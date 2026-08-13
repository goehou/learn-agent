import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { NodeWorkspaceFileSystem } from "../src/adapters/filesystem.js";
import { buildAgent } from "../src/bootstrap.js";
import { assistantMessage, toolCall, validateToolPairing } from "../src/core/messages.js";
import type { ModelReply } from "../src/core/model.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P02, P03 } from "../src/core/profiles.js";
import { commandResult, FakeCommandRunner, ScriptedModelClient } from "./fakes.js";

class RecordingApprovalProvider implements ApprovalProvider {
  readonly requests: PermissionRequest[] = [];

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    this.requests.push(request);
    return new PermissionDecision("allow", "approved once", "approval");
  }
}

class RecordingAuditSink implements AuditSink {
  readonly decisions: PermissionDecision[] = [];

  async record(_request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.decisions.push(decision);
  }
}

class FailingAuditSink implements AuditSink {
  async record(): Promise<void> {
    throw new Error("audit backend unavailable");
  }
}

function replies(call: ReturnType<typeof toolCall>, finalText = "done"): readonly ModelReply[] {
  return [
    { message: assistantMessage(null, [call]), finishReason: "tool_calls" },
    { message: assistantMessage(finalText), finishReason: "stop" },
  ];
}

async function temporaryWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-tutorial-ch03-"));
}

