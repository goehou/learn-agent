// Skill 管理：扫描技能目录、解析 frontmatter 并做路径白名单校验，为模型提供 load_skill 的 catalog 与内容读取。
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  readFile as readFileBytes,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";

import { parse } from "yaml";
import { z } from "zod";

import { isWindowsReservedComponent } from "../core/filesystem.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

// 技能目录、工具名与 catalog 上限是 Skill 功能的公共边界。
export const LOAD_SKILL_TOOL_NAME = "load_skill";
export const DEFAULT_SKILLS_DIRECTORY = "skills";
export const DEFAULT_MAX_CATALOG_ENTRIES = 100;
export const DEFAULT_MAX_CATALOG_BYTES = 8_000;
export const MAX_SKILL_NAME_LENGTH = 64;

// Skill 注册表只公开受限目录中的清单摘要，正文必须通过 load_skill 按需读取。
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SKILL_NAME_REGEXP = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// 校验名称为字母数字带连字符的合法标识，并拒绝 Windows 设备名。
const loadSkillInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_SKILL_NAME_LENGTH)
      .regex(SKILL_NAME_REGEXP)
      .refine((name) => !isWindowsReservedComponent(name))
      .describe("The exact Skill name from the available catalog."),
  })
  .strict();

export type LoadSkillInput = Readonly<z.output<typeof loadSkillInputSchema>>;

export class SkillError extends Error {}

export class SkillPathError extends SkillError {}

export class SkillManifestError extends SkillError {}

export class DuplicateSkillError extends SkillError {}

export class SkillNameError extends SkillError {}

export class SkillNotFoundError extends SkillError {}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
}

interface SkillRecord extends SkillSummary {
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly manifestPath: string;
}

export interface SkillScanOptions {
  readonly skillsDirectory?: string;
  readonly maxCatalogEntries?: number;
  readonly maxCatalogBytes?: number;
}

interface ParsedSkillDocument extends SkillSummary {
  readonly body: string;
}

// 扫描生成不可变元数据快照；加载时重新校验每一层真实路径。
export class SkillRegistry {
  // 扫描时记录入口，加载时再次校验真实路径，以防扫描后链接被替换。
  readonly #workspaceRoot: string;
  readonly #skillsRoot: string;
  readonly #records: ReadonlyMap<string, SkillRecord>;
  readonly names: readonly string[];
  readonly catalogEntries: readonly SkillSummary[];
  readonly toolDefinition: ToolDefinition<LoadSkillInput>;

  private constructor(
    workspaceRoot: string,
    skillsRoot: string,
    records: ReadonlyMap<string, SkillRecord>,
    catalogEntries: readonly SkillSummary[],
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#skillsRoot = skillsRoot;
    this.#records = new Map(records);
    this.names = Object.freeze([...records.keys()].sort());
    this.catalogEntries = Object.freeze(catalogEntries.map((entry) => Object.freeze({ ...entry })));
    this.toolDefinition = Object.freeze({
      name: LOAD_SKILL_TOOL_NAME,
      description: "Load the full instructions for one Skill listed in the workspace catalog.",
      inputSchema: loadSkillInputSchema,
      effect: "read",
      handler: (input: LoadSkillInput, context: ToolContext) => this.#handleLoad(input, context),
    });
  }

