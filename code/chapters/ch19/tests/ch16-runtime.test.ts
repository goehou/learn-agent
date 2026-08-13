import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { JsonProtocolStore } from "../src/adapters/protocol-json.js";
import { EventInbox } from "../src/core/events.js";
import { AgentRunner } from "../src/core/loop.js";
import { assistantMessage } from "../src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import { ToolRegistry } from "../src/core/tools.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import { ProtocolMessageKind, isProtocolMailboxMessage } from "../src/features/mailbox.js";
import { ProtocolRuntime } from "../src/features/protocol.js";
import { TeammateRuntime, TeammateStatus } from "../src/features/teammates.js";

class ResultModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #results: string[];
  constructor(...results: string[]) {
    this.#results = results;
  }
  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const text = this.#results.shift();
    if (text === undefined) throw new Error("unexpected model request");
    return Object.freeze({ message: assistantMessage(text), finishReason: "stop" });
  }
}

async function createRuntime(root: string, model: ResultModel) {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const cron = new CronRuntime({
    store: new JsonCronStore(root),
    inbox,
    supervisor,
    clock: { now: () => new Date("2026-07-30T08:00:00.000Z") },
  });
  const mailbox = new FileMailboxStore(root);
  const teammates = new TeammateRuntime({ store: mailbox, inbox, supervisor, cronRuntime: cron });
  const protocol = new ProtocolRuntime({
    store: new JsonProtocolStore(root),
    team: teammates,
  });
  teammates.configureProtocol(protocol);
  teammates.configureRunnerFactory((name, role, send) => {
    const tools = new ToolRegistry();
    tools.register(send);
    tools.register(protocol.submitPlanToolDefinition);
    return new AgentRunner({
      model,
      tools,
      systemPrompt: `You are ${name}, serving as ${role}.`,
      workspace: root,
      identity: name,
    });
  });
  await teammates.start();
  return { teammates, protocol, cron, supervisor, model, mailbox };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) throw new Error("Protocol delivery did not receive an AbortSignal");
  if (signal.aborted) throw new DOMException("Protocol delivery was aborted", "AbortError");
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("Protocol delivery was aborted", "AbortError")),
      { once: true },
    );
  });
}

