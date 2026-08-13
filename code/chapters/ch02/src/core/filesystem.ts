/**
 * 文件系统领域错误与接口定义。
 * 每个错误类型对应一个精确的失败场景，工具层按 instanceof 映射为模型可见的稳定错误码。
 * WorkspaceFileSystem 只使用字符串路径和基本类型，不暴露 Node 实现细节。
 */
// 文件工具以细分错误类型区分路径逃逸、编码、缺失和 I/O 失败。
// 相对路径在词法或真实路径解析后逃出工作区时抛出。
export class WorkspacePathError extends Error {}

// edit_file 找不到要求的精确旧文本时抛出，保证文件没有被部分修改。
export class TextNotFoundError extends Error {}

// 文件字节不能按严格 UTF-8 解码时抛出，禁止静默替换损坏字节。
export class InvalidUtf8Error extends Error {}

// 目标文件或目录在执行操作前不存在时抛出。
export class FileNotFoundError extends Error {}

// 路径指向错误的文件类型，例如把目录作为文本文件时抛出。
export class InvalidFilePathError extends Error {}

// 无法归入其他领域错误的底层文件系统失败。
export class FileSystemOperationError extends Error {}

// 所有路径参数必须相对 workspace；实现负责在每次操作前保留此边界。
// 这是工具层唯一依赖的文件系统边界，Node 细节不进入 Agent Loop。
export interface WorkspaceFileSystem {
  // 读取严格 UTF-8 文本；limit 存在时按规范化行数截断输出。
  readFile(workspace: string, relativePath: string, limit?: number): Promise<string>;
  // 写入完整 UTF-8 内容并返回实际字节数，调用方据此向模型报告副作用。
  writeFile(workspace: string, relativePath: string, content: string): Promise<number>;
  // 仅替换第一次精确匹配，oldText 不存在时不写入任何变更。
  editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>;
  // 按受限 glob 子集列举工作区相对路径，结果必须稳定排序。
  globFiles(workspace: string, pattern: string): Promise<readonly string[]>;
}
