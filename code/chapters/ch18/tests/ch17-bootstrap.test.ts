import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { JsonProtocolStore } from "../src/adapters/protocol-json.js";
import { JsonTaskStore } from "../src/adapters/task-json.js";
import { SqliteTaskStore } from "../src/adapters/task-sqlite.js";
import { buildAgent } from "../src/bootstrap.js";
import { EventInbox } from "../src/core/events.js";
import { assistantMessage } from "../src/core/messages.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P17 } from "../src/core/profiles.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import { ProtocolRuntime } from "../src/features/protocol.js";
import { RecoveryConfig } from "../src/features/recovery.js";
import { TeammateRuntime } from "../src/features/teammates.js";
import { WorkStealingRuntime } from "../src/features/work-stealing.js";
import { ScriptedModelClient } from "./fakes.js";

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test", "test");
  }
}
class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 17 bootstrap", () => {
  test("requires one shared SQLite work-stealing runtime and rejects the JSON task store", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-bootstrap-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-31T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const workStealing = new WorkStealingRuntime({ store: new SqliteTaskStore(root) });
    const common = {
      workspace: root,
      recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
      backgroundSupervisor: supervisor,
      cronRuntime: cron,
      teammateRuntime: teammates,
      protocolRuntime: protocol,
      workStealingRuntime: workStealing,
      approvalProvider: new AllowApproval(),
      auditSink: new NoopAudit(),
    } as const;
    try {
      const { workStealingRuntime: _workStealingRuntime, ...withoutWorkStealing } = common;
      expect(() =>
        buildAgent(P17, {
          ...withoutWorkStealing,
          model: new ScriptedModelClient([]),
        }),
      ).toThrow(/workStealingRuntime/);
      expect(() =>
        buildAgent(P17, {
          ...common,
          model: new ScriptedModelClient([]),
          taskStore: new JsonTaskStore(root),
        }),
      ).toThrow(/taskStore/);
      const model = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P17, { ...common, model });
      await runner.run("inspect");
      const complete = model.requests[0]?.tools.find(
        (tool) => tool.function.name === "complete_task",
      );
      expect(complete?.function.parameters).toMatchObject({
        required: expect.arrayContaining(["task_id", "claim_token"]),
      });
      expect(teammates.workStealingRuntime).toBe(workStealing);
      await runner.close();
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
