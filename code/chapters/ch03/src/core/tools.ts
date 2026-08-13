import { z } from "zod";

import type { ToolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// effect 是权限策略判断副作用的语义标签，而不是执行方式。
export type EffectClass = "read" | "write" | "execute" | "external";

export interface ToolContext {
  // 所有文件和命令工具必须使用的工作区根。
  readonly workspace: string;
  // 供权限策略和审计使用的调用主体。
  readonly identity: string;
  // 为副作用重试保留的可选去重关联。
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
  // 成功结果不携带错误码，isToolResult 用 errorCode 缺失验证成功分支。
  return Object.freeze({ content, isError: false });
}

export function toolError(errorCode: string, message: string): ToolResult {
  // 错误结果必须有稳定错误码，模型和测试无需解析文本即可判断失败类别。
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
  // 在执行前校验模型 JSON 参数的 schema。
  readonly inputSchema: z.ZodType<Input>;
  // 权限策略使用的副作用分类。
  readonly effect: EffectClass;
  // 已验证输入的实际执行器。
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  // invoke 是注册时包装好的校验执行入口；handler 本身不直接暴露给循环。
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
  // 原始但字段完整的模型调用。
  readonly call: ToolCall;
  // 成功或参数错误时对应的注册工具。
  readonly definition?: StoredToolDefinition;
  // 通过 schema 的参数对象。
  readonly arguments?: unknown;
  // 模型输入失败时可直接回填的结果。
  readonly error?: ToolResult;
}

export class ToolRegistry {
  // 按名称保存唯一工具定义。
  readonly #definitions: Map<string, StoredToolDefinition>;
  // false 表示模型请求期间不可变的注册表快照。
  readonly #mutable: boolean;

  // 复制定义映射，避免外部 Map 继续改变当前视图。
  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  get names(): readonly string[] {
    // 只暴露冻结的键名快照，调用方不能借此修改内部注册表。
    return Object.freeze([...this.#definitions.keys()]);
  }

  // 校验元数据并注册工具，将泛型 handler 封装为运行期入口。
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
      // 再次解析确保即使调用方绕过 prepare，也不会把未校验输入传给 handler。
      invoke: async (input, context) =>
        definition.handler(definition.inputSchema.parse(input), context),
    };
    this.#definitions.set(definition.name, stored);
  }

  // 复制为不可写快照，让模型可见工具集与本轮实际执行集一致。
  snapshot(): ToolRegistry {
    // 每轮使用不可变快照，避免模型请求与执行之间的注册表被篡改。
    return new ToolRegistry(this.#definitions, false);
  }

  // 从注册定义生成模型工具 schema，避免与 handler 平行维护。
  openAITools(): readonly OpenAIToolSchema[] {
    // 只序列化模型可见字段；handler、effect 与内部 Map 保持在模型视野之外。
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

  // 查找工具、解析 JSON 并校验 schema；所有模型输入错误转为回填结果。
  prepare(call: ToolCall): PreparedToolCall {
    // 解析与 schema 校验先于权限策略；策略永远面对可信的工具定义和参数。
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

  // 调用已准备工具，并把 handler 异常或无效返回值规范化为 ToolResult。
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
      // 工具故障转成可回填消息，循环可继续让模型决定下一步。
      return toolError("tool_execution_error", "Tool execution failed");
    }
  }
}

function isToolResult(value: unknown): value is ToolResult {
  // handler 返回值同样属于不可信边界，阻止畸形对象污染会话历史。
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
