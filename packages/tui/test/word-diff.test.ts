import { describe, expect, test } from "bun:test";
import { changeRatio, diffWords, tokenize } from "../src/word-diff.ts";

const plain = (kind: "same" | "add" | "remove", s: string): { kind: string; value: string } => ({
  kind,
  value: s,
});

describe("tokenize", () => {
  test("splits into word, whitespace, and punctuation tokens", () => {
    expect(tokenize("a = b;")).toEqual(["a", " ", "=", " ", "b", ";"]);
  });
});

describe("diffWords", () => {
  test("marks only the changed word, keeping the common prefix/suffix", () => {
    const ops = diffWords("const oldName = 1", "const newName = 1");
    // Unchanged "const " and " = 1" stay `same`; only the identifier differs.
    expect(ops).toContainEqual(plain("same", "const "));
    expect(ops).toContainEqual(plain("remove", "oldName"));
    expect(ops).toContainEqual(plain("add", "newName"));
    expect(ops).toContainEqual(plain("same", " = 1"));
  });

  test("reconstructs both sides exactly", () => {
    const before = "return foo(bar, baz)";
    const after = "return foo(qux, baz)";
    const ops = diffWords(before, after);
    const left = ops
      .filter((o) => o.kind !== "add")
      .map((o) => o.value)
      .join("");
    const right = ops
      .filter((o) => o.kind !== "remove")
      .map((o) => o.value)
      .join("");
    expect(left).toBe(before);
    expect(right).toBe(after);
  });

  test("merges adjacent ops of the same kind", () => {
    const ops = diffWords("ab", "cd");
    // No common tokens: one remove run, one add run (not four single-char ops).
    expect(ops.filter((o) => o.kind === "remove")).toHaveLength(1);
    expect(ops.filter((o) => o.kind === "add")).toHaveLength(1);
  });

  test("identical strings are all `same`", () => {
    const ops = diffWords("same line", "same line");
    expect(ops.every((o) => o.kind === "same")).toBe(true);
  });
});

describe("changeRatio", () => {
  test("0 for identical, 1 for fully different", () => {
    expect(changeRatio(diffWords("abc", "abc"))).toBe(0);
    expect(changeRatio(diffWords("abc", "xyz"))).toBe(1);
  });

  test("a one-word change in a longer line is a small ratio", () => {
    expect(
      changeRatio(diffWords("the quick brown fox jumps", "the quick red fox jumps")),
    ).toBeLessThan(0.4);
  });
});
