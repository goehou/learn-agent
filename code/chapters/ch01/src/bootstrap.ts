import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import { AgentRunner } from "./core/loop.js";
import type { ToolAuthorizer } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ChapterProfile } from "./core/profiles.js";
import { createChapterOneTools } from "./features/builtin-tools.js";

// 组合根（Composition Root）：负责把模型适配器、命令适配器和工具注册表装配为 AgentRunner。
//
// 核心循环只依赖 ModelClient / CommandRunner / ToolRegistry 等接口，
// 具体进程与 SDK 的创建集中在这里，测试也能注入替身隔离网络和操作系统。
// buildAgent 同时以 ChapterProfile 限制能力白名单，防止后续章节能力泄漏进第 1 章。
//
// 固定系统提示词属于组装配置；循环在每轮模型请求前注入它。
const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";

// 组装层只负责注入章节依赖，核心循环不直接依赖具体进程实现。
export interface BuildDependencies {
  // 调用方提供模型边界，测试可注入确定性替身以隔离网络。
  readonly model: ModelClient;
  // 绝对或相对工作目录最终由 AgentRunner 规范化并传给工具。
  readonly workspace: string;
  // 未注入时才创建真实 PowerShell 适配器，避免测试依赖进程。
  readonly commandRunner?: CommandRunner;
  // 可选人工授权边界；未提供时按本章最小循环直接执行工具。
  readonly authorizer?: ToolAuthorizer;
  // 为循环设置有限回合预算，防止模型持续请求工具。
  readonly maxTurns?: number;
}

// 组合根：把第 1 章允许的工具、模型和运行上下文装配为单一循环实例。
// profile 必须属于本章节；dependencies 只承载基础设施而不承载业务流程。
export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // 固定章节入口拒绝更高版本 profile，防止能力从后续章节意外泄漏。
  if (profile.chapter !== 1) {
    throw new Error(`Chapter ${profile.chapter} has not been migrated to TypeScript yet`);
  }
  // 仅在依赖未注入时使用默认适配器，其他依赖原样透传给核心循环。
  return new AgentRunner({
    model: dependencies.model,
    tools: createChapterOneTools(
      dependencies.commandRunner === undefined
        ? new PowerShellRunner()
        : dependencies.commandRunner,
    ),
    systemPrompt: SYSTEM_PROMPT,
    workspace: dependencies.workspace,
    ...(dependencies.authorizer === undefined ? {} : { authorizer: dependencies.authorizer }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}
