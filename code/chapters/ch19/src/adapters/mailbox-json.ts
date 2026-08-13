// FileMailboxStore 适配器：把 mailbox 领域协议落到 workspace/.agent_tutorial/mailboxes，提供文件锁和原子状态迁移。
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  lstat,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { lock as acquireLock } from "proper-lockfile";

import {
  canonicalAgentName,
  canonicalMailboxMessageId,
  createMailboxMessage,
  createProtocolMailboxMessage,
  equalMailboxItems,
  mailboxItemFromJson,
  mailboxItemToJson,
  type MailboxMessageKind,
  type MailboxItem,
  MailboxState,
  MailboxStorageError,
  randomMailboxMessageId,
  type MailboxMessage,
  type MailboxStore,
  type ProtocolMailboxMessage,
  type ProtocolMessageKind,
} from "../features/mailbox.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
// 同一进程内对同一 workspace 串行化一次，避免多个 store 实例在文件锁之外竞争内存状态。
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

interface MailboxPaths {
  readonly workspace: string;
  readonly stateRoot: string;
  readonly root: string;
  readonly lock: string;
}

type MailboxDirectories = Readonly<Record<MailboxState, string>>;

export interface FileMailboxStoreOptions {
  readonly idGenerator?: () => string;
  readonly clock?: () => Date;
}

// 文件存储实现负责 ready/processing/done/quarantine 四态迁移；调用方只依赖 MailboxStore 协议。
export class FileMailboxStore implements MailboxStore {
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(workspace: string, options: FileMailboxStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    this.#workspaceInput = workspace;
    this.#idGenerator = options.idGenerator ?? randomMailboxMessageId;
    this.#clock = options.clock ?? (() => new Date());
  }

  async send(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): Promise<MailboxMessage> {
    return await this.#withLock(
      true,
      async (paths) => {
        // 发送先校验消息，再写入目标 recipient 的 ready 目录，写入成功才返回消息。
        const message = this.#newMessage(sender, recipient, content, kind);
        const directories = await this.#ensureMailbox(paths, message.recipient);
        if ((await this.#pathsForId(paths, message.id)).length > 0) {
          throw new MailboxStorageError(`Mailbox message id already exists: ${message.id}`);
        }
        await atomicWrite(
          join(directories[MailboxState.Ready], `${message.id}.json`),
          Buffer.from(`${JSON.stringify(mailboxItemToJson(message), null, 2)}\n`, "utf8"),
        );
        return message;
      },
      async () => {
        throw new MailboxStorageError("Mailbox root is unavailable");
      },
    );
  }

