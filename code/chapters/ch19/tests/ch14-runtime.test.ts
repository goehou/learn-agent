import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { EventInbox } from "../src/core/events.js";
import { AgentRunner } from "../src/core/loop.js";
import { assistantMessage, toolCall } from "../src/core/messages.js";
import { PermissionPolicy, PermissionRule } from "../src/core/permissions.js";
import { ToolRegistry, toolSuccess, type ToolContext } from "../src/core/tools.js";
import { JobSupervisor } from "../src/features/background.js";
import {
  CronRuntime,
  CronStorageError,
  type CronClock,
  type CronSleeper,
} from "../src/features/cron.js";
import { ScriptedModelClient } from "./fakes.js";

const JOB_ID = "00000000-0000-4000-8000-000000000511";
const EVENT_ID = "00000000-0000-4000-8000-000000000512";
const BASE = new Date("2026-06-01T12:00:30.000Z");

class Clock implements CronClock {
  value = BASE;
  now(): Date {
    return this.value;
  }
}
class Sleeper implements CronSleeper {
  started = false;
  async sleep(_milliseconds: number): Promise<void> {
    this.started = true;
    await Promise.resolve();
  }
}
class BlockingSleeper implements CronSleeper {
  started = false;
  #release!: () => void;
  #wait = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  async sleep(_milliseconds: number, signal?: AbortSignal): Promise<void> {
    this.started = true;
    signal?.addEventListener("abort", () => this.#release(), { once: true });
    await this.#wait;
  }
}

async function scheduleDue(store: JsonCronStore, clock: Clock): Promise<void> {
  const job = await store.scheduleCron({
    cron: "* * * * *",
    prompt: "scheduled",
    timezone: "UTC",
    recurring: false,
    durable: true,
    identity: "cron-owner",
    nowUtc: clock.value,
  });
  clock.value = job.nextRunAtUtc;
}

