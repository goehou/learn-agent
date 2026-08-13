import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { OpenAIChatModel } from "../src/adapters/openai-chat.js";
import { runCli, runProfile } from "../src/cli.js";
import { P20, profileForChapter } from "../src/core/profiles.js";

async function expectMissingSettings(run: () => Promise<number>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch20-entry-"));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(run()).resolves.toBe(2);
    expect(write.mock.calls.flat().join("")).toContain("OPENAI_FALLBACK_MODEL");
    await expect(readdir(join(root, ".agent_tutorial"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    cwd.mockRestore();
    write.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

describe("chapter 20 profile", () => {
  test("exposes the full harness marker after all prior capabilities", () => {
    expect(profileForChapter(20)).toBe(P20);
    expect(P20.capabilities.has("full_harness")).toBe(true);
    expect(P20.capabilities.has("mcp")).toBe(true);
  });

  test("fixed entry rejects missing settings before creating state", async () => {
    await expectMissingSettings(() => runProfile(P20, ["--prompt", "hello"]));
  });

  test("unified entry resolves chapter 20 and rejects missing settings", async () => {
    await expectMissingSettings(() => runCli(["run", "--chapter", "20", "--prompt", "hello"]));
  });

  test("closes the model before rejecting a valid non-Git workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch20-entry-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const close = vi.spyOn(OpenAIChatModel.prototype, "close");
    try {
      await writeFile(
        join(root, ".env"),
        "OPENAI_BASE_URL=https://example.test/v1\nOPENAI_API_KEY=test-key\nOPENAI_MODEL=test-model\nOPENAI_FALLBACK_MODEL=test-fallback\n",
        "utf8",
      );

      await expect(runProfile(P20, ["--prompt", "hello"])).resolves.toBe(1);
      expect(close).toHaveBeenCalledOnce();
      await expect(readdir(join(root, ".agent_tutorial"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      cwd.mockRestore();
      close.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
