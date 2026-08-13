import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { JsonTaskStore } from "../src/adapters/task-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { buildAgent } from "../src/bootstrap.js";
import { EventInbox } from "../src/core/events.js";
import { assistantMessage } from "../src/core/messages.js";
import { P14, P15 } from "../src/core/profiles.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
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

describe("chapter 15 bootstrap", () => {
  test("requires a shared teammate runtime and appends only its two lead tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-bootstrap-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date() },
    });
    const runtime = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const common = {
      workspace: root,
      recoveryConfig: new RecoveryConfig({ primaryModel: "p", fallbackModel: "f" }),
      taskStore: new JsonTaskStore(root),
      approvalProvider: new AllowApproval(),
      auditSink: new NoopAudit(),
      backgroundSupervisor: supervisor,
      cronRuntime: cron,
    };
    try {
      expect(() => buildAgent(P15, { ...common, model: new ScriptedModelClient([]) })).toThrow(
        /teammateRuntime/,
      );
      expect(() =>
        buildAgent(P14, {
          ...common,
          model: new ScriptedModelClient([]),
          teammateRuntime: runtime,
        }),
      ).toThrow(/teammateRuntime requires chapter 15/);
      const model = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
        { message: assistantMessage("[]"), finishReason: "stop" },
        { message: assistantMessage("worker done"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P15, { ...common, model, teammateRuntime: runtime });
      await runner.run("inspect");
      expect(model.requests[0]?.tools.map((tool) => tool.function.name).slice(-2)).toEqual([
        "spawn_teammate",
        "send_message",
      ]);
      await runtime.spawn({
        name: "writer",
        role: "writer",
        prompt: "draft the note",
        sender: "lead",
      });
      const result = await runtime.waitForEvents(1);
      expect(result[0]?.toPayload().content).toBe("worker done");
      expect(
        model.requests
          .at(-1)
          ?.tools.map((tool) => tool.function.name)
          .sort(),
      ).toEqual(["read_file", "send_message", "shell", "write_file"]);
      await runtime.acknowledgeEvents(result);
      model.assertExhausted();
      await runner.close();
    } finally {
      await runtime.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
