// mailbox 领域模型：定义持久消息、状态目录与 Store 协议，供 teammate 运行时和文件适配器共用。
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { RuntimeEvent } from "../core/events.js";
import { isWindowsReservedComponent } from "../core/filesystem.js";

export const MailboxMessageKind = Object.freeze({
  // 消息类型决定消费者如何解释 content，但不能改变 mailbox 的持久化协议。
  Task: "task",
  Message: "message",
  Result: "result",
});
export type MailboxMessageKind = (typeof MailboxMessageKind)[keyof typeof MailboxMessageKind];

export const MailboxState = Object.freeze({
  // 每个目录名对应一个持久状态；同一条消息只允许在 ready/processing/done/quarantine 之一。
  Ready: "ready",
  Processing: "processing",
  Done: "done",
  Quarantine: "quarantine",
});
export type MailboxState = (typeof MailboxState)[keyof typeof MailboxState];

export class MailboxError extends Error {
  // 协议或持久化错误携带稳定 errorCode，工具边界可把它转成结构化 ToolResult。
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailboxError";
    this.errorCode = errorCode;
  }
}

export class MailboxStorageError extends MailboxError {
  // 文件损坏、锁失败和状态迁移冲突统一映射到同一错误族，调用方无需猜测底层异常。
  constructor(message: string, options?: ErrorOptions) {
    super("mailbox_storage_error", message, options);
    this.name = "MailboxStorageError";
  }
}

export interface MailboxMessage extends RuntimeEvent {
  // 邮箱消息以稳定 id、发送者和接收者建模，持久层据此保证投递与确认可追踪。
  readonly id: string;
  // 发送方和接收方均为可安全用作目录名的规范 Agent slug。
  readonly sender: string;
  readonly recipient: string;
  // task/message/result 只影响消费者语义，不改变投递状态机。
  readonly kind: MailboxMessageKind;
  // 交给目标 Agent 的原始文本负载。
  readonly content: string;
  // 决定同一收件箱内稳定 FIFO 次序的 UTC 时间。
  readonly createdAtUtc: Date;
  // RuntimeEvent 的去重 id 与消息主键一致。
  readonly eventId: string;
  // 工具副作用幂等键与消息 UUID 一致，重试不会生成新身份。
  readonly idempotencyKey: string;
}

export interface MailboxStore {
  // Store 暴露发送、认领和确认的协议操作，具体文件持久化留在适配器。
  send(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): Promise<MailboxMessage>;
  // 原子认领最早 ready 消息并迁移为 processing；空邮箱返回 undefined。
  claim(recipient: string): Promise<MailboxMessage | undefined>;
  // processing -> done；相同完成记录允许幂等确认。
  ack(message: MailboxMessage): Promise<boolean>;
  // processing -> ready，用于取消、关闭或可重试失败。
  release(message: MailboxMessage): Promise<boolean>;
  // processing -> quarantine，用于不可自动重试的业务失败。
  quarantine(message: MailboxMessage): Promise<boolean>;
  // 进程恢复时把遗留 processing 租约退回 ready，并返回恢复数量。
  recoverProcessing(recipient: string): Promise<number>;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const spawnTeammateInputSchema = z
  .object({
    name: z.string(),
    role: z.string(),
    prompt: z.string(),
  })
  .strict();
// spawn_teammate 的严格工具输入，不允许模型指定 sender 或运行时身份。
export type SpawnTeammateInput = z.infer<typeof spawnTeammateInputSchema>;

export const sendMessageInputSchema = z
  .object({
    to: z.string(),
    content: z.string(),
  })
  .strict();
// send_message 的严格工具输入；sender 始终来自 ToolContext.identity。
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export function canonicalAgentName(value: string): string {
  // Agent 名会被用作文件目录名，因此同时校验 slug 规则和 Windows 保留组件。
  if (typeof value !== "string" || !AGENT_NAME.test(value) || isWindowsReservedComponent(value)) {
    throw new Error("Invalid or unsafe Agent name; expected a safe lowercase slug");
  }
  return value;
}

export function canonicalMailboxMessageId(value: string): string {
  // UUID 既是消息主键也是事件 idempotency key，必须使用规范格式。
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new Error("Mailbox message id must be a canonical UUID");
  }
  return value;
}

