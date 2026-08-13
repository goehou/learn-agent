import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ToolRegistry } from "../src/core/tools.js";
import {
  DuplicateSkillError,
  SkillManifestError,
  SkillNameError,
  SkillNotFoundError,
  SkillPathError,
  SkillRegistry,
} from "../src/features/skills.js";

async function writeSkill(
  workspace: string,
  directory: string,
  options: {
    readonly name?: string;
    readonly description?: string;
    readonly body?: string;
  } = {},
): Promise<string> {
  const skillDirectory = join(workspace, "skills", directory);
  const name = options.name === undefined ? directory : options.name;
  const description = options.description === undefined ? "A test skill." : options.description;
  const body = options.body === undefined ? "# Test Skill\n\nprivate body\n" : options.body;
  await mkdir(skillDirectory, { recursive: true });
  const manifest = join(skillDirectory, "SKILL.md");
  await writeFile(
    manifest,
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`,
    "utf8",
  );
  return manifest;
}

async function writeRawManifest(
  workspace: string,
  directory: string,
  content: string | Buffer,
): Promise<string> {
  const skillDirectory = join(workspace, "skills", directory);
  await mkdir(skillDirectory, { recursive: true });
  const manifest = join(skillDirectory, "SKILL.md");
  await writeFile(manifest, content);
  return manifest;
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

describe("workspace skills", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-skills-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("an absent Skills directory produces an empty catalog", () => {
    const registry = SkillRegistry.scan(workspace);

    expect(registry.names).toEqual([]);
    expect(registry.catalogEntries).toEqual([]);
    expect(registry.renderCatalog()).toBe("");
  });

  test("the catalog is a snapshot while registered bodies are reread", async () => {
    const registry = SkillRegistry.scan(workspace);
    await writeSkill(workspace, "alpha", { body: "first body" });
    expect(registry.names).toEqual([]);

    const refreshed = SkillRegistry.scan(workspace);
    await writeFile(
      join(workspace, "skills", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: Updated description.\n---\nsecond body",
      "utf8",
    );
    expect(refreshed.renderCatalog()).toBe("- **alpha**: A test skill.");
    await expect(refreshed.loadSkill("alpha")).resolves.toBe("second body");
  });

  test("catalog limits must be positive integers", () => {
    expect(() => SkillRegistry.scan(workspace, { maxCatalogEntries: 0 })).toThrow(RangeError);
    expect(() => SkillRegistry.scan(workspace, { maxCatalogEntries: 1.5 })).toThrow(RangeError);
    expect(() => SkillRegistry.scan(workspace, { maxCatalogBytes: 0 })).toThrow(RangeError);
  });

  test("scans a stable bounded catalog without decoding or exposing bodies", async () => {
    await writeSkill(workspace, "zeta", { description: "Zeta description.", body: "ZETA PRIVATE" });
    await writeSkill(workspace, "alpha", {
      description: "Alpha description.",
      body: "ALPHA PRIVATE",
    });
    await writeSkill(workspace, "beta", { description: "Beta description.", body: "BETA PRIVATE" });

    const registry = SkillRegistry.scan(workspace, {
      maxCatalogEntries: 2,
      maxCatalogBytes: 1_000,
    });
    const secondScan = SkillRegistry.scan(workspace, {
      maxCatalogEntries: 2,
      maxCatalogBytes: 1_000,
    });

    expect(registry.names).toEqual(["alpha", "beta", "zeta"]);
    expect(registry.catalogEntries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(registry.renderCatalog()).toBe(
      "- **alpha**: Alpha description.\n- **beta**: Beta description.",
    );
    expect(secondScan.renderCatalog()).toBe(registry.renderCatalog());
    expect(registry.renderCatalog()).not.toContain("PRIVATE");
  });

  test("scan reads only frontmatter while explicit loading validates the full UTF-8 document", async () => {
    await writeRawManifest(
      workspace,
      "alpha",
      Buffer.concat([
        Buffer.from("---\nname: alpha\ndescription: Valid metadata\n---\n", "utf8"),
        Buffer.from([0xff]),
      ]),
    );

    const registry = SkillRegistry.scan(workspace);

    expect(registry.renderCatalog()).toBe("- **alpha**: Valid metadata");
    await expect(registry.loadSkill("alpha")).rejects.toThrow(SkillManifestError);
  });

  test("counts UTF-8 bytes and never emits a partial catalog entry", async () => {
    await writeSkill(workspace, "alpha", { description: "中文说明" });
    await writeSkill(workspace, "beta", { description: "short" });
    const firstLine = "- **alpha**: 中文说明";

    const registry = SkillRegistry.scan(workspace, {
      maxCatalogEntries: 10,
      maxCatalogBytes: Buffer.byteLength(firstLine, "utf8"),
    });

    expect(registry.renderCatalog()).toBe(firstLine);
    expect(registry.catalogEntries).toEqual([{ name: "alpha", description: "中文说明" }]);
    expect(Buffer.byteLength(registry.renderCatalog(), "utf8")).toBeLessThanOrEqual(
      Buffer.byteLength(firstLine, "utf8"),
    );
  });

  test("load_skill returns only a registered body after explicit tool invocation", async () => {
    const body = "# SQL Style\n\n只使用参数化查询。\n";
    await writeSkill(workspace, "sql-style", { description: "SQL 编写规范", body });
    const skills = SkillRegistry.scan(workspace);
    const tools = new ToolRegistry();
    tools.register(skills.toolDefinition);

    const result = await tools.invoke(
      tools.prepare({
        id: "skill-1",
        name: "load_skill",
        arguments: '{"name":"sql-style"}',
      }),
      { workspace, identity: "tester" },
    );

    expect(skills.renderCatalog()).toBe("- **sql-style**: SQL 编写规范");
    expect(skills.renderCatalog()).not.toContain(body);
    await expect(skills.loadSkill("sql-style")).resolves.toBe(body);
    expect(result).toEqual({ content: body, isError: false });
    expect(skills.toolDefinition).toMatchObject({ name: "load_skill", effect: "read" });
    expect(tools.openAITools()[0]?.function.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
      },
    });
  });

  test("rejects unknown, traversal, reserved, and extra load arguments before file access", async () => {
    await writeSkill(workspace, "known");
    const skills = SkillRegistry.scan(workspace);
    const tools = new ToolRegistry();
    tools.register(skills.toolDefinition);

    await expect(skills.loadSkill("../secret")).rejects.toThrow(SkillNameError);
    await expect(skills.loadSkill("missing")).rejects.toThrow(SkillNotFoundError);
    const missing = await tools.invoke(
      tools.prepare({ id: "missing", name: "load_skill", arguments: '{"name":"missing"}' }),
      { workspace, identity: "tester" },
    );
    const traversal = await tools.invoke(
      tools.prepare({ id: "escape", name: "load_skill", arguments: '{"name":"../secret"}' }),
      { workspace, identity: "tester" },
    );
    const extra = await tools.invoke(
      tools.prepare({
        id: "extra",
        name: "load_skill",
        arguments: '{"name":"known","path":"secret"}',
      }),
      { workspace, identity: "tester" },
    );
    const reserved = await tools.invoke(
      tools.prepare({ id: "reserved", name: "load_skill", arguments: '{"name":"nul"}' }),
      { workspace, identity: "tester" },
    );

    expect(missing).toMatchObject({ isError: true, errorCode: "skill_not_found" });
    expect(traversal).toMatchObject({ isError: true, errorCode: "invalid_arguments" });
    expect(extra).toMatchObject({ isError: true, errorCode: "invalid_arguments" });
    expect(reserved).toMatchObject({ isError: true, errorCode: "invalid_arguments" });
  });

  test("rejects malformed frontmatter, unsafe names, and duplicate names", async () => {
    await writeRawManifest(workspace, "alpha", "---\nname: alpha\ndescription: no close\n");
    expect(() => SkillRegistry.scan(workspace)).toThrow(SkillManifestError);
    await rm(join(workspace, "skills"), { recursive: true, force: true });

    await writeSkill(workspace, "bad_name");
    expect(() => SkillRegistry.scan(workspace)).toThrow(SkillManifestError);
    await rm(join(workspace, "skills"), { recursive: true, force: true });

    await writeSkill(workspace, "first", { name: "shared" });
    await writeSkill(workspace, "second", { name: "shared" });
    expect(() => SkillRegistry.scan(workspace)).toThrow(DuplicateSkillError);
  });

  test.each([
    ["missing opening delimiter", "name: alpha\ndescription: valid\n"],
    ["invalid YAML", "---\nname: [\n---\n"],
    ["non-mapping YAML", "---\n- name: alpha\n- description: valid\n---\n"],
    ["missing name", "---\ndescription: valid\n---\n"],
    ["missing description", "---\nname: alpha\n---\n"],
    ["wrong name type", "---\nname: 7\ndescription: valid\n---\n"],
    ["wrong description type", "---\nname: alpha\ndescription: 7\n---\n"],
    ["blank description", '---\nname: alpha\ndescription: "   "\n---\n'],
    ["multiline description", "---\nname: alpha\ndescription: |\n  first\n  second\n---\n"],
  ])("rejects %s", async (_label, manifest) => {
    await writeRawManifest(workspace, "alpha", manifest);

    expect(() => SkillRegistry.scan(workspace)).toThrow(SkillManifestError);
  });

  test("requires the manifest name to match its directory", async () => {
    await writeSkill(workspace, "alpha", { name: "beta" });

    expect(() => SkillRegistry.scan(workspace)).toThrow(SkillManifestError);
  });

  test("load_skill rejects a ToolContext from another workspace", async () => {
    await writeSkill(workspace, "alpha");
    const otherWorkspace = await mkdtemp(join(tmpdir(), "agent-tutorial-other-workspace-"));
    try {
      const skills = SkillRegistry.scan(workspace);
      const tools = new ToolRegistry();
      tools.register(skills.toolDefinition);

      const result = await tools.invoke(
        tools.prepare({ id: "mismatch", name: "load_skill", arguments: '{"name":"alpha"}' }),
        { workspace: otherWorkspace, identity: "tester" },
      );

      expect(result).toMatchObject({ isError: true, errorCode: "skill_workspace_mismatch" });
    } finally {
      await rm(otherWorkspace, { recursive: true, force: true });
    }
  });

  test("load_skill reports an unresolvable ToolContext workspace", async () => {
    await writeSkill(workspace, "alpha");
    const skills = SkillRegistry.scan(workspace);
    const tools = new ToolRegistry();
    tools.register(skills.toolDefinition);

    const result = await tools.invoke(
      tools.prepare({ id: "workspace", name: "load_skill", arguments: '{"name":"alpha"}' }),
      { workspace: join(workspace, "missing"), identity: "tester" },
    );

    expect(result).toMatchObject({ isError: true, errorCode: "skill_workspace_error" });
  });

  test("rejects unsafe skill roots and directory links that escape the workspace", async (context) => {
    expect(() => SkillRegistry.scan(workspace, { skillsDirectory: "../outside" })).toThrow(
      SkillPathError,
    );
    expect(() => SkillRegistry.scan(workspace, { skillsDirectory: "nul" })).toThrow(SkillPathError);
    expect(() =>
      SkillRegistry.scan(workspace, { skillsDirectory: join(workspace, "skills") }),
    ).toThrow(SkillPathError);

    const skillsDirectory = join(workspace, "skills");
    const outside = await mkdtemp(join(tmpdir(), "agent-tutorial-outside-skill-"));
    await mkdir(skillsDirectory);
    await writeFile(
      join(outside, "SKILL.md"),
      "---\nname: escaped\ndescription: outside\n---\nSECRET",
      "utf8",
    );
    if (!(await createDirectoryLink(join(skillsDirectory, "escaped"), outside))) {
      await rm(outside, { recursive: true, force: true });
      context.skip();
    }

    try {
      expect(() => SkillRegistry.scan(workspace)).toThrow(SkillPathError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rechecks path containment when a registered directory becomes an escape link", async (context) => {
    await writeSkill(workspace, "alpha", { body: "SAFE" });
    const skills = SkillRegistry.scan(workspace);
    const moved = join(workspace, "moved-alpha");
    await rename(join(workspace, "skills", "alpha"), moved);
    const outside = await mkdtemp(join(tmpdir(), "agent-tutorial-outside-alpha-"));
    await writeFile(
      join(outside, "SKILL.md"),
      "---\nname: alpha\ndescription: outside\n---\nSECRET",
      "utf8",
    );
    if (!(await createDirectoryLink(join(workspace, "skills", "alpha"), outside))) {
      await rm(outside, { recursive: true, force: true });
      context.skip();
    }

    try {
      await expect(skills.loadSkill("alpha")).rejects.toThrow(SkillPathError);
      const tools = new ToolRegistry();
      tools.register(skills.toolDefinition);
      const result = await tools.invoke(
        tools.prepare({ id: "escaped", name: "load_skill", arguments: '{"name":"alpha"}' }),
        { workspace, identity: "tester" },
      );
      expect(result).toMatchObject({ isError: true, errorCode: "skill_path_escape" });
      expect(result.content).not.toContain("SECRET");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
