/**
 * 命令执行边界：核心工具不直接依赖 child_process。
 * CommandResult 把输出、退出码、超时和截断统一为可观察状态，
 * 测试可以用确定性 CommandRunner 替换真实 PowerShellRunner。
 */
// 命令适配器的标准结果：输出限制和超时均为可观察状态，而非隐式异常。
export interface CommandResult {
  // 合并 stdout/stderr 的受限输出，供工具回填给模型。
  readonly output: string;
  // 子进程退出码；非零状态由工具层分类为错误结果。
  readonly exitCode: number;
  // 命令是否因时间预算耗尽而被终止。
  readonly timedOut: boolean;
  // 合并输出是否超过上限，防止模型把部分结果当作完整结果。
  readonly truncated: boolean;
}

// 核心工具只依赖此边界，可在测试中替换为确定性命令运行器。
export interface CommandRunner {
  // 可替换的进程执行边界，timeoutMs 仅覆盖本次调用。
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
