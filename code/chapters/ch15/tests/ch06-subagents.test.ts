import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { buildAgent } from "../src/bootstrap.js";
import { assistantMessage, toolCall, validateToolPairing } from "../src/core/messages.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P06 } from "../src/core/profiles.js";
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from "../src/features/subagents.js";
import { ScriptedModelClient } from "./fakes.js";

class AllowingApproval implements ApprovalProvider {
  readonly requests: PermissionRequest[] = [];

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    this.requests.push(request);
    return new PermissionDecision("allow", "approved by test", "test-approval");
  }
}

class RecordingAudit implements AuditSink {
  readonly records: { readonly tool: string; readonly decision: PermissionDecision }[] = [];

  async record(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    const definition = request.prepared.definition;
    if (definition === undefined) {
      throw new Error("audit request lost its tool definition");
    }
    this.records.push({ tool: definition.name, decision });
  }
}

async function temporaryWorkspace(): Promise<{
  readonly root: string;
  readonly workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch06-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace };
}

describe("chapter 6 subagent integration", () => {
  test("P06 isolates child trajectory while preserving an approved file side effect", async () => {
    const { root, workspace } = await temporaryWorkspace();
    try {
      const approval = new AllowingApproval();
      const audit = new RecordingAudit();
      const parentCall = toolCall(
        "parent-task",
        "task",
        '{"description":" write child.txt with evidence "}',
      );
      const childWrite = toolCall(
        "child-write",
        "write_file",
        '{"path":"child.txt","content":"child evidence"}',
      );
      const model = new ScriptedModelClient([
        { message: assistantMessage(null, [parentCall]), finishReason: "tool_calls" },
        { message: assistantMessage(null, [childWrite]), finishReason: "tool_calls" },
        { message: assistantMessage("child conclusion"), finishReason: "stop" },
        { message: assistantMessage("parent final"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P06, {
        model,
        workspace,
        approvalProvider: approval,
        auditSink: audit,
      });

      const result = await runner.run("delegate the write");

      expect(await readFile(join(workspace, "child.txt"), "utf8")).toBe("child evidence");
      expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
        "task",
      ]);
      expect(model.requests[1]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
      ]);
      expect(model.requests[1]?.messages).toEqual([
        { role: "system", content: DEFAULT_SUBAGENT_SYSTEM_PROMPT },
        { role: "user", content: "write child.txt with evidence" },
      ]);
      expect(result.history).toEqual([
        { role: "user", content: "delegate the write" },
        assistantMessage(null, [parentCall]),
        { role: "tool", content: "child conclusion", toolCallId: "parent-task" },
        assistantMessage("parent final"),
      ]);
      expect(approval.requests.map((request) => request.prepared.call.name)).toEqual([
        "write_file",
      ]);
      expect(audit.records.map((record) => [record.tool, record.decision.behavior])).toEqual([
        ["task", "allow"],
        ["write_file", "allow"],
      ]);
      validateToolPairing(result.history);
      model.assertExhausted();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("child cannot turn approval into a workspace escape", async () => {
    const { root, workspace } = await temporaryWorkspace();
    const outside = join(root, "outside.txt");
    try {
      await writeFile(outside, "sentinel", "utf8");
      const approval = new AllowingApproval();
      const audit = new RecordingAudit();
      const parentCall = toolCall("parent-task", "task", '{"description":"write outside"}');
      const childWrite = toolCall(
        "outside-write",
        "write_file",
        '{"path":"../outside.txt","content":"changed"}',
      );
      const model = new ScriptedModelClient([
        { message: assistantMessage(null, [parentCall]), finishReason: "tool_calls" },
        { message: assistantMessage(null, [childWrite]), finishReason: "tool_calls" },
        { message: assistantMessage("write denied"), finishReason: "stop" },
        { message: assistantMessage("parent final"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P06, {
        model,
        workspace,
        approvalProvider: approval,
        auditSink: audit,
      });

      const result = await runner.run("delegate dangerous work");

      expect(await readFile(outside, "utf8")).toBe("sentinel");
      expect(approval.requests).toEqual([]);
      expect(audit.records.map((record) => [record.tool, record.decision.behavior])).toEqual([
        ["task", "allow"],
        ["write_file", "deny"],
      ]);
      expect(model.requests[2]?.messages.at(-1)).toEqual({
        role: "tool",
        content: "Error [permission_denied]: Writing outside the workspace is forbidden",
        toolCallId: "outside-write",
      });
      expect(result.history[2]).toEqual({
        role: "tool",
        content: "write denied",
        toolCallId: "parent-task",
      });
      validateToolPairing(result.history);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
