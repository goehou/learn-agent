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
  // 稳定基础错误名，供调用方区分 Agent 运行失败。
  override readonly name: string = "AgentRunError";
}

// 模型请求次数超过 maxTurns 时抛出，阻止无限循环。
export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

// 模型因长度截断而无法作为最终回答时抛出。
export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

// 授权器位于工具执行前，收到的调用已完成名称和参数 schema 校验。
export interface ToolAuthorizer {
  authorize(prepared: PreparedToolCall, context: ToolContext): Promise<ToolAuthorizationDecision>;
}

export interface ToolAuthorizationDecision {
  // 是否允许实际执行已经通过 schema 校验的调用。
  readonly allowed: boolean;
  // 可回填模型的授权理由；空理由视为无效决策。
  readonly reason: string;
}

export interface RunResult {
  // 模型停止时提供的最终回答文本。
  readonly finalText: string;
  // 与内部状态隔离的完整消息历史快照。
  readonly history: readonly ChatMessage[];
  // 本次运行实际发起的模型请求次数。
  readonly turns: number;
}

// AgentRunner 选项将纯核心与模型、工具、工作区等外部能力隔离。
export interface AgentRunnerOptions {
  // 规范化模型请求的唯一供应商无关边界。
  readonly model: ModelClient;
  // 运行期工具来源；每轮会取不可变快照。
  readonly tools: ToolRegistry;
  // 每轮前置而不写入持久 history 的系统约束。
  readonly systemPrompt: string;
  // 工具上下文使用的工作区根目录。
  readonly workspace: string;
  // 可选模型请求上限。
  readonly maxTurns?: number;
  // 注入工具上下文的调用主体标识。
  readonly identity?: string;
  // 可选授权边界；缺失时按库调用方的信任决定执行。
  readonly authorizer?: ToolAuthorizer;
}

// 单会话状态机，严格保持模型工具调用与结果消息的配对关系。
export class AgentRunner {
  // 已规范化的模型客户端。
  readonly #model: ModelClient;
  // 源工具注册表，用于每轮构造快照。
  readonly #tools: ToolRegistry;
  // 稳定系统提示。
  readonly #systemPrompt: string;
  // 规范化后的工作区根。
  readonly #workspace: string;
  // 最大模型请求次数。
  readonly #maxTurns: number;
  // 当前调用主体。
  readonly #identity: string;
  // 可选授权器。
  readonly #authorizer: ToolAuthorizer | undefined;
  // 本实例累计的用户、模型与工具事件。
  readonly #history: ChatMessage[] = [];

  // 验证长期配置并固定依赖，任何失败都早于模型请求和副作用。
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

  // 返回冻结副本，外部无法修改随后请求使用的历史。
  get history(): readonly ChatMessage[] {
    // 返回副本，调用方不能篡改后续模型请求的对话历史。
    return Object.freeze([...this.#history]);
  }

  // 执行用户请求直到得到最终文本、不可恢复错误或耗尽回合预算。
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
