/**
 * 消息角色定义与不可变工厂函数。
 * 四种角色（system/user/assistant/tool）对应 Chat Completions API 的协议。
 * validateToolPairing 在发送请求前检查 tool_call_id 是否全部配对，
 * 防止 orphan 结果或缺项进入下一轮。工厂函数冻结消息对象以维持不可变性。
 */
export type Role = "system" | "user" | "assistant" | "tool";

// 消息契约阻止孤立 tool result 或未回填的模型工具调用进入下一轮。
export class MessageContractError extends Error {
  override readonly name = "MessageContractError";
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolMessage {
  readonly role: "tool";
  readonly content: string;
  readonly toolCallId: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// 集中校验所有消息字段；allowEmpty 仅用于协议允许空正文的角色。
function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new MessageContractError(`${field} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new MessageContractError(`${field} must not be empty`);
  }
  return value;
}

export function toolCall(id: unknown, name: unknown, argumentsJson: unknown): ToolCall {
  return Object.freeze({
    id: requireString(id, "tool call id"),
    name: requireString(name, "tool call name"),
    arguments: requireString(argumentsJson, "tool call arguments", true),
  });
}

// 工厂函数冻结消息，确保模型请求的历史在创建后不被外部修改。
export function systemMessage(content: string): SystemMessage {
  return Object.freeze({ role: "system", content: requireString(content, "system content", true) });
}

export function userMessage(content: string): UserMessage {
  return Object.freeze({ role: "user", content: requireString(content, "user content", true) });
}

export function assistantMessage(
  content: string | null,
  toolCalls: readonly ToolCall[] = [],
): AssistantMessage {
  if (content !== null) {
    requireString(content, "assistant content", true);
  }
  // 同一 assistant 消息不得重复声明 tool_call_id，否则无法无歧义回填结果。
  const ids = toolCalls.map((call) => call.id);
  if (new Set(ids).size !== ids.length) {
    throw new MessageContractError("assistant tool call ids must be unique");
  }
  return Object.freeze({ role: "assistant", content, toolCalls: Object.freeze([...toolCalls]) });
}

export function toolMessage(content: string, toolCallId: string): ToolMessage {
  return Object.freeze({
    role: "tool",
    content: requireString(content, "tool content", true),
    toolCallId: requireString(toolCallId, "tool_call_id"),
  });
}

export function validateToolPairing(messages: readonly ChatMessage[]): void {
  // pending 保留当前 assistant 消息尚未收到结果的调用标识。
  const pending = new Set<string>();

  for (const message of messages) {
    if (pending.size > 0) {
      if (message.role !== "tool") {
        throw new MessageContractError(
          `missing tool results for ids: ${JSON.stringify([...pending].sort())}`,
        );
      }
      if (!pending.delete(message.toolCallId)) {
        throw new MessageContractError(`unexpected tool result id: ${message.toolCallId}`);
      }
      continue;
    }

    if (message.role === "tool") {
      throw new MessageContractError(`orphan tool result id: ${message.toolCallId}`);
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        pending.add(call.id);
      }
    }
  }

  if (pending.size > 0) {
    throw new MessageContractError(
      `missing tool results for ids: ${JSON.stringify([...pending].sort())}`,
    );
  }
}
