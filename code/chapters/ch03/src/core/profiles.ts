// P03 在文件工具基础上增加 policy，作为外部副作用的执行前边界。
export type Capability = "loop" | "powershell" | "tool_registry" | "files" | "policy";

export interface ChapterProfile {
  // 固定章节号，组合根依此拒绝能力越级。
  readonly chapter: number;
  // 不可变能力白名单，决定本章可装配组件。
  readonly capabilities: ReadonlySet<Capability>;
}

class CapabilitySet implements ReadonlySet<Capability> {
  // 用不可导出底层 Set 的包装实现 ReadonlySet，防止 profile 能力被外部修改。
  readonly #values: Set<Capability>;

  constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  // 返回能力数量，不暴露可变 Set。
  get size(): number {
    return this.#values.size;
  }

  // 判断能力是否属于当前章节白名单。
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

  // 以原生 Set 回调签名遍历能力。
  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  // 支持 for...of 而不暴露写入入口。
  [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }
}

export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  // P01 只有循环和 PowerShell，没有工具注册表，也没有文件能力。
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

export const P02: ChapterProfile = Object.freeze({
  chapter: 2,
  // P02 在此增加工具注册表和文件能力，但还没有权限策略。
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files"]),
});

export const P03: ChapterProfile = Object.freeze({
  chapter: 3,
  // P03 增加 policy，bootstrap 检测到此能力后强制注入审批和审计。
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files", "policy"]),
});

// 返回模块内冻结单例，拒绝无效或尚未迁移的章节号。
export function profileForChapter(chapter: number): ChapterProfile {
  // 仅返回模块内冻结的单例，供组合根用引用相等性校验 profile 来源。
  if (chapter === 1) {
    return P01;
  }
  if (chapter === 2) {
    return P02;
  }
  if (chapter === 3) {
    return P03;
  }
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
