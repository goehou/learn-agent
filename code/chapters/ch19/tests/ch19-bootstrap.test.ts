import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { buildAgent, type BuildDependencies } from "../src/bootstrap.js";
import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { AjvMcpSchemaValidator } from "../src/adapters/mcp-schema.js";
import { JsonProtocolStore } from "../src/adapters/protocol-json.js";
import { SqliteTaskStore } from "../src/adapters/task-sqlite.js";
import { EventInbox } from "../src/core/events.js";
import { assistantMessage, toolCall } from "../src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import { P18, P19 } from "../src/core/profiles.js";
import type { PermissionRequest, ApprovalProvider, AuditSink } from "../src/core/permissions.js";
import { PermissionDecision } from "../src/core/permissions.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import {
  McpCallResult,
  McpPublishedTool,
  McpRuntime,
  McpServerSpec,
  McpToolPolicy,
} from "../src/features/mcp-tools.js";
import type { McpConnection, McpConnectionFactory } from "../src/features/mcp-tools.js";
import { ProtocolRuntime } from "../src/features/protocol.js";
import { RecoveryConfig } from "../src/features/recovery.js";
import { TeammateRuntime } from "../src/features/teammates.js";
import { WorkStealingRuntime } from "../src/features/work-stealing.js";
import { WorktreeRuntime } from "../src/features/worktrees.js";

class Model implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const names = request.tools.map((tool) => tool.function.name);
    if (
      names.includes("connect_mcp") &&
      !request.messages.some((message) => message.role === "tool")
    ) {
      return {
        message: assistantMessage(null, [toolCall("connect", "connect_mcp", '{"alias":"fake"}')]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("done"), finishReason: "stop" };
  }
}

class ExternalToolModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #phase = 0;

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    if (this.#phase === 0) {
      this.#phase = 1;
      return {
        message: assistantMessage(null, [toolCall("connect", "connect_mcp", '{"alias":"fake"}')]),
        finishReason: "tool_calls",
      };
    }
    if (this.#phase === 1) {
      this.#phase = 2;
      return {
        message: assistantMessage(null, [toolCall("terminate", "mcp__fake__terminate", "{}")]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("done"), finishReason: "stop" };
  }
}

class DisconnectToolModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #phase = 0;

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    if (this.#phase === 0) {
      this.#phase = 1;
      return {
        message: assistantMessage(null, [toolCall("connect", "connect_mcp", '{"alias":"fake"}')]),
        finishReason: "tool_calls",
      };
    }
    if (this.#phase === 1) {
      this.#phase = 2;
      return {
        message: assistantMessage(null, [
          toolCall("disconnect", "disconnect_mcp", '{"alias":"fake"}'),
        ]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("done"), finishReason: "stop" };
  }
}

class ScopedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const systemPrompt = request.messages.find((message) => message.role === "system")?.content;
    const names = request.tools.map((tool) => tool.function.name);
    if (systemPrompt?.includes("focused coding subagent") === true) {
      return { message: assistantMessage("subagent done"), finishReason: "stop" };
    }
    if (systemPrompt?.includes("You are alice, serving as worker.") === true) {
      return { message: assistantMessage("teammate done"), finishReason: "stop" };
    }
    if (
      systemPrompt?.includes("You are a coding agent.") === true &&
      request.messages.filter((message) => message.role === "tool").length === 0
    ) {
      expect(names).toContain("task");
      expect(names).toContain("spawn_teammate");
      return {
        message: assistantMessage(null, [
          toolCall("subagent", "task", '{"description":"inspect the child scope"}'),
          toolCall(
            "teammate",
            "spawn_teammate",
            '{"name":"alice","role":"worker","prompt":"inspect the teammate scope"}',
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("lead done"), finishReason: "stop" };
  }
}

function expectNoMcpTools(request: ModelRequest): void {
  const names = request.tools.map((tool) => tool.function.name);
  expect(names).not.toContain("connect_mcp");
  expect(names).not.toContain("disconnect_mcp");
  expect(names.some((name) => name.startsWith("mcp__"))).toBe(false);
}

class Approval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test", "test");
  }
}

class SelectableApproval implements ApprovalProvider {
  readonly requestedNames: string[] = [];
  readonly #allowedNames: ReadonlySet<string>;

  constructor(...allowedNames: string[]) {
    this.#allowedNames = new Set(allowedNames);
  }

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    this.requestedNames.push(request.prepared.call.name);
    return this.#allowedNames.has(request.prepared.call.name)
      ? new PermissionDecision("allow", "approved by test", "test")
      : new PermissionDecision("deny", "denied by test", "test");
  }
}

