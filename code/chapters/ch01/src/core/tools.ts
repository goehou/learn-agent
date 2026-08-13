import { z } from "zod";

import type { ToolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// 工具注册表将 schema、执行器和模型描述绑定，避免平行定义发生漂移。
//
// 工具注册表（ToolRegistry）是 Agent 的“手”——模型能调用的所有能力都注册在这里。
// 它承担三个职责：
//   1. 保存每个工具的 schema、描述和实际执行函数
//   2. 把工具定义转换成模型能理解的 OpenAIToolSchema
//   3. 在 prepare/invoke 阶段统一处理参数解析、校验和执行
// 本章只有一个 shell 工具，但注册表设计已经为后续章节扩展多个工具做好准备。
// 工具副作用分类；后续权限策略据此决定是否需要额外审批。
export type EffectClass = "read" | "write" | "execute" | "external";

// 每次工具调用由 AgentRunner 注入的受控运行上下文，工具不得自行推断这些边界。
export interface ToolContext {
  // 每次调用共享的受控运行信息；工具不得自行猜测工作目录或身份。
  // workspace 是命令执行的安全根目录；identity 标识当前用户。
  // 这两个字段由 AgentRunner 在每次 run() 时创建并传给所有工具。
  readonly workspace: string;
  readonly identity: string;
  // 可选的去重键，为未来具副作用的重试提供稳定关联而不改变当前工具语义。
  readonly idempotencyKey?: string;
}

// 工具执行后统一回填到聊天历史的结果；错误也以消息形式返回模型继续推理。
export interface ToolResult {
  // 所有成功和失败都用同一结果形状回填为 tool 消息，保证对话可继续。
  // isError=false 表示成功，isError=true 时必须携带 errorCode 供模型分类处理。
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

// 创建无错误码的成功结果，保持结果形状与失败路径一致。
export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

// 创建带稳定机器码的失败结果；模型读取文本，流程可按 errorCode 分类。
export function toolError(errorCode: string, message: string): ToolResult {
  // 机器可读 code 与模型可读文本同时保留；空 code 会破坏错误分类。
  if (errorCode.trim().length === 0) {
    throw new Error("tool error code must not be empty");
  }
  return Object.freeze({
    content: `Error [${errorCode}]: ${message}`,
    isError: true,
    errorCode,
  });
}

// 注册前的泛型工具声明，把输入 schema、元数据和执行器绑定为单一事实来源。
export interface ToolDefinition<Input> {
  // 注册前定义：schema、元数据和业务 handler 必须来自同一声明。
  // 输入 schema 用 Zod 定义，会在 prepare() 阶段解析和校验。
  // effect 标记副作用类别，第 3 章会用权限策略根据它做审批。
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly effect: EffectClass;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// 注册后的擦除泛型表示；输入已由 prepare 校验，invoke 可由循环统一调用。
export interface StoredToolDefinition {
  // 注册后定义擦除泛型输入，并保留已验证的统一调用入口。
  // 注册时把 handler 包装进 invoke，之后 prepare 只处理校验，invoke 只负责执行。
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

// prepare 的两态结果：成功携带已验证参数，失败携带可直接回填的 ToolResult。
export interface PreparedToolCall {
  // prepare 的判别结果：成功时含 definition/arguments，失败时含可回填 error。
  // 成功和失败都返回 PreparedToolCall，让 AgentRunner 永远能拿到可回填的 ToolResult。
  readonly call: ToolCall;
  readonly definition?: StoredToolDefinition;
  readonly arguments?: unknown;
  readonly error?: ToolResult;
}

// 工具定义、模型 schema 与执行器的单一注册表，负责把声明期与调用期边界串联起来。
export class ToolRegistry {
  // 按稳定名称保存已注册工具；私有化避免绕过 register 的不变量检查。
  readonly #definitions: Map<string, StoredToolDefinition>;
  // 快照注册表为 false，阻止模型可见工具集在本轮请求期间发生变更。
  readonly #mutable: boolean;

  // 复制传入映射构造独立视图；mutable=false 仅用于每轮调用的冻结快照。
  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  // 返回名称冻结副本，供诊断或 UI 枚举而不暴露内部 Map。
  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  // 校验并注册工具，同时把泛型 handler 包装为可在运行期安全调用的统一入口。
  register<Input>(definition: ToolDefinition<Input>): void {
    // 注册阶段拒绝重复名和不合法元数据，避免模型 schema 与执行器不一致。
    // 工具名必须符合 OpenAI 对 function name 的限制（字母、数字、下划线）。
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
        definition.handler(definition.inputSchema.parse(input), context),
    };
    this.#definitions.set(definition.name, stored);
  }

  // 创建不可写的注册表副本，让模型看到的工具集与本轮实际执行集一致。
  snapshot(): ToolRegistry {
    // 每轮请求使用不可变快照，使模型可见工具集和实际调度工具集一致。
    // 如果本轮请求期间注册表被修改，快照保证模型看到的和实际执行的是同一份。
    return new ToolRegistry(this.#definitions, false);
  }

  // 从同一注册定义生成 OpenAI 工具 schema，避免模型描述与执行器平行维护。
  openAITools(): readonly OpenAIToolSchema[] {
    // 由同一存储定义生成 JSON Schema，避免额外维护一份模型工具清单。
    // z.toJSONSchema 把 Zod schema 转成 OpenAI 兼容的 JSON Schema。
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

  // 查找工具、解析 JSON 并按 schema 校验；所有失败都转成可回填结果而非抛出到循环。
  prepare(call: ToolCall): PreparedToolCall {
    // 先解析并校验参数；失败也返回可回填的结构，维持消息配对。
    // 未知工具、非法 JSON、非对象参数、schema 不匹配都会生成错误结果。
    // 错误结果同样走 tool 消息回填，模型可以据此调整下一步。
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

  // 执行已准备调用，并将 handler 异常或无效返回值规范化为 ToolResult。
  async invoke(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    // 工具执行异常转换为受控结果，不能中断本轮其余调用的回填。
    // 任何 handler 抛出的异常都被捕获并转成 tool_execution_error，
    // 保证一个工具失败不会导致整个消息链断裂。
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
      return toolError("tool_execution_error", "Tool execution failed");
    }
  }
}

// 运行期收窄扩展 handler 的未知返回值，阻止不合法对象进入消息历史。
function isToolResult(value: unknown): value is ToolResult {
  // handler 是扩展边界，运行时再次验证其返回值才能安全写入消息历史。
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
