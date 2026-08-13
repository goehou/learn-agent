// 组合根：按章节能力选择基础设施、工具集、权限策略、Hook 和 TODO 观察器。
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
import { TodoTracker } from "./features/todos.js";

const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";

// Hook 仅在 P04 及以后组装，避免给早期教学快照注入未讲解的生命周期。
// P05 将 TodoTracker 同时注册为工具和每轮观察器，避免状态与提示分离。
export interface BuildDependencies {
  // 外部边界均可注入，离线测试无需启动真实进程或网络客户端。
  readonly model: ModelClient;
  // workspace 同时传给工具上下文和文件系统边界，是一次运行的根目录。
  readonly workspace: string;
  // 未注入时使用真实 PowerShell；测试可替换为可控执行器。
  readonly commandRunner?: CommandRunner;
  // 未注入时创建 Node 文件系统适配器，调用方可提供内存实现隔离副作用。
  readonly fileSystem?: WorkspaceFileSystem;
  // P03 以后处理 ask 决策的外部审批边界。
  readonly approvalProvider?: ApprovalProvider;
  // P03 以后记录允许、拒绝与失败结果的审计边界。
  readonly auditSink?: AuditSink;
  // P04 以后可注入的生命周期扩展注册表。
  readonly hooks?: HookRegistry;
  // 覆盖循环上限仅用于调用方控制成本和测试终止条件。
  readonly maxTurns?: number;
}

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
  const todoTracker = profile.capabilities.has("todo") ? new TodoTracker() : undefined;
  // 只有具备 todo 能力的 profile 才暴露计划工具和对应系统提示。
  if (todoTracker !== undefined) {
    tools.register(todoTracker.toolDefinition);
  }
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt:
      todoTracker === undefined ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`,
    workspace: dependencies.workspace,
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(dependencies.hooks === undefined ? {} : { hooks: dependencies.hooks }),
    // 同一个 tracker 实例既是 todo_write 的 handler，也是每轮观察器；
    // 因此写计划时能重置陈旧计数，遗忘计划时又能注入下一次请求提醒。
    ...(todoTracker === undefined ? {} : { toolRoundObserver: todoTracker }),
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