export function createMailboxMessage(input: {
  id: string;
  sender: string;
  recipient: string;
  kind: MailboxMessageKind;
  content: string;
  createdAtUtc: Date;
}): MailboxMessage {
  // 构造边界统一校验 id、sender、recipient、kind、content 和时钟，返回不可变消息。
  const id = canonicalMailboxMessageId(input.id);
  const sender = canonicalAgentName(input.sender);
  const recipient = canonicalAgentName(input.recipient);
  if (!Object.values(MailboxMessageKind).includes(input.kind)) {
    throw new TypeError("Mailbox message kind must be task, message, or result");
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new Error("Mailbox message content must not be empty");
  }
  if (!(input.createdAtUtc instanceof Date) || !Number.isFinite(input.createdAtUtc.valueOf())) {
    throw new Error("Mailbox clock value must be a valid UTC Date");
  }
  const createdAtUtc = new Date(input.createdAtUtc.valueOf());
  return Object.freeze({
    id,
    sender,
    recipient,
    kind: input.kind,
    content: input.content,
    createdAtUtc,
    eventId: id,
    idempotencyKey: id,
    toPayload: mailboxPayload,
  });
}

export function mailboxMessageFromJson(value: unknown): MailboxMessage {
  // 磁盘 JSON 是外部输入，必须拒绝未知字段和非法值，避免坏消息污染运行态。
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MailboxStorageError("Mailbox message payload is invalid");
  }
  const record = value as Record<string, unknown>;
  const expected = ["content", "created_at_utc", "id", "kind", "recipient", "sender"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new MailboxStorageError("Mailbox message payload contains unsupported fields");
  }
  if (
    typeof record.id !== "string" ||
    typeof record.sender !== "string" ||
    typeof record.recipient !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.content !== "string" ||
    typeof record.created_at_utc !== "string"
  ) {
    throw new MailboxStorageError("Mailbox message payload is invalid");
  }
  if (!Object.values(MailboxMessageKind).includes(record.kind as MailboxMessageKind)) {
    throw new MailboxStorageError("Mailbox message kind is invalid");
  }
  const createdAtUtc = new Date(record.created_at_utc);
  if (
    !record.created_at_utc.endsWith("Z") ||
    !Number.isFinite(createdAtUtc.valueOf()) ||
    createdAtUtc.toISOString() !== record.created_at_utc
  ) {
    throw new MailboxStorageError("Mailbox message timestamp is invalid");
  }
  try {
    return createMailboxMessage({
      id: record.id,
      sender: record.sender,
      recipient: record.recipient,
      kind: record.kind as MailboxMessageKind,
      content: record.content,
      createdAtUtc,
    });
  } catch (error) {
    throw new MailboxStorageError("Mailbox message fields failed validation", { cause: error });
  }
}

export function mailboxMessageToJson(message: MailboxMessage): Readonly<Record<string, string>> {
  // 持久化使用 snake_case 的稳定字段名，内存对象保持 camelCase，转换只在边界发生。
  return Object.freeze({
    id: message.id,
    sender: message.sender,
    recipient: message.recipient,
    kind: message.kind,
    content: message.content,
    created_at_utc: message.createdAtUtc.toISOString(),
  });
}

export function equalMailboxMessages(left: MailboxMessage, right: MailboxMessage): boolean {
  // 幂等 ack 需要按完整消息内容比较，不能只比较 id，否则可能确认了错误的负载。
  return (
    left.id === right.id &&
    left.sender === right.sender &&
    left.recipient === right.recipient &&
    left.kind === right.kind &&
    left.content === right.content &&
    left.createdAtUtc.valueOf() === right.createdAtUtc.valueOf()
  );
}

export function randomMailboxMessageId(): string {
  // 默认 id 生成器只在生产构造时使用；测试可注入确定 UUID。
  return randomUUID();
}

function mailboxPayload(this: MailboxMessage): Readonly<Record<string, unknown>> {
  // RuntimeEvent 的 payload 暴露结构化字段，避免调用方通过字符串前缀判断消息类型。
  return Object.freeze({
    kind: "mailbox",
    message_id: this.id,
    sender: this.sender,
    recipient: this.recipient,
    message_kind: this.kind,
    content: this.content,
    created_at_utc: this.createdAtUtc.toISOString(),
  });
}
