/**
 * Code highlighting (12b "Tests"): a known language highlights, an UNKNOWN one
 * is plain monospace.
 *
 * The unknown-language case is the one Step 0 changed the design for: the
 * simulator probe found `highlight()` THROWS on an unknown language
 * (`Unknown language: "nosuch"`), so the gate is `languageOf` + `getLanguage`
 * before any parse. A `try`/`catch` around `highlight()` would also "work", but
 * would run a parse it cannot finish and swallow the reason.
 */
import { describe, expect, test } from "bun:test";
import {
  HIGHLIGHT_MAX_CHARS,
  highlight,
  languageOf,
  spansOf,
  unescapeHtml,
} from "../src/highlight.ts";

describe("a known language", () => {
  test("highlights into scoped spans", () => {
    const result = highlight("const x = 1;", "ts");
    expect(result.language).toBe("typescript");
    const scopes = result.spans.map((span) => span.scope);
    expect(scopes).toContain("keyword");
    // The text is rebuilt exactly: a highlight must never lose a character.
    expect(result.spans.map((span) => span.text).join("")).toBe("const x = 1;");
  });

  test("an alias resolves to its grammar", () => {
    expect(languageOf("tsx")).toBe("typescript");
    expect(languageOf("SH")).toBe("bash");
    expect(languageOf(" zsh ")).toBe("bash");
    expect(highlight("x", "js").language).toBe("javascript");
  });

  test("no language is plain, not an error", () => {
    expect(highlight("x", null)).toEqual({
      language: null,
      spans: [{ text: "x", scope: "plain" }],
    });
    expect(highlight("x", "")).toEqual({ language: null, spans: [{ text: "x", scope: "plain" }] });
  });
});

describe("an unknown language is plain monospace", () => {
  test("a lang this build does not register", () => {
    const result = highlight("some code", "nosuchlang");
    expect(result.language).toBe(null);
    expect(result.spans).toEqual([{ text: "some code", scope: "plain" }]);
  });

  test("it does NOT throw (highlight() itself would: Step 0)", () => {
    expect(() => highlight("x", "nosuchlang")).not.toThrow();
  });

  test("a language whose name collides with no grammar", () => {
    expect(languageOf("brainfuck")).toBe(null);
  });
});

describe("bounds", () => {
  test("a block over the cap stays plain", () => {
    const big = "x".repeat(HIGHLIGHT_MAX_CHARS + 1);
    expect(highlight(big, "ts").language).toBe(null);
  });

  test("an empty block is plain", () => {
    expect(highlight("", "ts")).toEqual({ language: null, spans: [{ text: "", scope: "plain" }] });
  });
});

describe("the HTML → spans walker", () => {
  test("a nested scope keeps the innermost", () => {
    expect(spansOf('<span class="hljs-string">a<span class="hljs-subst">b</span>c</span>')).toEqual(
      [
        { text: "a", scope: "string" },
        { text: "b", scope: "subst" },
        { text: "c", scope: "string" },
      ],
    );
  });

  test("entities are unescaped, adjacent same-scope text is merged", () => {
    expect(spansOf('<span class="hljs-string">&quot;a&amp;b&quot;</span>')).toEqual([
      { text: '"a&b"', scope: "string" },
    ]);
    expect(spansOf('a<span class="hljs-number">1</span>b')).toEqual([
      { text: "a", scope: "plain" },
      { text: "1", scope: "number" },
      { text: "b", scope: "plain" },
    ]);
  });

  test("a truncated document keeps what was read", () => {
    expect(spansOf('<span class="hljs-keyword">con')).toEqual([{ text: "con", scope: "keyword" }]);
  });

  test("unescapeHtml handles the four entities highlight.js emits", () => {
    expect(unescapeHtml("&lt;a&gt; &quot;b&quot; &amp;")).toBe('<a> "b" &');
  });
});

/**
 * `subLanguage` (the `xml` grammar's `<script>`/`<style>`) does not wrap its
 * inner tokens in `hljs-*`: highlight.js emits a bare
 * `<span class="language-css">` / `<span class="language-javascript">` and puts
 * ordinary `hljs-*` spans INSIDE it (highlight.js 11.12,
 * `lib/languages/xml.js:164,177`). The walker only knew `class="hljs-`, so that
 * wrapper used to be printed as literal TEXT — the page showed
 * `<span class="language-css">` where the colour should start.
 */
describe("a sub-language wrapper is transparent, never text", () => {
  test("an html <style> body is coloured, and no marker text is emitted", () => {
    const html = "<style>\n:root { color: red; }\n</style>";
    const spans = highlight(html, "html").spans;
    // The property that kills the bug: no wrapper markup survives into the text.
    expect(spans.map((span) => span.text).join("")).toBe(html);
    // …and the CSS inside really was tokenized by the sub-language (a rule's
    // selector and property are css's scopes, which the xml grammar has none of).
    expect(spans.map((span) => span.scope)).toContain("attribute");
    expect(spans.map((span) => span.scope)).toContain("selector-pseudo");
  });

  test("a direct walk: the wrapper's own class is not a scope and not text", () => {
    expect(
      spansOf('<span class="language-css"><span class="hljs-number">1</span>px</span>'),
    ).toEqual([
      { text: "1", scope: "number" },
      { text: "px", scope: "plain" },
    ]);
  });

  test("a <script> body keeps javascript's own scopes", () => {
    const spans = highlight("<script>\nconst a = 1;\n</script>", "html").spans;
    expect(spans.map((span) => span.text).join("")).toBe("<script>\nconst a = 1;\n</script>");
    expect(spans.map((span) => span.scope)).toContain("keyword");
  });
});
