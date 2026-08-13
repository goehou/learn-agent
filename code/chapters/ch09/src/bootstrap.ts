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
import { CompactionManager, ModelHistorySummarizer } from "./features/compaction.js";
import { MemorySession, MemoryStore, ModelMemoryQueries } from "./features/memory.js";
import { SkillRegistry } from "./features/skills.js";
import { SubagentTool } from "./features/subagents.js";
import { TodoTracker } from "./features/todos.js";

const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
const SKILLS_SYSTEM_PROMPT =
  "\n\nAvailable workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:\n";
const EMPTY_SKILLS_CATALOG = "(No workspace Skills are currently available.)";

// Hook 仅在 P04 及以后组装，避免给早期教学快照注入未讲解的生命周期。
// P05 将 TodoTracker 同时注册为工具和每轮观察器，避免状态与提示分离。
// P07 将目录摘要注入系统提示，但完整指令只由显式工具调用提供。
// P08 为 Loop 注入请求历史与工具结果处理器，压缩只作用于下一次模型请求。
// P09 将持久记忆接入 TurnLifecycle，读写发生在 Agent Loop 的明确生命周期点。
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
  // 章节组装阶段扫描一次；运行时 load_skill 仍会复查真实路径。
  const skillRegistry = profile.capabilities.has("skills")
    ? SkillRegistry.scan(dependencies.workspace)
    : undefined;
  // 权限策略由 profile 能力位决定；子代理复用同一策略，不能绕过父审批。
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  // 同一压缩管理器同时服务请求历史和工具结果两条边界。
  const compactionManager = profile.capabilities.has("compaction")
    ? // 摘要模型沿用主模型边界，离线测试可注入确定性模型。
      new CompactionManager({
        workspace: dependencies.workspace,
        summarizer: new ModelHistorySummarizer(dependencies.model),
      })
    : undefined;
  // P09 按能力位注入记忆会话；没有 memory 能力时 Loop 保持 P08 行为。
  const memorySession = profile.capabilities.has("memory")
    ? createMemorySession(dependencies)
    : undefined;
  const hooks =
    dependencies.hooks === undefined && profile.capabilities.has("hooks")
      ? new HookRegistry()
      : dependencies.hooks;
  // 子代理在 P06+ 启用，要求 hooks 与 permissionPolicy 共同构成跨 Agent 边界。
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
    // 请求历史在模型调用前准备；工具结果在回填 canonical history 前经处理器。
    ...(compactionManager === undefined
      ? {}
      : {
          historyProcessor: compactionManager,
          toolResultProcessor: async (results) =>
            (await compactionManager.compactToolResults(results)).results,
        }),
    // 记忆生命周期与请求级压缩互补：压缩改变模型看到的旧历史，记忆在回合边界读写持久层。
    ...(memorySession === undefined ? {} : { turnLifecycle: memorySession }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

function createMemorySession(dependencies: BuildDependencies): MemorySession {
  // 三个记忆查询共用同一个 ModelClient，便于离线注入确定性模型；
  // 存储仍由 MemoryStore 管理，模型只返回选择/提取/整理结果，不直接写文件。
  const queries = new ModelMemoryQueries(dependencies.model);
  return new MemorySession({
    store: new MemoryStore({ workspace: dependencies.workspace }),
    selector: queries,
    extractor: queries,
    consolidator: queries,
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
