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
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAIToolSchema[];
  readonly model?: string;
  readonly maxTokens?: number;
}

// 用量是可选观测数据，适配器仅在供应商完整返回时填充。
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ModelReply {
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

export interface ModelClient {
  // 核心循环只通过此异步边界请求下一条模型消息。
  complete(request: ModelRequest): Promise<ModelReply>;
}
