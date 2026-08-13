import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonTaskStore } from "../src/adapters/task-json.js";
import { buildAgent } from "../src/bootstrap.js";
import { assistantMessage } from "../src/core/messages.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P11, P12 } from "../src/core/profiles.js";
import { RecoveryConfig } from "../src/features/recovery.js";
import { ScriptedModelClient } from "./fakes.js";

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test", "test");
  }
}

class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 12 bootstrap", () => {
  test("requires a JSON TaskStore only for the Task DAG profile and appends five tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch12-bootstrap-"));
    try {
      const recoveryConfig = new RecoveryConfig({
        primaryModel: "primary",
        fallbackModel: "fallback",
      });
      const model = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const common = {
        model,
        workspace,
        recoveryConfig,
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      };
      const store = new JsonTaskStore(workspace);

      expect(() => buildAgent(P11, { ...common, taskStore: store })).toThrow(/taskStore/);
      expect(() => buildAgent(P12, common)).toThrow(/taskStore/);

      const runner = buildAgent(P12, { ...common, taskStore: store });
      await runner.run("inspect tools");
      expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
        "task",
        "load_skill",
        "create_task",
        "get_task",
        "list_tasks",
        "claim_task",
        "complete_task",
      ]);
      model.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
