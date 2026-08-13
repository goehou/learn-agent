import { z } from "zod";
import { describe, expect, test } from "vitest";

import {
  PERMISSION_BEHAVIORS,
  PermissionContractError,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
  PermissionRule,
} from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink } from "../src/core/permissions.js";
import { toolCall } from "../src/core/messages.js";
import type { EffectClass, PreparedToolCall, ToolContext } from "../src/core/tools.js";
import { ToolRegistry, toolSuccess } from "../src/core/tools.js";

const context: ToolContext = Object.freeze({ workspace: process.cwd(), identity: "tester" });

function preparedCall(name: string, effect: EffectClass, argumentsJson: string): PreparedToolCall {
  const registry = new ToolRegistry();
  const inputSchema: z.ZodType<unknown> =
    effect === "execute"
      ? z.strictObject({ command: z.string() })
      : z.strictObject({ path: z.string() });
  registry.register({
    name,
    description: `Test ${name}.`,
    inputSchema,
    effect,
    handler: () => toolSuccess("must not execute"),
  });
  const prepared = registry.prepare(toolCall(`call-${name}`, name, argumentsJson));
  if (prepared.error !== undefined) {
    throw new Error("test setup produced an invalid prepared call");
  }
  return prepared;
}

class RecordingApprovalProvider implements ApprovalProvider {
  readonly requests: PermissionRequest[] = [];
  readonly #result: unknown;

  constructor(result: unknown) {
    this.#result = result;
  }

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    this.requests.push(request);
    if (this.#result instanceof Error) {
      throw this.#result;
    }
    return this.#result as PermissionDecision;
  }
}

class RecordingAuditSink implements AuditSink {
  readonly records: {
    readonly request: PermissionRequest;
    readonly decision: PermissionDecision;
  }[] = [];

  async record(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.records.push({ request, decision });
  }
}

class RecordingWriteBoundary {
  readonly calls: { readonly workspace: string; readonly path: string }[] = [];
  readonly #result: boolean | Error;

  constructor(result: boolean | Error) {
    this.#result = result;
  }

  async isPathWithinWorkspace(workspace: string, path: string): Promise<boolean> {
    this.calls.push({ workspace, path });
    if (this.#result instanceof Error) {
      throw this.#result;
    }
    return this.#result;
  }
}

function requestFor(
  prepared: PreparedToolCall,
  recommendations: readonly PermissionDecision[] = [],
): PermissionRequest {
  return new PermissionRequest({ prepared, context, recommendations });
}

