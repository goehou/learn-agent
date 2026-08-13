// 命令适配器与工具层之间的最小进程结果契约。
export interface CommandResult {
  readonly output: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

// cwd 必须由 Agent 上下文提供，命令文本不能自行扩大工作目录范围。
export interface CommandRunner {
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
