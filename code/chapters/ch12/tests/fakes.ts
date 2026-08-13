import type { CommandResult, CommandRunner } from "../src/core/commands.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import { validateToolPairing } from "../src/core/messages.js";

export class ScriptedModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #replies: ModelReply[];

  constructor(replies: readonly ModelReply[]) {
    this.#replies = [...replies];
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    const reply = this.#replies.shift();
    if (reply === undefined) {
      throw new Error("ScriptedModelClient received an unexpected request");
    }
    return reply;
  }

  assertExhausted(): void {
    if (this.#replies.length !== 0) {
      throw new Error(`ScriptedModelClient has ${this.#replies.length} unused replies`);
    }
  }
}

export class FakeCommandRunner implements CommandRunner {
  readonly calls: {
    readonly command: string;
    readonly cwd: string;
    readonly timeoutMs: number | undefined;
  }[] = [];
  readonly #result: CommandResult | Error;

  constructor(result: CommandResult | Error) {
    this.#result = result;
  }

  async run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult> {
    this.calls.push({ command, cwd, timeoutMs });
    if (this.#result instanceof Error) {
      throw this.#result;
    }
    return this.#result;
  }
}

export function commandResult(
  output: string,
  overrides: Partial<Omit<CommandResult, "output">> = {},
): CommandResult {
  return Object.freeze({
    output,
    exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
    timedOut: overrides.timedOut === undefined ? false : overrides.timedOut,
    truncated: overrides.truncated === undefined ? false : overrides.truncated,
  });
}
