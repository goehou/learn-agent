import type { ChatMessage } from "./messages.js";
import { isChatMessage, systemMessage, userMessage } from "./messages.js";
import type { PermissionBehavior } from "./permissions.js";
import { isPermissionBehavior } from "./permissions.js";
import type { PreparedToolCall, ToolResult } from "./tools.js";
import { copyToolResult, freezePreparedToolCall, isToolResult } from "./tools.js";

export const HOOK_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const);
// Hook 是受限扩展点：事件上下文和返回值均按事件类型严格校验。
export type HookEvent = (typeof HOOK_EVENTS)[number];

export class HookContractError extends Error {
  override readonly name: string = "HookContractError";
}

function isHookEvent(value: unknown): value is HookEvent {
  return HOOK_EVENTS.some((event) => event === value);
}

function isValidPrepared(prepared: unknown): prepared is PreparedToolCall {
  if (typeof prepared !== "object" || prepared === null) {
    return false;
  }
  const value = prepared as PreparedToolCall;
  const call = value.call;
  const definition = value.definition;
  return (
    typeof call === "object" &&
    call !== null &&
    typeof call.id === "string" &&
    call.id.length > 0 &&
    typeof call.name === "string" &&
    call.name.length > 0 &&
    typeof call.arguments === "string" &&
    value.error === undefined &&
    typeof definition === "object" &&
    definition !== null &&
    typeof definition.name === "string" &&
    typeof definition.inputSchema?.safeParse === "function" &&
    typeof definition.invoke === "function" &&
    value.arguments !== undefined
  );
}

export interface HookContextOptions {
  readonly event: HookEvent;
  readonly message?: ChatMessage;
  readonly prepared?: PreparedToolCall;
  readonly result?: ToolResult;
  readonly history?: readonly ChatMessage[];
  readonly stopHookActive?: boolean;
}

export class HookContext {
  // 每个事件只携带其拥有的数据，避免 Hook 误用其他生命周期阶段的状态。
  readonly event: HookEvent;
  readonly message: ChatMessage | undefined;
  readonly prepared: PreparedToolCall | undefined;
  readonly result: ToolResult | undefined;
  readonly history: readonly ChatMessage[];
  readonly stopHookActive: boolean;

  constructor(options: HookContextOptions) {
    if (!isHookEvent(options.event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    const history = options.history === undefined ? [] : options.history;
    const stopHookActive = options.stopHookActive === undefined ? false : options.stopHookActive;
    if (!Array.isArray(history) || !history.every((message: unknown) => isChatMessage(message))) {
      throw new HookContractError(`${options.event} history must contain ChatMessage values`);
    }
    if (typeof stopHookActive !== "boolean") {
      throw new HookContractError("stopHookActive must be boolean");
    }

    this.event = options.event;
    this.message = options.message;
    this.prepared = options.prepared;
    this.result = options.result;
    this.history = Object.freeze([...history]);
    this.stopHookActive = stopHookActive;
    this.#validateEventFields();
    Object.freeze(this);
  }

  #validateEventFields(): void {
    if (this.event === "UserPromptSubmit") {
      if (!isChatMessage(this.message) || this.message.role !== "user") {
        throw new HookContractError("UserPromptSubmit requires a user message");
      }
      if (
        this.prepared !== undefined ||
        this.result !== undefined ||
        this.history.length > 0 ||
        this.stopHookActive
      ) {
        throw new HookContractError("UserPromptSubmit received fields owned by another event");
      }
      return;
    }
    if (this.event === "PreToolUse") {
      if (!isValidPrepared(this.prepared)) {
        throw new HookContractError("PreToolUse requires a valid prepared tool call");
      }
      if (
        this.message !== undefined ||
        this.result !== undefined ||
        this.history.length > 0 ||
        this.stopHookActive
      ) {
        throw new HookContractError("PreToolUse received fields owned by another event");
      }
      return;
    }
    if (this.event === "PostToolUse") {
      if (!isValidPrepared(this.prepared)) {
        throw new HookContractError("PostToolUse requires a valid prepared tool call");
      }
      if (!isToolResult(this.result)) {
        throw new HookContractError("PostToolUse requires a tool result");
      }
      if (this.message !== undefined || this.history.length > 0 || this.stopHookActive) {
        throw new HookContractError("PostToolUse received fields owned by another event");
      }
      return;
    }
    if (this.message !== undefined || this.prepared !== undefined || this.result !== undefined) {
      throw new HookContractError("Stop received fields owned by another event");
    }
  }
}

export interface HookResultOptions {
  readonly permissionBehavior?: PermissionBehavior;
  readonly updatedInput?: PreparedToolCall;
  readonly updatedOutput?: ToolResult;
  readonly additionalContext?: readonly ChatMessage[];
  readonly blockingError?: ToolResult;
  readonly preventContinuation?: boolean;
  readonly forceContinue?: ChatMessage;
}

export class HookResult {
  // 构造器内校验类型并冻结副本，防止回调引用扩散污染。
  // Hook 的副作用被建模为结构化结果，不能直接修改 Agent 内部状态。
  readonly permissionBehavior: PermissionBehavior;
  readonly updatedInput: PreparedToolCall | undefined;
  readonly updatedOutput: ToolResult | undefined;
  readonly additionalContext: readonly ChatMessage[];
  readonly blockingError: ToolResult | undefined;
  readonly preventContinuation: boolean;
  readonly forceContinue: ChatMessage | undefined;

