import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { P07 } from "../src/core/profiles.js";
import { ScriptedModelClient } from "./fakes.js";

class UnexpectedApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    throw new Error("load_skill should not request approval");
  }
}

class RecordingAudit implements AuditSink {
  readonly tools: string[] = [];

  async record(request: PermissionRequest, _decision: PermissionDecision): Promise<void> {
    const definition = request.prepared.definition;
    if (definition === undefined) {
      throw new Error("audit request lost its tool definition");
    }
    this.tools.push(definition.name);
  }
}

async function temporaryWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-tutorial-ch07-"));
}

async function writeSkill(workspace: string): Promise<void> {
  const directory = join(workspace, "skills", "python-style");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: python-style\ndescription: Python project conventions\n---\n# Python Style\n\nUse pathlib for filesystem paths.\n",
    "utf8",
  );
}

describe("chapter 7 skills integration", () => {
  test("P07 explains when the workspace has no available Skills", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const model = new ScriptedModelClient([
        { message: assistantMessage("no skills"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P07, {
        model,
        workspace,
        approvalProvider: new UnexpectedApproval(),
        auditSink: new RecordingAudit(),
      });

      await runner.run("list available skills");

      expect(model.requests[0]?.messages[0]?.content).toContain(
        "(No workspace Skills are currently available.)",
      );
      model.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("P07 exposes an eager catalog and returns the body only after load_skill", async () => {
    const workspace = await temporaryWorkspace();
    try {
      await writeSkill(workspace);
      const loadSkill = toolCall("skill-1", "load_skill", '{"name":"python-style"}');
      const model = new ScriptedModelClient([
        { message: assistantMessage(null, [loadSkill]), finishReason: "tool_calls" },
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const audit = new RecordingAudit();
      const runner = buildAgent(P07, {
        model,
        workspace,
        approvalProvider: new UnexpectedApproval(),
        auditSink: audit,
      });

      const result = await runner.run("load the skill");

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
      const initialPrompt = model.requests[0]?.messages[0]?.content;
      expect(initialPrompt).toContain("python-style");
      expect(initialPrompt).toContain("Python project conventions");
      expect(initialPrompt).not.toContain("Use pathlib");
      expect(result.history[2]).toEqual({
        role: "tool",
        content: "# Python Style\n\nUse pathlib for filesystem paths.\n",
        toolCallId: "skill-1",
      });
      expect(audit.tools).toEqual(["load_skill"]);
      validateToolPairing(result.history);
      model.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("P07 subagent can load skills but cannot recursively delegate", async () => {
    const workspace = await temporaryWorkspace();
    try {
      await writeSkill(workspace);
      const parentTask = toolCall("task-1", "task", '{"description":"load the style"}');
      const childLoad = toolCall("child-skill", "load_skill", '{"name":"python-style"}');
      const model = new ScriptedModelClient([
        { message: assistantMessage(null, [parentTask]), finishReason: "tool_calls" },
        { message: assistantMessage(null, [childLoad]), finishReason: "tool_calls" },
        { message: assistantMessage("child conclusion"), finishReason: "stop" },
        { message: assistantMessage("parent conclusion"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P07, {
        model,
        workspace,
        approvalProvider: new UnexpectedApproval(),
        auditSink: new RecordingAudit(),
      });

      const result = await runner.run("delegate");

      expect(model.requests[1]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
        "load_skill",
      ]);
      expect(model.requests[1]?.messages[0]?.content).not.toContain("python-style");
      expect(model.requests[2]?.messages.at(-1)).toEqual({
        role: "tool",
        content: "# Python Style\n\nUse pathlib for filesystem paths.\n",
        toolCallId: "child-skill",
      });
      expect(result.history[2]).toEqual({
        role: "tool",
        content: "child conclusion",
        toolCallId: "task-1",
      });
      validateToolPairing(result.history);
      model.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
