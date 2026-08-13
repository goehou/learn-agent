// Profile 是章节能力白名单，防止固定章节脚本继承尚未教学的能力。
// Capability 枚举定义了本章节暴露给组合根的能力种类：
//   - "loop": Agent 核心循环（AgentRunner），所有章节都包含
//   - "powershell": PowerShell 命令执行工具（仅第 1 章）
// 后续章节会扩展此联合类型以加入文件操作、搜索等新能力。
export type Capability = "loop" | "powershell";

// 固定章节的能力边界；组合根只能根据该白名单装配对应阶段已教学的组件。
export interface ChapterProfile {
  // 固定章节号与不可变能力集合共同限制组合根可装配的能力。
  // 组合根 (bootstrap.ts) 根据 profile 决定注入哪些组件。
  readonly chapter: number;
  readonly capabilities: ReadonlySet<Capability>;
}

// 对只读能力集合的最小实现，隐藏可变 Set 以保持 profile 在导出后不可修改。
class CapabilitySet implements ReadonlySet<Capability> {
  // 用私有 Set 实现只读接口，避免调用方通过 profile 修改能力集合。
  // CapabilitySet 确保外部代码无法 add/delete，profile 一旦定义就不可变。
  readonly #values: Set<Capability>;

  // 从字面量能力列表创建私有副本，调用方随后修改原数组不会影响 profile。
  constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  // 暴露能力数量，同时不泄露底层可变集合。
  get size(): number {
    return this.#values.size;
  }

  // 判断特定能力是否在当前章节白名单内。
  has(value: Capability): boolean {
    return this.#values.has(value);
  }

  // 按原生 Set 约定返回键值对迭代器，兼容 ReadonlySet 消费方。
  entries(): SetIterator<[Capability, Capability]> {
    return this.#values.entries();
  }

  // 返回能力名称迭代器。
  keys(): SetIterator<Capability> {
    return this.#values.keys();
  }

  // 返回能力值迭代器；Set 的键和值相同，但该方法满足 ReadonlySet 契约。
  values(): SetIterator<Capability> {
    return this.#values.values();
  }

  // 以原生 Set 的回调签名遍历能力，第二个 value 参数保持协议兼容。
  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    // 按 Set 的标准回调签名传入两次 value，保持 ReadonlySet 行为兼容。
    // forEach 的第二个参数 value2 和第一个相同，与原生 Set.forEach 签名一致。
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  // 让能力集合可用于 for...of 和展开语法，不提供任何写入入口。
  [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }
}

// 第 1 章冻结 profile；只开放最小 Agent Loop 与 PowerShell 执行能力。
export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  // "loop" + "powershell"：第 1 章只有核心循环和 PowerShell 工具。
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

// 将通用 CLI 的章节号解析为本快照实际存在的 profile，拒绝未迁移章节。
export function profileForChapter(chapter: number): ChapterProfile {
  // 通用入口只能解析本快照实际提供的章节，拒绝尚未迁移的请求。
  // 当通用 CLI 请求未迁移章节时给出明确错误，避免运行时静默失败。
  if (chapter !== 1) {
    throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
  }
  return P01;
}