  constructor(options: HookResultOptions = {}) {
    const permissionBehavior = options.permissionBehavior ?? "passthrough";
    const additionalContext = options.additionalContext ?? [];
    const preventContinuation = options.preventContinuation ?? false;
    if (!isPermissionBehavior(permissionBehavior)) {
      throw new HookContractError("permissionBehavior must be a PermissionBehavior");
    }
    if (options.updatedInput !== undefined && !isValidPrepared(options.updatedInput)) {
      throw new HookContractError("updatedInput must be a valid prepared tool call");
    }
    if (options.updatedOutput !== undefined && !isToolResult(options.updatedOutput)) {
      throw new HookContractError("updatedOutput must be a ToolResult");
    }
    if (
      options.blockingError !== undefined &&
      (!isToolResult(options.blockingError) || !options.blockingError.isError)
    ) {
      throw new HookContractError("blockingError must be an error ToolResult");
    }
    if (
      !Array.isArray(additionalContext) ||
      !additionalContext.every(
        (message: unknown) => isChatMessage(message) && message.role === "system",
      )
    ) {
      throw new HookContractError("additionalContext must contain system ChatMessage values");
    }
    if (typeof preventContinuation !== "boolean") {
      throw new HookContractError("preventContinuation must be boolean");
    }
    if (
      options.forceContinue !== undefined &&
      (!isChatMessage(options.forceContinue) || options.forceContinue.role !== "user")
    ) {
      throw new HookContractError("forceContinue must be a user message");
    }

    this.permissionBehavior = permissionBehavior;
    this.updatedInput = options.updatedInput;
    this.updatedOutput =
      options.updatedOutput === undefined ? undefined : copyToolResult(options.updatedOutput);
    this.additionalContext = Object.freeze(
      additionalContext.map((message) => systemMessage(message.content)),
    );
    this.blockingError =
      options.blockingError === undefined ? undefined : copyToolResult(options.blockingError);
    this.preventContinuation = preventContinuation;
    this.forceContinue =
      options.forceContinue === undefined ? undefined : userMessage(options.forceContinue.content);
    Object.freeze(this);
  }

