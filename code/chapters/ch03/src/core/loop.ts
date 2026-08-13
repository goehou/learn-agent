import { resolve } from "node:path";

import { systemMessage, toolMessage, userMessage, validateToolPairing } from "./messages.js";
import type { ChatMessage } from "./messages.js";
import type { ModelClient, ModelRequest } from "./model.js";
import type { PermissionPolicy } from "./permissions.js";
import { PermissionRequest } from "./permissions.js";
import type { ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// Agent Loop 将准备好的调用交给权限策略，只有 allow 才进入工具执行器。
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

// 达到最大轮数限制时抛出，调用方不应将中间历史当作最终交付。
export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

// 模型输出因 token 上限被截断，无法获取完整回复。
export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

export interface RunResult {
  // 模型停止时提供的最终可交付文本。
  readonly finalText: string;
  // 与内部状态隔离的完整消息历史。
  readonly history: readonly ChatMessage[];
  // 本次运行实际请求模型的次数。
  readonly turns: number;
}

export interface AgentRunnerOptions {
  // 供应商无关的模型边界。
  readonly model: ModelClient;
  // 每轮请求时会生成快照的工具注册表。
  readonly tools: ToolRegistry;
  // 每轮临时前置而不写入 history 的系统提示。
  readonly systemPrompt: string;
  // 工具调用可访问的工作区根。
  readonly workspace: string;
  // 可选模型请求上限。
  readonly maxTurns?: number;
  // 注入工具上下文的主体标识。
  readonly identity?: string;
  // P03 的执行前权限策略；缺失时保留早期章节直调行为。
  readonly permissionPolicy?: PermissionPolicy;
}

// 单会话状态机；仅当 PermissionPolicy 产出 allow 时才调用工具 handler。
export class AgentRunner {
  // 已规范化的模型客户端。
  readonly #model: ModelClient;
  // 用于生成本轮不可变视图的源注册表。
  readonly #tools: ToolRegistry;
  // 稳定系统提示。
  readonly #systemPrompt: string;
  // 规范化后的工作区根。
  readonly #workspace: string;
  // 最大模型请求次数。
  readonly #maxTurns: number;
  // 当前调用主体。
  readonly #identity: string;
  // 可选权限策略，负责审批、审计和写边界。
  readonly #permissionPolicy: PermissionPolicy | undefined;
  // 累计的用户、模型和工具消息，不包含每轮重建的系统消息。
  readonly #history: ChatMessage[] = [];

  // 验证长期配置并固定依赖，失败发生在模型请求和副作用之前。
  constructor(options: AgentRunnerOptions) {
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
    this.#permissionPolicy = options.permissionPolicy;
  }

  // 返回冻结历史副本，调用方不能篡改后续模型请求。
  get history(): readonly ChatMessage[] {
    return Object.freeze([...this.#history]);
  }

  // 执行用户请求，直到得到最终文本、遇到不可恢复响应或耗尽回合。
  async run(prompt: string): Promise<RunResult> {
    // history 是单个 Runner 的累积会话；每轮请求重建系统消息和工具快照。
    this.#history.push(userMessage(prompt));
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      validateToolPairing(this.#history);
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: Object.freeze([systemMessage(this.#systemPrompt), ...this.#history]),
        tools: tools.openAITools(),
      });
      const reply = await this.#model.complete(request);

      if (reply.finishReason === "length") {
        throw new IncompleteModelReplyError("Model output reached the token limit");
      }
      if (reply.finishReason === "content_filter") {
        throw new AgentRunError("Model response was blocked by the content filter");
      }

      const assistant = reply.message;
      this.#history.push(assistant);
      if (assistant.toolCalls.length === 0) {
        // 没有工具调用时，非空文本才是可交付的最终答复。
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
        } else if (this.#permissionPolicy !== undefined) {
          // 权限决定必须发生在 handler 前；评估异常也要回填配对错误。
          try {
            const decision = await this.#permissionPolicy.decide(
              new PermissionRequest({ prepared, context }),
            );
            result = decision.isAllowed
              ? await tools.invoke(prepared, context)
              : decision.toToolResult();
          } catch {
            result = toolError("permission_evaluation_error", "Permission evaluation failed");
          }
        } else {
          // 前两章没有权限能力，保留其直接调用的教学行为。
          result = await tools.invoke(prepared, context);
        }
        this.#history.push(toolMessage(result.content, call.id));
      }
    }

    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }
}
