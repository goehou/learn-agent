/**
 * 工具注册表模块：将工具的名称、描述、Zod schema、副作用分类和处理函数绑定为单一闭包。
 * Agent Loop 通过 prepare → invoke 调用，不在循环里 switch 工具名称。
 * prepare 把所有模型输入错误（未知工具、坏 JSON、非法参数）封装为 ToolResult，
 * 因此非法参数不会先执行再报错。snapshot 返回不可变副本，确保本轮工具定义不会中途变化。
 * openAITools 按注册顺序稳定导出，与 KV Cache 前缀稳定性约束一致。
 */
import { z } from "zod";

import type { ToolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// 工具注册表把 schema、模型描述和执行器绑定，避免三份定义漂移。
export type EffectClass = "read" | "write" | "execute" | "external";

export interface ToolContext {
  // identity 和幂等键为后续策略层预留；P02 执行器只使用 workspace。
  readonly workspace: string;
  readonly identity: string;
  readonly idempotencyKey?: string;
}

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

// 错误结果仍作为 tool message 回填，使模型能基于稳定错误码自主调整。
export function toolError(errorCode: string, message: string): ToolResult {
  if (errorCode.trim().length === 0) {
    throw new Error("tool error code must not be empty");
  }
  return Object.freeze({
    content: `Error [${errorCode}]: ${message}`,
    isError: true,
    errorCode,
  });
}

export interface ToolDefinition<Input> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly effect: EffectClass;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
  // prepare 不抛出模型输入错误，而是保存可安全回填的 error。
  readonly call: ToolCall;
  readonly definition?: StoredToolDefinition;
  readonly arguments?: unknown;
  readonly error?: ToolResult;
}

export class ToolRegistry {
  readonly #definitions: Map<string, StoredToolDefinition>;
  readonly #mutable: boolean;

  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  register<Input>(definition: ToolDefinition<Input>): void {
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

    const stored: StoredToolDefinition = {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      effect: definition.effect,
      invoke: async (input, context) =>
        // 再次 parse 保证任何绕过 prepare 的内部调用也不能越过 schema。
        definition.handler(definition.inputSchema.parse(input), context),
    };
    this.#definitions.set(definition.name, stored);
  }

  snapshot(): ToolRegistry {
    // 模型请求使用不可变快照，确保本轮工具集不会在调用途中改变。
    return new ToolRegistry(this.#definitions, false);
  }

  openAITools(): readonly OpenAIToolSchema[] {
    // 每次导出都生成 JSON Schema，模型描述与实际校验器保持同源。
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
    // 参数错误也被封装为结果，Agent Loop 仍可回填对应 tool message。
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
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
    return { call, definition, arguments: parsed.data };
  }

  async invoke(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    if (prepared.error !== undefined) {
      return prepared.error;
    }
    if (prepared.definition === undefined || prepared.arguments === undefined) {
      throw new Error("prepared tool call is incomplete");
    }
    try {
      const result: unknown = await prepared.definition.invoke(prepared.arguments, context);
      if (!isToolResult(result)) {
        return toolError("invalid_tool_result", "Tool handler returned an invalid result");
      }
      return result;
    } catch {
      // 执行器异常不得破坏消息配对协议，统一降级为可回填错误结果。
      return toolError("tool_execution_error", "Tool execution failed");
    }
  }
}

function isToolResult(value: unknown): value is ToolResult {
  // 执行器是扩展边界，运行时复核返回形状后才写入对话历史。
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
