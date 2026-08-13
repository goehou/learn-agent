import { describe, expect, test } from "vitest";

import { nextCronOccurrence, validateCronExpression } from "../src/features/cron.js";

describe("chapter 14 cron expression", () => {
  test("supports five fields, steps, ranges and lists", () => {
    expect(
      nextCronOccurrence(
        "*/15 9-10 * * 1,3,5",
        "UTC",
        new Date("2026-06-01T09:00:00Z"),
      ).toISOString(),
    ).toBe("2026-06-01T09:15:00.000Z");
  });

  test("uses standard DOM/DOW OR semantics", () => {
    expect(
      nextCronOccurrence("0 9 1 * 1", "UTC", new Date("2026-06-02T00:00:00Z")).toISOString(),
    ).toBe("2026-06-08T09:00:00.000Z");
  });

  test("converts IANA local time to UTC and rejects invalid input", () => {
    expect(
      nextCronOccurrence(
        "0 9 * * *",
        "Asia/Shanghai",
        new Date("2026-06-01T00:30:00Z"),
      ).toISOString(),
    ).toBe("2026-06-01T01:00:00.000Z");
    expect(() => validateCronExpression("0 9 * *")).toThrow(/five fields/);
    expect(() =>
      nextCronOccurrence("0 9 * * *", "Mars/Olympus", new Date("2026-06-01T00:00:00Z")),
    ).toThrow(/timezone/);
  });

  test.each([
    "* * * *",
    "* * * * * *",
    "61 * * * *",
    "*/0 * * * *",
    "0 9 8-2 * *",
    "0 9 * 13 *",
    "0 9 * * 8",
  ])("rejects invalid five-field expression %s", (expression) => {
    expect(() => nextCronOccurrence(expression, "UTC", new Date("2026-06-01T00:00:00Z"))).toThrow();
  });

  test("applies the documented DST gap and fold strategy", () => {
    expect(
      nextCronOccurrence(
        "30 2 * * *",
        "America/New_York",
        new Date("2026-03-07T08:00:00Z"),
      ).toISOString(),
    ).toBe("2026-03-08T07:00:00.000Z");
    const first = nextCronOccurrence(
      "30 1 * * *",
      "America/New_York",
      new Date("2026-11-01T04:59:00Z"),
    );
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextCronOccurrence("30 1 * * *", "America/New_York", first).toISOString()).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });

  test("rejects an invalid clock Date", () => {
    expect(() => nextCronOccurrence("* * * * *", "UTC", new Date(Number.NaN))).toThrow(/valid UTC/);
  });
});
