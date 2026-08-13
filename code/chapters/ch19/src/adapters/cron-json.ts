// JSON Cron 适配器：把 durable 计划与 outbox 持久化到 workspace 的 .agent_tutorial/cron，以进程内 mutex 加文件锁保证原子迁移。
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { lock as acquireLock } from "proper-lockfile";

import {
  canonicalCronId,
  createCronEvent,
  CronError,
  CronJobNotFoundError,
  CronStorageError,
  type CronEvent,
  type CronJob,
  type CronStore,
  nextCronOccurrence,
  validateCronExpression,
  validateCronTimezone,
} from "../features/cron.js";

// 版本号决定 state.json 的 schema 兼容边界；锁参数则控制多进程竞争时的回收与重试策略。
const STATE_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const MAX_LOCK_RETRIES = 100;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
// 同一进程内对同一 workspace 再串行一次，避免多个 store 实例反复争抢目录锁。
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

export interface JsonCronStoreOptions {
  readonly idGenerator?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly outboxCapacity?: number;
  readonly atomicReplace?: (path: string, content: Buffer) => Promise<void>;
}
interface CronPaths {
  readonly workspace: string;
  readonly stateRoot: string;
  readonly root: string;
  readonly state: string;
  readonly lock: string;
  readonly leader: string;
}
// state.json 只保存 durable job/outbox；session-only 状态始终留在内存中。
interface CronState {
  readonly version: number;
  readonly jobs: readonly CronJob[];
  readonly outbox: readonly CronEvent[];
}

export class JsonCronStore implements CronStore {
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #eventIdGenerator: () => string;
  readonly #outboxCapacity: number;
  readonly #atomicReplace: (path: string, content: Buffer) => Promise<void>;
  // durable=False 的 job 与 pending event 只保存在本实例，不写入 state.json。
  readonly #sessionJobs = new Map<string, CronJob>();
  readonly #sessionOutbox = new Map<string, CronEvent>();
  #leaderRelease: (() => Promise<void>) | undefined;

