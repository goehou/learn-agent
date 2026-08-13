import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runProfile } from "../src/cli.js";
import { P13 } from "../src/core/profiles.js";

describe("chapter 13 fixed entry", () => {
  test("reports all required OpenAI settings before creating background state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch13-entry-"));
    const original = process.cwd();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.chdir(root);
      await expect(runProfile(P13, ["--prompt", "hello"])).resolves.toBe(2);
      expect(write.mock.calls.flat().join("")).toContain("OPENAI_FALLBACK_MODEL");
    } finally {
      process.chdir(original);
      write.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
