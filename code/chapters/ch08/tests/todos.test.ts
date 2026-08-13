import { describe, expect, test } from "vitest";

import { toolCall } from "../src/core/messages.js";
import { ToolRegistry } from "../src/core/tools.js";
import type { ToolResult } from "../src/core/tools.js";
import {
  MAX_TODOS,
  TODO_STATUSES,
  TODO_STALE_REMINDER,
  TodoTracker,
} from "../src/features/todos.js";

const context = Object.freeze({ workspace: process.cwd(), identity: "tester" });

function registryFor(tracker: TodoTracker): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(tracker.toolDefinition);
  return tools;
}

async function invokeTodo(tracker: TodoTracker, argumentsJson: string): Promise<ToolResult> {
  const tools = registryFor(tracker);
  return tools.invoke(tools.prepare(toolCall("todo-call", "todo_write", argumentsJson)), context);
}

describe("todo tracker", () => {
  test("defines exactly three statuses and normalizes content", async () => {
    const tracker = new TodoTracker();

    const result = await invokeTodo(
      tracker,
      JSON.stringify({ todos: [{ content: "  编写测试  ", status: "pending" }] }),
    );

    expect(TODO_STATUSES).toEqual(["pending", "in_progress", "completed"]);
    expect(result.content).toBe(
      '{"todos":[{"content":"\\u7f16\\u5199\\u6d4b\\u8bd5","status":"pending"}]}',
    );
    expect(tracker.todos).toEqual([{ content: "编写测试", status: "pending" }]);
    expect(Object.isFrozen(tracker.todos)).toBe(true);
    expect(Object.isFrozen(tracker.todos[0])).toBe(true);
  });

  test("returns the complete stable ASCII snapshot and one-source schema", async () => {
    const tracker = new TodoTracker();
    const tools = registryFor(tracker);
    const prepared = tools.prepare(
      toolCall(
        "todo-call",
        "todo_write",
        JSON.stringify({
          todos: [
            { content: "  编写测试  ", status: "in_progress" },
            { content: "ship", status: "completed" },
          ],
        }),
      ),
    );

    const result = await tools.invoke(prepared, context);

    expect(result).toEqual({
      content:
        '{"todos":[{"content":"\\u7f16\\u5199\\u6d4b\\u8bd5","status":"in_progress"},{"content":"ship","status":"completed"}]}',
      isError: false,
    });
    expect(
      [...result.content].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint <= 0x7f;
      }),
    ).toBe(true);
    expect(tracker.todos).toEqual([
      { content: "编写测试", status: "in_progress" },
      { content: "ship", status: "completed" },
    ]);
    expect(tracker.toolDefinition).toMatchObject({ name: "todo_write", effect: "write" });

    const schema = tools.openAITools()[0]?.function.parameters;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: { type: "array", maxItems: MAX_TODOS },
      },
    });
  });

  test("accepts and returns exactly fifty todos", async () => {
    const tracker = new TodoTracker();
    const todos = Array.from({ length: MAX_TODOS }, (_, index) => ({
      content: `task-${index}`,
      status: "pending",
    }));

    const result = await invokeTodo(tracker, JSON.stringify({ todos }));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ todos });
    expect(tracker.todos.map((item) => item.content)).toEqual(
      Array.from({ length: MAX_TODOS }, (_, index) => `task-${index}`),
    );
  });

  test.each([
    ['{"todos":"not-an-array"}', "invalid_arguments"],
    ['{"todos":[{"content":" ","status":"pending"}]}', "invalid_arguments"],
    ['{"todos":[{"content":"kept","status":"unknown"}]}', "invalid_arguments"],
    ['{"todos":[{"content":"kept","status":"pending","extra":true}]}', "invalid_arguments"],
    [
      JSON.stringify({
        todos: Array.from({ length: MAX_TODOS + 1 }, (_, index) => ({
          content: `task-${index}`,
          status: "pending",
        })),
      }),
      "invalid_arguments",
    ],
    ["{", "invalid_json"],
  ])("invalid update preserves the previous snapshot: %s", async (argumentsJson, errorCode) => {
    const tracker = new TodoTracker();
    const initial = await invokeTodo(
      tracker,
      '{"todos":[{"content":"kept","status":"in_progress"}]}',
    );
    const before = tracker.todos;

    const result = await invokeTodo(tracker, argumentsJson);

    expect(result).toMatchObject({ isError: true, errorCode });
    expect(tracker.todos).toBe(before);
    expect(tracker.todos).toEqual([{ content: "kept", status: "in_progress" }]);
    expect(initial.content).toBe('{"todos":[{"content":"kept","status":"in_progress"}]}');
  });

  test("trackers isolate session state", async () => {
    const first = new TodoTracker();
    const second = new TodoTracker();

    await invokeTodo(first, '{"todos":[{"content":"first session","status":"pending"}]}');

    expect(first.todos).toEqual([{ content: "first session", status: "pending" }]);
    expect(second.todos).toEqual([]);
  });

  test("three non-TODO tool rounds emit one reminder and reset", () => {
    const tracker = new TodoTracker();

    tracker.recordToolRound(["read_file", "write_file"]);
    expect(tracker.beforeModel()).toEqual([]);
    tracker.recordToolRound(["read_file"]);
    expect(tracker.beforeModel()).toEqual([]);
    tracker.recordToolRound(["glob"]);

    expect(tracker.beforeModel()).toEqual([{ role: "system", content: TODO_STALE_REMINDER }]);
    expect(tracker.beforeModel()).toEqual([]);
  });

  test("todo_write resets the stale-round counter", async () => {
    const tracker = new TodoTracker();
    tracker.recordToolRound(["read_file"]);
    tracker.recordToolRound(["glob"]);

    const result = await invokeTodo(tracker, '{"todos":[]}');
    tracker.recordToolRound(["todo_write"]);

    expect(result).toEqual({ content: '{"todos":[]}', isError: false });
    tracker.recordToolRound(["read_file"]);
    tracker.recordToolRound(["glob"]);
    expect(tracker.beforeModel()).toEqual([]);
    tracker.recordToolRound(["read_file"]);
    expect(tracker.beforeModel()).toEqual([{ role: "system", content: TODO_STALE_REMINDER }]);
  });
});
