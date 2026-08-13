import type { AssistantMessage, ChatMessage } from "./messages.js";

// 模型边界与供应商 SDK 解耦，循环只处理规范化后的请求和回复。
//
// 核心循环 (AgentRunner) 只知道 ModelClient.complete() 一个入口，
// 不知道具体是 OpenAI、Anthropic 还是本地模拟器。
// 这种边界让测试可以注入 ScriptedModelClient，也方便后续章节替换供应商。
// 供应商结束原因的受控联合；保留 function_call 只为在适配器边界明确拒绝旧协议。
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

// 注册表发布给模型的函数工具定义；parameters 为 JSON Schema。
//
// OpenAIToolSchema 对应 Chat Completions 的 tools 参数格式。
// 模型通过这个 JSON Schema 知道有哪些工具可用、每个工具接受什么参数。
export interface OpenAIToolSchema {
  // 当前协议只发布函数工具，避免把不支持的工具形状传到供应商边界。
  readonly type: "function";
  // 供应商要求嵌套在 function 字段中的工具元数据。
  readonly function: {
    // 模型调用时返回的稳定工具标识，必须与注册表中的名称一致。
    readonly name: string;
    // 面向模型的能力和使用时机说明。
    readonly description: string;
    // JSON Schema 参数契约；核心层不依赖供应商 SDK 的具体类型。
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

// 单次模型请求的冻结快照，防止请求构造后历史或工具定义继续变化。
export interface ModelRequest {
  // 循环向模型边界发送的不可变快照；可选模型/预算供后续章节策略使用。
  // messages 必须是已配对的会话历史；tools 是工具注册表的快照。
  // model/maxTokens 供后续章节在单次请求层面覆盖默认模型或限制 token。
  readonly messages: readonly ChatMessage[];
  // 与 messages 同一时刻冻结的工具描述，模型只能看到本轮可实际调用的能力。
  readonly tools: readonly OpenAIToolSchema[];
  // 可选的本次模型覆盖值；省略时由适配器使用已校验的默认模型。
  readonly model?: string;
  // 可选的单次输出预算；不是整轮 Agent 的回合预算。
  readonly maxTokens?: number;
}

// 统一供应商的用量统计字段，避免核心逻辑依赖各 SDK 的命名约定。
export interface TokenUsage {
  // 供应商用量统一为内部字段名，避免核心依赖 SDK 的 snake_case。
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

// 模型适配器返回给 Agent Loop 的规范化结果，包含消息、结束原因和可选用量。
export interface ModelReply {
  // 适配器必须把供应商回复规范化为 assistant 消息和明确结束原因。
  // finishReason 用于区分正常结束（stop）、被截断（length）和请求工具（tool_calls）。
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

// 核心循环唯一的模型依赖点；实现负责网络、SDK 和外部响应的边界校验。
export interface ModelClient {
  // 唯一模型依赖点；测试可用脚本化实现验证每轮请求。
  // complete() 接收完整请求（消息 + 工具定义），返回规范化的回复。
  // 这保持核心循环与 SDK 完全隔离。
  complete(request: ModelRequest): Promise<ModelReply>;
}
