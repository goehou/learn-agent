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
import { DynamicPromptProvider, DynamicPromptRenderer } from "./features/prompting.js";
import { SkillRegistry } from "./features/skills.js";
import { SubagentTool } from "./features/subagents.js";
import { TodoTracker } from "./features/todos.js";

// 固定身份与行为基线；动态渲染时作为 identity section 的起点，非动态时仍为完整 system prompt。
export const BASE_SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
// 复杂任务的 TODO 跟踪指令，在动态和非动态模式下都适用。
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
// Skill 目录插入提示，只在非动态模式下使用；动态模式下由 DynamicPromptRenderer 处理。
const SKILLS_SYSTEM_PROMPT =
  "\n\nAvailable workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:\n";
const EMPTY_SKILLS_CATALOG = "(No workspace Skills are currently available.)";

// P10 改用动态 Provider 统一组装身份、工具、工作区、Skill 和记忆上下文。
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
  // identity 只用作动态 Prompt context 字段；缺省时回退为 "user"。
  readonly identity?: string;
}

export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  if (profileForChapter(profile.chapter) !== profile) {
    // 运行时校验 profile 引用相等性，防止调用方传入损坏或动态构造的 profile。
    throw new Error("profile must be a fixed chapter profile");
  }
  if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
    // hooks 能力在 P04 之前不可用，调用方传入 hooks 时须同时打开 hooks 能力位。
    throw new Error("hooks require chapter 4 or later");
  }
  const commandRunner =
    dependencies.commandRunner === undefined ? new PowerShellRunner() : dependencies.commandRunner;
  const fileSystem =
    dependencies.fileSystem === undefined ? new NodeWorkspaceFileSystem() : dependencies.fileSystem;
  const standardTools = createStandardTools(profile, commandRunner, fileSystem);
  const tools = standardTools.tools;
  const todoTracker = standardTools.todoTracker;
  // identity 缺省 fallback 与 AgentRunner 构造器一致，保证 context 字段始终非空。
  const identity = dependencies.identity === undefined ? "user" : dependencies.identity;
  // dynamic_prompt 开启时由 DynamicPromptProvider 每轮重新渲染系统提示，关闭时回退静态字符串。
  const dynamicPrompt = profile.capabilities.has("dynamic_prompt");
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
  // 启用动态 Prompt 时关闭 MemorySession.beforeModel() 的独立消息注入，由 Provider 统一输出记忆正文。
  const memorySession = profile.capabilities.has("memory")
    ? createMemorySession(dependencies, !dynamicPrompt)
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
  // 基础 system prompt 组装；非动态模式下仍按旧逻辑嵌入 todo/Skill 段落。
  let systemPrompt =
    todoTracker === undefined ? BASE_SYSTEM_PROMPT : `${BASE_SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`;
  if (!dynamicPrompt && skillRegistry !== undefined) {
    // 非动态模式时，Skill 目录在构建期静态嵌入 system prompt 结尾。
    const catalog = skillRegistry.renderCatalog();
    systemPrompt = `${systemPrompt}${SKILLS_SYSTEM_PROMPT}${catalog.length === 0 ? EMPTY_SKILLS_CATALOG : catalog}`;
  }
  // 动态模式时创建 Provider，由它统一渲染 identity、工具列表、workspace、Skill 目录和选中记忆。
  const systemPromptProvider = dynamicPrompt
    ? // 记忆由 Provider 只注入一次；TurnLifecycle 仅负责维护选择与持久化。
      new DynamicPromptProvider({
        renderer: new DynamicPromptRenderer(),
        identity: systemPrompt,
        tools,
        workspace: dependencies.workspace,
        context: Object.freeze({ chapter: profile.chapter, identity }),
        ...(skillRegistry === undefined ? {} : { skills: skillRegistry }),
        ...(memorySession === undefined ? {} : { memory: memorySession }),
      })
    : undefined;
  return new AgentRunner({
    // 固定 systemPrompt 保留为 fallback；provider 存在时每轮通过 render() 获取渲染结果。
    model: dependencies.model,
    tools,
    systemPrompt,
    workspace: dependencies.workspace,
    ...(systemPromptProvider === undefined ? {} : { systemPromptProvider }),
    ...(dependencies.identity === undefined ? {} : { identity }),
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(todoTracker === undefined ? {} : { toolRoundObserver: todoTracker }),
    ...(compactionManager === undefined
      ? {}
      : {
          // 请求历史在模型调用前准备；工具结果在回填 canonical history 前经处理器。
          historyProcessor: compactionManager,
          toolResultProcessor: async (results) =>
            (await compactionManager.compactToolResults(results)).results,
        }),
    // 记忆生命周期与请求级压缩互补：压缩改变模型看到的旧历史，记忆在回合边界读写持久层。
    ...(memorySession === undefined ? {} : { turnLifecycle: memorySession }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

// 创建记忆会话；emitContextMessages 为 false 时关闭 MemorySession.beforeModel() 的独立注入。
function createMemorySession(
  dependencies: BuildDependencies,
  emitContextMessages: boolean,
): MemorySession {
  const queries = new ModelMemoryQueries(dependencies.model);
  return new MemorySession({
    store: new MemoryStore({ workspace: dependencies.workspace }),
    selector: queries,
    extractor: queries,
    consolidator: queries,
    emitContextMessages,
  });
}

// createStandardTools 封装章节通用工具注册：先创建 shell 与文件工具集，再按 profile 能力决定是否追加 todo 工具和对应观察器。
interface StandardTools {
  readonly tools: ToolRegistry;
  readonly todoTracker?: TodoTracker;
}

function createStandardTools(
  profile: ChapterProfile,
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
): StandardTools {
  const tools =
    profile.chapter === 1
      ? createChapterOneTools(commandRunner)
      : createChapterTwoTools(commandRunner, fileSystem);
  // todo 工具注册后，对应的 toolRoundObserver 作为 agentOption 传入，提供自动规划能力。
  const todoTracker = profile.capabilities.has("todo") ? new TodoTracker() : undefined;
  if (todoTracker === undefined) {
    return Object.freeze({ tools });
  }
  tools.register(todoTracker.toolDefinition);
  return Object.freeze({ tools, todoTracker });
}

// permissionPolicyForProfile 根据 profile 的 policy 能力组合权限策略；子代理复用同一套策略。
function permissionPolicyForProfile(
  profile: ChapterProfile,
  fileSystem: WorkspaceFileSystem,
  dependencies: BuildDependencies,
): PermissionPolicy | undefined {
  if (!profile.capabilities.has("policy")) {
    // 没有 policy 能力时只接受外部注入的 approvalProvider；审计与写边界由外部控制。
    return dependencies.approvalProvider === undefined
      ? undefined
      : new PermissionPolicy({ approval: dependencies.approvalProvider });
  }
  if (dependencies.approvalProvider === undefined) {
    // 有 policy 能力时必须同时提供 approvalProvider，否则干脆断开发起路径。
    throw new Error("approvalProvider is required for chapter 3 or later");
  }
  if (dependencies.auditSink === undefined) {
    throw new Error("auditSink is required for chapter 3 or later");
  }
  // 只提升写入工具；Shell 的执行审批由策略默认规则统一处理。
  return new PermissionPolicy({
    // 文件写入审批规则：只有 write_file/edit_file 触发确认弹窗。
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
