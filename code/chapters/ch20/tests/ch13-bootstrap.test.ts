import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonTaskStore } from "../src/adapters/task-json.js";
import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { buildAgent } from "../src/bootstrap.js";
import { EventInbox } from "../src/core/events.js";
import { assistantMessage } from "../src/core/messages.js";
import { P12, P13 } from "../src/core/profiles.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { RecoveryConfig } from "../src/features/recovery.js";
import { JobSupervisor } from "../src/features/background.js";
import { ScriptedModelClient } from "./fakes.js";

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test", "test");
  }
}

class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 13 bootstrap", () => {
  test("requires a background supervisor and adds only the shell flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch13-bootstrap-"));
    try {
      const recoveryConfig = new RecoveryConfig({
        primaryModel: "primary",
        fallbackModel: "fallback",
      });
      const common = {
        workspace: root,
        recoveryConfig,
        taskStore: new JsonTaskStore(root),
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      };
      const model12 = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      expect(() => buildAgent(P13, { ...common, model: model12 })).toThrow(/backgroundSupervisor/);
      const supervisor = new JobSupervisor({
        store: new JsonBackgroundJobStore(root),
        inbox: new EventInbox(),
      });
      const model13 = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P13, {
        ...common,
        model: model13,
        backgroundSupervisor: supervisor,
      });
      await runner.run("inspect");
      const shell = model13.requests[0]?.tools.find((tool) => tool.function.name === "shell");
      const parameters = shell?.function.parameters as { properties?: Record<string, unknown> };
      const properties = parameters.properties;
      expect(properties).toHaveProperty("run_in_background");
      expect(properties?.run_in_background).toMatchObject({ default: null });
      await runner.close();
      expect(supervisor.activeCount).toBe(0);
      expect(P12.capabilities.has("background")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
