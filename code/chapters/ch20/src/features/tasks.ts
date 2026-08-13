// 第 12 章任务 DAG 的领域模型与工具注册：Task 构造器、TaskStore 接口和五个任务工具共用同一套校验边界。
import { z } from "zod";

import type { ToolDefinition, ToolRegistry } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const TaskStatus = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
} as const);

// 状态集合是任务迁移的单一来源；pending/in_progress/completed 之外的状态不会进入模型。
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export interface TaskOptions {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly owner: string | null;
  readonly blockedBy: readonly string[];
}

export class Task {
  // Task 构造器集中维护状态、owner 与依赖的领域不变量，存储层不得绕过它。
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly owner: string | null;
  readonly blockedBy: readonly string[];

  constructor(options: TaskOptions) {
    this.id = canonicalTaskId(options.id);
    this.subject = normalizeSubject(options.subject);
    this.description = normalizeDescription(options.description);
    if (!isTaskStatus(options.status)) {
      throw new TaskStorageError("task status is invalid");
    }
    this.status = options.status;
    this.owner = normalizeOptionalOwner(options.owner);
    this.blockedBy = normalizeDependencies(options.blockedBy);
    if (this.status === TaskStatus.PENDING && this.owner !== null) {
      throw new TaskStorageError("pending task must not have an owner");
    }
    if (this.status !== TaskStatus.PENDING && this.owner === null) {
      throw new TaskStorageError("in-progress or completed task requires an owner");
    }
    Object.freeze(this.blockedBy);
    Object.freeze(this);
  }
}

export interface TaskCompletion {
  readonly task: Task;
  readonly unblocked: readonly Task[];
}

export class TaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskError";
    this.code = code;
  }
}

export class TaskNotFoundError extends TaskError {
  constructor(message: string) {
    super("task_not_found", message);
    this.name = "TaskNotFoundError";
  }
}

export class TaskGraphError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super("task_graph_error", message, options);
    this.name = "TaskGraphError";
  }
}

export class TaskStateError extends TaskError {
  constructor(message: string, code = "task_invalid_state") {
    super(code, message);
    this.name = "TaskStateError";
  }
}

export class TaskBlockedError extends TaskStateError {
  readonly taskId: string;
  readonly blockedBy: readonly string[];

  constructor(taskId: string, blockedBy: readonly string[]) {
    super(`Task ${taskId} is blocked by: ${blockedBy.join(", ")}`, "task_blocked");
    this.name = "TaskBlockedError";
    this.taskId = taskId;
    this.blockedBy = Object.freeze([...blockedBy]);
  }
}

export class TaskOwnershipError extends TaskError {
  constructor(message: string) {
    super("task_owner_mismatch", message);
    this.name = "TaskOwnershipError";
  }
}

export class TaskStorageError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super("task_storage_error", message, options);
    this.name = "TaskStorageError";
  }
}

export interface CreateTaskInput {
  readonly subject: string;
  readonly description?: string;
  readonly blockedBy?: readonly string[];
}

// TaskStore 是所有持久化实现必须满足的窄接口，工具层不依赖 JSON 或 SQLite 具体实现。
export interface TaskStore {
  // 任务图操作以完整 Task 返回，调用者不能通过局部补丁跳过状态迁移校验。
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  listTasks(): Promise<readonly Task[]>;
  claimTask(taskId: string, owner: string): Promise<Task>;
  completeTask(taskId: string, owner: string): Promise<TaskCompletion>;
}

const taskIdSchema = z.string().regex(CANONICAL_UUID, "task_id must be a canonical UUID");
const createTaskSchema = z
  .object({
    subject: z.string().trim().min(1),
    description: z.string().trim().default(""),
    blocked_by: z.array(taskIdSchema).default([]),
  })
  .strict();
const taskIdInputSchema = z.object({ task_id: taskIdSchema }).strict();
const listTasksInputSchema = z.object({}).strict();

