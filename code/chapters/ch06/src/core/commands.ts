// 命令适配器与工具层之间的最小进程结果契约。
export interface CommandResult {
  readonly output: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

// 命令执行抽象边界：CommandRunner 只接收命令和 cwd，返回输出、退出码和超时状态。
// cwd 必须由 Agent 上下文提供，命令文本不能自行扩大工作目录范围。
export interface CommandRunner {
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
