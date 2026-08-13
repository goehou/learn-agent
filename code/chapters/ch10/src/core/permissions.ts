// 权限策略在工具执行前集中裁决，并将最终决策写入审计边界。
import type { WorkspaceWriteBoundary } from "./filesystem.js";
import type { PreparedToolCall, ToolContext, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

export const PERMISSION_BEHAVIORS = Object.freeze(["allow", "deny", "ask", "passthrough"] as const);
export type PermissionBehavior = (typeof PERMISSION_BEHAVIORS)[number];

export class PermissionContractError extends Error {}

export function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  return PERMISSION_BEHAVIORS.some((behavior) => behavior === value);
}

// 不可变裁决值；只有最终 deny 才能转成模型可见的工具错误结果。
export class PermissionDecision {
  readonly behavior: PermissionBehavior;
  readonly reason: string;
  readonly source: string;

  constructor(behavior: PermissionBehavior, reason: string, source: string) {
    if (!isPermissionBehavior(behavior)) {
      throw new PermissionContractError("behavior must be a PermissionBehavior");
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new PermissionContractError("permission decision reason must not be empty");
    }
    if (typeof source !== "string" || source.trim().length === 0) {
      throw new PermissionContractError("permission decision source must not be empty");
    }
    this.behavior = behavior;
    this.reason = reason;
    this.source = source;
    Object.freeze(this);
  }

  get isAllowed(): boolean {
    return this.behavior === "allow";
  }

  toToolResult(): ToolResult {
    if (this.behavior !== "deny") {
      throw new PermissionContractError("only a final deny decision can become a tool result");
    }
    return toolError("permission_denied", this.reason);
  }
}

export interface PermissionRequestOptions {
  readonly prepared: PreparedToolCall;
  readonly context: ToolContext;
  readonly recommendations?: readonly PermissionDecision[];
  readonly proposedDecision?: PermissionDecision;
}

// 把已校验工具调用、运行时上下文与各参与者建议封装成不可变请求，供规则和审批共同消费。
export class PermissionRequest {
  readonly prepared: PreparedToolCall;
  readonly context: ToolContext;
  readonly recommendations: readonly PermissionDecision[];
  readonly proposedDecision: PermissionDecision | undefined;

  constructor(options: PermissionRequestOptions) {
    if (
      options.prepared.error !== undefined ||
      options.prepared.definition === undefined ||
      options.prepared.arguments === undefined
    ) {
      throw new PermissionContractError("permission request requires a valid prepared tool call");
    }
    const recommendations = options.recommendations === undefined ? [] : options.recommendations;
    if (
      !Array.isArray(recommendations) ||
      !recommendations.every((decision) => decision instanceof PermissionDecision)
    ) {
      throw new PermissionContractError("recommendations must contain PermissionDecision values");
    }
    if (
      options.proposedDecision !== undefined &&
      (!(options.proposedDecision instanceof PermissionDecision) ||
        options.proposedDecision.behavior !== "ask")
    ) {
      throw new PermissionContractError("proposedDecision must be an ask PermissionDecision");
    }
    this.prepared = options.prepared;
    this.context = options.context;
    this.recommendations = Object.freeze([...recommendations]);
    this.proposedDecision = options.proposedDecision;
    Object.freeze(this);
  }
}

export type PermissionMatcher = (request: PermissionRequest) => boolean;

export interface PermissionRuleOptions {
  readonly name: string;
  readonly behavior: PermissionBehavior;
  readonly reason: string;
  readonly matches: PermissionMatcher;
}

// 规则由名称、行为、原因和匹配函数组成，不持有工具执行逻辑。
export class PermissionRule {
  readonly name: string;
  readonly behavior: PermissionBehavior;
  readonly reason: string;
  readonly matches: PermissionMatcher;

  constructor(options: PermissionRuleOptions) {
    if (typeof options.name !== "string" || options.name.trim().length === 0) {
      throw new PermissionContractError("permission rule name must not be empty");
    }
    if (!isPermissionBehavior(options.behavior)) {
      throw new PermissionContractError("permission rule behavior must be a PermissionBehavior");
    }
    if (typeof options.reason !== "string" || options.reason.trim().length === 0) {
      throw new PermissionContractError("permission rule reason must not be empty");
    }
    if (typeof options.matches !== "function") {
      throw new PermissionContractError("permission rule matcher must be callable");
    }
    this.name = options.name;
    this.behavior = options.behavior;
    this.reason = options.reason;
    this.matches = options.matches;
    Object.freeze(this);
  }

  evaluate(request: PermissionRequest): PermissionDecision | undefined {
    if (!this.matches(request)) {
      return undefined;
    }
    return new PermissionDecision(this.behavior, this.reason, this.name);
  }
}

export interface ApprovalProvider {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface AuditSink {
  record(request: PermissionRequest, decision: PermissionDecision): Promise<void>;
}

export interface PermissionPolicyOptions {
  readonly rules?: readonly PermissionRule[];
  readonly approval?: ApprovalProvider;
  readonly audit?: AuditSink;
  readonly writeBoundary?: WorkspaceWriteBoundary;
}

export class PermissionPolicy {
  readonly #rules: readonly PermissionRule[];
  readonly #approval: ApprovalProvider | undefined;
  readonly #audit: AuditSink | undefined;
  readonly #writeBoundary: WorkspaceWriteBoundary | undefined;

  constructor(options: PermissionPolicyOptions = {}) {
    const rules = options.rules === undefined ? [] : options.rules;
    if (!Array.isArray(rules) || !rules.every((rule) => rule instanceof PermissionRule)) {
      throw new PermissionContractError("rules must contain PermissionRule values");
    }
    this.#rules = Object.freeze([...rules]);
    this.#approval = options.approval;
    this.#audit = options.audit;
    this.#writeBoundary = options.writeBoundary;
  }

