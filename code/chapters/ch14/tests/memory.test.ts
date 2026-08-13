import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { assistantMessage, userMessage } from "../src/core/messages.js";
import type { ChatMessage } from "../src/core/messages.js";
import {
  MemoryRecord,
  MemorySession,
  MemoryStore,
  MemoryType,
  ModelMemoryQueries,
} from "../src/features/memory.js";
import type {
  MemoryConsolidator,
  MemoryExtractor,
  MemorySelector,
} from "../src/features/memory.js";
import { ScriptedModelClient } from "./fakes.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-tutorial-memory-"));
  workspaces.push(path);
  return path;
}

function ids(...values: string[]): () => string {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (value === undefined) {
      throw new Error("test id generator exhausted");
    }
    return value;
  };
}

function record(
  name: string,
  description: string,
  body: string,
  kind: MemoryType = MemoryType.PROJECT,
): MemoryRecord {
  return new MemoryRecord({ name, description, kind, body });
}

describe("ModelMemoryQueries", () => {
  test("uses tool-free requests for selection, extraction, and consolidation", async () => {
    const model = new ScriptedModelClient([
      { message: assistantMessage('["project-fact"]'), finishReason: "stop" },
      { message: assistantMessage("[]"), finishReason: "stop" },
      {
        message: assistantMessage(
          '{"source_names":["project-fact"],"records":[{"name":"merged","type":"project","description":"Merged fact","body":"merged body"}]}',
        ),
        finishReason: "stop",
      },
    ]);
    const queries = new ModelMemoryQueries(model);
    const value = record("project-fact", "Project fact", "body");
    const history = [userMessage("remember this"), assistantMessage("done")];

    await queries.select("project query", "- project-fact");
    await queries.extract(history, "- project-fact");
    await queries.consolidate([value]);

    expect(model.requests).toHaveLength(3);
    expect(model.requests.every((request) => request.tools.length === 0)).toBe(true);
    expect(model.requests[1]?.messages.slice(1, -1)).toEqual(history);
    expect(model.requests[2]?.messages.at(-1)?.content).toContain('"name":"project-fact"');
    model.assertExhausted();
  });

  test.each([
    { message: assistantMessage("[]"), finishReason: "length" as const },
    {
      message: assistantMessage(null, [{ id: "bad", name: "read_file", arguments: "{}" }]),
      finishReason: "tool_calls" as const,
    },
    { message: assistantMessage("   "), finishReason: "stop" as const },
  ])("rejects invalid side-query replies", async (reply) => {
    const queries = new ModelMemoryQueries(new ScriptedModelClient([reply]));
    await expect(queries.select("query", "catalog")).rejects.toThrow(/memory model/);
  });
});

