/**
 * `speakable.ts` — markdown text → what a voice actually says
 * (docs/feat/voice-conversation.md §3, C2 / T2). Lifted from
 * `feat/mobile-voice`'s `src/speakable.ts` (`clean`, `splitLong`) and extended to
 * the STREAMING case: a reply arrives as deltas, so the transform is a data fold
 * (`speakableFilter`) whose one-shot form is `speakableText`.
 *
 * Mutation target: emitting a fenced block's own text (i.e. "keeping fences")
 * must fail the `(code on screen)` blocks.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_UTTERANCE,
  clean,
  speakableFilter,
  speakableText,
  splitLong,
} from "../../src/voice/index.ts";

const en = (text: string) => speakableText(text, "en");
const it_ = (text: string) => speakableText(text, "it");

describe("T2: a code fence is a placeholder, never read", () => {
  test("the fence's own text is replaced in en", () => {
    expect(en("Look:\n\n```ts\nconst a = 1;\nsecretFunction();\n```\n")).toBe(
      "Look: (code on screen)",
    );
  });

  test("and in it", () => {
    expect(it_("Guarda:\n\n```\nx\n```")).toBe("Guarda: (codice a schermo)");
  });

  test("two fences are two placeholders; a tildes fence counts too", () => {
    expect(en("```js\na\n```\nmid\n~~~\nb\n~~~")).toBe("(code on screen) mid (code on screen)");
  });

  test("an unclosed fence still hides its body", () => {
    expect(en("text\n```\nsecret();")).toBe("text (code on screen)");
  });

  test("the fence's code never appears, at any delta split", () => {
    const text = "Before\n```ts\nconst DONOTSPEAK = 1;\n```\nAfter";
    for (let i = 1; i < text.length; i++) {
      let state = speakableFilter.init("en");
      const out: string[] = [];
      for (const delta of [text.slice(0, i), text.slice(i)]) {
        const step = speakableFilter.step(state, delta);
        state = step.state;
        out.push(step.text);
      }
      out.push(speakableFilter.flush(state).text);
      expect(out.join("")).not.toContain("DONOTSPEAK");
    }
  });
});

describe("T2: a table is a placeholder", () => {
  test("a pipe table is not read cell by cell", () => {
    expect(en("| a | b |\n|---|---|\n| 1 | 2 |\n")).toBe("(table on screen)");
    expect(it_("| a |\n|---|\n| 1 |\n")).toBe("(tabella a schermo)");
  });

  test("text around a table survives", () => {
    expect(en("before\n\n| a |\n|---|\n| 1 |\n\nafter")).toBe("before (table on screen) after");
  });
});

describe("T2: links keep their label", () => {
  test("a markdown link reads its label, never its href", () => {
    expect(en("See [the docs](https://example.com/very/long) please")).toBe("See the docs please");
  });

  test("a bare URL is read as 'link' / 'collegamento'", () => {
    expect(en("Go to https://example.com/x now")).toBe("Go to link now");
    expect(it_("Vai su https://example.com/x ora")).toBe("Vai su collegamento ora");
  });

  test("inline code and emphasis are kept as text", () => {
    expect(en("Run `bun test` **now**")).toBe("Run `bun test` now");
  });
});

describe("T2: control characters are stripped", () => {
  test("BEL/NUL/ESC sequences never reach the voice", () => {
    expect(en("done\u0007 ok\u0000")).toBe("done ok");
    // ANSI SGR (the TUI's own colour codes, if a reply ever carried them): the
    // ESC byte is what makes it a terminal command, and it is gone. The visible
    // parameter bytes stay as harmless text — their exact spacing is not a
    // contract, so the assertions are the property, not a spelling.
    const stripped = clean("\u001b[31mred\u001b[0m");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the assertion
    expect(/[\u0000-\u001F\u007F]/.test(stripped)).toBe(false);
    expect(stripped).toContain("red");
    expect(en("a\u001b[1mb")).not.toContain("\u001b");
  });

  test("whitespace is collapsed and trimmed", () => {
    expect(clean("  a \n\n  b  ")).toBe("a b");
    expect(en("")).toBe("");
  });
});

describe("T2: splitLong (lifted unchanged from mobile-voice)", () => {
  test("a text under the cap is one utterance", () => {
    expect(splitLong("short one", 100)).toEqual(["short one"]);
  });

  test("the cap is MAX_UTTERANCE by default", () => {
    expect(MAX_UTTERANCE).toBe(600);
  });

  test("over the cap: sentence boundaries first, then a space, never mid-word", () => {
    const sentence = `${"word ".repeat(50).trim()}.`;
    const text = Array.from({ length: 6 }, () => sentence).join(" ");
    const out = splitLong(text);
    expect(out.length).toBeGreaterThan(1);
    for (const u of out) expect(u.length).toBeLessThanOrEqual(MAX_UTTERANCE);
    expect(out.join(" ")).toBe(text);

    const long = splitLong("a ".repeat(700).trim(), 100);
    for (const u of long) expect(u.length).toBeLessThanOrEqual(100);
    expect(long.join(" ")).toBe("a ".repeat(700).trim());
  });
});

describe("T2: the fold is delta-split invariant", () => {
  test("char by char equals one shot, for a mixed reply", () => {
    const text = "# Title\n\nHello [there](https://x.y) 👋\n\n| a |\n|---|\n| 1 |\n\nDone 3.14.";
    const oneShot = en(text);
    const out: string[] = [];
    let state = speakableFilter.init("en");
    for (const ch of text) {
      const step = speakableFilter.step(state, ch);
      state = step.state;
      out.push(step.text);
    }
    out.push(speakableFilter.flush(state).text);
    expect(clean(out.join(""))).toBe(oneShot);
  });
});
