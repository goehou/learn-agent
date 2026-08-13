import { describe, expect, test } from "vitest";
import { z } from "zod";

import { assistantMessage, toolCall } from "../src/core/messages.js";
import { AgentRunner } from "../src/core/loop.js";
import { ToolRegistry, toolSuccess, type ToolDefinition } from "../src/core/tools.js";
import { ScriptedModelClient } from "./fakes.js";

const emptySchema = z.strictObject({});

function definition(name: string, value: string): ToolDefinition<Record<string, never>> {
  return {
    name,
    description: `Run ${name}.`,
    inputSchema: emptySchema,
    effect: "read",
    source: "test",
    handler: () => toolSuccess(value),
  };
}

describe("chapter 19 registry version and snapshot", () => {
  test("batch mutation is atomic, identity-safe, versioned, and snapshot sealed", () => {
    const registry = new ToolRegistry();
    const first = definition("first", "one");
    const second = definition("second", "two");
    registry.register(first);
    const snapshot = registry.snapshot();
    expect(registry.version).toBe(1);
    expect(snapshot.version).toBe(1);
    registry.registerMany([second]);
    expect(registry.version).toBe(2);
    expect(snapshot.names).toEqual(["first"]);
    expect(() =>
      registry.registerMany([definition("first", "collision"), definition("third", "three")]),
    ).toThrow(/already registered/);
    expect(registry.names).toEqual(["first", "second"]);
    expect(registry.version).toBe(2);
    const foreignRegistry = new ToolRegistry();
    const foreignSecond = foreignRegistry.register(definition("second", "different"));
    expect(() => registry.unregisterMany([foreignSecond])).toThrow(/does not match/);
    expect(registry.names).toEqual(["first", "second"]);
    expect(() => snapshot.register(definition("late", "late"))).toThrow(/immutable/);
    registry.unregisterMany([second]);
    expect(registry.version).toBe(3);
  });

  test("a model reply keeps one registry snapshot until the next request", async () => {
    const registry = new ToolRegistry();
    let calls = 0;
    const dynamic = definition("mcp__docs__search", "dynamic");
    const connect: ToolDefinition<Record<string, never>> = {
      ...definition("connect_mcp", "connect"),
      handler: () => {
        registry.register(dynamic);
        return toolSuccess("connected");
      },
    };
    const dynamicWithCounter: ToolDefinition<Record<string, never>> = {
      ...dynamic,
      handler: () => {
        calls += 1;
        return toolSuccess("dynamic");
      },
    };
    registry.register({
      ...connect,
      handler: () => {
        registry.register(dynamicWithCounter);
        return toolSuccess("connected");
      },
    });
    const model = new ScriptedModelClient([
      {
        message: assistantMessage(null, [
          toolCall("connect", "connect_mcp", "{}"),
          toolCall("early", "mcp__docs__search", "{}"),
        ]),
        finishReason: "tool_calls",
      },
      {
        message: assistantMessage(null, [toolCall("late", "mcp__docs__search", "{}")]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools: registry,
      systemPrompt: "system",
      workspace: process.cwd(),
    });
    const result = await runner.run("connect");
    expect(result.finalText).toBe("done");
    expect(calls).toBe(1);
    expect(model.requests[0]?.tools.map((tool) => tool.function.name)).not.toContain(
      "mcp__docs__search",
    );
    expect(model.requests[1]?.tools.map((tool) => tool.function.name)).toContain(
      "mcp__docs__search",
    );
    await runner.close();
  });
});
