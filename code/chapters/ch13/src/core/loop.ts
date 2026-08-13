import { resolve } from "node:path";

import { isRuntimeEvent, runtimeEventMessage } from "./events.js";
import type { RuntimeEvent } from "./events.js";
import { HookContractError, HookRegistry } from "./hooks.js";
import type { HookResult } from "./hooks.js";
import {
  isChatMessage,
  systemMessage,
  toolMessage,
  userMessage,
  validateToolPairing,
} from "./messages.js";
import type { ChatMessage, ToolCall } from "./messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "./model.js";
import { PermissionDecision, PermissionPolicy, PermissionRequest } from "./permissions.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { copyToolResult, isToolResult, toolError } from "./tools.js";

// AgentRunner 是 Agent Loop：协调模型、工具、权限、Hook、后台事件与资源关闭，并保证每个工具调用都有协议回填。
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
  readonly finalText: string;
  readonly history: readonly ChatMessage[];
  readonly turns: number;
}

export interface AgentRunnerOptions {
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly systemPrompt: string;
  readonly systemPromptProvider?: SystemPromptProvider;
  readonly workspace: string;
  readonly maxTurns?: number;
  readonly identity?: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly hooks?: HookRegistry;
  readonly toolRoundObserver?: ToolRoundObserver;
  readonly historyProcessor?: RequestHistoryProcessor;
  readonly toolResultProcessor?: ToolResultProcessor;
  readonly turnLifecycle?: TurnLifecycle;
  readonly modelRequestExecutor?: ModelRequestExecutor;
  // 可选分派器接管工具执行；后台任务等场景可以先返回占位结果，再异步补交终态。
  readonly toolDispatcher?: ToolDispatcher;
  // 可选事件泵把后台终态异步注入 Agent Loop；注入后每轮模型请求前都会先接收事件。
  readonly eventPump?: RuntimeEventPump;
  // 可选外部资源按逆序统一关闭，AgentRunner 在 close() 时负责收束其生命周期。
  readonly resources?: readonly AsyncResource[];
}

// 处理器产出必须仍满足消息配对，确保压缩不破坏模型协议。
export interface RequestHistoryProcessor {
  prepare(history: readonly ChatMessage[]): Promise<readonly ChatMessage[]>;
}

// 动态提示 Provider 对 AgentRunner 保持零参数契约，内部数据源由组合根在构建时绑定。
export interface SystemPromptProvider {
  // 每轮模型调用临时读取动态系统提示，不把渲染结果写入对话历史。
  render(): string;
}

export interface ModelRequestExecutor {
  // Executor 接管模型调用时必须显式 beginTurn，确保恢复状态与 Agent 回合对齐。
  beginTurn(): void;
  complete(request: ModelRequest): Promise<ModelReply>;
}

// TurnLifecycle 是记忆等跨请求能力的边界：beginTurn 在首轮前执行，
// beforeModel 只给下一次模型请求附加上下文，complete 在最终结果返回前收尾。
export interface TurnLifecycle {
  beginTurn(query: string): Promise<void>;
  beforeModel(): readonly ChatMessage[];
  complete(history: readonly ChatMessage[]): Promise<void>;
}

export type ToolResultProcessor = (
  results: readonly ToolResult[],
) => Promise<readonly ToolResult[]> | readonly ToolResult[];

// 工具分派器保留原同步执行路径的返回值契约；后台作业先返回占位结果，再通过事件泵补交终态。
export interface ToolDispatcher {
  // 接收已完成 schema 校验的调用；实现必须返回统一 ToolResult，不能自行回填历史。
  dispatch(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult>;
}

// 事件泵是外部运行时到 Agent Loop 的单向通道：drain 取已就绪事件，waitForEvents 等待 pending 工作，acknowledgeEvents 标记已消费。
export interface RuntimeEventPump {
  // 表示外部运行时仍可能产生事件，供无工具轮决定是否阻塞等待。
  readonly hasPendingWork: boolean;
  // 非阻塞取走当前事件批次。
  drainEvents(limit?: number): readonly RuntimeEvent[];
  // 在存在 pending 工作时等待下一批事件。
  waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]>;
  // 确认本批事件已由 Loop 接收；实现可据此持久化消费位置。
  acknowledgeEvents(events: readonly RuntimeEvent[]): void;
  // 可选恢复屏障，确保构造期恢复事件在首次 drain 前已经发布。
  ready?(): Promise<void>;
}

