import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  HOOK_EVENTS,
  HookContext,
  HookContractError,
  HookRegistry,
  HookResult,
} from "../src/core/hooks.js";
import type { HookEvent } from "../src/core/hooks.js";
import {
  assistantMessage,
  systemMessage,
  toolCall,
  toolMessage,
  userMessage,
} from "../src/core/messages.js";
import { ToolRegistry, toolError, toolSuccess } from "../src/core/tools.js";
import type { PreparedToolCall, ToolResult } from "../src/core/tools.js";

const valueSchema = z.object({ value: z.number().int() }).strict();

function preparedCall(value = 1): PreparedToolCall {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "Echo a value.",
    inputSchema: valueSchema,
    effect: "read",
    handler: () => {
      throw new Error("Hook unit tests must not invoke the handler");
    },
  });
  const prepared = registry.prepare(toolCall("call-echo", "echo", JSON.stringify({ value })));
  if (prepared.error !== undefined) {
    throw new Error("test fixture failed to prepare");
  }
  return prepared;
}

function contextFor(event: HookEvent): HookContext {
  if (event === "UserPromptSubmit") {
    return new HookContext({ event, message: userMessage("go") });
  }
  if (event === "PreToolUse") {
    return new HookContext({ event, prepared: preparedCall() });
  }
  if (event === "PostToolUse") {
    return new HookContext({ event, prepared: preparedCall(), result: toolSuccess("one") });
  }
  return new HookContext({ event, history: [assistantMessage("done")] });
}