class Audit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

class Connection implements McpConnection {
  readonly #published: readonly McpPublishedTool[];
  closeCalls = 0;
  callCalls = 0;
  #resolveFailure: () => void = () => {};
  readonly #failure = new Promise<void>((resolve) => {
    this.#resolveFailure = resolve;
  });

  constructor(
    published: readonly McpPublishedTool[] = [
      new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } }),
    ],
  ) {
    this.#published = published;
  }

  async listTools(): Promise<readonly McpPublishedTool[]> {
    return this.#published;
  }

  async callTool(): Promise<McpCallResult> {
    this.callCalls += 1;
    return new McpCallResult({ content: [], structuredContent: {}, isError: false });
  }

  waitForFailure(): Promise<void> {
    return this.#failure;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#resolveFailure();
  }
}

class Factory implements McpConnectionFactory {
  readonly connection: Connection;
  openCalls = 0;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async open(): Promise<McpConnection> {
    this.openCalls += 1;
    return this.connection;
  }
}

function runtime(
  connection: Connection,
  factory: Factory = new Factory(connection),
  toolPolicies: readonly McpToolPolicy[] = [
    new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
  ],
): McpRuntime {
  return new McpRuntime({
    servers: [
      new McpServerSpec({
        alias: "fake",
        command: "unused",
        args: [],
        toolPolicies,
        startupTimeoutSeconds: 1,
        toolTimeoutSeconds: 1,
      }),
    ],
    connectionFactory: factory,
    schemaValidator: new AjvMcpSchemaValidator(),
  });
}

async function dependencies(
  root: string,
  model: ModelClient,
  mcpRuntime?: McpRuntime,
  approvalProvider: ApprovalProvider = new Approval(),
): Promise<{ deps: BuildDependencies; resources: readonly { close(): Promise<void> }[] }> {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const cron = new CronRuntime({
    store: new JsonCronStore(root),
    inbox,
    supervisor,
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
  });
  const teammates = new TeammateRuntime({
    store: new FileMailboxStore(root),
    inbox,
    supervisor,
    cronRuntime: cron,
  });
  const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
  const store = new SqliteTaskStore(root);
  const worktrees = new WorktreeRuntime({
    workspace: root,
    store,
    gitRunner: { run: async () => ({ returncode: 0, stdout: "", stderr: "" }) },
  });
  const workStealing = new WorkStealingRuntime({ store, claimService: worktrees });
  const deps: BuildDependencies = {
    model,
    workspace: root,
    recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
    approvalProvider,
    auditSink: new Audit(),
    backgroundSupervisor: supervisor,
    cronRuntime: cron,
    teammateRuntime: teammates,
    protocolRuntime: protocol,
    workStealingRuntime: workStealing,
    worktreeRuntime: worktrees,
    ...(mcpRuntime === undefined ? {} : { mcpRuntime }),
  };
  return { deps, resources: [teammates, cron, supervisor] };
}

