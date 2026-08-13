import { describe, expect, test } from "vitest";
import { z } from "zod";

import { buildAgent } from "../src/bootstrap.js";
import { HookRegistry, HookResult } from "../src/core/hooks.js";
import { AgentRunner } from "../src/core/loop.js";
import {
  assistantMessage,
  systemMessage,
  toolCall,
  validateToolPairing,
} from "../src/core/messages.js";
import type { ModelReply } from "../src/core/model.js";
import { PermissionDecision, PermissionPolicy, PermissionRule } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { P03, P04 } from "../src/core/profiles.js";
import { ToolRegistry, toolError, toolSuccess } from "../src/core/tools.js";
import type { ToolContext, ToolResult } from "../src/core/tools.js";
import { ScriptedModelClient } from "./fakes.js";

const valueSchema = z.object({ value: z.number().int() }).strict();

function registryWithHandler(
  handler: (input: { readonly value: number }, context: ToolContext) => ToolResult,
): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "work",
    description: "Perform deterministic test work.",
    inputSchema: valueSchema,
    effect: "read",
    handler,
  });
  return tools;
}

function replies(calls: readonly ReturnType<typeof toolCall>[], finalText = "done"): ModelReply[] {
  return [
    { message: assistantMessage(null, calls), finishReason: "tool_calls" },
    { message: assistantMessage(finalText), finishReason: "stop" },
  ];
}

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "approved", "test-approval");
  }
}

class RecordingAudit implements AuditSink {
  readonly decisions: PermissionDecision[] = [];

  async record(_request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.decisions.push(decision);
  }
}