  constructor(workspace: string, options: JsonCronStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0)
      throw new TypeError("workspace must be a non-empty string");
    const capacity = options.outboxCapacity ?? 50;
    if (!Number.isInteger(capacity) || capacity <= 0)
      throw new TypeError("outboxCapacity must be a positive integer");
    this.#workspaceInput = workspace;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#eventIdGenerator = options.eventIdGenerator ?? randomUUID;
    this.#outboxCapacity = capacity;
    this.#atomicReplace = options.atomicReplace ?? atomicReplace;
  }

  async scheduleCron(input: {
    cron: string;
    prompt: string;
    timezone: string;
    recurring: boolean;
    durable: boolean;
    identity: string;
    nowUtc: Date;
  }): Promise<CronJob> {
    if (typeof input.recurring !== "boolean" || typeof input.durable !== "boolean") {
      throw new CronStorageError("Cron recurring and durable values must be boolean");
    }
    // 创建 job 前先验证表达式、时区、prompt 和 identity，非法输入不会产生可持久化的定义。
    const id = this.#nextId(this.#idGenerator, "Cron job");
    const cron = validateCronExpression(input.cron);
    const timezone = validateCronTimezone(input.timezone);
    const job: CronJob = Object.freeze({
      id,
      cron,
      prompt: requireText(input.prompt, "Cron prompt"),
      timezone,
      recurring: input.recurring,
      durable: input.durable,
      identity: requireText(input.identity, "Cron identity"),
      nextRunAtUtc: nextCronOccurrence(input.cron, input.timezone, input.nowUtc),
      lastSlotAtUtc: null,
    });
    const paths = await this.#preparePaths(input.durable);
    return await this.#withLock(paths, async () => {
      const state = await this.#loadState(paths);
      if (this.#sessionJobs.has(job.id) || state.jobs.some((existing) => existing.id === job.id))
        throw new CronStorageError(`Cron job id already exists: ${job.id}`);
      // durable job 写入原子快照，session-only job 只放入内存 Map。
      if (job.durable) await this.#persist(paths, { ...state, jobs: [...state.jobs, job] });
      else this.#sessionJobs.set(job.id, job);
      return job;
    });
  }

  async getJob(jobId: string): Promise<CronJob> {
    // 查询时把 durable 快照与 session-only 合并，调用方不需要知道 job 来自哪个生命周期。
    const id = this.#lookupJobId(jobId);
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () => {
      const state = await this.#loadState(paths);
      const job = [...state.jobs, ...this.#sessionJobs.values()].find(
        (candidate) => candidate.id === id,
      );
      if (job === undefined) throw new CronJobNotFoundError(`Cron job does not exist: ${id}`);
      return job;
    });
  }
  async listJobs(): Promise<readonly CronJob[]> {
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () =>
      Object.freeze(
        [...(await this.#loadState(paths)).jobs, ...this.#sessionJobs.values()].sort(
          (left, right) => left.id.localeCompare(right.id),
        ),
      ),
    );
  }

  async tick(nowUtc: Date, includeDurable = true): Promise<readonly CronEvent[]> {
    if (typeof includeDurable !== "boolean")
      throw new TypeError("includeDurable must be a boolean");
    if (!(nowUtc instanceof Date) || !Number.isFinite(nowUtc.valueOf())) {
      throw new CronStorageError("Cron clock value must be a valid UTC Date");
    }
    // tick 在锁内同时迁移 durable 与 session-only：先按到期时间排序，再受 outbox 容量限制。
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () => {
      const state = await this.#loadState(paths);
      const durableJobs = new Map(state.jobs.map((job) => [job.id, job]));
      const durableOutbox = new Map(state.outbox.map((event) => [event.eventId, event]));
      const sessionJobs = new Map(this.#sessionJobs);
      const sessionOutbox = new Map(this.#sessionOutbox);
      const knownEventIds = new Set([...durableOutbox.keys(), ...sessionOutbox.keys()]);
      if (knownEventIds.size !== durableOutbox.size + sessionOutbox.size) {
        throw new CronStorageError("Cron outbox contains duplicate event IDs");
      }
      const jobs = new Map<string, CronJob>([
        ...(includeDurable ? durableJobs : []),
        ...sessionJobs,
      ]);
      // durable 与 session 事件共享同一容量，防止 session-only 无限占用当前进程内存。
      const capacityUsed = (includeDurable ? durableOutbox.size : 0) + sessionOutbox.size;
      let available = this.#outboxCapacity - capacityUsed;
      const created: CronEvent[] = [];
      for (const job of [...jobs.values()]
        .filter((candidate) => candidate.nextRunAtUtc.getTime() <= nowUtc.getTime())
        .sort(
          (left, right) =>
            left.nextRunAtUtc.getTime() - right.nextRunAtUtc.getTime() ||
            left.id.localeCompare(right.id),
        )) {
        if (available <= 0) break;
        const eventId = this.#nextId(this.#eventIdGenerator, "Cron event");
        if (knownEventIds.has(eventId)) {
          throw new CronStorageError(`Cron event id already exists: ${eventId}`);
        }
        const event = createCronEvent({
          eventId,
          jobId: job.id,
          identity: job.identity,
          prompt: job.prompt,
          timezone: job.timezone,
          durable: job.durable,
          slotAtUtc: new Date(job.nextRunAtUtc),
        });
        if (job.durable) durableOutbox.set(eventId, event);
        else sessionOutbox.set(eventId, event);
        knownEventIds.add(eventId);
        if (job.recurring) {
          const updated = Object.freeze({
            ...job,
            lastSlotAtUtc: new Date(job.nextRunAtUtc),
            nextRunAtUtc: nextCronOccurrence(job.cron, job.timezone, nowUtc),
          });
          if (job.durable) durableJobs.set(job.id, updated);
          else sessionJobs.set(job.id, updated);
        } else if (job.durable) durableJobs.delete(job.id);
        else sessionJobs.delete(job.id);
        created.push(event);
        available -= 1;
      }
      // 只有在产生 durable event 时才写 state.json；纯 session-only 状态不落盘。
      if (created.some((event) => event.durable))
        await this.#persist(paths, {
          version: STATE_VERSION,
          jobs: [...durableJobs.values()],
          outbox: [...durableOutbox.values()],
        });
      this.#sessionJobs.clear();
      for (const [id, job] of sessionJobs) this.#sessionJobs.set(id, job);
      this.#sessionOutbox.clear();
      for (const [id, event] of sessionOutbox) this.#sessionOutbox.set(id, event);
      return Object.freeze(created);
    });
  }

  async pendingEvents(includeDurable = true): Promise<readonly CronEvent[]> {
    if (typeof includeDurable !== "boolean")
      throw new TypeError("includeDurable must be a boolean");
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () =>
      Object.freeze(
        [
          ...(includeDurable ? (await this.#loadState(paths)).outbox : []),
          ...this.#sessionOutbox.values(),
        ].sort(
          (left, right) =>
            left.slotAtUtc.getTime() - right.slotAtUtc.getTime() ||
            left.eventId.localeCompare(right.eventId),
        ),
      ),
    );
  }
  async ackEvent(eventId: string): Promise<boolean> {
    const id = this.#lookupEventId(eventId);
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () => {
      const state = await this.#loadState(paths);
      // ack 优先删除 session outbox；durable event 需要把删除后的快照原子提交。
      if (this.#sessionOutbox.delete(id)) return true;
      if (!state.outbox.some((event) => event.eventId === id)) return false;
      await this.#persist(paths, {
        ...state,
        outbox: state.outbox.filter((event) => event.eventId !== id),
      });
      return true;
    });
  }
  async tryAcquireLeader(): Promise<boolean> {
    if (this.#leaderRelease !== undefined) return false;
    const paths = await this.#preparePaths(true);
    let release: (() => Promise<void>) | undefined;
    try {
      // leader lock 非阻塞尝试一次；拿不到就代表已有另一个 scheduler 负责 durable job。
      release = await acquireLock(paths.leader, {
        realpath: true,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: 0,
      });
    } catch (error) {
      if (hasCode(error, "ELOCKED") || hasCode(error, "EEXIST")) return false;
      throw new CronStorageError("Cron leader lock could not be acquired", { cause: error });
    }
    this.#leaderRelease = release;
    return true;
  }
  async releaseLeader(): Promise<void> {
    if (this.#leaderRelease === undefined) return;
    const release = this.#leaderRelease;
    this.#leaderRelease = undefined;
    try {
      await release();
    } catch (error) {
      throw new CronStorageError("Cron leader lock could not be released", { cause: error });
    }
  }

  async #preparePaths(create: boolean): Promise<CronPaths> {
    // 状态路径固定在 workspace/.agent_tutorial 下，并在创建或读取前验证不能逃逸 workspace。
    try {
      const workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) throw new Error("workspace is not a directory");
      const stateRoot = join(workspace, ".agent_tutorial");
      const root = join(stateRoot, "cron");
      const leader = join(root, "leader");
      if (create) {
        await mkdir(stateRoot, { recursive: true });
        await validateDirectory(workspace, stateRoot, "Cron state root");
        await mkdir(root, { recursive: true });
        await validateDirectory(workspace, root, "Cron state root");
        await mkdir(leader, { recursive: true });
        await validateDirectory(workspace, leader, "Cron leader root");
      } else if (await exists(stateRoot)) {
        await validateDirectory(workspace, stateRoot, "Cron state root");
      }
      const paths = Object.freeze({
        workspace,
        stateRoot,
        root,
        state: join(root, "state.json"),
        lock: join(stateRoot, ".cron.lock"),
        leader,
      });
      if (!(await exists(root))) return paths;
      await validateDirectory(workspace, root, "Cron state root");
      if ((await exists(paths.lock)) && (await lstat(paths.lock)).isSymbolicLink()) {
        throw new CronStorageError("Cron state lock path must not be a symbolic link");
      }
      return paths;
    } catch (error) {
      if (error instanceof CronError) throw error;
      throw new CronStorageError("Cron state root is invalid", { cause: error });
    }
  }
  async #withLock<T>(paths: CronPaths, operation: () => Promise<T>): Promise<T> {
    // 进程内 mutex 加 proper-lockfile 目录锁双重串行化，保证同一时刻只有一次快照读改写。
    return await withMutex(paths.workspace, async () => {
      if (!(await exists(paths.root))) return await operation();
      let release: (() => Promise<void>) | undefined;
      try {
        for (
          let attempts = 0;
          attempts <= MAX_LOCK_RETRIES && release === undefined;
          attempts += 1
        ) {
          try {
            release = await acquireLock(paths.root, {
              lockfilePath: paths.lock,
              realpath: true,
              stale: LOCK_STALE_MS,
              update: LOCK_UPDATE_MS,
              retries: 0,
            });
          } catch (error) {
            if (
              (hasCode(error, "ELOCKED") || hasCode(error, "EEXIST")) &&
              attempts < MAX_LOCK_RETRIES
            ) {
              await delay(LOCK_RETRY_MS);
              continue;
            }
            throw error;
          }
        }
        if (release === undefined) {
          throw new CronStorageError("Cron state lock could not be acquired");
        }
        await validateDirectory(paths.workspace, paths.root, "Cron state root");
        return await operation();
      } catch (error) {
        if (error instanceof CronError) throw error;
        throw new CronStorageError("Cron state operation failed", { cause: error });
      } finally {
        if (release !== undefined) await release();
      }
    });
  }
  async #loadState(paths: CronPaths): Promise<CronState> {
    if (!(await exists(paths.state))) return { version: STATE_VERSION, jobs: [], outbox: [] };
    try {
      // state.json 是外部可损坏的输入，读取后必须按严格 schema 解析，坏状态显式失败。
      const details = await lstat(paths.state);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new CronStorageError("Cron state must be a regular file");
      }
      const value: unknown = JSON.parse(UTF8_DECODER.decode(await readFile(paths.state)));
      return parseState(value);
    } catch (error) {
      if (error instanceof CronError) throw error;
      throw new CronStorageError("Cron state is invalid", { cause: error });
    }
  }
  async #persist(paths: CronPaths, state: CronState): Promise<void> {
    try {
      // 写入始终走原子替换，提交的新快照与旧字节只能二选一。
      await this.#atomicReplace(
        paths.state,
        Buffer.from(`${JSON.stringify(serializeState(state), null, 2)}\n`, "utf8"),
      );
    } catch (error) {
      if (error instanceof CronError) throw error;
      throw new CronStorageError("Cron state could not be persisted", { cause: error });
    }
  }
  #nextId(generator: () => string, label: string): string {
    // UUID 由注入生成器提供，但 store 仍校验 canonical 格式，避免把脏 id 写入状态。
    try {
      return canonicalCronId(generator());
    } catch (error) {
      throw new CronStorageError(`${label} id generator returned an invalid UUID`, {
        cause: error,
      });
    }
  }
  #lookupJobId(value: string): string {
    try {
      return canonicalCronId(value);
    } catch (_error) {
      throw new CronJobNotFoundError("Cron job id must be a canonical UUID");
    }
  }
  #lookupEventId(value: string): string {
    try {
      return canonicalCronId(value);
    } catch (error) {
      throw new CronStorageError("Cron event id must be a canonical UUID", { cause: error });
    }
  }
}

