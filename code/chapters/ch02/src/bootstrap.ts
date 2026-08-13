/**
 * 组装层：按固定 ChapterProfile 选择 P01/P02 工具集并创建 AgentRunner。
 * 依赖都可注入，离线测试无需真实模型、进程或文件系统。
 * 工作区边界由 adapters 执行，这里只负责组合 profile、工具集、授权器和最大轮次。
 */
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import { AgentRunner } from "./core/loop.js";
import type { ToolAuthorizer } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";

// 组装层仅负责按章节档案选择基础设施，核心循环不依赖具体 SDK 或 Node I/O 实现。
// 第 2 章在第 1 章循环上注入受工作区约束的文件系统能力。
const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";

export interface BuildDependencies {
  // 可替换依赖使离线测试无需真实模型、进程或文件系统。
  readonly model: ModelClient;
  // 工具可访问的工作区根；具体路径安全检查由文件适配器执行。
  readonly workspace: string;
  // 可选命令进程边界，缺失时构造真实 PowerShellRunner。
  readonly commandRunner?: CommandRunner;
  // 可选文件系统边界，缺失时构造 NodeWorkspaceFileSystem。
  readonly fileSystem?: WorkspaceFileSystem;
  // 可选副作用审批边界。
  readonly authorizer?: ToolAuthorizer;
  // 可选模型请求次数上限。
  readonly maxTurns?: number;
}

// 根据固定 profile 装配累计工具集；拒绝伪造 profile 防止章节能力越级。
export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // 只接受固定 profile，随后按章节选择累积工具集。
  if (profileForChapter(profile.chapter) !== profile) {
    throw new Error("profile must be a fixed chapter profile");
  }
  const commandRunner =
    dependencies.commandRunner === undefined ? new PowerShellRunner() : dependencies.commandRunner;
  const tools =
    // P01 只暴露 Shell；P02 才能取得文件工具，防止章节能力提前泄漏。
    profile.chapter === 1
      ? createChapterOneTools(commandRunner)
      : createChapterTwoTools(
          commandRunner,
          dependencies.fileSystem === undefined
            ? new NodeWorkspaceFileSystem()
            : dependencies.fileSystem,
        );
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    workspace: dependencies.workspace,
    ...(dependencies.authorizer === undefined ? {} : { authorizer: dependencies.authorizer }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}