describe("chapter 3 permission integration", () => {
  test("requires approval and audit boundaries at the P03 composition root", () => {
    expect(() =>
      buildAgent(P03, {
        model: new ScriptedModelClient([]),
        workspace: process.cwd(),
      }),
    ).toThrow(/approvalProvider is required/);
    expect(() =>
      buildAgent(P03, {
        model: new ScriptedModelClient([]),
        workspace: process.cwd(),
        approvalProvider: new RecordingApprovalProvider(),
      }),
    ).toThrow(/auditSink is required/);
  });

  test.each([
    { profile: P02, approvalCount: 0, auditCount: 0 },
    { profile: P03, approvalCount: 1, auditCount: 1 },
  ])(
    "P03 alone adds workspace-write approval and audit",
    async ({ profile, approvalCount, auditCount }) => {
      const workspace = await temporaryWorkspace();
      try {
        const fileSystem = new NodeWorkspaceFileSystem();
        const approval = new RecordingApprovalProvider();
        const audit = new RecordingAuditSink();
        const model = new ScriptedModelClient(
          replies(
            toolCall("write-1", "write_file", '{"path":"note.txt","content":"chapter three"}'),
          ),
        );
        const runner = buildAgent(profile, {
          model,
          workspace,
          fileSystem,
          commandRunner: new FakeCommandRunner(commandResult("unused")),
          approvalProvider: approval,
          auditSink: audit,
        });

        const result = await runner.run("write a note");

        await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("chapter three");
        expect(approval.requests).toHaveLength(approvalCount);
        if (profile === P03) {
          expect(approval.requests[0]?.proposedDecision?.behavior).toBe("ask");
        }
        expect(audit.decisions).toHaveLength(auditCount);
        if (profile === P03) {
          expect(audit.decisions[0]).toEqual(
            new PermissionDecision("allow", "approved once", "approval"),
          );
        }
        expect(result.history[2]).toEqual({
          role: "tool",
          content: "Wrote 13 UTF-8 bytes to note.txt",
          toolCallId: "write-1",
        });
        validateToolPairing(result.history);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test("P02 keeps file-handler path errors instead of applying the P03 boundary", async () => {
    const workspace = await temporaryWorkspace();
    const outsideName = `${workspace.split(/[\\/]/u).at(-1)}-outside.txt`;
    const outside = join(workspace, "..", outsideName);
    try {
      const approval = new RecordingApprovalProvider();
      const audit = new RecordingAuditSink();
      const model = new ScriptedModelClient(
        replies(
          toolCall(
            "outside-p02",
            "write_file",
            JSON.stringify({ path: `../${outsideName}`, content: "must not write" }),
          ),
          "rejected by file handler",
        ),
      );
      const runner = buildAgent(P02, {
        model,
        workspace,
        fileSystem: new NodeWorkspaceFileSystem(),
        approvalProvider: approval,
        auditSink: audit,
      });

      const result = await runner.run("write outside");

      expect(approval.requests).toEqual([]);
      expect(audit.decisions).toEqual([]);
      await expect(readFile(outside, "utf8")).rejects.toThrow();
      expect(result.history[2]).toEqual({
        role: "tool",
        content: `Error [path_escape]: path must not contain parent segments: ../${outsideName}`,
        toolCallId: "outside-p02",
      });
      validateToolPairing(result.history);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  test("an outside write is denied before approval and leaves the external file absent", async () => {
    const workspace = await temporaryWorkspace();
    const outsideName = `${workspace.split(/[\\/]/u).at(-1)}-outside.txt`;
    const outside = join(workspace, "..", outsideName);
    try {
      const fileSystem = new NodeWorkspaceFileSystem();
      const approval = new RecordingApprovalProvider();
      const audit = new RecordingAuditSink();
      const model = new ScriptedModelClient(
        replies(
          toolCall(
            "outside-1",
            "write_file",
            JSON.stringify({ path: `../${outsideName}`, content: "must not write" }),
          ),
          "denied",
        ),
      );
      const runner = buildAgent(P03, {
        model,
        workspace,
        fileSystem,
        approvalProvider: approval,
        auditSink: audit,
      });

      const result = await runner.run("write outside");

      expect(approval.requests).toEqual([]);
      expect(audit.decisions).toEqual([
        new PermissionDecision(
          "deny",
          "Writing outside the workspace is forbidden",
          "workspace-boundary",
        ),
      ]);
      await expect(readFile(outside, "utf8")).rejects.toThrow();
      expect(result.history[2]).toEqual({
        role: "tool",
        content: "Error [permission_denied]: Writing outside the workspace is forbidden",
        toolCallId: "outside-1",
      });
      validateToolPairing(result.history);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  test("ordinary reads pass without approval", async () => {
    const workspace = await temporaryWorkspace();
    try {
      await writeFile(join(workspace, "note.txt"), "safe read", "utf8");
      const fileSystem = new NodeWorkspaceFileSystem();
      const approval = new RecordingApprovalProvider();
      const audit = new RecordingAuditSink();
      const model = new ScriptedModelClient(
        replies(toolCall("read-1", "read_file", '{"path":"note.txt"}')),
      );
      const runner = buildAgent(P03, {
        model,
        workspace,
        fileSystem,
        approvalProvider: approval,
        auditSink: audit,
      });

      const result = await runner.run("read note");

      expect(approval.requests).toEqual([]);
      expect(audit.decisions).toEqual([
        new PermissionDecision("allow", "No permission rule blocked the request", "default"),
      ]);
      expect(result.history[2]).toEqual({
        role: "tool",
        content: "safe read",
        toolCallId: "read-1",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("permission-boundary failures return a paired error and skip the handler", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const fileSystem = new NodeWorkspaceFileSystem();
      const model = new ScriptedModelClient(
        replies(toolCall("write-1", "write_file", '{"path":"note.txt","content":"unsafe"}')),
      );
      const runner = buildAgent(P03, {
        model,
        workspace,
        fileSystem,
        approvalProvider: new RecordingApprovalProvider(),
        auditSink: new FailingAuditSink(),
      });

      const result = await runner.run("write note");

      await expect(readFile(join(workspace, "note.txt"), "utf8")).rejects.toThrow();
      expect(result.history[2]).toEqual({
        role: "tool",
        content: "Error [permission_evaluation_error]: Permission evaluation failed",
        toolCallId: "write-1",
      });
      validateToolPairing(result.history);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
