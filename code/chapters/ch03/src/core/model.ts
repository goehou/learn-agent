import type { AssistantMessage, ChatMessage } from "./messages.js";

// 供应商 adapter 必须归一为这些结束状态，循环据此处理截断、内容过滤或正常结束。
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

export interface OpenAIToolSchema {
  // 模型看到的工具定义只包含名称、描述和 JSON Schema，不暴露 handler 或 effect。
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface ModelRequest {
  // model 和 maxTokens 可由更高章节的恢复或预算层覆写。
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAIToolSchema[];
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface TokenUsage {
  // 用量用于观测和分析，Adapters 必须按严格整数契约提供。
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ModelReply {
  // normalized finishReason 是唯一权威的结束信号，adapter 不得保留原始供应商枚举。
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

export interface ModelClient {
  // core 只依赖一次完整调用；重试、降级和恢复由上层组合根在 adapter 外实现。
  complete(request: ModelRequest): Promise<ModelReply>;
}