describe("chapter 16 protocol routing", () => {
  test("shutdown is acknowledged on the lead and skips a model call", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-runtime-"));
    const model = new ResultModel("initial result");
    const runtime = await createRuntime(root, model);
    try {
      await runtime.teammates.spawn({
        name: "alice",
        role: "writer",
        prompt: "draft",
        sender: "lead",
      });
      const initial = await runtime.teammates.waitForEvents(1);
      await runtime.teammates.acknowledgeEvents(initial);
      const request = await runtime.protocol.requestShutdown("alice");
      const responseEvents = await runtime.teammates.waitForEvents(1);
      const response = responseEvents[0];
      expect(response).toBeDefined();
      if (response === undefined || !isProtocolMailboxMessage(response)) {
        throw new Error("shutdown response was not a protocol message");
      }
      expect(response.kind).toBe(ProtocolMessageKind.ShutdownResponse);
      expect(runtime.teammates.state("alice").status).toBe(TeammateStatus.Shutdown);
      expect(model.requests).toHaveLength(1);
      await runtime.teammates.acknowledgeEvents(responseEvents);
      expect((await runtime.protocol.store.getRequest(request.id)).status).toBe("approved");
    } finally {
      await runtime.teammates.close();
      await runtime.cron.close();
      await runtime.supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("plan approval response resumes the same worker runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-runtime-"));
    const model = new ResultModel("initial result", "approved work result");
    const runtime = await createRuntime(root, model);
    try {
      await runtime.teammates.spawn({
        name: "alice",
        role: "writer",
        prompt: "draft",
        sender: "lead",
      });
      const initial = await runtime.teammates.waitForEvents(1);
      await runtime.teammates.acknowledgeEvents(initial);
      const request = await runtime.protocol.submitPlan("alice", "write the config");
      const planEvents = await runtime.teammates.waitForEvents(1);
      await runtime.teammates.acknowledgeEvents(planEvents);
      await runtime.protocol.reviewPlan(request.id, true);
      const resultEvents = await runtime.teammates.waitForEvents(1);
      expect(resultEvents[0]?.toPayload().content).toBe("approved work result");
      expect(model.requests).toHaveLength(2);
      await runtime.teammates.acknowledgeEvents(resultEvents);
    } finally {
      await runtime.teammates.close();
      await runtime.cron.close();
      await runtime.supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("quarantines an invalid protocol message and continues the worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-runtime-"));
    const model = new ResultModel("initial result", "follow-up result");
    const runtime = await createRuntime(root, model);
    try {
      await runtime.teammates.spawn({
        name: "alice",
        role: "writer",
        prompt: "draft",
        sender: "lead",
      });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      await runtime.mailbox.sendProtocol(
        "lead",
        "alice",
        "unknown request",
        ProtocolMessageKind.ShutdownRequest,
        { requestId: "00000000-0000-4000-8000-000000000861", approved: null },
      );
      await runtime.teammates.send({ sender: "lead", to: "alice", content: "continue" });
      const events = await runtime.teammates.waitForEvents(1);
      expect(events[0]?.toPayload().content).toBe("follow-up result");
      expect(runtime.teammates.state("alice").status).toBe(TeammateStatus.Idle);
      await runtime.teammates.acknowledgeEvents(events);
    } finally {
      await runtime.teammates.close();
      await runtime.cron.close();
      await runtime.supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("close waits for cancelled response delivery and releases the shutdown request", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-runtime-"));
    const model = new ResultModel("initial result");
    const runtime = await createRuntime(root, model);
    const delivered = runtime.teammates.deliverProtocol.bind(runtime.teammates);
    let responseStarted: (() => void) | undefined;
    const responseStartedPromise = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    vi.spyOn(runtime.teammates, "deliverProtocol").mockImplementation(
      async (sender, recipient, content, kind, options) => {
        if (kind === ProtocolMessageKind.ShutdownResponse) {
          if (responseStarted === undefined)
            throw new Error("Response start resolver is unavailable");
          responseStarted();
          await waitForAbort(options.signal);
        }
        return await delivered(sender, recipient, content, kind, options);
      },
    );
    try {
      await runtime.teammates.spawn({
        name: "alice",
        role: "writer",
        prompt: "draft",
        sender: "lead",
      });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      const request = await runtime.protocol.requestShutdown("alice");
      await responseStartedPromise;
      await runtime.teammates.close();
      const recovered = await runtime.mailbox.claim("alice");
      expect(recovered).toMatchObject({
        kind: ProtocolMessageKind.ShutdownRequest,
        requestId: request.id,
      });
      if (recovered === undefined) throw new Error("Shutdown request was not released");
      await runtime.mailbox.release(recovered);
      expect((await runtime.protocol.store.getRequest(request.id)).status).toBe("pending");
    } finally {
      await runtime.teammates.close();
      await runtime.cron.close();
      await runtime.supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("response delivery failure releases the request and reports the worker failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch16-runtime-"));
    const model = new ResultModel("initial result");
    const runtime = await createRuntime(root, model);
    const delivered = runtime.teammates.deliverProtocol.bind(runtime.teammates);
    vi.spyOn(runtime.teammates, "deliverProtocol").mockImplementation(
      async (sender, recipient, content, kind, options) => {
        if (kind === ProtocolMessageKind.ShutdownResponse) {
          throw new Error("Mailbox is unavailable");
        }
        return await delivered(sender, recipient, content, kind, options);
      },
    );
    try {
      await runtime.teammates.spawn({
        name: "alice",
        role: "writer",
        prompt: "draft",
        sender: "lead",
      });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      const request = await runtime.protocol.requestShutdown("alice");
      const failure = await runtime.teammates.waitForEvents(1);
      expect(runtime.teammates.state("alice").status).toBe(TeammateStatus.Failed);
      expect(failure[0]?.toPayload().content).toContain("failed");
      await runtime.teammates.acknowledgeEvents(failure);
      const recovered = await runtime.mailbox.claim("alice");
      expect(recovered).toMatchObject({
        kind: ProtocolMessageKind.ShutdownRequest,
        requestId: request.id,
      });
      if (recovered === undefined) throw new Error("Shutdown request was not released");
      await runtime.mailbox.release(recovered);
      expect((await runtime.protocol.store.getRequest(request.id)).status).toBe("pending");
      expect(model.requests).toHaveLength(1);
    } finally {
      await runtime.teammates.close();
      await runtime.cron.close();
      await runtime.supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
