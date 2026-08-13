import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { NodeWorkspaceFileSystem } from "../src/adapters/filesystem.js";
import { buildAgent } from "../src/bootstrap.js";
import {
  FileNotFoundError,
  FileSystemOperationError,
  InvalidFilePathError,
} from "../src/core/filesystem.js";
import type { WorkspaceFileSystem } from "../src/core/filesystem.js";
import { assistantMessage, toolCall, validateToolPairing } from "../src/core/messages.js";
import type { ModelReply } from "../src/core/model.js";
import { P02 } from "../src/core/profiles.js";
import type { ToolContext } from "../src/core/tools.js";
import { createChapterTwoTools } from "../src/features/builtin-tools.js";
import { commandResult, FakeCommandRunner, ScriptedModelClient } from "./fakes.js";

async function createContext(): Promise<{ workspace: string; context: ToolContext }> {
  const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch02-tools-"));
  return {
    workspace,
    context: Object.freeze({ workspace, identity: "tester" }),
  };
}

class FailingWorkspaceFileSystem implements WorkspaceFileSystem {
  readonly #error: Error;

  constructor(error: Error) {
    this.#error = error;
  }

  readFile(): Promise<string> {
    return Promise.reject(this.#error);
  }

  writeFile(): Promise<number> {
    return Promise.reject(this.#error);
  }

  editFile(): Promise<void> {
    return Promise.reject(this.#error);
  }

  globFiles(): Promise<readonly string[]> {
    return Promise.reject(this.#error);
  }
}

describe("chapter 2 file tools", () => {
  test.each([
    [new FileNotFoundError("missing"), "file_not_found"],
    [new InvalidFilePathError("directory"), "invalid_path"],
    [new FileSystemOperationError("failed"), "filesystem_error"],
  ])("maps core filesystem errors without depending on Node error codes", async (error, code) => {
    const registry = createChapterTwoTools(
      new FakeCommandRunner(commandResult("unused")),
      new FailingWorkspaceFileSystem(error),
    );
    const context: ToolContext = Object.freeze({ workspace: process.cwd(), identity: "tester" });

    await expect(
      registry.invoke(
        registry.prepare(toolCall("read", "read_file", '{"path":"note.txt"}')),
        context,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: code });
  });

  test("composition accepts only the fixed P02 profile object", () => {
    expect(() =>
      buildAgent(
        { chapter: 2, capabilities: P02.capabilities },
        {
          model: new ScriptedModelClient([]),
          workspace: process.cwd(),
          commandRunner: new FakeCommandRunner(commandResult("unused")),
        },
      ),
    ).toThrow(/fixed chapter profile/);
  });

  test("P02 exposes five schemas and pairs multiple file calls in order", async () => {
    const { workspace } = await createContext();
    try {
      const replies: ModelReply[] = [
        {
          message: assistantMessage(null, [
            toolCall(
              "write",
              "write_file",
              '{"path":"note.txt","content":"alpha\\nbeta\\nalpha\\n"}',
            ),
            toolCall(
              "edit",
              "edit_file",
              '{"path":"note.txt","old_text":"alpha","new_text":"gamma"}',
            ),
            toolCall("read", "read_file", '{"path":"note.txt"}'),
            toolCall("glob", "glob", '{"pattern":"**/*.txt"}'),
          ]),
          finishReason: "tool_calls",
        },
        { message: assistantMessage("完成。"), finishReason: "stop" },
      ];
      const model = new ScriptedModelClient(replies);
      const runner = buildAgent(P02, {
        model,
        workspace,
        commandRunner: new FakeCommandRunner(commandResult("unused")),
      });

      const result = await runner.run("写入并读取 note.txt");

      expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
      ]);
      expect(result.history.slice(1, 6)).toEqual([
        expect.objectContaining({ role: "assistant" }),
        { role: "tool", toolCallId: "write", content: "Wrote 17 UTF-8 bytes to note.txt" },
        { role: "tool", toolCallId: "edit", content: "Edited note.txt" },
        { role: "tool", toolCallId: "read", content: "gamma\nbeta\nalpha" },
        { role: "tool", toolCallId: "glob", content: "note.txt" },
      ]);
      validateToolPairing(result.history);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("registers the exact five tools and effects with strict schemas", () => {
    const registry = createChapterTwoTools(
      new FakeCommandRunner(commandResult("42\n")),
      new NodeWorkspaceFileSystem(),
    );
    expect(registry.names).toEqual(["shell", "read_file", "write_file", "edit_file", "glob"]);
    expect(registry.openAITools().map((tool) => tool.function.name)).toEqual(registry.names);
    expect([
      registry.prepare(toolCall("shell", "shell", '{"command":"pwd"}')).definition?.effect,
      registry.prepare(toolCall("read", "read_file", '{"path":"a"}')).definition?.effect,
      registry.prepare(toolCall("write", "write_file", '{"path":"a","content":""}')).definition
        ?.effect,
      registry.prepare(toolCall("edit", "edit_file", '{"path":"a","old_text":"x","new_text":""}'))
        .definition?.effect,
      registry.prepare(toolCall("glob", "glob", '{"pattern":"*"}')).definition?.effect,
    ]).toEqual(["execute", "read", "write", "write", "read"]);
    expect(
      registry
        .openAITools()
        .every((tool) => tool.function.parameters.additionalProperties === false),
    ).toBe(true);
  });

  test("describes tool choice and failure semantics in model-facing schemas", () => {
    const registry = createChapterTwoTools(
      new FakeCommandRunner(commandResult("42\n")),
      new NodeWorkspaceFileSystem(),
    );
    const byName = new Map(
      registry.openAITools().map((tool) => [tool.function.name, tool.function]),
    );

    expect(byName.get("shell")?.description).toMatch(/interactive approval/i);
    expect(byName.get("read_file")?.description).toMatch(/workspace-relative/i);
    expect(byName.get("read_file")?.description).toMatch(/limit/i);
    expect(byName.get("edit_file")?.description).toMatch(/first exact occurrence/i);
    expect(byName.get("edit_file")?.description).toMatch(/text_not_found/i);
    expect(byName.get("glob")?.description).toMatch(/alphabetical order/i);

    const readParameters = byName.get("read_file")?.parameters as
      | Readonly<Record<string, unknown>>
      | undefined;
    const properties = readParameters?.properties as Readonly<Record<string, unknown>> | undefined;
    expect(properties?.path).toMatchObject({
      description: expect.stringContaining("Workspace-relative"),
    });
    expect(properties?.limit).toMatchObject({
      description: expect.stringContaining("maximum number of lines"),
    });
  });

  test("runs write, edit, read, and glob through the registry", async () => {
    const { workspace, context } = await createContext();
    try {
      const registry = createChapterTwoTools(
        new FakeCommandRunner(commandResult("42\n")),
        new NodeWorkspaceFileSystem(),
      );
      const writeResult = await registry.invoke(
        registry.prepare(
          toolCall(
            "write-1",
            "write_file",
            '{"path":"nested/note.txt","content":"alpha\\nbeta\\n"}',
          ),
        ),
        context,
      );
      const editResult = await registry.invoke(
        registry.prepare(
          toolCall(
            "edit-1",
            "edit_file",
            '{"path":"nested/note.txt","old_text":"alpha","new_text":"gamma"}',
          ),
        ),
        context,
      );
      const readResult = await registry.invoke(
        registry.prepare(toolCall("read-1", "read_file", '{"path":"nested/note.txt","limit":1}')),
        context,
      );
      const globResult = await registry.invoke(
        registry.prepare(toolCall("glob-1", "glob", '{"pattern":"**/*.txt"}')),
        context,
      );
      expect(writeResult).toMatchObject({
        isError: false,
        content: "Wrote 11 UTF-8 bytes to nested/note.txt",
      });
      expect(editResult).toMatchObject({ isError: false, content: "Edited nested/note.txt" });
      expect(readResult.content).toBe("gamma\n... (1 more lines)");
      expect(globResult.content).toBe("nested/note.txt");
      await expect(readFile(join(workspace, "nested/note.txt"), "utf8")).resolves.toBe(
        "gamma\nbeta\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects extra fields, invalid limits, and path escapes before side effects", async () => {
    const { workspace, context } = await createContext();
    try {
      const registry = createChapterTwoTools(
        new FakeCommandRunner(commandResult("42\n")),
        new NodeWorkspaceFileSystem(),
      );
      const calls = [
        toolCall("extra", "read_file", '{"path":"note.txt","extra":true}'),
        toolCall("zero", "read_file", '{"path":"note.txt","limit":0}'),
        toolCall("boolean", "read_file", '{"path":"note.txt","limit":true}'),
        toolCall("string", "read_file", '{"path":"note.txt","limit":"2"}'),
      ];
      for (const call of calls) {
        await expect(registry.invoke(registry.prepare(call), context)).resolves.toMatchObject({
          isError: true,
          errorCode: "invalid_arguments",
        });
      }
      const outsideName = `${workspace.split(/[\\/]/u).at(-1)}-outside.txt`;
      const escaped = await registry.invoke(
        registry.prepare(
          toolCall(
            "escape",
            "write_file",
            JSON.stringify({ path: `../${outsideName}`, content: "bad" }),
          ),
        ),
        context,
      );
      expect(escaped).toMatchObject({ isError: true, errorCode: "path_escape" });
      await expect(readFile(join(workspace, "..", outsideName), "utf8")).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("maps expected file failures to stable error codes", async () => {
    const { workspace, context } = await createContext();
    try {
      const registry = createChapterTwoTools(
        new FakeCommandRunner(commandResult("42\n")),
        new NodeWorkspaceFileSystem(),
      );
      await writeFile(join(workspace, "invalid.txt"), Uint8Array.from([0xff]));
      await writeFile(join(workspace, "note.txt"), "keep", "utf8");
      const cases = [
        ["missing", "read_file", '{"path":"missing.txt"}', "file_not_found"],
        ["utf8", "read_file", '{"path":"invalid.txt"}', "invalid_utf8"],
        [
          "text",
          "edit_file",
          '{"path":"note.txt","old_text":"missing","new_text":"replacement"}',
          "text_not_found",
        ],
      ] as const;
      for (const [id, name, argumentsJson, errorCode] of cases) {
        await expect(
          registry.invoke(registry.prepare(toolCall(id, name, argumentsJson)), context),
        ).resolves.toMatchObject({ isError: true, errorCode });
      }
      await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("keep");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
