// 后台任务运行时：以持久化 Job 为状态源，Supervisor 负责容量、取消、超时和事件发布，Dispatcher 只分流显式可后台工具。
import { randomUUID } from "node:crypto";

import { isRuntimeEvent, type EventInbox } from "../core/events.js";
import type { RuntimeEvent } from "../core/events.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "../core/tools.js";
import { isToolResult, toolError, toolSuccess } from "../core/tools.js";
import type { BackgroundShellInput } from "./builtin-tools.js";

const BACKGROUND_MARKERS = Object.freeze([
  "cargo build",
  "compile",
  "deploy",
  "docker build",
  "npm install",
  "pip install",
  "pytest",
]);

export const BackgroundJobStatus = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
} as const);
export type BackgroundJobStatus = (typeof BackgroundJobStatus)[keyof typeof BackgroundJobStatus];

export class BackgroundError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackgroundError";
    this.errorCode = errorCode;
  }
}

export class BackgroundCapacityError extends BackgroundError {
  constructor(message: string) {
    super("background_capacity", message);
    this.name = "BackgroundCapacityError";
  }
}

export class BackgroundClosedError extends BackgroundError {
  constructor(message: string) {
    super("background_closed", message);
    this.name = "BackgroundClosedError";
  }
}

export class BackgroundJobNotFoundError extends BackgroundError {
  constructor(message: string) {
    super("background_job_not_found", message);
    this.name = "BackgroundJobNotFoundError";
  }
}

export class BackgroundJobStateError extends BackgroundError {
  constructor(message: string) {
    super("background_job_state", message);
    this.name = "BackgroundJobStateError";
  }
}

export class BackgroundStorageError extends BackgroundError {
  constructor(message: string, options?: ErrorOptions) {
    super("background_storage_error", message, options);
    this.name = "BackgroundStorageError";
  }
}

export class BackgroundCloseTimeoutError extends BackgroundError {
  constructor(message: string) {
    super("background_close_timeout", message);
    this.name = "BackgroundCloseTimeoutError";
  }
}

export interface BackgroundJobOptions {
  readonly id: string;
  readonly sourceToolCallId: string;
  readonly toolName: string;
  readonly status: BackgroundJobStatus;
  readonly result: ToolResult | null;
}

// 领域对象在构造时验证状态不变量：running 无结果，终态必须有匹配的 ToolResult。
export class BackgroundJob {
  readonly id: string;
  readonly sourceToolCallId: string;
  readonly toolName: string;
  readonly status: BackgroundJobStatus;
  readonly result: ToolResult | null;

  constructor(options: BackgroundJobOptions) {
    this.id = canonicalBackgroundId(options.id);
    if (
      typeof options.sourceToolCallId !== "string" ||
      options.sourceToolCallId.trim().length === 0
    ) {
      throw new BackgroundStorageError("background source tool call id must not be empty");
    }
    if (typeof options.toolName !== "string" || options.toolName.trim().length === 0) {
      throw new BackgroundStorageError("background tool name must not be empty");
    }
    if (!isBackgroundJobStatus(options.status)) {
      throw new BackgroundStorageError("background job status is invalid");
    }
    if (options.status === BackgroundJobStatus.RUNNING) {
      if (options.result !== null) {
        throw new BackgroundStorageError("running background job cannot have a result");
      }
    } else {
      if (!isToolResult(options.result)) {
        throw new BackgroundStorageError("terminal background job requires a result");
      }
      if (options.status === BackgroundJobStatus.COMPLETED && options.result.isError) {
        throw new BackgroundStorageError("completed background job requires a successful result");
      }
      if (options.status !== BackgroundJobStatus.COMPLETED && !options.result.isError) {
        throw new BackgroundStorageError("non-completed background job requires an error result");
      }
    }
    this.sourceToolCallId = options.sourceToolCallId;
    this.toolName = options.toolName;
    this.status = options.status;
    this.result = options.result;
    Object.freeze(this);
  }
}

export interface BackgroundJobStore {
  createRunning(input: {
    readonly jobId: string;
    readonly sourceToolCallId: string;
    readonly toolName: string;
  }): Promise<BackgroundJob>;
  finishRunning(
    jobId: string,
    status: Exclude<BackgroundJobStatus, "running">,
    result: ToolResult,
  ): Promise<BackgroundJob | undefined>;
  interruptRunning(): Promise<readonly BackgroundJob[]>;
  getJob(jobId: string): Promise<BackgroundJob>;
  listJobs(): Promise<readonly BackgroundJob[]>;
}

