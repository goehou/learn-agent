#!/usr/bin/env node

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

// CLI 层提供两个入口：固定章节脚本和通用 CLI，二者共享权限、配置和错误处理边界。
//
// TerminalAuthorizer 是 shell 这类 execute 工具的人工授权点；
// 无交互终端、回车、非 y/yes 或审批异常都会 fail-closed 拒绝执行。
// runCli / runProfile 只负责参数解析和启动装配，不包含 Agent 循环逻辑。
//
// 终端是副作用工具的人工授权边界；没有交互终端时必须拒绝执行。
class TerminalAuthorizer implements ToolAuthorizer {
  // 在真实终端中请求本次副作用调用的明确批准；任何交互异常均拒绝执行。
  async authorize(
    prepared: PreparedToolCall,
    _context: ToolContext,
  ): Promise<ToolAuthorizationDecision> {
    const definition = prepared.definition;
    if (definition === undefined) {
      throw new Error("approval request is incomplete");
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

// CLI 解析完成后的最小启动参数；章节与用户请求缺一不可。
interface RunArguments {
  // 解析后的目标章节，随后必须映射到实际迁移的 profile。
  readonly chapter: number;
  // 传入 AgentRunner.run 的原始用户任务文本。
  readonly prompt: string;
}

// 解析通用入口或固定章节入口的参数；固定入口自行补齐 chapter，禁止用户覆盖。
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

// 真实运行路径：读取配置、创建 SDK 适配器、组装 Agent 并输出最终文本。
async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // 先完成配置校验，再创建模型和 Agent，避免缺少密钥时启动外部调用。
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
  // 通用 CLI 必须以 run 子命令开头，再自行选择已迁移章节。
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
  // 固定章节脚本不接受 --chapter，避免入口与 profile 指向不同章节。
  return runWithErrorHandling(async () => {
    const parsed = parseRunArguments(argv, profile.chapter);
    return await execute(profile, parsed.prompt);
  });
}

async function runWithErrorHandling(run: () => Promise<number>): Promise<number> {
  // CLI 边界把领域配置错误映射为可区分的退出码，内部错误不在此吞没。
  try {
    return await run();
  } catch (error) {
    const label = error instanceof ConfigurationError ? "配置错误" : "运行失败";
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label}: ${message}\n`);
    return error instanceof ConfigurationError ? 2 : 1;
  }
}

// 被其他模块导入时不启动进程；只有作为直接入口时才消费 process.argv。
const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
