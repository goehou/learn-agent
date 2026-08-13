import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { SubprocessGitRunner } from "../src/adapters/git.js";
import { SqliteTaskStore } from "../src/adapters/task-sqlite.js";
import { buildAgent } from "../src/bootstrap.js";
import { EventInbox } from "../src/core/events.js";
import { assistantMessage, toolCall } from "../src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P18 } from "../src/core/profiles.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { JsonProtocolStore } from "../src/adapters/protocol-json.js";
import { ProtocolRuntime } from "../src/features/protocol.js";
import { createProtocolMailboxMessage, ProtocolMessageKind } from "../src/features/mailbox.js";
import { ProtocolRequestKind } from "../src/features/protocol.js";
import { RecoveryConfig } from "../src/features/recovery.js";
import { TeammateRuntime } from "../src/features/teammates.js";
import { type WorkStealingSleeper, WorkStealingRuntime } from "../src/features/work-stealing.js";
import { WorktreeRuntime } from "../src/features/worktrees.js";
import { ScriptedModelClient } from "./fakes.js";

const execFileAsync = promisify(execFile);
const AUTO_TASK = "00000000-0000-4000-8000-000000002101";
const AUTO_TOKEN = "00000000-0000-4000-8000-000000002151";
const LEAD_TASK = "00000000-0000-4000-8000-000000002201";
const LEAD_TOKEN = "00000000-0000-4000-8000-000000002251";
const WORKTREE_LIFECYCLE_TOOLS = ["create_worktree", "keep_worktree", "remove_worktree"];

function expectNoWorktreeLifecycleTools(request: ModelRequest): void {
  const names = request.tools.map((tool) => tool.function.name);
  for (const name of WORKTREE_LIFECYCLE_TOOLS) {
    expect(names).not.toContain(name);
  }
}

class ImmediateSleeper implements WorkStealingSleeper {
  async sleep(_seconds: number, _wakeup: AbortSignal): Promise<void> {}
}

class AutoWorktreeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content.startsWith("<auto-claimed-task>")) {
      const payloadLine = last.content.split("\n")[1];
      if (payloadLine === undefined) throw new Error("auto-claim prompt is incomplete");
      const payload = JSON.parse(payloadLine) as {
        readonly task?: { readonly id?: string };
        readonly claim_token?: string;
      };
      if (payload.task?.id !== AUTO_TASK || payload.claim_token !== AUTO_TOKEN) {
        throw new Error("unexpected auto-claim payload");
      }
      return {
        message: assistantMessage(null, [
          toolCall("auto-write", "write_file", '{"path":"auto.txt","content":"isolated"}'),
        ]),
        finishReason: "tool_calls",
      };
    }
    if (last?.role === "tool")
      return { message: assistantMessage("auto done"), finishReason: "stop" };
    return { message: assistantMessage("idle"), finishReason: "stop" };
  }
}

async function git(cwd: string, ...argumentsValue: string[]): Promise<void> {
  await execFileAsync("git", argumentsValue, { cwd, encoding: "utf8", windowsHide: true });
}

async function gitRepository(root: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Agent Tutorial Tests");
  await git(root, "config", "user.email", "agent-tutorial@example.test");
  await writeFile(join(root, ".gitignore"), ".agent_tutorial/\n", "utf8");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "initial");
}

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test", "test");
  }
}

