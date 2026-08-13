import { describe, expect, test } from "vitest";

import {
  assistantMessage,
  MessageContractError,
  toolCall,
  toolMessage,
  userMessage,
  validateToolPairing,
} from "../src/core/messages.js";

describe("message contract", () => {
  test("accepts a complete multi-call assistant/tool group in any result order", () => {
    const messages = [
      userMessage("go"),
      assistantMessage(null, [toolCall("a", "one", "{}"), toolCall("b", "two", "{}")]),
      toolMessage("B", "b"),
      toolMessage("A", "a"),
    ];

    expect(() => validateToolPairing(messages)).not.toThrow();
  });

  test("rejects duplicate call IDs and orphan results", () => {
    expect(() =>
      assistantMessage(null, [toolCall("same", "one", "{}"), toolCall("same", "two", "{}")]),
    ).toThrow(MessageContractError);
    expect(() => validateToolPairing([toolMessage("orphan", "missing")])).toThrow(
      /orphan tool result/,
    );
  });

  test("rejects incomplete result groups", () => {
    expect(() =>
      validateToolPairing([
        assistantMessage(null, [toolCall("a", "one", "{}"), toolCall("b", "two", "{}")]),
        toolMessage("A", "a"),
      ]),
    ).toThrow(/missing tool results/);
  });
});