export type BackgroundOperation = (signal: AbortSignal) => Promise<ToolResult>;

export interface JobExecutor {
  execute(operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult>;
}

export class AsyncJobExecutor implements JobExecutor {
  async execute(operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult> {
    return await operation(signal);
  }
}

export class BackgroundJobEvent implements RuntimeEvent {
  readonly eventId: string;
  readonly jobId: string;
  readonly sourceToolCallId: string;
  readonly toolName: string;
  readonly status: Exclude<BackgroundJobStatus, "running">;
  readonly result: ToolResult;

  constructor(options: {
    readonly eventId: string;
    readonly jobId: string;
    readonly sourceToolCallId: string;
    readonly toolName: string;
    readonly status: Exclude<BackgroundJobStatus, "running">;
    readonly result: ToolResult;
  }) {
    this.eventId = canonicalBackgroundId(options.eventId);
    this.jobId = canonicalBackgroundId(options.jobId);
    if (options.sourceToolCallId.trim().length === 0 || options.toolName.trim().length === 0) {
      throw new Error("background event identifiers must not be empty");
    }
    if (!isToolResult(options.result)) {
      throw new Error("BackgroundJobEvent requires a terminal ToolResult");
    }
    this.sourceToolCallId = options.sourceToolCallId;
    this.toolName = options.toolName;
    this.status = options.status;
    this.result = options.result;
    Object.freeze(this);
  }

  toPayload(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      event_id: this.eventId,
      job_id: this.jobId,
      kind: "background_job",
      result: {
        content: this.result.content,
        error_code: this.result.errorCode ?? null,
        is_error: this.result.isError,
      },
      source_tool_call_id: this.sourceToolCallId,
      status: this.status,
      tool_name: this.toolName,
    });
  }
}

interface JobControl {
  readonly task: Promise<void>;
  readonly cancel: () => void;
}

class CancellationSignalError extends Error {}

// Supervisor 是后台 coroutine 的唯一 owner：控制容量、超时、取消、关闭，并把终态发布为 typed event。
export class JobSupervisor {
  // Supervisor 管理后台作业的持久状态、取消和终态事件，隔离当前模型回合。
  readonly #store: BackgroundJobStore;
  readonly #inbox: EventInbox;
  readonly #executor: JobExecutor;
  readonly #capacity: number;
  readonly #timeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #idGenerator: () => string;
  readonly #eventIdGenerator: () => string;
  readonly #jobControls = new Map<string, JobControl>();
  readonly #managedTasks = new Set<Promise<unknown>>();
  // 受管理的长期协程的 AbortController，close 时统一中止。
  readonly #managedControllers = new Map<Promise<void>, AbortController>();
  readonly #ready: Promise<void>;
  #closed = false;

