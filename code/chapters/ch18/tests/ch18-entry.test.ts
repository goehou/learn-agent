import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { OpenAIChatModel } from "../src/adapters/openai-chat.js";
import { runCli, runProfile } from "../src/cli.js";
import { P18 } from "../src/core/profiles.js";

describe("chapter 18 fixed entry", () => {
  test("reports missing real-run settings before Git or SQLite state is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-entry-"));
    const original = process.cwd();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.chdir(root);
      await expect(runProfile(P18, ["--prompt", "hello"])).resolves.toBe(2);
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

  test("closes the model when valid configuration reaches a non-Git workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-entry-"));
    const original = process.cwd();
    const close = vi.spyOn(OpenAIChatModel.prototype, "close");
    try {
      process.chdir(root);
      await writeFile(
        join(root, ".env"),
        "OPENAI_BASE_URL=https://example.test/v1\nOPENAI_API_KEY=test-key\nOPENAI_MODEL=test-model\nOPENAI_FALLBACK_MODEL=test-fallback\n",
        "utf8",
      );

      await expect(runCli(["run", "--chapter", "18", "--prompt", "hello"])).resolves.toBe(1);
      expect(close).toHaveBeenCalledOnce();
      await expect(readdir(join(root, ".agent_tutorial"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.chdir(original);
      close.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
