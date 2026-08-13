import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { APIError } from "openai";
import { describe, expect, test } from "vitest";

import { OpenAIChatModel } from "../src/adapters/openai-chat.js";
import type { OpenAIClientBoundary } from "../src/adapters/openai-chat.js";
import type { OpenAISettings } from "../src/config.js";
import { assistantMessage, systemMessage, toolCall, userMessage } from "../src/core/messages.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../src/core/model.js";

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

  test("normalizes only typed recovery errors from stable OpenAI status fields", async () => {
    const cases = [
      {
        error: new APIError(
          429,
          { error: { code: "rate_limited" } },
          undefined,
          new Headers({ "retry-after": "2", "x-request-id": "request-1" }),
        ),
        type: ModelRateLimitError,
        errorCode: "rate_limited",
        requestId: "request-1",
        retryAfter: "2",
      },
      {
        error: new APIError(
          529,
          { type: "overloaded" },
          undefined,
          new Headers({ "x-request-id": "request-2" }),
        ),
        type: ModelOverloadedError,
        errorCode: "overloaded",
        requestId: "request-2",
        retryAfter: undefined,
      },
      {
        error: new APIError(
          400,
          { code: "prompt_too_long" },
          undefined,
          new Headers({ "x-request-id": "request-3" }),
        ),
        type: ModelPromptTooLongError,
        errorCode: "prompt_too_long",
        requestId: "request-3",
        retryAfter: undefined,
      },
      ...["context_length_exceeded", "max_context_window", "prompt_is_too_long"].map(
        (errorCode) => ({
          error: new APIError(400, { code: errorCode }, undefined, new Headers()),
          type: ModelPromptTooLongError,
          errorCode,
          requestId: undefined,
          retryAfter: undefined,
        }),
      ),
    ];

    for (const item of cases) {
      const client: OpenAIClientBoundary = {
        chat: {
          completions: {
            async create() {
              throw item.error;
            },
          },
        },
      };
      try {
        await new OpenAIChatModel(settings, client).complete({
          messages: [userMessage("hi")],
          tools: [],
        });
        throw new Error("expected a typed model error");
      } catch (error) {
        expect(error).toBeInstanceOf(item.type);
        expect(error).toMatchObject({
          errorCode: item.errorCode,
          requestId: item.requestId,
          cause: item.error,
        });
        if (item.retryAfter !== undefined) {
          expect(error).toMatchObject({ retryAfter: item.retryAfter });
        }
      }
    }

    const unknown = Object.assign(new Error("unrelated failure"), {
      status: 429,
      headers: new Headers({ "retry-after": "2" }),
      error: { code: "rate_limited" },
    });
    const client: OpenAIClientBoundary = {
      chat: {
        completions: {
          async create() {
            throw unknown;
          },
        },
      },
    };
    await expect(
      new OpenAIChatModel(settings, client).complete({
        messages: [userMessage("hi")],
        tools: [],
      }),
    ).rejects.toBe(unknown);

    const unknown400 = new APIError(400, { code: "unknown_bad_request" }, undefined, new Headers());
    const unclassifiedClient: OpenAIClientBoundary = {
      chat: {
        completions: {
          async create() {
            throw unknown400;
          },
        },
      },
    };
    await expect(
      new OpenAIChatModel(settings, unclassifiedClient).complete({
        messages: [userMessage("hi")],
        tools: [],
      }),
    ).rejects.toBe(unknown400);
  });
});