  constructor(options: {
    readonly store: BackgroundJobStore;
    readonly inbox: EventInbox;
    readonly executor?: JobExecutor;
    readonly capacity?: number;
    readonly timeoutMs?: number;
    readonly closeTimeoutMs?: number;
    readonly idGenerator?: () => string;
    readonly eventIdGenerator?: () => string;
  }) {
    if (
      options.capacity !== undefined &&
      (!Number.isInteger(options.capacity) || options.capacity <= 0)
    ) {
      throw new Error("capacity must be a positive integer");
    }
    const timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
    const closeTimeoutMs = options.closeTimeoutMs === undefined ? 10_000 : options.closeTimeoutMs;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isFinite(closeTimeoutMs) ||
      closeTimeoutMs <= 0
    ) {
      throw new Error("timeouts must be positive finite numbers");
    }
    this.#store = options.store;
    this.#inbox = options.inbox;
    this.#executor = options.executor === undefined ? new AsyncJobExecutor() : options.executor;
    this.#capacity = options.capacity === undefined ? 4 : options.capacity;
    this.#timeoutMs = timeoutMs;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#idGenerator = options.idGenerator === undefined ? randomUUID : options.idGenerator;
    this.#eventIdGenerator =
      options.eventIdGenerator === undefined ? randomUUID : options.eventIdGenerator;
    this.#ready = this.#recover();
  }

  get activeCount(): number {
    return this.#managedTasks.size;
  }

  get eventInbox(): EventInbox {
    return this.#inbox;
  }

  get hasPendingWork(): boolean {
    return this.#jobControls.size > 0;
  }

  async ready(): Promise<void> {
    await this.#ready;
  }

  drainEvents(limit?: number): readonly RuntimeEvent[] {
    return this.#inbox.drain(limit);
  }

  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    return await this.#inbox.wait(limit);
  }

  acknowledgeEvents(events: readonly RuntimeEvent[]): void {
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
  }

  async submit(input: {
    readonly sourceToolCallId: string;
    readonly toolName: string;
    readonly operation: BackgroundOperation;
  }): Promise<string> {
    // 提交顺序固定为“容量检查 -> 先落盘 running -> 再登记 worker”，拒绝时不启动任何副作用。
    await this.#ready;
    if (this.#closed) {
      throw new BackgroundClosedError("JobSupervisor is closed");
    }
    if (this.#jobControls.size >= this.#capacity) {
      throw new BackgroundCapacityError(`Background job capacity ${this.#capacity} is full`);
    }
    const jobId = nextId(this.#idGenerator, "background job");
    await this.#store.createRunning({
      jobId,
      sourceToolCallId: input.sourceToolCallId,
      toolName: input.toolName,
    });
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new CancellationSignalError("background job cancelled"));
    });
    const task = this.#track(this.#runJob(jobId, input.operation, cancelled));
    this.#jobControls.set(jobId, { task, cancel });
    return jobId;
  }

  async cancel(jobId: string): Promise<void> {
    await this.#ready;
    const normalized = canonicalBackgroundId(jobId);
    const control = this.#jobControls.get(normalized);
    if (control === undefined) {
      const job = await this.#store.getJob(normalized);
      throw new BackgroundJobStateError(
        `Background job ${job.id} is ${job.status}; expected running`,
      );
    }
    control.cancel();
    await control.task;
  }

  async waitIdle(): Promise<void> {
    await this.#ready;
    while (this.#jobControls.size > 0) {
      await Promise.all([...this.#jobControls.values()].map((control) => control.task));
    }
  }

  async close(): Promise<void> {
    // 关闭先停止新提交并取消仍在运行的作业，再等待其收束。
    await this.#ready;
    if (this.#closed && this.#managedTasks.size === 0) {
      return;
    }
    this.#closed = true;
    for (const control of this.#jobControls.values()) {
      control.cancel();
    }
    for (const controller of this.#managedControllers.values()) {
      controller.abort();
    }
    const settled = Promise.allSettled([...this.#managedTasks]);
    await withTimeout(
      settled,
      this.#closeTimeoutMs,
      new BackgroundCloseTimeoutError("Managed tasks did not stop before close timeout"),
    );
  }

  // startManaged 注册受管理的长期协程（如 Cron scheduler），关闭时会自动中止其 AbortController。
  startManaged(
    operation: (signal: AbortSignal) => Promise<void>,
    _name = "managed-task",
  ): Promise<void> {
    if (this.#closed) {
      throw new BackgroundClosedError("JobSupervisor is closed");
    }
    if (typeof operation !== "function") {
      throw new TypeError("managed operation must be a function");
    }
    const controller = new AbortController();
    const task = this.#track(Promise.resolve().then(() => operation(controller.signal)));
    this.#managedControllers.set(task, controller);
    void task.then(
      () => this.#managedControllers.delete(task),
      () => this.#managedControllers.delete(task),
    );
    return task;
  }

  async #recover(): Promise<void> {
    const interrupted = await this.#store.interruptRunning();
    for (const job of interrupted) {
      await this.#publishEvent(job);
    }
  }

  #track(operation: Promise<void>): Promise<void> {
    const tracked = operation.then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof CancellationSignalError)) {
          throw error;
        }
      },
    );
    this.#managedTasks.add(tracked);
    void tracked.then(
      () => this.#managedTasks.delete(tracked),
      () => this.#managedTasks.delete(tracked),
    );
    return tracked;
  }

  async #runJob(
    jobId: string,
    operation: BackgroundOperation,
    cancelled: Promise<never>,
  ): Promise<void> {
    const controller = new AbortController();
    const execution = this.#executor.execute(operation, controller.signal);
    // Executor 可能在取消后仍有收尾逻辑；始终等待它结束，避免 close 返回时残留 worker。
    const timeoutHandle = timeout(this.#timeoutMs);
    try {
      const result = await Promise.race([execution, cancelled, timeoutHandle.promise]);
      if (!isToolResult(result)) {
        await this.#finish(
          jobId,
          BackgroundJobStatus.FAILED,
          toolError("background_contract_error", "Background executor returned an invalid result"),
        );
      } else {
        await this.#finish(
          jobId,
          result.isError ? BackgroundJobStatus.FAILED : BackgroundJobStatus.COMPLETED,
          result,
        );
      }
    } catch (error) {
      if (error instanceof CancellationSignalError) {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.CANCELLED,
          toolError("background_cancelled", "Background job was cancelled"),
        );
      } else if (error instanceof TimeoutMarker) {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.TIMED_OUT,
          toolError("background_timeout", "Background job timed out"),
        );
      } else {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.FAILED,
          toolError("background_execution_error", "Background job execution failed"),
        );
      }
    } finally {
      timeoutHandle.cancel();
      this.#jobControls.delete(jobId);
    }
  }

  async #finish(
    jobId: string,
    status: Exclude<BackgroundJobStatus, "running">,
    result: ToolResult,
  ): Promise<void> {
    const job = await this.#store.finishRunning(jobId, status, result);
    if (job !== undefined) {
      await this.#publishEvent(job);
    }
  }

  async #publishEvent(job: BackgroundJob): Promise<void> {
    if (job.result === null || job.status === BackgroundJobStatus.RUNNING) {
      throw new BackgroundStorageError("terminal background job is missing its result");
    }
    const event = new BackgroundJobEvent({
      eventId: nextId(this.#eventIdGenerator, "runtime event"),
      jobId: job.id,
      sourceToolCallId: job.sourceToolCallId,
      toolName: job.toolName,
      status: job.status,
      result: job.result,
    });
    this.#inbox.publish(event);
  }
}

