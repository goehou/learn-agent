/**
 * 文件系统领域错误与接口定义。
 * 每个错误类型对应一个精确的失败场景，工具层按 instanceof 映射为模型可见的稳定错误码。
 * WorkspaceFileSystem 只使用字符串路径和基本类型，不暴露 Node 实现细节。
 */
// 文件工具以细分错误类型区分路径逃逸、编码、缺失和 I/O 失败。
export class WorkspacePathError extends Error {}

export class TextNotFoundError extends Error {}

export class InvalidUtf8Error extends Error {}

export class FileNotFoundError extends Error {}

export class InvalidFilePathError extends Error {}

export class FileSystemOperationError extends Error {}

// 所有路径参数必须相对 workspace；实现负责在每次操作前保留此边界。
export interface WorkspaceFileSystem {
  readFile(workspace: string, relativePath: string, limit?: number): Promise<string>;
  writeFile(workspace: string, relativePath: string, content: string): Promise<number>;
  editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>;
  globFiles(workspace: string, pattern: string): Promise<readonly string[]>;
}
