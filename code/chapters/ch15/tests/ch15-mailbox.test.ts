import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import {
  MailboxMessageKind,
  MailboxState,
  MailboxStorageError,
  canonicalAgentName,
} from "../src/features/mailbox.js";

const IDS = [
  "00000000-0000-4000-8000-000000000701",
  "00000000-0000-4000-8000-000000000702",
  "00000000-0000-4000-8000-000000000703",
] as const;
const NOW = new Date("2026-07-30T08:00:00.000Z");

function createStore(
  root: string,
  ids: readonly string[] = IDS,
  dates: readonly Date[] = [NOW, NOW, NOW],
): FileMailboxStore {
  let index = 0;
  return new FileMailboxStore(root, {
    idGenerator: () =>
      ids[index] ??
      (() => {
        throw new Error("unexpected ID");
      })(),
    clock: () => dates[index++] ?? NOW,
  });
}

function messagePath(root: string, recipient: string, state: string, id: string): string {
  return join(root, ".agent_tutorial", "mailboxes", recipient, state, `${id}.json`);
}

describe("chapter 15 mailbox", () => {
  test("validates safe teammate names", () => {
    expect(canonicalAgentName("writer-2")).toBe("writer-2");
    for (const value of ["Lead", "../lead", "lead/other", "nul", "trailing.", "two_words"]) {
      expect(() => canonicalAgentName(value)).toThrow(/safe lowercase slug/);
    }
  });

  test("persists UTF-8 messages and advances ready -> processing -> done", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-mailbox-"));
    try {
      const mailbox = createStore(root, [IDS[0]]);
      const sent = await mailbox.send("lead", "writer", "整理中文资料", MailboxMessageKind.Task);
      const ready = messagePath(root, "writer", MailboxState.Ready, sent.id);
      expect(JSON.parse(await readFile(ready, "utf8"))).toEqual({
        id: sent.id,
        sender: "lead",
        recipient: "writer",
        kind: "task",
        content: "整理中文资料",
        created_at_utc: NOW.toISOString(),
      });
      expect(await mailbox.claim("writer")).toEqual(sent);
      expect(await mailbox.ack(sent)).toBe(true);
      expect(await mailbox.ack(sent)).toBe(true);
      await expect(mailbox.ack(Object.freeze({ ...sent, content: "different" }))).rejects.toThrow(
        /does not match completed/,
      );
      await expect(
        readFile(messagePath(root, "writer", MailboxState.Done, sent.id), "utf8"),
      ).resolves.toContain("整理中文资料");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses creation time and ID for FIFO, restores processing, and isolates bad files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-mailbox-"));
    try {
      const later = new Date(NOW.valueOf() + 1_000);
      const mailbox = createStore(root, [IDS[2], IDS[1], IDS[0]], [later, NOW, NOW]);
      const third = await mailbox.send("lead", "writer", "later", MailboxMessageKind.Message);
      const second = await mailbox.send(
        "lead",
        "writer",
        "same time larger ID",
        MailboxMessageKind.Message,
      );
      const first = await mailbox.send(
        "lead",
        "writer",
        "same time smaller ID",
        MailboxMessageKind.Message,
      );
      const ready = join(root, ".agent_tutorial", "mailboxes", "writer", "ready");
      await writeFile(join(ready, "not-a-uuid.json"), "{", "utf8");

      expect(await mailbox.claim("writer")).toEqual(first);
      expect(await mailbox.claim("writer")).toEqual(second);
      expect(await mailbox.recoverProcessing("writer")).toBe(2);
      expect(await mailbox.claim("writer")).toEqual(first);
      expect(await mailbox.claim("writer")).toEqual(second);
      expect(await mailbox.claim("writer")).toEqual(third);
      await expect(
        readFile(
          join(root, ".agent_tutorial", "mailboxes", "writer", "quarantine", "not-a-uuid.json"),
        ),
      ).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a duplicate ID across mailboxes while preserving legal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-mailbox-"));
    try {
      const first = createStore(root, [IDS[0]]);
      const sent = await first.send("lead", "writer", "one", MailboxMessageKind.Task);
      const collision = createStore(root, [IDS[0]]);
      await expect(
        collision.send("other", "lead", "collision", MailboxMessageKind.Result),
      ).rejects.toThrow(MailboxStorageError);
      expect(await first.claim("writer")).toEqual(sent);
      expect(await first.release(sent)).toBe(true);
      expect(await first.claim("writer")).toEqual(sent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves every concurrent write and grants each ready message to one claimer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-mailbox-"));
    try {
      const ids = Array.from(
        { length: 12 },
        (_value, index) => `00000000-0000-4000-8000-${String(index + 711).padStart(12, "0")}`,
      );
      const sent = await Promise.all(
        ids.map(
          async (id, index) =>
            await createStore(root, [id]).send(
              `sender-${index + 1}`,
              "lead",
              `result ${index + 1}`,
              MailboxMessageKind.Result,
            ),
        ),
      );
      const claimed = await Promise.all(
        ids.map(async () => await new FileMailboxStore(root).claim("lead")),
      );
      expect(
        new Set(claimed.filter((message) => message !== undefined).map((message) => message.id)),
      ).toEqual(new Set(sent.map((message) => message.id)));
      await expect(new FileMailboxStore(root).claim("lead")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows an old consumer to acknowledge a message completed by another runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-mailbox-"));
    try {
      const first = createStore(root, [IDS[0]]);
      const sent = await first.send("writer", "lead", "shared result", MailboxMessageKind.Result);
      expect(await first.claim("lead")).toEqual(sent);

      const second = new FileMailboxStore(root);
      expect(await second.recoverProcessing("lead")).toBe(1);
      expect(await second.claim("lead")).toEqual(sent);
      expect(await second.ack(sent)).toBe(true);
      expect(await first.ack(sent)).toBe(true);
      await expect(first.ack(Object.freeze({ ...sent, content: "conflict" }))).rejects.toThrow(
        /does not match completed/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
