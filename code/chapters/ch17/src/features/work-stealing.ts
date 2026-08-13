// 任务认领与完成能力：Lead、子代理和持续 Teammate 通过同一 SQLite store 与 claim service 操作任务，避免各自读写独立状态。
import { z } from "zod";

import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import { canonicalTaskId, type Task, TaskError } from "./tasks.js";
import type { CreateTaskInput, TaskCompletion } from "./tasks.js";

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const createTaskSchema = z.strictObject({
  subject: z.string().trim().min(1),
  description: z.string().trim().default(""),
  blocked_by: z.array(uuidSchema).default([]),
});
const taskIdSchema = z.strictObject({ task_id: uuidSchema });
const listTasksSchema = z.strictObject({});
const completeTaskSchema = z.strictObject({ task_id: uuidSchema, claim_token: uuidSchema });

export class TaskClaimError extends TaskError {
  constructor(message: string, code = "task_claim_mismatch") {
    super(code, message);
    this.name = "TaskClaimError";
  }
}

export class TaskLeaseExpiredError extends TaskClaimError {
  constructor(message: string) {
    super(message, "task_lease_expired");
    this.name = "TaskLeaseExpiredError";
  }
}

export interface TaskClaim {
  // claimToken 是完成权限证明，owner 相同也不能用旧租约完成被重新认领的任务。
  readonly task: Task;
  readonly claimToken: string;
  readonly leaseExpiresAtUtc: Date;
}

export interface LeasedTaskStore {
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  listTasks(): Promise<readonly Task[]>;
  claimTask(taskId: string, owner: string): Promise<TaskClaim>;
  claimNext(owner: string): Promise<TaskClaim | undefined>;
  completeTask(taskId: string, owner: string, claimToken: string): Promise<TaskCompletion>;
}

export interface TaskClaimService {
  readonly store: LeasedTaskStore;
  claimTask(taskId: string, context: ToolContext): Promise<TaskClaim>;
  claimNext(owner: string): Promise<TaskClaim | undefined>;
  completeTask(taskId: string, claimToken: string, context: ToolContext): Promise<TaskCompletion>;
}

// 默认服务把 ToolContext.identity 映射为 owner，不让工具输入伪造认领者。
class DirectTaskClaimService implements TaskClaimService {
  readonly #store: LeasedTaskStore;

  constructor(store: LeasedTaskStore) {
    this.#store = store;
  }

  get store(): LeasedTaskStore {
    return this.#store;
  }

  async claimTask(taskId: string, context: ToolContext): Promise<TaskClaim> {
    return await this.#store.claimTask(taskId, context.identity);
  }

  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    // 自动扫描不是模型工具调用，owner 由调用方直接传入；它不经过 ToolContext，模型也不能伪造。
    return await this.#store.claimNext(owner);
  }

  async completeTask(
    taskId: string,
    claimToken: string,
    context: ToolContext,
  ): Promise<TaskCompletion> {
    return await this.#store.completeTask(taskId, context.identity, claimToken);
  }
}

export interface WorkStealingSleeper {
  sleep(seconds: number, wakeup: AbortSignal): Promise<void>;
}

type LeasedToolDefinitions = ReturnType<typeof leasedTaskToolDefinitions>;
type TeammateLeasedToolDefinitions = readonly LeasedToolDefinitions[number][];

// AsyncioWorkStealingSleeper 默认 sleeper 使用 timer + abort 监听，避免空闲轮询无法被关闭流程中断。
export class AsyncioWorkStealingSleeper implements WorkStealingSleeper {
  async sleep(seconds: number, wakeup: AbortSignal): Promise<void> {
    if (wakeup.aborted) return;
    await new Promise<void>((resolve) => {
      // 同时监听 timer 和 abort：新消息到达时提前结束等待，避免 idle worker 卡满 5 秒。
      const timer = setTimeout(finish, seconds * 1000);
      const onAbort = (): void => {
        clearTimeout(timer);
        finish();
      };
      function finish(): void {
        wakeup.removeEventListener("abort", onAbort);
        resolve();
      }
      wakeup.addEventListener("abort", onAbort, { once: true });
      if (wakeup.aborted) onAbort();
    });
  }
}

// WorkStealingRuntime 封装任务认领/完成、轮询参数与工具定义，让 bootstrap 只关注能力组合而无需介入认领细节。
export class WorkStealingRuntime {
  // 运行时只通过共享 TaskClaimService 认领与完成，避免多队友直接竞争存储细节。
  readonly #store: LeasedTaskStore;
  readonly #claimService: TaskClaimService;
  readonly #sleeper: WorkStealingSleeper;
  readonly #pollIntervalSeconds: number;
  readonly #maxIdlePolls: number;
  readonly #leadToolDefinitions: LeasedToolDefinitions;
  readonly #teammateToolDefinitions: TeammateLeasedToolDefinitions;

