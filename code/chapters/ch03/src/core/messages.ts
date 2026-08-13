// 与 Chat Completions 对齐的最小会话消息模型。
export type Role = "system" | "user" | "assistant" | "tool";

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

function requireString(value: unknown, field: string, allowEmpty = false): string {
  // 所有消息构造器的公共格式校验，非字符串或空字符串会在构造阶段立即失败。
  if (typeof value !== "string") {
    throw new MessageContractError(`${field} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new MessageContractError(`${field} must not be empty`);
  }
  return value;
}

export function toolCall(id: unknown, name: unknown, argumentsJson: unknown): ToolCall {
  // 参数保留 JSON 字符串，具体解析和 schema 校验属于工具注册表。
  return Object.freeze({
    id: requireString(id, "tool call id"),
    name: requireString(name, "tool call name"),
    arguments: requireString(argumentsJson, "tool call arguments", true),
  });
}

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
  const ids = toolCalls.map((call) => call.id);
  // 同一 assistant 消息中的调用 ID 是后续工具结果配对的唯一键。
  if (new Set(ids).size !== ids.length) {
    throw new MessageContractError("assistant tool call ids must be unique");
  }
  // toolCalls 冻结防止调用方推入配对后消息后仍能追加调用 ID。
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
  // assistant 工具调用后必须紧随对应数量的 tool 消息，保证供应商协议历史有效。
  const pending = new Set<string>();

  for (const message of messages) {
    if (pending.size > 0) {
      // 有挂起的调用 ID 时，下一条消息必须是 tool 角色，ID 必须匹配。
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

    // 没有挂起 ID 时突然出现 tool 消息，说明历史中有多余结果。
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
