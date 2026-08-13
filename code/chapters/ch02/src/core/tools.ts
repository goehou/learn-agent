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
  // 调用主体标识，为后续权限策略提供稳定输入。
  readonly identity: string;
  // 可选去重键，为具副作用重试保留关联。
  readonly idempotencyKey?: string;
}

export interface ToolResult {
  // 模型可读取的成功输出或错误正文。
  readonly content: string;
  // 是否为错误结果，决定 errorCode 的约束。
  readonly isError: boolean;
  // 错误时必须存在的机器可读稳定码。
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
  // 提供给模型和注册表的稳定工具名。
  readonly name: string;
  // 面向模型的使用说明。
  readonly description: string;
  // 在执行前校验模型 JSON 参数的 Zod schema。
  readonly inputSchema: z.ZodType<Input>;
  // 权限策略使用的副作用分类。
  readonly effect: EffectClass;
  // 已验证输入的实际执行器，可同步或异步返回统一结果。
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// 注册后擦除泛型输入的内部定义，统一由 invoke 调用。
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
  // 成功或已识别参数错误时对应的注册工具。
  readonly definition?: StoredToolDefinition;
  // 通过 schema 的参数对象；存在时才允许执行。
  readonly arguments?: unknown;
  // 模型输入失败时可直接回填的结果。
  readonly error?: ToolResult;
}

export class ToolRegistry {
  // 按名称保存唯一工具定义。
  readonly #definitions: Map<string, StoredToolDefinition>;
  // false 表示每轮模型请求使用的不可写快照。
  readonly #mutable: boolean;

  // 复制定义映射，避免外部 Map 继续改变当前注册表。
  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  // 返回冻结名称列表，供诊断读取而不暴露内部 Map。
  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  // 校验元数据并注册工具，将泛型 handler 封装为统一的运行期入口。
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

  // 创建不可写副本，使模型可见工具集与本轮实际执行集一致。
  snapshot(): ToolRegistry {
    // 模型请求使用不可变快照，确保本轮工具集不会在调用途中改变。
    return new ToolRegistry(this.#definitions, false);
  }

  // 从注册定义稳定生成 OpenAI JSON Schema，避免与 handler 平行维护。
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

  // 查找工具、解析 JSON 并执行 schema 校验；错误转换为可回填结果而不抛出。
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

  // 执行已准备调用，并把 handler 异常或无效返回值规范化为 ToolResult。
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

// 在运行期收窄扩展 handler 的返回值，阻止无效对象进入消息历史。
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
