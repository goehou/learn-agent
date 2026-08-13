import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { describe, expect, test } from "vitest";

import { PowerShellRunner } from "../src/adapters/powershell.js";
import { toolCall } from "../src/core/messages.js";
import type { ToolContext } from "../src/core/tools.js";
import { ToolRegistry } from "../src/core/tools.js";
import { createShellTool } from "../src/features/builtin-tools.js";
import { commandResult, FakeCommandRunner } from "./fakes.js";

const context: ToolContext = Object.freeze({ workspace: process.cwd(), identity: "test" });

async function execute(result: ConstructorParameters<typeof FakeCommandRunner>[0]) {
  const registry = new ToolRegistry();
  registry.register(createShellTool(new FakeCommandRunner(result)));
  return registry.invoke(
    registry.prepare(toolCall("call", "shell", '{"command":"test"}')),
    context,
  );
}

describe("shell tool", () => {
  test("the real runner uses the requested cwd and captures both UTF-8 streams", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch01-"));
    try {
      const result = await new PowerShellRunner().run(
        "Write-Output (Get-Location).Path; Write-Output '中文'; [Console]::Error.WriteLine('错误')",
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.output).toContain(workspace);
      expect(result.output).toContain("中文");
      expect(result.output).toContain("错误");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("the real runner terminates a timed-out process and returns partial output", async () => {
    const result = await new PowerShellRunner().run(
      "Write-Output 'started'; Start-Sleep -Seconds 5",
      process.cwd(),
      100,
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("reports timeout and preserves the captured output", async () => {
    await expect(
      execute(commandResult("partial", { timedOut: true, exitCode: 1 })),
    ).resolves.toEqual({
      content: "Error [shell_timeout]: partial",
      isError: true,
      errorCode: "shell_timeout",
    });
  });

  test("marks truncated successful output without changing success status", async () => {
    await expect(execute(commandResult("prefix", { truncated: true }))).resolves.toEqual({
      content: "prefix\n[output truncated]",
      isError: false,
    });
  });

  test("normalizes process start failures without leaking their details", async () => {
    await expect(execute(new Error("secret executable path"))).resolves.toEqual({
      content: "Error [shell_start_failed]: PowerShell process could not be started",
      isError: true,
      errorCode: "shell_start_failed",
    });
  });

  test("converts an invalid handler result at the dispatch boundary", async () => {
    const registry = new ToolRegistry();
    const definition = {
      name: "invalid",
      description: "Return an invalid result.",
      inputSchema: z.strictObject({}),
      effect: "read" as const,
      handler: () => ({ content: "ok", isError: false }),
    };
    registry.register(definition);
    Object.defineProperty(definition, "handler", { value: () => ({ nope: true }) });

    await expect(
      registry.invoke(registry.prepare(toolCall("call", "invalid", "{}")), context),
    ).resolves.toEqual({
      content: "Error [invalid_tool_result]: Tool handler returned an invalid result",
      isError: true,
      errorCode: "invalid_tool_result",
    });
  });

  test("truncates real output at the configured character limit", async () => {
    const result = await new PowerShellRunner({ outputLimit: 5 }).run(
      "Write-Output '123456789'",
      process.cwd(),
    );

    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(5);
  });
});
