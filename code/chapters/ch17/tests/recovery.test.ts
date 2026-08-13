import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { assistantMessage, systemMessage, toolCall, userMessage } from "../src/core/messages.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../src/core/model.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import {
  CompactionManager,
  CompactionSummary,
  PromptTooLongRetryError,
} from "../src/features/compaction.js";
import {
  CONTINUATION_PROMPT,
  CancellationToken,
  InvalidRetryAfterError,
  RecoveryCancelledError,
  RecoveryConfig,
  RecoveryDeadlineExceeded,
  RecoveryManager,
  RecoveryRetriesExhausted,
} from "../src/features/recovery.js";

class ActionModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #actions: (ModelReply | Error)[];

  constructor(actions: readonly (ModelReply | Error)[]) {
    this.#actions = [...actions];
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const action = this.#actions.shift();
    if (action === undefined) {
      throw new Error("Unexpected model call");
    }
    if (action instanceof Error) {
      throw action;
    }
    return action;
  }
}

class AbortAwareModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly started: Promise<void>;
  #resolveStarted: (() => void) | undefined;
  #signal: AbortSignal | undefined;
  settled = false;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  get signal(): AbortSignal {
    if (this.#signal === undefined) {
      throw new Error("model has not started");
    }
    return this.#signal;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
    this.requests.push(request);
    this.#resolveStarted?.();
    if (signal === undefined) {
      throw new Error("recovery model call must receive an AbortSignal");
    }
    this.#signal = signal;
    return new Promise<ModelReply>((_resolve, reject) => {
      const rejectAfterSettlement = () => {
        queueMicrotask(() => {
          this.settled = true;
          reject(new Error("model operation aborted"));
        });
      };
      if (signal.aborted) {
        rejectAfterSettlement();
        return;
      }
      signal.addEventListener("abort", rejectAfterSettlement, { once: true });
    });
  }
}

class FakeClock {
  value = 100;

  now = (): number => this.value;

  advance(seconds: number): void {
    this.value += seconds;
  }
}

const recoveryWorkspaces = new WeakMap<RecoveryManager, string>();

function request(): ModelRequest {
  return Object.freeze({
    messages: Object.freeze([systemMessage("system"), userMessage("work")]),
    tools: Object.freeze([]),
  });
}

async function manager(
  model: ModelClient,
  overrides: Partial<ConstructorParameters<typeof RecoveryManager>[0]> = {},
): Promise<RecoveryManager> {
  const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch11-"));
  const compaction = new CompactionManager({
    workspace,
    summarizer: {
      async summarize() {
        return new CompactionSummary({
          currentGoal: "recover request",
          keyFindings: ["input too long"],
          filesReadOrChanged: [],
          remainingWork: ["retry"],
          userConstraints: [],
        });
      },
    },
    idGenerator: () => "recovery-transcript",
  });
  const recovery = new RecoveryManager({
    model,
    compaction,
    config: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
    jitter: () => 0,
    ...overrides,
  });
  recoveryWorkspaces.set(recovery, workspace);
  return recovery;
}

