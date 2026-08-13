import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { EventInbox } from "../src/core/events.js";
import { AgentRunner } from "../src/core/loop.js";
import { assistantMessage } from "../src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import { ToolRegistry } from "../src/core/tools.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import type {
  MailboxMessage,
  MailboxStore,
  ProtocolMailboxMessage,
} from "../src/features/mailbox.js";
import {
  isProtocolMailboxMessage,
  MailboxMessageKind,
  type ProtocolMessageKind,
} from "../src/features/mailbox.js";
import { TeammateRuntime, TeammateStatus } from "../src/features/teammates.js";

class ResultModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #results: string[];

  constructor(...results: string[]) {
    this.#results = results;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("unexpected request");
    return Object.freeze({ message: assistantMessage(result), finishReason: "stop" });
  }
}

class BlockingModel implements ModelClient {
  readonly started: Promise<void>;
  #started!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.#started = resolve;
    });
  }

  async complete(_request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
    this.#started();
    return await new Promise<ModelReply>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("worker aborted")), { once: true });
    });
  }
}

class FailFirstReleaseStore implements MailboxStore {
  readonly #inner: FileMailboxStore;
  releaseAttempts = 0;

  constructor(root: string) {
    this.#inner = new FileMailboxStore(root);
  }

  async send(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): Promise<MailboxMessage> {
    return await this.#inner.send(sender, recipient, content, kind);
  }

  async claim(recipient: string): Promise<MailboxMessage | undefined> {
    const message = await this.#inner.claim(recipient);
    if (message !== undefined && isProtocolMailboxMessage(message)) {
      throw new Error("unexpected protocol message");
    }
    return message;
  }

  async sendProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: { readonly requestId: string; readonly approved: boolean | null },
  ): Promise<ProtocolMailboxMessage> {
    return await this.#inner.sendProtocol(sender, recipient, content, kind, options);
  }

  async ack(message: MailboxMessage): Promise<boolean> {
    return await this.#inner.ack(message);
  }

  async release(message: MailboxMessage): Promise<boolean> {
    this.releaseAttempts += 1;
    if (this.releaseAttempts === 1) throw new Error("release failed");
    return await this.#inner.release(message);
  }

  async quarantine(message: MailboxMessage): Promise<boolean> {
    return await this.#inner.quarantine(message);
  }

  async recoverProcessing(recipient: string): Promise<number> {
    return await this.#inner.recoverProcessing(recipient);
  }
}

function createRuntime(
  root: string,
  store: MailboxStore = new FileMailboxStore(root),
): {
  readonly runtime: TeammateRuntime;
  readonly cron: CronRuntime;
  readonly supervisor: JobSupervisor;
} {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const cron = new CronRuntime({
    store: new JsonCronStore(root),
    inbox,
    supervisor,
    clock: { now: () => new Date("2026-07-30T08:00:00.000Z") },
  });
  return {
    runtime: new TeammateRuntime({
      store,
      inbox,
      supervisor,
      cronRuntime: cron,
    }),
    cron,
    supervisor,
  };
}

