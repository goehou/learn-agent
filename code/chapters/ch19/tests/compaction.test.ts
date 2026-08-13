import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  ArtifactConflictError,
  ArtifactPathError,
  COMPACTED_TOOL_RESULT,
  CompactionError,
  CompactionManager,
  CompactionSummary,
  ModelHistorySummarizer,
  PromptTooLongRetryError,
  historyUtf8Bytes,
  microCompactHistory,
  snipCompactHistory,
} from "../src/features/compaction.js";
import type { HistorySummarizer } from "../src/features/compaction.js";
import {
  assistantMessage,
  systemMessage,
  toolCall,
  toolMessage,
  userMessage,
} from "../src/core/messages.js";
import type { ChatMessage } from "../src/core/messages.js";
import { toolError, toolSuccess } from "../src/core/tools.js";
import { ScriptedModelClient } from "./fakes.js";

function summary(goal = "继续迁移第 8 章"): CompactionSummary {
  return new CompactionSummary({
    currentGoal: goal,
    keyFindings: ["按消息组压缩"],
    filesReadOrChanged: ["src/features/compaction.ts"],
    remainingWork: ["运行测试"],
    userConstraints: ["不得拆散工具配对"],
  });
}

class RecordingSummarizer implements HistorySummarizer {
  readonly histories: (readonly ChatMessage[])[] = [];
  readonly #summary: CompactionSummary;
  readonly #error: Error | undefined;

  constructor(value: CompactionSummary = summary(), error?: Error) {
    this.#summary = value;
    this.#error = error;
  }

  async summarize(history: readonly ChatMessage[]): Promise<CompactionSummary> {
    this.histories.push(history);
    if (this.#error !== undefined) {
      throw this.#error;
    }
    return this.#summary;
  }
}

function idGenerator(...values: string[]): () => string {
  const pending = [...values];
  return () => {
    const value = pending.shift();
    if (value === undefined) {
      throw new Error("test id generator exhausted");
    }
    return value;
  };
}

function exchange(id: string, result: string): readonly ChatMessage[] {
  return [
    assistantMessage(null, [toolCall(id, "read_file", `{"path":"${id}.txt"}`)]),
    toolMessage(result, id),
  ];
}

async function temporaryWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-tutorial-compaction-"));
}

async function createDirectoryLink(link: string, target: string): Promise<boolean> {
  try {
    await symlink(target, link, "junction");
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    if (code === "EACCES" || code === "ENOSYS" || code === "ENOTSUP" || code === "EPERM") {
      return false;
    }
    throw error;
  }
}

describe("model-backed history summarizer", () => {
  test("sends a tool-free request and accepts only the five-field JSON contract", async () => {
    const model = new ScriptedModelClient([
      {
        message: assistantMessage(
          JSON.stringify({
            current_goal: "finish",
            key_findings: ["finding"],
            files_read_or_changed: ["file.ts"],
            remaining_work: ["test"],
            user_constraints: ["simple"],
          }),
        ),
        finishReason: "stop",
      },
    ]);
    const summarizer = new ModelHistorySummarizer(model);

    const result = await summarizer.summarize([userMessage("long history")]);

    expect(result).toEqual(
      new CompactionSummary({
        currentGoal: "finish",
        keyFindings: ["finding"],
        filesReadOrChanged: ["file.ts"],
        remainingWork: ["test"],
        userConstraints: ["simple"],
      }),
    );
    expect(model.requests[0]?.tools).toEqual([]);
    expect(model.requests[0]?.messages[0]?.role).toBe("system");
    expect(model.requests[0]?.messages[0]?.content).toContain("current_goal");
    expect(model.requests[0]?.messages[1]).toEqual(userMessage("long history"));
  });

  test.each([
    {
      label: "tool calls",
      message: assistantMessage(null, [toolCall("call-1", "read_file", "{}")]),
      finishReason: "tool_calls" as const,
      expected: /must not call tools/,
    },
    {
      label: "a non-stop finish reason",
      message: assistantMessage("{}"),
      finishReason: "length" as const,
      expected: /finishReason must be stop/,
    },
    {
      label: "an extra field",
      message: assistantMessage(
        JSON.stringify({
          current_goal: "finish",
          key_findings: [],
          files_read_or_changed: [],
          remaining_work: [],
          user_constraints: [],
          extra: true,
        }),
      ),
      finishReason: "stop" as const,
      expected: /exact fields/,
    },
    {
      label: "an empty array item",
      message: assistantMessage(
        JSON.stringify({
          current_goal: "finish",
          key_findings: [" "],
          files_read_or_changed: [],
          remaining_work: [],
          user_constraints: [],
        }),
      ),
      finishReason: "stop" as const,
      expected: /invalid values/,
    },
  ])("rejects $label", async ({ message, finishReason, expected }) => {
    const summarizer = new ModelHistorySummarizer(
      new ScriptedModelClient([{ message, finishReason }]),
    );

    await expect(summarizer.summarize([userMessage("history")])).rejects.toThrow(expected);
  });
});

