import { describe, expect, test } from "bun:test";
import { isMousePrefix, splitMouseReports } from "../src/mouse.ts";

describe("splitMouseReports", () => {
  test("a single report parses and leaves no residue", () => {
    const { reports, rest } = splitMouseReports("[<64;10;5M");
    expect(reports).toEqual([{ btn: 64, x: 10, y: 5, press: true }]);
    expect(rest).toBe("");
  });

  test("coalesced wheel reports in one chunk (the scroll-leak bug)", () => {
    const { reports, rest } = splitMouseReports("[<65;16;20M[<65;16;20M[<65;16;20M");
    expect(reports).toHaveLength(3);
    expect(reports.every((r) => r.btn === 65 && r.press)).toBe(true);
    // Nothing is left to leak into the input.
    expect(rest).toBe("");
  });

  test("an interleaved ESC between coalesced reports is tolerated", () => {
    const { reports, rest } = splitMouseReports("[<65;1;1M\x1b[<65;1;1M");
    expect(reports).toHaveLength(2);
    expect(rest).toBe("");
  });

  test("release (m) parses as press:false", () => {
    const { reports } = splitMouseReports("[<0;3;4m");
    expect(reports[0]?.press).toBe(false);
  });

  test("a trailing half report is left in rest for the next chunk", () => {
    const { reports, rest } = splitMouseReports("[<65;1;1M[<65;1;");
    expect(reports).toHaveLength(1);
    expect(rest).toBe("[<65;1;");
    expect(isMousePrefix(rest)).toBe(true);
  });

  test("typed text is returned untouched", () => {
    const { reports, rest } = splitMouseReports("hello");
    expect(reports).toHaveLength(0);
    expect(rest).toBe("hello");
  });
});

describe("isMousePrefix", () => {
  test("recognises every growable partial", () => {
    for (const p of ["[", "[<", "[<65", "[<65;", "[<65;16", "[<65;16;", "[<65;16;20"]) {
      expect(isMousePrefix(p)).toBe(true);
    }
  });

  test("a complete report is not a prefix", () => {
    expect(isMousePrefix("[<65;16;20M")).toBe(false);
  });

  test("empty and plain text are not prefixes", () => {
    expect(isMousePrefix("")).toBe(false);
    expect(isMousePrefix("abc")).toBe(false);
    expect(isMousePrefix("[x")).toBe(false);
  });
});
