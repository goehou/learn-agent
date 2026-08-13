// 运行时事件协议：外部异步结果必须先实现 RuntimeEvent 才能进入 EventInbox；
// Agent Loop 批量取出已就绪事件，去重后以普通 user 消息注入历史。
import { userMessage } from "./messages.js";
import type { UserMessage } from "./messages.js";

export interface RuntimeEvent {
  // 事件携带稳定 id 与可选幂等键，供 Loop 去重并将外部结果安全注入下一回合。
  readonly eventId: string;
  readonly contextIdentity?: string;
  readonly idempotencyKey?: string;
  // 把事件序列化为模型可见的纯 JSON 数据；实现方负责稳定字段名。
  toPayload(): Readonly<Record<string, unknown>>;
}

export interface RuntimeEventBatchPosition {
  // 批量注入时记录事件在本批消息中的位置，帮助模型识别这是多条结果中的第几条。
  readonly index: number;
  readonly total: number;
}

// 校验外部对象是否满足 RuntimeEvent 契约；不信任运行时的鸭子类型输入。
export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const eventId = Reflect.get(value, "eventId");
  const toPayload = Reflect.get(value, "toPayload");
  const contextIdentity = Reflect.get(value, "contextIdentity");
  const idempotencyKey = Reflect.get(value, "idempotencyKey");
  return (
    typeof eventId === "string" &&
    eventId.trim().length > 0 &&
    typeof toPayload === "function" &&
    (contextIdentity === undefined ||
      (typeof contextIdentity === "string" && contextIdentity.trim().length > 0)) &&
    (idempotencyKey === undefined ||
      (typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0))
  );
}

export class EventInbox {
  // Inbox 是运行时到 Agent Loop 的单向队列；drain 保持 FIFO，并允许一次移交整批事件所有权。
  readonly #events: RuntimeEvent[] = [];
  readonly #waiters: Array<() => void> = [];

  // 发布一条事件并唤醒等待者；只接受已通过 RuntimeEvent 校验的对象。
  publish(event: RuntimeEvent): void {
    if (!isRuntimeEvent(event)) {
      throw new TypeError("EventInbox only accepts RuntimeEvent values");
    }
    this.#events.push(event);
    for (const resolve of this.#waiters.splice(0)) {
      resolve();
    }
  }

  // 取走当前已就绪的事件；limit 缺省为完整 FIFO 批次。
  drain(limit?: number): readonly RuntimeEvent[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("limit must be a positive integer or undefined");
    }
    const count = limit === undefined ? this.#events.length : Math.min(limit, this.#events.length);
    return Object.freeze(this.#events.splice(0, count));
  }

  // 阻塞等待队列非空后取走一批事件；由 Agent Loop 在等待后台结果时调用。
  async wait(limit?: number): Promise<readonly RuntimeEvent[]> {
    while (this.#events.length === 0) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.drain(limit);
  }
}

// 事件以普通 user 消息进入历史，但不伪装成 tool result，也不携带 tool_call_id。
// batch 只在一次 drain 注入多条事件时使用；未传时按单条事件处理。
export function runtimeEventMessage(
  event: RuntimeEvent,
  batch?: RuntimeEventBatchPosition,
): UserMessage {
  if (!isRuntimeEvent(event)) {
    throw new TypeError("event must be a RuntimeEvent");
  }
  const position = batch === undefined ? { index: 0, total: 1 } : batch;
  if (
    !Number.isInteger(position.index) ||
    position.index < 0 ||
    !Number.isInteger(position.total) ||
    position.total <= 0 ||
    position.index >= position.total
  ) {
    throw new TypeError("batch position must satisfy 0 <= index < total");
  }
  return userMessage(
    JSON.stringify(
      { runtime_event: event.toPayload(), batch: position },
      (_key, value: unknown) => value,
    ),
  );
}
