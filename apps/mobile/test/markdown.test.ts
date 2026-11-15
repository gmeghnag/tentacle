/**
 * Markdown for a phone row (12b "Tests"): fenced code with/without a lang,
 * nested lists, links AS DATA (a `link` token carries its `href`; nothing here
 * opens it), and the size bound (a row over `PARSE_MAX_CHARS` is not parsed).
 */
import { describe, expect, test } from "bun:test";
import {
  type MdBlock,
  PARSE_MAX_CHARS,
  boundText,
  createParseCache,
  parse,
  plainText,
} from "../src/markdown.ts";

function blocksOf(text: string): readonly MdBlock[] {
  const parsed = parse(text);
  if (parsed.kind !== "blocks") {
    throw new Error("expected blocks");
  }
  return parsed.blocks;
}

describe("fenced code", () => {
  test("with a language", () => {
    const [code] = blocksOf("```ts\nconst x = 1;\n```\n");
    expect(code).toEqual({ kind: "code", lang: "ts", text: "const x = 1;" });
  });

  test("without a language", () => {
    const [code] = blocksOf("```\nplain text\n```\n");
    expect(code).toEqual({ kind: "code", lang: null, text: "plain text" });
  });

  test("an empty fence tag is null, not an empty string", () => {
    const [code] = blocksOf("```   \nx\n```\n");
    expect(code?.kind === "code" && code.lang).toBe(null);
  });
});

describe("lists", () => {
  test("nested items keep their structure (a flat list would lose the nesting)", () => {
    const [list] = blocksOf("- a\n  - b\n  - c\n- d\n");
    expect(list?.kind).toBe("list");
    if (list?.kind !== "list") {
      throw new Error("expected a list");
    }
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    // The first item is "a" plus a nested list of two.
    expect(list.items[0]?.map((block) => block.kind)).toEqual(["paragraph", "list"]);
    const nested = list.items[0]?.[1];
    if (nested?.kind !== "list") {
      throw new Error("expected a nested list");
    }
    expect(nested.items).toHaveLength(2);
  });

  test("an ordered list keeps its start number", () => {
    const [list] = blocksOf("3. three\n4. four\n");
    expect(list?.kind === "list" && list.ordered).toBe(true);
    expect(list?.kind === "list" && list.start).toBe(3);
  });
});

describe("links are data", () => {
  test("a link token carries its href and its text, and nothing is fetched", () => {
    const [paragraph] = blocksOf("see [the docs](https://example.com/x)\n");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    const link = paragraph.children.find((item) => item.kind === "link");
    expect(link).toEqual({
      kind: "link",
      href: "https://example.com/x",
      children: [{ kind: "text", text: "the docs" }],
    });
  });

  test("a javascript: href is data too (the screen confirms before anything opens)", () => {
    const [paragraph] = blocksOf("[click](javascript:alert(1))\n");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    const link = paragraph.children.find((item) => item.kind === "link");
    expect(link?.kind === "link" && link.href).toBe("javascript:alert(1)");
  });

  test("an image is its alt text, never a URL to fetch", () => {
    const [paragraph] = blocksOf("![a picture](https://example.com/x.png)\n");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    expect(paragraph.children).toEqual([{ kind: "text", text: "a picture" }]);
  });

  test("raw HTML is a literal, never markup", () => {
    const blocks = blocksOf("<script>alert(1)</script>\n");
    expect(blocks).toEqual([{ kind: "literal", text: "<script>alert(1)</script>\n" }]);
  });
});

describe("inline emphasis and code", () => {
  test("strong/em/del/codespan", () => {
    const [paragraph] = blocksOf("**b** *i* ~~s~~ `c`\n");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    const kinds = paragraph.children.map((item) => item.kind);
    expect(kinds).toEqual(["strong", "text", "em", "text", "del", "text", "code"]);
  });
});

describe("the size bound (plan F21)", () => {
  test("a row at the cap is parsed", () => {
    const text = "word ".repeat(Math.floor(PARSE_MAX_CHARS / 5) - 1);
    expect(parse(text).kind).toBe("blocks");
  });

  test("a row over the cap is NOT parsed: shown up to a line, the rest counted", () => {
    const text = `${"a\n".repeat(PARSE_MAX_CHARS)}\nTAIL`;
    const parsed = parse(text);
    expect(parsed.kind).toBe("chunked");
    if (parsed.kind !== "chunked") {
      throw new Error("expected chunked");
    }
    expect(parsed.shown.length).toBeLessThanOrEqual(PARSE_MAX_CHARS);
    expect(parsed.shown.endsWith("a")).toBe(true); // cut at a line boundary, not mid-word
    expect(parsed.hidden).toBe(text.length - parsed.shown.length);
    expect(parsed.hidden).toBeGreaterThan(0);
  });

  test("a 1 MB message is bounded in reasonable time", () => {
    const huge = "paragraph text ".repeat(80_000);
    const started = performance.now();
    const parsed = boundText(huge);
    expect(parsed.kind).toBe("chunked");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

test("plainText flattens every block (an accessibility label)", () => {
  expect(plainText(parse("# h\n\npara **b**\n\n- one\n- two\n"))).toBe("h\npara b\none\ntwo");
});

describe("the parse cache", () => {
  test("re-parses only when the version changed", () => {
    const cache = createParseCache();
    let parses = 0;
    const text = (): string => {
      parses += 1;
      return "**x**";
    };
    cache.get("r1", 1, text);
    cache.get("r1", 1, text);
    expect(parses).toBe(1);
    cache.get("r1", 2, text);
    expect(parses).toBe(2);
  });

  test("retain drops the keys a replaced transcript no longer has", () => {
    const cache = createParseCache();
    cache.get("r1", 1, () => "a");
    cache.get("r2", 1, () => "b");
    cache.retain(new Set(["r2"]));
    expect(cache.size).toBe(1);
  });

  test("it is bounded (an endless stream cannot leak rows)", () => {
    const cache = createParseCache(3);
    for (let i = 0; i < 10; i += 1) {
      cache.get(`r${i}`, 1, () => "x");
    }
    expect(cache.size).toBe(3);
  });
});

describe("entities (B3: marked@12's lexer HTML-escapes inline text)", () => {
  const one = (text: string): string => plainText(parse(text));

  test("prose shows the characters, not their entities", () => {
    expect(one(`It's "x" & <y>`)).toBe(`It's "x" & <y>`);
  });

  test("a code span shows the characters", () => {
    const [para] = blocksOf("Use `a < b && c` here.");
    expect(para).toEqual({
      kind: "paragraph",
      children: [
        { kind: "text", text: "Use " },
        { kind: "code", text: "a < b && c" },
        { kind: "text", text: " here." },
      ],
    });
  });

  test("a table cell shows the characters", () => {
    const [table] = blocksOf("| a | b |\n|---|---|\n| x's | 1 |");
    expect(table).toEqual({ kind: "table", header: ["a", "b"], rows: [["x's", "1"]] });
  });

  test("a literal `&amp;` in the source decodes to `&`, as any renderer shows it", () => {
    expect(one("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });

  test("`&amp;` is decoded last: `&amp;lt;` is the text `&lt;`, not `<`", () => {
    expect(one("a &amp;lt; b")).toBe("a &lt; b");
  });

  test("link text and image alt text are decoded too", () => {
    expect(one(`[it's](https://x.test) ![a "b"](https://x.test/i.png)`)).toBe(`it's a "b"`);
  });
});
