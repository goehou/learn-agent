// teammate 运行时：以独立 AgentRunner 和身份管理持久队友，并通过 mailbox/EventInbox 与 Lead 协作。
import type { EventInbox, RuntimeEvent } from "../core/events.js";
import { isRuntimeEvent } from "../core/events.js";
import { AgentRunner } from "../core/loop.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import type { JobSupervisor } from "./background.js";
import type { CronRuntime } from "./cron.js";
import {
  canonicalAgentName,
  MailboxMessageKind,
  MailboxStorageError,
  sendMessageInputSchema,
  spawnTeammateInputSchema,
  type MailboxMessage,
  type MailboxStore,
  type SendMessageInput,
  type SpawnTeammateInput,
} from "./mailbox.js";

export const LEAD_NAME = "lead";

export const TeammateStatus = Object.freeze({
  // 状态机只描述当前进程内队友生命周期；failed/shutdown 后不再接收新消息。
  Running: "running",
  Idle: "idle",
  Failed: "failed",
  Shutdown: "shutdown",
});
export type TeammateStatus = (typeof TeammateStatus)[keyof typeof TeammateStatus];

export class TeammateError extends Error {
  // 队友运行时错误统一携带稳定 errorCode，工具边界据此返回结构化失败。
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeammateError";
    this.errorCode = errorCode;
  }
}
export class TeammateExistsError extends TeammateError {
  // 同名队友只允许注册一次，重复 spawn 必须可区分，不能静默覆盖。
  constructor(message: string) {
    super("teammate_exists", message);
    this.name = "TeammateExistsError";
  }
}
export class TeammateNotFoundError extends TeammateError {
  // 发消息到未注册的队友时显式失败，避免把消息写入一个不存在的收件箱。
  constructor(message: string) {
    super("teammate_not_found", message);
    this.name = "TeammateNotFoundError";
  }
}
export class TeammateStateError extends TeammateError {
  // 配置或生命周期状态不合法时立即失败，不等待后台 worker 再暴露问题。
  constructor(message: string) {
    super("teammate_state", message);
    this.name = "TeammateStateError";
  }
}
export class TeammateClosedError extends TeammateError {
  // 关闭后的 runtime 不再接受 spawn/send/start，防止资源释放后继续写 mailbox。
  constructor(message: string) {
    super("teammate_closed", message);
    this.name = "TeammateClosedError";
  }
}

export interface Teammate {
  // 规范 Agent slug，同时作为 mailbox recipient 和 ToolContext.identity。
  readonly name: string;
  // 创建时固定的职责描述，用于构造独立 Runner 提示。
  readonly role: string;
  // 当前进程内 worker 状态快照。
  readonly status: TeammateStatus;
}

// 工厂为每名队友创建独立历史的 AgentRunner，并只暴露受控 send_message 工具。
export type TeammateRunnerFactory = (
  name: string,
  role: string,
  sendToolDefinition: ToolDefinition<SendMessageInput>,
) => AgentRunner;

// Worker 保存队友的可观察快照和后台运行句柄；task/abort/currentMessage 只在单次 worker 循环期间存在。
interface Worker {
  // 对外可观察的不可变队友快照；状态变化时整体替换。
  teammate: Teammate;
  // 该队友独占的 AgentRunner 和 canonical history。
  readonly runner: AgentRunner;
  // supervisor 下的受管任务；undefined 表示当前没有在途循环，可以安全重启。
  task: Promise<void> | undefined;
  // 当前 processing 租约；close 或取消时必须 release 回 ready，不能静默丢弃。
  currentMessage: MailboxMessage | undefined;
  // 当前 worker 循环的取消控制器。
  abort: AbortController | undefined;
  // runner 与消息租约均成功清理后才为 true，支持 close 重试。
  closeComplete: boolean;
  // release 失败暂存到 close 边界统一报告。
  cleanupFailure: unknown | undefined;
}

