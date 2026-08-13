import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { SqliteTaskStore } from "../src/adapters/task-sqlite.js";
import { JsonTaskStore } from "../src/adapters/task-json.js";
import { TaskGraphError, TaskStatus, TaskStorageError } from "../src/features/tasks.js";
import { TaskClaimError, TaskLeaseExpiredError } from "../src/features/work-stealing.js";

const BASE = new Date("2026-07-27T14:00:00.000Z");
const IDS = [
  "00000000-0000-4000-8000-000000001701",
  "00000000-0000-4000-8000-000000001702",
  "00000000-0000-4000-8000-000000001703",
] as const;
const TOKENS = [
  "00000000-0000-4000-8000-000000001711",
  "00000000-0000-4000-8000-000000001712",
  "00000000-0000-4000-8000-000000001713",
] as const;
const require = createRequire(import.meta.url);

function claimInSpawnedProcess(workspace: string, owner: string): Promise<string | undefined> {
  const tsxCli = join(dirname(require.resolve("tsx")), "cli.mjs");
  const program = fileURLToPath(new URL("./fixtures/ch17-claim-child.ts", import.meta.url));
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [tsxCli, program, workspace, owner], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectResult);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectResult(new Error(`spawned claim process failed (${String(code)}): ${stderr}`));
        return;
      }
      const claim = stdout.trim();
      resolveResult(claim.length === 0 ? undefined : claim);
    });
  });
}

class Clock {
  value = new Date(BASE);
  now(): Date {
    return new Date(this.value);
  }
}

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("sequence exhausted");
    return value;
  };
}

describe("P17 SQLite task store", () => {
  test("uses a separate backend without reading or writing the legacy JSON task graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-"));
    try {
      const legacy = new JsonTaskStore(root, { idGenerator: () => IDS[2] });
      const legacyTask = await legacy.createTask({ subject: "legacy JSON" });
      const store = new SqliteTaskStore(root, { idGenerator: sequence(IDS) });
      const first = await store.createTask({ subject: "SQLite A" });
      const second = await store.createTask({ subject: "SQLite B" });
      expect((await store.listTasks()).map((task) => task.id)).toEqual([first.id, second.id]);
      expect((await legacy.listTasks()).map((task) => task.id)).toEqual([legacyTask.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a missing dependency without inserting a partial task", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-"));
    try {
      const store = new SqliteTaskStore(root, { idGenerator: sequence(IDS) });
      await expect(
        store.createTask({ subject: "blocked", blockedBy: [IDS[1]] }),
      ).rejects.toBeInstanceOf(TaskGraphError);
      expect(await store.listTasks()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves creation order, dependency gating, and claim history", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-"));
    try {
      const store = new SqliteTaskStore(root, {
        idGenerator: sequence(IDS),
        claimTokenGenerator: sequence(TOKENS),
        clock: new Clock(),
      });
      const first = await store.createTask({ subject: "A" });
      const second = await store.createTask({ subject: "B" });
      const dependent = await store.createTask({
        subject: "C",
        blockedBy: [first.id, second.id],
      });
      expect((await store.listTasks()).map((task) => task.id)).toEqual(IDS);
      const alice = await store.claimNext("alice");
      const bob = await store.claimNext("bob");
      expect(alice?.task.id).toBe(first.id);
      expect(bob?.task.id).toBe(second.id);
      expect(await store.claimNext("charlie")).toBeUndefined();
      if (alice === undefined || bob === undefined) throw new Error("expected two claims");
      await store.completeTask(first.id, "alice", alice.claimToken);
      const completion = await store.completeTask(second.id, "bob", bob.claimToken);
      expect(completion.unblocked.map((task) => task.id)).toEqual([dependent.id]);
      const last = await store.claimNext("charlie");
      expect(last?.task.id).toBe(dependent.id);
      expect((await store.getTask(dependent.id)).status).toBe(TaskStatus.IN_PROGRESS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expires at the half-open boundary and rejects old completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-"));
    try {
      const clock = new Clock();
      const id = IDS[0];
      if (id === undefined) throw new Error("first task ID is missing");
      const store = new SqliteTaskStore(root, {
        idGenerator: sequence([id]),
        claimTokenGenerator: sequence(TOKENS),
        clock,
        leaseDurationMs: 30_000,
      });
      const task = await store.createTask({ subject: "leased" });
      const first = await store.claimNext("alice");
      if (first === undefined) throw new Error("first claim missing");
      clock.value = new Date(BASE.getTime() + 30_000);
      await expect(store.completeTask(task.id, "alice", first.claimToken)).rejects.toBeInstanceOf(
        TaskLeaseExpiredError,
      );
      const replacement = await store.claimNext("bob");
      expect(replacement?.claimToken).toBe(TOKENS[1]);
      await expect(store.completeTask(task.id, "alice", first.claimToken)).rejects.toBeInstanceOf(
        TaskClaimError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rolls back a repeated claim token without claiming the second task", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-"));
    try {
      const store = new SqliteTaskStore(root, {
        idGenerator: sequence(IDS),
        claimTokenGenerator: sequence([TOKENS[0], TOKENS[0]]),
      });
      const first = await store.createTask({ subject: "first" });
      const second = await store.createTask({ subject: "second" });
      await store.claimTask(first.id, "alice");
      await expect(store.claimTask(second.id, "bob")).rejects.toBeInstanceOf(TaskStorageError);
      expect(await store.getTask(second.id)).toEqual(second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not reuse an expired claim token for the same owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-"));
    try {
      const id = IDS[0];
      const token = TOKENS[0];
      if (id === undefined || token === undefined) throw new Error("test IDs are missing");
      const clock = new Clock();
      const store = new SqliteTaskStore(root, {
        idGenerator: sequence([id]),
        claimTokenGenerator: sequence([token, token]),
        clock,
        leaseDurationMs: 30_000,
      });
      const task = await store.createTask({ subject: "leased" });
      await store.claimNext("alice");
      clock.value = new Date(BASE.getTime() + 30_000);
      await expect(store.claimNext("alice")).rejects.toBeInstanceOf(TaskStorageError);
      expect(await store.getTask(task.id)).toMatchObject({
        status: TaskStatus.PENDING,
        owner: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows exactly one spawned process to claim one ready task", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-process-"));
    try {
      const task = await new SqliteTaskStore(root).createTask({ subject: "race" });
      const results = await Promise.all([
        claimInSpawnedProcess(root, "alice"),
        claimInSpawnedProcess(root, "bob"),
      ]);
      expect(results.filter((result) => result === task.id)).toHaveLength(1);
      expect(results.filter((result) => result === undefined)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("rejects a database hardlink before changing the outside file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-sqlite-outside-"));
    try {
      const stateRoot = join(root, ".agent_tutorial");
      const outside = join(outsideRoot, "outside.sqlite3");
      await mkdir(stateRoot, { recursive: true });
      await writeFile(outside, Buffer.from("outside-bytes"));
      await link(outside, join(stateRoot, "tasks.sqlite3"));
      const before = await readFile(outside);
      await expect(new SqliteTaskStore(root).listTasks()).rejects.toBeInstanceOf(TaskStorageError);
      expect(await readFile(outside)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
