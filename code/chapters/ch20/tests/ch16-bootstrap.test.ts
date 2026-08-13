import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { JsonTaskStore } from "../src/adapters/task-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { JsonProtocolStore } from "../src/adapters/protocol-json.js";
import { buildAgent } from "../src/bootstrap.js";
import { EventInbox } from "../src/core/events.js";
import { assistantMessage } from "../src/core/messages.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P16 } from "../src/core/profiles.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import { ProtocolRuntime } from "../src/features/protocol.js";
import { RecoveryConfig } from "../src/features/recovery.js";
import { TeammateRuntime } from "../src/features/teammates.js";
import { ScriptedModelClient } from "./fakes.js";

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test", "test");
  }
}
class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 16 bootstrap", () => {
  test("requires a shared protocol runtime and exposes the protocol tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-bootstrap-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-30T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({
      store: new JsonProtocolStore(root),
      team: teammates,
    });
    const common = {
      workspace: root,
      recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
      backgroundSupervisor: supervisor,
      cronRuntime: cron,
      taskStore: new JsonTaskStore(root),
      teammateRuntime: teammates,
      approvalProvider: new AllowApproval(),
      auditSink: new NoopAudit(),
    } as const;
    try {
      expect(() => buildAgent(P16, { ...common, model: new ScriptedModelClient([]) })).toThrow(
        /protocolRuntime/,
      );
      const model = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P16, { ...common, model, protocolRuntime: protocol });
      await runner.run("inspect");
      const names = model.requests[0]?.tools.map((tool) => tool.function.name) ?? [];
      expect(names.slice(-4)).toEqual([
        "spawn_teammate",
        "send_message",
        "request_shutdown",
        "review_plan",
      ]);
      await runner.close();
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a protocol runtime attached to another teammate runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-bootstrap-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date() },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const other = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: other });
    try {
      expect(() =>
        buildAgent(P16, {
          model: new ScriptedModelClient([]),
          workspace: root,
          recoveryConfig: new RecoveryConfig({
            primaryModel: "primary",
            fallbackModel: "fallback",
          }),
          taskStore: new JsonTaskStore(root),
          backgroundSupervisor: supervisor,
          cronRuntime: cron,
          teammateRuntime: teammates,
          protocolRuntime: protocol,
        }),
      ).toThrow(/share the teammate runtime/);
    } finally {
      await teammates.close();
      await other.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
