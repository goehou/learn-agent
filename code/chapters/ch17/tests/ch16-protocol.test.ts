import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonProtocolStore } from "../src/adapters/protocol-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { createProtocolMailboxMessage, ProtocolMessageKind } from "../src/features/mailbox.js";
import {
  ProtocolExpiredError,
  ProtocolMismatchError,
  ProtocolNotFoundError,
  ProtocolDeliveryError,
  ProtocolRequestKind,
  ProtocolRequestStatus,
  ProtocolStorageError,
  ProtocolRuntime,
  ProtocolStateError,
} from "../src/features/protocol.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000000801";
const RESPONSE_ID = "00000000-0000-4000-8000-000000000802";
const NOW = new Date("2026-07-30T08:00:00.000Z");

describe("chapter 16 protocol store", () => {
  test("records before delivery, validates typed messages, and consumes a response once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-protocol-"));
    try {
      const store = new JsonProtocolStore(root, {
        idGenerator: () => REQUEST_ID,
        clock: () => NOW,
      });
      const request = await store.createRequest({
        kind: ProtocolRequestKind.PlanApproval,
        sender: "alice",
        target: "lead",
        content: "write the file",
      });
      expect(await store.getRequest(request.id)).toEqual(request);
      expect(await store.listRequests()).toEqual([request]);
      const response = createProtocolMailboxMessage({
        id: RESPONSE_ID,
        sender: "lead",
        recipient: "alice",
        kind: ProtocolMessageKind.PlanApprovalResponse,
        content: "approved",
        createdAtUtc: NOW,
        requestId: request.id,
        approved: true,
      });
      await expect(
        store.validateResponse({ ...response, recipient: "bob" }),
      ).rejects.toBeInstanceOf(ProtocolMismatchError);
      const resolved = await store.consumeResponse(response);
      expect(resolved.status).toBe(ProtocolRequestStatus.Approved);
      expect(resolved.resolution?.messageId).toBe(RESPONSE_ID);
      await expect(store.consumeResponse(response)).resolves.toEqual(resolved);
      await expect(
        store.consumeResponse({ ...response, content: "tampered" }),
      ).rejects.toBeInstanceOf(ProtocolStateError);
      expect(
        JSON.parse(await readFile(join(root, ".agent_tutorial", "protocol", "state.json"), "utf8")),
      ).toMatchObject({
        version: 1,
        requests: [{ id: REQUEST_ID, status: "approved" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects expired requests and missing ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-protocol-"));
    try {
      let now = NOW;
      const store = new JsonProtocolStore(root, {
        idGenerator: () => REQUEST_ID,
        clock: () => now,
        requestTtlMs: 1_000,
      });
      const request = await store.createRequest({
        kind: ProtocolRequestKind.Shutdown,
        sender: "lead",
        target: "alice",
        content: "shutdown",
      });
      now = new Date(NOW.valueOf() + 1_000);
      const message = createProtocolMailboxMessage({
        id: RESPONSE_ID,
        sender: "alice",
        recipient: "lead",
        kind: ProtocolMessageKind.ShutdownResponse,
        content: "ready",
        createdAtUtc: now,
        requestId: request.id,
        approved: true,
      });
      await expect(store.consumeResponse(message)).rejects.toBeInstanceOf(ProtocolExpiredError);
      await expect(store.getRequest("not-a-uuid")).rejects.toBeInstanceOf(ProtocolNotFoundError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects strict snapshot extras and wraps invalid id generators", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-protocol-"));
    try {
      const store = new JsonProtocolStore(root, {
        idGenerator: () => REQUEST_ID,
        clock: () => NOW,
      });
      await store.createRequest({
        kind: ProtocolRequestKind.Shutdown,
        sender: "lead",
        target: "alice",
        content: "shutdown",
      });
      const statePath = join(root, ".agent_tutorial", "protocol", "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      state.extra = true;
      await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
      await expect(store.listRequests()).rejects.toBeInstanceOf(ProtocolStorageError);
      await expect(
        new JsonProtocolStore(root, { idGenerator: () => "bad", clock: () => NOW }).createRequest({
          kind: ProtocolRequestKind.Shutdown,
          sender: "lead",
          target: "bob",
          content: "shutdown",
        }),
      ).rejects.toBeInstanceOf(ProtocolStorageError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a registered request pending when protocol delivery fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-protocol-"));
    try {
      const mailbox = new FileMailboxStore(root);
      const store = new JsonProtocolStore(root, {
        idGenerator: () => REQUEST_ID,
        clock: () => NOW,
      });
      const protocol = new ProtocolRuntime({
        store,
        team: {
          mailboxStore: mailbox,
          state: () => ({ status: "idle" as const }),
          beginShutdown: () => undefined,
          deliverProtocol: async () => {
            throw new Error("disk full");
          },
        },
      });
      await expect(protocol.requestShutdown("alice")).rejects.toBeInstanceOf(ProtocolDeliveryError);
      expect((await store.getRequest(REQUEST_ID)).status).toBe(ProtocolRequestStatus.Pending);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