  async sendProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: { readonly requestId: string; readonly approved: boolean | null },
  ): Promise<ProtocolMailboxMessage> {
    return await this.#withLock(
      true,
      async (paths) => {
        // 协议消息沿用同一 ready 目录，但 payload 增加 request_id/approved，校验失败不会落盘。
        const message = this.#newProtocolMessage(sender, recipient, content, kind, options);
        const directories = await this.#ensureMailbox(paths, message.recipient);
        if ((await this.#pathsForId(paths, message.id)).length > 0) {
          throw new MailboxStorageError(`Mailbox message id already exists: ${message.id}`);
        }
        await atomicWrite(
          join(directories[MailboxState.Ready], `${message.id}.json`),
          Buffer.from(`${JSON.stringify(mailboxItemToJson(message), null, 2)}\n`, "utf8"),
        );
        return message;
      },
      async () => {
        throw new MailboxStorageError("Mailbox root is unavailable");
      },
    );
  }

  async claim(recipient: string): Promise<MailboxItem | undefined> {
    let normalized: string;
    try {
      normalized = canonicalAgentName(recipient);
    } catch (error) {
      throw new MailboxStorageError("Mailbox recipient must be a safe lowercase slug", {
        cause: error,
      });
    }
    return await this.#withLock(
      false,
      async (paths) => {
        const directories = await this.#existingMailbox(paths, normalized);
        if (directories === undefined) return undefined;
        const candidates = await this.#validEntries(
          paths,
          directories,
          MailboxState.Ready,
          normalized,
        );
        // 按 (created_at_utc, id) 选出下一条，再用 rename 从 ready 原子迁移到 processing。
        const selected = candidates.sort(compareMessages)[0];
        if (selected === undefined) return undefined;
        await move(
          selected.path,
          join(directories[MailboxState.Processing], `${selected.message.id}.json`),
        );
        return selected.message;
      },
      async () => undefined,
    );
  }

  async ack(message: MailboxItem): Promise<boolean> {
    return await this.#transition(message, MailboxState.Done);
  }
  async release(message: MailboxItem): Promise<boolean> {
    return await this.#transition(message, MailboxState.Ready);
  }
  async quarantine(message: MailboxItem): Promise<boolean> {
    return await this.#transition(message, MailboxState.Quarantine);
  }

  async recoverProcessing(recipient: string): Promise<number> {
    let normalized: string;
    try {
      normalized = canonicalAgentName(recipient);
    } catch (error) {
      throw new MailboxStorageError("Mailbox recipient must be a safe lowercase slug", {
        cause: error,
      });
    }
    return await this.#withLock(
      false,
      async (paths) => {
        const directories = await this.#existingMailbox(paths, normalized);
        if (directories === undefined) return 0;
        const candidates = await this.#validEntries(
          paths,
          directories,
          MailboxState.Processing,
          normalized,
        );
        // processing 是半开租约：消费者崩溃后恢复为 ready，让下次 claim 继续处理。
        for (const candidate of candidates.sort(compareMessages)) {
          await move(
            candidate.path,
            join(directories[MailboxState.Ready], `${candidate.message.id}.json`),
          );
        }
        return candidates.length;
      },
      async () => 0,
    );
  }

  async #transition(message: MailboxItem, destination: MailboxState): Promise<boolean> {
    assertMailboxItem(message);
    return await this.#withLock(
      false,
      async (paths) => {
        const directories = await this.#existingMailbox(paths, message.recipient);
        if (directories === undefined) return false;
        const filename = `${message.id}.json`;
        const processing = join(directories[MailboxState.Processing], filename);
        if (!(await pathExists(processing))) {
          // 第二个 runtime 可能已把旧消息恢复并完成 ack；此时允许对相同内容幂等确认。
          if (destination !== MailboxState.Done) return false;
          const completed = join(directories[MailboxState.Done], filename);
          if (!(await pathExists(completed))) return false;
          const stored = await this.#loadMessage(completed, message.recipient);
          if (!equalMailboxItems(stored, message)) {
            throw new MailboxStorageError(
              `Mailbox message does not match completed message: ${message.id}`,
            );
          }
          await this.#assertUniqueId(paths, message.id, completed);
          return true;
        }
        const stored = await this.#loadMessage(processing, message.recipient);
        if (!equalMailboxItems(stored, message)) {
          throw new MailboxStorageError(
            `Processing message does not match claimed message: ${message.id}`,
          );
        }
        // ack/release/quarantine 都以当前 processing 文件为基准，目标目录已存在时拒绝覆盖。
        await this.#assertUniqueId(paths, message.id, processing);
        await move(processing, join(directories[destination], filename));
        return true;
      },
      async () => false,
    );
  }

  #newMessage(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): MailboxMessage {
    // 消息 ID 和时间都由可注入生成器提供，但最终仍走统一领域校验。
    const { id, createdAtUtc } = this.#newEnvelopeFields();
    try {
      return createMailboxMessage({ id, sender, recipient, content, kind, createdAtUtc });
    } catch (error) {
      throw new MailboxStorageError("Mailbox message fields failed validation", { cause: error });
    }
  }

  #newProtocolMessage(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: { readonly requestId: string; readonly approved: boolean | null },
  ): ProtocolMailboxMessage {
    // 协议 envelope 额外校验 request_id/approved 的匹配关系，request 和 response 不能互相伪装。
    const { id, createdAtUtc } = this.#newEnvelopeFields();
    try {
      return createProtocolMailboxMessage({
        ...options,
        id,
        sender,
        recipient,
        content,
        kind,
        createdAtUtc,
      });
    } catch (error) {
      throw new MailboxStorageError("Protocol mailbox fields failed validation", { cause: error });
    }
  }

  #newEnvelopeFields(): { readonly id: string; readonly createdAtUtc: Date } {
    // 生成器或时钟返回值异常时转换为存储错误，避免无效 UUID 或时间进入持久层。
    let id: string;
    let createdAtUtc: Date;
    try {
      id = canonicalMailboxMessageId(this.#idGenerator());
    } catch (error) {
      throw new MailboxStorageError("Mailbox id generator returned an invalid UUID", {
        cause: error,
      });
    }
    try {
      createdAtUtc = this.#clock();
      if (!(createdAtUtc instanceof Date) || !Number.isFinite(createdAtUtc.valueOf())) {
        throw new Error("invalid clock value");
      }
    } catch (error) {
      throw new MailboxStorageError("Mailbox clock must return a valid UTC Date", { cause: error });
    }
    return Object.freeze({ id, createdAtUtc });
  }

  async #preparePaths(create: boolean): Promise<MailboxPaths | undefined> {
    // 状态路径固定在 workspace/.agent_tutorial/mailboxes 下，创建和读取都验证不能逃逸 workspace。
    try {
      const workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) throw new Error("workspace is not a directory");
      const stateRoot = join(workspace, ".agent_tutorial");
      const root = join(stateRoot, "mailboxes");
      if (create) {
        await mkdir(stateRoot, { recursive: true });
        await validateDirectory(workspace, stateRoot, "Mailbox state root");
        await mkdir(root, { recursive: true });
        await validateDirectory(workspace, root, "Mailbox root");
      } else {
        if (!(await pathExists(stateRoot))) return undefined;
        await validateDirectory(workspace, stateRoot, "Mailbox state root");
        if (!(await pathExists(root))) return undefined;
        await validateDirectory(workspace, root, "Mailbox root");
      }
      const lock = join(stateRoot, ".mailboxes.lock");
      try {
        if ((await lstat(lock)).isSymbolicLink()) {
          throw new MailboxStorageError("Mailbox lock path must not be a symbolic link");
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      return Object.freeze({ workspace, stateRoot, root, lock });
    } catch (error) {
      if (error instanceof MailboxStorageError) throw error;
      throw new MailboxStorageError("Mailbox root is invalid", { cause: error });
    }
  }

  async #withLock<T>(
    create: boolean,
    operation: (paths: MailboxPaths) => Promise<T>,
    whenMissing: () => Promise<T>,
  ): Promise<T> {
    const paths = await this.#preparePaths(create);
    if (paths === undefined) return await whenMissing();
    // 进程内 mutex 加 proper-lockfile 目录锁双重串行化，保证状态迁移是原子读改写。
    return await withProcessMutex(paths.workspace, async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireLock(paths.root, {
          lockfilePath: paths.lock,
          realpath: true,
          stale: LOCK_STALE_MS,
          update: LOCK_UPDATE_MS,
          retries: { retries: 100, minTimeout: 10, maxTimeout: 10 },
        });
        await validateDirectory(paths.workspace, paths.root, "Mailbox root");
        return await operation(paths);
      } catch (error) {
        if (error instanceof MailboxStorageError) throw error;
        throw new MailboxStorageError("Mailbox state operation failed", { cause: error });
      } finally {
        if (release !== undefined) await release();
      }
    });
  }

  async #ensureMailbox(paths: MailboxPaths, recipient: string): Promise<MailboxDirectories> {
    // 每个收件人拥有四个状态目录，缺失时由发送方一次性创建。
    const root = join(paths.root, recipient);
    await mkdir(root, { recursive: true });
    await validateDirectory(paths.workspace, root, `Mailbox ${recipient}`);
    const directories = {} as Record<MailboxState, string>;
    for (const state of Object.values(MailboxState)) {
      const directory = join(root, state);
      await mkdir(directory, { recursive: true });
      await validateDirectory(paths.workspace, directory, `Mailbox ${recipient} ${state}`);
      directories[state] = directory;
    }
    return Object.freeze(directories);
  }

  async #existingMailbox(
    paths: MailboxPaths,
    recipient: string,
  ): Promise<MailboxDirectories | undefined> {
    // 读取既有 mailbox 时要求四个状态目录都完整，缺失不能静默当作空收件箱。
    const root = join(paths.root, recipient);
    if (!(await pathExists(root))) return undefined;
    await validateDirectory(paths.workspace, root, `Mailbox ${recipient}`);
    const directories = {} as Record<MailboxState, string>;
    for (const state of Object.values(MailboxState)) {
      const directory = join(root, state);
      if (!(await pathExists(directory))) {
        throw new MailboxStorageError(`Mailbox ${recipient} is missing ${state}`);
      }
      await validateDirectory(paths.workspace, directory, `Mailbox ${recipient} ${state}`);
      directories[state] = directory;
    }
    return Object.freeze(directories);
  }

  async #validEntries(
    paths: MailboxPaths,
    directories: MailboxDirectories,
    state: MailboxState,
    recipient: string,
  ): Promise<Array<{ readonly message: MailboxItem; readonly path: string }>> {
    const directory = directories[state];
    if (directory === undefined)
      throw new MailboxStorageError("Mailbox state directory is missing");
    // 逐个严格校验文件；坏消息先移入 quarantine，不阻塞同一目录中的合法消息。
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates: Array<{ readonly message: MailboxItem; readonly path: string }> = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const source = join(directory, entry.name);
      try {
        if (entry.isDirectory() || entry.isSymbolicLink() || !entry.isFile()) {
          throw new MailboxStorageError(`Mailbox message is not a regular file: ${entry.name}`);
        }
        const message = await this.#loadMessage(source, recipient);
        candidates.push({ message, path: source });
      } catch (error) {
        await this.#moveInvalid(source, directories);
        if (!(error instanceof MailboxStorageError)) {
          throw new MailboxStorageError("Mailbox message is invalid", { cause: error });
        }
      }
    }
    for (const candidate of candidates) {
      await this.#assertUniqueId(paths, candidate.message.id, candidate.path);
    }
    return candidates;
  }

  async #loadMessage(path: string, recipient: string): Promise<MailboxItem> {
    // 文件名、payload 和 recipient 必须三方一致，任何错配都按存储错误处理。
    const name = path.split(/[\\/]/u).at(-1) ?? "";
    if (!name.endsWith(".json"))
      throw new MailboxStorageError(`Mailbox message extension is invalid: ${name}`);
    let expectedId: string;
    try {
      expectedId = canonicalMailboxMessageId(name.slice(0, -".json".length));
    } catch (error) {
      throw new MailboxStorageError(`Mailbox message filename is invalid: ${name}`, {
        cause: error,
      });
    }
    try {
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new MailboxStorageError(`Mailbox message is not a regular file: ${name}`);
      }
      const raw = UTF8_DECODER.decode(await readFile(path));
      const message = mailboxItemFromJson(JSON.parse(raw));
      if (message.id !== expectedId || message.recipient !== recipient) {
        throw new MailboxStorageError(`Mailbox message path does not match payload: ${name}`);
      }
      return message;
    } catch (error) {
      if (error instanceof MailboxStorageError) throw error;
      throw new MailboxStorageError(`Mailbox message payload is invalid: ${name}`, {
        cause: error,
      });
    }
  }

  async #moveInvalid(source: string, directories: MailboxDirectories): Promise<void> {
    const quarantine = directories[MailboxState.Quarantine];
    if (quarantine === undefined)
      throw new MailboxStorageError("Mailbox quarantine directory is missing");
    const name = source.split(/[\\/]/u).at(-1) ?? "invalid";
    let destination = join(quarantine, name);
    // quarantine 已有同名文件时追加不冲突后缀，保留两份证据。
    for (let index = 1; await pathExists(destination); index += 1) {
      const suffix = name.endsWith(".json") ? ".json" : "";
      const stem = suffix.length === 0 ? name : name.slice(0, -suffix.length);
      destination = join(quarantine, `${stem}.quarantine-${index}${suffix}`);
    }
    await move(source, destination);
  }

  async #pathsForId(paths: MailboxPaths, id: string): Promise<readonly string[]> {
    // 跨 Agent 扫描所有 mailbox 和状态目录，保证同一个 UUID 在整个工作区唯一。
    const result: string[] = [];
    for (const entry of await readdir(paths.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new MailboxStorageError(`Mailbox directory is invalid: ${entry.name}`);
      }
      let recipient: string;
      try {
        recipient = canonicalAgentName(entry.name);
      } catch (error) {
        throw new MailboxStorageError(`Mailbox directory name is invalid: ${entry.name}`, {
          cause: error,
        });
      }
      const directories = await this.#existingMailbox(paths, recipient);
      if (directories === undefined) continue;
      for (const state of Object.values(MailboxState)) {
        const directory = directories[state];
        if (directory === undefined) continue;
        const candidate = join(directory, `${id}.json`);
        if (await pathExists(candidate)) result.push(candidate);
      }
    }
    return result;
  }

  async #assertUniqueId(paths: MailboxPaths, id: string, source: string): Promise<void> {
    // 发现同 ID 已存在于其他状态目录时显式失败，不能覆盖旧消息。
    const collisions = (await this.#pathsForId(paths, id)).filter((path) => path !== source);
    if (collisions.length > 0) {
      throw new MailboxStorageError(`Mailbox message id exists in multiple states: ${id}`);
    }
  }
}