// Dispatcher 仅转交显式标记为 background_eligible 的工具，其余调用保持同步语义。
export class BackgroundDispatcher {
  readonly #tools: ToolRegistry;
  readonly #supervisor: JobSupervisor;

  constructor(tools: ToolRegistry, supervisor: JobSupervisor) {
    this.#tools = tools;
    this.#supervisor = supervisor;
  }

  async dispatch(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    const definition = prepared.definition;
    const argumentsValue = prepared.arguments;
    if (definition === undefined || argumentsValue === undefined || prepared.error !== undefined) {
      throw new Error("BackgroundDispatcher received an invalid prepared call");
    }
    if (definition.concurrency !== "background_eligible") {
      return await this.#tools.invoke(prepared, context);
    }
    if (!isBackgroundShellInput(argumentsValue)) {
      return toolError(
        "background_contract_error",
        "Background-eligible tool used an unsupported input model",
      );
    }
    if (!shouldRunInBackground(argumentsValue)) {
      return await this.#tools.invoke(prepared, context);
    }
    try {
      const jobId = await this.#supervisor.submit({
        sourceToolCallId: prepared.call.id,
        toolName: definition.name,
        operation: async () => await this.#tools.invoke(prepared, context),
      });
      // 占位结果是普通 ToolResult，立即闭合当前工具轮；真实结果稍后经 EventInbox 注入。
      return toolSuccess(
        JSON.stringify({
          job_id: jobId,
          status: BackgroundJobStatus.RUNNING,
          tool_name: definition.name,
        }),
      );
    } catch (error) {
      if (error instanceof BackgroundError) {
        return toolError(error.errorCode, error.message);
      }
      throw error;
    }
  }
}

// 显式布尔值优先；省略时才使用确定性关键词启发式，不预测任意命令耗时。
export function shouldRunInBackground(input: BackgroundShellInput): boolean {
  if (input.run_in_background !== undefined && input.run_in_background !== null) {
    return input.run_in_background;
  }
  const command = input.command.toLowerCase();
  return BACKGROUND_MARKERS.some((marker) => command.includes(marker));
}

// UUID 即文件名来源，外部字符串无法作为路径进入文件系统。
export function canonicalBackgroundId(value: string): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new BackgroundStorageError("background id must be a canonical UUID");
  }
  return value;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isBackgroundJobStatus(value: unknown): value is BackgroundJobStatus {
  return Object.values(BackgroundJobStatus).includes(value as BackgroundJobStatus);
}

function isBackgroundShellInput(value: unknown): value is BackgroundShellInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const command = Reflect.get(value, "command");
  const background = Reflect.get(value, "run_in_background");
  return (
    typeof command === "string" &&
    (background === undefined || background === null || typeof background === "boolean")
  );
}

function nextId(generator: () => string, label: string): string {
  try {
    return canonicalBackgroundId(generator());
  } catch (error) {
    throw new BackgroundStorageError(`${label} id generator returned an invalid UUID`, {
      cause: error,
    });
  }
}

class TimeoutMarker extends Error {}

interface TimeoutHandle {
  readonly promise: Promise<never>;
  cancel(): void;
}

function timeout(milliseconds: number): TimeoutHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutMarker()), milliseconds);
  });
  return Object.freeze({
    promise,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(error), milliseconds);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
