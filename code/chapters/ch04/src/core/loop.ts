import { resolve } from "node:path";

import { HookContractError, HookRegistry } from "./hooks.js";
import type { HookResult } from "./hooks.js";
import { systemMessage, toolMessage, userMessage, validateToolPairing } from "./messages.js";
import type { ChatMessage, ToolCall } from "./messages.js";
import type { ModelClient, ModelRequest } from "./model.js";
import { PermissionDecision, PermissionPolicy, PermissionRequest } from "./permissions.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// Loop 在模型、权限与工具前后插入 Hook，但保持每个 tool call 必有回填结果。
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

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
  // P03 引入的执行前权限策略。
  readonly permissionPolicy?: PermissionPolicy;
  // P04 引入的生命周期回调注册表；省略时使用无回调注册表。
  readonly hooks?: HookRegistry;
}

// 一次工具调用在本轮的回填结果和是否阻止后续调用的内部状态。
interface ToolExecution {
  readonly result: ToolResult;
  readonly additionalContext: readonly ChatMessage[];
  readonly preventContinuation: boolean;
}

// 单会话状态机；在模型、权限和工具边界插入受限 Hook 并保持消息配对。
export class AgentRunner {
  // 构造函数做前置校验，不允许非法 maxTurns 或空 identity/systemPrompt。
  readonly #model: ModelClient;
  readonly #tools: ToolRegistry;
  readonly #systemPrompt: string;
  readonly #workspace: string;
  readonly #maxTurns: number;
  readonly #identity: string;
  readonly #permissionPolicy: PermissionPolicy | undefined;
  readonly #hooks: HookRegistry;
  readonly #history: ChatMessage[] = [];