// AsyncResource 是 Runner 可管理的关闭边界；由组合根注入，避免核心直接依赖具体后台实现。
export interface AsyncResource {
  // 释放异步资源；Runner 会按注入顺序逆序调用。
  close(): Promise<void>;
}

// 观察器可在模型请求前提供指导，并在工具轮完成后更新内部状态。
export interface ToolRoundObserver {
  beforeModel(): readonly ChatMessage[];
  recordToolRound(toolNames: readonly string[]): void;
}

interface ToolExecution {
  readonly result: ToolResult;
  readonly additionalContext: readonly ChatMessage[];
  readonly preventContinuation: boolean;
}

export class AgentRunner {
  readonly #model: ModelClient;
  readonly #tools: ToolRegistry;
  readonly #systemPrompt: string;
  readonly #systemPromptProvider: SystemPromptProvider | undefined;
  readonly #workspace: string;
  readonly #maxTurns: number;
  readonly #identity: string;
  readonly #permissionPolicy: PermissionPolicy | undefined;
  readonly #hooks: HookRegistry;
  readonly #toolRoundObserver: ToolRoundObserver | undefined;
  readonly #historyProcessor: RequestHistoryProcessor | undefined;
  readonly #toolResultProcessor: ToolResultProcessor | undefined;
  readonly #turnLifecycle: TurnLifecycle | undefined;
  readonly #modelRequestExecutor: ModelRequestExecutor | undefined;
  // ToolDispatcher 可选接管实际调用；未注入时仍走 ToolRegistry.invoke 的同步路径。
  readonly #toolDispatcher: ToolDispatcher | undefined;
  // EventPump 可选接收后台终态；未注入时保持 P01-P12 的同步 Agent Loop。
  readonly #eventPump: RuntimeEventPump | undefined;
  // 外部资源以冻结数组保存，关闭时按逆序执行，保证依赖方先于被依赖方释放。
  readonly #resources: readonly AsyncResource[];
  readonly #history: ChatMessage[] = [];
  // 事件 id 去重表：同一后台事件只能作为一条 user message 注入一次 canonical history。
  readonly #seenEventIds = new Set<string>();
  // 运行/关闭状态组成 Runner 生命周期：并发 run、重复 close 和关闭后继续执行都会显式失败。
  #running = false;
  #closed = false;
  #closing = false;

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
    if (
      options.systemPromptProvider !== undefined &&
      typeof options.systemPromptProvider.render !== "function"
    ) {
      throw new TypeError("systemPromptProvider must implement render()");
    }
    if (
      options.modelRequestExecutor !== undefined &&
      (typeof options.modelRequestExecutor.beginTurn !== "function" ||
        typeof options.modelRequestExecutor.complete !== "function")
    ) {
      throw new TypeError("modelRequestExecutor must implement beginTurn() and complete()");
    }
    // 可选扩展契约在构造时校验，避免运行到模型或工具阶段才发现缺方法。
    if (
      options.toolDispatcher !== undefined &&
      typeof options.toolDispatcher.dispatch !== "function"
    ) {
      throw new TypeError("toolDispatcher must implement dispatch()");
    }
    // 事件泵契约完整校验后才注入，未注入时 Loop 保持原有同步行为。
    if (
      options.eventPump !== undefined &&
      (typeof options.eventPump.drainEvents !== "function" ||
        typeof options.eventPump.waitForEvents !== "function" ||
        typeof options.eventPump.acknowledgeEvents !== "function" ||
        (options.eventPump.ready !== undefined && typeof options.eventPump.ready !== "function"))
    ) {
      throw new TypeError("eventPump must implement the RuntimeEventPump contract");
    }
    // 资源数组只接受实现了 close() 的对象；缺省为空，关闭时不产生副作用。
    const resources = options.resources === undefined ? [] : options.resources;
    if (
      !Array.isArray(resources) ||
      !resources.every((resource) => typeof resource.close === "function")
    ) {
      throw new TypeError("resources must contain AsyncResource values");
    }

