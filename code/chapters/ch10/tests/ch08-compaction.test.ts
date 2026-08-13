import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { buildAgent } from "../src/bootstrap.js";
import { assistantMessage, toolCall, validateToolPairing } from "../src/core/messages.js";
import type {
  ApprovalProvider,
  AuditSink,
  PermissionDecision,
  PermissionRequest,
} from "../src/core/permissions.js";
import { P08 } from "../src/core/profiles.js";
import { ScriptedModelClient } from "./fakes.js";

class UnexpectedApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    throw new Error("read_file should not request approval");
  }
}

class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 8 compaction integration", () => {
  test("P08 persists a large completed tool result before the next model request", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch08-"));
    try {
      const content = "甲".repeat(10_001);
      await writeFile(join(workspace, "large.txt"), content, "utf8");
      const model = new ScriptedModelClient([
        {
          message: assistantMessage(null, [
            toolCall("read-large", "read_file", '{"path":"large.txt"}'),
          ]),
          finishReason: "tool_calls",
        },
        { message: assistantMessage("stored"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P08, {
        model,
        workspace,
        approvalProvider: new UnexpectedApproval(),
        auditSink: new NoopAudit(),
      });

      const result = await runner.run("read the large file");

      expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
        "task",
        "load_skill",
      ]);
      const persisted = model.requests[1]?.messages.at(-1);
      expect(persisted?.role).toBe("tool");
      if (persisted?.role !== "tool") {
        throw new Error("expected a persisted tool result");
      }
      expect(persisted.content).toContain("<persisted-tool-result>");
      const relativePath = /^path: (.+)$/m.exec(persisted.content)?.[1];
      expect(relativePath).toMatch(/^\.agent_tutorial\/artifacts\/tool-result-[a-z0-9]+\.txt$/);
      if (relativePath === undefined) {
        throw new Error("persisted result did not include a path");
      }
      expect(await readFile(join(workspace, ...relativePath.split("/")), "utf8")).toBe(content);
      expect(result.history[2]).toEqual(persisted);
      validateToolPairing(result.history);
      model.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
