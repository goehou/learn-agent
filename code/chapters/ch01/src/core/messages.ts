export type Role = "system" | "user" | "assistant" | "tool";

// 消息契约保证模型工具调用与后续 tool result 在历史中严格一一对应。
//
// ChatMessage 是四类消息的 discriminated union：
//   system     - 系统提示词，每次请求时由 AgentRunner 前置
//   user       - 用户输入，运行开始时进入历史
//   assistant  - 模型回复，可能包含零个或多个 toolCalls
//   tool       - 工具执行结果，必须通过 toolCallId 对应到 assistant 的调用
// 这个契约是 Agent Loop 正确性的基础：模型必须能精确知道每个工具结果属于哪个调用。
export class MessageContractError extends Error {
  override readonly name = "MessageContractError";
}

export interface ToolCall {
  // ToolCall 表示模型在一次回复中请求执行的一个工具。
  // id 是本次调用的唯一标识；arguments 是 JSON 字符串，由 ToolRegistry 负责解析校验。
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
  // 所有消息构造器共享此边界检查，区分“不是字符串”和“不允许空字符串”。
  // allowEmpty=true 用于 arguments/content 等允许为空的场景。
  if (typeof value !== "string") {
    throw new MessageContractError(`${field} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new MessageContractError(`${field} must not be empty`);
  }
  return value;
}

export function toolCall(id: unknown, name: unknown, argumentsJson: unknown): ToolCall {
  // arguments 保留原始 JSON 文本；解析及 schema 校验属于 ToolRegistry 的职责。
  // 核心循环不解析参数，只把文本原样传给工具注册表。
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
  // 同一 assistant 回复内的调用 ID 必须唯一，否则 tool result 无法一一对应。
  // 多个工具并行时，每个调用必须有一个唯一 ID 才能正确配对结果。
  if (content !== null) {
    requireString(content, "assistant content", true);
  }
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
  // 遇到 assistant 调用后，只接受其尚未回填的 tool 消息，直到集合清空。
  // 这是核心不变量：任何 assistant 的工具调用都必须有且只有一个对应 tool result。
  // 在请求发往模型前调用它，可以提前发现历史损坏，避免远端请求浪费。
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
