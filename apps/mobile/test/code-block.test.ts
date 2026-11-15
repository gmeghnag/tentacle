/**
 * Owner B6 (2026-11-15): a code block never wraps — each source line stays one
 * line, and the block scrolls horizontally (the Conversation mockup). The line
 * split is `code-block.ts`'s; `CodeBlock.tsx` draws one non-wrapping `Text` per
 * line inside a horizontal `ScrollView` (pinned from the source below: the
 * `.tsx` cannot be imported by Bun).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeBlockView } from "../src/code-block.ts";

const text = (line: { readonly spans: readonly { readonly text: string }[] }): string =>
  line.spans.map((span) => span.text).join("");

describe("codeBlockView (B6)", () => {
  test("each source line is exactly one line, in order, never broken", () => {
    const long = `const message = "${"x".repeat(240)}";`;
    const source = `function f() {\n  ${long}\n  return 1;\n}`;
    const view = codeBlockView(source, "ts");
    expect(view.lines.map(text)).toEqual(source.split("\n"));
    expect(view.wrap).toBe(false);
  });

  test("a highlighted span that crosses a newline is split across the two lines, scope kept", () => {
    const source = "/* one\ntwo */ x";
    const view = codeBlockView(source, "js");
    expect(view.lines.map(text)).toEqual(["/* one", "two */ x"]);
    const crossed = view.lines[1]?.spans[0]?.scope ?? "missing";
    expect(crossed).not.toBe("plain");
    expect(view.lines[0]?.spans.at(-1)?.scope).toBe(crossed);
  });

  test("an empty line stays a line (drawn as one space, so it keeps its height)", () => {
    const view = codeBlockView("a\n\nb", null);
    expect(view.lines.map(text)).toEqual(["a", " ", "b"]);
  });

  test("a trailing newline adds no phantom last line", () => {
    expect(codeBlockView("a\nb\n", null).lines.map(text)).toEqual(["a", "b"]);
  });

  test("the header label is the fence language, or 'code' when there is none", () => {
    expect(codeBlockView("x", "TypeScript").label).toBe("typescript");
    expect(codeBlockView("x", null).label).toBe("code");
    expect(codeBlockView("x", "  ").label).toBe("code");
  });

  test("line keys are unique within a block", () => {
    const view = codeBlockView("a\na\na", null);
    expect(new Set(view.lines.map((line) => line.key)).size).toBe(3);
  });
});

describe("CodeBlock.tsx wiring (B6)", () => {
  const source = readFileSync(join(import.meta.dir, "../src/ui/CodeBlock.tsx"), "utf8");
  const markdown = readFileSync(
    join(import.meta.dir, "../src/screens/transcript/Markdown.tsx"),
    "utf8",
  );

  test("the lines sit in a HORIZONTAL ScrollView", () => {
    expect(source).toMatch(/<ScrollView[^>]*\bhorizontal\b/);
  });

  test("it draws codeBlockView's lines, one Text each, never wrapping (no flexShrink/flexWrap on a line)", () => {
    expect(source).toContain("codeBlockView(");
    expect(source).toMatch(/view\.lines\.map\(/);
    expect(source).not.toMatch(/flexShrink|flexWrap/);
  });

  test("Markdown routes every fenced block through CodeBlock", () => {
    expect(markdown).toMatch(/<CodeBlock\b/);
    expect(markdown).not.toContain("highlight(");
  });
});
