import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../src/core/loop.js";
import { assistantMessage, toolCall } from "../src/core/messages.js";
import type { ToolContext } from "../src/core/tools.js";
import { ToolRegistry, toolSuccess } from "../src/core/tools.js";
import type { ToolContextProvider } from "../src/core/loop.js";
import { ScriptedModelClient } from "./fakes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

class SwitchingWorkspaceProvider implements ToolContextProvider {
  readonly workspaceRoot: string;
  readonly #worktree: string;
  active = false;
  readonly resolved: string[] = [];

  constructor(workspaceRoot: string, worktree: string) {
    this.workspaceRoot = workspaceRoot;
    this.#worktree = worktree;
  }

  resolve(context: ToolContext): ToolContext {
    this.resolved.push(context.workspace);
    return Object.freeze({
      ...context,
      workspace: this.active ? this.#worktree : context.workspace,
    });
  }
}

class EscapingWorkspaceProvider implements ToolContextProvider {
  readonly workspaceRoot: string;
  readonly #outside: string;

  constructor(workspaceRoot: string, outside: string) {
    this.workspaceRoot = workspaceRoot;
    this.#outside = outside;
  }

  resolve(context: ToolContext): ToolContext {
    return Object.freeze({ ...context, workspace: this.#outside });
  }
}

class ScopeTrackingProvider implements ToolContextProvider {
  readonly workspaceRoot: string;
  readonly scopes: object[] = [];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  resolve(context: ToolContext): ToolContext {
    if (context.executionScope === undefined) {
      throw new Error("expected an execution scope");
    }
    this.scopes.push(context.executionScope);
    return context;
  }
}

describe("chapter 18 per-tool workspace routing", () => {
  test("same reply claim then write resolves the new workspace before the second tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-loop-"));
    roots.push(root);
    const worktree = join(root, ".agent_tutorial", "worktrees", "alice");
    await mkdir(worktree, { recursive: true });
    const provider = new SwitchingWorkspaceProvider(root, worktree);
    const seen: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "claim_task",
      description: "Claim a bound task.",
      inputSchema: z.strictObject({}),
      effect: "write",
      handler: async (_input, context) => {
        seen.push(context.workspace);
        provider.active = true;
        return toolSuccess("claimed");
      },
    });
    tools.register({
      name: "write_file",
      description: "Write inside the resolved workspace.",
      inputSchema: z.strictObject({ path: z.string(), content: z.string() }),
      effect: "write",
      handler: async (input, context) => {
        seen.push(context.workspace);
        await writeFile(join(context.workspace, input.path), input.content, "utf8");
        return toolSuccess("written");
      },
    });
    const model = new ScriptedModelClient([
      {
        message: assistantMessage(null, [
          toolCall("claim", "claim_task", "{}"),
          toolCall("write", "write_file", '{"path":"result.txt","content":"isolated"}'),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools,
      systemPrompt: "test",
      workspace: root,
      toolContextProvider: provider,
    });

    await expect(runner.run("claim and write")).resolves.toMatchObject({ finalText: "done" });
    expect(provider.resolved).toEqual([root, root]);
    expect(seen).toEqual([root, worktree]);
    await expect(readFile(join(root, "result.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(worktree, "result.txt"), "utf8")).resolves.toBe("isolated");
    model.assertExhausted();
  });

  test("provider escape becomes a paired tool_context_error before the handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-loop-"));
    roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-outside-"));
    roots.push(outside);
    let calls = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "write_file",
      description: "Write inside the resolved workspace.",
      inputSchema: z.strictObject({ path: z.string() }),
      effect: "write",
      handler: async () => {
        calls += 1;
        return toolSuccess("unexpected");
      },
    });
    const model = new ScriptedModelClient([
      {
        message: assistantMessage(null, [toolCall("write", "write_file", '{"path":"result.txt"}')]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("handled"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools,
      systemPrompt: "test",
      workspace: root,
      toolContextProvider: new EscapingWorkspaceProvider(root, outside),
    });

    await expect(runner.run("try escape")).resolves.toMatchObject({ finalText: "handled" });
    expect(calls).toBe(0);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "write",
      content: expect.stringContaining("tool_context_error"),
    });
    model.assertExhausted();
  });

  test("execution scope is shared within one run and replaced before the next run", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-loop-"));
    roots.push(root);
    const provider = new ScopeTrackingProvider(root);
    const tools = new ToolRegistry();
    tools.register({
      name: "observe_scope",
      description: "Observe the current execution scope.",
      inputSchema: z.strictObject({}),
      effect: "read",
      handler: async () => toolSuccess("observed"),
    });
    const model = new ScriptedModelClient([
      {
        message: assistantMessage(null, [
          toolCall("first", "observe_scope", "{}"),
          toolCall("second", "observe_scope", "{}"),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("first done"), finishReason: "stop" },
      {
        message: assistantMessage(null, [toolCall("third", "observe_scope", "{}")]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("second done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools,
      systemPrompt: "test",
      workspace: root,
      toolContextProvider: provider,
    });

    await runner.run("first run");
    await runner.run("second run");

    expect(provider.scopes).toHaveLength(3);
    expect(provider.scopes[0]).toBe(provider.scopes[1]);
    expect(provider.scopes[2]).not.toBe(provider.scopes[0]);
    model.assertExhausted();
  });
});
