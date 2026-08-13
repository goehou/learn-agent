import { z } from "zod";

import { HookRegistry } from "../core/hooks.js";
import { AgentLimitError, AgentRunner } from "../core/loop.js";
import type { ToolContextProvider } from "../core/loop.js";
import type { ModelClient } from "../core/model.js";
import { PermissionPolicy } from "../core/permissions.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { ToolRegistry, toolError, toolSuccess } from "../core/tools.js";

export const TASK_TOOL_NAME = "task";
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
export const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  "You are a focused coding subagent working in the current workspace. " +
  "Complete only the delegated task, then return a concise, evidence-based final conclusion. " +
  "Do not delegate further.";

// 子代理只接收自包含任务，并通过独立运行器返回最终结论而非中间历史。
const taskInputSchema = z
  .object({
    description: z
      .string()
      .transform((description) => description.trim())
      .pipe(z.string().min(1))
      .describe("A self-contained task for the subagent to complete."),
  })
  .strict();

export type TaskInput = Readonly<z.output<typeof taskInputSchema>>;
export type ModelClientFactory = () => ModelClient;
export type ToolRegistryFactory = () => ToolRegistry;

// 工厂签名允许调用方为每次委派延迟创建独立的模型与工具实例。
export interface SubagentToolOptions {
  readonly modelFactory: ModelClientFactory;
  readonly toolsFactory: ToolRegistryFactory;
  readonly hooks: HookRegistry;
  readonly permissionPolicy: PermissionPolicy;
  readonly toolContextProvider?: ToolContextProvider;
  readonly systemPrompt?: string;
  readonly maxTurns?: number;
}

export class SubagentTool {
  readonly #modelFactory: ModelClientFactory;
  readonly #toolsFactory: ToolRegistryFactory;
  readonly #hooks: HookRegistry;
  readonly #permissionPolicy: PermissionPolicy;
  readonly #toolContextProvider: ToolContextProvider | undefined;
  readonly #systemPrompt: string;
  readonly #maxTurns: number;
  readonly toolDefinition: ToolDefinition<TaskInput>;

  constructor(options: SubagentToolOptions) {
    if (typeof options.modelFactory !== "function") {
      throw new TypeError("modelFactory must be callable");
    }
    if (typeof options.toolsFactory !== "function") {
      throw new TypeError("toolsFactory must be callable");
    }
    if (!(options.hooks instanceof HookRegistry)) {
      throw new TypeError("hooks must be HookRegistry");
    }
    if (!(options.permissionPolicy instanceof PermissionPolicy)) {
      throw new TypeError("permissionPolicy must be PermissionPolicy");
    }
    if (
      options.toolContextProvider !== undefined &&
      (typeof options.toolContextProvider.resolve !== "function" ||
        typeof options.toolContextProvider.workspaceRoot !== "string" ||
        options.toolContextProvider.workspaceRoot.trim().length === 0)
    ) {
      throw new TypeError("toolContextProvider must implement the ToolContextProvider contract");
    }
    const systemPrompt =
      options.systemPrompt === undefined ? DEFAULT_SUBAGENT_SYSTEM_PROMPT : options.systemPrompt;
    if (systemPrompt.trim().length === 0) {
      throw new Error("systemPrompt must not be empty");
    }
    const maxTurns = options.maxTurns === undefined ? DEFAULT_SUBAGENT_MAX_TURNS : options.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error("maxTurns must be a positive integer");
    }
    if (maxTurns > DEFAULT_SUBAGENT_MAX_TURNS) {
      throw new Error("maxTurns must be at most 30");
    }

    this.#modelFactory = options.modelFactory;
    this.#toolsFactory = options.toolsFactory;
    this.#hooks = options.hooks;
    this.#permissionPolicy = options.permissionPolicy;
    this.#toolContextProvider = options.toolContextProvider;
    this.#systemPrompt = systemPrompt;
    this.#maxTurns = maxTurns;
    this.toolDefinition = Object.freeze({
      name: TASK_TOOL_NAME,
      description: "Launch an isolated subagent and return only its final conclusion.",
      inputSchema: taskInputSchema,
      effect: "external",
      handler: (input: TaskInput, context: ToolContext) => this.#runTask(input, context),
    });
  }

  async #runTask(input: TaskInput, context: ToolContext): Promise<ToolResult> {
    try {
      // 工厂在每次委派时创建隔离依赖，父代理的工具状态不会被子代理共享或改写。
      const tools: unknown = this.#toolsFactory();
      if (!(tools instanceof ToolRegistry)) {
        return toolError(
          "subagent_configuration_error",
          "Subagent tools factory must return ToolRegistry",
        );
      }
      if (tools.names.includes(TASK_TOOL_NAME)) {
        // 禁止子代理再次注册 task，防止无边界的递归委派。
        return toolError("subagent_configuration_error", "Subagent tools must not include task");
      }

      const model: unknown = this.#modelFactory();
      if (!isModelClient(model)) {
        return toolError(
          "subagent_configuration_error",
          "Subagent model factory must return ModelClient",
        );
      }

      // 新 Runner 只继承运行边界；父历史和其他子任务历史不会传入。
      const runner = new AgentRunner({
        model,
        tools,
        systemPrompt: this.#systemPrompt,
        workspace: context.workspace,
        identity: context.identity,
        maxTurns: this.#maxTurns,
        hooks: this.#hooks,
        permissionPolicy: this.#permissionPolicy,
        ...(this.#toolContextProvider === undefined
          ? {}
          : { toolContextProvider: this.#toolContextProvider }),
      });
      const result =
        context.claimToken === undefined
          ? await runner.run(input.description)
          : await runner.run(input.description, {
              idempotencyKey: context.claimToken,
              claimToken: context.claimToken,
            });
      // 仅把最终结论作为工具结果回传，内部推理与工具历史留在子执行边界内。
      return toolSuccess(result.finalText);
    } catch (error) {
      if (error instanceof AgentLimitError) {
        return toolError(
          "subagent_turn_limit",
          `Subagent exceeded max_turns=${this.#maxTurns} without a final answer`,
        );
      }
      // task handler 是子执行边界；不向父模型泄露内部异常文本。
      return toolError("subagent_execution_error", "Subagent execution failed");
    }
  }
}

function isModelClient(value: unknown): value is ModelClient {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "complete") === "function"
  );
}
