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
  // worktree 表示受控 Git 工作树隔离，mcp 表示可动态发布和撤销的远程 MCP 工具边界。
  | "worktree"
  | "mcp"
  // full_harness 标记 P20 完整能力集，不新增独立运行时。
  | "full_harness";

export interface ChapterProfile {
  readonly chapter: number;
  readonly capabilities: ReadonlySet<Capability>;
}

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

// 每章只声明新增能力；后续章节通过累计 PROFILE_DELTAS 得到完整档案。
const PROFILE_DELTAS = [
  ["loop", "powershell"],
  ["tool_registry", "files"],
  ["policy"],
  ["hooks"],
  ["todo"],
  ["subagent"],
  ["skills"],
  ["artifacts", "compaction"],
  ["memory"],
  ["dynamic_prompt"],
  ["recovery"],
  ["task_dag_json"],
  ["background"],
  ["cron"],
  ["teammate", "mailbox"],
  ["protocol", "plan_gate"],
  ["task_dag_sqlite", "work_stealing"],
  ["worktree"],
  ["mcp"],
  // full_harness 是 P20 的标记能力：不新增具体运行时，只声明前十九章能力全部生效。
  ["full_harness"],
] as const satisfies readonly (readonly Capability[])[];

// PROFILES 由增量能力数组推导，保证每章档案都是前一章的严格超集。
const PROFILES: readonly ChapterProfile[] = Object.freeze(
  PROFILE_DELTAS.map((_, index) =>
    Object.freeze({
      chapter: index + 1,
      capabilities: new CapabilitySet(PROFILE_DELTAS.slice(0, index + 1).flat()),
    }),
  ),
);

export const P01 = profileAt(1);
export const P02 = profileAt(2);
export const P03 = profileAt(3);
export const P04 = profileAt(4);
export const P05 = profileAt(5);
export const P06 = profileAt(6);
export const P07 = profileAt(7);
export const P08 = profileAt(8);
export const P09 = profileAt(9);
export const P10 = profileAt(10);
export const P11 = profileAt(11);
export const P12 = profileAt(12);
export const P13 = profileAt(13);
export const P14 = profileAt(14);
export const P15 = profileAt(15);
export const P16 = profileAt(16);
export const P17 = profileAt(17);
export const P18 = profileAt(18);
export const P19 = profileAt(19);
// P20 是完整 Harness 档案，统一启用前十九章已经验证的累计能力。
export const P20 = profileAt(20);

export function profileForChapter(chapter: number): ChapterProfile {
  // 只有 1 到 20 的固定章节可查询；越界立即失败，避免调用方构造未知档案。
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > PROFILES.length) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  return profileAt(chapter);
}

function profileAt(chapter: number): ChapterProfile {
  const profile = PROFILES[chapter - 1];
  // 未迁移章节在运行前显式失败，而不是返回空能力集。
  if (profile === undefined) {
    throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
  }
  return profile;
}
