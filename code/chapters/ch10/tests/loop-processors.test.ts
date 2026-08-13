import { describe, expect, test } from "vitest";
import { z } from "zod";

import { HookRegistry, HookResult } from "../src/core/hooks.js";
import { AgentRunner } from "../src/core/loop.js";
import type { TurnLifecycle } from "../src/core/loop.js";
import type { ModelClient } from "../src/core/model.js";
import { assistantMessage, toolCall, toolMessage, userMessage } from "../src/core/messages.js";
import { ToolRegistry, toolSuccess } from "../src/core/tools.js";
import { ScriptedModelClient } from "./fakes.js";

function registerEcho(tools: ToolRegistry): void {
  tools.register({
    name: "echo",
    description: "Echo text.",
    inputSchema: z.object({ value: z.string() }).strict(),
    effect: "read",
    handler: ({ value }) => toolSuccess(value),
  });
}

function echoTools(): ToolRegistry {
  const tools = new ToolRegistry();
  registerEcho(tools);
  return tools;
}

describe("AgentRunner request and tool-result processors", () => {
  test("runs turn lifecycle around request preparation and never stores guidance", async () => {
    const trace: string[] = [];
    const lifecycle: TurnLifecycle = {
      async beginTurn(query) {
        trace.push(`begin:${query}`);
      },
      beforeModel() {
        trace.push("before");
        return [userMessage("memory context")];
      },
      async complete(history) {
        trace.push(`complete:${history.length}`);
      },
    };
    const model = new ScriptedModelClient([
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools: echoTools(),
      systemPrompt: "test",
      workspace: process.cwd(),
      turnLifecycle: lifecycle,
    });

    const result = await runner.run("go");

    expect(trace).toEqual(["begin:go", "before", "complete:2"]);
    expect(model.requests[0]?.messages).toEqual([
      { role: "system", content: "test" },
      userMessage("go"),
      userMessage("memory context"),
    ]);
    expect(result.history).toEqual([userMessage("go"), assistantMessage("done")]);
  });

  test("rejects invalid lifecycle guidance before calling the model", async () => {
    let modelCalls = 0;
    const model: ModelClient = {
      async complete() {
        modelCalls += 1;
        return { message: assistantMessage("should not run"), finishReason: "stop" };
      },
    };
    const runner = new AgentRunner({
      model,
      tools: new ToolRegistry(),
      systemPrompt: "test",
      workspace: process.cwd(),
      turnLifecycle: {
        async beginTurn() {},
        beforeModel() {
          return [toolMessage("orphan", "missing")];
        },
        async complete() {},
      },
    });

    await expect(runner.run("go")).rejects.toThrow(/orphan tool result/);
    expect(modelCalls).toBe(0);
  });

  test("snapshots tools after lifecycle guidance is prepared", async () => {
    const tools = new ToolRegistry();
    let registered = false;
    const model = new ScriptedModelClient([
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools,
      systemPrompt: "test",
      workspace: process.cwd(),
      turnLifecycle: {
        async beginTurn() {},
        beforeModel() {
          if (!registered) {
            registerEcho(tools);
            registered = true;
          }
          return [];
        },
        async complete() {},
      },
    });

    await runner.run("go");

    expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual(["echo"]);
  });

  test("renders the system prompt provider for each model request after lifecycle preparation", async () => {
    const tools = new ToolRegistry();
    let registered = false;
    let renderCount = 0;
    const model = new ScriptedModelClient([
      {
        message: assistantMessage(null, [toolCall("call-1", "echo", '{"value":"first"}')]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools,
      systemPrompt: "fallback",
      systemPromptProvider: {
        render() {
          renderCount += 1;
          return `dynamic:${tools.names.join(",")}`;
        },
      },
      workspace: process.cwd(),
      turnLifecycle: {
        async beginTurn() {},
        beforeModel() {
          if (!registered) {
            registerEcho(tools);
            registered = true;
          }
          return [];
        },
        async complete() {},
      },
    });

    await runner.run("go");

    expect(renderCount).toBe(2);
    expect(model.requests.map((request) => request.messages[0])).toEqual([
      { role: "system", content: "dynamic:echo" },
      { role: "system", content: "dynamic:echo" },
    ]);
  });

  test("passes one complete result batch through the processor before appending tool messages", async () => {
    const calls = [
      toolCall("call-1", "echo", '{"value":"first"}'),
      toolCall("call-2", "echo", '{"value":"second"}'),
    ];
    const model = new ScriptedModelClient([
      { message: assistantMessage(null, calls), finishReason: "tool_calls" },
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const batches: string[][] = [];
    const runner = new AgentRunner({
      model,
      tools: echoTools(),
      systemPrompt: "test",
      workspace: process.cwd(),
      toolResultProcessor: (results) => {
        batches.push(results.map((result) => result.content));
        return results.map((result) => toolSuccess(`processed:${result.content}`));
      },
    });

    const result = await runner.run("go");

    expect(batches).toEqual([["first", "second"]]);
    expect(result.history.slice(2, 4)).toEqual([
      toolMessage("processed:first", "call-1"),
      toolMessage("processed:second", "call-2"),
    ]);
  });

  test.each([
    ["throws", () => Promise.reject(new Error("disk failed"))],
    ["returns the wrong count", () => []],
    ["returns an invalid result", () => [{ content: "bad", isError: false, errorCode: "x" }]],
  ])(
    "pairs every call with a controlled error when the processor %s",
    async (_label, processor) => {
      const calls = [
        toolCall("call-1", "echo", '{"value":"first"}'),
        toolCall("call-2", "echo", '{"value":"second"}'),
      ];
      const model = new ScriptedModelClient([
        { message: assistantMessage(null, calls), finishReason: "tool_calls" },
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const runner = new AgentRunner({
        model,
        tools: echoTools(),
        systemPrompt: "test",
        workspace: process.cwd(),
        toolResultProcessor: processor,
      });

      const result = await runner.run("go");

      expect(result.history.slice(2, 4)).toEqual([
        toolMessage(
          "Error [tool_result_processing_error]: Tool result processing failed",
          "call-1",
        ),
        toolMessage(
          "Error [tool_result_processing_error]: Tool result processing failed",
          "call-2",
        ),
      ]);
    },
  );

  test("returns the processed result when PostToolUse stops the round", async () => {
    let completedHistoryLength = 0;
    const lifecycle: TurnLifecycle = {
      async beginTurn() {},
      beforeModel() {
        return [];
      },
      async complete(history) {
        completedHistoryLength = history.length;
      },
    };
    const hooks = new HookRegistry();
    hooks.register(
      "PostToolUse",
      () => new HookResult({ updatedOutput: toolSuccess("from hook"), preventContinuation: true }),
    );
    const model = new ScriptedModelClient([
      {
        message: assistantMessage(null, [toolCall("call-1", "echo", '{"value":"raw"}')]),
        finishReason: "tool_calls",
      },
    ]);
    const runner = new AgentRunner({
      model,
      tools: echoTools(),
      systemPrompt: "test",
      workspace: process.cwd(),
      hooks,
      turnLifecycle: lifecycle,
      toolResultProcessor: (results) =>
        results.map((result) => toolSuccess(`persisted:${result.content}`)),
    });

    const result = await runner.run("go");

    expect(result.finalText).toBe("persisted:from hook");
    expect(result.history.at(-1)).toEqual(toolMessage("persisted:from hook", "call-1"));
    expect(completedHistoryLength).toBe(3);
  });

  test("uses processed request history without mutating canonical history", async () => {
    const model = new ScriptedModelClient([
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools: echoTools(),
      systemPrompt: "test",
      workspace: process.cwd(),
      historyProcessor: {
        prepare: async () => [userMessage("compressed")],
      },
    });

    const result = await runner.run("canonical");

    expect(model.requests[0]?.messages).toEqual([
      { role: "system", content: "test" },
      userMessage("compressed"),
    ]);
    expect(result.history).toEqual([userMessage("canonical"), assistantMessage("done")]);
  });

  test("rejects invalid processed history before calling the model", async () => {
    const model = new ScriptedModelClient([
      { message: assistantMessage("must not run"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools: echoTools(),
      systemPrompt: "test",
      workspace: process.cwd(),
      historyProcessor: {
        prepare: async () => [toolMessage("orphan", "missing")],
      },
    });

    await expect(runner.run("go")).rejects.toThrow(/orphan tool result/);
    expect(model.requests).toEqual([]);
  });
});
