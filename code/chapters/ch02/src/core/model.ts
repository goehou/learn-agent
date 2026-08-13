/**
 * 模型边界模块：定义核心循环依赖的最小模型接口。
 * ModelClient.complete 是唯一异步入口，适配器负责把供应商响应归一化为 ModelReply。
 * OpenAIToolSchema 描述模型可见的工具结构，FinishReason 只保留本项目支持的终止原因。
 */
import type { AssistantMessage, ChatMessage } from "./messages.js";

// 与供应商 finish_reason 对齐的最小联合类型；旧 function_call 在适配器中显式拒绝。
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

// 模型可见的 function tool 描述，与内部 ToolDefinition 解耦。
export interface OpenAIToolSchema {
  // 当前协议只允许函数工具。
  readonly type: "function";
  // 供应商规定的函数工具元数据容器。
  readonly function: {
    // 与注册表一致的稳定调用名。
    readonly name: string;
    // 面向模型的能力说明。
    readonly description: string;
    // 不依赖 SDK 类型的 JSON Schema 参数契约。
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

// 单次模型请求的冻结快照，避免构造后历史或工具集继续变化。
export interface ModelRequest {
  // 已验证的会话历史。
  readonly messages: readonly ChatMessage[];
  // 本轮实际可调用工具的冻结描述。
  readonly tools: readonly OpenAIToolSchema[];
  // 可选单次模型覆盖。
  readonly model?: string;
  // 可选单次输出预算，区别于 Agent 回合上限。
  readonly maxTokens?: number;
}

// 用量是可选观测数据，适配器仅在供应商完整返回时填充。
export interface TokenUsage {
  // 输入消息消耗的 token 数。
  readonly promptTokens: number;
  // 输出回复消耗的 token 数。
  readonly completionTokens: number;
  // 供应商报告的总 token 数。
  readonly totalTokens: number;
}

// 适配器交回核心循环的规范化回复。
export interface ModelReply {
  // 已收窄为核心消息契约的模型回复。
  readonly message: AssistantMessage;
  // 决定循环继续、结束或失败的结束原因。
  readonly finishReason: FinishReason;
  // 供后续预算策略使用的可选统计。
  readonly usage?: TokenUsage;
}

export interface ModelClient {
  // 核心循环只通过此异步边界请求下一条模型消息。
  complete(request: ModelRequest): Promise<ModelReply>;
}