describe("tool-result artifact budgeting", () => {
  test("persists values above the strict UTF-8 threshold and keeps bounded previews", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const manager = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        idGenerator: idGenerator("large"),
        persistThresholdBytes: 8,
        batchBudgetBytes: 100,
        previewHeadBytes: 4,
        previewTailBytes: 4,
      });

      const outcome = await manager.compactToolResults([toolSuccess("甲甲甲")]);

      expect(outcome.artifacts).toHaveLength(1);
      expect(outcome.artifacts[0]?.resultIndex).toBe(0);
      expect(outcome.artifacts[0]?.reference.relativePath).toBe(
        ".agent_tutorial/artifacts/tool-result-large.txt",
      );
      expect(outcome.artifacts[0]?.reference.originalBytes).toBe(9);
      const artifactPath = outcome.artifacts[0]?.reference.path;
      if (artifactPath === undefined) {
        throw new Error("persisted result did not include its artifact path");
      }
      expect(await readFile(artifactPath, "utf8")).toBe("甲甲甲");
      expect(outcome.results[0]?.content).toContain("head_preview:\n甲\ntail_preview:\n甲");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("keeps a value exactly at the threshold inline", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const manager = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        persistThresholdBytes: 6,
        batchBudgetBytes: 100,
      });

      const outcome = await manager.compactToolResults([toolSuccess("abcdef")]);

      expect(outcome.results).toEqual([toolSuccess("abcdef")]);
      expect(outcome.artifacts).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("persists the largest remaining value first and preserves error metadata", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const manager = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        idGenerator: idGenerator("largest"),
        persistThresholdBytes: 100,
        batchBudgetBytes: 9,
      });
      const original = [
        toolError("read_failed", "123456"),
        toolSuccess("12345"),
        toolSuccess("1234"),
      ];

      const outcome = await manager.compactToolResults(original);

      expect(outcome.artifacts.map((artifact) => artifact.resultIndex)).toEqual([0]);
      expect(outcome.results[0]).toMatchObject({ isError: true, errorCode: "read_failed" });
      expect(outcome.results.slice(1)).toEqual(original.slice(1));
      expect(original[0]?.content).toBe("Error [read_failed]: 123456");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("never overwrites an existing artifact and removes earlier files from the failed batch", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const directory = join(workspace, ".agent_tutorial", "artifacts");
      await mkdir(directory, { recursive: true });
      const conflict = join(directory, "tool-result-conflict.txt");
      await writeFile(conflict, "existing", "utf8");
      const manager = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        idGenerator: idGenerator("created", "conflict"),
        persistThresholdBytes: 1,
        batchBudgetBytes: 100,
      });

      await expect(
        manager.compactToolResults([toolSuccess("first"), toolSuccess("other")]),
      ).rejects.toThrow(ArtifactConflictError);

      await expect(readFile(join(directory, "tool-result-created.txt"), "utf8")).rejects.toThrow();
      expect(await readFile(conflict, "utf8")).toBe("existing");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects unsafe IDs and artifact directory setup failures without changing input", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const original = toolSuccess("unchanged");
      const unsafe = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        idGenerator: idGenerator("../escape"),
        persistThresholdBytes: 1,
        batchBudgetBytes: 100,
      });
      await expect(unsafe.compactToolResults([original])).rejects.toThrow(ArtifactPathError);
      expect(original).toEqual(toolSuccess("unchanged"));

      await writeFile(join(workspace, ".agent_tutorial"), "not a directory", "utf8");
      const unwritable = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        idGenerator: idGenerator("valid"),
        persistThresholdBytes: 1,
        batchBudgetBytes: 100,
      });
      await expect(unwritable.compactToolResults([original])).rejects.toThrow(ArtifactPathError);
      expect(original).toEqual(toolSuccess("unchanged"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects a state-directory junction that escapes the workspace", async () => {
    const workspace = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    try {
      const linked = await createDirectoryLink(join(workspace, ".agent_tutorial"), outside);
      if (!linked) {
        return;
      }
      const manager = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        idGenerator: idGenerator("escape"),
        persistThresholdBytes: 1,
        batchBudgetBytes: 100,
      });

      await expect(manager.compactToolResults([toolSuccess("must not escape")])).rejects.toThrow(
        ArtifactPathError,
      );
      await expect(readFile(join(outside, "tool-result-escape.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("atomic message-group compaction", () => {
  test("micro compaction replaces every old result but keeps recent exchanges intact", () => {
    const history = [
      userMessage("start"),
      ...exchange("old-1", "old result 1"),
      ...exchange("old-2", "old result 2"),
      ...exchange("new", "new result"),
    ];

    const compacted = microCompactHistory(history, { keepRecentToolGroups: 1 });

    expect(compacted[2]).toEqual(toolMessage(COMPACTED_TOOL_RESULT, "old-1"));
    expect(compacted[4]).toEqual(toolMessage(COMPACTED_TOOL_RESULT, "old-2"));
    expect(compacted[6]).toEqual(toolMessage("new result", "new"));
  });

  test("snip compaction removes whole groups and inserts an exact omission marker", () => {
    const history = [
      userMessage("head"),
      systemMessage("middle-1"),
      ...exchange("middle-tool", "paired"),
      userMessage("middle-2"),
      ...exchange("tail-tool", "tail result"),
      assistantMessage("tail"),
    ];

    const compacted = snipCompactHistory(history, { maxGroups: 4, keepHeadGroups: 1 });

    expect(compacted).toEqual([
      userMessage("head"),
      systemMessage("[Compacted: 3 message groups omitted]"),
      ...exchange("tail-tool", "tail result"),
      assistantMessage("tail"),
    ]);
  });

  test("counts canonical OpenAI JSONL bytes including non-ASCII UTF-8 and the final newline", () => {
    const history = [userMessage("甲"), ...exchange("call-1", "乙")];
    const expected = `${JSON.stringify({ content: "甲", role: "user" })}\n${JSON.stringify({
      content: null,
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: '{"path":"call-1.txt"}', name: "read_file" },
          id: "call-1",
          type: "function",
        },
      ],
    })}\n${JSON.stringify({ content: "乙", role: "tool", tool_call_id: "call-1" })}\n`;

    expect(historyUtf8Bytes(history)).toBe(Buffer.byteLength(expected, "utf8"));
  });
});

describe("final history compaction", () => {
  test("persists the full transcript before replacing history with one structured summary", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const summarizer = new RecordingSummarizer();
      const history = [userMessage("start"), ...exchange("call-1", "full result")];
      const manager = new CompactionManager({
        workspace,
        summarizer,
        idGenerator: idGenerator("transcript"),
      });

      const outcome = await manager.compactProactively(history);

      expect(summarizer.histories).toEqual([history]);
      expect(outcome.history).toHaveLength(1);
      const compacted = outcome.history[0];
      expect(compacted?.role).toBe("system");
      if (compacted?.role !== "system") {
        throw new Error("expected structured system summary");
      }
      expect(JSON.parse(compacted.content)).toEqual({
        current_goal: "继续迁移第 8 章",
        files_read_or_changed: ["src/features/compaction.ts"],
        key_findings: ["按消息组压缩"],
        kind: "compacted_history",
        remaining_work: ["运行测试"],
        transcript_path: ".agent_tutorial/artifacts/transcript-transcript.jsonl",
        user_constraints: ["不得拆散工具配对"],
      });
      const transcript = await readFile(outcome.transcript.path, "utf8");
      expect(transcript).toContain('"tool_call_id":"call-1"');
      expect(transcript.endsWith("\n")).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("keeps the transcript when summarization fails", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const manager = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(summary(), new CompactionError("summary failed")),
        idGenerator: idGenerator("failed-summary"),
      });

      await expect(manager.compactProactively([userMessage("unchanged")])).rejects.toThrow(
        /summary failed/,
      );

      expect(
        await readFile(
          join(workspace, ".agent_tutorial", "artifacts", "transcript-failed-summary.jsonl"),
          "utf8",
        ),
      ).toContain("unchanged");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("reactive compaction runs once per retry window and retains recent complete groups", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const manager = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        idGenerator: idGenerator("reactive"),
        reactiveTailGroups: 2,
      });
      const history = [userMessage("old"), systemMessage("middle"), ...exchange("recent", "data")];

      const outcome = await manager.compactOnPromptTooLong(history, { retryCount: 0 });

      expect(outcome.history.slice(1)).toEqual([
        systemMessage("middle"),
        ...exchange("recent", "data"),
      ]);
      await expect(manager.compactOnPromptTooLong(history, { retryCount: 1 })).rejects.toThrow(
        PromptTooLongRetryError,
      );

      const newWindow = new CompactionManager({
        workspace,
        summarizer: new RecordingSummarizer(),
        idGenerator: idGenerator("new-window"),
        reactiveTailGroups: 2,
      });
      const repeated = await newWindow.compactOnPromptTooLong(history, { retryCount: 0 });
      expect(repeated.transcript.relativePath).toContain("new-window");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("prepare caches semantic equality, reuses a compressed prefix, and leaves canonical input intact", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const summarizer = new RecordingSummarizer();
      const manager = new CompactionManager({
        workspace,
        summarizer,
        keepRecentToolGroups: 0,
        proactiveThresholdBytes: 100_000,
      });
      const first = [userMessage("start"), ...exchange("old", "large old result")];

      const prepared = await manager.prepare(first);
      const equalPrepared = await manager.prepare([
        userMessage("start"),
        ...exchange("old", "large old result"),
      ]);
      const appended = await manager.prepare([...first, userMessage("next")]);

      expect(equalPrepared).toBe(prepared);
      expect(prepared[2]).toEqual(toolMessage(COMPACTED_TOOL_RESULT, "old"));
      expect(appended).toEqual([...prepared, userMessage("next")]);
      expect(first[2]).toEqual(toolMessage("large old result", "old"));
      expect(summarizer.histories).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("prepare summarizes once, caches equal history, and appends to the compressed prefix", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const summarizer = new RecordingSummarizer();
      const manager = new CompactionManager({
        workspace,
        summarizer,
        idGenerator: idGenerator("prepared"),
        proactiveThresholdBytes: 800,
      });
      const canonical = [userMessage("x".repeat(1_000))];

      const first = await manager.prepare(canonical);
      const cached = await manager.prepare([userMessage("x".repeat(1_000))]);
      const appendedMessage = assistantMessage("latest answer");
      const appended = await manager.prepare([...canonical, appendedMessage]);

      expect(cached).toBe(first);
      expect(summarizer.histories).toEqual([canonical]);
      expect(appended).toEqual([...first, appendedMessage]);
      const transcript = await readFile(
        join(workspace, ".agent_tutorial", "artifacts", "transcript-prepared.jsonl"),
        "utf8",
      );
      expect(
        transcript
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ).toEqual([{ content: "x".repeat(1_000), role: "user" }]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("recompaction summarizes the cached prefix but transcribes the full canonical history", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const summarizer = new RecordingSummarizer();
      const manager = new CompactionManager({
        workspace,
        summarizer,
        idGenerator: idGenerator("first-window", "second-window"),
        proactiveThresholdBytes: 800,
      });
      const firstCanonical = [userMessage("x".repeat(1_000))];
      const firstPrepared = await manager.prepare(firstCanonical);
      const appended = assistantMessage("y".repeat(1_000));
      const canonical = [...firstCanonical, appended];

      await manager.prepare(canonical);

      expect(summarizer.histories).toEqual([firstCanonical, [...firstPrepared, appended]]);
      const transcript = await readFile(
        join(workspace, ".agent_tutorial", "artifacts", "transcript-second-window.jsonl"),
        "utf8",
      );
      expect(
        transcript
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { content: "x".repeat(1_000), role: "user" },
        { content: "y".repeat(1_000), role: "assistant" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("a transcript collision never overwrites or invokes the summarizer again", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const summarizer = new RecordingSummarizer();
      const manager = new CompactionManager({
        workspace,
        summarizer,
        idGenerator: idGenerator("same", "same"),
      });
      const first = await manager.compactProactively([userMessage("first")]);
      const before = await readFile(first.transcript.path, "utf8");

      await expect(manager.compactProactively([userMessage("second")])).rejects.toThrow(
        ArtifactConflictError,
      );

      expect(await readFile(first.transcript.path, "utf8")).toBe(before);
      expect(summarizer.histories).toEqual([[userMessage("first")]]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("a transcript directory failure leaves history unchanged and skips summarization", async () => {
    const workspace = await temporaryWorkspace();
    try {
      await writeFile(join(workspace, ".agent_tutorial"), "not a directory", "utf8");
      const summarizer = new RecordingSummarizer();
      const manager = new CompactionManager({
        workspace,
        summarizer,
        idGenerator: idGenerator("unused"),
      });
      const history = [userMessage("unchanged")];

      await expect(manager.compactProactively(history)).rejects.toThrow(ArtifactPathError);

      expect(history).toEqual([userMessage("unchanged")]);
      expect(summarizer.histories).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("validates pairing before any transcript write or summary call", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const summarizer = new RecordingSummarizer();
      const manager = new CompactionManager({ workspace, summarizer });

      await expect(manager.compactProactively([toolMessage("orphan", "missing")])).rejects.toThrow(
        /orphan tool result/,
      );

      expect(summarizer.histories).toEqual([]);
      await expect(readFile(join(workspace, ".agent_tutorial"), "utf8")).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
