/**
 * Node 文件系统适配器：实现 core 的 WorkspaceFileSystem。
 * 所有工具路径必须先经 safePath 从 workspace 相对路径解析为安全绝对路径，
 * 再执行 read/write/edit/glob。Node 错误在适配器边界翻译为领域错误。
 * UTF-8 使用 fatal TextDecoder，非法字节不会被静默替换。
 */
import {
  lstat,
  mkdir,
  readdir,
  readFile as readFileBytes,
  realpath,
  stat,
  writeFile as writeFileBytes,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";

import {
  FileNotFoundError,
  FileSystemOperationError,
  InvalidFilePathError,
  InvalidUtf8Error,
  TextNotFoundError,
  WorkspacePathError,
} from "../core/filesystem.js";
import type { WorkspaceFileSystem } from "../core/filesystem.js";

// Windows 保留设备名和严格 UTF-8 解码器都属于工作区安全边界。
// Win32 设备文件名集合；即使带扩展名也不能作为普通工作区路径组件。
const WINDOWS_DEVICE_NAMES = new Set(["AUX", "CLOCK$", "CON", "CONIN$", "CONOUT$", "NUL", "PRN"]);
// fatal 模式避免无效字节被替换字符掩盖，读工具必须报告编码错误。
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

// 文件系统适配器把 Node 错误归一为工具层可映射的领域错误。
// 从未知异常中提取 Node 的 code，不能信任任何异常对象一定具有该字段。
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

// 将 Node 的宽松异常映射为核心文件系统契约的稳定错误类型。
function translateFileSystemError(error: unknown): Error {
  // 已知领域错误原样保留，其余 Node 错误映射为稳定的工具层错误类别。
  if (
    error instanceof WorkspacePathError ||
    error instanceof TextNotFoundError ||
    error instanceof InvalidUtf8Error ||
    error instanceof FileNotFoundError ||
    error instanceof InvalidFilePathError ||
    error instanceof FileSystemOperationError ||
    error instanceof RangeError
  ) {
    return error;
  }
  const code = errorCode(error);
  if (code === "ENOENT") {
    return new FileNotFoundError("File or directory was not found");
  }
  if (code === "EISDIR" || code === "ENOTDIR") {
    return new InvalidFilePathError("Path has the wrong file type");
  }
  if (code === undefined) {
    return error instanceof Error ? error : new Error("Non-error value thrown by file system code");
  }
  return new FileSystemOperationError("File system operation failed");
}

// 判断候选绝对路径是否仍在根目录内，兼容 Windows 与 POSIX 分隔符语义。
function isInside(root: string, candidate: string): boolean {
  // relative 结果既非父目录也非绝对路径，才表示 candidate 仍在 root 内。
  const child = relative(root, candidate);
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

// 拒绝 Windows 非法字符、尾随空格/点以及设备名，防止跨平台路径语义偏差。
function isWindowsReservedComponent(component: string): boolean {
  // 同时拒绝 Win32 非法字符、尾随点/空格和设备文件名。
  if (component.endsWith(" ") || component.endsWith(".")) {
    return true;
  }
  if (
    [...component].some((character) => {
      const code = character.codePointAt(0);
      return (code !== undefined && code < 32) || '<>:"|*?'.includes(character);
    })
  ) {
    return true;
  }
  const stem = component.split(".", 1)[0]?.replace(/ +$/u, "").toUpperCase();
  if (stem === undefined) {
    return false;
  }
  if (WINDOWS_DEVICE_NAMES.has(stem)) {
    return true;
  }
  return (
    stem.length === 4 &&
    (stem.startsWith("COM") || stem.startsWith("LPT")) &&
    "123456789¹²³".includes(stem[3] ?? "")
  );
}

// 将用户路径或 glob 拆成安全相对组件；allowWildcards 只为 glob 的模式字符放行。
function relativeParts(value: string, label: string, allowWildcards: boolean): string[] {
  // 同时拒绝 POSIX、Win32 和盘符绝对路径，所有工具路径必须相对工作区。
  if (value.length === 0) {
    throw new WorkspacePathError(`${label} must not be empty`);
  }
  if (value.includes("\0")) {
    throw new WorkspacePathError(`${label} contains a null byte`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    normalized.startsWith("/")
  ) {
    throw new WorkspacePathError(
      `${label} must be relative; absolute paths are rejected: ${value}`,
    );
  }
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.includes("..")) {
    throw new WorkspacePathError(`${label} must not contain parent segments: ${value}`);
  }
  for (const part of parts) {
    if (!allowWildcards && isWindowsReservedComponent(part)) {
      throw new WorkspacePathError(`${label} contains a reserved Windows path component: ${part}`);
    }
    if (
      [...part].some((character) => {
        const code = character.codePointAt(0);
        return (code !== undefined && code < 32) || '<>:"|'.includes(character);
      })
    ) {
      throw new WorkspacePathError(`${label} contains a reserved Windows path component: ${part}`);
    }
  }
  return parts;
}

// 解析并验证工作区真实路径，作为符号链接检查所依据的可信根。
async function workspaceRoot(workspace: string): Promise<string> {
  // 真实路径是后续链接逃逸检查的可信根，而不是调用方传入的词法路径。
  const root = await realpath(workspace);
  const information = await stat(root);
  if (!information.isDirectory()) {
    throw new InvalidFilePathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

// 向上查找目标最接近的已存在父目录，以便写入新文件前也能验证真实路径边界。
async function resolvedExistingParent(
  root: string,
  target: string,
): Promise<{ physical: string; lexical: string }> {
  // 写入目标可能尚不存在，向上寻找首个可 realpath 的父目录即可验证链接边界。
  let current = target;
  while (true) {
    try {
      return { physical: await realpath(current), lexical: current };
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || current === root) {
        throw error;
      }
      current = dirname(current);
    }
  }
}

// 以词法检查和 realpath 检查双重解析相对路径，阻止 junction 与符号链接逃逸。
export async function safePath(workspace: string, relativePath: string): Promise<string> {
  // 词法检查后再解析现有父目录真实路径，双重防护链接逃逸。
  try {
    const root = await workspaceRoot(workspace);
    const parts = relativeParts(relativePath, "path", false);
    const target = resolve(root, ...parts);
    if (!isInside(root, target)) {
      throw new WorkspacePathError(`Path escapes workspace: ${relativePath}`);
    }
    // 现有父路径必须解析真实位置，防止 junction 或符号链接把目标带出工作区。
    const existing = await resolvedExistingParent(root, target);
    const resolved = resolve(existing.physical, relative(existing.lexical, target));
    if (!isInside(root, resolved)) {
      throw new WorkspacePathError(`Path escapes workspace: ${relativePath}`);
    }
    return resolved;
  } catch (error) {
    throw translateFileSystemError(error);
  }
}

// 用共享严格解码器读取文本，文件含非法 UTF-8 时返回领域错误而非替换字符。
function decodeUtf8(bytes: Uint8Array, relativePath: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new InvalidUtf8Error(`File is not valid UTF-8: ${relativePath}`);
  }
}

// 统一换行符后按行截断，输出不依赖宿主系统的行尾格式。
// 尾随空行不计作内容行，保证 read_file 的 limit 在各平台一致。
function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

// 将约定的 glob 子集编译为路径级正则；不把未实现模式静默交给宿主 shell。
function globRegex(pattern: string): RegExp {
  // 仅实现工具约定的 glob 子集，匹配对象始终是标准化的相对路径。
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) {
      continue;
    }
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const content = pattern.slice(index + 1, end);
        source += content.startsWith("!") ? `[^${content.slice(1)}]` : `[${content}]`;
        index = end;
      }
    } else {
      source += character === "/" ? "/" : character.replace(/[\\^$+?.()|{}]/gu, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u");
}

// 提取第一个通配符前的确定目录，以缩小 glob 扫描范围并先验证该路径。
async function literalPrefix(root: string, parts: readonly string[]): Promise<readonly string[]> {
  // 从第一个通配符起停止，减少 glob 遍历起点并先验证确定的目录前缀。
  const literal: string[] = [];
  for (const part of parts) {
    if (/[?*[\]]/u.test(part)) {
      break;
    }
    literal.push(part);
  }
  if (literal.length > 0) {
    await safePath(root, literal.join(sep));
  }
  return literal;
}

// Node fs/promises 对 WorkspaceFileSystem 的实现；所有公开操作都通过 safePath 保持工作区边界。
export class NodeWorkspaceFileSystem implements WorkspaceFileSystem {
  // 所有 I/O 都经 safePath，不能绕过工作区边界直接操作宿主文件。
  // 读取后统一行尾，limit 只影响返回内容，不影响磁盘文件。
  async readFile(workspace: string, relativePath: string, limit?: number): Promise<string> {
    try {
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new RangeError("limit must be a positive integer");
      }
      const target = await safePath(workspace, relativePath);
      const text = decodeUtf8(await readFileBytes(target), relativePath);
      const lines = splitLines(text);
      if (limit !== undefined && limit < lines.length) {
        return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
      }
      return lines.join("\n");
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  // 在安全目标的父目录内创建缺失目录并写入 UTF-8 字节，返回写入大小。
  async writeFile(workspace: string, relativePath: string, content: string): Promise<number> {
    try {
      const target = await safePath(workspace, relativePath);
      // 仅在已确认安全的目标父目录中递归创建目录。
      const bytes = Buffer.from(content, "utf8");
      await mkdir(dirname(target), { recursive: true });
      await writeFileBytes(target, bytes);
      return bytes.byteLength;
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  // 读取、查找并只替换第一次精确文本；找不到时抛出 TextNotFoundError。
  async editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void> {
    // 精确文本替换只修改首次命中，调用方可据此构造可预测的编辑操作。
    try {
      if (oldText.length === 0) {
        throw new RangeError("old_text must not be empty");
      }
      const target = await safePath(workspace, relativePath);
      const currentBytes = await readFileBytes(target);
      const current = decodeUtf8(currentBytes, relativePath);
      const index = current.indexOf(oldText);
      if (index === -1) {
        throw new TextNotFoundError(`Exact text not found in ${relativePath}`);
      }
      const updated = `${current.slice(0, index)}${newText}${current.slice(index + oldText.length)}`;
      await writeFileBytes(target, Buffer.from(updated, "utf8"));
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  // 在安全工作区内遍历目录并返回稳定、去重、使用 / 分隔的相对匹配结果。
  async globFiles(workspace: string, pattern: string): Promise<readonly string[]> {
    try {
      const root = await workspaceRoot(workspace);
      const parts = relativeParts(pattern, "glob pattern", true);
      const prefix = await literalPrefix(root, parts);
      const normalizedPattern = parts.length === 0 ? "." : parts.join("/");
      const matcher = globRegex(normalizedPattern);
      const start = resolve(root, ...prefix);
      let startInformation: Stats;
      try {
        startInformation = await lstat(start);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return Object.freeze([]);
        }
        throw error;
      }
      if (prefix.length === parts.length) {
        // 无通配符时无需扫描目录，直接按规范化相对路径返回。
        return Object.freeze(matcher.test(normalizedPattern) ? [normalizedPattern] : []);
      }
      if (!startInformation.isDirectory() || startInformation.isSymbolicLink()) {
        return Object.freeze([]);
      }
      const results: string[] = [];
      const pending = [start];
      // Dirent.isDirectory() 不会跟随符号链接目录，避免递归越界和链接环。
      while (pending.length > 0) {
        const directory = pending.pop();
        if (directory === undefined) {
          continue;
        }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = join(directory, entry.name);
          const relativePath = relative(root, target).split(sep).join("/");
          if (matcher.test(relativePath)) {
            const resolved = await safePath(root, relativePath);
            if (!isInside(root, resolved)) {
              throw new WorkspacePathError(`Glob match escapes workspace: ${relativePath}`);
            }
            results.push(relativePath);
          }
          if (entry.isDirectory()) {
            pending.push(target);
          }
        }
      }
      return Object.freeze([...new Set(results)].sort());
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }
}
