import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { describe, expect, test } from "vitest";

import { OpenAIChatModel } from "../src/adapters/openai-chat.js";
import type { OpenAIClientBoundary } from "../src/adapters/openai-chat.js";
import type { OpenAISettings } from "../src/config.js";
import { assistantMessage, systemMessage, toolCall, userMessage } from "../src/core/messages.js";

const settings: OpenAISettings = Object.freeze({
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  model: "primary-model",
});

function completion(overrides: Partial<ChatCompletion> = {}): ChatCompletion {
  return {
    id: "completion-1",
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        logprobs: null,
        message: { role: "assistant", content: "done", refusal: null },
      },
    ],
    created: 0,
    model: "test-model",
    object: "chat.completion",
    ...overrides,
  };
}

class FakeOpenAIClient implements OpenAIClientBoundary {
  readonly requests: ChatCompletionCreateParamsNonStreaming[] = [];
  readonly #response: ChatCompletion;
  readonly chat = {
    completions: {
      create: async (request: ChatCompletionCreateParamsNonStreaming) => {
        this.requests.push(request);
        return this.#response;
      },
    },
  };

  constructor(response: ChatCompletion) {
    this.#response = response;
  }
}

describe("OpenAI Chat Completions adapter", () => {
  test("maps the request and normalizes function tool calls", async () => {
    const client = new FakeOpenAIClient(
      completion({
        choices: [
          {
            finish_reason: "tool_calls",
            index: 0,
            logprobs: null,
            message: {
              role: "assistant",
              content: null,
              refusal: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "shell", arguments: '{"command":"pwd"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const model = new OpenAIChatModel(settings, client);
    const tool = {
      type: "function" as const,
      function: {
        name: "shell",
        description: "Run PowerShell.",
        parameters: { type: "object" },
      },
    };

    const reply = await model.complete({
      messages: [systemMessage("system"), userMessage("hello")],
      tools: [tool],
      maxTokens: 321,
    });

    expect(client.requests).toEqual([
      {
        model: "primary-model",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
        ],
        tools: [tool],
        max_completion_tokens: 321,
      },
    ]);
    expect(reply).toEqual({
      message: assistantMessage(null, [toolCall("call-1", "shell", '{"command":"pwd"}')]),
      finishReason: "tool_calls",
    });
  });

  test("preserves refusal text as assistant content", async () => {
    const client = new FakeOpenAIClient(
      completion({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            logprobs: null,
            message: { role: "assistant", content: null, refusal: "I cannot help." },
          },
        ],
      }),
    );

    await expect(
      new OpenAIChatModel(settings, client).complete({ messages: [userMessage("hi")], tools: [] }),
    ).resolves.toEqual({
      message: assistantMessage("I cannot help."),
      finishReason: "stop",
    });
    expect(client.requests[0]).not.toHaveProperty("tools");
  });

  test("rejects unpaired messages and invalid token limits before SDK use", async () => {
    const client = new FakeOpenAIClient(completion());
    const model = new OpenAIChatModel(settings, client);
    const pending = assistantMessage(null, [toolCall("call-1", "shell", "{}")]);

    await expect(model.complete({ messages: [pending], tools: [] })).rejects.toThrow(
      /missing tool results/,
    );
    await expect(
      model.complete({ messages: [userMessage("hi")], tools: [], maxTokens: 0 }),
    ).rejects.toThrow(/positive integer/);
    expect(client.requests).toEqual([]);
  });

  test("rejects an unknown provider finish reason at the adapter boundary", async () => {
    const response = completion();
    Object.defineProperty(response.choices[0], "finish_reason", { value: "future_reason" });
    const client = new FakeOpenAIClient(response);

    await expect(
      new OpenAIChatModel(settings, client).complete({ messages: [userMessage("hi")], tools: [] }),
    ).rejects.toThrow(/Unsupported finish_reason/);

    const legacyFinishReason = completion();
    Object.defineProperty(legacyFinishReason.choices[0], "finish_reason", {
      value: "function_call",
    });
    await expect(
      new OpenAIChatModel(settings, new FakeOpenAIClient(legacyFinishReason)).complete({
        messages: [userMessage("hi")],
        tools: [],
      }),
    ).rejects.toThrow(/Legacy function_call finish reason/);
  });

  test("rejects malformed role, legacy function_call, and usage values", async () => {
    const malformedRole = completion();
    Object.defineProperty(malformedRole.choices[0]?.message, "role", { value: "user" });
    await expect(
      new OpenAIChatModel(settings, new FakeOpenAIClient(malformedRole)).complete({
        messages: [userMessage("hi")],
        tools: [],
      }),
    ).rejects.toThrow(/role must be assistant/);

    const legacy = completion();
    Object.defineProperty(legacy.choices[0]?.message, "function_call", { value: { name: "old" } });
    Object.defineProperty(legacy.choices[0]?.message, "tool_calls", { value: [] });
    await expect(
      new OpenAIChatModel(settings, new FakeOpenAIClient(legacy)).complete({
        messages: [userMessage("hi")],
        tools: [],
      }),
    ).rejects.toThrow(/Legacy function_call/);

    const invalidUsage = completion();
    Object.defineProperty(invalidUsage, "usage", {
      value: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
    });
    await expect(
      new OpenAIChatModel(settings, new FakeOpenAIClient(invalidUsage)).complete({
        messages: [userMessage("hi")],
        tools: [],
      }),
    ).rejects.toThrow(/prompt_tokens/);
  });
});
