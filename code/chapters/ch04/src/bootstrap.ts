// 组合根：按章节能力选择基础设施、工具集、权限策略和 Hook 生命周期。
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import type { HookRegistry } from "./core/hooks.js";
import { AgentRunner } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionPolicy, PermissionRule } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";

// Hook 仅在 P04 及以后组装，避免给早期教学快照注入未讲解的生命周期。
const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";

export interface BuildDependencies {
  // 外部边界均可注入，离线测试无需启动真实进程或网络客户端。
  readonly model: ModelClient;
  // 命令、文件和 Hook 上下文共享的工作区根。
  readonly workspace: string;
  // 可替换命令执行边界。
  readonly commandRunner?: CommandRunner;
  // 可替换文件系统边界，同时用于写路径安全校验。
  readonly fileSystem?: WorkspaceFileSystem;
  // P03+ 的 ask 决策收敛边界。
  readonly approvalProvider?: ApprovalProvider;
  // P03+ 的最终决策审计边界。
  readonly auditSink?: AuditSink;
  // P04 可选 Hook 队列；早期 profile 明确拒绝它。
  readonly hooks?: HookRegistry;
  // 可选模型回合上限。
  readonly maxTurns?: number;
}

// 根据固定 profile 组合累计能力，拒绝 profile 伪造与 Hook 越级注入。
export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // 先验证 profile 与章节匹配，再按能力选择工具集与权限策略，最后组装 AgentRunner。
  // 禁止伪造同章节号但能力不同的 profile，保持教学快照固定。
  if (profileForChapter(profile.chapter) !== profile) {
    throw new Error("profile must be a fixed chapter profile");
  }
  if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
    throw new Error("hooks require chapter 4 or later");
  }
  const commandRunner =
    dependencies.commandRunner === undefined ? new PowerShellRunner() : dependencies.commandRunner;
  const fileSystem =
    dependencies.fileSystem === undefined ? new NodeWorkspaceFileSystem() : dependencies.fileSystem;
  const tools =
    profile.chapter === 1
      ? createChapterOneTools(commandRunner)
      : createChapterTwoTools(commandRunner, fileSystem);
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    workspace: dependencies.workspace,
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(dependencies.hooks === undefined ? {} : { hooks: dependencies.hooks }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

function permissionPolicyForProfile(
  profile: ChapterProfile,
  fileSystem: WorkspaceFileSystem,
  dependencies: BuildDependencies,
): PermissionPolicy | undefined {
  if (!profile.capabilities.has("policy")) {
    return dependencies.approvalProvider === undefined
      ? undefined
      : new PermissionPolicy({ approval: dependencies.approvalProvider });
  }
  if (dependencies.approvalProvider === undefined) {
    throw new Error("approvalProvider is required for chapter 3 or later");
  }
  if (dependencies.auditSink === undefined) {
    throw new Error("auditSink is required for chapter 3 or later");
  }
  // 只提升写入工具；Shell 的执行审批由策略默认规则统一处理。
  return new PermissionPolicy({
    rules: [
      new PermissionRule({
        name: "confirm-file-write",
        behavior: "ask",
        reason: "File writes require explicit approval from chapter 3 onward",
        matches: (request) => {
          const name = request.prepared.definition?.name;
          return name === "write_file" || name === "edit_file";
        },
      }),
    ],
    approval: dependencies.approvalProvider,
    audit: dependencies.auditSink,
    writeBoundary: fileSystem,
  });
}
