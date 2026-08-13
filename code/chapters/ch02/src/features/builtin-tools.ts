/**
 * 内置工具定义：P02 的能力面由 shell 与四个文件工具组成。
 * 每个工具把 Zod schema、description、effect 和 handler 绑定在一个 ToolDefinition 中。
 * description 随 z.toJSONSchema 进入模型上下文，因此既是文档也是决策提示；
 * handler 负责把领域错误映射为模型可见的稳定错误码，不改变 Agent Loop。
 */
import { z } from "zod";

import type { CommandResult, CommandRunner } from "../core/commands.js";
import {
  FileNotFoundError,
  FileSystemOperationError,
  InvalidFilePathError,
  InvalidUtf8Error,
  TextNotFoundError,
  WorkspacePathError,
} from "../core/filesystem.js";
import type { WorkspaceFileSystem } from "../core/filesystem.js";
import type { ToolDefinition } from "../core/tools.js";
import { ToolRegistry, toolError, toolSuccess } from "../core/tools.js";

// shell 的最小输入契约；严格对象拒绝模型附带的未声明参数。
const shellInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .describe("Exact PowerShell command to run. The process starts in the current workspace."),
});

// 工具定义将模型参数约束、效果分类和工作区执行器保持在同一处。
export function createShellTool(commandRunner: CommandRunner): ToolDefinition<{ command: string }> {
  return {
    name: "shell",
    description:
      "Run a PowerShell command in the current workspace. Prefer it only when the file tools cannot express the operation. Execution requires interactive approval, and stdout/stderr are returned together with an explicit marker when output is truncated.",
    inputSchema: shellInputSchema,
    effect: "execute",
    handler: async ({ command }, context) => {
      let result: CommandResult;
      try {
        result = await commandRunner.run(command, context.workspace);
      } catch {
        return toolError("shell_start_failed", "PowerShell process could not be started");
      }

      let output = result.output.length === 0 ? "(no output)" : result.output;
      // 截断标志加入正文，让模型知道输出不代表完整命令结果。
      if (result.truncated) {
        output = `${output}\n[output truncated]`;
      }
      if (result.timedOut) {
        return toolError("shell_timeout", output);
      }
      if (result.exitCode !== 0) {
        return toolError(
          "shell_failed",
          `PowerShell exited with code ${result.exitCode}\n${output}`,
        );
      }
      return toolSuccess(output);
    },
  };
}

// 构建 P01 累积工具集，供 P02 在保留 shell 行为的基础上继续扩展。
export function createChapterOneTools(commandRunner: CommandRunner): ToolRegistry {
  // P02 仍复用 P01 的注册结果，保证章节快照的累计行为。
  const registry = new ToolRegistry();
  registry.register(createShellTool(commandRunner));
  return registry;
}

// 读取工具的路径和可选行数限制；路径安全性由文件系统边界二次验证。
const readFileInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative file path. `..`, absolute paths, Windows device names, and symlink/junction escapes are rejected.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional maximum number of lines to return. The full file is returned when omitted.",
    ),
});
// 完整写入的输入契约；空 content 有意表示清空文件而非参数错误。
const writeFileInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Workspace-relative destination path. Parent directories are created automatically."),
  content: z
    .string()
    .describe("UTF-8 text content to write. Use an empty string to clear the file."),
});
// 精确编辑的输入契约；old_text 必填且非空以防无边界插入。
const editFileInputSchema = z.strictObject({
  path: z.string().min(1).describe("Workspace-relative target file path."),
  old_text: z
    .string()
    .min(1)
    .describe(
      "Exact existing text to replace. Only the first occurrence is changed; read the file first to get exact text.",
    ),
  new_text: z
    .string()
    .describe("Replacement text. Use an empty string to delete the matched text."),
});
// 文件发现的受限 glob 输入契约；父目录片段会由安全边界拒绝。
const globInputSchema = z.strictObject({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative glob pattern, for example `**/*.ts`; patterns containing `..` are rejected.",
    ),
});

// 从 Zod schema 推导执行器输入，模型描述和实际参数类型不重复维护。
// 从 schema 推导的读取 handler 输入，防止 TypeScript 类型与模型参数漂移。
type ReadFileInput = z.infer<typeof readFileInputSchema>;
// 从 schema 推导的完整写入 handler 输入。
type WriteFileInput = z.infer<typeof writeFileInputSchema>;
// 从 schema 推导的精确编辑 handler 输入。
type EditFileInput = z.infer<typeof editFileInputSchema>;
// 从 schema 推导的文件发现 handler 输入。
type GlobInput = z.infer<typeof globInputSchema>;

