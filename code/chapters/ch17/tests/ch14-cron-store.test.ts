import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonCronStore } from "../src/adapters/cron-json.js";
import { CronJobNotFoundError, CronStorageError } from "../src/features/cron.js";

const JOB_ID = "00000000-0000-4000-8000-000000000501";
const JOB_ID_2 = "00000000-0000-4000-8000-000000000503";
const EVENT_ID = "00000000-0000-4000-8000-000000000502";
const BASE = new Date("2026-06-01T12:00:30.000Z");

class OneId {
  #value: string;
  #used = false;
  constructor(value: string) {
    this.#value = value;
  }
  next = (): string => {
    if (this.#used) throw new Error("id exhausted");
    this.#used = true;
    return this.#value;
  };
}

class SequenceId {
  #values: readonly string[];
  #index = 0;
  constructor(...values: string[]) {
    this.#values = values;
  }
  next = (): string => {
    const value = this.#values[this.#index];
    if (value === undefined) throw new Error("id exhausted");
    this.#index += 1;
    return value;
  };
}

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-"));
}

describe("chapter 14 cron store", () => {
  test("durable job and pending outbox recover, while session job does not", async () => {
    const root = await workspace();
    try {
      const store = new JsonCronStore(root, {
        idGenerator: new OneId(JOB_ID).next,
        eventIdGenerator: new OneId(EVENT_ID).next,
      });
      const durable = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "durable",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      const session = await new JsonCronStore(root, {
        idGenerator: new OneId(JOB_ID_2).next,
      }).scheduleCron({
        cron: "* * * * *",
        prompt: "session",
        timezone: "UTC",
        recurring: false,
        durable: false,
        identity: "owner",
        nowUtc: BASE,
      });
      expect(durable.durable).toBe(true);
      expect(session.durable).toBe(false);
      await store.tick(durable.nextRunAtUtc);
      expect((await store.pendingEvents()).map((event) => event.eventId)).toEqual([EVENT_ID]);
      const rebuilt = new JsonCronStore(root);
      expect((await rebuilt.listJobs()).map((job) => job.id)).toEqual([]);
      expect((await rebuilt.pendingEvents()).map((event) => event.eventId)).toEqual([EVENT_ID]);
      await rebuilt.ackEvent(EVENT_ID);
      expect(await rebuilt.pendingEvents()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("one-shot removes definition but keeps event until ack", async () => {
    const root = await workspace();
    try {
      const store = new JsonCronStore(root, {
        idGenerator: new OneId(JOB_ID).next,
        eventIdGenerator: new OneId(EVENT_ID).next,
      });
      const job = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "once",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      await store.tick(job.nextRunAtUtc);
      await expect(store.getJob(JOB_ID)).rejects.toBeInstanceOf(CronJobNotFoundError);
      expect((await store.pendingEvents()).map((event) => event.eventId)).toEqual([EVENT_ID]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("full outbox leaves later due jobs unchanged", async () => {
    const root = await workspace();
    try {
      const ids = new SequenceId(JOB_ID, JOB_ID_2);
      const events = new SequenceId(EVENT_ID, "00000000-0000-4000-8000-000000000504");
      const store = new JsonCronStore(root, {
        outboxCapacity: 1,
        idGenerator: ids.next,
        eventIdGenerator: events.next,
      });
      const first = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "first",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      const second = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "second",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      await store.tick(first.nextRunAtUtc);
      expect((await store.getJob(second.id)).nextRunAtUtc).toEqual(second.nextRunAtUtc);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recurring tick is idempotent for a slot and advances beyond misfire time", async () => {
    const root = await workspace();
    try {
      const store = new JsonCronStore(root, {
        idGenerator: new OneId(JOB_ID).next,
        eventIdGenerator: new OneId(EVENT_ID).next,
      });
      const job = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "repeat",
        timezone: "UTC",
        recurring: true,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      const later = new Date(job.nextRunAtUtc.valueOf() + 3 * 86_400_000);
      expect((await store.tick(later)).map((event) => event.slotAtUtc)).toEqual([job.nextRunAtUtc]);
      expect(await store.tick(job.nextRunAtUtc)).toEqual([]);
      const updated = await store.getJob(JOB_ID);
      expect(updated.lastSlotAtUtc).toEqual(job.nextRunAtUtc);
      expect(updated.nextRunAtUtc.getTime()).toBeGreaterThan(later.getTime());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("acknowledgement removes an event exactly once", async () => {
    const root = await workspace();
    try {
      const store = new JsonCronStore(root, {
        idGenerator: new OneId(JOB_ID).next,
        eventIdGenerator: new OneId(EVENT_ID).next,
      });
      const job = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "once",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      await store.tick(job.nextRunAtUtc);
      expect(await store.ackEvent(EVENT_ID)).toBe(true);
      expect(await store.ackEvent(EVENT_ID)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed durable writes leave previous bytes and due state unchanged", async () => {
    const root = await workspace();
    let failWrites = false;
    const replace = async (path: string, content: Buffer): Promise<void> => {
      if (failWrites) throw new Error("disk full");
      await writeFile(path, content);
    };
    try {
      const ids = new SequenceId(JOB_ID, JOB_ID_2);
      const store = new JsonCronStore(root, {
        idGenerator: ids.next,
        eventIdGenerator: new OneId(EVENT_ID).next,
        atomicReplace: replace,
      });
      const job = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "stable",
        timezone: "UTC",
        recurring: true,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      const statePath = join(root, ".agent_tutorial", "cron", "state.json");
      const before = await readFile(statePath);
      failWrites = true;
      await expect(store.tick(job.nextRunAtUtc)).rejects.toBeInstanceOf(CronStorageError);
      expect(await readFile(statePath)).toEqual(before);
      const rebuilt = new JsonCronStore(root);
      expect((await rebuilt.getJob(JOB_ID)).lastSlotAtUtc).toBeNull();
      expect(await rebuilt.pendingEvents()).toEqual([]);
      await expect(
        store.scheduleCron({
          cron: "* * * * *",
          prompt: "not committed",
          timezone: "UTC",
          recurring: false,
          durable: true,
          identity: "owner",
          nowUtc: BASE,
        }),
      ).rejects.toBeInstanceOf(CronStorageError);
      expect(await readFile(statePath)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed acknowledgement leaves the durable outbox bytes unchanged", async () => {
    const root = await workspace();
    let failWrites = false;
    const replace = async (path: string, content: Buffer): Promise<void> => {
      if (failWrites) throw new Error("disk full");
      await writeFile(path, content);
    };
    try {
      const store = new JsonCronStore(root, {
        idGenerator: new OneId(JOB_ID).next,
        eventIdGenerator: new OneId(EVENT_ID).next,
        atomicReplace: replace,
      });
      const job = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "stable",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      await store.tick(job.nextRunAtUtc);
      const statePath = join(root, ".agent_tutorial", "cron", "state.json");
      const before = await readFile(statePath);
      failWrites = true;
      await expect(store.ackEvent(EVENT_ID)).rejects.toBeInstanceOf(CronStorageError);
      expect(await readFile(statePath)).toEqual(before);
      expect((await new JsonCronStore(root).pendingEvents()).map((event) => event.eventId)).toEqual(
        [EVENT_ID],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("event ID collision does not overwrite an unacknowledged outbox event", async () => {
    const root = await workspace();
    try {
      const store = new JsonCronStore(root, {
        idGenerator: new SequenceId(JOB_ID, JOB_ID_2).next,
        eventIdGenerator: () => EVENT_ID,
      });
      const first = await store.scheduleCron({
        cron: "* * * * *",
        prompt: "first",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      const second = await store.scheduleCron({
        cron: "*/2 * * * *",
        prompt: "second",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      await store.tick(first.nextRunAtUtc);
      await expect(store.tick(second.nextRunAtUtc)).rejects.toThrow("Cron event id already exists");
      expect((await store.pendingEvents()).map((event) => event.eventId)).toEqual([EVENT_ID]);
      expect((await store.getJob(second.id)).nextRunAtUtc).toEqual(second.nextRunAtUtc);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("competing stores commit one event for the same due slot", async () => {
    const root = await workspace();
    try {
      const creator = new JsonCronStore(root, { idGenerator: new OneId(JOB_ID).next });
      const job = await creator.scheduleCron({
        cron: "* * * * *",
        prompt: "once",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      const first = new JsonCronStore(root, { eventIdGenerator: new OneId(EVENT_ID).next });
      const second = new JsonCronStore(root, { eventIdGenerator: new OneId(EVENT_ID).next });
      const outcomes = await Promise.all([
        first.tick(job.nextRunAtUtc),
        second.tick(job.nextRunAtUtc),
      ]);
      expect(outcomes.flat()).toHaveLength(1);
      expect((await new JsonCronStore(root).pendingEvents()).map((event) => event.eventId)).toEqual(
        [EVENT_ID],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bad persisted state fails explicitly", async () => {
    const root = await workspace();
    try {
      const store = new JsonCronStore(root, { idGenerator: new OneId(JOB_ID).next });
      await store.scheduleCron({
        cron: "* * * * *",
        prompt: "state",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "owner",
        nowUtc: BASE,
      });
      const statePath = join(root, ".agent_tutorial", "cron", "state.json");
      const original = await readFile(statePath, "utf8");
      await writeFile(statePath, `${original.replace('"version": 1', '"version": 2')}`, "utf8");
      await expect(new JsonCronStore(root).listJobs()).rejects.toBeInstanceOf(CronStorageError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a Cron root junction before creating an external leader directory", async () => {
    const root = await workspace();
    const external = await workspace();
    try {
      const stateRoot = join(root, ".agent_tutorial");
      await mkdir(stateRoot);
      await symlink(external, join(stateRoot, "cron"), "junction");
      const store = new JsonCronStore(root, { idGenerator: new OneId(JOB_ID).next });
      await expect(
        store.scheduleCron({
          cron: "* * * * *",
          prompt: "must not escape",
          timezone: "UTC",
          recurring: false,
          durable: true,
          identity: "owner",
          nowUtc: BASE,
        }),
      ).rejects.toBeInstanceOf(CronStorageError);
      await expect(lstat(join(external, "leader"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
});