  // 验证长期配置并固定依赖；Hook 存在时为兼容路径提供权限策略实例。
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
    this.#permissionPolicy =
      options.permissionPolicy === undefined && options.hooks !== undefined
        ? new PermissionPolicy()
        : options.permissionPolicy;
    this.#hooks = options.hooks === undefined ? new HookRegistry() : options.hooks;
  }

  // 返回冻结历史副本，外部无法篡改后续模型请求。
  get history(): readonly ChatMessage[] {
    return Object.freeze([...this.#history]);
  }

  // 执行用户请求，允许 Hook 受限地追加上下文、改写工具输入/输出或控制一次续写。
  async run(prompt: string): Promise<RunResult> {
    // 先触发 UserPromptSubmit Hook，然后将 prompt 与 additionalContext 写入历史。
    const submitted = userMessage(prompt);
    const promptHook = await this.#hooks.runUserPrompt(submitted);
    this.#history.push(submitted, ...promptHook.additionalContext);
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    let stopHookActive = false;
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
        // Stop Hook 最多请求一次继续，stopHookActive 防止自我延续的无限循环。
        if (assistant.content === null) {
          throw new AgentRunError("Model stopped without final text or tool calls");
        }
        const stopHook = await this.#hooks.runStop(this.#history, stopHookActive);
        if (stopHook.forceContinue !== undefined) {
          this.#history.push(...stopHook.additionalContext, stopHook.forceContinue);
          stopHookActive = true;
          continue;
        }
        return this.#complete(assistant.content, turn);
      }

      // 一条 assistant 消息中的每个调用都必须回填一次，错误和拒绝也不例外。
      const results: ToolResult[] = [];
      const deferredContext: ChatMessage[] = [];
      let stoppedResultIndex: number | undefined;
      for (const call of assistant.toolCalls) {
        let result: ToolResult;
        if (stoppedResultIndex !== undefined) {
          result = toolError(
            "hook_stopped_continuation",
            "Skipped after PostToolUse requested a stop",
          );
        } else {
          const execution = await this.#executeTool(call, context, tools);
          result = execution.result;
          deferredContext.push(...execution.additionalContext);
          if (execution.preventContinuation) {
            stoppedResultIndex = results.length;
          }
        }
        results.push(result);
      }
      for (const [index, call] of assistant.toolCalls.entries()) {
        const result = results[index];
        if (result === undefined) {
          throw new AgentRunError("Tool execution did not produce a paired result");
        }
        this.#history.push(toolMessage(result.content, call.id));
      }
      this.#history.push(...deferredContext);
      if (stoppedResultIndex !== undefined) {
        const stoppedResult = results[stoppedResultIndex];
        if (stoppedResult === undefined) {
          throw new AgentRunError("PostToolUse stop did not preserve its result");
        }
        return this.#complete(stoppedResult.content, turn);
      }
    }

    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }

  // 每个回调优先检查 prepared 错误，然后依次执行 Pre Hook、权限裁决、handler 和 Post Hook。
  // Hook 阻断、权限拒绝、Handler 错误都统一回填 tool_call_id，不会遗留未配对调用。
  async #executeTool(
    call: ToolCall,
    context: ToolContext,
    tools: ToolRegistry,
  ): Promise<ToolExecution> {
    let prepared: PreparedToolCall;
    try {
      prepared = tools.prepare(call);
    } catch {
      return execution(toolError("tool_preparation_error", "Tool preparation failed"));
    }
    if (prepared.error !== undefined) {
      return execution(prepared.error);
    }

    let preHook: HookResult;
    try {
      preHook = await this.#hooks.runPreTool(prepared);
    } catch (error) {
      return execution(
        error instanceof HookContractError
          ? toolError("hook_contract_error", "PreToolUse hook returned an invalid update")
          : toolError("hook_execution_error", "PreToolUse hook failed"),
      );
    }
    const effective = preHook.updatedInput === undefined ? prepared : preHook.updatedInput;
    // Pre Hook 可阻断或建议权限，实际拒绝仍由统一权限策略裁决。
    if (preHook.blockingError !== undefined) {
      return execution(preHook.blockingError, preHook.additionalContext);
    }

    if (this.#permissionPolicy !== undefined) {
      // Hook 只提交结构化建议；系统 deny 仍在同一策略合并中拥有最高优先级。
      try {
        const decision = await this.#permissionPolicy.decide(
          new PermissionRequest({
            prepared: effective,
            context,
            recommendations: hookRecommendations(preHook),
          }),
        );
        if (!decision.isAllowed) {
          return execution(decision.toToolResult(), preHook.additionalContext);
        }
      } catch {
        return execution(
          toolError("permission_evaluation_error", "Permission evaluation failed"),
          preHook.additionalContext,
        );
      }
    }

    let result = await tools.invoke(effective, context);
    let postHook: HookResult;
    try {
      postHook = await this.#hooks.runPostTool(effective, result);
    } catch {
      return execution(
        toolError("hook_execution_error", "PostToolUse hook failed"),
        preHook.additionalContext,
      );
    }
    if (postHook.updatedOutput !== undefined) {
      result = postHook.updatedOutput;
    }
    return execution(
      result,
      [...preHook.additionalContext, ...postHook.additionalContext],
      postHook.preventContinuation,
    );
  }

  // 历史校验后返回冻结快照。
  #complete(finalText: string, turns: number): RunResult {
    validateToolPairing(this.#history);
    return Object.freeze({
      finalText,
      history: Object.freeze([...this.#history]),
      turns,
    });
  }
}

function execution(
  result: ToolResult,
  additionalContext: readonly ChatMessage[] = [],
  preventContinuation = false,
): ToolExecution {
  return Object.freeze({
    result,
    additionalContext: Object.freeze([...additionalContext]),
    preventContinuation,
  });
}

function hookRecommendations(hook: HookResult): readonly PermissionDecision[] {
  if (hook.permissionBehavior === "passthrough") {
    return [];
  }
  return [
    new PermissionDecision(
      hook.permissionBehavior,
      `PreToolUse hook requested ${hook.permissionBehavior}`,
      "pre-tool-hook",
    ),
  ];
}
