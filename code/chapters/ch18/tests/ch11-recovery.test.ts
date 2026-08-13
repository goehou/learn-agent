import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { buildAgent } from "../src/bootstrap.js";
import { assistantMessage, userMessage } from "../src/core/messages.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P10, P11 } from "../src/core/profiles.js";
import { ModelPromptTooLongError } from "../src/core/model.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
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

class ActionModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #actions: (ModelReply | Error)[];

  constructor(actions: readonly (ModelReply | Error)[]) {
    this.#actions = [...actions];
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const action = this.#actions.shift();
    if (action === undefined) {
      throw new Error("unexpected model request");
    }
    if (action instanceof Error) {
      throw action;
    }
    return action;
  }

  assertExhausted(): void {
    expect(this.#actions).toEqual([]);
  }
}

describe("chapter 11 recovery integration", () => {
  test("requires recovery configuration only for P11 and recovers without polluting canonical history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch11-"));
    try {
      const config = new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" });
      expect(() =>
        buildAgent(P10, {
          model: new ScriptedModelClient([]),
          workspace,
          recoveryConfig: config,
        }),
      ).toThrow(/chapter 11/);
      expect(() => buildAgent(P11, { model: new ScriptedModelClient([]), workspace })).toThrow(
        /recoveryConfig/,
      );

      const model = new ScriptedModelClient([
        { message: assistantMessage("discarded"), finishReason: "length" },
        { message: assistantMessage("done"), finishReason: "stop" },
        { message: assistantMessage("[]"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P11, {
        model,
        workspace,
        recoveryConfig: config,
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      });

      const result = await runner.run("work");

      const mainRequests = model.requests.filter((request) => request.tools.length > 0);
      expect(result.finalText).toBe("done");
      expect(result.history).toEqual([userMessage("work"), assistantMessage("done")]);
      expect(mainRequests.map((request) => request.maxTokens)).toEqual([8_000, 64_000]);
      expect(mainRequests.map((request) => request.model)).toEqual(["primary", "primary"]);
      model.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("uses the raw model for a prompt-too-long compaction summary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch11-compaction-"));
    try {
      const summary = JSON.stringify({
        current_goal: "finish work",
        key_findings: [],
        files_read_or_changed: [],
        remaining_work: ["retry"],
        user_constraints: [],
      });
      const model = new ActionModel([
        new ModelPromptTooLongError("too long"),
        { message: assistantMessage(summary), finishReason: "stop" },
        { message: assistantMessage("done"), finishReason: "stop" },
        { message: assistantMessage("[]"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P11, {
        model,
        workspace,
        recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      });

      await expect(runner.run("work")).resolves.toMatchObject({ finalText: "done" });

      expect(model.requests).toHaveLength(4);
      expect(model.requests[0]?.tools).not.toHaveLength(0);
      expect(model.requests[1]?.tools).toEqual([]);
      expect(model.requests[1]?.model).toBeUndefined();
      expect(model.requests[1]?.maxTokens).toBeUndefined();
      expect(model.requests[2]?.tools).not.toHaveLength(0);
      expect(model.requests[2]?.model).toBe("primary");
      expect(model.requests[2]?.maxTokens).toBe(8_000);
      model.assertExhausted();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
