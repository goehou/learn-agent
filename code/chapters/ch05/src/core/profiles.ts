// 章节能力快照：每章一个冻结单例，组合根用引用相等校验 profile 来源。
// P05 将 todo 加入章节能力集，用于显式计划快照与陈旧计划提醒。
export type Capability =
  | "loop"
  | "powershell"
  | "tool_registry"
  | "files"
  | "policy"
  | "hooks"
  // todo 表示 Agent 已具备显式计划快照与陈旧计划提醒能力。
  | "todo";

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
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
