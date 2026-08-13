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
// Agent 运行期间的基础领域错误；调用方可与配置或 SDK 错误分开处理。
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

// 在未得到最终回答前耗尽回合预算时抛出，避免无限模型/工具循环。
export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

// 模型因长度截断而无法安全视为最终回答时抛出。
export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

export interface ToolAuthorizer {
  // 在 handler 前评估已校验调用；返回原因会进入拒绝的 tool result。
  // 第 1 章 CLI 注入 TerminalAuthorizer，要求用户逐次批准 shell 命令。
  authorize(prepared: PreparedToolCall, context: ToolContext): Promise<ToolAuthorizationDecision>;
}

// 授权边界的明确结论；拒绝原因必须回填给模型以便其调整后续行动。
export interface ToolAuthorizationDecision {
  // 是否允许实际调用 handler，而不是仅允许模型提出调用请求。
  readonly allowed: boolean;
  // 人类或策略拒绝的可解释文本；空原因会被视为无效授权响应。
  readonly reason: string;
}

// 单次 Agent 运行的可审计结果；与内部状态隔离的 history 用于验证消息配对。
export interface RunResult {
  // 最终文本、可审计历史与实际使用回合数构成一次运行的完整结果。
  // history 是冻结副本，调用方不能修改 AgentRunner 内部状态。
  readonly finalText: string;
  readonly history: readonly ChatMessage[];
  readonly turns: number;
}

// 构造 AgentRunner 所需的依赖与边界；外部 SDK 和进程实现必须由组合根注入。
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

// 单会话 Agent 状态机，按“模型回复 -> 工具回填 -> 再请求”推进到最终文本。
export class AgentRunner {
  // 已规范化的模型边界，循环不依赖具体供应商 SDK。
  readonly #model: ModelClient;
  // 可变源注册表；每轮会从它生成不可变工具快照。
  readonly #tools: ToolRegistry;
  // 每轮模型请求前置的稳定系统约束，不写入可变历史。
  readonly #systemPrompt: string;
  // 规范化后的工作区根目录，所有工具调用共用该边界。
  readonly #workspace: string;
  // 一次 run 最多允许的模型请求次数，而非工具调用次数。
  readonly #maxTurns: number;
  // 注入工具上下文的调用主体标识。
  readonly #identity: string;
  // 可选人工或策略授权边界；缺失时由库调用方承担信任决定。
  readonly #authorizer: ToolAuthorizer | undefined;
  // 当前实例累计的用户、模型和工具事件；system prompt 始终按请求临时前置。
  readonly #history: ChatMessage[] = [];

  // 验证长期配置并固定依赖；构造失败应早于任何模型请求或副作用。
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

  // 返回冻结的历史副本，供审计读取而不允许外部改写实例状态。
  get history(): readonly ChatMessage[] {
    // 返回冻结副本，调用方不能修改内部消息历史。
    // 测试可用它验证消息配对；生产代码通常只读取 finalText。
    return Object.freeze([...this.#history]);
  }

  // 执行一次用户请求，直到模型给出最终文本、触发不可恢复错误或耗尽回合预算。
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