function parseState(value: unknown): CronState {
  // 从 JSON 恢复时逐项校验版本、字段集、类型、UTC 时间和不可变记录约束。
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CronStorageError("Cron state is invalid");
  const record = value as Record<string, unknown>;
  requireExactKeys(record, ["version", "jobs", "outbox"], "Cron state");
  if (
    record.version !== STATE_VERSION ||
    !Array.isArray(record.jobs) ||
    !Array.isArray(record.outbox)
  )
    throw new CronStorageError("Cron state has an unsupported schema");
  let jobs: CronJob[];
  let outbox: CronEvent[];
  try {
    jobs = record.jobs.map(parseJob);
    outbox = record.outbox.map(parseEvent);
  } catch (error) {
    if (error instanceof CronStorageError) throw error;
    throw new CronStorageError("Cron state contains invalid records", { cause: error });
  }
  if (
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    new Set(outbox.map((event) => event.eventId)).size !== outbox.length ||
    jobs.some((job) => !job.durable) ||
    outbox.some((event) => !event.durable)
  )
    throw new CronStorageError("Cron state contains invalid duplicate or non-durable records");
  return { version: STATE_VERSION, jobs, outbox };
}
function parseJob(value: unknown): CronJob {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CronStorageError("Cron job is invalid");
  const record = value as Record<string, unknown>;
  requireExactKeys(
    record,
    [
      "id",
      "cron",
      "prompt",
      "timezone",
      "recurring",
      "durable",
      "identity",
      "next_run_at_utc",
      "last_slot_at_utc",
    ],
    "Cron job",
  );
  if (
    typeof record.id !== "string" ||
    typeof record.cron !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.timezone !== "string" ||
    typeof record.recurring !== "boolean" ||
    typeof record.durable !== "boolean" ||
    typeof record.identity !== "string" ||
    typeof record.next_run_at_utc !== "string" ||
    (record.last_slot_at_utc !== null && typeof record.last_slot_at_utc !== "string")
  )
    throw new CronStorageError("Cron job is invalid");
  const next = new Date(record.next_run_at_utc);
  const last = record.last_slot_at_utc === null ? null : new Date(record.last_slot_at_utc);
  validateCronExpression(record.cron);
  validateCronTimezone(record.timezone);
  if (
    !isUtcTimestamp(record.next_run_at_utc) ||
    (record.last_slot_at_utc !== null && !isUtcTimestamp(record.last_slot_at_utc)) ||
    Number.isNaN(next.valueOf()) ||
    (last !== null && Number.isNaN(last.valueOf())) ||
    (last !== null && next.valueOf() <= last.valueOf())
  )
    throw new CronStorageError("Cron job has invalid UTC timestamp");
  return Object.freeze({
    id: canonicalCronId(record.id),
    cron: validateCronExpression(record.cron),
    prompt: requireText(record.prompt, "Cron prompt"),
    timezone: validateCronTimezone(record.timezone),
    recurring: record.recurring,
    durable: record.durable,
    identity: requireText(record.identity, "Cron identity"),
    nextRunAtUtc: next,
    lastSlotAtUtc: last,
  });
}
function parseEvent(value: unknown): CronEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CronStorageError("Cron event is invalid");
  const record = value as Record<string, unknown>;
  requireExactKeys(
    record,
    ["event_id", "job_id", "identity", "prompt", "timezone", "durable", "slot_at_utc"],
    "Cron event",
  );
  if (
    typeof record.event_id !== "string" ||
    typeof record.job_id !== "string" ||
    typeof record.identity !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.timezone !== "string" ||
    typeof record.durable !== "boolean" ||
    typeof record.slot_at_utc !== "string"
  )
    throw new CronStorageError("Cron event is invalid");
  const slot = new Date(record.slot_at_utc);
  validateCronTimezone(record.timezone);
  if (!isUtcTimestamp(record.slot_at_utc) || Number.isNaN(slot.valueOf()))
    throw new CronStorageError("Cron event has invalid UTC timestamp");
  return createCronEvent({
    eventId: canonicalCronId(record.event_id),
    jobId: canonicalCronId(record.job_id),
    identity: requireText(record.identity, "Cron event identity"),
    prompt: requireText(record.prompt, "Cron event prompt"),
    timezone: validateCronTimezone(record.timezone),
    durable: record.durable,
    slotAtUtc: slot,
  });
}
function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  // 严格字段集是快照版本的一部分；未知字段会让迁移决策变成猜测，因此直接失败。
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new CronStorageError(`${label} contains unsupported fields`);
  }
}
function isUtcTimestamp(value: string): boolean {
  return /Z$/u.test(value);
}
function serializeState(state: CronState): Record<string, unknown> {
  return {
    version: STATE_VERSION,
    jobs: state.jobs.map((job) => ({
      id: job.id,
      cron: job.cron,
      prompt: job.prompt,
      timezone: job.timezone,
      recurring: job.recurring,
      durable: job.durable,
      identity: job.identity,
      next_run_at_utc: job.nextRunAtUtc.toISOString(),
      last_slot_at_utc: job.lastSlotAtUtc?.toISOString() ?? null,
    })),
    outbox: state.outbox.map((event) => ({
      event_id: event.eventId,
      job_id: event.jobId,
      identity: event.identity,
      prompt: event.prompt,
      timezone: event.timezone,
      durable: event.durable,
      slot_at_utc: event.slotAtUtc.toISOString(),
    })),
  };
}
function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new CronStorageError(`${label} must not be empty`);
  return value.trim();
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}
async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
async function validateDirectory(workspace: string, path: string, label: string): Promise<void> {
  // 状态目录必须是 workspace 内真实目录，防止符号链接或相对路径把状态写到外部。
  const resolved = await realpath(path);
  const relativePath = relative(workspace, resolved);
  if (
    (relativePath !== "" && (relativePath.startsWith("..") || isAbsolute(relativePath))) ||
    !(await stat(resolved)).isDirectory()
  )
    throw new CronStorageError(`${label} escapes workspace or is not a directory`);
}
async function withMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // 用 Promise 队列把同进程内对同一 workspace 的操作串行化，避免并发操作覆盖内存状态。
  const previous = PROCESS_LOCK_TAILS.get(key);
  const result = previous === undefined ? operation() : previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  PROCESS_LOCK_TAILS.set(key, tail);
  try {
    return await result;
  } finally {
    if (PROCESS_LOCK_TAILS.get(key) === tail) PROCESS_LOCK_TAILS.delete(key);
  }
}
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // 先写临时文件、sync、再 rename，读方只能看到完整旧快照或完整新快照。
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}
