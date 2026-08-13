// 命令适配器与工具层之间的最小进程结果契约。
export interface CommandResult {
  // output 是截断后的稳定文本；timedOut 与 truncated 是权限之外的执行边界信息。
  readonly output: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface CommandRunner {
  // cwd 必须由 Agent 上下文提供，命令文本不能自行扩大工作目录范围。
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
