// 命令适配器向工具层暴露的最小结果契约，保留受限执行的状态信息。
//
// CommandResult 包含运行时所有可能结果状态，工具层据此决定 toolSuccess 或具体 toolError。
export interface CommandResult {
  readonly output: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

//
// CommandRunner 抽象进程执行边界，使核心循环不依赖具体子进程实现；
// 测试可使用 FakeCommandRunner 注入确定性结果以隔离操作系统依赖。
//
export interface CommandRunner {
  // 命令工具依赖的可替换进程边界；实现负责 cwd、超时及输出收集。
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
