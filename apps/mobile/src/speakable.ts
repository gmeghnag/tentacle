/**
 * A reply as SPEAKABLE text (docs/feat/mobile-voice.md Design §3): the parsed
 * markdown tree (`markdown.ts`) walked into utterances the system voice reads.
 * A sibling walk of `plainText`, never a second markdown parser (P2).
 *
 * Rules, each pinned by `test/speakable.test.ts`:
 * - a paragraph / heading / list item is one utterance; a heading ends with a
 *   period so the voice pauses;
 * - a link keeps its text, never its href; a bare URL is read as "link";
 * - a code BLOCK is summarised ("code block, 12 lines, ts"), never read out;
 * - a table is summarised ("table, 3 rows"); a rule is skipped; raw HTML is read
 *   with its tags removed;
 * - emoji and box-drawing characters are dropped, whitespace collapsed;
 * - an utterance over `MAX_UTTERANCE` is split at a sentence boundary;
 * - a `chunked` (too long to parse) row reads its shown text, then "message
 *   truncated".
 */
import type { MdBlock, MdInline, Parsed } from "./markdown.ts";

export type SpeechLang = "it" | "en";

/** Characters one utterance may run to before it is split (Design §3). */
export const MAX_UTTERANCE = 600;

const WORDS = {
  en: {
    link: "link",
    codeBlock: "code block",
    line: "line",
    lines: "lines",
    table: "table",
    row: "row",
    rows: "rows",
    truncated: "message truncated",
  },
  it: {
    link: "collegamento",
    codeBlock: "blocco di codice",
    line: "riga",
    lines: "righe",
    table: "tabella",
    row: "riga",
    rows: "righe",
    truncated: "messaggio troncato",
  },
} as const;

const URL_RE = /\bhttps?:\/\/\S+/g;
// Emoji (pictographs, flags, keycaps' modifiers, ZWJ, variation selectors) and box drawing / blocks.
// An alternation, not one class: the joiners/selectors are combining characters.
const NOISE_RE =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\u{20E3}|[─-▟]/gu;
const TAG_RE = /<[^>]*>/g;

/** Strip noise and collapse whitespace: the text a voice should actually say. */
export function clean(text: string): string {
  return text.replace(NOISE_RE, " ").replace(/\s+/g, " ").trim();
}

function inlineText(items: readonly MdInline[], lang: SpeechLang): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case "text":
          return item.text.replace(URL_RE, WORDS[lang].link);
        case "code":
          return item.text;
        case "link": {
          const text = inlineText(item.children, lang);
          // An autolink's text IS its href: a URL is never read out.
          return text.trim() === "" || text === item.href ? WORDS[lang].link : text;
        }
        default:
          return inlineText(item.children, lang);
      }
    })
    .join("");
}

/** "1 line" / "12 lines" in the reply's language. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Lines of a code block, a trailing newline not counted. */
function codeLines(text: string): number {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}

function withPause(text: string): string {
  return /[.!?:;]$/.test(text) ? text : `${text}.`;
}

/** Split one utterance at sentence boundaries so none exceeds `max`. */
export function splitLong(text: string, max: number = MAX_UTTERANCE): string[] {
  if (text.length <= max) {
    return [text];
  }
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [text];
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim() !== "") {
      out.push(current.trim());
    }
    current = "";
  };
  for (const sentence of sentences) {
    if (current.length + sentence.length > max) {
      flush();
    }
    if (sentence.length > max) {
      // One sentence longer than the cap: hard cut at a space.
      let rest = sentence.trim();
      while (rest.length > max) {
        const at = rest.lastIndexOf(" ", max);
        const cut = at > 0 ? at : max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest === "" ? "" : `${rest} `;
    } else {
      current += sentence;
    }
  }
  flush();
  return out;
}

/** A parsed reply → the utterances to speak, in order. Empty input → `[]`. */
export function speakable(parsed: Parsed, lang: SpeechLang): string[] {
  const words = WORDS[lang];
  const raw: string[] = [];
  const walk = (list: readonly MdBlock[], prefix = ""): void => {
    let first = true;
    for (const block of list) {
      // A list item's number is said once, before its first utterance.
      const lead = first ? prefix : "";
      first = false;
      switch (block.kind) {
        case "paragraph":
          raw.push(lead + inlineText(block.children, lang));
          break;
        case "heading":
          raw.push(lead + withPause(clean(inlineText(block.children, lang))));
          break;
        case "code": {
          const summary = `${words.codeBlock}, ${count(codeLines(block.text), words.line, words.lines)}`;
          raw.push(lead + (block.lang !== null ? `${summary}, ${block.lang}` : summary));
          break;
        }
        case "table":
          raw.push(`${lead}${words.table}, ${count(block.rows.length, words.row, words.rows)}`);
          break;
        case "list":
          block.items.forEach((item, i) => {
            walk(item, block.ordered ? `${(block.start ?? 1) + i}. ` : "");
          });
          break;
        case "quote":
          walk(block.children, lead);
          break;
        case "literal":
          raw.push(lead + block.text.replace(TAG_RE, " ").replace(URL_RE, words.link));
          break;
        case "rule":
          break;
      }
    }
  };
  if (parsed.kind === "chunked") {
    for (const para of parsed.shown.split(/\n\s*\n/)) {
      raw.push(para.replace(URL_RE, words.link));
    }
  } else {
    walk(parsed.blocks);
  }
  const out: string[] = [];
  for (const text of raw) {
    const spoken = clean(text);
    // A bare list number with nothing after it is not worth a breath.
    if (spoken === "" || /^\d+\.$/.test(spoken)) {
      continue;
    }
    out.push(...splitLong(spoken));
  }
  if (parsed.kind === "chunked" && out.length > 0) {
    out.push(words.truncated);
  }
  return out;
}