// 创建只读文本工具，并把文件系统领域错误转译为模型可恢复的错误码。
function createReadFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<ReadFileInput> {
  // 基础设施错误在这里映射为模型可见的稳定错误码。
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the current workspace. Pass a workspace-relative path; `limit` limits the returned output to that many lines and appends a visible remaining-line marker. Invalid UTF-8 fails with `invalid_utf8` instead of silently replacing bytes.",
    inputSchema: readFileInputSchema,
    effect: "read",
    handler: async ({ path, limit }, context) => {
      try {
        return toolSuccess(await fileSystem.readFile(context.workspace, path, limit));
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          return toolError("path_escape", error.message);
        }
        if (error instanceof InvalidUtf8Error) {
          return toolError("invalid_utf8", `File is not valid UTF-8: ${path}`);
        }
        if (error instanceof FileNotFoundError) {
          return toolError("file_not_found", `File not found: ${path}`);
        }
        if (error instanceof InvalidFilePathError) {
          return toolError("invalid_path", `Path is a directory: ${path}`);
        }
        if (error instanceof FileSystemOperationError) {
          return toolError("filesystem_error", `Could not read file: ${path}`);
        }
        throw error;
      }
    },
  };
}

// 创建完整内容写入工具，成功时报告实际 UTF-8 字节数而不是字符数。
function createWriteFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<WriteFileInput> {
  // 每个文件工具独立映射领域错误，模型可按错误码修正下一次调用。
  return {
    name: "write_file",
    description:
      "Write UTF-8 text to a file in the current workspace. Use this when the full target content is known; parent directories are created automatically and the result reports the actual UTF-8 byte count.",
    inputSchema: writeFileInputSchema,
    effect: "write",
    handler: async ({ path, content }, context) => {
      try {
        const byteCount = await fileSystem.writeFile(context.workspace, path, content);
        return toolSuccess(`Wrote ${byteCount} UTF-8 bytes to ${path}`);
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          return toolError("path_escape", error.message);
        }
        if (error instanceof InvalidFilePathError) {
          return toolError("invalid_path", `Path is a directory: ${path}`);
        }
        if (error instanceof FileNotFoundError || error instanceof FileSystemOperationError) {
          return toolError("filesystem_error", `Could not write file: ${path}`);
        }
        throw error;
      }
    },
  };
}

// 创建首个精确匹配替换工具，避免模型指定模糊行号造成不可预测编辑。
function createEditFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<EditFileInput> {
  // 编辑只替换首个精确匹配，避免模型模糊指令造成意外批量修改。
  return {
    name: "edit_file",
    description:
      "Replace the first exact occurrence of `old_text` with `new_text` in a UTF-8 file in the current workspace. Use this for surgical edits after reading the file; line numbers are never accepted. If the exact text is missing, the file is left unchanged and `text_not_found` is returned.",
    inputSchema: editFileInputSchema,
    effect: "write",
    handler: async ({ path, old_text, new_text }, context) => {
      try {
        await fileSystem.editFile(context.workspace, path, old_text, new_text);
        return toolSuccess(`Edited ${path}`);
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          return toolError("path_escape", error.message);
        }
        if (error instanceof TextNotFoundError) {
          return toolError("text_not_found", `Exact text not found in ${path}`);
        }
        if (error instanceof InvalidUtf8Error) {
          return toolError("invalid_utf8", `File is not valid UTF-8: ${path}`);
        }
        if (error instanceof FileNotFoundError) {
          return toolError("file_not_found", `File not found: ${path}`);
        }
        if (error instanceof InvalidFilePathError) {
          return toolError("invalid_path", `Path is a directory: ${path}`);
        }
        if (error instanceof FileSystemOperationError) {
          return toolError("filesystem_error", `Could not edit file: ${path}`);
        }
        throw error;
      }
    },
  };
}

// 创建只读路径发现工具，空匹配也是正常工具结果而不是异常。
function createGlobTool(fileSystem: WorkspaceFileSystem): ToolDefinition<GlobInput> {
  return {
    name: "glob",
    description:
      "List workspace-relative paths matching a glob pattern. Use this to discover files before reading or editing. Matches are returned one per line in stable alphabetical order with `/` separators; `(no matches)` is returned when nothing matches.",
    inputSchema: globInputSchema,
    effect: "read",
    handler: async ({ pattern }, context) => {
      try {
        const matches = await fileSystem.globFiles(context.workspace, pattern);
        return toolSuccess(matches.length === 0 ? "(no matches)" : matches.join("\n"));
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          return toolError("path_escape", error.message);
        }
        if (
          error instanceof FileNotFoundError ||
          error instanceof InvalidFilePathError ||
          error instanceof FileSystemOperationError
        ) {
          return toolError("filesystem_error", `Could not list files: ${pattern}`);
        }
        throw error;
      }
    },
  };
}

export function createChapterTwoTools(
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
): ToolRegistry {
  // 章节能力累加：保留 P01 Shell，再注册文件读写与枚举工具。
  const registry = createChapterOneTools(commandRunner);
  registry.register(createReadFileTool(fileSystem));
  registry.register(createWriteFileTool(fileSystem));
  registry.register(createEditFileTool(fileSystem));
  registry.register(createGlobTool(fileSystem));
  return registry;
}
