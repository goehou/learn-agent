// teammate 运行时：以独立 AgentRunner 和身份管理持久队友，并通过 mailbox/EventInbox 与 Lead 协作；P16 增加协议消息路由与优雅关闭，P17 增加 SQLite 任务自动认领与空闲轮询。
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
import type { WorkStealingRuntime } from "./work-stealing.js";

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
  readonly name: string;
  readonly role: string;
  readonly status: TeammateStatus;
}

export type TeammateRunnerFactory = (
  name: string,
  role: string,
  sendToolDefinition: ToolDefinition<SendMessageInput>,
) => AgentRunner;

interface Worker {
  // worker 聚合单个持续队友的 Runner、取消信号、唤醒信号与生命周期状态。
  teammate: Teammate;
  readonly runner: AgentRunner;
  task: Promise<void> | undefined;
  currentMessage: MailboxItem | undefined;
  abort: AbortController | undefined;
  closeComplete: boolean;
  cleanupFailure: unknown | undefined;
  // 空闲轮询状态由 worker 自持，收到新消息时立即中止等待并重新扫描。
  pollWakeup: AbortController | undefined;
  idlePolls: number;
  idleTimeoutCount: number;
  idleTimeout: Deferred<void>;
}

interface Deferred<T> {
  // ready/idle 等待使用显式 Promise 控制器，状态转换只由 runtime 内部完成。
  // P17 为受管轮询保存独立的完成信号，让 idle 结束可被等待而不只依赖计数器。
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

// 每名队友拥有独立 AgentRunner 和身份；共享资源仅限 mailbox、事件 Inbox 与调度器。
export class TeammateRuntime {
  // Lead、所有 worker、mailbox、protocol 与 work stealing 共享该运行时，避免各自维护状态副本。
  readonly #store: MailboxStore;
  readonly #inbox: EventInbox;
  readonly #supervisor: JobSupervisor;
  readonly #cronRuntime: CronRuntime;
  readonly #leadName: string;
  readonly #workers = new Map<string, Worker>();
  // 记录已发布到 EventInbox 的 mailbox 事件，避免确认失败重投时重复排队。
  readonly #queuedMessageIds = new Set<string>();
  readonly #spawnToolDefinition: ToolDefinition<SpawnTeammateInput>;
  readonly #sendToolDefinition: ToolDefinition<SendMessageInput>;
  // 协议运行时与队友共享同一 store，负责 Lead 侧消息校验与 ack 状态消费。
  #protocolRuntime: ProtocolRuntime | undefined;
  // work-stealing 运行时在启动前绑定，负责 SQLite 任务认领与空闲轮询。
  #workStealingRuntime: WorkStealingRuntime | undefined;
  #runnerFactory: TeammateRunnerFactory | undefined;
  #wakeup: (() => Promise<void>) | undefined;
  #registryTail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor(options: {
    readonly store: MailboxStore;
    readonly inbox: EventInbox;
    readonly supervisor: JobSupervisor;
    readonly cronRuntime: CronRuntime;
    readonly leadName?: string;
  }) {
    // 构造器校验共享 supervisor/inbox/cron 引用；Runner、protocol 和 work stealing 在 start 前补齐。
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
    return this.#supervisor;
  }
  get eventInbox(): EventInbox {
    return this.#inbox;
  }
  get cronRuntime(): CronRuntime {
    return this.#cronRuntime;
  }
  get mailboxStore(): MailboxStore {
    return this.#store;
  }
  get workStealingRuntime(): WorkStealingRuntime | undefined {
    return this.#workStealingRuntime;
  }
  get hasPendingWork(): boolean {
    return this.#cronRuntime.hasPendingWork;
  }
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

  configureRunnerFactory(factory: TeammateRunnerFactory): void {
    // factory 只允许配置一次且必须早于 start，保证所有 worker 使用同一工具与治理策略。
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    if (this.#runnerFactory !== undefined || this.#started) {
      throw new TeammateStateError("Teammate runner factory must be configured once before start");
    }
    this.#runnerFactory = factory;
  }

  configureProtocol(runtime: ProtocolRuntime): void {
    // 协议运行时必须复用当前 team 和 mailbox store，避免请求登记与消息投递分叉。
    // 协议 runtime 必须与队友共享同一 MailboxStore，并且只能在启动前配置一次。
    if (runtime.teamRuntime !== this || runtime.mailboxStore !== this.#store) {
      throw new TeammateStateError("Protocol runtime must share this teammate runtime and mailbox");
    }
    if (this.#protocolRuntime !== undefined || this.#started) {
      throw new TeammateStateError("Protocol runtime must be configured once before start");
    }
    this.#protocolRuntime = runtime;
  }

  configureWorkStealing(runtime: WorkStealingRuntime): void {
    // 必须在 start 前绑定；worker 启动后替换认领服务会破坏活跃租约的身份一致性。
    // work-stealing 需要 ProtocolRuntime 做 plan gate：最新计划为 pending/rejected 时不自动认领。
    if (this.#workStealingRuntime !== undefined || this.#started) {
      throw new TeammateStateError("Work-stealing runtime must be configured once before start");
    }
    if (this.#protocolRuntime === undefined) {
      throw new TeammateStateError("Work-stealing runtime requires Protocol runtime");
    }
    this.#workStealingRuntime = runtime;
  }

  bindWakeup(wakeup: () => Promise<void>): void {
    // Lead 事件到达时调用外层 AgentRunner.runEvents；重复绑定会显式失败。
    if (typeof wakeup !== "function") throw new TypeError("wakeup must be a function");
    this.#wakeup = wakeup;
  }

  async start(): Promise<void> {
    // 启动先恢复 Lead/worker 的 processing 消息，再启动事件泵和已注册 worker。
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
    // 等待 Lead 消息泵完成首次恢复，调用方可在此后安全发送协议请求。
    await this.start();
  }

  state(name: string): Teammate {
    // 返回不可变公开快照，不暴露 Worker 的 Runner、AbortController 等内部资源。
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    return worker.teammate;
  }

  idleTimeoutCount(name: string): number {
    // 暴露连续空轮询次数供测试和关闭策略观察，不允许调用方直接修改。
    // 只读观察空闲轮询结束次数，供测试确认 idle 队友不会伪造 shutdown/退出状态。
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    return worker.idleTimeoutCount;
  }

  async waitForIdleTimeout(name: string): Promise<void> {
    // 仅在达到 maxIdlePolls 后完成；新任务或消息会重置计数。
    // 等待当前 worker 的空闲轮询结束，测试可在不依赖固定 poll 时长下确认受管任务收束。
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    await worker.idleTimeout.promise;
  }

  beginShutdown(name: string): void {
    // 先标记 closing 并唤醒等待中的 worker，实际终态由 shutdown 协议响应确认。
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    this.#setStatus(worker, TeammateStatus.Shutdown);
  }

  async spawn(input: SpawnTeammateInput & { readonly sender: string }): Promise<Teammate> {
    // 注册表写入与 worker 启动串行化，同名检查和状态发布不会互相穿插。
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
        pollWakeup: undefined,
        idlePolls: 0,
        idleTimeoutCount: 0,
        idleTimeout: deferred<void>(),
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
    // 发送前验证参与方状态；成功落盘后唤醒目标 worker 或通知 Lead 事件泵。
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
        this.#wakeWorker(worker);
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
        this.#wakeWorker(worker);
        this.#startWorker(worker);
      }
      return sent;
    });
    if (to === this.#leadName) await this.#notifyLead();
    return message;
  }

  drainEvents(limit?: number): readonly RuntimeEvent[] {
    // 非阻塞拉取共享事件，并同步更新 mailbox 去重集合。
    const events = this.#cronRuntime.drainEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    // 阻塞等待与 drain 使用相同的出队记账，避免同一消息重复发布。
    const events = await this.#cronRuntime.waitForEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  async acknowledgeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    // 先确认 Cron 事件，再消费协议状态和 mailbox 租约；失败事件重新入队供重试。
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
    for (const worker of this.#workers.values()) {
      worker.abort?.abort();
      this.#wakeWorker(worker);
    }
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
    // 每名 worker 同时只允许一个运行 Promise，结束后统一解析 shutdown/idle 等等待者。
    // 每个 worker 都作为 supervisor 下的受管任务运行，supervisor 负责统一追踪和关闭。
    if (worker.task !== undefined) return;
    const abort = new AbortController();
    worker.abort = abort;
    const task = this.#supervisor.startManaged(async (signal) => {
      signal.addEventListener(
        "abort",
        () => {
          abort.abort();
          this.#wakeWorker(worker);
        },
        { once: true },
      );
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
    // 单轮优先级固定为 mailbox/protocol、计划门禁、自动认领、可中断等待，避免任务抢占控制消息。
    // claim 即获取租约：成功后当前消息进入 processing，直到 ack/release/quarantine 结束本轮。
    try {
      while (!this.#closed) {
        // 每次扫描的优先顺序：Mailbox 消息 > typed Protocol > 自动认领 > 轮询等待。
        // Mailbox 优先保证 shutdown/plan response 不会被 ready task 饿死。
        // Protocol.planAllowsEffectful 为 false 时跳过认领，保持最新计划门控。
        const scan = await this.#withRegistry(async () => {
          this.#ensureAvailable();
          const message = await this.#store.claim(worker.teammate.name);
          if (message !== undefined) {
            return { message, workStealing: undefined, claim: undefined };
          }
          const workStealing = this.#workStealingRuntime;
          if (workStealing === undefined) {
            return { message: undefined, workStealing: undefined, claim: undefined };
          }
          const protocol = this.#protocolRuntime;
          if (protocol === undefined) {
            throw new TeammateStateError("Work-stealing runtime requires Protocol runtime");
          }
          if (!(await protocol.planAllowsEffectful(worker.teammate.name))) {
            return { message: undefined, workStealing, claim: undefined };
          }
          return {
            message: undefined,
            workStealing,
            claim: await workStealing.claimNext(worker.teammate.name),
          };
        });
        const message = scan.message;
        if (message === undefined) {
          const workStealing = scan.workStealing;
          if (workStealing === undefined) {
            this.#setStatus(worker, TeammateStatus.Idle);
            return;
          }
          const claim = scan.claim;
          if (claim !== undefined) {
            // claim token 同时作为本轮 AgentRunner.run() 的幂等键，防止模型因重试重复完成任务。
            worker.idlePolls = 0;
            this.#setStatus(worker, TeammateStatus.Running);
            const finalText = (
              await worker.runner.run(workStealing.renderClaimPrompt(claim), {
                idempotencyKey: claim.claimToken,
                signal,
              })
            ).finalText;
            await this.#store.send(
              worker.teammate.name,
              this.#leadName,
              finalText,
              MailboxMessageKind.Result,
            );
            this.#setStatus(worker, TeammateStatus.Idle);
            await this.#notifyLead();
            continue;
          }
          this.#setStatus(worker, TeammateStatus.Idle);
          const wakeup = new AbortController();
          worker.pollWakeup = wakeup;
          // waitForPoll 可被 #wakeWorker 提前中止，让空闲队友在收到新消息后立即重启扫描。
          await workStealing.waitForPoll(wakeup.signal);
          if (worker.pollWakeup === wakeup) worker.pollWakeup = undefined;
          if (wakeup.signal.aborted) continue;
          worker.idlePolls += 1;
          if (worker.idlePolls >= workStealing.maxIdlePolls) {
            worker.idleTimeoutCount += 1;
            worker.idleTimeout.resolve();
            return;
          }
          continue;
        }
        worker.idlePolls = 0;
        worker.currentMessage = message;
        this.#setStatus(worker, TeammateStatus.Running);
        try {
          // 同一 mailbox 消息 UUID 作为本轮 idempotency key；自动认领则使用 claim token。
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
    // 合并并发通知为单个泵任务，避免每条 mailbox 消息都并行触发 runEvents。
    const published = await this.#publishLeadMessages();
    if (published && this.#wakeup !== undefined) await this.#wakeup();
  }
  async #publishLeadMessages(): Promise<boolean> {
    // 按 mailbox 租约顺序发布 Lead 消息，发布失败则释放租约等待下次重试。
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
    // 事件离开 Inbox 后移除 queued 标记；ack 失败时才允许重新发布。
    for (const event of events) {
      if (!(isMailboxMessage(event) || isProtocolMailboxMessage(event))) continue;
      this.#queuedMessageIds.delete((event as MailboxItem).id);
    }
  }
  #assertParticipant(name: string, allowShutdown = false): void {
    // Lead 永远可接收；普通队友必须存在且状态允许，shutdown 响应是唯一终态例外。
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
    // 状态变更集中写入，确保公开快照与内部 worker 始终一致。
    worker.teammate = snapshot(worker.teammate.name, worker.teammate.role, status);
  }
  #wakeWorker(worker: Worker): void {
    // abort 只唤醒当前 sleep；随后立即换新 controller，worker 生命周期本身不被取消。
    // 中断 polling sleep，使 idle worker 在下一轮循环重新扫描 Mailbox。
    worker.pollWakeup?.abort();
  }
  #ensureAvailable(): void {
    // 关闭后的 runtime 拒绝所有新操作，避免资源释放后继续落盘。
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
  return Object.freeze({ name, role, status });
}
function deferred<T>(): Deferred<T> {
  // 每个 worker 使用独立 Deferred，保证测试等待不会跨队友串台。
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}
function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must not be empty`);
  return value.trim();
}
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