describe("chapter 4 hook integration", () => {
  test("runs UserPrompt, Pre, permission, handler, Post, and Stop in fixed order", async () => {
    const trace: string[] = [];
    const hooks = new HookRegistry();
    hooks.register("UserPromptSubmit", () => {
      trace.push("user");
      return new HookResult({ additionalContext: [systemMessage("hook context")] });
    });
    hooks.register("PreToolUse", () => {
      trace.push("pre");
      return new HookResult({ permissionBehavior: "allow" });
    });
    hooks.register("PostToolUse", () => {
      trace.push("post");
      return new HookResult({ updatedOutput: toolSuccess("rewritten") });
    });
    hooks.register("Stop", () => {
      trace.push("stop");
      return new HookResult();
    });
    const policy = new PermissionPolicy({
      rules: [
        new PermissionRule({
          name: "record-policy",
          behavior: "allow",
          reason: "test allows this read",
          matches: () => {
            trace.push("permission");
            return true;
          },
        }),
      ],
    });
    const tools = registryWithHandler(({ value }) => {
      trace.push("handler");
      return toolSuccess(String(value));
    });
    const model = new ScriptedModelClient(replies([toolCall("call-1", "work", '{"value":42}')]));
    const runner = new AgentRunner({
      model,
      tools,
      hooks,
      permissionPolicy: policy,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(trace).toEqual(["user", "pre", "permission", "handler", "post", "stop"]);
    expect(model.requests[0]?.messages).toEqual([
      systemMessage("system"),
      { role: "user", content: "go" },
      systemMessage("hook context"),
    ]);
    expect(result.history[3]).toEqual({
      role: "tool",
      content: "rewritten",
      toolCallId: "call-1",
    });
    validateToolPairing(result.history);
  });

  test("mutating Hook-owned return objects cannot change model history or tool output", async () => {
    const rawContext = { role: "system", content: "safe context" } as const;
    const rawOutput: ToolResult = { content: "safe output", isError: false };
    const hooks = new HookRegistry();
    hooks.register("UserPromptSubmit", () => {
      const result = new HookResult({ additionalContext: [rawContext] });
      Reflect.set(rawContext, "role", "assistant");
      Reflect.set(rawContext, "content", "mutated context");
      return result;
    });
    hooks.register("PostToolUse", () => {
      const result = new HookResult({ updatedOutput: rawOutput });
      Reflect.set(rawOutput, "content", "mutated output");
      Reflect.set(rawOutput, "isError", true);
      return result;
    });
    const model = new ScriptedModelClient(replies([toolCall("call-1", "work", '{"value":1}')]));
    const runner = new AgentRunner({
      model,
      tools: registryWithHandler(() => toolSuccess("handler output")),
      hooks,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(model.requests[0]?.messages).toEqual([
      systemMessage("system"),
      { role: "user", content: "go" },
      systemMessage("safe context"),
    ]);
    expect(result.history[3]).toEqual({
      role: "tool",
      content: "safe output",
      toolCallId: "call-1",
    });
    validateToolPairing(result.history);
  });

  test("system deny beats Hook allow and skips handler and PostToolUse", async () => {
    const trace: string[] = [];
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", () => {
      trace.push("pre");
      return new HookResult({ permissionBehavior: "allow" });
    });
    hooks.register("PostToolUse", () => {
      trace.push("post");
      return new HookResult();
    });
    const policy = new PermissionPolicy({
      rules: [
        new PermissionRule({
          name: "hard-deny",
          behavior: "deny",
          reason: "blocked by system policy",
          matches: () => {
            trace.push("permission");
            return true;
          },
        }),
      ],
    });
    const tools = registryWithHandler(() => {
      trace.push("handler");
      return toolSuccess("unsafe");
    });
    const runner = new AgentRunner({
      model: new ScriptedModelClient(replies([toolCall("call-1", "work", '{"value":1}')])),
      tools,
      hooks,
      permissionPolicy: policy,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(trace).toEqual(["pre", "permission"]);
    expect(result.history[2]).toEqual({
      role: "tool",
      content: "Error [permission_denied]: blocked by system policy",
      toolCallId: "call-1",
    });
    validateToolPairing(result.history);
  });

  test("PreToolUse can replace validated arguments without replacing the tool", async () => {
    const handled: number[] = [];
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", (context) => {
      const prepared = context.prepared;
      if (prepared === undefined) {
        throw new Error("missing prepared call");
      }
      return new HookResult({
        updatedInput: {
          ...prepared,
          call: toolCall(prepared.call.id, prepared.call.name, '{"value":2}'),
          arguments: { value: 2 },
        },
      });
    });
    const runner = new AgentRunner({
      model: new ScriptedModelClient(replies([toolCall("call-1", "work", '{"value":1}')])),
      tools: registryWithHandler(({ value }) => {
        handled.push(value);
        return toolSuccess(`value=${value}`);
      }),
      hooks,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(handled).toEqual([2]);
    expect(result.history[2]).toEqual({
      role: "tool",
      content: "value=2",
      toolCallId: "call-1",
    });
  });

  test("an invalid PreToolUse rewrite returns a paired contract error", async () => {
    let handled = false;
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", (context) => {
      const prepared = context.prepared;
      if (prepared === undefined) {
        throw new Error("missing prepared call");
      }
      return new HookResult({
        updatedInput: {
          ...prepared,
          call: toolCall("changed-id", prepared.call.name, prepared.call.arguments),
        },
      });
    });
    const runner = new AgentRunner({
      model: new ScriptedModelClient(replies([toolCall("call-1", "work", '{"value":1}')])),
      tools: registryWithHandler(() => {
        handled = true;
        return toolSuccess("unsafe");
      }),
      hooks,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(handled).toBe(false);
    expect(result.history[2]).toEqual({
      role: "tool",
      content: "Error [hook_contract_error]: PreToolUse hook returned an invalid update",
      toolCallId: "call-1",
    });
    validateToolPairing(result.history);
  });

  test("approval and handler see the same immutable PreToolUse rewrite", async () => {
    const rewrittenArguments = { value: 2 };
    const approvalValues: unknown[] = [];
    const handled: number[] = [];
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", (context) => {
      const prepared = context.prepared;
      if (prepared === undefined) {
        throw new Error("missing prepared call");
      }
      return new HookResult({
        permissionBehavior: "ask",
        updatedInput: {
          ...prepared,
          call: toolCall(prepared.call.id, prepared.call.name, '{"value":2}'),
          arguments: rewrittenArguments,
        },
      });
    });
    const approval: ApprovalProvider = {
      decide: async (request) => {
        approvalValues.push(request.prepared.arguments);
        await Promise.resolve();
        rewrittenArguments.value = 99;
        return new PermissionDecision("allow", "approved value 2", "test-approval");
      },
    };
    const runner = new AgentRunner({
      model: new ScriptedModelClient(replies([toolCall("call-1", "work", '{"value":1}')])),
      tools: registryWithHandler(({ value }) => {
        handled.push(value);
        return toolSuccess(`value=${value}`);
      }),
      hooks,
      permissionPolicy: new PermissionPolicy({ approval }),
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(rewrittenArguments).toEqual({ value: 99 });
    expect(approvalValues).toEqual([{ value: 2 }]);
    expect(Object.isFrozen(approvalValues[0])).toBe(true);
    expect(handled).toEqual([2]);
    expect(result.history[2]).toEqual({
      role: "tool",
      content: "value=2",
      toolCallId: "call-1",
    });
  });

  test("Stop forces at most one additional model turn", async () => {
    const activeStates: boolean[] = [];
    const hooks = new HookRegistry();
    hooks.register("Stop", (context) => {
      activeStates.push(context.stopHookActive);
      return new HookResult({ forceContinue: { role: "user", content: "verify completion" } });
    });
    const model = new ScriptedModelClient([
      { message: assistantMessage("premature"), finishReason: "stop" },
      { message: assistantMessage("verified"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools: new ToolRegistry(),
      hooks,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(result.finalText).toBe("verified");
    expect(result.turns).toBe(2);
    expect(result.history).toEqual([
      { role: "user", content: "go" },
      assistantMessage("premature"),
      { role: "user", content: "verify completion" },
      assistantMessage("verified"),
    ]);
    expect(activeStates).toEqual([false, true]);
    expect(model.requests).toHaveLength(2);
  });

  test("PostToolUse stop pairs later calls without executing them", async () => {
    const handled: number[] = [];
    const hooks = new HookRegistry();
    hooks.register("PostToolUse", () => new HookResult({ preventContinuation: true }));
    const tools = registryWithHandler(({ value }) => {
      handled.push(value);
      return toolSuccess(`value=${value}`);
    });
    const calls = [
      toolCall("call-1", "work", '{"value":1}'),
      toolCall("call-2", "work", '{"value":2}'),
    ];
    const model = new ScriptedModelClient([
      { message: assistantMessage(null, calls), finishReason: "tool_calls" },
    ]);
    const runner = new AgentRunner({
      model,
      tools,
      hooks,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(handled).toEqual([1]);
    expect(result.finalText).toBe("value=1");
    expect(result.history.slice(2)).toEqual([
      { role: "tool", content: "value=1", toolCallId: "call-1" },
      {
        role: "tool",
        content: "Error [hook_stopped_continuation]: Skipped after PostToolUse requested a stop",
        toolCallId: "call-2",
      },
    ]);
    validateToolPairing(result.history);
    model.assertExhausted();
  });

  test.each([
    ["PreToolUse", false],
    ["PostToolUse", true],
  ] as const)("%s exceptions become paired errors", async (event, handlerRan) => {
    const handled: number[] = [];
    const hooks = new HookRegistry();
    hooks.register(event, () => {
      throw new Error("hook implementation failed");
    });
    const tools = registryWithHandler(({ value }) => {
      handled.push(value);
      return toolSuccess("handled");
    });
    const runner = new AgentRunner({
      model: new ScriptedModelClient(replies([toolCall("call-1", "work", '{"value":1}')])),
      tools,
      hooks,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(handled).toEqual(handlerRan ? [1] : []);
    expect(result.history[2]).toEqual({
      role: "tool",
      content: `Error [hook_execution_error]: ${event} hook failed`,
      toolCallId: "call-1",
    });
    validateToolPairing(result.history);
  });

  test("fixed profiles reject early Hook injection and accept P04 boundaries", () => {
    const dependencies = {
      model: new ScriptedModelClient([]),
      workspace: process.cwd(),
      approvalProvider: new AllowApproval(),
      auditSink: new RecordingAudit(),
      hooks: new HookRegistry(),
    };

    expect(() => buildAgent(P03, dependencies)).toThrow(/hooks require chapter 4/);
    expect(buildAgent(P04, dependencies)).toBeInstanceOf(AgentRunner);
  });

  test("PreToolUse blocking returns its exact error without handler execution", async () => {
    let handled = false;
    const hooks = new HookRegistry();
    hooks.register(
      "PreToolUse",
      () => new HookResult({ blockingError: toolError("hook_blocked", "blocked") }),
    );
    const runner = new AgentRunner({
      model: new ScriptedModelClient(replies([toolCall("call-1", "work", '{"value":1}')])),
      tools: registryWithHandler(() => {
        handled = true;
        return toolSuccess("unsafe");
      }),
      hooks,
      systemPrompt: "system",
      workspace: process.cwd(),
    });

    const result = await runner.run("go");

    expect(handled).toBe(false);
    expect(result.history[2]).toEqual({
      role: "tool",
      content: "Error [hook_blocked]: blocked",
      toolCallId: "call-1",
    });
  });
});
