import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { buildAgent } from "../src/bootstrap.js";
import { assistantMessage } from "../src/core/messages.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { PermissionDecision } from "../src/core/permissions.js";
import { P09 } from "../src/core/profiles.js";
import { ScriptedModelClient } from "./fakes.js";

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test approval", "test");
  }
}

class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 9 memory integration", () => {
  test("extracts in one agent instance and selects only relevant memory in the next", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch09-"));
    try {
      const firstModel = new ScriptedModelClient([
        { message: assistantMessage("stored"), finishReason: "stop" },
        {
          message: assistantMessage(
            '[{"name":"project-fact","type":"project","description":"Project database rule","body":"Always use the integration database."}]',
          ),
          finishReason: "stop",
        },
      ]);
      const first = buildAgent(P09, {
        model: firstModel,
        workspace,
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      });
      await first.run("remember the database rule");

      const secondModel = new ScriptedModelClient([
        { message: assistantMessage('["project-fact"]'), finishReason: "stop" },
        { message: assistantMessage("used"), finishReason: "stop" },
        { message: assistantMessage("[]"), finishReason: "stop" },
      ]);
      const second = buildAgent(P09, {
        model: secondModel,
        workspace,
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      });
      const result = await second.run("which database should I use?");

      expect(result.finalText).toBe("used");
      expect(
        secondModel.requests[1]?.messages.some((message) =>
          message.content?.includes("Always use the integration database."),
        ),
      ).toBe(true);
      expect(firstModel.requests[1]?.tools).toEqual([]);
      expect(secondModel.requests[0]?.tools).toEqual([]);
      expect(secondModel.requests[2]?.tools).toEqual([]);
      expect(secondModel.requests[1]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
        "task",
        "load_skill",
      ]);
      firstModel.assertExhausted();
      secondModel.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
