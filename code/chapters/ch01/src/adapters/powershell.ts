import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "../core/commands.js";

// PowerShell 命令适配器：把字符串命令转换为受限子进程执行，并统一收集输出。
//
// 显式 NoLogo / NoProfile / NonInteractive 参数保证纯脚本执行，不加载用户配置；
// 默认 120 秒超时和 50000 字符输出上限，防止单条命令耗尽运行资源或淹没上下文。
// 参数数组传递避免再次经过 shell 解析，UTF-8 编码让 stdout/stderr 可一致解码。
//
// PowerShell 进程边界：统一 UTF-8、超时和输出上限，避免单次命令耗尽运行资源。
export interface PowerShellRunnerOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
}

export class PowerShellRunner implements CommandRunner {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #outputLimit: number;

  constructor(options: PowerShellRunnerOptions = {}) {
    // 运行限制可为测试替换；生产默认值限制单次命令时间和返回体积。
    this.#executable = options.executable === undefined ? "powershell.exe" : options.executable;
    this.#timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
    this.#outputLimit = options.outputLimit === undefined ? 50_000 : options.outputLimit;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.#outputLimit) || this.#outputLimit <= 0) {
      throw new Error("outputLimit must be a positive integer");
    }
  }

  run(command: string, cwd: string, timeoutOverrideMs?: number): Promise<CommandResult> {
    // 每次调用可缩短或延长预算，但仍要求正整数以保证计时器语义明确。
    if (command.length === 0) {
      throw new Error("command must not be empty");
    }
    const timeoutMs = timeoutOverrideMs === undefined ? this.#timeoutMs : timeoutOverrideMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }

    return new Promise((resolve, reject) => {
      // 参数数组避免经由 shell 再次解析；显式 UTF-8 使 stdout/stderr 可一致解码。
      const child = spawn(
        this.#executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; ${command}`,
        ],
        { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks: string[] = [];
      let outputLength = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      // 两个输出流共用一个上限，保留最早的内容并记录截断状态。
      const append = (chunk: Buffer): void => {
        // stdout 与 stderr 共享同一预算，保证错误输出也不能绕过结果上限。
        if (outputLength >= this.#outputLimit) {
          truncated = true;
          return;
        }
        const text = chunk.toString("utf8");
        const remaining = this.#outputLimit - outputLength;
        chunks.push(text.slice(0, remaining));
        outputLength += Math.min(text.length, remaining);
        if (text.length > remaining) {
          truncated = true;
        }
      };

      child.stdout.on("data", append);
      child.stderr.on("data", append);
      // error 与 close 可能先后到达；settled 确保 Promise 只兑现一次。
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(
          Object.freeze({
            output: chunks.join("").trimEnd(),
            exitCode: code === null ? 1 : code,
            timedOut,
            truncated,
          }),
        );
      });

      // 超时只终止子进程；close 负责收集最终退出码并返回 timedOut 标记。
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    });
  }
}