  static scan(workspace: string, options: SkillScanOptions = {}): SkillRegistry {
    // Catalog 有条目和字节上限，避免 workspace 文件把系统提示词无限扩张。
    const workspaceRoot = resolveWorkspace(workspace);
    const skillsDirectory =
      options.skillsDirectory === undefined ? DEFAULT_SKILLS_DIRECTORY : options.skillsDirectory;
    const maxCatalogEntries = positiveInteger(
      options.maxCatalogEntries,
      DEFAULT_MAX_CATALOG_ENTRIES,
      "maxCatalogEntries",
    );
    const maxCatalogBytes = positiveInteger(
      options.maxCatalogBytes,
      DEFAULT_MAX_CATALOG_BYTES,
      "maxCatalogBytes",
    );
    const skillsPath = resolveSkillRoot(workspaceRoot, skillsDirectory);
    if (!existsSync(skillsPath)) {
      return new SkillRegistry(workspaceRoot, skillsPath, new Map(), []);
    }

    const skillsRoot = checkedRealDirectory(
      skillsPath,
      workspaceRoot,
      `Skills directory escapes workspace: ${skillsDirectory}`,
    );
    const discovered: SkillRecord[] = [];
    const byName = new Map<string, SkillRecord>();

    for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((left, right) =>
      compareSkillNames(left.name, right.name),
    )) {
      const lexicalDirectory = resolve(skillsRoot, entry.name);
      const information = lstatSync(lexicalDirectory);
      if (!information.isDirectory() && !information.isSymbolicLink()) {
        continue;
      }
      const directoryPath = checkedRealDirectory(
        lexicalDirectory,
        skillsRoot,
        `Skill directory escapes Skills root: ${entry.name}`,
      );
      const lexicalManifest = resolve(directoryPath, "SKILL.md");
      if (!existsSync(lexicalManifest)) {
        continue;
      }
      const manifestPath = checkedRealFile(
        lexicalManifest,
        directoryPath,
        `Skill manifest escapes its directory: ${entry.name}`,
      );
      const parsed = parseSkillDocument(readFrontmatter(manifestPath), manifestPath);
      // 保存逻辑入口；显式加载时重新解析，才能发现扫描后的链接替换。
      const record: SkillRecord = Object.freeze({
        name: parsed.name,
        description: parsed.description,
        directoryName: entry.name,
        directoryPath: lexicalDirectory,
        manifestPath: resolve(lexicalDirectory, "SKILL.md"),
      });
      if (byName.has(record.name)) {
        throw new DuplicateSkillError(`Duplicate Skill name: ${record.name}`);
      }
      byName.set(record.name, record);
      discovered.push(record);
    }

    for (const record of discovered) {
      if (record.name !== record.directoryName) {
        throw new SkillManifestError(
          `Skill name must match its directory: ${record.directoryName}`,
        );
      }
    }

    const ordered = [...byName.values()].sort((left, right) =>
      compareSkillNames(left.name, right.name),
    );
    const catalog = boundedCatalog(ordered, maxCatalogEntries, maxCatalogBytes);
    return new SkillRegistry(
      workspaceRoot,
      skillsRoot,
      new Map(ordered.map((record) => [record.name, record])),
      catalog,
    );
  }

  renderCatalog(): string {
    return this.catalogEntries
      .map((entry) => `- **${entry.name}**: ${entry.description}`)
      .join("\n");
  }

  async loadSkill(name: string): Promise<string> {
    // 读取请求边界重新解析 workspace、Skill 目录和 manifest 的物理位置。
    validateSkillName(name);
    const record = this.#records.get(name);
    if (record === undefined) {
      throw new SkillNotFoundError(`Skill not found: ${name}`);
    }

    // load_skill 位于请求路径，使用异步 I/O，并重新检查每一层真实路径。
    const currentSkillsRoot = await checkedRealDirectoryAsync(
      this.#skillsRoot,
      this.#workspaceRoot,
      "Skills directory escapes workspace",
    );
    const currentDirectory = await checkedRealDirectoryAsync(
      record.directoryPath,
      currentSkillsRoot,
      `Skill directory escapes Skills root: ${name}`,
    );
    const currentManifest = await checkedRealFileAsync(
      record.manifestPath,
      currentDirectory,
      `Skill manifest escapes its directory: ${name}`,
    );
    const document = parseSkillDocument(
      decodeUtf8(await readFileBytes(currentManifest), currentManifest),
      currentManifest,
    );
    if (document.name !== record.name || document.name !== record.directoryName) {
      throw new SkillManifestError(`Skill name must match its directory: ${name}`);
    }
    return document.body;
  }

  // handler 先验证 workspace 一致性，再通过 loadSkill 读取并返回正文。
  async #handleLoad(input: LoadSkillInput, context: ToolContext): Promise<ToolResult> {
    let contextWorkspace: string;
    try {
      contextWorkspace = await resolveWorkspaceAsync(context.workspace);
    } catch (error) {
      if (error instanceof SkillPathError) {
        return toolError("skill_workspace_error", "Current workspace could not be resolved");
      }
      throw error;
    }
    if (contextWorkspace !== this.#workspaceRoot) {
      return toolError(
        "skill_workspace_mismatch",
        "Skill registry belongs to a different workspace",
      );
    }
    try {
      return toolSuccess(await this.loadSkill(input.name));
    } catch (error) {
      if (error instanceof SkillNotFoundError) {
        return toolError("skill_not_found", "Requested Skill is not registered");
      }
      if (error instanceof SkillPathError) {
        return toolError("skill_path_escape", "Registered Skill path is no longer safe");
      }
      if (error instanceof SkillManifestError) {
        return toolError("invalid_skill", "Registered Skill manifest is invalid");
      }
      return toolError("skill_load_error", "Skill could not be loaded");
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return selected;
}

