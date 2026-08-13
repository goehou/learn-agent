import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { SubprocessGitRunner } from "../src/adapters/git.js";
import { SqliteTaskStore } from "../src/adapters/task-sqlite.js";
import type { ToolContext } from "../src/core/tools.js";
import { TaskStatus, TaskStorageError } from "../src/features/tasks.js";
import {
  GitExecutionError,
  type GitCommandResult,
  type GitRunner,
  WorktreeAction,
  WorktreeGitError,
  WorktreeRepositoryError,
  WorktreeRuntime,
  WorktreeStatus,
} from "../src/features/worktrees.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const TASK_IDS = ["00000000-0000-4000-8000-000000001801", "00000000-0000-4000-8000-000000001802"];
const TOKEN_IDS = ["00000000-0000-4000-8000-000000001851", "00000000-0000-4000-8000-000000001852"];
const BASE = new Date("2026-07-27T18:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

class SequenceValues {
  readonly #values: string[];

  constructor(values: readonly string[]) {
    this.#values = [...values];
  }

  next = (): string => {
    const value = this.#values.shift();
    if (value === undefined) throw new Error("test sequence exhausted");
    return value;
  };
}

class RecordingGitRunner implements GitRunner {
  readonly calls: Array<{ readonly argumentsValue: readonly string[]; readonly cwd: string }> = [];
  readonly delegate: GitRunner;

  constructor(delegate: GitRunner) {
    this.delegate = delegate;
  }

  protected record(argumentsValue: readonly string[], cwd: string): void {
    this.calls.push({ argumentsValue: Object.freeze([...argumentsValue]), cwd });
  }

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.record(argumentsValue, cwd);
    return await this.delegate.run(argumentsValue, cwd);
  }
}

class FailingAddGitRunner extends RecordingGitRunner {
  override async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.record(argumentsValue, cwd);
    if (argumentsValue[0] === "worktree" && argumentsValue[1] === "add") {
      return Object.freeze({ returncode: 128, stdout: "", stderr: "injected add failure" });
    }
    return await this.delegate.run(argumentsValue, cwd);
  }
}

class FailingStatusGitRunner extends RecordingGitRunner {
  override async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.record(argumentsValue, cwd);
    if (argumentsValue[0] === "status" && argumentsValue[1] === "--porcelain=v1") {
      return Object.freeze({ returncode: 128, stdout: "", stderr: "injected status failure" });
    }
    return await this.delegate.run(argumentsValue, cwd);
  }
}

class RaisingStatusGitRunner extends RecordingGitRunner {
  override async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.record(argumentsValue, cwd);
    if (argumentsValue[0] === "status" && argumentsValue[1] === "--porcelain=v1") {
      throw new GitExecutionError("injected process failure");
    }
    return await this.delegate.run(argumentsValue, cwd);
  }
}

class WrongWorktreeRootGitRunner extends RecordingGitRunner {
  readonly repositoryRoot: string;

  constructor(delegate: GitRunner, repositoryRoot: string) {
    super(delegate);
    this.repositoryRoot = repositoryRoot;
  }

  override async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.record(argumentsValue, cwd);
    if (
      argumentsValue.length === 2 &&
      argumentsValue[0] === "rev-parse" &&
      argumentsValue[1] === "--show-toplevel" &&
      cwd !== this.repositoryRoot
    ) {
      return Object.freeze({ returncode: 0, stdout: `${this.repositoryRoot}\n`, stderr: "" });
    }
    return await this.delegate.run(argumentsValue, cwd);
  }
}

async function git(cwd: string, ...argumentsValue: string[]): Promise<void> {
  await execFileAsync("git", argumentsValue, { cwd, encoding: "utf8", windowsHide: true });
}

async function repository(): Promise<string> {
  const actual = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-"));
  roots.push(actual);
  await git(actual, "init", "-b", "main");
  await git(actual, "config", "user.name", "Agent Tutorial Tests");
  await git(actual, "config", "user.email", "agent-tutorial@example.test");
  await writeFile(join(actual, ".gitignore"), ".agent_tutorial/\n", "utf8");
  await writeFile(join(actual, "shared.txt"), "base\n", "utf8");
  await git(actual, "add", ".gitignore", "shared.txt");
  await git(actual, "commit", "-m", "initial");
  return actual;
}

