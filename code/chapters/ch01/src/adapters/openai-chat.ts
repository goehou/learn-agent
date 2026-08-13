import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { assistantMessage, toolCall, validateToolPairing } from "../core/messages.js";
import type { ChatMessage } from "../core/messages.js";
import type {
  FinishReason,
  ModelClient,
  ModelReply,
  ModelRequest,
  TokenUsage,
} from "../core/model.js";
import type { OpenAISettings } from "../config.js";

// OpenAI 适配器：把 Chat Completions SDK 的宽松返回类型收窄为核心循环使用的 ModelClient 契约。
//
// normalizeResponse 对 SDK 原始响应逐层做运行时验证，拒绝非法类型、遗留 function_call、
// 缺失字段和不支持的 finish_reason。验证在适配器边界完成，核心循环永远不接触 SDK 类型。
//
// 将 OpenAI SDK 的宽松响应收窄为 Agent Loop 使用的严格模型契约。
export class OpenAIResponseError extends Error {
  override readonly name = "OpenAIResponseError";
}

export interface OpenAIClientBoundary {
  // 仅声明本适配器使用的 SDK 表面，使测试能注入无网络的客户端替身。
  readonly chat: {
    readonly completions: {
      create(request: ChatCompletionCreateParamsNonStreaming): Promise<unknown>;
    };
  };
}

export class OpenAIChatModel implements ModelClient {
  readonly #client: OpenAIClientBoundary;
  readonly #model: string;

  constructor(settings: OpenAISettings, client?: OpenAIClientBoundary) {
    // 默认创建真实 SDK；可选 client 保持外部请求边界可替换。
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

  async complete(request: ModelRequest): Promise<ModelReply> {
    // 在发给供应商前验证历史，不能把配对错误伪装为远端模型故障。
    validateToolPairing(request.messages);
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new Error("maxTokens must be a positive integer");
    }
    const model = request.model === undefined ? this.#model : request.model;
    const response = await this.#client.chat.completions.create({
      model,
      messages: request.messages.map(toOpenAIMessage),
      ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toOpenAITool) }),
      ...(request.maxTokens === undefined ? {} : { max_completion_tokens: request.maxTokens }),
    });
    const normalized = normalizeResponse(response);
    return Object.freeze({
      message: assistantMessage(normalized.content, normalized.calls),
      finishReason: normalized.finishReason,
      ...(normalized.usage === undefined ? {} : { usage: normalized.usage }),
    });
  }
}

interface NormalizedResponse {
  // SDK 原始响应经运行时收窄后的内部表示，避免 unknown 进入循环状态。
  readonly content: string | null;
  readonly calls: readonly ReturnType<typeof toolCall>[];
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

function normalizeResponse(response: unknown): NormalizedResponse {
  // SDK 返回值是外部不可信边界，逐层验证后才允许进入核心消息历史。
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

function normalizeToolCall(call: unknown): ReturnType<typeof toolCall> {
  // Chat Completions 只接受 function 类型调用，并交由核心构造器验证三个字符串字段。
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
  // 白名单同时保留 legacy 值，以便 normalizeResponse 给出明确的不支持错误。
  return (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter" ||
    value === "function_call"
  );
}

function toOpenAIMessage(message: ChatMessage): ChatCompletionMessageParam {
  // 保留工具调用与 tool result 的关联字段，避免转换时破坏消息配对。
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

function toOpenAITool(tool: ModelRequest["tools"][number]): ChatCompletionTool {
  // 工具 schema 由注册表单一来源生成，此处只转换为 SDK 请求形状。
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

function normalizeUsage(usage: unknown): TokenUsage {
  // 用量字段参与后续章节的恢复策略，因此必须为非负整数而非宽松转换。
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
