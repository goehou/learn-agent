import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ToolRegistry } from "../src/core/tools.js";
import { toolCall } from "../src/core/messages.js";
import { JsonTaskStore } from "../src/adapters/task-json.js";
import {
  TaskBlockedError,
  TaskGraphError,
  TaskNotFoundError,
  TaskOwnershipError,
  TaskStateError,
  TaskStorageError,
  registerTaskTools,
} from "../src/features/tasks.js";

const workspaces: string[] = [];
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-tutorial-ch12-"));
  workspaces.push(path);
  return path;
}

function ids(values: readonly string[] = IDS): () => string {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (value === undefined) {
      throw new Error("test id generator exhausted");
    }
    return value;
  };
}

async function writeRawTask(
  root: string,
  id: string,
  updates: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const taskRoot = join(root, ".agent_tutorial", ".tasks");
  await mkdir(taskRoot, { recursive: true });
  await writeFile(
    join(taskRoot, `${id}.json`),
    `${JSON.stringify({
      blocked_by: [],
      description: "",
      id,
      owner: null,
      status: "pending",
      subject: "persisted",
      ...updates,
    })}\n`,
    "utf8",
  );
}

describe("chapter 12 JSON Task DAG", () => {
  test("does not create task state for empty reads or missing task mutations", async () => {
    const root = await workspace();
    const store = new JsonTaskStore(root);

    expect(await store.listTasks()).toEqual([]);
    await expect(store.getTask(IDS[0] as string)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(store.claimTask(IDS[0] as string, "worker")).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(store.completeTask(IDS[0] as string, "worker")).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect(
      await lstat(join(root, ".agent_tutorial")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("rejects missing and self dependencies before writing a file", async () => {
    const root = await workspace();
    await expect(
      new JsonTaskStore(root, { idGenerator: ids([IDS[0] as string]) }).createTask({
        subject: "missing",
        blockedBy: [IDS[1] as string],
      }),
    ).rejects.toBeInstanceOf(TaskGraphError);
    await expect(
      new JsonTaskStore(root, { idGenerator: ids([IDS[0] as string]) }).createTask({
        subject: "self",
        blockedBy: [IDS[0] as string],
      }),
    ).rejects.toThrow(/itself/);
    expect(await new JsonTaskStore(root).listTasks()).toEqual([]);
  });

  test("fails closed on corrupt or invalid persisted JSON", async () => {
    const root = await workspace();
    const path = join(root, ".agent_tutorial", ".tasks", `${IDS[0]}.json`);
    await mkdir(join(root, ".agent_tutorial", ".tasks"), { recursive: true });
    await writeFile(path, "{not-json", "utf8");
    await expect(new JsonTaskStore(root).listTasks()).rejects.toThrow(new RegExp(IDS[0] as string));

    await writeRawTask(root, IDS[0] as string);
    await writeRawTask(root, IDS[1] as string, { status: "unknown" });
    await expect(new JsonTaskStore(root).listTasks()).rejects.toThrow(new RegExp(IDS[1] as string));
  });

  test("rejects a persisted dependency cycle", async () => {
    const root = await workspace();
    await writeRawTask(root, IDS[0] as string, { blocked_by: [IDS[1] as string] });
    await writeRawTask(root, IDS[1] as string, { blocked_by: [IDS[0] as string] });

    await expect(new JsonTaskStore(root).listTasks()).rejects.toThrow(/cycle/);
  });

  test("never overwrites a generated ID collision or a failed atomic update", async () => {
    const root = await workspace();
    const first = new JsonTaskStore(root, { idGenerator: ids([IDS[0] as string]) });
    const task = await first.createTask({ subject: "keep", description: "original" });
    const taskPath = join(root, ".agent_tutorial", ".tasks", `${task.id}.json`);
    const before = await readFile(taskPath);

    await expect(
      new JsonTaskStore(root, { idGenerator: ids([IDS[0] as string]) }).createTask({
        subject: "replace",
      }),
    ).rejects.toThrow(/already exists/);

    const failing = new JsonTaskStore(root, {
      atomicReplace: async () => {
        throw new Error("disk failed");
      },
    });
    await expect(failing.claimTask(task.id, "worker")).rejects.toThrow(TaskStorageError);
    expect(await readFile(taskPath)).toEqual(before);
  });

  test("rejects a .agent_tutorial junction that escapes the workspace", async () => {
    const root = await workspace();
    const outside = await workspace();
    await symlink(outside, join(root, ".agent_tutorial"), "junction");

    await expect(
      new JsonTaskStore(root, { idGenerator: ids([IDS[0] as string]) }).createTask({
        subject: "escape",
      }),
    ).rejects.toThrow(/escapes workspace/);
    expect(
      await readFile(join(root, ".agent_tutorial", ".tasks", `${IDS[0]}.json`)).catch(
        () => undefined,
      ),
    ).toBeUndefined();
  });

  test("preserves state on invalid transitions and enforces the claim owner", async () => {
    const root = await workspace();
    const store = new JsonTaskStore(root, { idGenerator: ids([IDS[0] as string]) });
    const pending = await store.createTask({ subject: "stateful" });
    await expect(store.completeTask(pending.id, "worker")).rejects.toBeInstanceOf(TaskStateError);
    const claimed = await store.claimTask(pending.id, "worker-a");
    await expect(store.claimTask(pending.id, "worker-b")).rejects.toBeInstanceOf(TaskStateError);
    await expect(store.completeTask(pending.id, "worker-b")).rejects.toBeInstanceOf(
      TaskOwnershipError,
    );
    expect(await store.getTask(pending.id)).toEqual(claimed);
  });

  test("rebuilds the graph and reports only direct newly unblocked tasks", async () => {
    const root = await workspace();
    const store = new JsonTaskStore(root, { idGenerator: ids() });
    const schema = await store.createTask({ subject: "schema" });
    const endpoints = await store.createTask({
      subject: "endpoints",
      description: "create API endpoints",
      blockedBy: [schema.id],
    });
    const tests = await store.createTask({
      subject: "tests",
      blockedBy: [endpoints.id, schema.id],
    });
    const docs = await store.createTask({ subject: "docs", blockedBy: [schema.id] });

    const endpointsPath = join(root, ".agent_tutorial", ".tasks", `${endpoints.id}.json`);
    const blockedBytes = await readFile(endpointsPath);
    await expect(store.claimTask(endpoints.id, "worker")).rejects.toBeInstanceOf(TaskBlockedError);
    expect(await readFile(endpointsPath)).toEqual(blockedBytes);
    await store.claimTask(schema.id, "worker");
    const completion = await store.completeTask(schema.id, "worker");

    expect(completion.unblocked.map((task) => task.id)).toEqual([docs.id, endpoints.id].sort());
    expect(completion.unblocked.map((task) => task.id)).not.toContain(tests.id);
    expect((await store.getTask(endpoints.id)).status).toBe("pending");
    expect((await store.getTask(tests.id)).status).toBe("pending");

    const rebuilt = new JsonTaskStore(root);
    expect(await rebuilt.listTasks()).toEqual(await store.listTasks());
  });

  test("allows exactly one concurrent claim winner and enforces owner completion", async () => {
    const root = await workspace();
    const first = new JsonTaskStore(root, { idGenerator: ids([IDS[0] as string]) });
    const second = new JsonTaskStore(root, { idGenerator: ids([IDS[1] as string]) });
    const task = await first.createTask({ subject: "single claim" });

    const outcomes = await Promise.allSettled([
      first.claimTask(task.id, "worker-a"),
      second.claimTask(task.id, "worker-b"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      TaskStateError,
    );
    const winner = (await first.getTask(task.id)).owner;
    if (winner === null) {
      throw new Error("claim winner was not persisted");
    }
    const nonOwner = winner === "worker-a" ? "worker-b" : "worker-a";
    await expect(first.completeTask(task.id, nonOwner)).rejects.toThrow(winner);
    await first.completeTask(task.id, winner);
    expect((await second.getTask(task.id)).status).toBe("completed");
  });

  test("registers exactly five strict tools and keeps task errors typed", async () => {
    const root = await workspace();
    const store = new JsonTaskStore(root, { idGenerator: ids() });
    const registry = new ToolRegistry();
    registerTaskTools(registry, store);

    expect(registry.names).toEqual([
      "create_task",
      "get_task",
      "list_tasks",
      "claim_task",
      "complete_task",
    ]);
    const invalid = registry.prepare(
      toolCall("call-1", "create_task", JSON.stringify({ subject: "x", owner: "spoof" })),
    );
    expect(invalid.error?.errorCode).toBe("invalid_arguments");

    const created = await registry.invoke(
      registry.prepare(toolCall("call-2", "create_task", JSON.stringify({ subject: "x" }))),
      { workspace: root, identity: "agent" },
    );
    expect(created.isError).toBe(false);
    const files = await readFile(join(root, ".agent_tutorial", ".tasks", `${IDS[0]}.json`), "utf8");
    expect(files.endsWith("\n")).toBe(true);
  });

  test("executes the persistent owner-checked tool workflow", async () => {
    const root = await workspace();
    const store = new JsonTaskStore(root, { idGenerator: ids() });
    const registry = new ToolRegistry();
    registerTaskTools(registry, store);
    let nextCall = 0;
    const invoke = async (
      name: string,
      argumentsValue: Readonly<Record<string, unknown>>,
      identity: string,
    ) => {
      nextCall += 1;
      const prepared = registry.prepare(
        toolCall(`call-${nextCall}`, name, JSON.stringify(argumentsValue)),
      );
      return await registry.invoke(prepared, { workspace: root, identity });
    };

    const createdSchema = await invoke(
      "create_task",
      { subject: "schema", description: "create schema", blocked_by: [] },
      "planner",
    );
    const createdEndpoint = await invoke(
      "create_task",
      { subject: "endpoint", description: "create endpoint", blocked_by: [IDS[0] as string] },
      "planner",
    );
    const listed = await invoke("list_tasks", {}, "reader");
    const blocked = await invoke("claim_task", { task_id: IDS[1] as string }, "worker-b");
    const claimed = await invoke("claim_task", { task_id: IDS[0] as string }, "worker-a");
    const wrongOwner = await invoke("complete_task", { task_id: IDS[0] as string }, "worker-b");
    const completed = await invoke("complete_task", { task_id: IDS[0] as string }, "worker-a");
    const fetched = await invoke("get_task", { task_id: IDS[1] as string }, "reader");

    expect(JSON.parse(createdSchema.content)).toEqual({
      blocked_by: [],
      description: "create schema",
      id: IDS[0],
      owner: null,
      status: "pending",
      subject: "schema",
    });
    expect(JSON.parse(createdEndpoint.content).blocked_by).toEqual([IDS[0]]);
    expect(JSON.parse(listed.content).tasks.map((task: { id: string }) => task.id)).toEqual([
      IDS[0],
      IDS[1],
    ]);
    expect(blocked.errorCode).toBe("task_blocked");
    expect(JSON.parse(claimed.content).owner).toBe("worker-a");
    expect(wrongOwner.errorCode).toBe("task_owner_mismatch");
    expect(JSON.parse(completed.content).unblocked.map((task: { id: string }) => task.id)).toEqual([
      IDS[1],
    ]);
    expect(JSON.parse(fetched.content).status).toBe("pending");
  });
});
