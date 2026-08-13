/**
 * 章节能力档案：每个已迁移章节对应一个固定 profile。
 * P02 只比 P01 多 tool_registry 与 files 能力，bootstrap 根据 chapter 选择工具集。
 * CapabilitySet 只暴露只读接口，防止调用方通过类型断言修改白名单。
 */
// Profile 是章节能力白名单；P02 只比 P01 新增工具注册与文件访问。
export type Capability = "loop" | "powershell" | "tool_registry" | "files";

export interface ChapterProfile {
  // 固定章节号，组合根据此拒绝能力越级。
  readonly chapter: number;
  // 不可变能力白名单，决定允许装配的组件。
  readonly capabilities: ReadonlySet<Capability>;
}

// Set 的只读包装避免 profile.capabilities 被调用方通过类型断言后修改。
class CapabilitySet implements ReadonlySet<Capability> {
  readonly #values: Set<Capability>;

  // 复制输入数组，防止外部随后修改影响 profile。
  constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  // 返回已启用能力数量，不暴露可变集合。
  get size(): number {
    return this.#values.size;
  }

  // 判断某项能力是否属于当前章节白名单。
  has(value: Capability): boolean {
    return this.#values.has(value);
  }

  // 返回键值对迭代器以兼容 ReadonlySet。
  entries(): SetIterator<[Capability, Capability]> {
    return this.#values.entries();
  }

  // 返回能力名称迭代器。
  keys(): SetIterator<Capability> {
    return this.#values.keys();
  }

  // 返回能力值迭代器；Set 的键和值相同。
  values(): SetIterator<Capability> {
    return this.#values.values();
  }

  // 以原生 Set 回调签名遍历能力，第二个值参数与第一个保持一致。
  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  // 支持 for...of 遍历，同时不提供添加或删除能力的入口。
  [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }
}

// 第 1 章冻结 profile，仅包含循环和 PowerShell。
export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

// 第 2 章在 P01 基础上开启注册表和文件系统工具。
export const P02: ChapterProfile = Object.freeze({
  chapter: 2,
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files"]),
});

// 返回唯一冻结 profile，拒绝无效或尚未迁移的章节号。
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