describe("hook registry", () => {
  test("defines exactly the four chapter lifecycle events", () => {
    expect(HOOK_EVENTS).toEqual(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
  });

  test.each(HOOK_EVENTS)("%s callbacks run in registration order", async (event) => {
    const calls: string[] = [];
    const hooks = new HookRegistry();
    hooks.register(event, () => {
      calls.push("first");
      return new HookResult();
    });
    hooks.register(event, async () => {
      calls.push("second");
      return new HookResult();
    });

    await hooks.run(contextFor(event));

    expect(calls).toEqual(["first", "second"]);
  });

  test("PreToolUse blocking errors short-circuit later callbacks", async () => {
    const calls: string[] = [];
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", () => {
      calls.push("blocker");
      return new HookResult({
        blockingError: toolError("hook_blocked", "blocked by policy hook"),
      });
    });
    hooks.register("PreToolUse", () => {
      calls.push("late");
      return new HookResult();
    });

    const result = await hooks.runPreTool(preparedCall());

    expect(result.blockingError).toEqual(toolError("hook_blocked", "blocked by policy hook"));
    expect(calls).toEqual(["blocker"]);
  });

  test("PreToolUse rewrites flow to later callbacks and preserve the trusted definition", async () => {
    const original = preparedCall(1);
    const rewritten: PreparedToolCall = {
      ...original,
      call: toolCall("call-echo", "echo", '{"value":2}'),
      arguments: { value: 2 },
    };
    const observed: unknown[] = [];
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", () => new HookResult({ updatedInput: rewritten }));
    hooks.register("PreToolUse", (context) => {
      observed.push(context.prepared?.arguments);
      return new HookResult();
    });

    const result = await hooks.runPreTool(original);

    expect(result.updatedInput).not.toBe(rewritten);
    expect(result.updatedInput).toEqual(rewritten);
    expect(Object.isFrozen(result.updatedInput)).toBe(true);
    expect(Object.isFrozen(result.updatedInput?.arguments)).toBe(true);
    expect(observed).toEqual([{ value: 2 }]);
  });

  test("prepared definitions and arguments cannot be mutated in place", () => {
    const prepared = preparedCall();

    expect(Object.isFrozen(prepared.definition)).toBe(true);
    expect(Object.isFrozen(prepared.arguments)).toBe(true);
    expect(Reflect.set(prepared.arguments as object, "value", "invalid")).toBe(false);
    expect(prepared.arguments).toEqual({ value: 1 });
  });

  test.each([
    {
      label: "tool call id",
      update: (original: PreparedToolCall): PreparedToolCall => ({
        ...original,
        call: toolCall("different-id", "echo", '{"value":2}'),
        arguments: { value: 2 },
      }),
    },
    {
      label: "registered definition",
      update: (original: PreparedToolCall): PreparedToolCall => {
        const replacement = preparedCall(2);
        return { ...replacement, call: original.call };
      },
    },
    {
      label: "input schema",
      update: (original: PreparedToolCall): PreparedToolCall => ({
        ...original,
        arguments: { value: "two" },
      }),
    },
  ])("PreToolUse rejects rewrites that change the $label", async ({ update, label }) => {
    const original = preparedCall();
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", () => new HookResult({ updatedInput: update(original) }));

    await expect(hooks.runPreTool(original)).rejects.toThrow(label);
  });

  test("PostToolUse output rewrites chain in registration order", async () => {
    const observed: string[] = [];
    const hooks = new HookRegistry();
    hooks.register("PostToolUse", (context) => {
      if (context.result === undefined) {
        throw new Error("PostToolUse context is incomplete");
      }
      observed.push(context.result.content);
      return new HookResult({ updatedOutput: toolSuccess("rewritten once") });
    });
    hooks.register("PostToolUse", (context) => {
      if (context.result === undefined) {
        throw new Error("PostToolUse context is incomplete");
      }
      observed.push(context.result.content);
      return new HookResult({ updatedOutput: toolSuccess("rewritten twice") });
    });

    const result = await hooks.runPostTool(preparedCall(), toolSuccess("original"));

    expect(observed).toEqual(["original", "rewritten once"]);
    expect(result.updatedOutput).toEqual(toolSuccess("rewritten twice"));
  });

  test("Stop can force only one continuation while still running twice", async () => {
    const activeStates: boolean[] = [];
    const hooks = new HookRegistry();
    hooks.register("Stop", (context) => {
      activeStates.push(context.stopHookActive);
      return new HookResult({ forceContinue: userMessage("verify the claimed output") });
    });
    const history = [userMessage("work"), assistantMessage("done")];

    const first = await hooks.runStop(history, false);
    const second = await hooks.runStop(history, true);

    expect(first.forceContinue).toEqual(userMessage("verify the claimed output"));
    expect(second).toEqual(new HookResult());
    expect(activeStates).toEqual([false, true]);
  });

  test("permission recommendations merge by deny, ask, allow, passthrough priority", async () => {
    const hooks = new HookRegistry();
    for (const permissionBehavior of ["allow", "ask", "deny"] as const) {
      hooks.register("PreToolUse", () => new HookResult({ permissionBehavior }));
    }

    const result = await hooks.runPreTool(preparedCall());

    expect(result.permissionBehavior).toBe("deny");
  });

  test.each([
    ["UserPromptSubmit", new HookResult({ updatedOutput: toolSuccess("invalid") })],
    ["PreToolUse", new HookResult({ updatedOutput: toolSuccess("invalid") })],
    ["PostToolUse", new HookResult({ updatedInput: preparedCall() })],
    ["Stop", new HookResult({ preventContinuation: true })],
  ] as const)("%s rejects fields owned by another event", async (event, result) => {
    const hooks = new HookRegistry();
    hooks.register(event, () => result);

    await expect(hooks.run(contextFor(event))).rejects.toThrow(`${event} HookResult`);
  });

  test("runtime contracts reject invalid results, context, and pairing-breaking messages", async () => {
    expect(() => new HookResult({ blockingError: toolSuccess("not an error") })).toThrow(
      HookContractError,
    );
    expect(
      () =>
        new HookResult({
          additionalContext: [toolMessage("orphan", "call-1")],
        }),
    ).toThrow(/additionalContext/);
    expect(
      () =>
        new HookResult({
          additionalContext: [assistantMessage(null, [toolCall("call-1", "echo", "{}")])],
        }),
    ).toThrow(/additionalContext/);
    expect(
      () =>
        new HookContext({
          event: "PreToolUse",
          prepared: preparedCall(),
          message: userMessage("invalid here"),
        }),
    ).toThrow(/PreToolUse/);

    const hooks = new HookRegistry();
    hooks.register("UserPromptSubmit", () => ({}) as HookResult);
    await expect(hooks.runUserPrompt(userMessage("go"))).rejects.toThrow(/must return HookResult/);
  });

  test("HookResult detaches and freezes every returned message and tool result", () => {
    const rawSystem = { role: "system", content: "safe context" } as const;
    const rawUser = { role: "user", content: "verify safely" } as const;
    const rawOutput: ToolResult = { content: "safe output", isError: false };
    const rawError: ToolResult = {
      content: "Error [hook_blocked]: safe block",
      isError: true,
      errorCode: "hook_blocked",
    };
    const result = new HookResult({
      additionalContext: [rawSystem],
      forceContinue: rawUser,
      updatedOutput: rawOutput,
      blockingError: rawError,
    });

    Reflect.set(rawSystem, "content", "mutated context");
    Reflect.set(rawSystem, "role", "assistant");
    Reflect.set(rawUser, "content", "mutated continuation");
    Reflect.set(rawOutput, "content", "mutated output");
    Reflect.set(rawError, "isError", false);

    expect(result.additionalContext).toEqual([systemMessage("safe context")]);
    expect(result.forceContinue).toEqual(userMessage("verify safely"));
    expect(result.updatedOutput).toEqual(toolSuccess("safe output"));
    expect(result.blockingError).toEqual(toolError("hook_blocked", "safe block"));
    expect(Object.isFrozen(result.additionalContext[0])).toBe(true);
    expect(Object.isFrozen(result.forceContinue)).toBe(true);
    expect(Object.isFrozen(result.updatedOutput)).toBe(true);
    expect(Object.isFrozen(result.blockingError)).toBe(true);
  });

  test("UserPromptSubmit accepts only system additional context", async () => {
    const hooks = new HookRegistry();
    hooks.register(
      "UserPromptSubmit",
      () => new HookResult({ additionalContext: [systemMessage("project rule")] }),
    );

    const result = await hooks.runUserPrompt(userMessage("go"));

    expect(result.additionalContext).toEqual([systemMessage("project rule")]);
  });
});