  // 系统硬边界、默认 shell 审批、规则建议统一按保守优先级合并，再决定是否走人工审批。
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    if (!(request instanceof PermissionRequest)) {
      throw new PermissionContractError("request must be a PermissionRequest");
    }
    // 系统硬边界先参与合并，后续 allow 不能覆盖它产生的 deny。
    const candidates: PermissionDecision[] = [];
    const workspaceBoundary = await this.#workspaceBoundaryDecision(request);
    if (workspaceBoundary !== undefined) {
      candidates.push(workspaceBoundary);
    }
    const shellDefault = shellDefaultDecision(request);
    if (shellDefault !== undefined) {
      candidates.push(shellDefault);
    }
    candidates.push(...request.recommendations, ...this.#evaluateRules(request));

    const proposed = strongestDecision(candidates);
    let final: PermissionDecision;
    if (proposed.behavior === "ask") {
      final = await this.#resolveApproval(request, proposed);
    } else if (proposed.behavior === "passthrough") {
      final = new PermissionDecision("allow", "No permission rule blocked the request", "default");
    } else {
      final = proposed;
    }
    if (this.#audit !== undefined) {
      await this.#audit.record(request, final);
    }
    return final;
  }

  // 规则异常也 fail-closed，不因单个规则崩溃放行工具调用。
  #evaluateRules(request: PermissionRequest): readonly PermissionDecision[] {
    return this.#rules
      .map((rule) => {
        try {
          return rule.evaluate(request);
        } catch {
          return new PermissionDecision("deny", `Permission rule failed: ${rule.name}`, rule.name);
        }
      })
      .filter((decision): decision is PermissionDecision => decision !== undefined);
  }

  // 没有 approval、approval 抛错或返回非法值时都按 deny 处理；只有显式 allow/deny 才被接受。
  async #resolveApproval(
    request: PermissionRequest,
    proposed: PermissionDecision,
  ): Promise<PermissionDecision> {
    if (this.#approval === undefined) {
      return implicitApprovalDenial(proposed);
    }
    const approvalRequest = new PermissionRequest({
      prepared: request.prepared,
      context: request.context,
      recommendations: request.recommendations,
      proposedDecision: proposed,
    });
    let decision: unknown;
    try {
      decision = await this.#approval.decide(approvalRequest);
    } catch {
      return new PermissionDecision("deny", "Approval provider failed; request denied", "approval");
    }
    if (!(decision instanceof PermissionDecision)) {
      return new PermissionDecision(
        "deny",
        "Approval provider returned an invalid decision",
        "approval",
      );
    }
    if (decision.behavior === "allow" || decision.behavior === "deny") {
      return decision;
    }
    return implicitApprovalDenial(proposed);
  }

  // 写工具且带 path 时做真实路径边界检查；解析失败按 deny 处理，避免“不知道能不能写”就放行。
  async #workspaceBoundaryDecision(
    request: PermissionRequest,
  ): Promise<PermissionDecision | undefined> {
    const definition = request.prepared.definition;
    const argumentsValue = request.prepared.arguments;
    if (definition === undefined || argumentsValue === undefined) {
      throw new PermissionContractError("permission request lost validated tool data");
    }
    if (definition.effect !== "write") {
      return undefined;
    }
    const rawPath = Reflect.get(argumentsValue as object, "path");
    if (rawPath === undefined) {
      return undefined;
    }
    if (typeof rawPath !== "string") {
      return new PermissionDecision("deny", "Write path is invalid", "workspace-boundary");
    }
    if (this.#writeBoundary === undefined) {
      return undefined;
    }
    try {
      // 真实路径解析由组合根注入的文件系统边界完成，core 不依赖具体 adapter。
      const allowed = await this.#writeBoundary.isPathWithinWorkspace(
        request.context.workspace,
        rawPath,
      );
      if (typeof allowed !== "boolean") {
        throw new PermissionContractError("write boundary must return a boolean");
      }
      return allowed
        ? undefined
        : new PermissionDecision(
            "deny",
            "Writing outside the workspace is forbidden",
            "workspace-boundary",
          );
    } catch {
      return new PermissionDecision(
        "deny",
        "Write path could not be resolved safely",
        "workspace-boundary",
      );
    }
  }
}

// 多条建议冲突时选择最保守行为，避免宽松规则覆盖显式拒绝。
function strongestDecision(decisions: readonly PermissionDecision[]): PermissionDecision {
  for (const behavior of ["deny", "ask", "allow"] as const) {
    const decision = decisions.find((candidate) => candidate.behavior === behavior);
    if (decision !== undefined) {
      return decision;
    }
  }
  return new PermissionDecision(
    "passthrough",
    "No permission participant made a decision",
    "default",
  );
}

// 人工审批没有被明确授予时默认拒绝，避免未配置审批人的 ask 变成放行。
function implicitApprovalDenial(proposed: PermissionDecision): PermissionDecision {
  return new PermissionDecision(
    "deny",
    `Approval was not explicitly granted: ${proposed.reason}`,
    "approval",
  );
}

// execute effect 默认需要人工审批，Shell 调用不能由工具自身决定放行。
function shellDefaultDecision(request: PermissionRequest): PermissionDecision | undefined {
  const definition = request.prepared.definition;
  if (definition === undefined) {
    throw new PermissionContractError("permission request lost its tool definition");
  }
  if (definition.effect !== "execute") {
    return undefined;
  }
  return new PermissionDecision("ask", "Shell execution requires approval", "shell-default");
}
