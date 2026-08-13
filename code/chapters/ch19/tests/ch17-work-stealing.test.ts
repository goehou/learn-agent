import { describe, expect, test } from "vitest";

import { toolCall } from "../src/core/messages.js";
import { ToolRegistry } from "../src/core/tools.js";
import { Task, TaskStatus } from "../src/features/tasks.js";
import type { CreateTaskInput } from "../src/features/tasks.js";
import {
  registerLeasedTaskTools,
  registerTeammateLeasedTaskTools,
  WorkStealingRuntime,
} from "../src/features/work-stealing.js";

describe("P17 work-stealing contracts", () => {
  test("uses one store and keeps the claim token in the completion schema", () => {
    const store = {
      createTask: async () => {
        throw new Error("not used");
      },
      getTask: async () => {
        throw new Error("not used");
      },
      listTasks: async () => [],
      claimTask: async () => {
        throw new Error("not used");
      },
      claimNext: async () => undefined,
      completeTask: async () => {
        throw new Error("not used");
      },
    };
    const runtime = new WorkStealingRuntime({ store });
    const lead = new ToolRegistry();
    registerLeasedTaskTools(lead, runtime.store, runtime.claimService);
    const teammate = new ToolRegistry();
    registerTeammateLeasedTaskTools(teammate, runtime.store, runtime.claimService);
    expect(lead.names).toEqual([
      "create_task",
      "get_task",
      "list_tasks",
      "claim_task",
      "complete_task",
    ]);
    expect(teammate.names).toEqual(["get_task", "list_tasks", "claim_task", "complete_task"]);
    const schema = lead.openAITools().find((tool) => tool.function.name === "complete_task");
    expect(schema?.function.parameters).toMatchObject({
      required: expect.arrayContaining(["task_id", "claim_token"]),
    });
  });

  test("maps create_task dependencies into the TaskStore contract", async () => {
    const dependencyId = "00000000-0000-0000-0000-000000000001";
    let receivedInput: CreateTaskInput | undefined;
    const store = {
      createTask: async (input: CreateTaskInput) => {
        receivedInput = input;
        return new Task({
          id: "00000000-0000-0000-0000-000000000002",
          subject: input.subject,
          description: input.description === undefined ? "" : input.description,
          status: TaskStatus.PENDING,
          owner: null,
          blockedBy: input.blockedBy === undefined ? [] : input.blockedBy,
        });
      },
      getTask: async () => {
        throw new Error("not used");
      },
      listTasks: async () => [],
      claimTask: async () => {
        throw new Error("not used");
      },
      claimNext: async () => undefined,
      completeTask: async () => {
        throw new Error("not used");
      },
    };
    const runtime = new WorkStealingRuntime({ store });
    const tools = new ToolRegistry();
    registerLeasedTaskTools(tools, runtime.store, runtime.claimService);

    const result = await tools.invoke(
      tools.prepare(
        toolCall(
          "create-task",
          "create_task",
          JSON.stringify({
            subject: "dependent task",
            description: "wait for prerequisite",
            blocked_by: [dependencyId],
          }),
        ),
      ),
      { workspace: process.cwd(), identity: "lead" },
    );

    expect(result).toMatchObject({ isError: false });
    expect(receivedInput).toEqual({
      subject: "dependent task",
      description: "wait for prerequisite",
      blockedBy: [dependencyId],
    });
  });
});
