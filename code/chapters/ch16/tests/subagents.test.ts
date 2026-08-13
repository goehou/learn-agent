import { describe, expect, test } from "vitest";
import { z } from "zod";

import { HookRegistry, HookResult } from "../src/core/hooks.js";
import { AgentRunner } from "../src/core/loop.js";
import {
  assistantMessage,
  systemMessage,
  toolCall,
  validateToolPairing,
} from "../src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import { PermissionPolicy, PermissionRule } from "../src/core/permissions.js";
import { ToolRegistry, toolSuccess } from "../src/core/tools.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../src/core/tools.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  SubagentTool,
} from "../src/features/subagents.js";
import { ScriptedModelClient } from "./fakes.js";

const inspectSchema = z.strictObject({ value: z.string() });
const pathSchema = z.strictObject({ path: z.string() });
const context = Object.freeze({ workspace: process.cwd(), identity: "parent-user" });

function registryWith<Input>(definition: ToolDefinition<Input>): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(definition);
  return tools;
}

async function invokeTask(feature: SubagentTool, description: string): Promise<ToolResult> {
  const tools = registryWith(feature.toolDefinition);
  return tools.invoke(
    tools.prepare(toolCall("parent-task", "task", JSON.stringify({ description }))),
    context,
  );
}

describe("one-shot subagent", () => {
  test("defines a strict task contract and caps child turns at thirty", () => {
    const feature = new SubagentTool({
      modelFactory: () => new ScriptedModelClient([]),
      toolsFactory: () => new ToolRegistry(),
      hooks: new HookRegistry(),
      permissionPolicy: new PermissionPolicy(),
    });
    const tools = registryWith(feature.toolDefinition);

    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBe(30);
    expect(feature.toolDefinition).toMatchObject({ name: "task", effect: "external" });
    expect(tools.openAITools()[0]?.function).toMatchObject({
      name: "task",
      description: "Launch an isolated subagent and return only its final conclusion.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["description"],
        properties: { description: { type: "string", minLength: 1 } },
      },
    });
    for (const argumentsJson of [
      '{"description":""}',
      '{"description":"   "}',
      '{"description":"go","extra":1}',
    ]) {
      expect(tools.prepare(toolCall("task-1", "task", argumentsJson)).error).toMatchObject({
        isError: true,
        errorCode: "invalid_arguments",
      });
    }
    expect(
      () =>
        new SubagentTool({
          modelFactory: () => new ScriptedModelClient([]),
          toolsFactory: () => new ToolRegistry(),
          hooks: new HookRegistry(),
          permissionPolicy: new PermissionPolicy(),
          maxTurns: 31,
        }),
    ).toThrow(/at most 30/);
  });

  test("parent sees only the task result while child shares hooks, permission, workspace, and identity", async () => {
    const trace: string[] = [];
    const observedContexts: ToolContext[] = [];
    const inspectDefinition: ToolDefinition<z.infer<typeof inspectSchema>> = {
      name: "inspect",
      description: "Inspect deterministic evidence.",
      inputSchema: inspectSchema,
      effect: "read",
      handler: ({ value }, toolContext) => {
        trace.push("handler:inspect");
        observedContexts.push(toolContext);
        return toolSuccess(`evidence:${value}`);
      },
    };
    const childModel = new ScriptedModelClient([
      {
        message: assistantMessage(null, [
          toolCall("child-inspect", "inspect", '{"value":"found"}'),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("child conclusion"), finishReason: "stop" },
    ]);
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", (hookContext) => {
      trace.push(`pre:${hookContext.prepared?.call.name}`);
      return new HookResult();
    });
    hooks.register("PostToolUse", (hookContext) => {
      trace.push(`post:${hookContext.prepared?.call.name}`);
      return new HookResult();
    });
    const permissionPolicy = new PermissionPolicy({
      rules: [
        new PermissionRule({
          name: "record",
          behavior: "allow",
          reason: "Allowed for the isolation test",
          matches: (request) => {
            trace.push(`permission:${request.prepared.call.name}`);
            return true;
          },
        }),
      ],
    });
    const feature = new SubagentTool({
      modelFactory: () => childModel,
      toolsFactory: () => registryWith(inspectDefinition),
      hooks,
      permissionPolicy,
    });
    const parentCall = toolCall("parent-task", "task", '{"description":"inspect the project"}');
    const parentModel = new ScriptedModelClient([
      { message: assistantMessage(null, [parentCall]), finishReason: "tool_calls" },
      { message: assistantMessage("parent final"), finishReason: "stop" },
    ]);
    const parentRunner = new AgentRunner({
      model: parentModel,
      tools: registryWith(feature.toolDefinition),
      systemPrompt: "parent system",
      workspace: context.workspace,
      identity: context.identity,
      hooks,
      permissionPolicy,
    });

    const result = await parentRunner.run("parent request");

    expect(result.history).toEqual([
      { role: "user", content: "parent request" },
      assistantMessage(null, [parentCall]),
      { role: "tool", content: "child conclusion", toolCallId: "parent-task" },
      assistantMessage("parent final"),
    ]);
    expect(childModel.requests[0]?.messages).toEqual([
      systemMessage(DEFAULT_SUBAGENT_SYSTEM_PROMPT),
      { role: "user", content: "inspect the project" },
    ]);
    expect(childModel.requests[0]?.tools.map((tool) => tool.function.name)).toEqual(["inspect"]);
    expect(observedContexts).toEqual([context]);
    expect(trace).toEqual([
      "pre:task",
      "permission:task",
      "pre:inspect",
      "permission:inspect",
      "handler:inspect",
      "post:inspect",
      "post:task",
    ]);
    validateToolPairing(result.history);
    childModel.assertExhausted();
    parentModel.assertExhausted();
  });

  test("each task call creates fresh model, registry, and child history", async () => {
    const childModels: ScriptedModelClient[] = [];
    const childRegistries: ToolRegistry[] = [];
    const feature = new SubagentTool({
      modelFactory: () => {
        const model = new ScriptedModelClient([
          {
            message: assistantMessage(`child conclusion ${childModels.length + 1}`),
            finishReason: "stop",
          },
        ]);
        childModels.push(model);
        return model;
      },
      toolsFactory: () => {
        const tools = new ToolRegistry();
        childRegistries.push(tools);
        return tools;
      },
      hooks: new HookRegistry(),
      permissionPolicy: new PermissionPolicy(),
    });

    const first = await invokeTask(feature, " first task ");
    const second = await invokeTask(feature, "second task");

    expect(first).toEqual({ content: "child conclusion 1", isError: false });
    expect(second).toEqual({ content: "child conclusion 2", isError: false });
    expect(childModels).toHaveLength(2);
    expect(childRegistries).toHaveLength(2);
    expect(childRegistries[0]).not.toBe(childRegistries[1]);
    expect(childModels[0]?.requests[0]?.messages).toEqual([
      systemMessage(DEFAULT_SUBAGENT_SYSTEM_PROMPT),
      { role: "user", content: "first task" },
    ]);
    expect(childModels[1]?.requests[0]?.messages).toEqual([
      systemMessage(DEFAULT_SUBAGENT_SYSTEM_PROMPT),
      { role: "user", content: "second task" },
    ]);
  });

  test("child has no task tool and a recursive attempt becomes unknown_tool", async () => {
    const childModel = new ScriptedModelClient([
      {
        message: assistantMessage(null, [
          toolCall("recursive-task", "task", '{"description":"again"}'),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("delegation unavailable"), finishReason: "stop" },
    ]);
    const feature = new SubagentTool({
      modelFactory: () => childModel,
      toolsFactory: () => new ToolRegistry(),
      hooks: new HookRegistry(),
      permissionPolicy: new PermissionPolicy(),
    });

    const result = await invokeTask(feature, "do work");

    expect(result).toEqual({ content: "delegation unavailable", isError: false });
    expect(childModel.requests[0]?.tools).toEqual([]);
    const recursiveRequest = childModel.requests[1];
    if (recursiveRequest === undefined) {
      throw new Error("recursive attempt did not reach the second child request");
    }
    expect(recursiveRequest.messages.at(-1)).toEqual({
      role: "tool",
      content: "Error [unknown_tool]: Unknown tool: task",
      toolCallId: "recursive-task",
    });
    validateToolPairing(recursiveRequest.messages);
  });

  test("shared hard permission denies a child write before its handler", async () => {
    const handled: string[] = [];
    const hookCalls: string[] = [];
    const dangerousDefinition: ToolDefinition<z.infer<typeof pathSchema>> = {
      name: "dangerous_write",
      description: "Write a dangerous path.",
      inputSchema: pathSchema,
      effect: "write",
      handler: ({ path }, toolContext) => {
        handled.push(`${toolContext.workspace}/${path}`);
        return toolSuccess("unsafe");
      },
    };
    const hooks = new HookRegistry();
    hooks.register("PreToolUse", (hookContext) => {
      hookCalls.push(`pre:${hookContext.prepared?.call.name}`);
      return new HookResult();
    });
    hooks.register("PostToolUse", (hookContext) => {
      hookCalls.push(`post:${hookContext.prepared?.call.name}`);
      return new HookResult();
    });
    const childModel = new ScriptedModelClient([
      {
        message: assistantMessage(null, [
          toolCall("dangerous-call", "dangerous_write", '{"path":"../outside.txt"}'),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("write was denied"), finishReason: "stop" },
    ]);
    const feature = new SubagentTool({
      modelFactory: () => childModel,
      toolsFactory: () => registryWith(dangerousDefinition),
      hooks,
      permissionPolicy: new PermissionPolicy({
        writeBoundary: {
          isPathWithinWorkspace: async () => false,
        },
      }),
    });

    const result = await invokeTask(feature, "write outside");

    expect(result).toEqual({ content: "write was denied", isError: false });
    expect(handled).toEqual([]);
    expect(hookCalls).toEqual(["pre:dangerous_write"]);
    expect(childModel.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      content: "Error [permission_denied]: Writing outside the workspace is forbidden",
      toolCallId: "dangerous-call",
    });
  });

  test("turn limit is structured and never returns the last tool result", async () => {
    const inspectDefinition: ToolDefinition<z.infer<typeof inspectSchema>> = {
      name: "inspect",
      description: "Keep requesting another turn.",
      inputSchema: inspectSchema,
      effect: "read",
      handler: ({ value }) => toolSuccess(`last-tool-result:${value}`),
    };
    const childModel = new EndlessToolModel();
    const feature = new SubagentTool({
      modelFactory: () => childModel,
      toolsFactory: () => registryWith(inspectDefinition),
      hooks: new HookRegistry(),
      permissionPolicy: new PermissionPolicy(),
    });

    const result = await invokeTask(feature, "never finish");

    expect(result).toEqual({
      content: "Error [subagent_turn_limit]: Subagent exceeded max_turns=30 without a final answer",
      isError: true,
      errorCode: "subagent_turn_limit",
    });
    expect(result.content).not.toContain("last-tool-result");
    expect(childModel.requests).toHaveLength(DEFAULT_SUBAGENT_MAX_TURNS);
    const lastRequest = childModel.requests.at(-1);
    if (lastRequest === undefined) {
      throw new Error("turn-limit test did not issue any child request");
    }
    validateToolPairing(lastRequest.messages);
  });

  test("unexpected child failure returns a sanitized boundary error", async () => {
    const feature = new SubagentTool({
      modelFactory: () => new FailingModel(),
      toolsFactory: () => new ToolRegistry(),
      hooks: new HookRegistry(),
      permissionPolicy: new PermissionPolicy(),
    });

    const result = await invokeTask(feature, "fail");

    expect(result).toEqual({
      content: "Error [subagent_execution_error]: Subagent execution failed",
      isError: true,
      errorCode: "subagent_execution_error",
    });
    expect(result.content).not.toContain("secret-api-key");
    expect(result.content).not.toContain("internal-path");
  });

  test("child tools factory cannot reintroduce task", async () => {
    let modelFactoryCalls = 0;
    let feature: SubagentTool;
    feature = new SubagentTool({
      modelFactory: () => {
        modelFactoryCalls += 1;
        return new ScriptedModelClient([]);
      },
      toolsFactory: () => registryWith(feature.toolDefinition),
      hooks: new HookRegistry(),
      permissionPolicy: new PermissionPolicy(),
    });

    const result = await invokeTask(feature, "recurse");

    expect(result).toEqual({
      content: "Error [subagent_configuration_error]: Subagent tools must not include task",
      isError: true,
      errorCode: "subagent_configuration_error",
    });
    expect(modelFactoryCalls).toBe(0);
  });
});

class EndlessToolModel implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    const index = this.requests.length;
    return {
      message: assistantMessage(null, [
        toolCall(`endless-${index}`, "inspect", JSON.stringify({ value: String(index) })),
      ]),
      finishReason: "tool_calls",
    };
  }
}

class FailingModel implements ModelClient {
  async complete(_request: ModelRequest): Promise<ModelReply> {
    throw new Error("secret-api-key-and-internal-path");
  }
}