    this.#model = options.model;
    this.#tools = options.tools;
    this.#systemPrompt = options.systemPrompt;
    this.#systemPromptProvider = options.systemPromptProvider;
    this.#workspace = resolve(options.workspace);
    this.#maxTurns = maxTurns;
    this.#identity = identity;
    this.#permissionPolicy =
      options.permissionPolicy === undefined && options.hooks !== undefined
        ? new PermissionPolicy()
        : options.permissionPolicy;
    this.#hooks = options.hooks === undefined ? new HookRegistry() : options.hooks;
    this.#toolRoundObserver = options.toolRoundObserver;
    this.#historyProcessor = options.historyProcessor;
    this.#toolResultProcessor = options.toolResultProcessor;
    this.#turnLifecycle = options.turnLifecycle;
    this.#modelRequestExecutor = options.modelRequestExecutor;
    this.#toolDispatcher = options.toolDispatcher;
    this.#eventPump = options.eventPump;
    this.#resources = Object.freeze([...resources]);
  }

  get history(): readonly ChatMessage[] {
    return Object.freeze([...this.#history]);
  }

  async run(prompt: string): Promise<RunResult> {
    // 状态检查在进入回合前完成，避免并发 run 或关闭中的 Runner 启动模型/工具副作用。
    this.#ensureOpen();
    if (this.#closed) {
      throw new AgentRunError("AgentRunner is closed");
    }
    if (this.#running) {
      throw new AgentRunError("AgentRunner is already running");
    }
    // running 标记在 finally 中复位，保证异常退出后 Runner 仍可复用。
    this.#running = true;
    try {
      return await this.#runUserTurn(prompt);
    } finally {
      this.#running = false;
    }
  }

  async #runUserTurn(prompt: string): Promise<RunResult> {
    // canonical history 始终完整追加；请求级压缩或生命周期注入只影响每次模型快照。
    this.#ensureOpen();
    const submitted = userMessage(prompt);
    const promptHook = await this.#hooks.runUserPrompt(submitted);
    this.#history.push(submitted, ...promptHook.additionalContext);
    if (this.#turnLifecycle !== undefined) {
      // 生命周期先于首轮模型请求执行；选择失败由实现方降级，不能阻塞主 Agent。
      await this.#turnLifecycle.beginTurn(prompt);
    }
    // 执行器与 memory lifecycle 对齐回合边界；P01-P10 不注入时继续直接调用 ModelClient。
    this.#modelRequestExecutor?.beginTurn();
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    let stopHookActive = false;
    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      // 每次模型请求前都先接收已完成的后台事件，避免事件只在首轮可见。
      await this.#acceptNextRuntimeEvent(false);
      validateToolPairing(this.#history);
      const preparedHistory: unknown =
        this.#historyProcessor === undefined
          ? this.#history
          : await this.#historyProcessor.prepare(Object.freeze([...this.#history]));
      if (
        !Array.isArray(preparedHistory) ||
        !preparedHistory.every((message: unknown) => isChatMessage(message))
      ) {
        throw new AgentRunError("Request history processor returned invalid messages");
      }
      const requestHistory = Object.freeze([...preparedHistory]);
      // requestHistory 只决定模型本次能看到什么，canonical history 仍保持完整追加。
      validateToolPairing(requestHistory);
      // beforeModel 注入只进入本次模型请求，不写入 canonical history。
      const turnGuidance =
        this.#turnLifecycle === undefined ? [] : this.#turnLifecycle.beforeModel();
      if (
        !Array.isArray(turnGuidance) ||
        !turnGuidance.every((message: unknown) => isChatMessage(message))
      ) {
        throw new AgentRunError("Turn lifecycle returned invalid model guidance");
      }
      const observerGuidance =
        this.#toolRoundObserver === undefined ? [] : this.#toolRoundObserver.beforeModel();
      // 观察器指导是请求级内容，只影响当次模型输入；TODO 提醒等不写入持久历史。
      // 系统提示在每轮组装请求前渲染，使工具列表和选中记忆等运行态变化下一轮生效。
      const systemPrompt = this.#renderSystemPrompt();
      const requestMessages = Object.freeze([
        systemMessage(systemPrompt),
        ...requestHistory,
        ...turnGuidance,
        ...observerGuidance,
      ]);
      validateToolPairing(requestMessages);
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: requestMessages,
        tools: tools.openAITools(),
      });
      // 模型边界一次只发送当前轮请求；canonical history 继续由本类维护。
      const reply = await (this.#modelRequestExecutor === undefined
        ? this.#model.complete(request)
        : this.#modelRequestExecutor.complete(request));
      // 有执行器时，内部重试、压缩和 fallback 都在 complete() 内收束，不会重新进入外层循环。

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
        const stopHook = await this.#hooks.runStop(this.#history, stopHookActive);
        if (stopHook.forceContinue !== undefined) {
          this.#history.push(...stopHook.additionalContext, stopHook.forceContinue);
          stopHookActive = true;
          continue;
        }
        // 当前轮已无工具调用；先等待可能有结果的后台事件，事件到达时继续下一轮。
        const injectedCount = await this.#acceptNextRuntimeEvent(true);
        if (injectedCount > 0) {
          continue;
        }
        return await this.#complete(assistant.content, turn);
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
      const processedResults = await this.#processToolResults(results, assistant.toolCalls);
      for (const [index, call] of assistant.toolCalls.entries()) {
        const result = processedResults[index];
        if (result === undefined) {
          throw new AgentRunError("Tool execution did not produce a paired result");
        }
        // 每个工具调用都必须回填一个 tool message，否则后续模型请求会破坏协议配对。
        this.#history.push(toolMessage(result.content, call.id));
      }
      if (this.#toolRoundObserver !== undefined) {
        this.#toolRoundObserver.recordToolRound(assistant.toolCalls.map((call) => call.name));
      }
      this.#history.push(...deferredContext);
      if (stoppedResultIndex !== undefined) {
        const stoppedResult = processedResults[stoppedResultIndex];
        if (stoppedResult === undefined) {
          throw new AgentRunError("PostToolUse stop did not preserve its result");
        }
        return await this.#complete(stoppedResult.content, turn);
      }
    }

    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }

  async #processToolResults(
    results: readonly ToolResult[],
    calls: readonly ToolCall[],
  ): Promise<readonly ToolResult[]> {
    // 没有处理器时也深拷贝结果，避免工具内部可变对象污染 canonical history。
    if (this.#toolResultProcessor === undefined) {
      return Object.freeze(results.map((result) => copyToolResult(result)));
    }
    try {
      // 处理器收到只读快照；返回批次必须与工具调用数一致，否则整批按错误回填。
      const input = Object.freeze(results.map((result) => copyToolResult(result)));
      const processed: unknown = await this.#toolResultProcessor(input);
      if (!Array.isArray(processed) || processed.length !== calls.length) {
        throw new Error("tool result processor returned an invalid batch");
      }
      return Object.freeze(processed.map((result) => copyToolResult(result)));
    } catch {
      // 处理器失败时整批返回受控错误，仍与原工具调用数量一一对应。
      return Object.freeze(
        calls.map(() => toolError("tool_result_processing_error", "Tool result processing failed")),
      );
    }
  }

  // 每轮模型请求前渲染系统提示；provider 缺失时使用构建期固定字符串。
  #renderSystemPrompt(): string {
    // Provider 输出是模型边界输入，空值立即失败而不是回退到旧缓存。
    const rendered =
      this.#systemPromptProvider === undefined
        ? this.#systemPrompt
        : this.#systemPromptProvider.render();
    if (typeof rendered !== "string" || rendered.trim().length === 0) {
      throw new AgentRunError("System prompt provider returned an empty prompt");
    }
    return rendered;
  }

  async #executeTool(
    call: ToolCall,
    context: ToolContext,
    tools: ToolRegistry,
  ): Promise<ToolExecution> {
    // 工具执行边界统一产出 ToolResult，Hook、权限和 handler 异常都不可见原始堆栈。
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

    let result: ToolResult;
    try {
      // 分派器可选接管工具执行，但必须返回同一 ToolResult 契约；错误统一转为受控错误。
      result =
        this.#toolDispatcher === undefined
          ? await tools.invoke(effective, context)
          : await this.#toolDispatcher.dispatch(effective, context);
      if (!isToolResult(result)) {
        throw new TypeError("tool dispatcher returned an invalid result");
      }
    } catch {
      return execution(
        toolError("tool_dispatch_error", "Tool dispatch failed"),
        preHook.additionalContext,
      );
    }
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

  async #complete(finalText: string, turns: number): Promise<RunResult> {
    validateToolPairing(this.#history);
    // complete 使用完整 canonical history，让 extractor 看到请求级压缩前的原始会话。
    if (this.#turnLifecycle !== undefined) {
      await this.#turnLifecycle.complete(Object.freeze([...this.#history]));
    }
    return Object.freeze({
      finalText,
      history: Object.freeze([...this.#history]),
      turns,
    });
  }

  // 重复关闭是幂等操作；正在关闭时拒绝并发调用，防止资源释放顺序错乱。
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#closing) {
      throw new AgentRunError("AgentRunner close is already in progress");
    }
    this.#closing = true;
    const failures: unknown[] = [];
    try {
      // 资源按注入顺序的逆序释放，并收集单个失败，确保一个资源异常不会中断其余清理。
      for (const resource of [...this.#resources].reverse()) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.#closing = false;
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "AgentRunner close failed");
    }
    this.#closed = true;
  }

  // 一次取走所有已就绪事件；重复 id 会先 acknowledge 再跳过，避免把同一后台结果多次写入历史。
  // 新增事件按批次位置注入为多条 user message，返回实际注入条数供无工具轮决定是否继续。
  async #acceptNextRuntimeEvent(waitForPendingWork: boolean): Promise<number> {
    if (this.#eventPump === undefined) {
      return 0;
    }
    if (this.#eventPump.ready !== undefined) {
      await this.#eventPump.ready();
    }
    let events = this.#eventPump.drainEvents();
    if (events.length === 0 && waitForPendingWork && this.#eventPump.hasPendingWork) {
      events = await this.#eventPump.waitForEvents();
    }
    if (events.length === 0) {
      return 0;
    }
    // 批次中任一事件非法都显式失败；acknowledge 只针对已取出的事件，不能跨批撤销。
    if (!events.every((event) => isRuntimeEvent(event))) {
      throw new AgentRunError("Runtime event pump returned invalid events");
    }
    // 先过滤重复 id 再计算批次位置，使模型一次看到的是连续、有序的多条完成事实。
    const injected: RuntimeEvent[] = [];
    for (const event of events) {
      if (this.#seenEventIds.has(event.eventId)) {
        continue;
      }
      this.#seenEventIds.add(event.eventId);
      injected.push(event);
    }
    this.#eventPump.acknowledgeEvents(events);
    for (const [index, event] of injected.entries()) {
      this.#history.push(runtimeEventMessage(event, { index, total: injected.length }));
    }
    return injected.length;
  }

  // 关闭或正在关闭的 Runner 都不可继续执行回合；状态错误显式抛出而不是静默降级。
  #ensureOpen(): void {
    if (this.#closed || this.#closing) {
      throw new AgentRunError("AgentRunner is closed");
    }
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
