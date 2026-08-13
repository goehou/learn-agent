// 章节能力清单：每个 profile 都是冻结单例，组合根据此决定启用的运行时边界。
export type Capability =
  | "loop"
  | "powershell"
  | "tool_registry"
  | "files"
  | "policy"
  | "hooks"
  | "todo"
  | "subagent"
  | "skills"
  | "artifacts"
  | "compaction"
  | "memory"
  | "dynamic_prompt"
  | "recovery"
  | "task_dag_json"
  | "background"
  | "cron"
  | "teammate"
  | "mailbox"
  // protocol 与 plan_gate 共同表示结构化审批消息和副作用执行门控。
  | "protocol"
  | "plan_gate"
  // task_dag_sqlite 与 work_stealing 表示带租约的 SQLite 任务图与去中心化认领。
  | "task_dag_sqlite"
  | "work_stealing"
  // worktree 启用受管 Git 工作树与动态 ToolContextProvider。
  | "worktree";

export interface ChapterProfile {
  // chapter 与能力集共同构成 profileForChapter 返回的固定单例。
  readonly chapter: number;
  readonly capabilities: ReadonlySet<Capability>;
}

class CapabilitySet implements ReadonlySet<Capability> {
  // 包装原生 Set，只暴露 ReadonlySet 契约。
  readonly #values: Set<Capability>;

  constructor(values: readonly Capability[]) {
    // 复制输入，外部修改不会改变已构建 profile。
    this.#values = new Set(values);
  }

  get size(): number {
    // 返回去重后的能力数量。
    return this.#values.size;
  }

  has(value: Capability): boolean {
    // 组合根通过能力位选择依赖，不散落章节号判断。
    return this.#values.has(value);
  }

  entries(): SetIterator<[Capability, Capability]> {
    // 迭代行为与原生 Set 一致。
    return this.#values.entries();
  }

  keys(): SetIterator<Capability> {
    // 不暴露内部可变 Set。
    return this.#values.keys();
  }

  values(): SetIterator<Capability> {
    // 保留能力构建顺序，便于下一章累计展开。
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    // 第三个参数传只读包装本身。
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  [Symbol.iterator](): SetIterator<Capability> {
    // 支持扩展运算符构建累计能力集。
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

export const P12: ChapterProfile = Object.freeze({
  chapter: 12,
  capabilities: new CapabilitySet([...P11.capabilities, "task_dag_json"]),
});

export const P13: ChapterProfile = Object.freeze({
  chapter: 13,
  capabilities: new CapabilitySet([...P12.capabilities, "background"]),
});

export const P14: ChapterProfile = Object.freeze({
  chapter: 14,
  capabilities: new CapabilitySet([...P13.capabilities, "cron"]),
});

export const P15: ChapterProfile = Object.freeze({
  chapter: 15,
  capabilities: new CapabilitySet([...P14.capabilities, "teammate", "mailbox"]),
});

export const P16: ChapterProfile = Object.freeze({
  chapter: 16,
  capabilities: new CapabilitySet([...P15.capabilities, "protocol", "plan_gate"]),
});

// P17 在 P16 基础上追加 SQLite 任务图与 work stealing，让 Lead、子代理和队友共享同一认领路径。
export const P17: ChapterProfile = Object.freeze({
  chapter: 17,
  capabilities: new CapabilitySet([...P16.capabilities, "task_dag_sqlite", "work_stealing"]),
});

// P18 在 SQLite 工作窃取之上加入受控 Git worktree 隔离。
export const P18: ChapterProfile = Object.freeze({
  chapter: 18,
  capabilities: new CapabilitySet([...P17.capabilities, "worktree"]),
});

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
  if (chapter === 14) {
    return P14;
  }
  if (chapter === 15) {
    return P15;
  }
  if (chapter === 16) {
    return P16;
  }
  if (chapter === 17) {
    return P17;
  }
  if (chapter === 18) {
    return P18;
  }
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
