import { describe, expect, test } from "vitest";

import { PermissionPolicy } from "../src/core/permissions.js";
import type { ProtocolMailboxStore } from "../src/features/mailbox.js";
import { ProtocolRuntime } from "../src/features/protocol.js";

describe("chapter 16 plan gate", () => {
  test("does not treat pending or rejected plans as permission to perform effects", async () => {
    const requests: Array<{ sender: string; status: "pending" | "approved" | "rejected" }> = [];
    const store = {
      async createRequest() {
        throw new Error("not used");
      },
      async getRequest() {
        throw new Error("not used");
      },
      async listRequests() {
        return [];
      },
      async getPendingRequest() {
        throw new Error("not used");
      },
      async latestPlanRequest(sender: string) {
        const request = requests.find((item) => item.sender === sender);
        return request === undefined ? undefined : ({ status: request.status } as never);
      },
      async validateRequest() {
        throw new Error("not used");
      },
      async validateResponse() {
        throw new Error("not used");
      },
      async consumeResponse() {
        throw new Error("not used");
      },
    };
    const team = {
      mailboxStore: {
        sendProtocol: async () => {
          throw new Error("not used");
        },
      } as unknown as ProtocolMailboxStore,
      state: () => ({ status: "idle" as const }),
      beginShutdown: () => undefined,
      deliverProtocol: async () => {
        throw new Error("not used");
      },
    };
    const protocol = new ProtocolRuntime({ store, team });
    expect(await protocol.planAllowsEffectful("alice")).toBe(true);
    requests.push({ sender: "alice", status: "pending" });
    expect(await protocol.planAllowsEffectful("alice")).toBe(false);
    const plan = requests[0];
    if (plan === undefined) throw new Error("plan was not recorded");
    plan.status = "rejected";
    expect(await protocol.planAllowsEffectful("alice")).toBe(false);
    plan.status = "approved";
    expect(await protocol.planAllowsEffectful("alice")).toBe(true);
    expect(new PermissionPolicy().withRules([protocol.planGateRule])).toBeInstanceOf(
      PermissionPolicy,
    );
  });
});
