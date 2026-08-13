// 命令适配器向工具层暴露的最小结果契约，保留受限执行的状态信息。
//
// CommandResult 包含运行时所有可能结果状态，工具层据此决定 toolSuccess 或具体 toolError。
export interface CommandResult {
  // 合并 stdout 与 stderr 后的受限文本，供工具回填给模型。
  readonly output: string;
  // 子进程退出状态；非零值由上层转换为可恢复的工具错误。
  readonly exitCode: number;
  // 超时终止与普通非零退出需要区别处理，因此单独保留此标记。
  readonly timedOut: boolean;
  // 输出超过共享预算时为 true，调用方据此避免把不完整结果当成全部结果。
  readonly truncated: boolean;
}

//
// CommandRunner 抽象进程执行边界，使核心循环不依赖具体子进程实现；
// 测试可使用 FakeCommandRunner 注入确定性结果以隔离操作系统依赖。
//
export interface CommandRunner {
  // 命令工具依赖的可替换进程边界；实现负责 cwd、超时及输出收集。
  // timeoutMs 仅覆盖本次调用的时间预算，省略时由具体适配器使用默认限制。
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
