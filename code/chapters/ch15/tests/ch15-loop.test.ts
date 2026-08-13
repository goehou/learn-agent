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
import { MailboxMessageKind, MailboxStorageError } from "../src/features/mailbox.js";
import { TeammateRuntime } from "../src/features/teammates.js";

class EventModel implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    return Object.freeze({ message: assistantMessage("handled"), finishReason: "stop" });
  }
}

class DeferredMailboxModel implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const hasMailbox = request.messages.some(
      (message) => message.role === "user" && message.content?.includes('"kind":"mailbox"'),
    );
    return Object.freeze({
      message: assistantMessage(hasMailbox ? "mailbox handled" : "user handled"),
      finishReason: "stop",
    });
  }
}

describe("chapter 15 mailbox event turn", () => {
  test("rejects a blank idempotency key before creating history or model work", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-loop-"));
    const model = new EventModel();
    const runner = new AgentRunner({
      model,
      tools: new ToolRegistry(),
      systemPrompt: "system",
      workspace: root,
    });
    try {
      await expect(runner.run("work", { idempotencyKey: "   " })).rejects.toThrow(/idempotencyKey/);
      expect(runner.history).toEqual([]);
      expect(model.requests).toEqual([]);
    } finally {
      await runner.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("defers a mailbox event during a normal user turn until an explicit event turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-loop-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date() },
    });
    const store = new FileMailboxStore(root);
    const runtime = new TeammateRuntime({ store, inbox, supervisor, cronRuntime: cron });
    runtime.configureRunnerFactory(() => {
      throw new Error("not used");
    });
    const model = new DeferredMailboxModel();
    const runner = new AgentRunner({
      model,
      tools: new ToolRegistry(),
      systemPrompt: "system",
      workspace: root,
      eventPump: runtime,
      resources: [supervisor, cron, runtime],
    });
    try {
      await store.send("writer", "lead", "report complete", MailboxMessageKind.Result);
      await runtime.start();
      await expect(runner.run("normal request")).resolves.toMatchObject({
        finalText: "user handled",
      });
      expect(model.requests).toHaveLength(1);
      expect(
        model.requests[0]?.messages.some((message) =>
          message.content?.includes('"kind":"mailbox"'),
        ),
      ).toBe(false);

      await expect(runner.runEvents()).resolves.toMatchObject({ finalText: "mailbox handled" });
      expect(model.requests).toHaveLength(2);
    } finally {
      await runner.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("adds one canonical mailbox event before ack and retries an ack failure without a duplicate model call", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-loop-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date() },
    });
    const store = new FileMailboxStore(root);
    const runtime = new TeammateRuntime({ store, inbox, supervisor, cronRuntime: cron });
    runtime.configureRunnerFactory(() => {
      throw new Error("not used");
    });
    const model = new EventModel();
    const runner = new AgentRunner({
      model,
      tools: new ToolRegistry(),
      systemPrompt: "system",
      workspace: root,
      eventPump: runtime,
      resources: [supervisor, cron, runtime],
    });
    try {
      const message = await store.send(
        "writer",
        "lead",
        "report complete",
        MailboxMessageKind.Result,
      );
      await runtime.start();
      const originalAck = store.ack.bind(store);
      let attempted = 0;
      store.ack = async (event) => {
        attempted += 1;
        const canonical = runner.history.filter(
          (item) => item.role === "user" && item.content?.includes('"kind":"mailbox"'),
        );
        expect(canonical).toHaveLength(1);
        if (attempted === 1) throw new MailboxStorageError("ack persist failed");
        return await originalAck(event);
      };

      await expect(runner.runEvents()).rejects.toThrow(/ack persist failed/);
      expect(model.requests).toHaveLength(0);
      expect(runner.history.filter((item) => item.content?.includes(message.id))).toHaveLength(1);

      await expect(runner.runEvents()).resolves.toMatchObject({ finalText: "handled" });
      expect(attempted).toBe(2);
      expect(model.requests).toHaveLength(1);
      expect(runner.history.filter((item) => item.content?.includes(message.id))).toHaveLength(1);

      inbox.publish(message);
      await expect(runner.runEvents()).resolves.toBeUndefined();
      expect(model.requests).toHaveLength(1);
    } finally {
      await runner.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