function resolveWorkspace(workspace: string): string {
  let root: string;
  try {
    root = realpathSync.native(workspace);
  } catch {
    throw new SkillPathError(`Workspace does not exist: ${workspace}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new SkillPathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

async function resolveWorkspaceAsync(workspace: string): Promise<string> {
  let root: string;
  try {
    root = await realpathAsync(workspace);
  } catch {
    throw new SkillPathError(`Workspace does not exist: ${workspace}`);
  }
  if (!(await statAsync(root)).isDirectory()) {
    throw new SkillPathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

function resolveSkillRoot(workspaceRoot: string, skillsDirectory: string): string {
  if (skillsDirectory.length === 0 || skillsDirectory.includes("\0")) {
    throw new SkillPathError("Skills directory must be a non-empty relative path");
  }
  const normalized = skillsDirectory.replaceAll("\\", "/");
  if (
    isAbsolute(skillsDirectory) ||
    win32.isAbsolute(skillsDirectory) ||
    /^[A-Za-z]:/u.test(skillsDirectory) ||
    normalized.startsWith("/")
  ) {
    throw new SkillPathError("Skills directory must be relative to the workspace");
  }
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new SkillPathError("Skills directory must not contain parent segments");
  }
  for (const part of parts) {
    if (isWindowsReservedComponent(part)) {
      throw new SkillPathError(`Skills directory contains a reserved path component: ${part}`);
    }
  }
  const target = resolve(workspaceRoot, ...parts);
  if (!isInside(workspaceRoot, target)) {
    throw new SkillPathError("Skills directory escapes workspace");
  }
  return target;
}

function checkedRealDirectory(path: string, root: string, message: string): string {
  let physical: string;
  try {
    physical = realpathSync.native(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !statSync(physical).isDirectory()) {
    throw new SkillPathError(message);
  }
  return physical;
}

function checkedRealFile(path: string, root: string, message: string): string {
  let physical: string;
  try {
    physical = realpathSync.native(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !statSync(physical).isFile()) {
    throw new SkillPathError(message);
  }
  return physical;
}

async function checkedRealDirectoryAsync(
  path: string,
  root: string,
  message: string,
): Promise<string> {
  let physical: string;
  try {
    physical = await realpathAsync(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !(await statAsync(physical)).isDirectory()) {
    throw new SkillPathError(message);
  }
  return physical;
}

async function checkedRealFileAsync(path: string, root: string, message: string): Promise<string> {
  let physical: string;
  try {
    physical = await realpathAsync(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !(await statAsync(physical)).isFile()) {
    throw new SkillPathError(message);
  }
  return physical;
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

// 只读取 frontmatter 结束分隔符之前的字节，避免扫描时解码全量正文。
function readFrontmatter(path: string): string {
  const descriptor = openSync(path, "r");
  const completeLines: Buffer[] = [];
  let pending = Buffer.alloc(0);
  const chunk = Buffer.allocUnsafe(4_096);
  try {
    while (true) {
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        break;
      }
      let offset = 0;
      while (offset < count) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1 || newline >= count) {
          pending = Buffer.concat([pending, chunk.subarray(offset, count)]);
          break;
        }
        const line = Buffer.concat([pending, chunk.subarray(offset, newline + 1)]);
        pending = Buffer.alloc(0);
        completeLines.push(line);
        if (completeLines.length > 1 && isFrontmatterSeparator(line)) {
          // catalog 只解码 frontmatter；正文留到 load_skill 被显式调用之后。
          return decodeUtf8(Buffer.concat(completeLines), path);
        }
        offset = newline + 1;
      }
    }
    if (pending.byteLength > 0) {
      completeLines.push(pending);
    }
    return decodeUtf8(Buffer.concat(completeLines), path);
  } finally {
    closeSync(descriptor);
  }
}

function isFrontmatterSeparator(line: Buffer): boolean {
  let end = line.byteLength;
  if (end > 0 && line[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end > 0 && line[end - 1] === 0x0d) {
    end -= 1;
  }
  return end === 3 && line[0] === 0x2d && line[1] === 0x2d && line[2] === 0x2d;
}

function decodeUtf8(bytes: Uint8Array, source: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new SkillManifestError(`Skill manifest is not valid UTF-8: ${source}`);
  }
}

function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

function stripLineEnding(line: string): string {
  if (line.endsWith("\r\n")) {
    return line.slice(0, -2);
  }
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

// 校验 frontmatter 格式与结构，确保 name、description 合规。
function parseSkillDocument(text: string, source: string): ParsedSkillDocument {
  const lines = splitLinesKeepEnds(text);
  if (lines.length === 0 || stripLineEnding(lines[0] as string) !== "---") {
    throw new SkillManifestError(`Skill manifest must begin with YAML frontmatter: ${source}`);
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && stripLineEnding(line) === "---",
  );
  if (closingIndex === -1) {
    throw new SkillManifestError(`Skill manifest has no closing frontmatter delimiter: ${source}`);
  }

  let metadata: unknown;
  try {
    metadata = parse(lines.slice(1, closingIndex).join(""));
  } catch {
    throw new SkillManifestError(`Skill frontmatter is not valid YAML: ${source}`);
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new SkillManifestError(`Skill frontmatter must be a mapping: ${source}`);
  }
  const name = Reflect.get(metadata, "name");
  const description = Reflect.get(metadata, "description");
  if (typeof name !== "string" || typeof description !== "string") {
    throw new SkillManifestError(
      `Skill frontmatter requires string name and description: ${source}`,
    );
  }
  try {
    validateSkillName(name);
  } catch (error) {
    if (error instanceof SkillNameError) {
      throw new SkillManifestError(`Skill frontmatter contains an invalid name: ${source}`);
    }
    throw error;
  }
  const normalizedDescription = description.trim();
  if (
    normalizedDescription.length === 0 ||
    normalizedDescription.includes("\n") ||
    normalizedDescription.includes("\r")
  ) {
    throw new SkillManifestError(`Skill description must be one non-empty line: ${source}`);
  }
  return Object.freeze({
    name,
    description: normalizedDescription,
    body: lines.slice(closingIndex + 1).join(""),
  });
}

function validateSkillName(name: string): void {
  if (
    name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_REGEXP.test(name) ||
    isWindowsReservedComponent(name)
  ) {
    throw new SkillNameError(`Invalid Skill name: ${name}`);
  }
}

function compareSkillNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// Catalog 按条目数和 UTF-8 byte 双重上限截断，返回不可变快照。
function boundedCatalog(
  records: readonly SkillRecord[],
  maxEntries: number,
  maxBytes: number,
): readonly SkillSummary[] {
  const catalog: SkillSummary[] = [];
  let usedBytes = 0;
  for (const record of records) {
    if (catalog.length >= maxEntries) {
      break;
    }
    const line = `- **${record.name}**: ${record.description}`;
    const separatorBytes = catalog.length === 0 ? 0 : 1;
    const entryBytes = Buffer.byteLength(line, "utf8") + separatorBytes;
    if (usedBytes + entryBytes > maxBytes) {
      break;
    }
    catalog.push(Object.freeze({ name: record.name, description: record.description }));
    usedBytes += entryBytes;
  }
  return Object.freeze(catalog);
}