describe("MemoryRecord and MemoryStore", () => {
  test.each(["../escape", "has space", "UPPER", "nul", "com1", "lpt9", "file:stream", "trailing."])(
    "rejects unsafe memory name %s",
    (name) => {
      expect(() => record(name, "description", "body")).toThrow(/slug/);
    },
  );

  test("enforces type, line, and UTF-8 byte limits", () => {
    expect(
      () =>
        new MemoryRecord({
          name: "valid-name",
          description: "description",
          kind: "invalid" as never,
          body: "body",
        }),
    ).toThrow(/MemoryType/);
    expect(() =>
      record("too-many-lines", "description", Array(201).fill("line").join("\n")),
    ).toThrow(/200 lines/);
    expect(() =>
      record("frontmatter-counts", "description", Array(195).fill("line").join("\n")),
    ).toThrow(/200 lines/);
    expect(() => record("too-many-bytes", "description", "界".repeat(1_400))).toThrow(
      /4096 UTF-8 bytes/,
    );
  });

  test("persists strict YAML records, manifest, and derived index", async () => {
    const root = await workspace();
    const preference = record(
      "tabs-style",
      "Tabs indentation preference",
      "Always indent with tabs. ",
      MemoryType.USER,
    );
    const store = new MemoryStore({ workspace: root, idGenerator: ids("id-one") });

    await store.add(preference);

    const manifest = JSON.parse(await readFile(join(root, ".memory", "manifest.json"), "utf8"));
    expect(manifest).toEqual({ version: 1, files: ["tabs-style-id-one.md"] });
    const persisted = await readFile(join(root, ".memory", "tabs-style-id-one.md"), "utf8");
    expect(persisted).toContain(
      "name: tabs-style\ndescription: Tabs indentation preference\ntype: user",
    );
    expect(persisted.endsWith("Always indent with tabs. \n")).toBe(true);
    expect(await readFile(join(root, ".memory", "MEMORY.md"), "utf8")).toBe(
      "- [tabs-style](tabs-style-id-one.md) - Tabs indentation preference\n",
    );
    expect(await new MemoryStore({ workspace: root }).records()).toEqual([preference]);
  });

  test("keeps the previous committed set when the index budget is exceeded", async () => {
    const root = await workspace();
    const store = new MemoryStore({
      workspace: root,
      idGenerator: ids("one", "two"),
      maxIndexBytes: 100,
    });
    await store.add(record("first-memory", "short description", "first body"));
    const memoryRoot = join(root, ".memory");
    const beforeManifest = await readFile(join(memoryRoot, "manifest.json"));
    const beforeFiles = await readdir(memoryRoot);

    await expect(store.add(record("second-memory", "x".repeat(80), "second body"))).rejects.toThrow(
      /index byte limit/,
    );

    expect(await readFile(join(memoryRoot, "manifest.json"))).toEqual(beforeManifest);
    expect((await readdir(memoryRoot)).sort()).toEqual(beforeFiles.sort());
    expect(await store.records()).toEqual([
      record("first-memory", "short description", "first body"),
    ]);
  });

  test("restores the previous index and removes new files when manifest replacement fails", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("one", "two") });
    await store.add(record("first", "First fact", "first body"));
    const memoryRoot = join(root, ".memory");
    const manifestPath = join(memoryRoot, "manifest.json");
    const beforeManifest = await readFile(manifestPath);
    const beforeIndex = await readFile(join(memoryRoot, "MEMORY.md"));
    const beforeFiles = await readdir(memoryRoot);

    await chmod(manifestPath, 0o444);
    try {
      await expect(store.add(record("second", "Second fact", "second body"))).rejects.toThrow();
    } finally {
      await chmod(manifestPath, 0o666);
    }

    expect(await readFile(manifestPath)).toEqual(beforeManifest);
    expect(await readFile(join(memoryRoot, "MEMORY.md"))).toEqual(beforeIndex);
    expect((await readdir(memoryRoot)).sort()).toEqual(beforeFiles.sort());
    expect(await store.records()).toEqual([record("first", "First fact", "first body")]);
  });

  test("removes every file from an uncommitted batch after an exclusive-write failure", async () => {
    const root = await workspace();
    const memoryRoot = join(root, ".memory");
    await mkdir(memoryRoot);
    await writeFile(join(memoryRoot, "second-collision.md"), "occupied", "utf8");
    const store = new MemoryStore({ workspace: root, idGenerator: ids("fresh", "collision") });

    await expect(
      store.extend([
        record("first", "First fact", "first body"),
        record("second", "Second fact", "second body"),
      ]),
    ).rejects.toThrow(/already exists/);

    expect(await readdir(memoryRoot)).toEqual(["second-collision.md"]);
  });

  test.each(["NUL.md", "safe-name.md:stream"])(
    "rejects unsafe manifest filename %s",
    async (filename) => {
      const root = await workspace();
      const memoryRoot = join(root, ".memory");
      await mkdir(memoryRoot);
      await writeFile(
        join(memoryRoot, "manifest.json"),
        JSON.stringify({ version: 1, files: [filename] }),
        "utf8",
      );
      await expect(new MemoryStore({ workspace: root }).records()).rejects.toThrow(
        /unsafe filename/,
      );
    },
  );

  test("rejects boolean manifest version instead of treating it as integer one", async () => {
    const root = await workspace();
    const memoryRoot = join(root, ".memory");
    await mkdir(memoryRoot);
    await writeFile(
      join(memoryRoot, "manifest.json"),
      JSON.stringify({ version: true, files: [] }),
      "utf8",
    );
    await expect(new MemoryStore({ workspace: root }).records()).rejects.toThrow(/invalid schema/);
  });

  test("rejects a memory-root link that escapes the workspace", async () => {
    const root = await workspace();
    const outside = await workspace();
    await symlink(outside, join(root, ".memory"), "junction");

    await expect(new MemoryStore({ workspace: root }).records()).rejects.toThrow(
      /escapes workspace/,
    );
  });

  test("resolves a linked workspace before creating the memory root", async () => {
    const target = await workspace();
    const parent = await workspace();
    const linkedWorkspace = join(parent, "workspace-link");
    await symlink(target, linkedWorkspace, "junction");
    const store = new MemoryStore({ workspace: linkedWorkspace, idGenerator: ids("linked") });

    await store.add(record("linked-fact", "Linked workspace fact", "body"));

    expect(await readFile(join(target, ".memory", "manifest.json"), "utf8")).toContain(
      "linked-fact-linked.md",
    );
  });

  test("serializes concurrent writers through the shared lock", async () => {
    const root = await workspace();
    const firstStore = new MemoryStore({ workspace: root, idGenerator: ids("one") });
    const secondStore = new MemoryStore({ workspace: root, idGenerator: ids("two") });

    await Promise.all([
      firstStore.add(record("first", "First fact", "first body")),
      secondStore.add(record("second", "Second fact", "second body")),
    ]);

    expect(
      [...(await firstStore.records())].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
    ).toEqual([
      record("first", "First fact", "first body"),
      record("second", "Second fact", "second body"),
    ]);
  });

  test("serializes writers that concurrently recover the same stale lock", async () => {
    const root = await workspace();
    const memoryRoot = join(root, ".memory");
    await mkdir(memoryRoot);
    const lockPath = join(memoryRoot, ".lock");
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);
    const stores = Array.from(
      { length: 8 },
      (_, index) => new MemoryStore({ workspace: root, idGenerator: ids(`id-${index}`) }),
    );

    await Promise.all(
      stores.map((store, index) =>
        store.add(record(`memory-${index}`, `Memory ${index}`, `body ${index}`)),
      ),
    );

    const firstStore = stores[0];
    if (firstStore === undefined) {
      throw new Error("test store factory returned no stores");
    }
    const records = await firstStore.records();
    expect(records).toHaveLength(8);
    expect(records.map((value) => value.name).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `memory-${index}`),
    );
  });
});

