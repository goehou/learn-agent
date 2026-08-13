#!/usr/bin/env node

/**
 * CLI 入口模块：负责解析命令行参数、创建模型与授权器、触发 AgentRunner。
 * TerminalAuthorizer 只对 effect === "execute" 的工具要求交互批准；
 * read/write 工具直接放行，stdin 非 TTY 时默认拒绝 execute 调用。
 * 退出码：0 成功，1 运行时错误，2 配置错误。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { OpenAIChatModel } from "./adapters/openai-chat.js";
import { buildAgent } from "./bootstrap.js";
import { ConfigurationError, settingsFromEnvFile, settingsFromMapping } from "./config.js";
import type { ToolAuthorizer, ToolAuthorizationDecision } from "./core/loop.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import type { PreparedToolCall, ToolContext } from "./core/tools.js";

// 终端边界只要求用户批准会执行宿主命令的工具；读写工作区文件不阻塞交互流程。
class TerminalAuthorizer implements ToolAuthorizer {
  // 仅对 execute 工具请求终端批准；非交互或异常一律 fail-closed。
  async authorize(
    prepared: PreparedToolCall,
    _context: ToolContext,
  ): Promise<ToolAuthorizationDecision> {
    const definition = prepared.definition;
    if (definition === undefined) {
      throw new Error("approval request is incomplete");
    }
    if (definition.effect !== "execute") {
      return { allowed: true, reason: "This tool effect does not require approval" };
    }
    stderr.write(`\n工具调用需要批准: ${definition.name}\n`);
    stderr.write("原因: PowerShell command execution requires explicit approval.\n");
    stderr.write(`参数: ${JSON.stringify(prepared.arguments)}\n`);
    if (!stdin.isTTY) {
      stderr.write("无交互输入，默认拒绝。\n");
      return { allowed: false, reason: "No interactive approval input was available" };
    }

    const terminal = createInterface({ input: stdin, output: stderr });
    try {
      const answer = await terminal.question("允许本次调用? [y/N] ");
      const normalized = answer.trim().toLowerCase();
      const allowed = normalized === "y" || normalized === "yes";
      return {
        allowed,
        reason: allowed ? "User approved this tool call" : "User denied this tool call",
      };
    } finally {
      terminal.close();
    }
  }
}

interface RunArguments {
  // 解析后映射为冻结 profile 的章节号。
  readonly chapter: number;
  // 传给 AgentRunner.run 的用户任务。
  readonly prompt: string;
}

// 固定章节入口通过 fixedChapter 注入章节号，仍复用通用参数校验逻辑。
function parseRunArguments(argv: readonly string[], fixedChapter?: number): RunArguments {
  const args = fixedChapter === undefined ? argv : ["--chapter", String(fixedChapter), ...argv];
  let chapter: number | undefined;
  let prompt: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--chapter") {
      const value = args[index + 1];
      if (value === undefined || !/^(?:[1-9]|1[0-9]|20)$/.test(value)) {
        throw new Error("--chapter must be an integer from 1 to 20");
      }
      chapter = Number(value);
      index += 1;
      continue;
    }
    if (arg === "--prompt") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--prompt must not be empty");
      }
      prompt = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(arg)}`);
  }
  if (chapter === undefined || prompt === undefined) {
    throw new Error("Both --chapter and --prompt are required");
  }
  return { chapter, prompt };
}

// 真实启动路径：加载配置、创建 SDK 适配器、装配 Agent 并输出最终文本。
async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // 工作区和 .env 始终从启动目录解析，避免受模块文件所在位置影响。
  const workspace = resolve(process.cwd());
  const envPath = resolve(workspace, ".env");
  const settings = existsSync(envPath) ? settingsFromEnvFile(envPath) : settingsFromMapping({});
  const model = new OpenAIChatModel(settings);
  const runner = buildAgent(profile, {
    model,
    workspace,
    authorizer: new TerminalAuthorizer(),
  });
  const result = await runner.run(prompt);
  stdout.write(`${result.finalText}\n`);
  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  return runWithErrorHandling(async () => {
    if (argv[0] !== "run") {
      throw new Error("Expected command: run");
    }
    const parsed = parseRunArguments(argv.slice(1));
    return await execute(profileForChapter(parsed.chapter), parsed.prompt);
  });
}

export async function runProfile(
  profile: ChapterProfile,
  argv: readonly string[],
): Promise<number> {
  return runWithErrorHandling(async () => {
    const parsed = parseRunArguments(argv, profile.chapter);
    return await execute(profile, parsed.prompt);
  });
}

// CLI 进程边界统一转换错误为稳定的中文标签和退出码。
async function runWithErrorHandling(run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    const label = error instanceof ConfigurationError ? "配置错误" : "运行失败";
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label}: ${message}\n`);
    return error instanceof ConfigurationError ? 2 : 1;
  }
}

const entryPath = process.argv[1];
// 被章节入口导入时不重复执行；直接运行本文件时才解析 argv。
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
