// teammate 运行时：以独立 AgentRunner 和身份管理持久队友，并通过 mailbox/EventInbox 与 Lead 协作；P16 增加协议消息路由与优雅关闭。
import type { EventInbox, RuntimeEvent } from "../core/events.js";
import { isRuntimeEvent } from "../core/events.js";
import { AgentRunner } from "../core/loop.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import type { JobSupervisor } from "./background.js";
import type { CronRuntime } from "./cron.js";
import {
  canonicalAgentName,
  isProtocolMailboxMessage,
  isProtocolMailboxStore,
  MailboxMessageKind,
  MailboxStorageError,
  ProtocolMessageKind,
  sendMessageInputSchema,
  spawnTeammateInputSchema,
  type MailboxMessage,
  type MailboxItem,
  type MailboxStore,
  type ProtocolMailboxMessage,
  type SendMessageInput,
  type SpawnTeammateInput,
} from "./mailbox.js";
import type { ProtocolRuntime } from "./protocol.js";

export const LEAD_NAME = "lead";

export const TeammateStatus = Object.freeze({
  // 状态机只描述当前进程内队友生命周期；failed/shutdown 后不再接收新消息。
  Running: "running",
  Idle: "idle",
  Failed: "failed",
  Shutdown: "shutdown",
});
export type TeammateStatus = (typeof TeammateStatus)[keyof typeof TeammateStatus];

// 队友运行时错误统一携带稳定 errorCode，工具边界据此返回结构化失败。
export class TeammateError extends Error {
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
  // 当前进程内 worker 状态快照；状态变化时整体替换。
  readonly status: TeammateStatus;
}

// 工厂为每名队友创建独立历史的 AgentRunner，并注入受控消息与协议工具。
export type TeammateRunnerFactory = (
  name: string,
  role: string,
  sendToolDefinition: ToolDefinition<SendMessageInput>,
) => AgentRunner;

interface Worker {
  // 对外可观察的不可变队友快照。
  teammate: Teammate;
  // 该队友独占的 AgentRunner 和 canonical history。
  readonly runner: AgentRunner;
  // supervisor 下的受管任务；undefined 表示当前没有在途循环。
  task: Promise<void> | undefined;
  // 当前 processing 租约；关闭或取消时必须 release 回 ready。
  currentMessage: MailboxItem | undefined;
  // 当前 worker 循环的取消控制器，与 supervisor signal 衔接。
  abort: AbortController | undefined;
  // 消息租约和 Runner 都成功清理后才为 true，支持 close 重试。
  closeComplete: boolean;
  // 取消阶段无法 release 消息时暂存，交给 close 汇总报告。
  cleanupFailure: unknown | undefined;
}

// 每名队友拥有独立 AgentRunner 和身份；共享资源仅限 mailbox、事件 Inbox 与调度器。
export class TeammateRuntime {
  // 普通与协议消息共享的持久 MailboxStore。
  readonly #store: MailboxStore;
  // Lead 事件发布目标，与 CronRuntime 使用同一个实例。
  readonly #inbox: EventInbox;
  // 所有队友 worker 都作为该 supervisor 的受管任务运行。
  readonly #supervisor: JobSupervisor;
  // 统一实现事件 drain/wait/ack 和 wakeup 排序。
  readonly #cronRuntime: CronRuntime;
  // 规范化 Lead 名称，默认固定为 lead。
  readonly #leadName: string;
  // 仅保存当前进程已创建的队友及其独立 Runner。
  readonly #workers = new Map<string, Worker>();
  // 记录已发布到 EventInbox 的 mailbox 事件，避免确认失败重投时重复排队。
  readonly #queuedMessageIds = new Set<string>();
  // Lead 暴露给模型的创建队友工具定义。
  readonly #spawnToolDefinition: ToolDefinition<SpawnTeammateInput>;
  // Lead 与队友共享的普通消息工具定义。
  readonly #sendToolDefinition: ToolDefinition<SendMessageInput>;
  // 协议运行时与队友共享同一 store，负责 Lead 侧消息校验与 ack 状态消费。
  #protocolRuntime: ProtocolRuntime | undefined;
  // start 前注入，为每名队友创建带独立历史的 Runner。
  #runnerFactory: TeammateRunnerFactory | undefined;
  // 发布 Lead 新事件后触发组合根安排事件回合。
  #wakeup: (() => Promise<void>) | undefined;
  // 串行化队友注册、普通发送和协议投递。
  #registryTail: Promise<void> = Promise.resolve();
  // start 完成后才允许 spawn/send/deliverProtocol。
  #started = false;
  // close 一开始即封闭新操作，清理失败可再次 close 重试。
  #closed = false;

