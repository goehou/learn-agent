import { z } from "zod";

import type { CommandResult, CommandRunner } from "../core/commands.js";
import type { ToolDefinition } from "../core/tools.js";
import { ToolRegistry, toolError, toolSuccess } from "../core/tools.js";

// 第一章内置工具：当前只注册一个受 schema 约束的 shell（PowerShell）工具。
//
// shell 的输入、handler 和副作用类别来自同一个 ToolDefinition，
// 避免模型看到的 schema 与实际执行逻辑平行维护。错误被分类为启动失败、超时和非零退出码，
// 让模型既能读到可操作文本，也能按 errorCode 区分失败原因。
//
// 严格对象拒绝额外字段，命令字符串不得为空；实际命令语义交由 PowerShell。
const shellInputSchema = z.strictObject({ command: z.string().min(1) });

// 第 1 章仅暴露受 schema 约束的 PowerShell 工具，工作目录来自受控上下文。
// commandRunner 是唯一进程边界，工具定义本身不直接启动子进程。
export function createShellTool(commandRunner: CommandRunner): ToolDefinition<{ command: string }> {
  return {
    name: "shell",
    description: "Run a PowerShell command in the current workspace.",
    inputSchema: shellInputSchema,
    effect: "execute",
    handler: async ({ command }, context) => {
      let result: CommandResult;
      try {
        result = await commandRunner.run(command, context.workspace);
      } catch {
        return toolError("shell_start_failed", "PowerShell process could not be started");
      }

      // 结果文本兼容空输出、截断、超时和非零退出码，均可作为下一轮模型上下文。
      let output = result.output.length === 0 ? "(no output)" : result.output;
      if (result.truncated) {
        output = `${output}\n[output truncated]`;
      }
      if (result.timedOut) {
        return toolError("shell_timeout", output);
      }
      if (result.exitCode !== 0) {
        return toolError(
          "shell_failed",
          `PowerShell exited with code ${result.exitCode}\n${output}`,
        );
      }
      return toolSuccess(output);
    },
  };
}

// 创建本章完整工具注册表；新增工具必须在这里集中注册，避免组合根遗漏能力。
export function createChapterOneTools(commandRunner: CommandRunner): ToolRegistry {
  // 章节工具集中注册全部可用副作用，供组装层一次性注入。
  const registry = new ToolRegistry();
  registry.register(createShellTool(commandRunner));
  return registry;
}
