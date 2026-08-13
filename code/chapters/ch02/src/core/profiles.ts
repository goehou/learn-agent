/**
 * 章节能力档案：每个已迁移章节对应一个固定 profile。
 * P02 只比 P01 多 tool_registry 与 files 能力，bootstrap 根据 chapter 选择工具集。
 * CapabilitySet 只暴露只读接口，防止调用方通过类型断言修改白名单。
 */
// Profile 是章节能力白名单；P02 只比 P01 新增工具注册与文件访问。
export type Capability = "loop" | "powershell" | "tool_registry" | "files";

export interface ChapterProfile {
  readonly chapter: number;
  readonly capabilities: ReadonlySet<Capability>;
}

// Set 的只读包装避免 profile.capabilities 被调用方通过类型断言后修改。
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

export function profileForChapter(chapter: number): ChapterProfile {
  // 已迁移章节返回单例，以便组装层可用对象身份拒绝伪造 profile。
  if (chapter === 1) {
    return P01;
  }
  if (chapter === 2) {
    return P02;
  }
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