  constructor(options: {
    readonly store: LeasedTaskStore;
    readonly claimService?: TaskClaimService;
    readonly sleeper?: WorkStealingSleeper;
    readonly pollIntervalSeconds?: number;
    readonly maxIdlePolls?: number;
  }) {
    if (!isLeasedTaskStore(options.store))
      throw new TypeError("store must implement LeasedTaskStore");
    const claimService =
      options.claimService === undefined
        ? new DirectTaskClaimService(options.store)
        : options.claimService;
    // claimService 必须指向同一个 store，否则 Lead 与 Teammate 可能操作两个数据库。
    if (!isTaskClaimService(claimService))
      throw new TypeError("claimService must implement TaskClaimService");
    if (claimService.store !== options.store) {
      throw new Error("claimService must use the WorkStealingRuntime store");
    }
    const sleeper =
      options.sleeper === undefined ? new AsyncioWorkStealingSleeper() : options.sleeper;
    if (typeof sleeper.sleep !== "function") throw new TypeError("sleeper must implement sleep()");
    const pollIntervalSeconds =
      options.pollIntervalSeconds === undefined ? 5 : options.pollIntervalSeconds;
    const maxIdlePolls = options.maxIdlePolls === undefined ? 12 : options.maxIdlePolls;
    if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
      throw new RangeError("pollIntervalSeconds must be positive");
    }
    if (!Number.isInteger(maxIdlePolls) || maxIdlePolls <= 0) {
      throw new RangeError("maxIdlePolls must be a positive integer");
    }
    this.#store = options.store;
    this.#claimService = claimService;
    this.#sleeper = sleeper;
    this.#pollIntervalSeconds = pollIntervalSeconds;
    this.#maxIdlePolls = maxIdlePolls;
    // 同一份五工具先整体给 Lead；Teammate 从索引 1 开始，只暴露读取、认领和完成。
    const definitions = leasedTaskToolDefinitions(this.#store, this.#claimService);
    this.#leadToolDefinitions = definitions;
    this.#teammateToolDefinitions = Object.freeze(definitions.slice(1));
  }

  get store(): LeasedTaskStore {
    return this.#store;
  }

  get claimService(): TaskClaimService {
    return this.#claimService;
  }

  get maxIdlePolls(): number {
    return this.#maxIdlePolls;
  }

  get leadToolDefinitions(): LeasedToolDefinitions {
    return this.#leadToolDefinitions;
  }

  get teammateToolDefinitions(): TeammateLeasedToolDefinitions {
    return this.#teammateToolDefinitions;
  }

  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    return await this.#claimService.claimNext(owner);
  }

  async waitForPoll(wakeup: AbortSignal): Promise<void> {
    await this.#sleeper.sleep(this.#pollIntervalSeconds, wakeup);
  }

  renderClaimPrompt(claim: TaskClaim): string {
    // 用确定性 JSON 把 token、lease 和任务状态一起交给模型，模型必须显式调用 complete_task。
    const payload = {
      claim_token: claim.claimToken,
      lease_expires_at_utc: claim.leaseExpiresAtUtc.toISOString(),
      task: taskPayload(claim.task),
    };
    return `<auto-claimed-task>\n${JSON.stringify(payload)}\n</auto-claimed-task>`;
  }
}