async function dispose(manager: RecoveryManager): Promise<void> {
  const workspace = recoveryWorkspaces.get(manager);
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("RecoveryManager", () => {
  test("rejects invalid recovery budgets and semantically mismatched typed model errors", () => {
    expect(
      () =>
        new RecoveryConfig({
          primaryModel: "primary",
          fallbackModel: "fallback",
          escalatedMaxTokens: 64_000,
          modelMaxTokens: 32_000,
        }),
    ).toThrow(/modelMaxTokens/);
    expect(() => new ModelRateLimitError("rate", { statusCode: 500 })).toThrow(/429/);
    expect(() => new ModelOverloadedError("overloaded", { statusCode: 429 })).toThrow(/529/);
    expect(() => new ModelPromptTooLongError("too long", { statusCode: 413 })).toThrow(/400/);
  });

  test("discards the first length reply and retries with the escalated budget", async () => {
    const model = new ActionModel([
      { message: assistantMessage("incomplete"), finishReason: "length" },
      { message: assistantMessage("complete"), finishReason: "stop" },
    ]);
    const recovery = await manager(model);
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).resolves.toEqual({
        message: assistantMessage("complete"),
        finishReason: "stop",
      });
      expect(model.requests.map((item) => item.maxTokens)).toEqual([8_000, 64_000]);
      expect(model.requests.map((item) => item.model)).toEqual(["primary", "primary"]);
    } finally {
      await dispose(recovery);
    }
  });

  test("continues only in the request snapshot and returns one merged reply", async () => {
    const model = new ActionModel([
      { message: assistantMessage("discarded"), finishReason: "length" },
      { message: assistantMessage("first half "), finishReason: "length" },
      { message: assistantMessage("second half"), finishReason: "stop" },
    ]);
    const recovery = await manager(model);
    const original = request();
    try {
      recovery.beginTurn();

      await expect(recovery.complete(original)).resolves.toEqual({
        message: assistantMessage("first half second half"),
        finishReason: "stop",
      });
      expect(model.requests[2]?.messages.slice(-2)).toEqual([
        assistantMessage("first half "),
        userMessage(CONTINUATION_PROMPT),
      ]);
      expect(original.messages).toEqual([systemMessage("system"), userMessage("work")]);
    } finally {
      await dispose(recovery);
    }
  });

  test("honors Retry-After and rejects invalid Retry-After", async () => {
    const clock = new FakeClock();
    const delays: number[] = [];
    const model = new ActionModel([
      new ModelRateLimitError("rate limited", { retryAfter: "3.25" }),
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const recovery = await manager(model, {
      monotonic: clock.now,
      sleeper: async (delay) => {
        delays.push(delay);
        clock.advance(delay);
      },
    });
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).resolves.toEqual({
        message: assistantMessage("done"),
        finishReason: "stop",
      });
      expect(delays).toEqual([3.25]);
      expect(model.requests.map((item) => item.model)).toEqual(["primary", "primary"]);
    } finally {
      await dispose(recovery);
    }

    const invalid = new ActionModel([
      new ModelRateLimitError("rate limited", { retryAfter: "NaN" }),
    ]);
    const invalidRecovery = await manager(invalid);
    try {
      invalidRecovery.beginTurn();
      await expect(invalidRecovery.complete(request())).rejects.toBeInstanceOf(
        InvalidRetryAfterError,
      );
      expect(invalid.requests).toHaveLength(1);
    } finally {
      await dispose(invalidRecovery);
    }
  });

  test("uses the injected UTC clock for an HTTP-date Retry-After", async () => {
    const clock = new FakeClock();
    const delays: number[] = [];
    const utcNow = new Date("2026-07-30T00:00:00.000Z");
    const model = new ActionModel([
      new ModelRateLimitError("rate limited", {
        retryAfter: new Date(utcNow.getTime() + 5_000).toUTCString(),
      }),
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const recovery = await manager(model, {
      monotonic: clock.now,
      utcNow: () => utcNow,
      sleeper: async (delay) => {
        delays.push(delay);
        clock.advance(delay);
      },
    });
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).resolves.toEqual({
        message: assistantMessage("done"),
        finishReason: "stop",
      });
      expect(delays).toEqual([5]);
    } finally {
      await dispose(recovery);
    }
  });

  test.each(["", "-1", "NaN", "Infinity"])(
    "rejects invalid Retry-After %j without sleeping or retrying",
    async (retryAfter) => {
      const clock = new FakeClock();
      const delays: number[] = [];
      const model = new ActionModel([new ModelRateLimitError("rate limited", { retryAfter })]);
      const recovery = await manager(model, {
        monotonic: clock.now,
        sleeper: async (delay) => {
          delays.push(delay);
          clock.advance(delay);
        },
      });
      try {
        recovery.beginTurn();

        await expect(recovery.complete(request())).rejects.toBeInstanceOf(InvalidRetryAfterError);
        expect(delays).toEqual([]);
        expect(model.requests).toHaveLength(1);
      } finally {
        await dispose(recovery);
      }
    },
  );

  test("switches to the fallback model after three consecutive overloads", async () => {
    const clock = new FakeClock();
    const delays: number[] = [];
    const model = new ActionModel([
      new ModelOverloadedError("overloaded"),
      new ModelOverloadedError("overloaded"),
      new ModelOverloadedError("overloaded"),
      { message: assistantMessage("fallback result"), finishReason: "stop" },
    ]);
    const recovery = await manager(model, {
      monotonic: clock.now,
      sleeper: async (delay) => {
        delays.push(delay);
        clock.advance(delay);
      },
    });
    try {
      recovery.beginTurn();
      await expect(recovery.complete(request())).resolves.toEqual({
        message: assistantMessage("fallback result"),
        finishReason: "stop",
      });
      expect(delays).toEqual([0.5, 1, 2]);
      expect(model.requests.map((item) => item.model)).toEqual([
        "primary",
        "primary",
        "primary",
        "fallback",
      ]);
    } finally {
      await dispose(recovery);
    }
  });

  test("compacts a prompt-too-long request once and keeps the leading system prompt", async () => {
    const model = new ActionModel([
      new ModelPromptTooLongError("too long"),
      new ModelPromptTooLongError("still too long"),
    ]);
    const recovery = await manager(model);
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).rejects.toBeInstanceOf(PromptTooLongRetryError);
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]?.messages[0]).toEqual(systemMessage("system"));
      expect(model.requests[1]?.messages[1]?.content).toContain("compacted_history");
    } finally {
      await dispose(recovery);
    }
  });

  test("does not sleep past the total deadline", async () => {
    const clock = new FakeClock();
    const model = new ActionModel([new ModelRateLimitError("rate limited", { retryAfter: "2" })]);
    const recovery = await manager(model, {
      config: new RecoveryConfig({
        primaryModel: "primary",
        fallbackModel: "fallback",
        totalTimeoutSeconds: 1,
      }),
      monotonic: clock.now,
      sleeper: async () => {
        throw new Error("must not sleep");
      },
    });
    try {
      recovery.beginTurn();
      await expect(recovery.complete(request())).rejects.toBeInstanceOf(RecoveryDeadlineExceeded);
    } finally {
      await dispose(recovery);
    }
  });

  test("rejects a pre-cancelled turn before the first model call", async () => {
    const cancellation = new CancellationToken();
    cancellation.cancel();
    const model = new ActionModel([]);
    const recovery = await manager(model, { cancellation });
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).rejects.toBeInstanceOf(RecoveryCancelledError);
      expect(model.requests).toEqual([]);
    } finally {
      await dispose(recovery);
    }
  });

  test("does not retry unknown model failures", async () => {
    const defect = new Error("programming defect");
    const model = new ActionModel([defect]);
    const recovery = await manager(model);
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).rejects.toBe(defect);
      expect(model.requests).toHaveLength(1);
    } finally {
      await dispose(recovery);
    }
  });

  test("unsubscribes cancellation observers after each successful request", async () => {
    const cancellation = new CancellationToken();
    const unsubscribe = vi.fn();
    const subscribe = vi.spyOn(cancellation, "subscribe").mockReturnValue(unsubscribe);
    const model = new ActionModel([
      { message: assistantMessage("one"), finishReason: "stop" },
      { message: assistantMessage("two"), finishReason: "stop" },
    ]);
    const recovery = await manager(model, { cancellation });
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).resolves.toMatchObject({ finishReason: "stop" });
      await expect(recovery.complete(request())).resolves.toMatchObject({ finishReason: "stop" });
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(unsubscribe).toHaveBeenCalledTimes(2);
    } finally {
      await dispose(recovery);
    }
  });

  test("does not wrap or retry an AbortError raised by the model boundary", async () => {
    const abortError = new DOMException("request aborted", "AbortError");
    const model = new ActionModel([abortError]);
    const recovery = await manager(model);
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).rejects.toBe(abortError);
      expect(model.requests).toHaveLength(1);
    } finally {
      await dispose(recovery);
    }
  });

  test("aborts and settles an in-flight model call on cancellation and deadline", async () => {
    const cancellation = new CancellationToken();
    const cancelledModel = new AbortAwareModel();
    const cancelledRecovery = await manager(cancelledModel, { cancellation });
    try {
      cancelledRecovery.beginTurn();
      const completion = cancelledRecovery.complete(request());
      await cancelledModel.started;
      cancellation.cancel();

      await expect(completion).rejects.toBeInstanceOf(RecoveryCancelledError);
      expect(cancelledModel.signal.aborted).toBe(true);
      expect(cancelledModel.settled).toBe(true);
      expect(cancelledModel.requests).toHaveLength(1);
    } finally {
      await dispose(cancelledRecovery);
    }

    const requestAbortModel = new AbortAwareModel();
    const requestAbortRecovery = await manager(requestAbortModel);
    const requestController = new AbortController();
    try {
      requestAbortRecovery.beginTurn();
      const completion = requestAbortRecovery.complete(request(), requestController.signal);
      await requestAbortModel.started;
      requestController.abort();

      await expect(completion).rejects.toBeInstanceOf(RecoveryCancelledError);
      expect(requestAbortModel.signal.aborted).toBe(true);
      expect(requestAbortModel.settled).toBe(true);
      expect(requestAbortModel.requests).toHaveLength(1);
    } finally {
      await dispose(requestAbortRecovery);
    }

    const deadlineModel = new AbortAwareModel();
    const deadlineRecovery = await manager(deadlineModel, {
      config: new RecoveryConfig({
        primaryModel: "primary",
        fallbackModel: "fallback",
        totalTimeoutSeconds: 0.05,
      }),
    });
    try {
      deadlineRecovery.beginTurn();
      const completion = deadlineRecovery.complete(request());
      await deadlineModel.started;

      await expect(completion).rejects.toBeInstanceOf(RecoveryDeadlineExceeded);
      expect(deadlineModel.signal.aborted).toBe(true);
      expect(deadlineModel.settled).toBe(true);
      expect(deadlineModel.requests).toHaveLength(1);
    } finally {
      await dispose(deadlineRecovery);
    }
  });

  test("keeps transient attempts across prompt compaction", async () => {
    const clock = new FakeClock();
    const model = new ActionModel([
      new ModelOverloadedError("overloaded"),
      new ModelPromptTooLongError("too long"),
      new ModelOverloadedError("overloaded again"),
      { message: assistantMessage("must not run"), finishReason: "stop" },
    ]);
    const recovery = await manager(model, {
      config: new RecoveryConfig({
        primaryModel: "primary",
        fallbackModel: "fallback",
        maxTransientAttempts: 2,
      }),
      monotonic: clock.now,
      sleeper: async (delay) => {
        clock.advance(delay);
      },
    });
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).rejects.toBeInstanceOf(RecoveryRetriesExhausted);
      expect(model.requests).toHaveLength(3);
    } finally {
      await dispose(recovery);
    }
  });

  test.each([
    { message: assistantMessage(""), finishReason: "length" as const },
    {
      message: assistantMessage(null, [toolCall("call-truncated", "read_file", "{}")]),
      finishReason: "length" as const,
    },
  ])("rejects non-text continuation fragments", async (invalidReply) => {
    const model = new ActionModel([
      { message: assistantMessage("discarded"), finishReason: "length" },
      invalidReply,
    ]);
    const recovery = await manager(model);
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).rejects.toBeInstanceOf(RecoveryRetriesExhausted);
      expect(model.requests).toHaveLength(2);
    } finally {
      await dispose(recovery);
    }
  });

  test("preserves final tool calls after merging continuation fragments", async () => {
    const call = toolCall("call-final", "read_file", '{"path":"README.md"}');
    const model = new ActionModel([
      { message: assistantMessage("discarded"), finishReason: "length" },
      { message: assistantMessage("part"), finishReason: "length" },
      { message: assistantMessage("tail", [call]), finishReason: "tool_calls" },
    ]);
    const recovery = await manager(model);
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).resolves.toEqual({
        message: assistantMessage("parttail", [call]),
        finishReason: "tool_calls",
      });
    } finally {
      await dispose(recovery);
    }
  });

  test("raises a typed failure once continuation attempts are exhausted", async () => {
    const model = new ActionModel([
      { message: assistantMessage("discarded"), finishReason: "length" },
      { message: assistantMessage("part one"), finishReason: "length" },
      { message: assistantMessage("part two"), finishReason: "length" },
    ]);
    const recovery = await manager(model, {
      config: new RecoveryConfig({
        primaryModel: "primary",
        fallbackModel: "fallback",
        maxContinuations: 1,
      }),
    });
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).rejects.toBeInstanceOf(RecoveryRetriesExhausted);
      expect(model.requests).toHaveLength(3);
    } finally {
      await dispose(recovery);
    }
  });

  test.each([
    { ...request(), model: "other" },
    { ...request(), maxTokens: 4_000 },
  ])("rejects model request overrides before calling the model", async (overriddenRequest) => {
    const model = new ActionModel([]);
    const recovery = await manager(model);
    try {
      recovery.beginTurn();

      await expect(recovery.complete(overriddenRequest)).rejects.toThrow(
        /RecoveryConfig|initialMaxTokens/,
      );
      expect(model.requests).toEqual([]);
    } finally {
      await dispose(recovery);
    }
  });

  test("cancels a reactive compaction operation without retrying the model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch11-cancel-"));
    const cancellation = new CancellationToken();
    const model = new ActionModel([new ModelPromptTooLongError("too long")]);
    const compaction = new CompactionManager({
      workspace,
      summarizer: {
        async summarize(_history, signal) {
          cancellation.cancel();
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
          expect(signal?.aborted).toBe(true);
          return new CompactionSummary({
            currentGoal: "recover request",
            keyFindings: ["cancelled"],
            filesReadOrChanged: [],
            remainingWork: [],
            userConstraints: [],
          });
        },
      },
    });
    const recovery = new RecoveryManager({
      model,
      compaction,
      config: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
      cancellation,
    });
    try {
      recovery.beginTurn();
      await expect(recovery.complete(request())).rejects.toBeInstanceOf(RecoveryCancelledError);
      expect(model.requests).toHaveLength(1);
      expect(await readdir(join(workspace, ".agent_tutorial", "artifacts"))).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rolls back a reactive transcript when its summarizer fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch11-summary-failure-"));
    const summaryFailure = new Error("summary failed");
    const model = new ActionModel([new ModelPromptTooLongError("too long")]);
    const compaction = new CompactionManager({
      workspace,
      summarizer: {
        async summarize() {
          throw summaryFailure;
        },
      },
    });
    const recovery = new RecoveryManager({
      model,
      compaction,
      config: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
    });
    try {
      recovery.beginTurn();

      await expect(recovery.complete(request())).rejects.toBe(summaryFailure);
      expect(model.requests).toHaveLength(1);
      expect(await readdir(join(workspace, ".agent_tutorial", "artifacts"))).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
