// 供应商 adapter 必须归一为这些结束状态，循环据此处理不可完成或被过滤的回复。
// 模型接口边界：core 只依赖 complete() 返回规范化 ModelReply，不绑定供应商 SDK。
import type { AssistantMessage, ChatMessage } from "./messages.js";

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

export interface OpenAIToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

// model 和 maxTokens 可由更高章节的恢复或预算层覆写。
export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAIToolSchema[];
  readonly model?: string;
  readonly maxTokens?: number;
}

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

// core 只依赖一次完整调用，不感知 OpenAI SDK 或 HTTP 细节。
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelReply>;
}