describe("chapter 15 persistent teammates", () => {
  test("runs independent workers, delivers results, and reuses an idle runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-team-"));
    const { runtime, cron, supervisor } = createRuntime(root);
    const models = new Map<string, ResultModel>([
      ["alice", new ResultModel("alice first", "alice second")],
      ["bob", new ResultModel("bob first")],
    ]);
    const runners = new Map<string, AgentRunner>();
    runtime.configureRunnerFactory((name, role, send) => {
      const tools = new ToolRegistry();
      tools.register(send);
      const model = models.get(name);
      if (model === undefined) throw new Error("missing model");
      const runner = new AgentRunner({
        model,
        tools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: root,
        identity: name,
      });
      runners.set(name, runner);
      return runner;
    });
    try {
      await runtime.start();
      await Promise.all([
        runtime.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" }),
        runtime.spawn({ name: "bob", role: "reviewer", prompt: "review", sender: "lead" }),
      ]);
      const results = [...(await runtime.waitForEvents(2)), ...(await runtime.waitForEvents(1))];
      expect(results.map((event) => event.toPayload().content).sort()).toEqual([
        "alice first",
        "bob first",
      ]);
      await runtime.acknowledgeEvents(results);
      expect(runtime.state("alice").status).toBe(TeammateStatus.Idle);
      const alice = runners.get("alice");
      await runtime.send({ sender: "lead", to: "alice", content: "revise" });
      const revised = await runtime.waitForEvents(1);
      expect(revised[0]?.toPayload().content).toBe("alice second");
      expect(runners.get("alice")).toBe(alice);
      expect(
        models.get("alice")?.requests[1]?.messages.map((message) => message.content),
      ).toContain("draft");
      await runtime.acknowledgeEvents(revised);
    } finally {
      await runtime.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate and reserved names and publishes a failed worker outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-team-"));
    const { runtime, cron, supervisor } = createRuntime(root);
    runtime.configureRunnerFactory(
      (name) =>
        new AgentRunner({
          model: {
            complete: async () => {
              throw new Error("model exploded");
            },
          },
          tools: new ToolRegistry(),
          systemPrompt: name,
          workspace: root,
          identity: name,
        }),
    );
    try {
      await runtime.start();
      await expect(
        runtime.spawn({ name: "lead", role: "bad", prompt: "bad", sender: "lead" }),
      ).rejects.toThrow(/reserved/);
      await runtime.spawn({ name: "alice", role: "writer", prompt: "fail", sender: "lead" });
      await expect(
        runtime.spawn({ name: "alice", role: "writer", prompt: "again", sender: "lead" }),
      ).rejects.toThrow(/exists/);
      const events = await runtime.waitForEvents(1);
      expect(events[0]?.toPayload()).toMatchObject({
        sender: "alice",
        recipient: "lead",
        message_kind: MailboxMessageKind.Result,
      });
      expect(runtime.state("alice").status).toBe(TeammateStatus.Failed);
    } finally {
      await runtime.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("close aborts an in-flight teammate and releases its processing message", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-team-"));
    const { runtime, cron, supervisor } = createRuntime(root);
    const model = new BlockingModel();
    runtime.configureRunnerFactory(
      (name) =>
        new AgentRunner({
          model,
          tools: new ToolRegistry(),
          systemPrompt: name,
          workspace: root,
          identity: name,
        }),
    );
    try {
      await runtime.start();
      await runtime.spawn({ name: "alice", role: "writer", prompt: "long task", sender: "lead" });
      await model.started;
      await runtime.close();
      expect(runtime.state("alice").status).toBe(TeammateStatus.Shutdown);
      await expect(runtime.mailboxStore.claim("alice")).resolves.toMatchObject({
        content: "long task",
        kind: MailboxMessageKind.Task,
      });
    } finally {
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("continues closing every worker after a failure and retries incomplete cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-team-"));
    const { runtime, cron, supervisor } = createRuntime(root);
    const closeAttempts = new Map<string, number>();
    runtime.configureRunnerFactory(
      (name) =>
        new AgentRunner({
          model: new ResultModel(`${name} done`),
          tools: new ToolRegistry(),
          systemPrompt: name,
          workspace: root,
          identity: name,
          resources: [
            {
              close: async () => {
                const attempts = (closeAttempts.get(name) ?? 0) + 1;
                closeAttempts.set(name, attempts);
                if (name === "alice" && attempts === 1) throw new Error("alice close failed");
              },
            },
          ],
        }),
    );
    try {
      await runtime.start();
      await Promise.all([
        runtime.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" }),
        runtime.spawn({ name: "bob", role: "reviewer", prompt: "review", sender: "lead" }),
      ]);
      const results = await runtime.waitForEvents(2);
      await runtime.acknowledgeEvents(results);

      await expect(runtime.close()).rejects.toThrow("alice close failed");
      expect(closeAttempts).toEqual(
        new Map([
          ["alice", 1],
          ["bob", 1],
        ]),
      );
      expect(runtime.state("alice").status).toBe(TeammateStatus.Shutdown);
      expect(runtime.state("bob").status).toBe(TeammateStatus.Shutdown);

      await expect(runtime.close()).resolves.toBeUndefined();
      expect(closeAttempts).toEqual(
        new Map([
          ["alice", 2],
          ["bob", 1],
        ]),
      );
    } finally {
      await runtime.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retains a failed cancellation release for the next close attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-team-"));
    const store = new FailFirstReleaseStore(root);
    const { runtime, cron, supervisor } = createRuntime(root, store);
    const model = new BlockingModel();
    runtime.configureRunnerFactory(
      (name) =>
        new AgentRunner({
          model,
          tools: new ToolRegistry(),
          systemPrompt: name,
          workspace: root,
          identity: name,
        }),
    );
    try {
      await runtime.start();
      await runtime.spawn({ name: "alice", role: "writer", prompt: "long task", sender: "lead" });
      await model.started;

      await expect(runtime.close()).rejects.toThrow("release failed");
      expect(store.releaseAttempts).toBe(1);
      expect(runtime.state("alice").status).toBe(TeammateStatus.Shutdown);

      await expect(runtime.close()).resolves.toBeUndefined();
      expect(store.releaseAttempts).toBe(2);
      await expect(runtime.mailboxStore.claim("alice")).resolves.toMatchObject({
        content: "long task",
        kind: MailboxMessageKind.Task,
      });
    } finally {
      await runtime.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
