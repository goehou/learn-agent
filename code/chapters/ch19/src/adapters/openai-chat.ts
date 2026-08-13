// OpenAI SDK 仅存在于此 adapter，core 不依赖供应商类型。
import OpenAI, { APIError } from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { assistantMessage, toolCall, validateToolPairing } from "../core/messages.js";
import type { ChatMessage } from "../core/messages.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../core/model.js";
import type {
  FinishReason,
  ModelClient,
  ModelReply,
  ModelRequest,
  TokenUsage,
} from "../core/model.js";
import type { OpenAISettings } from "../config.js";

// 成功响应未通过结构校验时抛出此错误，绝不猜测字段类型。
export class OpenAIResponseError extends Error {
  override readonly name = "OpenAIResponseError";
}

// 最小客户端边界只暴露 create，便于测试注入 fake OpenAI 状态对象。
export interface OpenAIClientBoundary {
  readonly chat: {
    readonly completions: {
      create(
        request: ChatCompletionCreateParamsNonStreaming,
        options?: { readonly signal?: AbortSignal },
      ): Promise<unknown>;
    };
  };
}

export class OpenAIChatModel implements ModelClient {
  readonly #client: OpenAIClientBoundary;
  readonly #model: string;

  constructor(settings: OpenAISettings, client?: OpenAIClientBoundary) {
    this.#client =
      client === undefined
        ? new OpenAI({
            apiKey: settings.apiKey,
            baseURL: settings.baseUrl,
            // 重试由第 11 章的供应商无关恢复层统一控制，SDK 不得隐藏额外请求。
            maxRetries: 0,
          })
        : client;
    this.#model = settings.model;
  }

  // 当前 SDK 没有需要主动释放的连接；保留统一资源边界供 Runner 关闭。
  async close(): Promise<void> {
    return;
  }

  // 先校验请求，再调用供应商；signal 直接透传给网络层。
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
    validateToolPairing(request.messages);
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new Error("maxTokens must be a positive integer");
    }
    const model = request.model === undefined ? this.#model : request.model;
    let response: unknown;
    try {
      response = await this.#client.chat.completions.create(
        {
          model,
          messages: request.messages.map(toOpenAIMessage),
          ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toOpenAITool) }),
          ...(request.maxTokens === undefined ? {} : { max_completion_tokens: request.maxTokens }),
        },
        ...(signal === undefined ? [] : [{ signal }]),
      );
    } catch (error) {
      const mapped = mapApiStatusError(error);
      if (mapped === undefined) {
        throw error;
      }
      throw mapped;
    }
    const normalized = normalizeResponse(response);
    return Object.freeze({
      message: assistantMessage(normalized.content, normalized.calls),
      finishReason: normalized.finishReason,
      ...(normalized.usage === undefined ? {} : { usage: normalized.usage }),
    });
  }
}

// 输入过长只接受稳定的 code/type 标识，不匹配 message 文本。
const PROMPT_TOO_LONG_CODES = new Set([
  "context_length_exceeded",
  "max_context_window",
  "prompt_is_too_long",
  "prompt_too_long",
]);

// 只识别 APIError 的结构化字段；未知错误原样抛回。
function mapApiStatusError(error: unknown): Error | undefined {
  if (!(error instanceof APIError)) {
    return undefined;
  }
  const status = error.status;
  if (!Number.isInteger(status)) {
    return undefined;
  }
  const body = error.error;
  const errorCode = structuredErrorIdentifier(body);
  const requestId = nonEmptyText(error.requestID);
  if (status === 429) {
    const retryAfter = retryAfterValue(error.headers);
    return new ModelRateLimitError("OpenAI request was rate limited", {
      statusCode: status,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(requestId === undefined ? {} : { requestId }),
      cause: error,
    });
  }
  if (status === 529) {
    return new ModelOverloadedError("OpenAI model was overloaded", {
      statusCode: status,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(requestId === undefined ? {} : { requestId }),
      cause: error,
    });
  }
  if (status === 400 && errorCode !== undefined && PROMPT_TOO_LONG_CODES.has(errorCode)) {
    return new ModelPromptTooLongError("OpenAI prompt exceeded the model context window", {
      statusCode: status,
      errorCode,
      ...(requestId === undefined ? {} : { requestId }),
      cause: error,
    });
  }
  return undefined;
}

// error code 只取平铺对象或一层 error 对象中的 code/type，避免递归搜索不可信 JSON。
function structuredErrorIdentifier(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const candidates = [body];
  const nested = Reflect.get(body, "error");
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    candidates.push(nested);
  }
  for (const candidate of candidates) {
    for (const field of ["code", "type"]) {
      const value = nonEmptyText(Reflect.get(candidate, field));
      if (value !== undefined) {
        return value.toLowerCase();
      }
    }
  }
  return undefined;
}

