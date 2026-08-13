import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { buildAgent } from "../src/bootstrap.js";
import { assistantMessage, toolCall, validateToolPairing } from "../src/core/messages.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { PermissionDecision } from "../src/core/permissions.js";
import { P10 } from "../src/core/profiles.js";
import { MemoryRecord, MemoryStore, MemoryType } from "../src/features/memory.js";
import { ScriptedModelClient } from "./fakes.js";

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test approval", "test");
  }
}

class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 10 dynamic prompt integration", () => {
  test("P10 injects selected memory through one dynamic system prompt across tool rounds", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch10-"));
    try {
      await mkdir(join(workspace, "skills", "typescript-style"), { recursive: true });
      await writeFile(
        join(workspace, "skills", "typescript-style", "SKILL.md"),
        "---\nname: typescript-style\ndescription: TypeScript conventions\n---\n# Private body\n",
        "utf8",
      );
      await new MemoryStore({ workspace, idGenerator: () => "memory" }).add(
        new MemoryRecord({
          name: "project-fact",
          description: "Project database rule",
          kind: MemoryType.PROJECT,
          body: "Always use the integration database.",
        }),
      );
      const unknown = toolCall("unknown-1", "missing", "{}");
      const model = new ScriptedModelClient([
        { message: assistantMessage('["project-fact"]'), finishReason: "stop" },
        { message: assistantMessage(null, [unknown]), finishReason: "tool_calls" },
        { message: assistantMessage("done"), finishReason: "stop" },
        { message: assistantMessage("[]"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P10, {
        model,
        workspace,
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      });

      const result = await runner.run("work");

      const firstMain = model.requests[1];
      const secondMain = model.requests[2];
      const prompt = firstMain?.messages[0]?.content;
      expect(result.finalText).toBe("done");
      expect(prompt).toContain("## identity");
      expect(prompt).toContain("## tools");
      expect(prompt).toContain("## workspace");
      expect(prompt).toContain("## skills");
      expect(prompt).toContain("## memory");
      expect(prompt).toContain("Always use the integration database.");
      expect(prompt?.indexOf("## identity")).toBeLessThan(prompt?.indexOf("## tools") ?? -1);
      expect(prompt?.indexOf("## tools")).toBeLessThan(prompt?.indexOf("## workspace") ?? -1);
      expect(prompt?.indexOf("## workspace")).toBeLessThan(prompt?.indexOf("## skills") ?? -1);
      expect(prompt?.indexOf("## skills")).toBeLessThan(prompt?.indexOf("## memory") ?? -1);
      expect(
        firstMain?.messages.filter((message) =>
          (message.content ?? "").includes("<relevant_memories>"),
        ),
      ).toHaveLength(1);
      expect(secondMain?.messages[0]).toEqual(firstMain?.messages[0]);
      expect(firstMain?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
        "task",
        "load_skill",
      ]);
      validateToolPairing(result.history);
      model.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
