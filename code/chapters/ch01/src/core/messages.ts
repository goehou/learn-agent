// 聊天历史的判别标签；role 决定每条消息允许出现的字段以及工具配对规则。
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
  // 保持稳定错误名，便于 CLI 和测试将消息契约错误与外部故障区分开。
  override readonly name = "MessageContractError";
}

// 模型在 assistant 回复中声明的一次工具调用；随后必须有对应 ToolMessage 回填。
export interface ToolCall {
  // ToolCall 表示模型在一次回复中请求执行的一个工具。
  // id 是本次调用的唯一标识；arguments 是 JSON 字符串，由 ToolRegistry 负责解析校验。
  readonly id: string;
  // 注册表查找工具定义使用的名称，不是面向用户显示的描述。
  readonly name: string;
  // 保留供应商给出的 JSON 文本，避免消息层越界承担 schema 解析职责。
  readonly arguments: string;
}

// 每轮请求前置的系统约束；不写入可变 history，避免在每轮重复保存。
export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

// 一次 run 开始时记录的用户输入。
export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

// 模型回复；content 为 null 时必须携带工具调用，否则该回复不完整。
export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
}

// 工具调用的回填结果；toolCallId 将它关联到紧邻之前的 assistant 调用。
export interface ToolMessage {
  readonly role: "tool";
  readonly content: string;
  readonly toolCallId: string;
}

// 四类消息的判别联合，供历史验证和供应商转换进行穷尽分支。
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// 所有消息构造器共用的字符串边界校验，明确区分类型错误和不允许的空值。
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

// 创建并冻结工具调用，参数文本只在注册表 prepare 阶段解析和校验。
export function toolCall(id: unknown, name: unknown, argumentsJson: unknown): ToolCall {
  // arguments 保留原始 JSON 文本；解析及 schema 校验属于 ToolRegistry 的职责。
  // 核心循环不解析参数，只把文本原样传给工具注册表。
  return Object.freeze({
    id: requireString(id, "tool call id"),
    name: requireString(name, "tool call name"),
    arguments: requireString(argumentsJson, "tool call arguments", true),
  });
}

// 创建系统消息；允许空内容以保持供应商协议兼容，具体系统提示限制由 AgentRunner 承担。
export function systemMessage(content: string): SystemMessage {
  return Object.freeze({ role: "system", content: requireString(content, "system content", true) });
}

// 创建用户消息；允许空文本以不在消息层改变上层输入策略。
export function userMessage(content: string): UserMessage {
  return Object.freeze({ role: "user", content: requireString(content, "user content", true) });
}

// 创建模型消息并验证同一回复内的调用 ID 唯一，保证结果可以一一回填。
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

// 创建工具结果消息，并强制 toolCallId 非空以保留可审计的调用关联。
export function toolMessage(content: string, toolCallId: string): ToolMessage {
  return Object.freeze({
    role: "tool",
    content: requireString(content, "tool content", true),
    toolCallId: requireString(toolCallId, "tool_call_id"),
  });
}

// 验证完整历史的工具调用/结果配对不变量，在请求供应商前阻止损坏历史外泄。
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