describe("chapter 14 cron runtime", () => {
  test("publishes pending durable event once and acknowledges it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    try {
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
      const clock = new Clock();
      const store = new JsonCronStore(root, {
        idGenerator: () => JOB_ID,
        eventIdGenerator: () => EVENT_ID,
      });
      const runtime = new CronRuntime({ store, inbox, supervisor, clock });
      const job = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "scheduled",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "cron-owner",
        nowUtc: clock.value,
      });
      clock.value = job.nextRunAtUtc;
      await runtime.tick();
      const events = runtime.drainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.contextIdentity).toBe("cron-owner");
      await runtime.acknowledgeEvents(events);
      expect(await store.pendingEvents()).toEqual([]);
      await runtime.close();
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scheduler is a closeable resource", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    try {
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
      const runtime = new CronRuntime({
        store: new JsonCronStore(root),
        inbox,
        supervisor,
        clock: new Clock(),
        sleeper: new Sleeper(),
      });
      runtime.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await runtime.close();
      await runtime.close();
      expect(supervisor.activeCount).toBe(0);
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runtime close cancels a blocked scheduler before supervisor close", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    try {
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
      const sleeper = new BlockingSleeper();
      const runtime = new CronRuntime({
        store: new JsonCronStore(root),
        inbox,
        supervisor,
        clock: new Clock(),
        sleeper,
      });
      runtime.start();
      await vi.waitFor(() => expect(sleeper.started).toBe(true));
      await runtime.close();
      expect(supervisor.activeCount).toBe(0);
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scheduler failure remains observable through close", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    try {
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
      const store = new JsonCronStore(root);
      const runtime = new CronRuntime({ store, inbox, supervisor, clock: new Clock() });
      const failure = new CronStorageError("scheduler failed");
      vi.spyOn(store, "tick").mockRejectedValue(failure);
      runtime.start();
      await vi.waitFor(() => expect(supervisor.activeCount).toBe(0));
      await expect(runtime.close()).rejects.toBe(failure);
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("wakeup runs the event with its saved identity and current permission policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    try {
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
      const clock = new Clock();
      const store = new JsonCronStore(root, {
        idGenerator: () => JOB_ID,
        eventIdGenerator: () => EVENT_ID,
      });
      const runtime = new CronRuntime({ store, inbox, supervisor, clock });
      await scheduleDue(store, clock);
      const contexts: ToolContext[] = [];
      const tools = new ToolRegistry();
      tools.register({
        name: "action",
        description: "Run the scheduled action.",
        inputSchema: z.object({ value: z.string() }).strict(),
        effect: "read",
        handler: async (input, context) => {
          contexts.push(context);
          return toolSuccess(input.value);
        },
      });
      const model = new ScriptedModelClient([
        {
          message: assistantMessage(null, [
            toolCall("scheduled-action", "action", '{"value":"run"}'),
          ]),
          finishReason: "tool_calls",
        },
        { message: assistantMessage("scheduled done"), finishReason: "stop" },
      ]);
      const policy = new PermissionPolicy({
        rules: [
          new PermissionRule({
            name: "current-rule",
            behavior: "allow",
            reason: "allowed",
            matches: () => true,
          }),
        ],
      });
      const runner = new AgentRunner({
        model,
        tools,
        systemPrompt: "system",
        workspace: root,
        identity: "interactive",
        permissionPolicy: policy,
        eventPump: runtime,
        resources: [supervisor, runtime],
      });
      runtime.bindWakeup(async () => {
        await runner.runEvents();
      });
      await runtime.tick();
      expect(contexts).toEqual([
        expect.objectContaining({ identity: "cron-owner", idempotencyKey: EVENT_ID }),
      ]);
      expect(await store.pendingEvents()).toEqual([]);
      expect(model.requests).toHaveLength(2);
      await runner.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("acknowledgement failure retries the event without duplicate history", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    try {
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
      const clock = new Clock();
      const store = new JsonCronStore(root, {
        idGenerator: () => JOB_ID,
        eventIdGenerator: () => EVENT_ID,
      });
      const runtime = new CronRuntime({ store, inbox, supervisor, clock });
      await scheduleDue(store, clock);
      await runtime.tick();
      const originalAck = store.ackEvent.bind(store);
      vi.spyOn(store, "ackEvent").mockResolvedValueOnce(false).mockImplementation(originalAck);
      const model = new ScriptedModelClient([
        { message: assistantMessage("handled"), finishReason: "stop" },
      ]);
      const runner = new AgentRunner({
        model,
        tools: new ToolRegistry(),
        systemPrompt: "system",
        workspace: root,
        eventPump: runtime,
        resources: [supervisor, runtime],
      });
      await expect(runner.runEvents()).rejects.toThrow("Cron event is no longer pending");
      expect((await store.pendingEvents()).map((event) => event.eventId)).toEqual([EVENT_ID]);
      expect(
        runner.history.filter(
          (message) => message.role === "user" && message.content?.includes('"kind":"cron"'),
        ),
      ).toHaveLength(0);
      expect(model.requests).toHaveLength(0);
      await runtime.tick();
      await expect(runner.runEvents()).resolves.toMatchObject({ finalText: "handled" });
      expect(await store.pendingEvents()).toEqual([]);
      expect(
        runner.history.filter(
          (message) => message.role === "user" && message.content?.includes('"kind":"cron"'),
        ),
      ).toHaveLength(1);
      await runner.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("only the durable leader delivers an event and a successor re-delivers unacked work", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    try {
      const firstInbox = new EventInbox();
      const firstSupervisor = new JobSupervisor({
        store: new JsonBackgroundJobStore(root),
        inbox: firstInbox,
      });
      const secondInbox = new EventInbox();
      const secondSupervisor = new JobSupervisor({
        store: new JsonBackgroundJobStore(root),
        inbox: secondInbox,
      });
      const clock = new Clock();
      const creator = new JsonCronStore(root, {
        idGenerator: () => JOB_ID,
        eventIdGenerator: () => EVENT_ID,
      });
      await scheduleDue(creator, clock);
      const first = new CronRuntime({
        store: new JsonCronStore(root, { eventIdGenerator: () => EVENT_ID }),
        inbox: firstInbox,
        supervisor: firstSupervisor,
        clock,
      });
      const second = new CronRuntime({
        store: new JsonCronStore(root, { eventIdGenerator: () => EVENT_ID }),
        inbox: secondInbox,
        supervisor: secondSupervisor,
        clock,
      });
      await first.tick();
      await second.tick();
      expect(first.drainEvents().map((event) => event.eventId)).toEqual([EVENT_ID]);
      expect(second.drainEvents()).toEqual([]);
      await first.close();
      await second.tick();
      const recovered = second.drainEvents();
      expect(recovered.map((event) => event.eventId)).toEqual([EVENT_ID]);
      await second.acknowledgeEvents(recovered);
      expect(await new JsonCronStore(root).pendingEvents()).toEqual([]);
      await second.close();
      await firstSupervisor.close();
      await secondSupervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an interactive turn defers a cron event to its own identity context", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    let releaseInteractive!: () => void;
    const interactiveReleased = new Promise<void>((resolve) => {
      releaseInteractive = resolve;
    });
    let markInteractiveStarted!: () => void;
    const interactiveStarted = new Promise<void>((resolve) => {
      markInteractiveStarted = resolve;
    });
    try {
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
      const clock = new Clock();
      const store = new JsonCronStore(root, {
        idGenerator: () => JOB_ID,
        eventIdGenerator: () => EVENT_ID,
      });
      const runtime = new CronRuntime({ store, inbox, supervisor, clock });
      const contexts: ToolContext[] = [];
      const tools = new ToolRegistry();
      tools.register({
        name: "action",
        description: "Run the scheduled action.",
        inputSchema: z.object({ value: z.string() }).strict(),
        effect: "read",
        handler: async (input, context) => {
          contexts.push(context);
          return toolSuccess(input.value);
        },
      });
      let calls = 0;
      const model = {
        complete: async () => {
          calls += 1;
          if (calls === 1) {
            markInteractiveStarted();
            await interactiveReleased;
            return { message: assistantMessage("interactive done"), finishReason: "stop" } as const;
          }
          if (calls === 2) {
            return {
              message: assistantMessage(null, [
                toolCall("scheduled-action", "action", '{"value":"run"}'),
              ]),
              finishReason: "tool_calls",
            } as const;
          }
          return { message: assistantMessage("scheduled done"), finishReason: "stop" } as const;
        },
      };
      const policy = new PermissionPolicy({
        rules: [
          new PermissionRule({
            name: "allow",
            behavior: "allow",
            reason: "allowed",
            matches: () => true,
          }),
        ],
      });
      const runner = new AgentRunner({
        model,
        tools,
        systemPrompt: "system",
        workspace: root,
        identity: "interactive-owner",
        permissionPolicy: policy,
        eventPump: runtime,
        resources: [supervisor, runtime],
      });
      runtime.bindWakeup(async () => {
        await runner.runEvents();
      });
      const userTurn = runner.run("interactive request");
      await interactiveStarted;
      await scheduleDue(store, clock);
      await runtime.tick();
      releaseInteractive();
      await expect(userTurn).resolves.toMatchObject({ finalText: "interactive done" });
      expect(contexts).toEqual([]);
      expect((await store.pendingEvents()).map((event) => event.eventId)).toEqual([EVENT_ID]);
      await expect(runner.runEvents()).resolves.toMatchObject({ finalText: "scheduled done" });
      expect(contexts).toEqual([
        expect.objectContaining({ identity: "cron-owner", idempotencyKey: EVENT_ID }),
      ]);
      expect(await store.pendingEvents()).toEqual([]);
      await runner.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a deferred cron event is not republished before its acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-runtime-"));
    let releaseInteractive!: () => void;
    const interactiveReleased = new Promise<void>((resolve) => {
      releaseInteractive = resolve;
    });
    let markInteractiveStarted!: () => void;
    const interactiveStarted = new Promise<void>((resolve) => {
      markInteractiveStarted = resolve;
    });
    try {
      const inbox = new EventInbox();
      const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
      const clock = new Clock();
      const store = new JsonCronStore(root, {
        idGenerator: () => JOB_ID,
        eventIdGenerator: () => EVENT_ID,
      });
      const runtime = new CronRuntime({ store, inbox, supervisor, clock });
      await scheduleDue(store, clock);
      await runtime.tick();
      let calls = 0;
      const runner = new AgentRunner({
        model: {
          complete: async () => {
            calls += 1;
            if (calls === 1) {
              markInteractiveStarted();
              await interactiveReleased;
              return {
                message: assistantMessage("interactive done"),
                finishReason: "stop",
              } as const;
            }
            return { message: assistantMessage("scheduled done"), finishReason: "stop" } as const;
          },
        },
        tools: new ToolRegistry(),
        systemPrompt: "system",
        workspace: root,
        eventPump: runtime,
        resources: [supervisor, runtime],
      });
      const interactive = runner.run("interactive request");
      await interactiveStarted;
      await runtime.tick();
      releaseInteractive();
      await expect(interactive).resolves.toMatchObject({ finalText: "interactive done" });
      await expect(runner.runEvents()).resolves.toMatchObject({ finalText: "scheduled done" });
      await expect(runner.runEvents()).resolves.toBeUndefined();
      expect(calls).toBe(2);
      expect(await store.pendingEvents()).toEqual([]);
      await runner.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
