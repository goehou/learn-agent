// PowerShell 命令 adapter：负责子进程启动、超时、输出截断与退出码归一化。
import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "../core/commands.js";

export interface PowerShellRunnerOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
}

// 默认值限制单次工具调用的等待时间与返回内容，避免循环被无限命令拖住。
export class PowerShellRunner implements CommandRunner {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #outputLimit: number;

  constructor(options: PowerShellRunnerOptions = {}) {
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
        timedOut = true;
        child.kill();
      }, timeoutMs);
    });
  }
}
