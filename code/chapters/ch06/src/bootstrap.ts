// 组合根：按章节能力选择基础设施、工具集、权限策略、Hook 和 TODO 观察器。
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import { HookRegistry } from "./core/hooks.js";
import { AgentRunner } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionPolicy, PermissionRule } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import type { ToolRegistry } from "./core/tools.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";
import { SubagentTool } from "./features/subagents.js";
import { TodoTracker } from "./features/todos.js";

// P06 在已具备 Hook 与权限的前提下才组装子代理，委派本身同样受父策略控制。
const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";

// Hook 仅在 P04 及以后组装，避免给早期教学快照注入未讲解的生命周期。
// P05 将 TodoTracker 同时注册为工具和每轮观察器，避免状态与提示分离。
export interface BuildDependencies {
  // 外部边界均可注入，离线测试无需启动真实进程或网络客户端。
  readonly model: ModelClient;
  // 单次父子运行共用的工作区根目录，子代理只能在该边界内操作文件。
  readonly workspace: string;
  // 可替换真实 PowerShell，用于测试或宿主特定的命令边界。
  readonly commandRunner?: CommandRunner;
  // 可替换 Node 文件系统，实现可控副作用和工作区校验。
  readonly fileSystem?: WorkspaceFileSystem;
  // 对 ask 决策提供人或外部系统的批准结果。
  readonly approvalProvider?: ApprovalProvider;
  // 收集父、子 Agent 均会经过的权限决策审计记录。
  readonly auditSink?: AuditSink;
  // P04 及以后由父子运行器共享的生命周期扩展。
  readonly hooks?: HookRegistry;
  // 父循环的调用方上限；子代理另有不得超过 30 的独立上限。
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
  const standardTools = createStandardTools(profile, commandRunner, fileSystem);
  const tools = standardTools.tools;
  const todoTracker = standardTools.todoTracker;
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  const hooks =
    dependencies.hooks === undefined && profile.capabilities.has("hooks")
      ? new HookRegistry()
      : dependencies.hooks;
  if (profile.capabilities.has("subagent")) {
    // 子代理复用受控依赖工厂，但得到自己的 AgentRunner 与工具注册表。
    if (hooks === undefined || permissionPolicy === undefined) {
      throw new Error("subagent capability requires hooks and permission policy");
    }
    const subagent = new SubagentTool({
      modelFactory: () => dependencies.model,
      toolsFactory: () => createStandardTools(profile, commandRunner, fileSystem).tools,
      hooks,
      permissionPolicy,
    });
    tools.register(subagent.toolDefinition);
  }
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt:
      todoTracker === undefined ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`,
    workspace: dependencies.workspace,
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(todoTracker === undefined ? {} : { toolRoundObserver: todoTracker }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

interface StandardTools {
  // 每次组合创建一个独立 registry；子代理工厂借此避免与父 registry 互相污染。
  readonly tools: ToolRegistry;
  // P05 以后同 registry 对应的会话级计划观察器。
  readonly todoTracker?: TodoTracker;
}

// createStandardTools 封装章节通用工具注册：先创建 shell 与文件工具集，
// 再按 profile 能力决定是否追加 todo 工具和对应观察器，返回不可变组合。
function createStandardTools(
  profile: ChapterProfile,
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
): StandardTools {
  const tools =
    profile.chapter === 1
      ? createChapterOneTools(commandRunner)
      : createChapterTwoTools(commandRunner, fileSystem);
  const todoTracker = profile.capabilities.has("todo") ? new TodoTracker() : undefined;
  if (todoTracker === undefined) {
    return Object.freeze({ tools });
  }
  tools.register(todoTracker.toolDefinition);
  return Object.freeze({ tools, todoTracker });
}

// permissionPolicyForProfile 根据 profile 的 policy 能力组合权限策略；
// 子代理复用同一套策略，因此委派不能绕过父 Agent 的审批与审计边界。
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