async function components(gitRunner: GitRunner = new SubprocessGitRunner()): Promise<{
  readonly root: string;
  readonly store: SqliteTaskStore;
  readonly runtime: WorktreeRuntime;
}> {
  const root = await repository();
  const ids = new SequenceValues(TASK_IDS);
  const tokens = new SequenceValues(TOKEN_IDS);
  const store = new SqliteTaskStore(root, {
    idGenerator: ids.next,
    claimTokenGenerator: tokens.next,
    clock: { now: () => new Date(BASE) },
  });
  const runtime = new WorktreeRuntime({
    workspace: root,
    store,
    gitRunner,
    clock: () => new Date(BASE),
  });
  await runtime.validateRepository();
  return { root, store, runtime };
}

async function mutateDatabase(root: string, statement: string): Promise<void> {
  const databasePath = join(root, ".agent_tutorial", "tasks.sqlite3");
  const SQL = await initSqlJs({
    locateFile: (name) =>
      join(fileURLToPath(new URL("../node_modules/sql.js/dist/", import.meta.url)), name),
  });
  const database = new SQL.Database(await readFile(databasePath));
  try {
    database.run(statement);
    await writeFile(databasePath, database.export());
  } finally {
    database.close();
  }
}

async function complete(runtime: WorktreeRuntime, taskId: string, owner: string): Promise<void> {
  const context: ToolContext = Object.freeze({
    workspace: runtime.workspaceRoot,
    identity: owner,
    executionScope: Object.freeze({}),
  });
  const claim = await runtime.claimTask(taskId, context);
  await runtime.completeTask(taskId, claim.claimToken, context);
}

