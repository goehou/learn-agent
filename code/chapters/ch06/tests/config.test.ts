import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ConfigurationError, settingsFromMapping } from "../src/config.js";
import { runCli } from "../src/cli.js";

describe("OpenAI settings", () => {
  test("the unified CLI exits with code 2 before network access when config is missing", async () => {
    // 真实 .env 与离线断言互斥：临时移走本机配置，断言后原样恢复。
    const envPath = join(process.cwd(), ".env");
    const originalEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : undefined;
    if (originalEnv !== undefined) {
      rmSync(envPath);
    }
    try {
      await expect(runCli(["run", "--chapter", "1", "--prompt", "test"])).resolves.toBe(2);
    } finally {
      if (originalEnv !== undefined) {
        writeFileSync(envPath, originalEnv, "utf8");
      }
    }
  });

  test("lists every missing required field before a client can be created", () => {
    try {
      settingsFromMapping({ OPENAI_API_KEY: " " });
      throw new Error("expected settingsFromMapping to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).missingFields).toEqual([
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
      ]);
    }
  });

  test.each(["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const)(
    "reports %s when that individual field is blank",
    (field) => {
      const values = {
        OPENAI_BASE_URL: "https://example.test/v1",
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "test-model",
        [field]: " ",
      };
      try {
        settingsFromMapping(values);
        throw new Error("expected settingsFromMapping to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as ConfigurationError).missingFields).toEqual([field]);
      }
    },
  );

  test("keeps explicit values and does not invent a fallback model", () => {
    expect(
      settingsFromMapping({
        OPENAI_BASE_URL: " https://example.test/v1 ",
        OPENAI_API_KEY: " test-key ",
        OPENAI_MODEL: " test-model ",
      }),
    ).toEqual({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
  });

  test("rejects a non-HTTP base URL before client construction", () => {
    expect(() =>
      settingsFromMapping({
        OPENAI_BASE_URL: "file:///tmp/model",
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "test-model",
      }),
    ).toThrow(ConfigurationError);
  });

  test("rejects a Chat Completions endpoint URL before client construction", () => {
    expect(() =>
      settingsFromMapping({
        OPENAI_BASE_URL: "https://example.test/v1/chat/completions/",
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "test-model",
      }),
    ).toThrow(ConfigurationError);
  });
});
