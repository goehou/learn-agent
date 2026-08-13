import { describe, expect, test } from "vitest";

import { P01, profileForChapter } from "../src/core/profiles.js";

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
    expect(() => profileForChapter(2)).toThrow(/not been migrated/);
  });
});
