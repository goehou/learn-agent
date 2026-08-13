import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runProfile } from "../src/cli.js";
import { P17 } from "../src/core/profiles.js";

describe("chapter 17 fixed entry", () => {
  test("reports missing real-run settings before creating SQLite state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-entry-"));
    const original = process.cwd();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.chdir(root);
      await expect(runProfile(P17, ["--prompt", "hello"])).resolves.toBe(2);
      expect(write.mock.calls.flat().join("")).toContain("OPENAI_FALLBACK_MODEL");
      await expect(readdir(join(root, ".agent_tutorial"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.chdir(original);
      write.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