describe("permission policy", () => {
  test("defines exactly four explicit behaviors", () => {
    expect(PERMISSION_BEHAVIORS).toEqual(["allow", "deny", "ask", "passthrough"]);
  });

  test("deny beats allow without requesting approval and is audited", async () => {
    const prepared = preparedCall("read_file", "read", '{"path":"notes.txt"}');
    const approval = new RecordingApprovalProvider(
      new PermissionDecision("allow", "user approved", "approval"),
    );
    const audit = new RecordingAuditSink();
    const policy = new PermissionPolicy({
      rules: [
        new PermissionRule({
          name: "project-allow",
          behavior: "allow",
          reason: "project allows reads",
          matches: () => true,
        }),
        new PermissionRule({
          name: "organization-deny",
          behavior: "deny",
          reason: "organization blocks this path",
          matches: () => true,
        }),
      ],
      approval,
      audit,
    });

    const decision = await policy.decide(requestFor(prepared));

    expect(decision).toEqual(
      new PermissionDecision("deny", "organization blocks this path", "organization-deny"),
    );
    expect(approval.requests).toEqual([]);
    expect(audit.records.map((record) => record.decision)).toEqual([decision]);
  });

  test("ask fails closed without approval and explicit approval runs once", async () => {
    const prepared = preparedCall("write_file", "write", '{"path":"notes.txt"}');
    const boundary = new RecordingWriteBoundary(true);
    const askRule = new PermissionRule({
      name: "confirm-write",
      behavior: "ask",
      reason: "writing requires confirmation",
      matches: () => true,
    });
    const denied = await new PermissionPolicy({ rules: [askRule], writeBoundary: boundary }).decide(
      requestFor(prepared),
    );
    const approval = new RecordingApprovalProvider(
      new PermissionDecision("allow", "approved once", "approval"),
    );
    const allowed = await new PermissionPolicy({
      rules: [askRule],
      approval,
      writeBoundary: boundary,
    }).decide(requestFor(prepared));

    expect(denied).toEqual(
      new PermissionDecision(
        "deny",
        "Approval was not explicitly granted: writing requires confirmation",
        "approval",
      ),
    );
    expect(denied.toToolResult()).toMatchObject({
      isError: true,
      errorCode: "permission_denied",
    });
    expect(allowed).toEqual(new PermissionDecision("allow", "approved once", "approval"));
    expect(approval.requests).toHaveLength(1);
    expect(approval.requests[0]?.proposedDecision).toEqual(
      new PermissionDecision("ask", "writing requires confirmation", "confirm-write"),
    );
  });

  test("approval exceptions and invalid approval results fail closed and are audited", async () => {
    const prepared = preparedCall("write_file", "write", '{"path":"notes.txt"}');
    const boundary = new RecordingWriteBoundary(true);
    const audit = new RecordingAuditSink();
    const rule = new PermissionRule({
      name: "confirm-write",
      behavior: "ask",
      reason: "writing requires confirmation",
      matches: () => true,
    });
    const failed = await new PermissionPolicy({
      rules: [rule],
      approval: new RecordingApprovalProvider(new Error("terminal unavailable")),
      audit,
      writeBoundary: boundary,
    }).decide(requestFor(prepared));
    const invalid = await new PermissionPolicy({
      rules: [rule],
      approval: new RecordingApprovalProvider({ allowed: true }),
      writeBoundary: boundary,
    }).decide(requestFor(prepared));
    const nonFinal = await Promise.all(
      (["ask", "passthrough"] as const).map((behavior) =>
        new PermissionPolicy({
          rules: [rule],
          approval: new RecordingApprovalProvider(
            new PermissionDecision(behavior, "not final", "approval"),
          ),
          writeBoundary: boundary,
        }).decide(requestFor(prepared)),
      ),
    );

    expect(failed).toEqual(
      new PermissionDecision("deny", "Approval provider failed; request denied", "approval"),
    );
    expect(invalid).toEqual(
      new PermissionDecision("deny", "Approval provider returned an invalid decision", "approval"),
    );
    expect(nonFinal).toEqual([
      new PermissionDecision(
        "deny",
        "Approval was not explicitly granted: writing requires confirmation",
        "approval",
      ),
      new PermissionDecision(
        "deny",
        "Approval was not explicitly granted: writing requires confirmation",
        "approval",
      ),
    ]);
    expect(audit.records.map((record) => record.decision)).toEqual([failed]);
  });

  test("workspace denial cannot be relaxed by rules, recommendations, or approval", async () => {
    const prepared = preparedCall("write_file", "write", '{"path":"../outside.txt"}');
    const boundary = new RecordingWriteBoundary(false);
    const approval = new RecordingApprovalProvider(
      new PermissionDecision("allow", "user approved", "approval"),
    );
    const hookAllow = new PermissionDecision("allow", "hook allows", "hook");
    const policy = new PermissionPolicy({
      rules: [
        new PermissionRule({
          name: "project-allow",
          behavior: "allow",
          reason: "project allows writes",
          matches: () => true,
        }),
      ],
      approval,
      writeBoundary: boundary,
    });

    const decision = await policy.decide(requestFor(prepared, [hookAllow]));

    expect(decision).toEqual(
      new PermissionDecision(
        "deny",
        "Writing outside the workspace is forbidden",
        "workspace-boundary",
      ),
    );
    expect(approval.requests).toEqual([]);
    expect(boundary.calls).toEqual([{ workspace: process.cwd(), path: "../outside.txt" }]);
  });

  test("shell defaults to ask while reads and passthrough safely default to allow", async () => {
    const shell = preparedCall("shell", "execute", '{"command":"Get-Location"}');
    const read = preparedCall("read_file", "read", '{"path":"notes.txt"}');
    const deniedShell = await new PermissionPolicy().decide(requestFor(shell));
    const approval = new RecordingApprovalProvider(
      new PermissionDecision("allow", "command approved", "approval"),
    );
    const allowedShell = await new PermissionPolicy({ approval }).decide(requestFor(shell));
    const allowedRead = await new PermissionPolicy({
      rules: [
        new PermissionRule({
          name: "no-opinion",
          behavior: "passthrough",
          reason: "not applicable",
          matches: () => true,
        }),
      ],
    }).decide(requestFor(read));

    expect(deniedShell.reason).toBe(
      "Approval was not explicitly granted: Shell execution requires approval",
    );
    expect(allowedShell).toEqual(new PermissionDecision("allow", "command approved", "approval"));
    expect(allowedRead).toEqual(
      new PermissionDecision("allow", "No permission rule blocked the request", "default"),
    );
  });

  test("rule and write-boundary failures deny with stable reasons", async () => {
    const read = preparedCall("read_file", "read", '{"path":"notes.txt"}');
    const brokenRule = new PermissionRule({
      name: "broken-rule",
      behavior: "allow",
      reason: "unused",
      matches: () => {
        throw new Error("rule backend unavailable");
      },
    });
    const ruleDecision = await new PermissionPolicy({ rules: [brokenRule] }).decide(
      requestFor(read),
    );
    const write = preparedCall("write_file", "write", '{"path":"notes.txt"}');
    const boundaryDecision = await new PermissionPolicy({
      writeBoundary: new RecordingWriteBoundary(new Error("resolver unavailable")),
    }).decide(requestFor(write));

    expect(ruleDecision).toEqual(
      new PermissionDecision("deny", "Permission rule failed: broken-rule", "broken-rule"),
    );
    expect(boundaryDecision).toEqual(
      new PermissionDecision(
        "deny",
        "Write path could not be resolved safely",
        "workspace-boundary",
      ),
    );
  });

  test("rejects malformed requests and non-deny tool-result conversion", () => {
    const prepared = preparedCall("read_file", "read", '{"path":"notes.txt"}');
    expect(
      () =>
        new PermissionRequest({
          prepared,
          context,
          recommendations: ["allow"] as unknown as PermissionDecision[],
        }),
    ).toThrow(PermissionContractError);
    expect(
      () =>
        new PermissionRequest({
          prepared,
          context,
          recommendations: "allow" as unknown as PermissionDecision[],
        }),
    ).toThrow(PermissionContractError);
    expect(
      () =>
        new PermissionRequest({
          prepared,
          context,
          proposedDecision: new PermissionDecision("allow", "not an ask", "rule"),
        }),
    ).toThrow(PermissionContractError);
    expect(() => new PermissionDecision("allow", 1 as unknown as string, "test")).toThrow(
      PermissionContractError,
    );
    expect(() => new PermissionDecision("allow", "allowed", "test").toToolResult()).toThrow(
      PermissionContractError,
    );
  });
});
