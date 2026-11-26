import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BADGES_END,
  BADGES_START,
  codeLines,
  measureCoverage,
  parseLcov,
  parseTestCount,
  renderBadges,
  withBadges,
} from "../coverage-badges.ts";

const LCOV = [
  "TN:",
  "SF:packages/a/src/one.ts",
  "FNF:2",
  "FNH:2",
  "LF:10",
  "LH:9",
  "end_of_record",
  "TN:",
  "SF:packages/a/test/support.ts",
  "LF:50",
  "LH:10",
  "end_of_record",
  "TN:",
  "SF:packages/a/src/one.ts",
  "LF:10",
  "LH:7",
  "end_of_record",
  "",
].join("\n");

describe("parseLcov", () => {
  test("one entry per file; a file reported twice keeps its best record", () => {
    const files = parseLcov(LCOV);
    expect(files.get("packages/a/src/one.ts")).toEqual({ found: 10, hit: 9 });
    expect(files.get("packages/a/test/support.ts")).toEqual({ found: 50, hit: 10 });
    expect(files.size).toBe(2);
  });

  test("empty input → no files", () => {
    expect(parseLcov("").size).toBe(0);
  });
});

describe("codeLines", () => {
  test("counts lines that are neither blank nor comments", () => {
    const text = [
      "/**",
      " * doc",
      " */",
      "",
      "// note",
      "export const a = 1;",
      "  return a; // trailing comment still code",
      "}",
    ].join("\n");
    expect(codeLines(text)).toBe(3);
  });
});

describe("measureCoverage", () => {
  test("only the source files count: a test helper's lines are left out", () => {
    const m = measureCoverage(parseLcov(LCOV), [{ path: "packages/a/src/one.ts", text: "x\n" }]);
    expect(m).toEqual({ covered: 9, total: 10, percent: 90 });
  });

  test("a source file no test loads counts as fully UNcovered, not left out", () => {
    // The honest number: bun reports only the files a test imported, so a
    // screen no test can load would otherwise vanish from the denominator.
    const m = measureCoverage(parseLcov(LCOV), [
      { path: "packages/a/src/one.ts", text: "x\n" },
      { path: "apps/m/src/Screen.tsx", text: "const a = 1;\nconst b = 2;\n\n// c\n" },
    ]);
    expect(m.covered).toBe(9);
    expect(m.total).toBe(12);
    expect(m.percent).toBe(75);
  });

  test("the percent is rounded DOWN (a badge never claims more than measured)", () => {
    const lcov = "SF:s.ts\nLF:1000\nLH:889\nend_of_record\n";
    expect(measureCoverage(parseLcov(lcov), [{ path: "s.ts", text: "" }]).percent).toBe(88);
  });

  test("no source lines at all is an error, not 100% or NaN", () => {
    expect(() => measureCoverage(new Map(), [])).toThrow(/no source lines/);
  });
});

describe("parseTestCount", () => {
  test("reads bun's summary line", () => {
    const output = " 20894 pass\n 5 skip\n 0 fail\n 289605 expect() calls\n";
    expect(parseTestCount(output)).toBe(20894);
  });

  test("a run with a failure is refused (the badge says passing)", () => {
    expect(() => parseTestCount(" 10 pass\n 1 fail\n")).toThrow(/1 test failed/);
  });

  test("no summary line is an error", () => {
    expect(() => parseTestCount("crashed\n")).toThrow(/no test summary/);
  });
});

describe("renderBadges", () => {
  test("two shields badges with the numbers in their text and alt", () => {
    const block = renderBadges({ percent: 88, tests: 20894 });
    expect(block).toContain('alt="coverage 88%"');
    expect(block).toContain("https://img.shields.io/badge/coverage-88%25-");
    expect(block).toContain('alt="tests: 20,894 passing"');
    expect(block).toContain("https://img.shields.io/badge/tests-20%2C894%20passing-");
  });
});

describe("withBadges", () => {
  const readme = `a\n${BADGES_START}\nold\n${BADGES_END}\nb\n`;

  test("replaces only the block between the markers", () => {
    expect(withBadges(readme, "NEW")).toBe(`a\n${BADGES_START}\nNEW\n${BADGES_END}\nb\n`);
  });

  test("idempotent: the same block twice gives the same text", () => {
    const once = withBadges(readme, "NEW");
    expect(withBadges(once, "NEW")).toBe(once);
  });

  test("a missing or misordered marker is an error, never a silent no-op", () => {
    expect(() => withBadges("a\n", "NEW")).toThrow(/marker/);
    expect(() => withBadges(`${BADGES_END}\n${BADGES_START}\n`, "NEW")).toThrow(/marker/);
  });
});

describe("the repo's README", () => {
  test("carries the badge markers exactly once each, in order", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8");
    expect(text.split(BADGES_START).length - 1).toBe(1);
    expect(text.split(BADGES_END).length - 1).toBe(1);
    expect(text.indexOf(BADGES_START)).toBeLessThan(text.indexOf(BADGES_END));
  });
});
