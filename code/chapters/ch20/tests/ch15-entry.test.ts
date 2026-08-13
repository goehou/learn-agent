import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runProfile } from "../src/cli.js";
import { P15 } from "../src/core/profiles.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import { TeammateRuntime } from "../src/features/teammates.js";

vi.mock("../src/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bootstrap.js")>();
  return {
    ...actual,
    buildAgent: vi.fn(() => {
      throw new Error("bootstrap failed");
    }),
  };
});

describe("chapter 15 fixed entry", () => {
  test("reports all required OpenAI settings before creating teammate state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-entry-"));
    const original = process.cwd();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.chdir(root);
      await expect(runProfile(P15, ["--prompt", "hello"])).resolves.toBe(2);
      expect(write.mock.calls.flat().join("")).toContain("OPENAI_FALLBACK_MODEL");
    } finally {
      process.chdir(original);
      write.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("continues fallback cleanup after a teammate close failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch15-entry-"));
    const original = process.cwd();
    const teammateClose = vi
      .spyOn(TeammateRuntime.prototype, "close")
      .mockRejectedValueOnce(new Error("teammate close failed"));
    const cronClose = vi.spyOn(CronRuntime.prototype, "close").mockResolvedValue();
    const supervisorClose = vi.spyOn(JobSupervisor.prototype, "close").mockResolvedValue();
    try {
      process.chdir(root);
      await writeFile(
        join(root, ".env"),
        "OPENAI_BASE_URL=https://example.test/v1\nOPENAI_API_KEY=test-key\nOPENAI_MODEL=test-model\nOPENAI_FALLBACK_MODEL=test-fallback\n",
        "utf8",
      );

      await expect(runProfile(P15, ["--prompt", "hello"])).resolves.toBe(1);
      expect(cronClose).toHaveBeenCalledOnce();
      expect(supervisorClose).toHaveBeenCalledOnce();
    } finally {
      process.chdir(original);
      teammateClose.mockRestore();
      cronClose.mockRestore();
      supervisorClose.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
