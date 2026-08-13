// 与 Chat Completions 对齐的最小会话消息模型。
export type Role = "system" | "user" | "assistant" | "tool";

export class MessageContractError extends Error {
  // 稳定错误名，表明历史或工厂输入违反消息契约。
  override readonly name = "MessageContractError";
}

export interface ToolCall {
  // 供应商生成的调用唯一 ID，tool result 通过它回填关联。
  readonly id: string;
  // 注册表查找使用的工具名称。
  readonly name: string;
  // 原始 JSON 参数文本，仅由 ToolRegistry 解析。
  readonly arguments: string;
}

export interface SystemMessage {
  // 判别标签；系统约束在每轮请求临时前置。
  readonly role: "system";
  // 系统提示正文。
  readonly content: string;
}

export interface UserMessage {
  // 判别标签；一次 run 的起点。
  readonly role: "user";
  // 用户原始任务文本。
  readonly content: string;
}

export interface AssistantMessage {
  // 判别标签；模型回复。
  readonly role: "assistant";
  // 最终文本或工具调用时的 null。
  readonly content: string | null;
  // 本回复提出且必须逐项回填的工具调用。
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolMessage {
  // 判别标签；工具执行后的回填消息。
  readonly role: "tool";
  // 成功输出或带错误码的失败正文。
  readonly content: string;
  // 对应 assistant 调用的唯一 ID。
  readonly toolCallId: string;
}

// 四类消息的判别联合，供配对验证和供应商转换进行穷尽分支。
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

// 创建并冻结工具调用，参数仅在注册表 prepare 阶段解析和校验。
export function toolCall(id: unknown, name: unknown, argumentsJson: unknown): ToolCall {
  // 参数保留 JSON 字符串，具体解析和 schema 校验属于工具注册表。
  return Object.freeze({
    id: requireString(id, "tool call id"),
    name: requireString(name, "tool call name"),
    arguments: requireString(argumentsJson, "tool call arguments", true),
  });
}

// 创建系统消息；具体系统提示非空约束由 AgentRunner 承担。
export function systemMessage(content: string): SystemMessage {
  return Object.freeze({ role: "system", content: requireString(content, "system content", true) });
}

// 创建用户消息；消息层不改变上层输入策略。
export function userMessage(content: string): UserMessage {
  return Object.freeze({ role: "user", content: requireString(content, "user content", true) });
}

// 创建模型消息并保证单一回复内工具调用 ID 可无歧义配对。
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

// 创建工具结果消息，要求关联 ID 非空以保持调用可审计。
export function toolMessage(content: string, toolCallId: string): ToolMessage {
  return Object.freeze({
    role: "tool",
    content: requireString(content, "tool content", true),
    toolCallId: requireString(toolCallId, "tool_call_id"),
  });
}

// 验证完整历史的调用/结果配对不变量，在请求供应商前阻止损坏状态外泄。
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