// 工具参数沿用磁盘命名 blocked_by，避免模型可见字段与存储格式之间出现另一层映射。
export function registerTaskTools(registry: ToolRegistry, store: TaskStore): void {
  // 五个工具统一由这里注册，schema 与 handler 都来自同一 ToolDefinition。
  registry.register(createTaskDefinition(store));
  registry.register(
    taskIdDefinition("get_task", "Read one persistent project task by ID.", "read", store),
  );
  registry.register({
    name: "list_tasks",
    description: "List the complete persistent project task graph.",
    inputSchema: listTasksInputSchema,
    effect: "read",
    handler: async (_input, _context) => {
      try {
        const tasks = await store.listTasks();
        return toolSuccess(encodePayload({ tasks: tasks.map(taskPayload) }));
      } catch (error) {
        return taskToolError(error);
      }
    },
  });
  registry.register(
    taskIdDefinition(
      "claim_task",
      "Atomically claim a ready pending task as the current identity.",
      "write",
      store,
    ),
  );
  registry.register({
    name: "complete_task",
    description: "Complete a claimed task owned by the current identity.",
    inputSchema: taskIdInputSchema,
    effect: "write",
    handler: async (input, context) => {
      try {
        const completion = await store.completeTask(
          input.task_id,
          normalizeOwner(context.identity),
        );
        return toolSuccess(
          encodePayload({
            task: taskPayload(completion.task),
            unblocked: completion.unblocked.map(taskPayload),
          }),
        );
      } catch (error) {
        return taskToolError(error);
      }
    },
  });
}

function createTaskDefinition(store: TaskStore): ToolDefinition<z.infer<typeof createTaskSchema>> {
  return {
    name: "create_task",
    description: "Create a persistent project task with explicit dependencies.",
    inputSchema: createTaskSchema,
    effect: "write",
    handler: async (input) => {
      try {
        const task = await store.createTask({
          subject: input.subject,
          description: input.description,
          blockedBy: input.blocked_by,
        });
        return toolSuccess(encodePayload(taskPayload(task)));
      } catch (error) {
        return taskToolError(error);
      }
    },
  };
}

function taskIdDefinition(
  name: "get_task" | "claim_task",
  description: string,
  effect: "read" | "write",
  store: TaskStore,
): ToolDefinition<z.infer<typeof taskIdInputSchema>> {
  // get/claim 共用 task_id schema，只有 store 调用和 effect 不同。
  return {
    name,
    description,
    inputSchema: taskIdInputSchema,
    effect,
    handler: async (input, context) => {
      try {
        const task =
          name === "get_task"
            ? await store.getTask(input.task_id)
            : await store.claimTask(input.task_id, normalizeOwner(context.identity));
        return toolSuccess(encodePayload(taskPayload(task)));
      } catch (error) {
        return taskToolError(error);
      }
    },
  };
}

function taskToolError(error: unknown) {
  // 已知领域错误保留稳定错误码；未知异常继续向上抛，避免吞掉程序缺陷。
  if (error instanceof TaskError) {
    return toolError(error.code, error.message);
  }
  throw error;
}

export function canonicalTaskId(value: string): string {
  // 所有 ID 都先归一为 canonical UUID，外部路径字符串无法进入文件系统。
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new TaskGraphError("task id must be a canonical UUID");
  }
  return value;
}

export function normalizeOwner(value: string): string {
  if (typeof value !== "string") {
    throw new TaskOwnershipError("task owner must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TaskOwnershipError("task owner must not be empty");
  }
  return normalized;
}

function normalizeOptionalOwner(value: string | null): string | null {
  return value === null ? null : normalizeOwner(value);
}

function normalizeSubject(value: string): string {
  if (typeof value !== "string") {
    throw new TaskStorageError("task subject must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TaskStorageError("task subject must not be empty");
  }
  return normalized;
}

function normalizeDescription(value: string): string {
  if (typeof value !== "string") {
    throw new TaskStorageError("task description must be a string");
  }
  return value.trim();
}

function normalizeDependencies(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new TaskStorageError("task dependencies must be an array");
  }
  const normalized = values.map(canonicalTaskId);
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskGraphError("task dependencies must be unique");
  }
  return normalized;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === TaskStatus.PENDING ||
    value === TaskStatus.IN_PROGRESS ||
    value === TaskStatus.COMPLETED
  );
}

function taskPayload(task: Task): Readonly<Record<string, unknown>> {
  // 返回给模型的字段使用磁盘命名 blocked_by，避免 wire format 与存储格式不一致。
  return {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
}

function encodePayload(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}
