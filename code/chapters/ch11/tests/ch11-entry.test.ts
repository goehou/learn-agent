import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runProfile } from "../src/cli.js";
import { P11 } from "../src/core/profiles.js";

describe("chapter 11 fixed entry", () => {
  test("reports all four required OpenAI settings before constructing a live client", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch11-entry-"));
    const originalWorkspace = process.cwd();
    let stderr = "";
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      process.chdir(workspace);

      await expect(runProfile(P11, ["--prompt", "hello"])).resolves.toBe(2);
      expect(stderr).toContain("OPENAI_BASE_URL");
      expect(stderr).toContain("OPENAI_API_KEY");
      expect(stderr).toContain("OPENAI_MODEL");
      expect(stderr).toContain("OPENAI_FALLBACK_MODEL");
    } finally {
      process.chdir(originalWorkspace);
      write.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
