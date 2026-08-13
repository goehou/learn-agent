/**
 * Agent 核心循环模块。AgentRunner 负责单次用户提示到最终回答的完整执行。
 * 每轮执行：snapshot 工具集 → 构造 ModelRequest → 调用模型 → 解析 assistant 回应 →
 * 逐一 prepare/authorize/invoke 工具调用 → 回填 tool 消息 → 下一轮或结束。
 * 约束要点：
 * - 每条 assistant 消息中的每个 tool_call 必须回填一条 tool 消息；
 * - 授权器异常时默认拒绝，防止边界失效；
 * - history 返回副本，调用方不能篡改模型请求历史。
 */
import { resolve } from "node:path";

import { systemMessage, toolMessage, userMessage, validateToolPairing } from "./messages.js";
import type { ChatMessage } from "./messages.js";
import type { ModelClient, ModelRequest } from "./model.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// 核心循环保持消息配对：模型调用后必须为每个工具调用写回一个结果。
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

// 授权器位于工具执行前，收到的调用已完成名称和参数 schema 校验。
export interface ToolAuthorizer {
  authorize(prepared: PreparedToolCall, context: ToolContext): Promise<ToolAuthorizationDecision>;
}

export interface ToolAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface RunResult {
  readonly finalText: string;
  readonly history: readonly ChatMessage[];
  readonly turns: number;
}

// AgentRunner 选项将纯核心与模型、工具、工作区等外部能力隔离。
export interface AgentRunnerOptions {
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly systemPrompt: string;
  readonly workspace: string;
  readonly maxTurns?: number;
  readonly identity?: string;
  readonly authorizer?: ToolAuthorizer;
}

export class AgentRunner {
  readonly #model: ModelClient;
  readonly #tools: ToolRegistry;
  readonly #systemPrompt: string;
  readonly #workspace: string;
  readonly #maxTurns: number;
  readonly #identity: string;
  readonly #authorizer: ToolAuthorizer | undefined;
  readonly #history: ChatMessage[] = [];

  constructor(options: AgentRunnerOptions) {
    // 轮次与身份都属于运行契约，构造时失败可避免中途产生不完整历史。
    const maxTurns = options.maxTurns === undefined ? 20 : options.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error("maxTurns must be a positive integer");
    }
    const identity = options.identity === undefined ? "user" : options.identity;
    if (identity.trim().length === 0) {
      throw new Error("identity must not be empty");
    }
    if (options.systemPrompt.trim().length === 0) {
      throw new Error("systemPrompt must not be empty");
    }

    this.#model = options.model;
    this.#tools = options.tools;
    this.#systemPrompt = options.systemPrompt;
    this.#workspace = resolve(options.workspace);
    this.#maxTurns = maxTurns;
    this.#identity = identity;
    this.#authorizer = options.authorizer;
  }

  get history(): readonly ChatMessage[] {
    // 返回副本，调用方不能篡改后续模型请求的对话历史。
    return Object.freeze([...this.#history]);
  }

  async run(prompt: string): Promise<RunResult> {
    // system prompt 每轮重建，持久历史只记录真实对话和工具事件。
    this.#history.push(userMessage(prompt));
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      // 在发起模型请求前检查上轮工具调用已经全部配对完成。
      validateToolPairing(this.#history);
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: Object.freeze([systemMessage(this.#systemPrompt), ...this.#history]),
        tools: tools.openAITools(),
      });
      const reply = await this.#model.complete(request);

      // 不把不完整或被过滤的回复误当成最终答案。
      if (reply.finishReason === "length") {
        throw new IncompleteModelReplyError("Model output reached the token limit");
      }
      if (reply.finishReason === "content_filter") {
        throw new AgentRunError("Model response was blocked by the content filter");
      }

      const assistant = reply.message;
      this.#history.push(assistant);
      if (assistant.toolCalls.length === 0) {
        if (assistant.content === null) {
          throw new AgentRunError("Model stopped without final text or tool calls");
        }
        validateToolPairing(this.#history);
        return Object.freeze({
          finalText: assistant.content,
          history: Object.freeze([...this.#history]),
          turns: turn,
        });
      }

      // 一条 assistant 消息中的每个调用都必须回填一次，错误和拒绝也不例外。
      for (const call of assistant.toolCalls) {
        const prepared = tools.prepare(call);
        let result: ToolResult;
        if (prepared.error !== undefined) {
          result = prepared.error;
        } else if (this.#authorizer !== undefined) {
          // 授权故障默认拒绝，防止授权边界失效时继续执行副作用工具。
          try {
            const decision = await this.#authorizer.authorize(prepared, context);
            if (decision.reason.trim().length === 0) {
              throw new Error("authorization decision reason must not be empty");
            }
            result = decision.allowed
              ? await tools.invoke(prepared, context)
              : toolError("permission_denied", decision.reason);
          } catch {
            result = toolError("permission_denied", "Tool approval failed closed");
          }
        } else {
          result = await tools.invoke(prepared, context);
        }
        this.#history.push(toolMessage(result.content, call.id));
      }
    }

    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }
}