export class TeammateRuntime {
  // 每名队友拥有独立 AgentRunner 和身份；共享资源仅限 mailbox、事件 Inbox 与调度器。
  readonly #store: MailboxStore;
  readonly #inbox: EventInbox;
  readonly #supervisor: JobSupervisor;
  readonly #cronRuntime: CronRuntime;
  readonly #leadName: string;
  // 当前进程已创建的队友注册表，不从磁盘自动重建 AgentRunner。
  readonly #workers = new Map<string, Worker>();
  // 已发布到共享 Inbox、尚未被 drain 的 lead 消息 id。
  readonly #queuedMessageIds = new Set<string>();
  readonly #spawnToolDefinition: ToolDefinition<SpawnTeammateInput>;
  readonly #sendToolDefinition: ToolDefinition<SendMessageInput>;
  // 工厂必须在 start 前恰好配置一次，避免不同队友使用漂移的组装规则。
  #runnerFactory: TeammateRunnerFactory | undefined;
  // Lead mailbox 新消息到达时请求 Runner.runEvents 的回调。
  #wakeup: (() => Promise<void>) | undefined;
  // 串行化 spawn/send 对 worker 注册表的读改写。
  #registryTail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  // 校验 mailbox、Cron、Supervisor 和 Inbox 的共享关系；构造器不启动 worker。
  constructor(options: {
    readonly store: MailboxStore;
    readonly inbox: EventInbox;
    readonly supervisor: JobSupervisor;
    readonly cronRuntime: CronRuntime;
    readonly leadName?: string;
  }) {
    if (
      options.store === undefined ||
      typeof options.store.send !== "function" ||
      typeof options.store.claim !== "function" ||
      typeof options.store.ack !== "function"
    ) {
      throw new TypeError("store must implement MailboxStore");
    }
    if (options.cronRuntime.supervisor !== options.supervisor) {
      throw new Error("cronRuntime must share the JobSupervisor");
    }
    if (options.cronRuntime.eventInbox !== options.inbox) {
      throw new Error("cronRuntime must share the EventInbox");
    }
    this.#store = options.store;
    this.#inbox = options.inbox;
    this.#supervisor = options.supervisor;
    this.#cronRuntime = options.cronRuntime;
    this.#leadName = canonicalAgentName(options.leadName ?? LEAD_NAME);
    this.#spawnToolDefinition = {
      name: "spawn_teammate",
      description: "Start a persistent teammate with an isolated history and focused role.",
      inputSchema: spawnTeammateInputSchema,
      effect: "external",
      handler: async (input, context) => await this.#spawnTool(input, context),
    };
    this.#sendToolDefinition = {
      name: "send_message",
      description: "Send a persistent message to the lead or an existing teammate.",
      inputSchema: sendMessageInputSchema,
      effect: "external",
      handler: async (input, context) => await this.#sendTool(input, context),
    };
  }

  // 暴露共享 Supervisor 供组合根验证资源所有权。
  get supervisor(): JobSupervisor {
    return this.#supervisor;
  }
  // 暴露共享 Inbox 供组合根验证事件路径唯一。
  get eventInbox(): EventInbox {
    return this.#inbox;
  }
  // 暴露被包装的 CronRuntime，事件泵方法在其上组合 mailbox ack。
  get cronRuntime(): CronRuntime {
    return this.#cronRuntime;
  }
  // 暴露 MailboxStore 供组合一致性测试和受控查询。
  get mailboxStore(): MailboxStore {
    return this.#store;
  }
  // pending 状态沿用共享 Cron/Supervisor 的受管任务状态。
  get hasPendingWork(): boolean {
    return this.#cronRuntime.hasPendingWork;
  }
  // 主 Agent 注册 spawn 与 send 两个工具的稳定顺序快照。
  get toolDefinitions(): readonly (
    | ToolDefinition<SpawnTeammateInput>
    | ToolDefinition<SendMessageInput>
  )[] {
    return Object.freeze([this.#spawnToolDefinition, this.#sendToolDefinition]);
  }
  get spawnToolDefinition(): ToolDefinition<SpawnTeammateInput> {
    return this.#spawnToolDefinition;
  }
  get sendToolDefinition(): ToolDefinition<SendMessageInput> {
    return this.#sendToolDefinition;
  }

  // 在 start 前一次性注入 Runner 工厂，防止运行中更换隔离与权限规则。
  configureRunnerFactory(factory: TeammateRunnerFactory): void {
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    if (this.#runnerFactory !== undefined || this.#started) {
      throw new TeammateStateError("Teammate runner factory must be configured once before start");
    }
    this.#runnerFactory = factory;
  }

  // 绑定 Lead 消息唤醒回调；实际并发互斥由 AgentRunner 负责。
  bindWakeup(wakeup: () => Promise<void>): void {
    if (typeof wakeup !== "function") throw new TypeError("wakeup must be a function");
    this.#wakeup = wakeup;
  }

  // 恢复 Lead 半开消息并发布待处理事件；重复启动幂等。
  async start(): Promise<void> {
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (this.#runnerFactory === undefined) {
      throw new TeammateStateError("Teammate runner factory is not configured");
    }
    if (this.#started) return;
    // 启动 Lead 前先恢复旧 processing 消息，再发布到 EventInbox，避免崩溃消息停留在租约中。
    await this.#store.recoverProcessing(this.#leadName);
    await this.#publishLeadMessages();
    this.#started = true;
  }

  // 作为 RuntimeEventPump 的恢复屏障，确保 mailbox 已可消费。
  async ready(): Promise<void> {
    await this.start();
  }

  // 返回指定队友当前不可变状态快照。
  state(name: string): Teammate {
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    return worker.teammate;
  }

  // 原子注册队友、恢复其邮箱、发送首个 task，并启动受管 worker。
  async spawn(input: SpawnTeammateInput & { readonly sender: string }): Promise<Teammate> {
    // 注册与恢复 mailbox 后才启动 worker，防止队友在收件箱未就绪时丢失首条消息。
    this.#ensureAvailable();
    const name = canonicalAgentName(input.name);
    const sender = canonicalAgentName(input.sender);
    const role = requireText(input.role, "Teammate role");
    const prompt = requireText(input.prompt, "Teammate prompt");
    if (name === this.#leadName)
      throw new Error(`Teammate name ${this.#leadName} is reserved for the lead`);
    return await this.#withRegistry(async () => {
      this.#ensureAvailable();
      if (this.#workers.has(name))
        throw new TeammateExistsError(`Teammate already exists: ${name}`);
      const factory = this.#runnerFactory;
      if (factory === undefined)
        throw new TeammateStateError("Teammate runner factory is not configured");
      const runner = factory(name, role, this.#sendToolDefinition);
      if (!(runner instanceof AgentRunner)) {
        throw new TypeError("Teammate runner factory must return AgentRunner");
      }
      const worker: Worker = {
        teammate: snapshot(name, role, TeammateStatus.Running),
        runner,
        task: undefined,
        currentMessage: undefined,
        abort: undefined,
        closeComplete: false,
        cleanupFailure: undefined,
      };
      this.#workers.set(name, worker);
      try {
        // 先恢复队友遗留的 processing 消息，再发送首个 task，保证旧消息不会和新消息竞争丢失。
        await this.#store.recoverProcessing(name);
        await this.#store.send(sender, name, prompt, MailboxMessageKind.Task);
        this.#startWorker(worker);
        return worker.teammate;
      } catch (error) {
        this.#workers.delete(name);
        await runner.close();
        throw error;
      }
    });
  }

  // 向 Lead 或可接收消息的队友持久发送消息，必要时唤醒 Idle worker。
  async send(input: SendMessageInput & { readonly sender: string }): Promise<MailboxMessage> {
    this.#ensureAvailable();
    const sender = canonicalAgentName(input.sender);
    const to = canonicalAgentName(input.to);
    const content = requireText(input.content, "Mailbox message content");
    if (sender === to) throw new Error("Mailbox sender and recipient must differ");
    const message = await this.#withRegistry(async () => {
      this.#ensureAvailable();
      const worker = to === this.#leadName ? undefined : this.#workers.get(to);
      if (to !== this.#leadName && worker === undefined) {
        throw new TeammateNotFoundError(`Unknown teammate: ${to}`);
      }
      if (
        worker !== undefined &&
        (worker.teammate.status === TeammateStatus.Failed ||
          worker.teammate.status === TeammateStatus.Shutdown)
      ) {
        throw new TeammateStateError(
          `Teammate ${to} cannot receive messages while ${worker.teammate.status}`,
        );
      }
      const sent = await this.#store.send(sender, to, content, MailboxMessageKind.Message);
      if (worker !== undefined && worker.teammate.status === TeammateStatus.Idle) {
        // idle 只表示 worker 已结束本轮循环；收到新消息时复用原 Runner 并重新拉取 mailbox。
        this.#setStatus(worker, TeammateStatus.Running);
        this.#startWorker(worker);
      }
      return sent;
    });
    if (to === this.#leadName) await this.#notifyLead();
    return message;
  }

  // 从共享事件泵取走事件，并同步清除 mailbox 的“已入队”登记。
  drainEvents(limit?: number): readonly RuntimeEvent[] {
    const events = this.#cronRuntime.drainEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  // 阻塞等待共享事件，并同步清除 mailbox 的“已入队”登记。
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    const events = await this.#cronRuntime.waitForEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  // 组合 Cron 与 mailbox 的确认协议；mailbox ack 失败会重新发布同一事件。
  async acknowledgeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
    // 先确认 Cron 侧事件，再逐个确认 mailbox；mailbox ack 失败时重新发布，等待 Runner 按 event_id 补 ack。
    await this.#cronRuntime.acknowledgeEvents(events);
    for (const event of events) {
      if (!isMailboxMessage(event)) continue;
      try {
        if (!(await this.#store.ack(event))) {
          throw new MailboxStorageError(`Mailbox message is not processing: ${event.id}`);
        }
      } catch (error) {
        // 确认失败时把同一事件重新发布，Runner 会按 event_id 去重，避免已写入 history 的消息丢失。
        if (!this.#queuedMessageIds.has(event.id)) {
          this.#inbox.publish(event);
          this.#queuedMessageIds.add(event.id);
        }
        throw error;
      }
      this.#queuedMessageIds.delete(event.id);
    }
  }

  async close(): Promise<void> {
    // 关闭按 worker 收束、资源释放顺序执行，确保未确认消息不会被静默丢弃。
    if (this.#closed && [...this.#workers.values()].every((worker) => worker.closeComplete)) return;
    this.#closed = true;
    for (const worker of this.#workers.values()) worker.abort?.abort();
    const tasks = [...this.#workers.values()]
      .map((worker) => worker.task)
      .filter((task): task is Promise<void> => task !== undefined);
    const failures: unknown[] = [];
    for (const outcome of await Promise.allSettled(tasks)) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
    }
    for (const worker of this.#workers.values()) {
      if (worker.closeComplete) continue;
      let workerClosed = true;
      if (worker.cleanupFailure !== undefined) {
        workerClosed = false;
        failures.push(worker.cleanupFailure);
        worker.cleanupFailure = undefined;
      } else if (worker.currentMessage !== undefined) {
        try {
          await this.#store.release(worker.currentMessage);
          worker.currentMessage = undefined;
        } catch (error) {
          workerClosed = false;
          failures.push(error);
        }
      }
      try {
        await worker.runner.close();
      } catch (error) {
        workerClosed = false;
        failures.push(error);
      }
      worker.task = undefined;
      worker.abort = undefined;
      this.#setStatus(worker, TeammateStatus.Shutdown);
      worker.closeComplete = workerClosed;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "TeammateRuntime close failed");
  }

  async #spawnTool(input: SpawnTeammateInput, context: ToolContext): Promise<ToolResult> {
    try {
      const teammate = await this.spawn({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(teammate));
    } catch (error) {
      // 工具边界只返回可观察的错误，不向 Agent 暴露内部栈。
      return toolError(errorCode(error, "teammate_spawn_error"), errorMessage(error));
    }
  }
  async #sendTool(input: SendMessageInput, context: ToolContext): Promise<ToolResult> {
    try {
      const message = await this.send({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(message.toPayload()));
    } catch (error) {
      // sender 由 ToolContext.identity 注入，工具输入不能伪造消息来源。
      return toolError(errorCode(error, "mailbox_send_error"), errorMessage(error));
    }
  }

  #startWorker(worker: Worker): void {
    // 每个 worker 都作为 supervisor 下的受管任务运行，supervisor 负责统一追踪和关闭。
    // 只有在途任务结束时才可重启；Idle 队友收到新消息会复用原 Runner 回到这里。
    if (worker.task !== undefined) return;
    const abort = new AbortController();
    worker.abort = abort;
    const task = this.#supervisor.startManaged(async (signal) => {
      signal.addEventListener("abort", () => abort.abort(), { once: true });
      await this.#runWorker(worker, abort.signal);
    });
    worker.task = task;
    void task.then(
      () => {
        if (worker.task === task) {
          worker.task = undefined;
          if (!this.#closed && worker.teammate.status === TeammateStatus.Running) {
            this.#startWorker(worker);
          }
        }
        if (worker.abort === abort) worker.abort = undefined;
      },
      () => {
        if (worker.task === task) worker.task = undefined;
        if (worker.abort === abort) worker.abort = undefined;
      },
    );
  }

  async #runWorker(worker: Worker, signal: AbortSignal): Promise<void> {
    // worker 循环把消息处理拆成三态：无消息转 idle；成功回 result 后 ack；失败 quarantine 并向 Lead 暴露错误。
    try {
      while (!this.#closed) {
        // claim 即获取租约：成功后当前消息进入 processing，直到 ack/release/quarantine。
        const message = await this.#store.claim(worker.teammate.name);
        if (message === undefined) {
          this.#setStatus(worker, TeammateStatus.Idle);
          return;
        }
        worker.currentMessage = message;
        this.#setStatus(worker, TeammateStatus.Running);
        try {
          // 同一消息 UUID 作为本轮 idempotency key，外部工具可以据此去重。
          const result = await worker.runner.run(message.content, {
            idempotencyKey: message.id,
            signal,
          });
          await this.#store.send(
            worker.teammate.name,
            this.#leadName,
            result.finalText,
            MailboxMessageKind.Result,
          );
          if (!(await this.#store.ack(message))) {
            throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
          }
          worker.currentMessage = undefined;
        } catch (error) {
          if (this.#closed || signal.aborted) {
            // 关闭或取消时不 quarantine，而是 release 回 ready，保留崩溃后重放的机会。
            try {
              if (!(await this.#store.release(message))) {
                throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
              }
              worker.currentMessage = undefined;
            } catch (releaseError) {
              if (this.#closed) {
                worker.cleanupFailure = releaseError;
                return;
              }
              throw releaseError;
            }
            return;
          }
          // 业务失败把输入隔离到 quarantine，并向 Lead 发布可观察的失败 result。
          if (!(await this.#store.quarantine(message))) {
            throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
          }
          worker.currentMessage = undefined;
          throw error;
        }
        this.#setStatus(worker, TeammateStatus.Idle);
        await this.#notifyLead();
      }
      this.#setStatus(worker, TeammateStatus.Shutdown);
    } catch (error) {
      if (this.#closed) {
        this.#setStatus(worker, TeammateStatus.Shutdown);
        return;
      }
      this.#setStatus(worker, TeammateStatus.Failed);
      try {
        await this.#store.send(
          worker.teammate.name,
          this.#leadName,
          `Teammate ${worker.teammate.name} failed: ${errorMessage(error)}`,
          MailboxMessageKind.Result,
        );
        await this.#notifyLead();
      } catch {
        // 错误结果无法再持久化时，状态仍保留为 failed 供调用方观察。
      }
    }
  }

  // 发布 Lead 当前所有 ready 消息，并在新增事件时请求运行独立事件回合。
  async #notifyLead(): Promise<void> {
    const published = await this.#publishLeadMessages();
    if (published && this.#wakeup !== undefined) await this.#wakeup();
  }
  async #publishLeadMessages(): Promise<boolean> {
    // 发布阶段持续 claim 直到 lead mailbox 为空；每次 claim 都会把消息置于 processing。
    let published = false;
    while (true) {
      const message = await this.#store.claim(this.#leadName);
      if (message === undefined) return published;
      if (this.#queuedMessageIds.has(message.id)) {
        throw new MailboxStorageError(`Mailbox message was queued twice: ${message.id}`);
      }
      this.#inbox.publish(message);
      this.#queuedMessageIds.add(message.id);
      published = true;
    }
  }
  // drain 后允许 ack 失败的同一消息重新发布到 Inbox。
  #markMailboxEventsDequeued(events: readonly RuntimeEvent[]): void {
    for (const event of events)
      if (isMailboxMessage(event)) this.#queuedMessageIds.delete(event.id);
  }
  // 状态变化通过替换冻结快照完成，外部引用不会被就地修改。
  #setStatus(worker: Worker, status: TeammateStatus): void {
    worker.teammate = snapshot(worker.teammate.name, worker.teammate.role, status);
  }
  // spawn/send 只能在已启动且未关闭的 runtime 中执行。
  #ensureAvailable(): void {
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (!this.#started) throw new TeammateStateError("TeammateRuntime is not started");
  }
  async #withRegistry<T>(operation: () => Promise<T>): Promise<T> {
    // 进程内 promise 队列串行化注册和发送，避免并发 spawn/send 造成队友集合不一致。
    const previous = this.#registryTail;
    let release!: () => void;
    this.#registryTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// 创建不可变的队友可观察状态。
function snapshot(name: string, role: string, status: TeammateStatus): Teammate {
  return Object.freeze({ name, role, status });
}
// 校验并裁剪角色、初始任务和消息正文。
function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must not be empty`);
  return value.trim();
}
// 在共享事件队列中识别 mailbox 消息，避免对 Cron/后台事件执行邮箱 ack。
function isMailboxMessage(value: RuntimeEvent): value is MailboxMessage {
  return value.toPayload().kind === "mailbox" && "id" in value;
}
function errorCode(error: unknown, fallback: string): string {
  // 领域错误保留 errorCode，其他异常统一使用工具边界 fallback，避免泄露内部异常类型。
  return error instanceof TeammateError || error instanceof MailboxStorageError
    ? error.errorCode
    : fallback;
}
function errorMessage(error: unknown): string {
  // 错误转字符串时只取稳定 message，不把完整堆栈写入工具结果。
  return error instanceof Error ? error.message : String(error);
}
