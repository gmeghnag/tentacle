/**
 * Code highlighting for a phone row (12b): `highlight.js/lib/core` with a FIXED
 * registered language set, → `[{text, scope}]` spans a `<Text>` renders.
 *
 * Why core + a list: the full bundle is ~1 MB of grammars in the JS bundle, and
 * an unknown language must never highlight (plan F21's sibling rule). Step 0
 * proved on the 26.5 simulator that `highlight()`, `getLanguage()` and the
 * grammars chosen here RUN under Hermes in a Release build.
 *
 * A language this build does not register is PLAIN MONOSPACE — and the gate is
 * `getLanguage()` FIRST, because `highlight()` THROWS on an unknown language
 * (`Unknown language: "nosuch"`, found by Step 0's own probe).
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** The registered grammars: name → module. The ONE place the set is decided. */
const LANGUAGES = {
  bash,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
} as const;

/** The dialect a fence's `lang` means, or null when this build does not know it. */
const ALIASES: Readonly<Record<string, keyof typeof LANGUAGES>> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  java: "java",
  kt: "java",
  kotlin: "java",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  diff: "diff",
  patch: "diff",
  md: "markdown",
  markdown: "markdown",
  html: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "css",
};

let registered = false;

/** Register the fixed set, once (idempotent: two screens must not throw). */
function ensureRegistered(): void {
  if (registered) {
    return;
  }
  for (const [name, grammar] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, grammar);
  }
  registered = true;
}

/** A highlighted span: `scope` is `hljs-*`'s class suffix (`keyword`, `string`). */
export interface Span {
  readonly text: string;
  readonly scope: string;
}

/** What a code block renders as: spans, or the plain text (`lang` unknown/absent). */
export interface Highlighted {
  /** The dialect actually used, or null for plain. */
  readonly language: string | null;
  readonly spans: readonly Span[];
}

/** Characters of one code block this module highlights (a huge block stays plain). */
export const HIGHLIGHT_MAX_CHARS = 20_000;

/** The dialect name `lang` (a fence tag) resolves to, or null. */
export function languageOf(lang: string | null | undefined): keyof typeof LANGUAGES | null {
  if (lang === null || lang === undefined) {
    return null;
  }
  const key = lang.trim().toLowerCase();
  if (key === "") {
    return null;
  }
  return ALIASES[key] ?? null;
}

/**
 * Highlight `text` as `lang`. Unknown/absent/over-long → one plain span (no
 * error: `highlight()` would throw on an unknown language, so the gate is
 * `languageOf` + `getLanguage` — never a `try`/`catch` around a parse).
 */
export function highlight(text: string, lang: string | null | undefined): Highlighted {
  const name = languageOf(lang);
  if (name === null || text === "" || text.length > HIGHLIGHT_MAX_CHARS) {
    return { language: null, spans: [{ text, scope: "plain" }] };
  }
  ensureRegistered();
  if (hljs.getLanguage(name) === undefined) {
    return { language: null, spans: [{ text, scope: "plain" }] };
  }
  const result = hljs.highlight(text, { language: name, ignoreIllegals: true });
  return { language: name, spans: spansOf(result.value) };
}

/**
 * `highlight()`'s HTML output → spans. Its own emitter is not used (it escapes
 * and nests `<span class="hljs-x">`), so this walks the tags it actually emits:
 * every node is opened by `<span class="hljs-…">` and closed by `</span>`, and
 * text between them is HTML-escaped by highlight.js itself.
 */
export function spansOf(html: string): readonly Span[] {
  const spans: Span[] = [];
  const stack: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<span class="hljs-', at);
    const close = html.indexOf("</span>", at);
    if (open === -1 && close === -1) {
      pushText(spans, unescapeHtml(html.slice(at)), stack);
      break;
    }
    if (open !== -1 && (close === -1 || open < close)) {
      pushText(spans, unescapeHtml(html.slice(at, open)), stack);
      const end = html.indexOf('"', open + '<span class="hljs-'.length);
      if (end === -1) {
        break; // malformed output: keep what was read
      }
      stack.push(html.slice(open + '<span class="hljs-'.length, end));
      const after = html.indexOf(">", end);
      if (after === -1) {
        break;
      }
      at = after + 1;
      continue;
    }
    pushText(spans, unescapeHtml(html.slice(at, close)), stack);
    stack.pop();
    at = close + "</span>".length;
  }
  return spans;
}

function pushText(into: Span[], text: string, stack: readonly string[]): void {
  if (text === "") {
    return;
  }
  const scope = stack.length === 0 ? "plain" : (stack[stack.length - 1] as string);
  const last = into[into.length - 1];
  if (last !== undefined && last.scope === scope) {
    into[into.length - 1] = { text: last.text + text, scope };
    return;
  }
  into.push({ text, scope });
}

/** The entities highlight.js escapes (`escapeHTML`): `&`, `<`, `>`, `"`. */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
