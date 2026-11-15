/**
 * Flow `24-ui-shots`'s seed (Slice 6): the mock model's `SHOWCASE` answer, read
 * through the app's OWN parser — so the flow's `code-2` id is the code block, and
 * the screenshot really shows every shape it claims to (chip and run inline code,
 * B7's characters in a highlighted block, a table, a list).
 */
import { describe, expect, test } from "bun:test";
import { SHOWCASE_MD } from "../e2e/mock-model.ts";
import { codeBlockView, inlineCodeLook } from "../src/code-block.ts";
import { type MdBlock, type MdInline, parse } from "../src/markdown.ts";

const parsed = parse(SHOWCASE_MD.join(""));
const blocks: readonly MdBlock[] = parsed.kind === "blocks" ? parsed.blocks : [];

function codeSpans(list: readonly MdBlock[]): string[] {
  const out: string[] = [];
  const walk = (items: readonly MdInline[]) => {
    for (const item of items) {
      if (item.kind === "code") {
        out.push(item.text);
      } else if ("children" in item) {
        walk(item.children);
      }
    }
  };
  for (const block of list) {
    if (block.kind === "paragraph") {
      walk(block.children);
    }
  }
  return out;
}

describe("the SHOWCASE answer (flow 24's seed)", () => {
  test("its blocks, in order: the flow's `code-2` is the fenced block", () => {
    expect(blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
      "code",
      "table",
      "list",
    ]);
  });

  test("it has inline code of both looks: a chip and a run", () => {
    const looks = new Set(codeSpans(blocks).map(inlineCodeLook));
    expect(looks).toEqual(new Set(["chip", "run"]));
  });

  test("its highlighted block shows quotes, <, > and & as themselves (B7)", () => {
    const code = blocks[2];
    expect(code?.kind).toBe("code");
    if (code?.kind !== "code") {
      return;
    }
    const lines = codeBlockView(code.text, code.lang).lines.map((line) =>
      line.spans.map((span) => span.text).join(""),
    );
    expect(lines).toContain(`print(f"{'EXT':<12}{'FILES':>8}")  # a < b && c > d`);
    expect(lines.join("\n")).not.toMatch(/&#x27;|&quot;|&lt;|&gt;|&amp;/);
  });
});