describe("chapter 19 bootstrap", () => {
  test("requires MCP runtime only from P19 onward", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch19-bootstrap-"));
    const model = new Model();
    const connection = new Connection();
    const current = await dependencies(root, model);
    const withRuntime = await dependencies(root, model, runtime(connection));
    try {
      expect(() => buildAgent(P19, current.deps)).toThrow(/mcpRuntime is required/);
      expect(() => buildAgent(P18, withRuntime.deps)).toThrow(/mcpRuntime requires/);
    } finally {
      await Promise.all(
        [...current.resources, ...withRuntime.resources].map((resource) => resource.close()),
      );
      await rm(root, { recursive: true, force: true });
    }
  });

  test("installs MCP only in Lead and closes the connection through AgentRunner", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch19-bootstrap-"));
    const model = new Model();
    const connection = new Connection();
    const { deps, resources } = await dependencies(root, model, runtime(connection));
    const runner = buildAgent(P19, deps);
    try {
      const result = await runner.run("connect");
      expect(result.finalText).toBe("done");
      const leadTools = model.requests[0]?.tools.map((tool) => tool.function.name) ?? [];
      expect(leadTools).toContain("connect_mcp");
      expect(leadTools).not.toContain("mcp__fake__lookup");
      expect(model.requests[1]?.tools.map((tool) => tool.function.name)).toContain(
        "mcp__fake__lookup",
      );
    } finally {
      await runner.close();
      await Promise.all(resources.map((resource) => resource.close()));
      expect(connection.closeCalls).toBe(1);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("asks before connecting MCP and keeps the transport closed when denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch19-bootstrap-"));
    const model = new ExternalToolModel();
    const connection = new Connection();
    const factory = new Factory(connection);
    const approval = new SelectableApproval();
    const { deps, resources } = await dependencies(
      root,
      model,
      runtime(connection, factory),
      approval,
    );
    const runner = buildAgent(P19, deps);
    try {
      const result = await runner.run("connect");
      expect(result.finalText).toBe("done");
      expect(approval.requestedNames).toContain("connect_mcp");
      expect(factory.openCalls).toBe(0);
      expect(connection.callCalls).toBe(0);
      expect(connection.closeCalls).toBe(0);
    } finally {
      await runner.close();
      await Promise.all(resources.map((resource) => resource.close()));
      expect(connection.closeCalls).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("asks before invoking an MCP external tool and keeps the remote handler zero-call when denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch19-bootstrap-"));
    const model = new ExternalToolModel();
    const connection = new Connection([
      new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } }),
      new McpPublishedTool({ name: "terminate", inputSchema: { type: "object" } }),
    ]);
    const factory = new Factory(connection);
    const approval = new SelectableApproval("connect_mcp");
    const { deps, resources } = await dependencies(
      root,
      model,
      runtime(connection, factory, [
        new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
        new McpToolPolicy({ remoteName: "terminate", effect: "external" }),
      ]),
      approval,
    );
    const runner = buildAgent(P19, deps);
    try {
      const result = await runner.run("connect then terminate");
      expect(result.finalText).toBe("done");
      expect(approval.requestedNames).toContain("connect_mcp");
      expect(approval.requestedNames).toContain("mcp__fake__terminate");
      expect(factory.openCalls).toBe(1);
      expect(connection.callCalls).toBe(0);
      expect(connection.closeCalls).toBe(0);
    } finally {
      await runner.close();
      await Promise.all(resources.map((resource) => resource.close()));
      expect(connection.closeCalls).toBe(1);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("asks before disconnecting MCP and keeps the connection open when denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch19-bootstrap-"));
    const model = new DisconnectToolModel();
    const connection = new Connection();
    const factory = new Factory(connection);
    const approval = new SelectableApproval("connect_mcp");
    const { deps, resources } = await dependencies(
      root,
      model,
      runtime(connection, factory),
      approval,
    );
    const runner = buildAgent(P19, deps);
    try {
      const result = await runner.run("connect then disconnect");
      expect(result.finalText).toBe("done");
      expect(approval.requestedNames).toContain("connect_mcp");
      expect(approval.requestedNames).toContain("disconnect_mcp");
      expect(factory.openCalls).toBe(1);
      expect(connection.closeCalls).toBe(0);
      const runnerRequests = model.requests.filter((request) => request.tools.length > 0);
      expect(runnerRequests.at(-1)?.tools.map((tool) => tool.function.name)).toContain(
        "mcp__fake__lookup",
      );
    } finally {
      await runner.close();
      await Promise.all(resources.map((resource) => resource.close()));
      expect(connection.closeCalls).toBe(1);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps MCP out of real Subagent and Teammate bootstrap runners", {
    timeout: 15_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch19-bootstrap-"));
    const model = new ScopedModel();
    const connection = new Connection();
    const { deps, resources } = await dependencies(root, model, runtime(connection));
    const runner = buildAgent(P19, deps);
    try {
      await expect(runner.run("exercise child scopes")).resolves.toMatchObject({
        finalText: "lead done",
      });
      await vi.waitFor(
        () => {
          expect(
            model.requests.some((request) =>
              request.messages.some(
                (message) =>
                  message.role === "system" &&
                  message.content.includes("You are alice, serving as worker."),
              ),
            ),
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
      const childRequests = model.requests.filter((request) => {
        const systemPrompt = request.messages.find((message) => message.role === "system")?.content;
        return (
          systemPrompt?.includes("focused coding subagent") === true ||
          systemPrompt?.includes("You are alice, serving as worker.") === true
        );
      });
      expect(childRequests).toHaveLength(2);
      for (const request of childRequests) expectNoMcpTools(request);
    } finally {
      await runner.close();
      await Promise.all(resources.map((resource) => resource.close()));
      expect(connection.closeCalls).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });
});
