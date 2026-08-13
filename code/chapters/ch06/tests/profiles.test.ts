import { describe, expect, test } from "vitest";

import { P01, P02, P03, P04, P05, P06, profileForChapter } from "../src/core/profiles.js";

describe("chapter profiles", () => {
  test("P01 exposes exactly its fixed capabilities", () => {
    expect([...P01.capabilities]).toEqual(["loop", "powershell"]);
    expect(P01.capabilities.has("loop")).toBe(true);
    expect(P01.capabilities.has("powershell")).toBe(true);
    const capabilities: ReadonlySet<string> = P01.capabilities;
    expect(capabilities.has("policy")).toBe(false);
  });

  test("the capability collection has no mutation API and profile lookup is fixed", () => {
    expect("add" in P01.capabilities).toBe(false);
    expect(profileForChapter(1)).toBe(P01);
    expect(profileForChapter(2)).toBe(P02);
    expect([...P02.capabilities]).toEqual(["loop", "powershell", "tool_registry", "files"]);
    expect(profileForChapter(3)).toBe(P03);
    expect([...P03.capabilities]).toEqual([
      "loop",
      "powershell",
      "tool_registry",
      "files",
      "policy",
    ]);
    expect(profileForChapter(4)).toBe(P04);
    expect([...P04.capabilities]).toEqual([
      "loop",
      "powershell",
      "tool_registry",
      "files",
      "policy",
      "hooks",
    ]);
    expect(profileForChapter(5)).toBe(P05);
    expect([...P05.capabilities]).toEqual([
      "loop",
      "powershell",
      "tool_registry",
      "files",
      "policy",
      "hooks",
      "todo",
    ]);
    expect(profileForChapter(6)).toBe(P06);
    expect([...P06.capabilities]).toEqual([
      "loop",
      "powershell",
      "tool_registry",
      "files",
      "policy",
      "hooks",
      "todo",
      "subagent",
    ]);
    expect(() => profileForChapter(7)).toThrow(/not been migrated/);
  });
});
