import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { buildAgent } from "../src/bootstrap.js";
import { assistantMessage, toolCall, validateToolPairing } from "../src/core/messages.js";
import type { ModelReply } from "../src/core/model.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P05 } from "../src/core/profiles.js";
import { TODO_STALE_REMINDER } from "../src/features/todos.js";
import { ScriptedModelClient } from "./fakes.js";

class UnexpectedApproval implements ApprovalProvider {
  readonly requests: PermissionRequest[] = [];

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    this.requests.push(request);
    throw new Error("todo_write and reads must not request approval");
  }
}

class RecordingAudit implements AuditSink {
  readonly decisions: PermissionDecision[] = [];

  async record(_request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.decisions.push(decision);
  }
}

async function temporaryWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-tutorial-ch05-"));
}

describe("chapter 5 TODO integration", () => {
  test("P05 exposes todo_write and returns a complete audited snapshot without approval", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const approval = new UnexpectedApproval();
      const audit = new RecordingAudit();
      const model = new ScriptedModelClient([
        {
          message: assistantMessage(null, [
            toolCall(
              "todo-1",
              "todo_write",
              JSON.stringify({
                todos: [
                  { content: "  编写测试  ", status: "in_progress" },
                  { content: "ship", status: "completed" },
                ],
              }),
            ),
          ]),
          finishReason: "tool_calls",
        },
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P05, {
        model,
        workspace,
        approvalProvider: approval,
        auditSink: audit,
      });

      const result = await runner.run("plan the work");

      expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
      ]);
      expect(model.requests[0]?.messages[0]?.content).toContain(
        "call todo_write with the complete task snapshot",
      );
      expect(approval.requests).toEqual([]);
      expect(audit.decisions).toEqual([
        new PermissionDecision("allow", "No permission rule blocked the request", "default"),
      ]);
      expect(result.history[2]).toEqual({
        role: "tool",
        content:
          '{"todos":[{"content":"\\u7f16\\u5199\\u6d4b\\u8bd5","status":"in_progress"},{"content":"ship","status":"completed"}]}',
        toolCallId: "todo-1",
      });
      validateToolPairing(result.history);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("the third stale tool round injects one request-only reminder", async () => {
    const workspace = await temporaryWorkspace();
    try {
      await writeFile(join(workspace, "note.txt"), "safe read", "utf8");
      const replies: ModelReply[] = [1, 2, 3, 4].map((index) => ({
        message: assistantMessage(null, [
          toolCall(`read-${index}`, "read_file", '{"path":"note.txt"}'),
        ]),
        finishReason: "tool_calls",
      }));
      replies.push({ message: assistantMessage("done"), finishReason: "stop" });
      const model = new ScriptedModelClient(replies);
      const runner = buildAgent(P05, {
        model,
        workspace,
        approvalProvider: new UnexpectedApproval(),
        auditSink: new RecordingAudit(),
      });

      const result = await runner.run("read repeatedly");

      expect(model.requests).toHaveLength(5);
      for (const request of model.requests.slice(0, 3)) {
        expect(request.messages.some((message) => message.content === TODO_STALE_REMINDER)).toBe(
          false,
        );
      }
      expect(
        model.requests[3]?.messages.filter(
          (message) => message.role === "system" && message.content === TODO_STALE_REMINDER,
        ),
      ).toEqual([{ role: "system", content: TODO_STALE_REMINDER }]);
      expect(
        model.requests[4]?.messages.some((message) => message.content === TODO_STALE_REMINDER),
      ).toBe(false);
      expect(result.history.some((message) => message.content === TODO_STALE_REMINDER)).toBe(false);
      expect(result.history.filter((message) => message.role === "tool")).toHaveLength(4);
      validateToolPairing(result.history);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
