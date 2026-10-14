import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/markdown.ts";

describe("renderMarkdown", () => {
  test("returns a non-empty string preserving the words", () => {
    const out = renderMarkdown("**bold** and `code`");
    expect(typeof out).toBe("string");
    expect(out).toContain("bold");
    expect(out).toContain("code");
  });

  test("renders a fenced code block", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).toContain("const x = 1");
  });

  test("does not end with trailing newlines", () => {
    const out = renderMarkdown("hello");
    expect(out.endsWith("\n")).toBe(false);
  });
});