export function leasedTaskToolDefinitions(
  store: LeasedTaskStore,
  claimService: TaskClaimService = new DirectTaskClaimService(store),
): readonly [
  ToolDefinition<z.infer<typeof createTaskSchema>>,
  ToolDefinition<z.infer<typeof taskIdSchema>>,
  ToolDefinition<z.infer<typeof listTasksSchema>>,
  ToolDefinition<z.infer<typeof taskIdSchema>>,
  ToolDefinition<z.infer<typeof completeTaskSchema>>,
] {
  if (!isLeasedTaskStore(store)) throw new TypeError("store must implement LeasedTaskStore");
  if (!isTaskClaimService(claimService) || claimService.store !== store) {
    throw new Error("claimService must use the leased Task store");
  }
  // 数组顺序即 Lead/Teammate 的工具分界：Teammate 注册时跳过 create_task。
  const create: ToolDefinition<z.infer<typeof createTaskSchema>> = {
    name: "create_task",
    description: "Create a persistent SQLite project task with explicit dependencies.",
    inputSchema: createTaskSchema,
    effect: "write",
    handler: async (input) => {
      try {
        return toolSuccess(
          JSON.stringify(
            taskPayload(
              await store.createTask({
                subject: input.subject,
                description: input.description,
                blockedBy: input.blocked_by,
              }),
            ),
          ),
        );
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  const get: ToolDefinition<z.infer<typeof taskIdSchema>> = {
    name: "get_task",
    description: "Read one persistent SQLite project task by ID.",
    inputSchema: taskIdSchema,
    effect: "read",
    handler: async (input) => {
      try {
        return toolSuccess(JSON.stringify(taskPayload(await store.getTask(input.task_id))));
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  const list: ToolDefinition<z.infer<typeof listTasksSchema>> = {
    name: "list_tasks",
    description: "List the SQLite project task graph in stable creation order.",
    inputSchema: listTasksSchema,
    effect: "read",
    handler: async () => {
      try {
        const tasks = await store.listTasks();
        return toolSuccess(JSON.stringify({ tasks: tasks.map(taskPayload) }));
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  const claim: ToolDefinition<z.infer<typeof taskIdSchema>> = {
    name: "claim_task",
    description: "Atomically claim a ready task and return its claim token and lease.",
    inputSchema: taskIdSchema,
    effect: "write",
    handler: async (input, context) => {
      try {
        // claimService 从 ToolContext.identity 推导 owner，工具参数没有 owner 字段。
        return toolSuccess(
          JSON.stringify(claimPayload(await claimService.claimTask(input.task_id, context))),
        );
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  const complete: ToolDefinition<z.infer<typeof completeTaskSchema>> = {
    name: "complete_task",
    description: "Complete an owned task with its current claim token.",
    inputSchema: completeTaskSchema,
    effect: "write",
    handler: async (input, context) => {
      try {
        // owner 仍由 context.identity 注入，claim_token 是模型唯一需要回传的权限证明。
        const result = await claimService.completeTask(input.task_id, input.claim_token, context);
        return toolSuccess(
          JSON.stringify({
            task: taskPayload(result.task),
            unblocked: result.unblocked.map(taskPayload),
          }),
        );
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  return [create, get, list, claim, complete];
}

export function registerLeasedTaskTools(
  registry: ToolRegistry,
  store: LeasedTaskStore,
  claimService?: TaskClaimService,
): void {
  // Lead 和一次性子代理可创建任务、查询、认领并完成整个 DAG。
  const [create, get, list, claim, complete] = leasedTaskToolDefinitions(store, claimService);
  registry.register(create);
  registry.register(get);
  registry.register(list);
  registry.register(claim);
  registry.register(complete);
}

export function registerTeammateLeasedTaskTools(
  registry: ToolRegistry,
  store: LeasedTaskStore,
  claimService?: TaskClaimService,
): void {
  // 持续队友只处理已有任务，不暴露 create_task，避免空闲循环无界扩张任务图。
  const [, get, list, claim, complete] = leasedTaskToolDefinitions(store, claimService);
  registry.register(get);
  registry.register(list);
  registry.register(claim);
  registry.register(complete);
}

export function canonicalClaimToken(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskClaimError("Claim token must be a canonical UUID");
  }
}

function isLeasedTaskStore(value: unknown): value is LeasedTaskStore {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "createTask") === "function" &&
    typeof Reflect.get(value, "getTask") === "function" &&
    typeof Reflect.get(value, "listTasks") === "function" &&
    typeof Reflect.get(value, "claimTask") === "function" &&
    typeof Reflect.get(value, "claimNext") === "function" &&
    typeof Reflect.get(value, "completeTask") === "function"
  );
}

function isTaskClaimService(value: unknown): value is TaskClaimService {
  return (
    typeof value === "object" &&
    value !== null &&
    isLeasedTaskStore(Reflect.get(value, "store")) &&
    typeof Reflect.get(value, "claimTask") === "function" &&
    typeof Reflect.get(value, "claimNext") === "function" &&
    typeof Reflect.get(value, "completeTask") === "function"
  );
}

function taskPayload(task: Task): Readonly<Record<string, unknown>> {
  // 内存 Task 使用 blockedBy，工具结果统一映射为 wire format 的 blocked_by。
  return {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
}

function claimPayload(claim: TaskClaim): Readonly<Record<string, unknown>> {
  // TaskClaim 内部字段是 camelCase，序列化给模型时统一换成 claim_token 与 lease_expires_at_utc。
  return {
    claim_token: claim.claimToken,
    lease_expires_at_utc: claim.leaseExpiresAtUtc.toISOString(),
    task: taskPayload(claim.task),
  };
}

function leasedTaskError(error: unknown): ToolResult {
  if (error instanceof TaskError) return toolError(error.code, error.message);
  throw error;
}
