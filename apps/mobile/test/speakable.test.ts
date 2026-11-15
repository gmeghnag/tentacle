/**
 * `speakable.ts` — a reply as utterances (docs/feat/mobile-voice.md Design §3,
 * Tests). Mutation target: speaking `block.text` for a code block must fail the
 * "N lines" tests.
 */
import { describe, expect, test } from "bun:test";
import { boundText, parse } from "../src/markdown.ts";
import { MAX_UTTERANCE, speakable, splitLong } from "../src/speakable.ts";

const en = (md: string) => speakable(parse(md), "en");
const it_ = (md: string) => speakable(parse(md), "it");

describe("code blocks are summarised, never read", () => {
  test("N lines, with the language", () => {
    expect(en("Look:\n\n```ts\nconst a = 1;\nconst b = 2;\nfoo();\n```\n")).toEqual([
      "Look:",
      "code block, 3 lines, ts",
    ]);
  });

  test("one line is singular; no language → no suffix", () => {
    expect(en("```\nls -la\n```")).toEqual(["code block, 1 line"]);
  });

  test("Italian wording, singular and plural", () => {
    expect(it_("```\nx\n```")).toEqual(["blocco di codice, 1 riga"]);
    expect(it_("```py\na\nb\n```")).toEqual(["blocco di codice, 2 righe, py"]);
  });

  test("the code's own text is never spoken", () => {
    const out = en("```js\nsecretFunction();\n```").join(" ");
    expect(out).not.toContain("secretFunction");
  });
});

describe("inline content", () => {
  test("inline code is kept as is", () => {
    expect(en("Run `bun_test/run.ts` now")).toEqual(["Run bun_test/run.ts now"]);
  });

  test("a link keeps its text, never the href", () => {
    const out = en("See [the docs](https://example.com/very/long) please");
    expect(out).toEqual(["See the docs please"]);
  });

  test("a bare URL is read as 'link' / 'collegamento'", () => {
    expect(en("Go to https://example.com/x now")).toEqual(["Go to link now"]);
    expect(it_("Vai su https://example.com/x ora")).toEqual(["Vai su collegamento ora"]);
  });

  test("emphasis is flattened to its text", () => {
    expect(en("This is **very** _important_")).toEqual(["This is very important"]);
  });
});

describe("blocks", () => {
  test("headings end with a period so the voice pauses", () => {
    expect(en("# Summary\n\nAll good.")).toEqual(["Summary.", "All good."]);
    expect(en("## Done?")).toEqual(["Done?"]);
  });

  test("a table is summarised by its row count", () => {
    expect(en("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n")).toEqual(["table, 2 rows"]);
    expect(it_("| a |\n|---|\n| 1 |\n")).toEqual(["tabella, 1 riga"]);
  });

  test("list items are one utterance each; ordered lists say their number", () => {
    expect(en("- one\n- two\n")).toEqual(["one", "two"]);
    expect(en("1. first\n2. second\n")).toEqual(["1. first", "2. second"]);
  });

  test("a nested list keeps document order", () => {
    expect(en("- outer\n  - inner a\n  - inner b\n- last\n")).toEqual([
      "outer",
      "inner a",
      "inner b",
      "last",
    ]);
  });

  test("quote children are spoken; a rule is skipped", () => {
    expect(en("> quoted line\n\n---\n\nafter")).toEqual(["quoted line", "after"]);
  });

  test("literal HTML is spoken with its tags removed", () => {
    expect(en("<div>hello <b>there</b></div>")).toEqual(["hello there"]);
  });
});

describe("cleaning and limits", () => {
  test("emoji and box-drawing characters are stripped, whitespace collapsed", () => {
    expect(en("Done 🎉🚀 ok ✅")).toEqual(["Done ok"]);
    expect(en("├── src\n└── test")).toEqual(["src test"]);
  });

  test("an utterance over the cap is split at a sentence boundary", () => {
    const sentence = `${"word ".repeat(50).trim()}.`;
    const text = Array.from({ length: 6 }, () => sentence).join(" ");
    const out = en(text);
    expect(out.length).toBeGreaterThan(1);
    for (const u of out) {
      expect(u.length).toBeLessThanOrEqual(MAX_UTTERANCE);
      expect(u.endsWith(".")).toBe(true);
    }
    expect(out.join(" ")).toBe(text);
  });

  test("one sentence longer than the cap is cut at a space", () => {
    const out = splitLong("a ".repeat(700).trim(), 100);
    for (const u of out) {
      expect(u.length).toBeLessThanOrEqual(100);
    }
    expect(out.join(" ")).toBe("a ".repeat(700).trim());
  });

  test("a chunked row reads its shown text, then 'message truncated'", () => {
    const parsed = boundText("first para\n\nsecond https://x.y/z\nmore", 34);
    expect(parsed.kind).toBe("chunked");
    expect(speakable(parsed, "en")).toEqual(["first para", "second link", "message truncated"]);
    expect(speakable(parsed, "it").at(-1)).toBe("messaggio troncato");
  });

  test("empty input yields no utterances", () => {
    expect(en("")).toEqual([]);
    expect(en("   \n\n")).toEqual([]);
    expect(en("---")).toEqual([]);
    expect(en("🎉")).toEqual([]);
  });
});
