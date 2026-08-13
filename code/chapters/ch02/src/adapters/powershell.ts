/**
 * PowerShell 子进程适配器：实现 CommandRunner。
 * 使用 -NoLogo、-NoProfile、-NonInteractive 降低宿主配置影响；
 * windowsHide 隐藏控制台窗口；超时后 kill 并保留 timedOut 状态；
 * stdout/stderr 共用输出预算，截断通过 truncated 标志暴露给工具层。
 */
import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "../core/commands.js";

// 进程选项可注入，测试能够验证超时与截断而不依赖系统默认值。
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
    // 默认值限制单次命令的时间和输出量，防止工具调用无限占用运行资源。
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
    if (command.length === 0) {
      throw new Error("command must not be empty");
    }
    const timeoutMs = timeoutOverrideMs === undefined ? this.#timeoutMs : timeoutOverrideMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }

    return new Promise((resolve, reject) => {
      // 关闭 Profile 和交互输入，降低宿主环境配置对工具结果的影响。
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

      const append = (chunk: Buffer): void => {
        // stdout 与 stderr 共用预算，返回结果保留发生截断这一事实。
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
      child.once("error", (error) => {
        // error 与 close 可能先后到达；settled 确保 Promise 仅完成一次。
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

      const timer = setTimeout(() => {
        // 超时后等待 close 收集最终进程状态，再把 timedOut 返回给工具层。
        timedOut = true;
        child.kill();
      }, timeoutMs);
    });
  }
}