// 只从标准 Headers 读取 Retry-After，其他响应类型不猜测。
function retryAfterValue(headers: unknown): string | undefined {
  if (headers instanceof Headers) {
    return nonEmptyText(headers.get("retry-after"));
  }
  return undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

interface NormalizedResponse {
  readonly content: string | null;
  readonly calls: readonly ReturnType<typeof toolCall>[];
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

// 成功响应属于不可信边界，逐字段校验 OpenAI Chat Completion 结构。
function normalizeResponse(response: unknown): NormalizedResponse {
  if (typeof response !== "object" || response === null) {
    throw new OpenAIResponseError("Chat completion response must be an object");
  }
  const choices = Reflect.get(response, "choices");
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw new OpenAIResponseError("Chat completion must return exactly one choice");
  }
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) {
    throw new OpenAIResponseError("Chat completion choice must be an object");
  }
  const finishReason = Reflect.get(choice, "finish_reason");
  if (!isFinishReason(finishReason)) {
    throw new OpenAIResponseError(`Unsupported finish_reason: ${String(finishReason)}`);
  }
  if (finishReason === "function_call") {
    throw new OpenAIResponseError("Legacy function_call finish reason is unsupported");
  }
  const message = Reflect.get(choice, "message");
  if (typeof message !== "object" || message === null) {
    throw new OpenAIResponseError("Chat completion message must be an object");
  }
  if (Reflect.get(message, "role") !== "assistant") {
    throw new OpenAIResponseError("Chat completion message role must be assistant");
  }
  const rawContent = Reflect.get(message, "content");
  if (rawContent !== null && typeof rawContent !== "string") {
    throw new OpenAIResponseError("Chat completion content must be a string or null");
  }
  const refusal = Reflect.get(message, "refusal");
  if (refusal !== undefined && refusal !== null && typeof refusal !== "string") {
    throw new OpenAIResponseError("Chat completion refusal must be a string or null");
  }
  const rawCalls = Reflect.get(message, "tool_calls");
  const legacyCall = Reflect.get(message, "function_call");
  if (legacyCall !== undefined && legacyCall !== null) {
    throw new OpenAIResponseError("Legacy function_call responses are unsupported");
  }
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) {
    throw new OpenAIResponseError("Chat completion tool_calls must be an array");
  }
  const calls = (rawCalls === undefined ? [] : rawCalls).map(normalizeToolCall);
  const rawUsage = Reflect.get(response, "usage");
  const content = rawContent !== null ? rawContent : typeof refusal === "string" ? refusal : null;
  return Object.freeze({
    content,
    calls: Object.freeze(calls),
    finishReason,
    ...(rawUsage === undefined || rawUsage === null ? {} : { usage: normalizeUsage(rawUsage) }),
  });
}

// tool_calls 必须带完整 id/name/arguments，任何缺失都让本轮失败。
function normalizeToolCall(call: unknown): ReturnType<typeof toolCall> {
  if (typeof call !== "object" || call === null) {
    throw new OpenAIResponseError("Tool call must be an object");
  }
  const type = Reflect.get(call, "type");
  if (type !== "function") {
    throw new OpenAIResponseError(`Unsupported tool call type: ${String(type)}`);
  }
  const fn = Reflect.get(call, "function");
  if (typeof fn !== "object" || fn === null) {
    throw new OpenAIResponseError("Function tool call payload must be an object");
  }
  try {
    return toolCall(Reflect.get(call, "id"), Reflect.get(fn, "name"), Reflect.get(fn, "arguments"));
  } catch (error) {
    throw new OpenAIResponseError(
      `Invalid function tool call: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isFinishReason(value: unknown): value is FinishReason {
  return (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter" ||
    value === "function_call"
  );
}

// ChatMessage 到 OpenAI wire format 的映射，assistant tool_calls 原样保留。
function toOpenAIMessage(message: ChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "tool":
      return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
    case "assistant": {
      const result: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: message.content,
      };
      if (message.toolCalls.length > 0) {
        result.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return result;
    }
  }
}

// 工具 schema 直接映射，OpenAI 只接受 function 类型。
function toOpenAITool(tool: ModelRequest["tools"][number]): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

// usage 字段为不可信输入，缺少或非负整数失败。
function normalizeUsage(usage: unknown): TokenUsage {
  if (typeof usage !== "object" || usage === null) {
    throw new OpenAIResponseError("Chat completion usage must be an object");
  }
  const promptTokens = readUsageCount(usage, "prompt_tokens");
  const completionTokens = readUsageCount(usage, "completion_tokens");
  const totalTokens = readUsageCount(usage, "total_tokens");
  return Object.freeze({
    promptTokens,
    completionTokens,
    totalTokens,
  });
}

function readUsageCount(usage: object, field: string): number {
  const value = Reflect.get(usage, field);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OpenAIResponseError(
      `Chat completion usage field ${field} must be non-negative integer`,
    );
  }
  return value;
}
