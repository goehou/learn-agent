import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runProfile } from "../src/cli.js";
import { P12 } from "../src/core/profiles.js";

describe("chapter 12 fixed entry", () => {
  test("reports all four required OpenAI settings before constructing the TaskStore", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-tutorial-ch12-entry-"));
    const originalWorkspace = process.cwd();
    let stderr = "";
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      process.chdir(workspace);

      await expect(runProfile(P12, ["--prompt", "hello"])).resolves.toBe(2);
      expect(stderr).toContain("OPENAI_BASE_URL");
      expect(stderr).toContain("OPENAI_API_KEY");
      expect(stderr).toContain("OPENAI_MODEL");
      expect(stderr).toContain("OPENAI_FALLBACK_MODEL");
      expect(stderr).not.toContain("Task storage");
    } finally {
      process.chdir(originalWorkspace);
      write.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
