// Profile 是章节能力白名单，防止固定章节脚本继承尚未教学的能力。
// Capability 枚举定义了本章节暴露给组合根的能力种类：
//   - "loop": Agent 核心循环（AgentRunner），所有章节都包含
//   - "powershell": PowerShell 命令执行工具（仅第 1 章）
// 后续章节会扩展此联合类型以加入文件操作、搜索等新能力。
export type Capability = "loop" | "powershell";

export interface ChapterProfile {
  // 固定章节号与不可变能力集合共同限制组合根可装配的能力。
  // 组合根 (bootstrap.ts) 根据 profile 决定注入哪些组件。
  readonly chapter: number;
  readonly capabilities: ReadonlySet<Capability>;
}

class CapabilitySet implements ReadonlySet<Capability> {
  // 用私有 Set 实现只读接口，避免调用方通过 profile 修改能力集合。
  // CapabilitySet 确保外部代码无法 add/delete，profile 一旦定义就不可变。
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
    // 按 Set 的标准回调签名传入两次 value，保持 ReadonlySet 行为兼容。
    // forEach 的第二个参数 value2 和第一个相同，与原生 Set.forEach 签名一致。
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
  // "loop" + "powershell"：第 1 章只有核心循环和 PowerShell 工具。
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

export function profileForChapter(chapter: number): ChapterProfile {
  // 通用入口只能解析本快照实际提供的章节，拒绝尚未迁移的请求。
  // 当通用 CLI 请求未迁移章节时给出明确错误，避免运行时静默失败。
  if (chapter !== 1) {
    throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
  }
  return P01;
}