describe("MemorySession", () => {
  test("injects only model-selected memory bodies", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("one", "two") });
    const tabs = record(
      "tabs",
      "Tabs indentation preference",
      "Always indent with tabs.",
      MemoryType.USER,
    );
    const database = record(
      "database",
      "Production database constraint",
      "Never mock the database.",
    );
    await store.extend([tabs, database]);
    const calls: string[][] = [];
    const selector: MemorySelector = {
      async select(query, catalog) {
        calls.push([query, catalog]);
        return '["database"]';
      },
    };
    const session = new MemorySession({ store, selector });

    await session.beginTurn("How should database tests run?");

    expect(session.selected).toEqual([database]);
    expect(calls).toHaveLength(1);
    const context = session.beforeModel();
    expect(context).toHaveLength(1);
    expect(context[0]?.role).toBe("system");
    expect(context[0]?.content).toContain("Never mock the database.");
    expect(context[0]?.content).not.toContain("Always indent with tabs.");
  });

  test.each([new Error("offline"), "not json", '["unknown"]'])(
    "uses deterministic keyword fallback after selector failure",
    async (output) => {
      const root = await workspace();
      const store = new MemoryStore({ workspace: root, idGenerator: ids("one", "two") });
      const tabs = record("tabs-style", "Tabs indentation preference", "Always indent with tabs.");
      const database = record(
        "database",
        "Database integration constraint",
        "Use the real database.",
      );
      await store.extend([tabs, database]);
      const selector: MemorySelector = {
        async select() {
          if (output instanceof Error) {
            throw output;
          }
          return output;
        },
      };
      const session = new MemorySession({ store, selector });

      await session.beginTurn("Please check the database integration");

      expect(session.selected).toEqual([database]);
      expect(session.lastError).toBe("Memory selection failed; deterministic fallback used");
    },
  );

  test("matches Chinese bigrams in the deterministic fallback", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("one", "two") });
    const database = record("database", "生产数据库约束", "使用真实数据库。");
    const interaction = record("interaction", "前端交互约束", "保持键盘可用。");
    await store.extend([database, interaction]);
    const selector: MemorySelector = {
      async select() {
        throw new Error("offline");
      },
    };
    const session = new MemorySession({ store, selector });

    await session.beginTurn("检查数据库集成");

    expect(session.selected).toEqual([database]);
  });

  test("extracts valid memories without mutating caller history", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("extracted") });
    const histories: unknown[] = [];
    const extractor: MemoryExtractor = {
      async extract(history) {
        histories.push(history);
        return '[{"name":"windows-only","type":"project","description":"Project runs on Windows","body":"Use PowerShell commands."}]';
      },
    };
    const session = new MemorySession({ store, extractor });
    const history = [userMessage("We use Windows"), assistantMessage("Understood")];
    const before = structuredClone(history);

    await session.complete(history);

    expect(history).toEqual(before);
    expect(histories).toHaveLength(1);
    expect(histories[0]).not.toBe(history);
    expect((histories[0] as readonly ChatMessage[])[0]).not.toBe(history[0]);
    expect(await store.records()).toEqual([
      record("windows-only", "Project runs on Windows", "Use PowerShell commands."),
    ]);
    expect(session.lastError).toBeUndefined();
  });

  test("does not commit the valid prefix of an invalid extraction batch", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("unused") });
    const extractor: MemoryExtractor = {
      async extract() {
        return '[{"name":"valid","type":"project","description":"Valid fact","body":"valid body"},{"name":"../invalid","type":"project","description":"Invalid fact","body":"invalid body"}]';
      },
    };
    const session = new MemorySession({ store, extractor });

    await session.complete([userMessage("remember both"), assistantMessage("done")]);

    expect(session.lastError).toBe("Memory extraction failed");
    expect(await store.records()).toEqual([]);
  });

  test("does not consolidate the old collection after extraction fails", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("one") });
    const first = record("first", "First project fact", "first body");
    await store.add(first);
    let consolidationCalls = 0;
    const extractor: MemoryExtractor = {
      async extract() {
        throw new Error("offline");
      },
    };
    const consolidator: MemoryConsolidator = {
      async consolidate() {
        consolidationCalls += 1;
        return '{"source_names":["first"],"records":[{"name":"merged","type":"project","description":"Merged fact","body":"merged body"}]}';
      },
    };
    const session = new MemorySession({ store, extractor, consolidator, consolidateThreshold: 1 });

    await session.complete([userMessage("done"), assistantMessage("done")]);

    expect(session.lastError).toBe("Memory extraction failed");
    expect(consolidationCalls).toBe(0);
    expect(await store.records()).toEqual([first]);
  });

  test("does not partially commit extraction when consolidation fails", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("one", "unused") });
    const first = record("first", "First project fact", "first body");
    await store.add(first);
    const extractor: MemoryExtractor = {
      async extract() {
        return '[{"name":"second","type":"project","description":"Second project fact","body":"second body"}]';
      },
    };
    const consolidator: MemoryConsolidator = {
      async consolidate() {
        throw new Error("model unavailable");
      },
    };
    const session = new MemorySession({ store, extractor, consolidator, consolidateThreshold: 2 });

    await session.complete([userMessage("done"), assistantMessage("done")]);

    expect(session.lastError).toBe("Memory consolidation failed");
    expect(await store.records()).toEqual([first]);
  });

  test("rejects an empty consolidation replacement without changing the store", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("one") });
    const first = record("first", "First project fact", "first body");
    await store.add(first);
    const consolidator: MemoryConsolidator = {
      async consolidate() {
        return '{"source_names":["first"],"records":[]}';
      },
    };
    const session = new MemorySession({ store, consolidator, consolidateThreshold: 1 });

    await session.complete([userMessage("done"), assistantMessage("done")]);

    expect(session.lastError).toBe("Memory consolidation failed");
    expect(await store.records()).toEqual([first]);
  });

  test("atomically replaces only named sources and preserves unrelated records", async () => {
    const root = await workspace();
    const store = new MemoryStore({
      workspace: root,
      idGenerator: ids("one", "two", "three", "merged"),
    });
    const first = record("first", "First project fact", "first body");
    const second = record("second", "Second project fact", "second body");
    const unrelated = record(
      "unrelated",
      "Unrelated reference",
      "third body",
      MemoryType.REFERENCE,
    );
    await store.extend([first, second, unrelated]);
    const consolidator: MemoryConsolidator = {
      async consolidate() {
        return '{"source_names":["first","second"],"records":[{"name":"merged","type":"project","description":"Merged project facts","body":"merged body"}]}';
      },
    };
    const session = new MemorySession({ store, consolidator, consolidateThreshold: 2 });

    await session.complete([userMessage("done"), assistantMessage("done")]);

    expect(await store.records()).toEqual([
      unrelated,
      record("merged", "Merged project facts", "merged body"),
    ]);
    expect(JSON.parse(await readFile(join(root, ".memory", "manifest.json"), "utf8"))).toEqual({
      version: 1,
      files: ["unrelated-three.md", "merged-merged.md"],
    });
    expect(
      (await readdir(join(root, ".memory"))).filter((name) => name.endsWith(".md")).sort(),
    ).toEqual(["MEMORY.md", "merged-merged.md", "unrelated-three.md"]);
  });

  test("preserves a record committed while consolidation waits on the model", async () => {
    const root = await workspace();
    const store = new MemoryStore({ workspace: root, idGenerator: ids("first", "merged") });
    const first = record("first", "First project fact", "first body");
    const late = record("late", "Concurrently added fact", "late body");
    await store.add(first);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consolidator: MemoryConsolidator = {
      async consolidate() {
        started?.();
        await releasePromise;
        return '{"source_names":["first"],"records":[{"name":"merged","type":"project","description":"Merged fact","body":"merged body"}]}';
      },
    };
    const session = new MemorySession({ store, consolidator, consolidateThreshold: 1 });
    const completion = session.complete([userMessage("done"), assistantMessage("done")]);
    await startedPromise;

    await new MemoryStore({ workspace: root, idGenerator: ids("late") }).add(late);
    release?.();
    await completion;

    expect(await store.records()).toEqual([late, record("merged", "Merged fact", "merged body")]);
  });
});
