import { z } from "zod";

import type { ToolCall } from "./messages.js";
import { toolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// effect 是权限策略和工具列表可见性的最小事实来源，不依赖工具名称猜测。
export type EffectClass = "read" | "write" | "execute" | "external";
// concurrency 是 Dispatcher 判断工具能否转后台执行的显式契约，缺省为 inline。
export type ConcurrencyClass = "inline" | "background_eligible";

// ToolContext 是每次工具调用的不可变执行边界；P18 由 provider 在 handler 前补入
// taskId/claimToken/worktreeName，并把 workspace 解析成当前 claim 的 Worktree 路径。
export interface ToolContext {
  // 实际执行目录：未绑定 claim 时是主 workspace，绑定后是受管 Worktree。
  readonly workspace: string;
  // 执行者身份，用于 claim owner 校验；由 Runner 固定，handler 不可修改。
  readonly identity: string;
  // 幂等键与显式认领 token：自动认领/Subagent 用同一 token 跨回复恢复 claim。
  readonly idempotencyKey?: string;
  readonly taskId?: string;
  readonly claimToken?: string;
  readonly worktreeName?: string;
  // 同一 assistant 回复内的短时 claim 关联，WorktreeRuntime 用它回查 claim token。
  readonly executionScope?: object;
}

export interface ToolResult {
  // content 回填模型；失败必须额外携带稳定 errorCode。
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

// 成功和失败都返回不可变 ToolResult；错误必须携带稳定错误码。
export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

export function toolError(errorCode: string, message: string): ToolResult {
  if (errorCode.trim().length === 0) {
    throw new Error("tool error code must not be empty");
  }
  // 失败结果必须提供稳定 errorCode，便于模型、Hook 和存储层分类处理。
  return Object.freeze({
    content: `Error [${errorCode}]: ${message}`,
    isError: true,
    errorCode,
  });
}

// 任何进入 canonical history 的工具结果都深拷贝，防止 handler 内部可变对象污染会话。
export function copyToolResult(result: ToolResult): ToolResult {
  if (!isToolResult(result)) {
    throw new Error("tool result must satisfy the ToolResult contract");
  }
  if (!result.isError) {
    return toolSuccess(result.content);
  }
  const errorCode = result.errorCode;
  if (errorCode === undefined) {
    throw new Error("error tool result requires an errorCode");
  }
  return Object.freeze({ content: result.content, isError: true, errorCode });
}

export interface ToolDefinition<Input> {
  // handler 接收 provider 已解析的上下文，不自行决定工作目录或身份。
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly effect: EffectClass;
  readonly concurrency?: ConcurrencyClass;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// StoredToolDefinition 隐藏泛型 Input，统一把 schema 校验放在 invoke 边界。
export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  readonly concurrency: ConcurrencyClass;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
  // 成功时具有 definition/arguments，失败时具有可直接回填的 error。
  readonly call: ToolCall;
  readonly definition?: StoredToolDefinition;
  readonly arguments?: unknown;
  readonly error?: ToolResult;
}

export function freezePreparedToolCall(
  call: ToolCall,
  definition: StoredToolDefinition,
  argumentsValue: unknown,
): PreparedToolCall {
  // Hook 改写后重建冻结快照，审批和执行始终读取同一份参数。
  return Object.freeze({
    call: toolCall(call.id, call.name, call.arguments),
    definition,
    arguments: freezeInput(structuredClone(argumentsValue)),
  });
}

// 工具注册表保存冻结定义，并在分发前按上下文与 schema 建立调用边界。
export class ToolRegistry {
  readonly #definitions: Map<string, StoredToolDefinition>;
  readonly #mutable: boolean;

  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    // 复制 Map 隔离调用方修改；snapshot 通过 mutable=false 禁止注册。
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  get names(): readonly string[] {
    // 名称快照按注册顺序返回并冻结。
    return Object.freeze([...this.#definitions.keys()]);
  }

  register<Input>(definition: ToolDefinition<Input>): void {
    // 注册时立即冻结定义；运行期 prepare() 只允许解析、校验和深拷贝输入。
    if (!this.#mutable) {
      throw new Error("tool registry snapshot is immutable");
    }
    if (!/^[A-Za-z0-9_]+$/.test(definition.name)) {
      throw new Error(`invalid tool name: ${definition.name}`);
    }
    if (definition.description.trim().length === 0) {
      throw new Error("tool description must not be empty");
    }
    if (this.#definitions.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }

    const stored: StoredToolDefinition = Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      effect: definition.effect,
      concurrency: definition.concurrency === undefined ? "inline" : definition.concurrency,
      invoke: async (input: unknown, context: ToolContext) =>
        definition.handler(definition.inputSchema.parse(input), context),
    });
    this.#definitions.set(definition.name, stored);
  }

  snapshot(): ToolRegistry {
    // snapshot 用于给子 Agent 等边界提供只读工具视图，不能继续注册新工具。
    return new ToolRegistry(this.#definitions, false);
  }

  subset(names: readonly string[]): ToolRegistry {
    // subset 只暴露显式声明的工具，队友运行时用它限制模型可调用的能力。
    const definitions = new Map<string, StoredToolDefinition>();
    for (const name of names) {
      const definition = this.#definitions.get(name);
      if (definition === undefined) throw new Error(`tool does not exist: ${name}`);
      definitions.set(name, definition);
    }
    return new ToolRegistry(definitions);
  }

  openAITools(): readonly OpenAIToolSchema[] {
    // 模型侧 schema 与运行时 handler 同源，避免平行定义漂移。
    return Object.freeze(
      [...this.#definitions.values()].map((definition) => ({
        type: "function" as const,
        function: {
          name: definition.name,
          description: definition.description,
          parameters: z.toJSONSchema(definition.inputSchema) as Readonly<Record<string, unknown>>,
        },
      })),
    );
  }

  prepare(call: ToolCall): PreparedToolCall {
    // 参数是不可信输入：先解析 JSON，再按 schema 校验，最后冻结完整调用快照。
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
      // 工具故障转成可回填消息，循环可继续让模型决定下一步。
      return { call, error: toolError("unknown_tool", `Unknown tool: ${call.name}`) };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments);
    } catch {
      return {
        call,
        definition,
        error: toolError("invalid_json", "Tool arguments must be valid JSON"),
      };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        call,
        definition,
        error: toolError("invalid_arguments", "Tool arguments must be a JSON object"),
      };
    }

    const parsed = definition.inputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        call,
        definition,
        error: toolError("invalid_arguments", "Tool arguments failed schema validation"),
      };
    }
    // Pre Hook 只能通过 updatedInput 显式改写，不能就地修改受信任的准备结果。
    return freezePreparedToolCall(call, definition, parsed.data);
  }

  async invoke(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    // provider 解析发生在 AgentRunner 调用 invoke 之前。
    if (prepared.error !== undefined) {
      return prepared.error;
    }
    if (prepared.definition === undefined || prepared.arguments === undefined) {
      throw new Error("prepared tool call is incomplete");
    }
    try {
      // handler 异常统一归一为 tool_execution_error，不让内部错误文本直接进入模型上下文。
      const result: unknown = await prepared.definition.invoke(prepared.arguments, context);
      if (!isToolResult(result)) {
        return toolError("invalid_tool_result", "Tool handler returned an invalid result");
      }
      return result;
    } catch {
      return toolError("tool_execution_error", "Tool execution failed");
    }
  }
}

function freezeInput<Input>(value: Input, seen: WeakSet<object> = new WeakSet()): Input {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    freezeInput(nested, seen);
  }
  return Object.freeze(value);
}

// handler 返回值同样属于不可信边界，阻止畸形对象污染会话历史。
export function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const content = Reflect.get(value, "content");
  const isError = Reflect.get(value, "isError");
  const errorCode = Reflect.get(value, "errorCode");
  if (typeof content !== "string" || typeof isError !== "boolean") {
    return false;
  }
  if (isError) {
    return typeof errorCode === "string" && errorCode.trim().length > 0;
  }
  return errorCode === undefined;
}
