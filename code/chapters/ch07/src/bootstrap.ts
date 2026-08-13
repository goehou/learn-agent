// 组合根：按章节能力选择基础设施、工具集、权限策略、Hook、TODO 观察器和 Skill 目录。
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
import { SkillRegistry } from "./features/skills.js";
import { SubagentTool } from "./features/subagents.js";
import { TodoTracker } from "./features/todos.js";

const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
// Skill 目录是构建期稳定前缀；正文不在这里出现，只能由 load_skill 显式取回。
const SKILLS_SYSTEM_PROMPT =
  "\n\nAvailable workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:\n";
const EMPTY_SKILLS_CATALOG = "(No workspace Skills are currently available.)";

// Hook 仅在 P04 及以后组装，避免给早期教学快照注入未讲解的生命周期。
// P05 将 TodoTracker 同时注册为工具和每轮观察器，避免状态与提示分离。
// P07 将目录摘要注入系统提示，但完整指令只由显式工具调用提供。
export interface BuildDependencies {
  // 外部边界均可注入，离线测试无需启动真实进程或网络客户端。
  readonly model: ModelClient;
  readonly workspace: string;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: WorkspaceFileSystem;
  readonly approvalProvider?: ApprovalProvider;
  readonly auditSink?: AuditSink;
  readonly hooks?: HookRegistry;
  readonly maxTurns?: number;
}

export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
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
  // P07 构建时固定可发现目录；每个 load_skill 请求仍重新验证物理路径。
  const skillRegistry = profile.capabilities.has("skills")
    ? // 章节组装阶段扫描一次；运行时加载仍做路径复查。
      SkillRegistry.scan(dependencies.workspace)
    : undefined;
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  const hooks =
    dependencies.hooks === undefined && profile.capabilities.has("hooks")
      ? new HookRegistry()
      : dependencies.hooks;
  if (profile.capabilities.has("subagent")) {
    if (hooks === undefined || permissionPolicy === undefined) {
      throw new Error("subagent capability requires hooks and permission policy");
    }
    const subagent = new SubagentTool({
      modelFactory: () => dependencies.model,
      toolsFactory: () => {
        // 子代理共享 Skill 元数据快照，但每次创建独立工具注册表，避免跨任务状态泄漏。
        const childTools = createStandardTools(profile, commandRunner, fileSystem).tools;
        if (skillRegistry !== undefined) {
          childTools.register(skillRegistry.toolDefinition);
        }
        return childTools;
      },
      hooks,
      permissionPolicy,
    });
    tools.register(subagent.toolDefinition);
  }
  if (skillRegistry !== undefined) {
    // load_skill 注册在 task 之后，使父工具顺序稳定且子工具仍可复用同一注册表。
    tools.register(skillRegistry.toolDefinition);
  }
  let systemPrompt =
    todoTracker === undefined ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`;
  if (skillRegistry !== undefined) {
    // 目录摘要作为构建期快照进入 System Prompt；正文仍由 load_skill 按需加载。
    // 空目录也会得到明确提示，避免模型猜测未公开的 Skill 存在。
    const catalog = skillRegistry.renderCatalog();
    systemPrompt = `${systemPrompt}${SKILLS_SYSTEM_PROMPT}${catalog.length === 0 ? EMPTY_SKILLS_CATALOG : catalog}`;
  }
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt,
    workspace: dependencies.workspace,
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(todoTracker === undefined ? {} : { toolRoundObserver: todoTracker }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

interface StandardTools {
  readonly tools: ToolRegistry;
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
