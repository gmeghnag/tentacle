import { describe, expect, test } from "bun:test";
import { formatChars, formatDuration, formatDurationMs, formatTokens } from "../src/format.ts";

describe("formatTokens", () => {
  test("plain under 1000, then k, then M — never a long number", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1040)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9_999)).toBe("10k");
    expect(formatTokens(54_000)).toBe("54k");
    expect(formatTokens(999_499)).toBe("999k");
    expect(formatTokens(999_600)).toBe("1M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(12_345_678)).toBe("12M");
  });
});

// docs/feat/tui-spill-note.md Q3: one decimal, as the owner's `40.8k` example.
describe("formatChars", () => {
  test("plain under 1000, then one decimal in k / M with .0 dropped", () => {
    expect(formatChars(0)).toBe("0");
    expect(formatChars(999)).toBe("999");
    expect(formatChars(1000)).toBe("1k");
    expect(formatChars(1234)).toBe("1.2k");
    expect(formatChars(16_000)).toBe("16k");
    expect(formatChars(39_600)).toBe("39.6k");
    expect(formatChars(40_800)).toBe("40.8k");
    expect(formatChars(999_940)).toBe("999.9k");
    expect(formatChars(999_960)).toBe("1M"); // never "1000k"
    expect(formatChars(1_234_567)).toBe("1.2M");
    expect(formatChars(12_000_000)).toBe("12M");
  });
});

describe("formatDuration", () => {
  test("seconds under a minute, then `1m 50s`, then `1h 5m`", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(60)).toBe("1m 0s");
    expect(formatDuration(110)).toBe("1m 50s");
    expect(formatDuration(3599)).toBe("59m 59s");
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(3_900)).toBe("1h 5m");
  });

  test("a tool's duration keeps tenths under a minute", () => {
    expect(formatDurationMs(1_234)).toBe("1.2s");
    expect(formatDurationMs(59_900)).toBe("59.9s");
    expect(formatDurationMs(59_960)).toBe("1m 0s");
    expect(formatDurationMs(110_400)).toBe("1m 50s");
  });
});
