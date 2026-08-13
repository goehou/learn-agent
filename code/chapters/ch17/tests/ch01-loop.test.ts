import { describe, expect, test } from "vitest";

import { buildAgent } from "../src/bootstrap.js";
import { AgentLimitError, IncompleteModelReplyError } from "../src/core/loop.js";
import { assistantMessage, toolCall, validateToolPairing } from "../src/core/messages.js";
import type { ModelReply } from "../src/core/model.js";
import { P01 } from "../src/core/profiles.js";
import { commandResult, FakeCommandRunner, ScriptedModelClient } from "./fakes.js";

function reply(
  message: ModelReply["message"],
  finishReason: ModelReply["finishReason"],
): ModelReply {
  return Object.freeze({ message, finishReason });
}

describe("chapter 1 Agent Loop", () => {
  test("executes PowerShell, pairs its result, then returns the exact final text", async () => {
    const model = new ScriptedModelClient([
      reply(
        assistantMessage(null, [toolCall("call-1", "shell", '{"command":"Write-Output 42"}')]),
        "tool_calls",
      ),
      reply(assistantMessage("PowerShell 返回 42。"), "stop"),
    ]);
    const commands = new FakeCommandRunner(commandResult("42"));
    const runner = buildAgent(P01, {
      model,
      workspace: process.cwd(),
      commandRunner: commands,
    });

    const result = await runner.run("运行 Write-Output 42，并告诉我结果");

    expect(result.finalText).toBe("PowerShell 返回 42。");
    expect(result.turns).toBe(2);
    expect(commands.calls).toEqual([
      { command: "Write-Output 42", cwd: process.cwd(), timeoutMs: undefined },
    ]);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual(["shell"]);
    expect(model.requests[0]?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(model.requests[1]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    const toolResult = model.requests[1]?.messages[3];
    expect(toolResult).toEqual({ role: "tool", content: "42", toolCallId: "call-1" });
    validateToolPairing(result.history);
    model.assertExhausted();
  });

  test("returns a paired unknown_tool result without invoking PowerShell", async () => {
    const model = new ScriptedModelClient([
      reply(assistantMessage(null, [toolCall("missing-1", "missing", "{}")]), "tool_calls"),
      reply(assistantMessage("该工具不存在。"), "stop"),
    ]);
    const commands = new FakeCommandRunner(commandResult("must not run"));
    const runner = buildAgent(P01, { model, workspace: process.cwd(), commandRunner: commands });

    const result = await runner.run("调用不存在的工具");

    expect(commands.calls).toEqual([]);
    expect(model.requests[1]?.messages[3]).toEqual({
      role: "tool",
      content: "Error [unknown_tool]: Unknown tool: missing",
      toolCallId: "missing-1",
    });
    expect(result.finalText).toBe("该工具不存在。");
    validateToolPairing(result.history);
  });

  test("rejects invalid JSON before invoking the command runner", async () => {
    const model = new ScriptedModelClient([
      reply(assistantMessage(null, [toolCall("bad-json", "shell", "{")]), "tool_calls"),
      reply(assistantMessage("参数无效。"), "stop"),
    ]);
    const commands = new FakeCommandRunner(commandResult("must not run"));
    const runner = buildAgent(P01, { model, workspace: process.cwd(), commandRunner: commands });

    await runner.run("传递坏参数");

    expect(commands.calls).toEqual([]);
    expect(model.requests[1]?.messages[3]).toEqual({
      role: "tool",
      content: "Error [invalid_json]: Tool arguments must be valid JSON",
      toolCallId: "bad-json",
    });
  });

  test("fails with AgentLimitError after the configured model-call limit", async () => {
    const repeated = () =>
      reply(
        assistantMessage(null, [toolCall(crypto.randomUUID(), "shell", '{"command":"pwd"}')]),
        "tool_calls",
      );
    const model = new ScriptedModelClient([repeated(), repeated()]);
    const runner = buildAgent(P01, {
      model,
      workspace: process.cwd(),
      commandRunner: new FakeCommandRunner(commandResult("workspace")),
      maxTurns: 2,
    });

    await expect(runner.run("一直调用工具")).rejects.toThrow(AgentLimitError);
    expect(model.requests).toHaveLength(2);
    validateToolPairing(runner.history);
  });

  test("does not store a length-truncated assistant response as completed history", async () => {
    const model = new ScriptedModelClient([reply(assistantMessage("未完成"), "length")]);
    const runner = buildAgent(P01, { model, workspace: process.cwd() });

    await expect(runner.run("生成长回答")).rejects.toThrow(IncompleteModelReplyError);
    expect(runner.history.map((message) => message.role)).toEqual(["user"]);
  });
});
