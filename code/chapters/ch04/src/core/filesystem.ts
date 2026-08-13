// 文件 adapter 将不同平台错误归一为这些可由工具层稳定处理的领域错误。
// 文件系统抽象边界：WorkspaceFileSystem 仅暴露工作区内的文件操作，禁止越界。
export class WorkspacePathError extends Error {}

export class TextNotFoundError extends Error {}

export class InvalidUtf8Error extends Error {}

export class FileNotFoundError extends Error {}

export class InvalidFilePathError extends Error {}

export class FileSystemOperationError extends Error {}

export interface WorkspaceWriteBoundary {
  // 权限层仅依赖此窄接口检查写入边界，避免反向依赖具体文件实现。
  isPathWithinWorkspace(workspace: string, relativePath: string): Promise<boolean>;
}

export interface WorkspaceFileSystem extends WorkspaceWriteBoundary {
  // 仅声明 Agent 工具需要的工作区文件能力。
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
