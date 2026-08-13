/**
 * 命令执行边界：核心工具不直接依赖 child_process。
 * CommandResult 把输出、退出码、超时和截断统一为可观察状态，
 * 测试可以用确定性 CommandRunner 替换真实 PowerShellRunner。
 */
// 命令适配器的标准结果：输出限制和超时均为可观察状态，而非隐式异常。
export interface CommandResult {
  readonly output: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

// 核心工具只依赖此边界，可在测试中替换为确定性命令运行器。
export interface CommandRunner {
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
