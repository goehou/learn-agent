import type { AssistantMessage, ChatMessage } from "./messages.js";

// 模型边界与供应商 SDK 解耦，循环只处理规范化后的请求和回复。
//
// 核心循环 (AgentRunner) 只知道 ModelClient.complete() 一个入口，
// 不知道具体是 OpenAI、Anthropic 还是本地模拟器。
// 这种边界让测试可以注入 ScriptedModelClient，也方便后续章节替换供应商。
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

// 注册表发布给模型的函数工具定义；parameters 为 JSON Schema。
//
// OpenAIToolSchema 对应 Chat Completions 的 tools 参数格式。
// 模型通过这个 JSON Schema 知道有哪些工具可用、每个工具接受什么参数。
export interface OpenAIToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface ModelRequest {
  // 循环向模型边界发送的不可变快照；可选模型/预算供后续章节策略使用。
  // messages 必须是已配对的会话历史；tools 是工具注册表的快照。
  // model/maxTokens 供后续章节在单次请求层面覆盖默认模型或限制 token。
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAIToolSchema[];
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface TokenUsage {
  // 供应商用量统一为内部字段名，避免核心依赖 SDK 的 snake_case。
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ModelReply {
  // 适配器必须把供应商回复规范化为 assistant 消息和明确结束原因。
  // finishReason 用于区分正常结束（stop）、被截断（length）和请求工具（tool_calls）。
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

export interface ModelClient {
  // 唯一模型依赖点；测试可用脚本化实现验证每轮请求。
  // complete() 接收完整请求（消息 + 工具定义），返回规范化的回复。
  // 这保持核心循环与 SDK 完全隔离。
  complete(request: ModelRequest): Promise<ModelReply>;
}