  constructor(options: {
    readonly store: MailboxStore;
    readonly inbox: EventInbox;
    readonly supervisor: JobSupervisor;
    readonly cronRuntime: CronRuntime;
    readonly leadName?: string;
  }) {
    // 组合根必须把 supervisor、Cron 与 EventInbox 注入到同一个运行时，否则事件流会分裂。
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

  get supervisor(): JobSupervisor {
    // 组合根复用同一 supervisor，使后台作业与队友 worker 共享关闭顺序。
    return this.#supervisor;
  }
  get eventInbox(): EventInbox {
    // 队友结果与 Cron 事件进入同一事件泵，避免平行历史写入路径。
    return this.#inbox;
  }
  get cronRuntime(): CronRuntime {
    // drain/wait/ack 委托给共享 CronRuntime，保留统一事件排序。
    return this.#cronRuntime;
  }
  get mailboxStore(): MailboxStore {
    // 协议与普通消息必须共用该 Store，保持单一租约状态机。
    return this.#store;
  }
  get hasPendingWork(): boolean {
    // CronRuntime 汇总 EventInbox 与调度状态，是事件泵的单一待办判断。
    return this.#cronRuntime.hasPendingWork;
  }
  get toolDefinitions(): readonly (
    | ToolDefinition<SpawnTeammateInput>
    | ToolDefinition<SendMessageInput>
  )[] {
    // 保持工具顺序稳定；P16 协议工具由组合根按身份分别追加。
    return Object.freeze([this.#spawnToolDefinition, this.#sendToolDefinition]);
  }
  get spawnToolDefinition(): ToolDefinition<SpawnTeammateInput> {
    // 组合根按能力位注册，不暴露内部可变定义。
    return this.#spawnToolDefinition;
  }
  get sendToolDefinition(): ToolDefinition<SendMessageInput> {
    // sender 始终由 ToolContext 注入，工具输入不能伪造来源。
    return this.#sendToolDefinition;
  }

  configureRunnerFactory(factory: TeammateRunnerFactory): void {
    // 工厂只能启动前绑定一次，防止既有和新建队友使用不同契约。
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    if (this.#runnerFactory !== undefined || this.#started) {
      throw new TeammateStateError("Teammate runner factory must be configured once before start");
    }
    this.#runnerFactory = factory;
  }

  configureProtocol(runtime: ProtocolRuntime): void {
    // 协议 runtime 必须与队友共享同一 MailboxStore，并且只能在启动前配置一次。
    if (runtime.teamRuntime !== this || runtime.mailboxStore !== this.#store) {
      throw new TeammateStateError("Protocol runtime must share this teammate runtime and mailbox");
    }
    if (this.#protocolRuntime !== undefined || this.#started) {
      throw new TeammateStateError("Protocol runtime must be configured once before start");
    }
    this.#protocolRuntime = runtime;
  }

  bindWakeup(wakeup: () => Promise<void>): void {
    // wakeup 由组合根绑定，用于有新 Lead 事件时启动独立事件回合。
    if (typeof wakeup !== "function") throw new TypeError("wakeup must be a function");
    this.#wakeup = wakeup;
  }

  async start(): Promise<void> {
    // 启动 Lead 前先恢复旧 processing 消息，再发布到 EventInbox，避免崩溃消息停留在租约中。
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (this.#runnerFactory === undefined) {
      throw new TeammateStateError("Teammate runner factory is not configured");
    }
    if (this.#started) return;
    await this.#store.recoverProcessing(this.#leadName);
    await this.#publishLeadMessages();
    this.#started = true;
  }

  async ready(): Promise<void> {
    // AgentRunner 拉取事件前调用，确保 Lead ready 消息已发布。
    await this.start();
  }

  state(name: string): Teammate {
    // 状态查询只读 Map，不启动 worker，也不产生 mailbox 副作用。
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    return worker.teammate;
  }

  beginShutdown(name: string): void {
    // shutdown 状态先于响应投递设置，让后续协议投递无法再发给该队友。
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    this.#setStatus(worker, TeammateStatus.Shutdown);
  }

  async spawn(input: SpawnTeammateInput & { readonly sender: string }): Promise<Teammate> {
    // 先恢复队友遗留的 processing 消息，再发送首个 task，保证旧消息不会和新消息竞争丢失。
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

  // 协议投递共享注册表串行化，只发给已注册且状态可接收的队友或 Lead。
  async deliverProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: {
      readonly requestId: string;
      readonly approved: boolean | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<ProtocolMailboxMessage> {
    // abort 在持久化前后各检查一次，取消后不得继续唤醒参与者。
    this.#ensureAvailable();
    if (!isProtocolMailboxStore(this.#store)) {
      throw new TeammateStateError("Mailbox store does not support protocol messages");
    }
    const protocolStore = this.#store;
    if (options.signal?.aborted)
      throw new DOMException("Protocol delivery was aborted", "AbortError");
    const from = canonicalAgentName(sender);
    const to = canonicalAgentName(recipient);
    if (from === to) throw new Error("Protocol sender and recipient must differ");
    const message = await this.#withRegistry(async () => {
      this.#ensureAvailable();
      if (options.signal?.aborted)
        throw new DOMException("Protocol delivery was aborted", "AbortError");
      this.#assertParticipant(from, kind === ProtocolMessageKind.ShutdownResponse);
      this.#assertParticipant(to);
      const sent = await protocolStore.sendProtocol(
        from,
        to,
        requireText(content, "Protocol content"),
        kind,
        options,
      );
      if (options.signal?.aborted)
        throw new DOMException("Protocol delivery was aborted", "AbortError");
      const worker = to === this.#leadName ? undefined : this.#workers.get(to);
      if (worker !== undefined && worker.teammate.status === TeammateStatus.Idle) {
        this.#setStatus(worker, TeammateStatus.Running);
        this.#startWorker(worker);
      }
      return sent;
    });
    if (to === this.#leadName) await this.#notifyLead();
    return message;
  }

  drainEvents(limit?: number): readonly RuntimeEvent[] {
    // 事件出队即清除 queued 标记，确保 ack 失败后重新发布仍能被 Runner 识别为重试。
    const events = this.#cronRuntime.drainEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    // 等待路径与 drain 路径共用同一去重逻辑，不能让等待中的事件永久占据 queued 标记。
    const events = await this.#cronRuntime.waitForEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  async acknowledgeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    // 协议事件先消费 ProtocolStore 状态再 ack transport；普通消息直接 ack。
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
    await this.#cronRuntime.acknowledgeEvents(events);
    for (const event of events) {
      if (!(isMailboxMessage(event) || isProtocolMailboxMessage(event))) continue;
      const mailboxEvent = event as MailboxItem;
      try {
        if (isProtocolMailboxMessage(mailboxEvent)) {
          const runtime = this.#protocolRuntime;
          if (runtime === undefined)
            throw new TeammateStateError("Protocol runtime is not configured");
          await runtime.acknowledgeLeadMessage(mailboxEvent);
        }
        if (!(await this.#store.ack(mailboxEvent))) {
          throw new MailboxStorageError(`Mailbox message is not processing: ${mailboxEvent.id}`);
        }
      } catch (error) {
        // 确认失败时把同一事件重新发布，Runner 会按 event_id 去重，避免已写入 history 的消息丢失。
        if (!this.#queuedMessageIds.has(mailboxEvent.id)) {
          this.#inbox.publish(mailboxEvent);
          this.#queuedMessageIds.add(mailboxEvent.id);
        }
        throw error;
      }
      this.#queuedMessageIds.delete(event.id);
    }
  }

  // 关闭按 worker 收束、资源释放顺序执行，确保未确认消息不会被静默丢弃。
  async close(): Promise<void> {
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

  // 工具边界只返回可观察的错误，不向 Agent 暴露内部栈。
  async #spawnTool(input: SpawnTeammateInput, context: ToolContext): Promise<ToolResult> {
    try {
      const teammate = await this.spawn({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(teammate));
    } catch (error) {
      return toolError(errorCode(error, "teammate_spawn_error"), errorMessage(error));
    }
  }
  // sender 由 ToolContext.identity 注入，工具输入不能伪造消息来源。
  async #sendTool(input: SendMessageInput, context: ToolContext): Promise<ToolResult> {
    try {
      const message = await this.send({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(message.toPayload()));
    } catch (error) {
      return toolError(errorCode(error, "mailbox_send_error"), errorMessage(error));
    }
  }

  #startWorker(worker: Worker): void {
    // 每个 worker 都作为 supervisor 下的受管任务运行，supervisor 负责统一追踪和关闭。
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
    // claim 即获取租约：成功后当前消息进入 processing，直到 ack/release/quarantine。
    try {
      while (!this.#closed) {
        const message = await this.#store.claim(worker.teammate.name);
        if (message === undefined) {
          this.#setStatus(worker, TeammateStatus.Idle);
          return;
        }
        worker.currentMessage = message;
        this.#setStatus(worker, TeammateStatus.Running);
        try {
          // 同一消息 UUID 作为本轮 idempotency key，外部工具可以据此去重。
          let finalText: string;
          if (isProtocolMailboxMessage(message)) {
            // 协议消息在模型调用前完成路由；shutdown 直接终止，plan response 才生成模型 prompt。
            const runtime = this.#protocolRuntime;
            if (runtime === undefined)
              throw new TeammateStateError("Protocol runtime is not configured");
            const route = await runtime.routeTeammateMessage(worker.teammate.name, message, signal);
            if (route.shutdown) {
              if (!(await this.#store.ack(message))) {
                throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
              }
              worker.currentMessage = undefined;
              this.#setStatus(worker, TeammateStatus.Shutdown);
              return;
            }
            if (route.prompt === undefined)
              throw new TeammateStateError("Protocol route did not provide a prompt");
            finalText = (
              await worker.runner.run(route.prompt, {
                idempotencyKey: message.id,
                signal,
              })
            ).finalText;
          } else {
            // 普通消息直接把 content 交给队友 Runner。
            finalText = (
              await worker.runner.run(message.content, {
                idempotencyKey: message.id,
                signal,
              })
            ).finalText;
          }
          await this.#store.send(
            worker.teammate.name,
            this.#leadName,
            finalText,
            MailboxMessageKind.Result,
          );
          // 队友结果写回 Lead 后再 ack 原消息，结果和租约释放不会互相丢失。
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
          if (isProtocolMailboxMessage(message) && !isProtocolQuarantineError(error)) {
            // 非协议类错误不 quarantine，release 后让 worker 失败，保留消息供诊断后重放。
            if (!(await this.#store.release(message))) {
              throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
            }
            worker.currentMessage = undefined;
            throw error;
          }
          if (!(await this.#store.quarantine(message))) {
            // 业务失败把输入隔离到 quarantine，并向 Lead 发布可观察的失败 result。
            throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
          }
          worker.currentMessage = undefined;
          if (isProtocolMailboxMessage(message)) continue;
          throw error;
        }
        this.#setStatus(worker, TeammateStatus.Idle);
        // 完成一轮后主动通知 Lead，让 run_events 有机会立即消费结果。
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

  async #notifyLead(): Promise<void> {
    // 只有发布了新事件才唤醒事件回合，空扫描不制造模型调用。
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
      if (isProtocolMailboxMessage(message)) {
        const runtime = this.#protocolRuntime;
        if (runtime === undefined) {
          await this.#store.release(message);
          throw new TeammateStateError("Protocol runtime is not configured");
        }
        try {
          await runtime.validateLeadMessage(message);
        } catch (error) {
          // Lead 协议消息先只读校验：协议无效则 quarantine，其他故障 release 后交给上层重试。
          if (!isProtocolQuarantineError(error)) {
            await this.#store.release(message);
            throw error;
          }
          if (!(await this.#store.quarantine(message))) {
            throw new MailboxStorageError(`Protocol message is not processing: ${message.id}`);
          }
          continue;
        }
      }
      this.#inbox.publish(message);
      this.#queuedMessageIds.add(message.id);
      published = true;
    }
  }
  #markMailboxEventsDequeued(events: readonly RuntimeEvent[]): void {
    // 出队只释放进程内去重标记；持久 processing 状态仍等 ack 处理。
    for (const event of events) {
      if (!(isMailboxMessage(event) || isProtocolMailboxMessage(event))) continue;
      this.#queuedMessageIds.delete((event as MailboxItem).id);
    }
  }
  #assertParticipant(name: string, allowShutdown = false): void {
    // Lead 始终可收；普通队友必须存在且未 failed/shutdown，shutdown 响应允许发给已进入关闭流程的队友。
    if (name === this.#leadName) return;
    const worker = this.#workers.get(name);
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    if (
      worker.teammate.status === TeammateStatus.Failed ||
      (worker.teammate.status === TeammateStatus.Shutdown && !allowShutdown)
    ) {
      throw new TeammateStateError(
        `Teammate ${name} cannot receive protocol messages while ${worker.teammate.status}`,
      );
    }
  }
  #setStatus(worker: Worker, status: TeammateStatus): void {
    // 状态变化通过替换冻结快照完成，外部引用不会被就地修改。
    worker.teammate = snapshot(worker.teammate.name, worker.teammate.role, status);
  }
  #ensureAvailable(): void {
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (!this.#started) throw new TeammateStateError("TeammateRuntime is not started");
  }
  async #withRegistry<T>(operation: () => Promise<T>): Promise<T> {
    // 进程内 promise 队列串行化注册、发送和协议投递，避免并发操作造成队友集合不一致。
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

function snapshot(name: string, role: string, status: TeammateStatus): Teammate {
  // 每次迁移返回新冻结对象，使观察者不会看到半更新字段。
  return Object.freeze({ name, role, status });
}
function requireText(value: string, label: string): string {
  // Mailbox 与协议正文统一拒绝空白，避免生成不可执行回合。
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must not be empty`);
  return value.trim();
}
function isMailboxMessage(value: RuntimeEvent): value is MailboxMessage {
  // 普通与协议事件都使用 kind=mailbox；该守卫只收窄 P15 普通消息。
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
function isProtocolQuarantineError(error: unknown): boolean {
  // 只有协议不匹配、不存在、过期或状态错误才隔离；其他错误交给外层恢复逻辑。
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "errorCode");
  return (
    code === "protocol_mismatch" ||
    code === "protocol_not_found" ||
    code === "protocol_expired" ||
    code === "protocol_state_error"
  );
}