  validateFor(event: HookEvent): void {
    if (!isHookEvent(event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    const invalid: string[] = [];
    if (event !== "PreToolUse") {
      if (this.permissionBehavior !== "passthrough") {
        invalid.push("permissionBehavior");
      }
      if (this.updatedInput !== undefined) {
        invalid.push("updatedInput");
      }
      if (this.blockingError !== undefined) {
        invalid.push("blockingError");
      }
    }
    if (event !== "PostToolUse") {
      if (this.updatedOutput !== undefined) {
        invalid.push("updatedOutput");
      }
      if (this.preventContinuation) {
        invalid.push("preventContinuation");
      }
    }
    if (event !== "Stop" && this.forceContinue !== undefined) {
      invalid.push("forceContinue");
    }
    if (invalid.length > 0) {
      throw new HookContractError(
        `${event} HookResult does not allow fields: ${invalid.join(", ")}`,
      );
    }
  }
}

export type HookCallback = (context: HookContext) => HookResult | Promise<HookResult>;

export class HookRegistry {
  // 每个事件有独立回调队列，注册顺序即为执行顺序。
  // 回调按注册顺序合并；后续回调读取前一个回调规范化后的上下文。
  readonly #callbacks: Map<HookEvent, HookCallback[]> = new Map(
    HOOK_EVENTS.map((event) => [event, []]),
  );

  register(event: HookEvent, callback: HookCallback): void {
    if (!isHookEvent(event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    if (typeof callback !== "function") {
      throw new HookContractError("hook callback must be callable");
    }
    const callbacks = this.#callbacks.get(event);
    if (callbacks === undefined) {
      throw new HookContractError(`hook registry is missing event: ${event}`);
    }
    callbacks.push(callback);
  }

  async run(context: HookContext): Promise<HookResult> {
    // 串行执行回调，合并结果；blockingError 或 forceContinue 短路。
    if (!(context instanceof HookContext)) {
      throw new HookContractError("context must be a HookContext");
    }
    let combined = new HookResult();
    let current = context;
    const callbacks = this.#callbacks.get(context.event);
    if (callbacks === undefined) {
      throw new HookContractError(`hook registry is missing event: ${context.event}`);
    }
    for (const callback of callbacks) {
      const outcome: unknown = await callback(current);
      if (!(outcome instanceof HookResult)) {
        throw new HookContractError(`${context.event} hook callback must return HookResult`);
      }
      outcome.validateFor(context.event);
      const normalizedInput = normalizeUpdatedInput(current, outcome);
      const normalizedOutcome =
        normalizedInput === undefined
          ? outcome
          : new HookResult({
              permissionBehavior: outcome.permissionBehavior,
              updatedInput: normalizedInput,
              additionalContext: outcome.additionalContext,
              ...(outcome.blockingError === undefined
                ? {}
                : { blockingError: outcome.blockingError }),
            });
      const effective =
        context.event === "Stop" &&
        context.stopHookActive &&
        normalizedOutcome.forceContinue !== undefined
          ? new HookResult({ additionalContext: normalizedOutcome.additionalContext })
          : normalizedOutcome;
      combined = mergeResults(combined, effective);

      if (effective.updatedInput !== undefined) {
        current = new HookContext({ event: "PreToolUse", prepared: effective.updatedInput });
      }
      if (effective.updatedOutput !== undefined && current.prepared !== undefined) {
        current = new HookContext({
          event: "PostToolUse",
          prepared: current.prepared,
          result: effective.updatedOutput,
        });
      }
      if (effective.blockingError !== undefined || effective.forceContinue !== undefined) {
        break;
      }
    }
    return combined;
  }

  async runUserPrompt(message: ChatMessage): Promise<HookResult> {
    return this.run(new HookContext({ event: "UserPromptSubmit", message }));
  }

  async runPreTool(prepared: PreparedToolCall): Promise<HookResult> {
    return this.run(new HookContext({ event: "PreToolUse", prepared }));
  }

  async runPostTool(prepared: PreparedToolCall, result: ToolResult): Promise<HookResult> {
    return this.run(new HookContext({ event: "PostToolUse", prepared, result }));
  }

  async runStop(history: readonly ChatMessage[], stopHookActive: boolean): Promise<HookResult> {
    return this.run(new HookContext({ event: "Stop", history, stopHookActive }));
  }
}

function normalizeUpdatedInput(
  // 重新解析 updatedInput 并冻结副本，防止“批准 A、执行 B”。
  context: HookContext,
  result: HookResult,
): PreparedToolCall | undefined {
  const updated = result.updatedInput;
  if (updated === undefined) {
    return undefined;
  }
  const original = context.prepared;
  if (original === undefined || original.definition === undefined) {
    throw new HookContractError("updatedInput requires an existing prepared tool call");
  }
  if (updated.call.id !== original.call.id) {
    throw new HookContractError("updatedInput must preserve the OpenAI tool call id");
  }
  if (updated.call.name !== original.call.name) {
    throw new HookContractError("updatedInput must preserve the tool name");
  }
  if (updated.definition !== original.definition) {
    throw new HookContractError("updatedInput must preserve the registered definition");
  }
  const parsed = original.definition.inputSchema.safeParse(updated.arguments);
  if (!parsed.success) {
    throw new HookContractError("updatedInput arguments must match the registered input schema");
  }
  // 审批和执行只读取这个脱离 Hook 原引用的冻结副本，避免批准 A、执行 B。
  return freezePreparedToolCall(updated.call, original.definition, parsed.data);
}

function mergeResults(current: HookResult, incoming: HookResult): HookResult {
  // 合并策略：updatedInput/Output 以后优先，additionalContext 串联，
  // preventContinuation OR，permissionBehavior 取最严格，
  // blockingError/forceContinue 短路并保留最先出现的。
  return new HookResult({
    permissionBehavior: strongerPermission(current.permissionBehavior, incoming.permissionBehavior),
    ...(incoming.updatedInput === undefined
      ? current.updatedInput === undefined
        ? {}
        : { updatedInput: current.updatedInput }
      : { updatedInput: incoming.updatedInput }),
    ...(incoming.updatedOutput === undefined
      ? current.updatedOutput === undefined
        ? {}
        : { updatedOutput: current.updatedOutput }
      : { updatedOutput: incoming.updatedOutput }),
    additionalContext: [...current.additionalContext, ...incoming.additionalContext],
    ...(incoming.blockingError === undefined
      ? current.blockingError === undefined
        ? {}
        : { blockingError: current.blockingError }
      : { blockingError: incoming.blockingError }),
    preventContinuation: current.preventContinuation || incoming.preventContinuation,
    ...(incoming.forceContinue === undefined
      ? current.forceContinue === undefined
        ? {}
        : { forceContinue: current.forceContinue }
      : { forceContinue: incoming.forceContinue }),
  });
}

function strongerPermission(
  current: PermissionBehavior,
  incoming: PermissionBehavior,
): PermissionBehavior {
  const priority: Readonly<Record<PermissionBehavior, number>> = {
    passthrough: 0,
    allow: 1,
    ask: 2,
    deny: 3,
  };
  return priority[incoming] > priority[current] ? incoming : current;
}
