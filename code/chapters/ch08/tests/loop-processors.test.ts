import { describe, expect, test } from "vitest";
import { z } from "zod";

import { HookRegistry, HookResult } from "../src/core/hooks.js";
import { AgentRunner } from "../src/core/loop.js";
import { assistantMessage, toolCall, toolMessage, userMessage } from "../src/core/messages.js";
import { ToolRegistry, toolSuccess } from "../src/core/tools.js";
import { ScriptedModelClient } from "./fakes.js";

function echoTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "Echo text.",
    inputSchema: z.object({ value: z.string() }).strict(),
    effect: "read",
    handler: ({ value }) => toolSuccess(value),
  });
  return tools;
}

describe("AgentRunner request and tool-result processors", () => {
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
      toolResultProcessor: (results) =>
        results.map((result) => toolSuccess(`persisted:${result.content}`)),
    });

    const result = await runner.run("go");

    expect(result.finalText).toBe("persisted:from hook");
    expect(result.history.at(-1)).toEqual(toolMessage("persisted:from hook", "call-1"));
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
