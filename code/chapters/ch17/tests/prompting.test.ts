import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  DynamicPromptProvider,
  DynamicPromptRenderer,
  PromptContextError,
} from "../src/features/prompting.js";
import type { JsonValue } from "../src/features/prompting.js";
import { MemoryRecord, MemorySession, MemoryStore, MemoryType } from "../src/features/memory.js";
import { SkillRegistry } from "../src/features/skills.js";
import { ToolRegistry, toolSuccess } from "../src/core/tools.js";

function registerReadTool(tools: ToolRegistry, name: string): void {
  tools.register({
    name,
    description: `Run ${name}.`,
    inputSchema: z.object({}).strict(),
    effect: "read",
    handler: () => toolSuccess(name),
  });
}

async function temporaryWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-tutorial-ch10-"));
}

async function writeSkill(workspace: string, name: string, description: string): Promise<void> {
  const directory = join(workspace, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# Private body\n`,
    "utf8",
  );
}

function record(name: string, description: string, body: string): MemoryRecord {
  return new MemoryRecord({ name, description, kind: MemoryType.PROJECT, body });
}

describe("dynamic prompt renderer", () => {
  test("binds live state through a zero-argument provider", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const tools = new ToolRegistry();
      const renderer = new DynamicPromptRenderer();
      const provider = new DynamicPromptProvider({
        renderer,
        identity: "agent",
        tools,
        workspace,
        context: { chapter: 10 },
      });

      const first = provider.render();
      registerReadTool(tools, "inspect");
      const second = provider.render();

      expect(first).toContain("## tools\n(none)");
      expect(second).toContain("## tools\n- inspect");
      expect(renderer.cacheHits).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("renders live sources in fixed order without private Skill or unselected memory bodies", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const tools = new ToolRegistry();
      registerReadTool(tools, "read_file");
      registerReadTool(tools, "todo_write");
      await writeSkill(workspace, "sql-style", "SQL 编写规范");
      const skills = SkillRegistry.scan(workspace);
      const store = new MemoryStore({ workspace, idGenerator: () => "one" });
      await store.extend([
        record("database", "生产数据库约束", "始终使用真实数据库。"),
        record("keyboard", "未选择的键盘索引说明", "PRIVATE UNSELECTED MEMORY"),
      ]);
      const memory = new MemorySession({
        store,
        selector: {
          async select() {
            return '["database"]';
          },
        },
      });
      await memory.beginTurn("检查数据库");

      const prompt = new DynamicPromptRenderer().render({
        identity: "主智能体",
        tools,
        workspace,
        skills,
        memory,
        context: { mode: "编码", nested: { b: 2, a: 1 }, flags: [true, null, 1.5] },
      });

      expect(prompt).toBe(
        `## identity\n主智能体\ncontext: {"flags":[true,null,1.5],"mode":"编码","nested":{"a":1,"b":2}}\n\n` +
          "## tools\n- read_file\n- todo_write\n\n" +
          `## workspace\n${resolve(workspace)}\n\n` +
          "## skills\n- **sql-style**: SQL 编写规范\n\n" +
          "## memory\n<relevant_memories>\n\n## database (project)\n\n生产数据库约束\n\n始终使用真实数据库。\n\n</relevant_memories>",
      );
      expect(prompt).not.toContain("Private body");
      expect(prompt).not.toContain("PRIVATE UNSELECTED MEMORY");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("uses a per-renderer cache for semantically equal context and invalidates every live section", async () => {
    const firstWorkspace = await temporaryWorkspace();
    const secondWorkspace = await temporaryWorkspace();
    try {
      await writeSkill(firstWorkspace, "alpha", "Alpha catalog entry");
      const tools = new ToolRegistry();
      registerReadTool(tools, "inspect");
      const renderer = new DynamicPromptRenderer();
      const firstContext: Record<string, JsonValue> = {
        b: [true, null, "中文"],
        a: { y: 2, x: 1 },
      };
      const reorderedContext: Record<string, JsonValue> = {
        a: { x: 1, y: 2 },
        b: [true, null, "中文"],
      };
      const first = renderer.render({
        identity: "agent",
        tools,
        workspace: firstWorkspace,
        context: firstContext,
        skills: SkillRegistry.scan(firstWorkspace),
      });
      const same = renderer.render({
        identity: "agent",
        tools,
        workspace: firstWorkspace,
        context: reorderedContext,
        skills: SkillRegistry.scan(firstWorkspace),
      });
      registerReadTool(tools, "write_file");
      const toolsChanged = renderer.render({
        identity: "agent",
        tools,
        workspace: firstWorkspace,
        context: reorderedContext,
        skills: SkillRegistry.scan(firstWorkspace),
      });
      const workspaceChanged = renderer.render({
        identity: "agent",
        tools,
        workspace: secondWorkspace,
        context: reorderedContext,
        skills: SkillRegistry.scan(firstWorkspace),
      });
      const isolatedRenderer = new DynamicPromptRenderer();
      const isolatedPrompt = isolatedRenderer.render({
        identity: "agent",
        tools,
        workspace: secondWorkspace,
        context: reorderedContext,
        skills: SkillRegistry.scan(firstWorkspace),
      });

      expect(same).toBe(first);
      expect(renderer.cacheHits).toBe(1);
      expect(toolsChanged).toContain("- write_file");
      expect(toolsChanged).not.toBe(first);
      expect(workspaceChanged).toContain(resolve(secondWorkspace));
      expect(workspaceChanged).not.toBe(toolsChanged);
      expect(isolatedPrompt).toBe(workspaceChanged);
      expect(isolatedRenderer.cacheHits).toBe(0);
      expect(renderer.cacheHits).toBe(1);
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  });

  test("invalidates the cache when the Skill catalog or selected memory changes", async () => {
    const workspace = await temporaryWorkspace();
    try {
      await writeSkill(workspace, "alpha", "Alpha catalog entry");
      const store = new MemoryStore({ workspace, idGenerator: () => "one" });
      await store.extend([
        record("first-memory", "First selected memory", "first body"),
        record("second-memory", "Second selected memory", "second body"),
      ]);
      let selectedName = "first-memory";
      const memory = new MemorySession({
        store,
        selector: {
          async select() {
            return JSON.stringify([selectedName]);
          },
        },
      });
      const tools = new ToolRegistry();
      const renderer = new DynamicPromptRenderer();
      await memory.beginTurn("first query");
      const first = renderer.render({
        identity: "agent",
        tools,
        workspace,
        context: {},
        skills: SkillRegistry.scan(workspace),
        memory,
      });

      await writeSkill(workspace, "beta", "Beta catalog entry");
      const skillsChanged = renderer.render({
        identity: "agent",
        tools,
        workspace,
        context: {},
        skills: SkillRegistry.scan(workspace),
        memory,
      });
      selectedName = "second-memory";
      await memory.beginTurn("second query");
      const memoryChanged = renderer.render({
        identity: "agent",
        tools,
        workspace,
        context: {},
        skills: SkillRegistry.scan(workspace),
        memory,
      });

      expect(first).toContain("- **alpha**: Alpha catalog entry");
      expect(first).toContain("first body");
      expect(skillsChanged).toContain("- **beta**: Beta catalog entry");
      expect(skillsChanged).toContain("first body");
      expect(memoryChanged).toContain("second body");
      expect(memoryChanged).not.toContain("first body");
      expect(renderer.cacheHits).toBe(0);
      expect(
        renderer.render({
          identity: "agent",
          tools,
          workspace,
          context: {},
          skills: SkillRegistry.scan(workspace),
          memory,
        }),
      ).toBe(memoryChanged);
      expect(renderer.cacheHits).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("preserves the JSON __proto__ key in rendered context and cache keys", () => {
    const renderer = new DynamicPromptRenderer();
    const tools = new ToolRegistry();
    const first = renderer.render({
      identity: "agent",
      tools,
      workspace: process.cwd(),
      context: JSON.parse('{"__proto__":"first"}') as Record<string, JsonValue>,
    });
    const second = renderer.render({
      identity: "agent",
      tools,
      workspace: process.cwd(),
      context: JSON.parse('{"__proto__":"second"}') as Record<string, JsonValue>,
    });

    expect(first).toContain('context: {"__proto__":"first"}');
    expect(second).toContain('context: {"__proto__":"second"}');
    expect(second).not.toBe(first);
    expect(renderer.cacheHits).toBe(0);
  });

  test.each([
    ["root array", ["root must be an object"]],
    ["unsupported object", { value: new Date() }],
    ["non-finite number", { value: Number.NaN }],
    ["symbol key", { [Symbol("secret")]: "hidden" }],
  ])("rejects %s context without poisoning the cache", (_label, context) => {
    const renderer = new DynamicPromptRenderer();
    const tools = new ToolRegistry();
    const valid = renderer.render({
      identity: "agent",
      tools,
      workspace: process.cwd(),
      context: {},
    });

    expect(() =>
      renderer.render({
        identity: "agent",
        tools,
        workspace: process.cwd(),
        context: context as Record<string, JsonValue>,
      }),
    ).toThrow(PromptContextError);
    expect(
      renderer.render({ identity: "agent", tools, workspace: process.cwd(), context: {} }),
    ).toBe(valid);
    expect(renderer.cacheHits).toBe(1);
  });

  test("rejects cyclic JSON context", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() =>
      new DynamicPromptRenderer().render({
        identity: "agent",
        tools: new ToolRegistry(),
        workspace: process.cwd(),
        context: cyclic as Record<string, JsonValue>,
      }),
    ).toThrow(/cyclic/);
  });
});