class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 18 bootstrap", () => {
  test("requires WorktreeRuntime as the shared work-stealing claim service", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-bootstrap-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const store = new SqliteTaskStore(root);
    const worktrees = new WorktreeRuntime({
      workspace: root,
      store,
      gitRunner: new SubprocessGitRunner(),
    });
    const workStealing = new WorkStealingRuntime({ store, claimService: worktrees });
    const common = {
      workspace: root,
      recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
      backgroundSupervisor: supervisor,
      cronRuntime: cron,
      teammateRuntime: teammates,
      protocolRuntime: protocol,
      workStealingRuntime: workStealing,
      worktreeRuntime: worktrees,
      approvalProvider: new AllowApproval(),
      auditSink: new NoopAudit(),
    } as const;
    try {
      const { worktreeRuntime: _worktreeRuntime, ...withoutWorktrees } = common;
      expect(() =>
        buildAgent(P18, { ...withoutWorktrees, model: new ScriptedModelClient([]) }),
      ).toThrow(/worktreeRuntime/);
      const wrongService = new WorkStealingRuntime({ store });
      expect(() =>
        buildAgent(P18, {
          ...common,
          model: new ScriptedModelClient([]),
          workStealingRuntime: wrongService,
        }),
      ).toThrow(/claim service/);
      const model = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P18, { ...common, model });
      await runner.run("inspect");
      const names = model.requests[0]?.tools.map((tool) => tool.function.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining(["create_worktree", "keep_worktree", "remove_worktree"]),
      );
      await runner.close();
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes a teammate auto-claim write to its bound worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-teammate-"));
    await gitRepository(root);
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const store = new SqliteTaskStore(root, {
      idGenerator: () => AUTO_TASK,
      claimTokenGenerator: () => AUTO_TOKEN,
    });
    const worktrees = new WorktreeRuntime({
      workspace: root,
      store,
      gitRunner: new SubprocessGitRunner(),
    });
    const workStealing = new WorkStealingRuntime({
      store,
      claimService: worktrees,
      sleeper: new ImmediateSleeper(),
      maxIdlePolls: 1,
    });
    const model = new AutoWorktreeModel();
    const runner = buildAgent(P18, {
      model,
      workspace: root,
      recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
      backgroundSupervisor: supervisor,
      cronRuntime: cron,
      teammateRuntime: teammates,
      protocolRuntime: protocol,
      workStealingRuntime: workStealing,
      worktreeRuntime: worktrees,
      approvalProvider: new AllowApproval(),
      auditSink: new NoopAudit(),
    });
    try {
      await worktrees.validateRepository();
      const task = await store.createTask({ subject: "automatic isolation", description: "" });
      const binding = await worktrees.createWorktree({
        taskId: task.id,
        name: "alice",
        integrationRef: "refs/heads/main",
      });
      const plan = await protocol.store.createRequest({
        kind: ProtocolRequestKind.PlanApproval,
        sender: "alice",
        target: "lead",
        content: "Complete the SQLite task.",
      });
      await protocol.store.consumeResponse(
        createProtocolMailboxMessage({
          id: "00000000-0000-4000-8000-000000002161",
          sender: "lead",
          recipient: "alice",
          kind: ProtocolMessageKind.PlanApprovalResponse,
          requestId: plan.id,
          content: "Approved",
          approved: true,
          createdAtUtc: new Date("2026-08-01T00:00:00.000Z"),
        }),
      );
      await teammates.start();
      await teammates.spawn({
        name: "alice",
        role: "worker",
        prompt: "be ready",
        sender: "lead",
      });
      const initialEvents = await teammates.waitForEvents(1);
      await teammates.acknowledgeEvents(initialEvents);
      const events = await teammates.waitForEvents(1);
      await teammates.acknowledgeEvents(events);

      await expect(readFile(join(root, binding.relativePath, "auto.txt"), "utf8")).resolves.toBe(
        "isolated",
      );
      await expect(readFile(join(root, "auto.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(store.getTask(task.id)).resolves.toMatchObject({ owner: "alice" });
      expect(
        model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === "user" && message.content.startsWith("<auto-claimed-task>"),
          ),
        ),
      ).toBe(true);
      for (const request of model.requests) {
        expectNoWorktreeLifecycleTools(request);
      }
      await runner.close();
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes Lead and Subagent writes through the shared bound worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-subagent-"));
    await gitRepository(root);
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const store = new SqliteTaskStore(root, {
      idGenerator: () => LEAD_TASK,
      claimTokenGenerator: () => LEAD_TOKEN,
    });
    const worktrees = new WorktreeRuntime({
      workspace: root,
      store,
      gitRunner: new SubprocessGitRunner(),
    });
    const workStealing = new WorkStealingRuntime({ store, claimService: worktrees });
    const model = new ScriptedModelClient([
      {
        message: assistantMessage(null, [
          toolCall("lead-claim", "claim_task", JSON.stringify({ task_id: LEAD_TASK })),
          toolCall(
            "lead-write",
            "write_file",
            JSON.stringify({ path: "lead.txt", content: "lead" }),
          ),
          toolCall("lead-task", "task", JSON.stringify({ description: "write child marker" })),
        ]),
        finishReason: "tool_calls",
      },
      {
        message: assistantMessage(null, [
          toolCall(
            "child-write",
            "write_file",
            JSON.stringify({ path: "child.txt", content: "child" }),
          ),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("child done"), finishReason: "stop" },
      { message: assistantMessage("lead done"), finishReason: "stop" },
    ]);
    try {
      await worktrees.validateRepository();
      const task = await store.createTask({ subject: "shared workspace" });
      const binding = await worktrees.createWorktree({
        taskId: task.id,
        name: "lead",
        integrationRef: "refs/heads/main",
      });
      const runner = buildAgent(P18, {
        model,
        workspace: root,
        identity: "lead",
        recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
        backgroundSupervisor: supervisor,
        cronRuntime: cron,
        teammateRuntime: teammates,
        protocolRuntime: protocol,
        workStealingRuntime: workStealing,
        worktreeRuntime: worktrees,
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      });

      await expect(runner.run("complete the bound task")).resolves.toMatchObject({
        finalText: "lead done",
      });
      await runner.close();

      await expect(readFile(join(root, binding.relativePath, "lead.txt"), "utf8")).resolves.toBe(
        "lead",
      );
      await expect(readFile(join(root, binding.relativePath, "child.txt"), "utf8")).resolves.toBe(
        "child",
      );
      await expect(readFile(join(root, "lead.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(root, "child.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(store.getTask(task.id)).resolves.toMatchObject({ owner: "lead" });
      const childRequests = model.requests.slice(1, 3);
      expect(childRequests).toHaveLength(2);
      for (const request of childRequests) {
        expectNoWorktreeLifecycleTools(request);
      }
      model.assertExhausted();
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