describe("chapter 18 worktrees", () => {
  test("reserves, activates, and rebuilds binding audit while task remains pending", async () => {
    const { root, store, runtime } = await components();
    const task = await store.createTask({ subject: "isolated", description: "" });

    const binding = await runtime.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });

    expect((await store.getTask(task.id)).status).toBe(TaskStatus.PENDING);
    expect(binding.status).toBe(WorktreeStatus.ACTIVE);
    expect(binding.relativePath).toBe(".agent_tutorial/worktrees/alice");
    expect((await store.listWorktreeEvents()).map((event) => event.action)).toEqual([
      WorktreeAction.RESERVE,
      WorktreeAction.CREATE,
    ]);
    expect(await new SqliteTaskStore(root).getWorktreeBinding(task.id)).toMatchObject({
      taskId: task.id,
      status: WorktreeStatus.ACTIVE,
    });
  });

  test("keeps dirty worktree for review and only removes an integrated clean worktree", async () => {
    const { root, store, runtime } = await components();
    const dirtyTask = await store.createTask({ subject: "dirty", description: "" });
    const dirty = await runtime.createWorktree({
      taskId: dirtyTask.id,
      name: "dirty",
      integrationRef: "refs/heads/main",
    });
    await complete(runtime, dirtyTask.id, "alice");
    const dirtyPath = join(root, dirty.relativePath);
    await writeFile(join(dirtyPath, "uncommitted.txt"), "keep me\n", "utf8");
    await expect(runtime.removeWorktree(dirtyTask.id)).resolves.toMatchObject({
      status: WorktreeStatus.NEEDS_REVIEW,
      reviewReason: expect.stringContaining("uncommitted"),
    });
    await expect(readFile(join(dirtyPath, "uncommitted.txt"), "utf8")).resolves.toContain(
      "keep me",
    );

    const integratedTask = await store.createTask({ subject: "integrated", description: "" });
    const integrated = await runtime.createWorktree({
      taskId: integratedTask.id,
      name: "integrated",
      integrationRef: "refs/heads/main",
    });
    await complete(runtime, integratedTask.id, "bob");
    const integratedPath = join(root, integrated.relativePath);
    await writeFile(join(integratedPath, "shared.txt"), "integrated\n", "utf8");
    await git(integratedPath, "add", "shared.txt");
    await git(integratedPath, "commit", "-m", "integrated");
    await git(root, "merge", "--ff-only", "wt/integrated");

    await expect(runtime.removeWorktree(integratedTask.id)).resolves.toMatchObject({
      status: WorktreeStatus.REMOVED,
    });
    await expect(readFile(join(integratedPath, "shared.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15_000);

  test("isolates same-named files across two active worktrees", async () => {
    const { root, store, runtime } = await components();
    const first = await store.createTask({ subject: "first", description: "" });
    const second = await store.createTask({ subject: "second", description: "" });
    const alice = await runtime.createWorktree({
      taskId: first.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const bob = await runtime.createWorktree({
      taskId: second.id,
      name: "bob",
      integrationRef: "refs/heads/main",
    });
    await writeFile(join(root, alice.relativePath, "same.txt"), "alice", "utf8");
    await writeFile(join(root, bob.relativePath, "same.txt"), "bob", "utf8");

    await expect(readFile(join(root, alice.relativePath, "same.txt"), "utf8")).resolves.toBe(
      "alice",
    );
    await expect(readFile(join(root, bob.relativePath, "same.txt"), "utf8")).resolves.toBe("bob");
    await expect(readFile(join(root, "same.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("keeps a reservation and pending task when Git worktree creation fails", async () => {
    const gitRunner = new FailingAddGitRunner(new SubprocessGitRunner());
    const { store, runtime } = await components(gitRunner);
    const task = await store.createTask({ subject: "create failure", description: "" });

    await expect(
      runtime.createWorktree({
        taskId: task.id,
        name: "reserved",
        integrationRef: "refs/heads/main",
      }),
    ).rejects.toBeInstanceOf(WorktreeGitError);
    await expect(store.getTask(task.id)).resolves.toMatchObject({ status: TaskStatus.PENDING });
    await expect(store.getWorktreeBinding(task.id)).resolves.toMatchObject({
      status: WorktreeStatus.RESERVED,
    });
    expect((await store.listWorktreeEvents()).map((event) => event.action)).toEqual([
      WorktreeAction.RESERVE,
    ]);
  });

  test("keeps an unmerged branch and marks it for review", async () => {
    const { root, store, runtime } = await components();
    const task = await store.createTask({ subject: "unmerged", description: "" });
    const active = await runtime.createWorktree({
      taskId: task.id,
      name: "unmerged",
      integrationRef: "refs/heads/main",
    });
    await complete(runtime, task.id, "alice");
    const path = join(root, active.relativePath);
    await writeFile(join(path, "branch-only.txt"), "branch only\n", "utf8");
    await git(path, "add", "branch-only.txt");
    await git(path, "commit", "-m", "branch only");

    await expect(runtime.removeWorktree(task.id)).resolves.toMatchObject({
      status: WorktreeStatus.NEEDS_REVIEW,
      reviewReason: expect.stringContaining("integration ref"),
    });
    await expect(readFile(join(path, "branch-only.txt"), "utf8")).resolves.toContain("branch only");
  });

  test("rolls back a binding transition when audit insertion fails", async () => {
    const { root, store, runtime } = await components();
    const task = await store.createTask({ subject: "audit rollback", description: "" });
    const active = await runtime.createWorktree({
      taskId: task.id,
      name: "rollback",
      integrationRef: "refs/heads/main",
    });
    await complete(runtime, task.id, "alice");
    await mutateDatabase(
      root,
      "CREATE TRIGGER fail_keep_audit BEFORE INSERT ON worktree_events WHEN NEW.action = 'keep' BEGIN SELECT RAISE(FAIL, 'injected audit failure'); END",
    );

    await expect(runtime.keepWorktree(task.id)).rejects.toBeInstanceOf(TaskStorageError);
    await expect(store.getWorktreeBinding(task.id)).resolves.toMatchObject({
      status: WorktreeStatus.ACTIVE,
    });
    await expect(readFile(join(root, active.relativePath, ".git"), "utf8")).resolves.toContain(
      "gitdir",
    );
    expect((await store.listWorktreeEvents()).map((event) => event.action)).toEqual([
      WorktreeAction.RESERVE,
      WorktreeAction.CREATE,
    ]);
  });

  for (const statement of [
    "UPDATE worktree_events SET action = 'remove' WHERE sequence = 1",
    "DELETE FROM worktree_events WHERE sequence = 1",
  ]) {
    test(`keeps worktree audit append-only for ${statement.split(" ")[0]}`, async () => {
      const { root, store, runtime } = await components();
      const task = await store.createTask({ subject: "append only", description: "" });
      await runtime.createWorktree({
        taskId: task.id,
        name: "audit",
        integrationRef: "refs/heads/main",
      });

      await expect(mutateDatabase(root, statement)).rejects.toThrow(/append-only/);
      expect((await store.listWorktreeEvents()).map((event) => event.action)).toEqual([
        WorktreeAction.RESERVE,
        WorktreeAction.CREATE,
      ]);
    });
  }

  test("turns Git status failures and process errors into needs_review without stderr", async () => {
    for (const runner of [
      new FailingStatusGitRunner(new SubprocessGitRunner()),
      new RaisingStatusGitRunner(new SubprocessGitRunner()),
    ]) {
      const { root, store, runtime } = await components(runner);
      const task = await store.createTask({ subject: "git failure", description: "" });
      const active = await runtime.createWorktree({
        taskId: task.id,
        name: runner instanceof FailingStatusGitRunner ? "nonzero" : "process",
        integrationRef: "refs/heads/main",
      });
      await complete(runtime, task.id, "alice");

      const reviewed = await runtime.removeWorktree(task.id);
      expect(reviewed.status).toBe(WorktreeStatus.NEEDS_REVIEW);
      expect(reviewed.reviewReason).toContain("git status");
      expect(reviewed.reviewReason).not.toContain("injected");
      expect((await stat(join(root, active.relativePath))).isDirectory()).toBe(true);
    }
  });

  test("marks a mismatched registered worktree root for review", async () => {
    const { root, store } = await components();
    const runtime = new WorktreeRuntime({
      workspace: root,
      store,
      gitRunner: new WrongWorktreeRootGitRunner(new SubprocessGitRunner(), root),
      clock: () => new Date(BASE),
    });
    await runtime.validateRepository();
    const task = await store.createTask({ subject: "wrong root", description: "" });
    const active = await runtime.createWorktree({
      taskId: task.id,
      name: "wrongroot",
      integrationRef: "refs/heads/main",
    });
    await complete(runtime, task.id, "alice");

    await expect(runtime.removeWorktree(task.id)).resolves.toMatchObject({
      status: WorktreeStatus.NEEDS_REVIEW,
      reviewReason: expect.stringContaining("registered worktree"),
    });
    expect((await stat(join(root, active.relativePath))).isDirectory()).toBe(true);
  });

  test("rejects a non-Git workspace before creating runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-non-git-"));
    roots.push(root);
    const store = new SqliteTaskStore(root, {
      idGenerator: () => "00000000-0000-4000-8000-000000001801",
      claimTokenGenerator: () => "00000000-0000-4000-8000-000000001851",
      clock: { now: () => new Date(BASE) },
    });
    const runtime = new WorktreeRuntime({
      workspace: root,
      store,
      gitRunner: new SubprocessGitRunner(),
    });

    await expect(runtime.validateRepository()).rejects.toBeInstanceOf(WorktreeRepositoryError);
    await expect(readFile(join(root, ".agent_tutorial"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("marks an active binding for review when its managed path disappears", async () => {
    const { root, store, runtime } = await components();
    const task = await store.createTask({ subject: "missing path", description: "" });
    const binding = await runtime.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    await complete(runtime, task.id, "alice");
    await rm(join(root, binding.relativePath), { recursive: true, force: true });

    await expect(runtime.removeWorktree(task.id)).resolves.toMatchObject({
      status: WorktreeStatus.NEEDS_REVIEW,
      reviewReason: expect.stringContaining("unavailable"),
    });
    await expect(store.getWorktreeBinding(task.id)).resolves.toMatchObject({
      status: WorktreeStatus.NEEDS_REVIEW,
    });
  });

  test("preserves a kept binding when its managed path disappears", async () => {
    const { root, store, runtime } = await components();
    const task = await store.createTask({ subject: "missing kept path", description: "" });
    const binding = await runtime.createWorktree({
      taskId: task.id,
      name: "kept",
      integrationRef: "refs/heads/main",
    });
    await complete(runtime, task.id, "alice");
    await runtime.keepWorktree(task.id);
    await rm(join(root, binding.relativePath), { recursive: true, force: true });

    await expect(runtime.removeWorktree(task.id)).resolves.toMatchObject({
      status: WorktreeStatus.KEPT,
    });
    await expect(store.getWorktreeBinding(task.id)).resolves.toMatchObject({
      status: WorktreeStatus.KEPT,
    });
  });
});
