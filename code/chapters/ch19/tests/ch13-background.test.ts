import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { EventInbox } from "../src/core/events.js";
import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { assistantMessage, toolCall, validateToolPairing } from "../src/core/messages.js";
import { AgentRunner } from "../src/core/loop.js";
import { PermissionDecision, PermissionPolicy, PermissionRule } from "../src/core/permissions.js";
import type { ApprovalProvider, PermissionRequest } from "../src/core/permissions.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import { ToolRegistry, toolSuccess, toolError } from "../src/core/tools.js";
import { createShellTool } from "../src/features/builtin-tools.js";
import {
  BackgroundCapacityError,
  BackgroundDispatcher,
  BackgroundJobEvent,
  BackgroundJobStatus,
  JobSupervisor,
  shouldRunInBackground,
} from "../src/features/background.js";
import type { CommandResult, CommandRunner } from "../src/core/commands.js";
import type { BackgroundOperation } from "../src/features/background.js";
import type { ToolResult } from "../src/core/tools.js";

const JOB_ID = "00000000-0000-4000-8000-000000000301";
const EVENT_ID = "00000000-0000-4000-8000-000000000302";
const JOB_ID_2 = "00000000-0000-4000-8000-000000000303";
const EVENT_ID_2 = "00000000-0000-4000-8000-000000000304";

class SequenceId {
  readonly #values: readonly string[];
  #index = 0;

  constructor(...values: string[]) {
    this.#values = values;
  }

  next = (): string => {
    const value = this.#values[this.#index];
    if (value === undefined) {
      throw new Error("id exhausted");
    }
    this.#index += 1;
    return value;
  };
}

class ManualExecutor {
  readonly release: Promise<void>;
  resolve: () => void = () => {
    throw new Error("manual executor release is not initialized");
  };
  calls = 0;

  constructor() {
    this.release = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  async execute(operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult> {
    this.calls += 1;
    await Promise.race([
      this.release,
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    if (signal.aborted) {
      return toolError("background_cancelled", "Background job was cancelled");
    }
    return await operation(signal);
  }
}

class AbortAwareExecutor {
  aborted = false;

  async execute(_operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          resolve();
        },
        { once: true },
      );
    });
    return toolError("background_cancelled", "worker observed cancellation");
  }
}

class RecordingCommandRunner implements CommandRunner {
  readonly calls: string[] = [];

  async run(command: string, _cwd: string, _timeoutMs?: number): Promise<CommandResult> {
    this.calls.push(command);
    return { output: "slow complete", exitCode: 0, timedOut: false, truncated: false };
  }
}

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test approval", "test");
  }
}

class CoordinatingModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #turn = 0;

  readonly release: () => void;
  readonly pending: () => boolean;

  constructor(release: () => void, pending: () => boolean) {
    this.release = release;
    this.pending = pending;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    this.#turn += 1;
    if (this.#turn === 1) {
      return {
        message: assistantMessage(null, [
          toolCall(
            "slow-call",
            "shell",
            JSON.stringify({ command: "npm install", run_in_background: true }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    if (this.#turn === 2) {
      const latest = request.messages.at(-1);
      expect(latest?.role).toBe("tool");
      expect(latest?.content).toContain('"status":"running"');
      expect(this.pending()).toBe(true);
      setTimeout(this.release, 20);
      return { message: assistantMessage("placeholder received"), finishReason: "stop" };
    }
    if (this.#turn === 3) {
      const latest = request.messages.at(-1);
      expect(latest?.role).toBe("user");
      expect(latest?.content).toContain('"kind":"background_job"');
      this.release();
      return { message: assistantMessage("all done"), finishReason: "stop" };
    }
    throw new Error("unexpected model call");
  }
}

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-tutorial-ch13-"));
}

describe("chapter 13 background runtime", () => {
  test("explicit background flags take precedence over the slow-command heuristic", () => {
    expect(shouldRunInBackground({ command: "Write-Output quick", run_in_background: true })).toBe(
      true,
    );
    expect(shouldRunInBackground({ command: "npm install", run_in_background: false })).toBe(false);
    expect(shouldRunInBackground({ command: "npm install", run_in_background: null })).toBe(true);
    expect(shouldRunInBackground({ command: "Get-ChildItem" })).toBe(false);
  });

  test("event inbox rejects untyped values", () => {
    const inbox = new EventInbox();
    expect(() => inbox.publish({ kind: "background_job" } as never)).toThrow(/RuntimeEvent/);
  });

  test("persists terminal status and emits exactly one typed event", async () => {
    const root = await workspace();
    try {
      const store = new JsonBackgroundJobStore(root);
      const inbox = new EventInbox();
      const executor = new ManualExecutor();
      const supervisor = new JobSupervisor({
        store,
        inbox,
        executor,
        idGenerator: new SequenceId(JOB_ID).next,
        eventIdGenerator: new SequenceId(EVENT_ID).next,
      });
      const jobId = await supervisor.submit({
        sourceToolCallId: "source-call",
        toolName: "shell",
        operation: async () => toolSuccess("compiled"),
      });
      expect(jobId).toBe(JOB_ID);
      executor.resolve();
      await supervisor.waitIdle();
      expect((await store.getJob(jobId)).status).toBe(BackgroundJobStatus.COMPLETED);
      const events = inbox.drain();
      expect(events).toHaveLength(1);
      expect(events[0]?.eventId).toBe(EVENT_ID);
      expect(inbox.drain()).toEqual([]);
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("background placeholder lets the loop finish before the event turn", async () => {
    const root = await workspace();
    try {
      const store = new JsonBackgroundJobStore(root);
      const inbox = new EventInbox();
      const executor = new ManualExecutor();
      const supervisor = new JobSupervisor({
        store,
        inbox,
        executor,
        idGenerator: new SequenceId(JOB_ID).next,
        eventIdGenerator: new SequenceId(EVENT_ID).next,
      });
      const commandRunner = new RecordingCommandRunner();
      const tools = new ToolRegistry();
      tools.register(createShellTool(commandRunner, true));
      const model = new CoordinatingModel(executor.resolve, () => supervisor.hasPendingWork);
      const runner = new AgentRunner({
        model,
        tools,
        systemPrompt: "system",
        workspace: root,
        permissionPolicy: new PermissionPolicy({
          approval: new AllowApproval(),
          rules: [
            new PermissionRule({
              name: "allow-shell",
              behavior: "allow",
              reason: "test",
              matches: () => true,
            }),
          ],
        }),
        toolDispatcher: new BackgroundDispatcher(tools, supervisor),
        eventPump: supervisor,
        resources: [supervisor],
      });
      const result = await runner.run("start");
      expect(result.finalText).toBe("all done");
      expect(model.requests).toHaveLength(3);
      expect(model.requests[1]?.messages.at(-1)?.content).toContain('"status":"running"');
      expect(commandRunner.calls).toEqual(["npm install"]);
      expect((await store.getJob(JOB_ID)).status).toBe(BackgroundJobStatus.COMPLETED);
      validateToolPairing(result.history);
      await runner.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("worker errors persist as one failed event", async () => {
    const root = await workspace();
    try {
      const store = new JsonBackgroundJobStore(root);
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({
        store,
        inbox,
        idGenerator: new SequenceId(JOB_ID).next,
        eventIdGenerator: new SequenceId(EVENT_ID).next,
      });
      await supervisor.submit({
        sourceToolCallId: "failing-call",
        toolName: "shell",
        operation: async () => {
          throw new Error("worker failed");
        },
      });
      await supervisor.waitIdle();
      const job = await store.getJob(JOB_ID);
      expect(job.status).toBe(BackgroundJobStatus.FAILED);
      expect(job.result?.errorCode).toBe("background_execution_error");
      const events = inbox.drain();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(BackgroundJobEvent);
      expect(events[0]?.toPayload()).toMatchObject({ status: "failed", job_id: JOB_ID });
      expect(inbox.drain()).toEqual([]);
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("capacity rejects a second job without persistence or execution", async () => {
    const root = await workspace();
    try {
      const store = new JsonBackgroundJobStore(root);
      const inbox = new EventInbox();
      const executor = new ManualExecutor();
      const supervisor = new JobSupervisor({
        store,
        inbox,
        executor,
        capacity: 1,
        idGenerator: new SequenceId(JOB_ID).next,
        eventIdGenerator: new SequenceId(EVENT_ID).next,
      });
      await supervisor.submit({
        sourceToolCallId: "call-1",
        toolName: "shell",
        operation: async () => toolSuccess("first"),
      });
      await expect(
        supervisor.submit({
          sourceToolCallId: "call-2",
          toolName: "shell",
          operation: async () => toolSuccess("second"),
        }),
      ).rejects.toBeInstanceOf(BackgroundCapacityError);
      expect((await store.listJobs()).map((job) => job.id)).toEqual([JOB_ID]);
      expect(executor.calls).toBe(1);
      executor.resolve();
      await supervisor.waitIdle();
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restart interrupts persisted running jobs once", async () => {
    const root = await workspace();
    try {
      const store = new JsonBackgroundJobStore(root);
      await store.createRunning({
        jobId: JOB_ID,
        sourceToolCallId: "old-call",
        toolName: "shell",
      });
      const firstInbox = new EventInbox();
      const first = new JobSupervisor({
        store,
        inbox: firstInbox,
        eventIdGenerator: new SequenceId(EVENT_ID).next,
      });
      await first.ready();
      expect((await store.getJob(JOB_ID)).status).toBe(BackgroundJobStatus.INTERRUPTED);
      expect(firstInbox.drain()).toHaveLength(1);
      await first.close();
      const secondInbox = new EventInbox();
      const second = new JobSupervisor({ store, inbox: secondInbox });
      await second.ready();
      expect(secondInbox.drain()).toEqual([]);
      await second.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("closing cancels every running job and leaves no running status", async () => {
    const root = await workspace();
    try {
      const store = new JsonBackgroundJobStore(root);
      const inbox = new EventInbox();
      const executor = new ManualExecutor();
      const first = new SequenceId(JOB_ID, JOB_ID_2);
      const events = new SequenceId(EVENT_ID, EVENT_ID_2);
      const supervisor = new JobSupervisor({
        store,
        inbox,
        executor,
        capacity: 2,
        idGenerator: first.next,
        eventIdGenerator: events.next,
      });
      await supervisor.submit({
        sourceToolCallId: "call-1",
        toolName: "shell",
        operation: async () => toolSuccess("first"),
      });
      await supervisor.submit({
        sourceToolCallId: "call-2",
        toolName: "shell",
        operation: async () => toolSuccess("second"),
      });
      await supervisor.close();
      await supervisor.close();
      expect(
        (await store.listJobs()).every((job) => job.status !== BackgroundJobStatus.RUNNING),
      ).toBe(true);
      expect(supervisor.activeCount).toBe(0);
      expect(inbox.drain()).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("timeout aborts the worker and emits one timed-out event", async () => {
    const root = await workspace();
    try {
      const store = new JsonBackgroundJobStore(root);
      const inbox = new EventInbox();
      const executor = new AbortAwareExecutor();
      const supervisor = new JobSupervisor({
        store,
        inbox,
        executor,
        timeoutMs: 10,
        idGenerator: new SequenceId(JOB_ID).next,
        eventIdGenerator: new SequenceId(EVENT_ID).next,
      });
      await supervisor.submit({
        sourceToolCallId: "slow-call",
        toolName: "shell",
        operation: async () => toolSuccess("too late"),
      });
      await supervisor.waitIdle();
      expect(executor.aborted).toBe(true);
      expect((await store.getJob(JOB_ID)).status).toBe(BackgroundJobStatus.TIMED_OUT);
      expect(inbox.drain()).toHaveLength(1);
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("explicit cancellation aborts the worker and persists cancelled status", async () => {
    const root = await workspace();
    try {
      const store = new JsonBackgroundJobStore(root);
      const inbox = new EventInbox();
      const executor = new AbortAwareExecutor();
      const supervisor = new JobSupervisor({
        store,
        inbox,
        executor,
        idGenerator: new SequenceId(JOB_ID).next,
        eventIdGenerator: new SequenceId(EVENT_ID).next,
      });
      const jobId = await supervisor.submit({
        sourceToolCallId: "cancel-call",
        toolName: "shell",
        operation: async () => toolSuccess("never completes"),
      });
      await supervisor.cancel(jobId);
      expect(executor.aborted).toBe(true);
      expect((await store.getJob(jobId)).status).toBe(BackgroundJobStatus.CANCELLED);
      expect(inbox.drain()).toHaveLength(1);
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
