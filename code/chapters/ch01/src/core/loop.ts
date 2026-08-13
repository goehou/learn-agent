import { resolve } from "node:path";

import { systemMessage, toolMessage, userMessage, validateToolPairing } from "./messages.js";
import type { ChatMessage } from "./messages.js";
import type { ModelClient, ModelRequest } from "./model.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// Agent Loop 的状态机：模型回复、工具回填、再次推理，直到得到最终文本。
//
// AgentRunner 是整个 Agent 的核心：
//   1. 接收用户 prompt
//   2. 循环调用模型直到模型不再请求工具
//   3. 每轮把 assistant 消息和工具结果追加进 history
//   4. 返回最终文本、完整历史和实际轮次
// 本章不实现 Planner、Memory 或 Orchestrator，它们都是在这个循环之上叠加的能力。
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

export interface ToolAuthorizer {
  // 在 handler 前评估已校验调用；返回原因会进入拒绝的 tool result。
  // 第 1 章 CLI 注入 TerminalAuthorizer，要求用户逐次批准 shell 命令。
  authorize(prepared: PreparedToolCall, context: ToolContext): Promise<ToolAuthorizationDecision>;
}

export interface ToolAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface RunResult {
  // 最终文本、可审计历史与实际使用回合数构成一次运行的完整结果。
  // history 是冻结副本，调用方不能修改 AgentRunner 内部状态。
  readonly finalText: string;
  readonly history: readonly ChatMessage[];
  readonly turns: number;
}

export interface AgentRunnerOptions {
  // 核心循环只依赖抽象模型和工具；具体 SDK/进程在 bootstrap 层注入。
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
    // 在实例创建时验证长期不变量，避免运行到中途才暴露无效配置。
    // 默认 20 轮上限防止模型无限循环；identity 默认 "user"。
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
    // 返回冻结副本，调用方不能修改内部消息历史。
    // 测试可用它验证消息配对；生产代码通常只读取 finalText。
    return Object.freeze([...this.#history]);
  }

  async run(prompt: string): Promise<RunResult> {
    // 历史仅保存用户与模型/工具事件；system prompt 在每次请求时单独前置。
    // system prompt 不进入 history，是因为它每轮都一样，无需重复保存。
    this.#history.push(userMessage(prompt));
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    // 一个回合对应一次模型请求；工具结果回填后才允许进入下一次请求。
    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      validateToolPairing(this.#history);
      // 冻结本回合工具视图，确保模型看到的定义与实际 prepare/invoke 使用同一集合。
      // snapshot 每轮创建一次，代价很小但能防止并发修改引起的不一致。
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: Object.freeze([systemMessage(this.#systemPrompt), ...this.#history]),
        tools: tools.openAITools(),
      });
      const reply = await this.#model.complete(request);

      // 首章不做续写或压缩；未完整回复不能被误当作最终答案。
      // length 表示输出被 token 限制截断，content_filter 表示内容被过滤。
      // 两者都不是正常结束，后续章节会加入恢复策略。
      if (reply.finishReason === "length") {
        throw new IncompleteModelReplyError("Model output reached the token limit");
      }
      if (reply.finishReason === "content_filter") {
        throw new AgentRunError("Model response was blocked by the content filter");
      }

      // assistant 消息必须先入历史，随后的每项工具结果才能与调用 ID 相邻配对。
      // 先 push assistant 再回填 tool 消息，保证验证器看到的是完整配对。
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
      // 工具结果不只是一对一，而且顺序可以不同（先 A 后 B 或先 B 后 A 都可以）。
      for (const call of assistant.toolCalls) {
        // prepare 统一处理未知工具、JSON 与 schema 错误，并把错误安全回填给模型。
        // prepare 本身不执行副作用，只有 invoke 才调用实际 handler。
        const prepared = tools.prepare(call);
        let result: ToolResult;
        if (prepared.error !== undefined) {
          result = prepared.error;
        } else if (this.#authorizer !== undefined) {
          // 有人工授权边界时先征求许可；拒绝也生成 tool result 供模型换方案。
          try {
            const decision = await this.#authorizer.authorize(prepared, context);
            if (decision.reason.trim().length === 0) {
              throw new Error("authorization decision reason must not be empty");
            }
            result = decision.allowed
              ? await tools.invoke(prepared, context)
              : toolError("permission_denied", decision.reason);
          } catch {
            // 授权边界失败时拒绝而非放行，避免审批基础设施异常扩大权限。
            // fail-closed：任何授权异常都默认拒绝，而不是冒险执行。
            result = toolError("permission_denied", "Tool approval failed closed");
          }
        } else {
          // 未配置 authorizer 时直接执行；测试和库调用方通常走这条路径。
          result = await tools.invoke(prepared, context);
        }
        this.#history.push(toolMessage(result.content, call.id));
      }
    }

    // 达到最大轮次仍没有最终文本时抛出类型化错误，调用方可决定如何恢复。
    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }
}