function compareMessages(
  left: { readonly message: MailboxItem },
  right: { readonly message: MailboxItem },
): number {
  // FIFO 顺序由创建时间决定，时间相同再用 UUID 文本稳定打破平局。
  return (
    left.message.createdAtUtc.valueOf() - right.message.createdAtUtc.valueOf() ||
    left.message.id.localeCompare(right.message.id)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function validateDirectory(workspace: string, path: string, label: string): Promise<void> {
  // 状态目录必须是 workspace 内真实目录，防止符号链接或相对路径把状态写到外部。
  const resolved = await realpath(path);
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || !isWithin(workspace, resolved)) {
    throw new MailboxStorageError(`${label} escapes workspace or is not a directory`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !value.includes(":"));
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
  // 先写临时文件、sync、再 rename，读方只能看到完整旧文件或完整新文件。
  const temporary = join(
    path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1),
    `.${path.split(/[\\/]/u).at(-1) ?? "mailbox"}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.write(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    throw new MailboxStorageError("Could not persist mailbox message", { cause: error });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function move(source: string, destination: string): Promise<void> {
  // rename 前显式拒绝已存在目标，避免两个状态目录同时持有同一消息。
  if (await pathExists(destination)) {
    throw new MailboxStorageError(
      `Mailbox destination already exists: ${destination.split(/[\\/]/u).at(-1)}`,
    );
  }
  try {
    await rename(source, destination);
  } catch (error) {
    throw new MailboxStorageError("Could not move mailbox message", { cause: error });
  }
}

function assertMailboxItem(value: MailboxItem): void {
  // 普通与协议消息共用迁移入口，先按类型重新校验，防止伪对象绕过领域约束。
  try {
    if ("requestId" in value) createProtocolMailboxMessage(value);
    else createMailboxMessage(value);
  } catch (error) {
    throw new TypeError("message must be a MailboxItem", { cause: error });
  }
}

async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // 用 Promise 队列把同进程内对同一 workspace 的操作串行化，避免并发操作覆盖内存状态。
  const previous = PROCESS_LOCK_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  PROCESS_LOCK_TAILS.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (PROCESS_LOCK_TAILS.get(key) === tail) PROCESS_LOCK_TAILS.delete(key);
  }
}

function isNodeError(value: unknown, code: string): boolean {
  // 只根据 Node 错误码判断常见 ENOENT，其他异常继续向上传播。
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
