export type Capability =
  | "loop"
  | "powershell"
  | "tool_registry"
  | "files"
  | "policy"
  | "hooks"
  | "todo"
  // subagent 表示可将自包含工作交给隔离 AgentRunner 执行。
  | "subagent"
  // skills 表示可以发现 workspace 技能摘要并按名称加载受控说明。
  | "skills"
  // artifacts 与 compaction 共同表示大结果落盘和受预算的上下文缩减。
  | "artifacts"
  | "compaction"
  // memory 表示回合可检索、提取并持久化工作区级记忆。
  | "memory"
  // dynamic_prompt 表示系统提示由运行时状态渲染，而非固定字符串。
  | "dynamic_prompt"
  // recovery 表示模型请求具备统一 deadline、退避、fallback 和长度恢复。
  | "recovery"
  // task_dag_json 表示任务依赖图由注入的 JSON TaskStore 持久化。
  | "task_dag_json"
  // background 表示可启动受控后台作业并通过事件队列回传终态。
  | "background";

export interface ChapterProfile {
  readonly chapter: number;
  readonly capabilities: ReadonlySet<Capability>;
}

// 用不可导出底层 Set 的包装实现 ReadonlySet，防止 profile 能力被外部修改。
class CapabilitySet implements ReadonlySet<Capability> {
  readonly #values: Set<Capability>;

  constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: Capability): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[Capability, Capability]> {
    return this.#values.entries();
  }

  keys(): SetIterator<Capability> {
    return this.#values.keys();
  }

  values(): SetIterator<Capability> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }
}

export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

export const P02: ChapterProfile = Object.freeze({
  chapter: 2,
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files"]),
});

export const P03: ChapterProfile = Object.freeze({
  chapter: 3,
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files", "policy"]),
});

// P04 在 P03 基础上加入 hooks，允许受限 Hook 生命周期扩展。
export const P04: ChapterProfile = Object.freeze({
  chapter: 4,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
  ]),
});

// P05 在 P04 基础上加入 todo，用于会话级计划快照与陈旧提醒。
export const P05: ChapterProfile = Object.freeze({
  chapter: 5,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
  ]),
});

// P06 在 P05 基础上加入 subagent，用于隔离委派并复用父级审批边界。
export const P06: ChapterProfile = Object.freeze({
  chapter: 6,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
  ]),
});

// P07 在 P06 基础上增加 skills 能力，让组合根按需扫描并注册知识加载工具。
export const P07: ChapterProfile = Object.freeze({
  chapter: 7,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
  ]),
});

// P08 在 P07 基础上增加 artifacts 与 compaction，让组合根接入请求级压缩和结果落盘。
export const P08: ChapterProfile = Object.freeze({
  chapter: 8,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
    "artifacts",
    "compaction",
  ]),
});

// P09 在 P08 能力上追加 memory，使同一 Loop 同时拥有请求级压缩与跨会话文件记忆。
export const P09: ChapterProfile = Object.freeze({
  chapter: 9,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
    "artifacts",
    "compaction",
    "memory",
  ]),
});

// P10 在 P09 能力上追加 dynamic_prompt，让组合根切换到运行时渲染系统提示。
export const P10: ChapterProfile = Object.freeze({
  chapter: 10,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
    "artifacts",
    "compaction",
    "memory",
    "dynamic_prompt",
  ]),
});

// P11 在 P10 能力上追加 recovery，模型请求由 RecoveryManager 接管。
export const P11: ChapterProfile = Object.freeze({
  chapter: 11,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
    "artifacts",
    "compaction",
    "memory",
    "dynamic_prompt",
    "recovery",
  ]),
});

// P12 在 P11 能力上追加 task_dag_json，由 JSON TaskStore 提供持久化任务依赖图。
export const P12: ChapterProfile = Object.freeze({
  chapter: 12,
  capabilities: new CapabilitySet([...P11.capabilities, "task_dag_json"]),
});

// P13 在 P12 能力上追加 background，由 EventInbox 回传后台作业终态。
export const P13: ChapterProfile = Object.freeze({
  chapter: 13,
  capabilities: new CapabilitySet([...P12.capabilities, "background"]),
});

// 仅返回模块内冻结的单例，供组合根用引用相等性校验 profile 来源。
export function profileForChapter(chapter: number): ChapterProfile {
  if (chapter === 1) {
    return P01;
  }
  if (chapter === 2) {
    return P02;
  }
  if (chapter === 3) {
    return P03;
  }
  if (chapter === 4) {
    return P04;
  }
  if (chapter === 5) {
    return P05;
  }
  if (chapter === 6) {
    return P06;
  }
  if (chapter === 7) {
    return P07;
  }
  if (chapter === 8) {
    return P08;
  }
  if (chapter === 9) {
    return P09;
  }
  if (chapter === 10) {
    return P10;
  }
  if (chapter === 11) {
    return P11;
  }
  if (chapter === 12) {
    return P12;
  }
  if (chapter === 13) {
    return P13;
  }
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
