/**
 * Markdown text → SPEAKABLE text (docs/feat/voice-conversation.md §3, C2).
 *
 * Two shapes, one truth:
 * - `speakableText` — a finished reply (the phone's read-aloud button, a
 *   `flush`ed turn);
 * - `speakableFilter` — the STREAMING fold, because on both edges the reply
 *   arrives as `agent_message_chunk` deltas and a fence, a table or a link can
 *   straddle a delta boundary. `step` emits only text it is sure of; the tail
 *   that could still change meaning is held in `pending`.
 *
 * Rules (each pinned by `test/voice/speakable.test.ts` T2):
 * - a fenced block (` ``` ` or `~~~`, closed or not) becomes a placeholder and
 *   its body is NEVER spoken — that body may be pod-supplied (F7);
 * - a table becomes a placeholder;
 * - a link keeps its label, never its href; a bare URL is "link";
 * - control characters (C0, C1, DEL) are stripped; whitespace is collapsed;
 * - `clean` and `splitLong` are `feat/mobile-voice`'s, lifted unchanged so the
 *   phone's read-aloud path keeps its behaviour.
 *
 * Why the fold is not a markdown parser: the phone's AST walk needs the whole
 * reply and its own parser (`apps/mobile/src/markdown.ts`, unmerged). This module
 * must run on a pipe of deltas, so it does the minimum both edges share: hide
 * what must not be heard.
 */
import type { SpeechLang } from "./voice-lang.ts";

/** Characters one spoken utterance may run to before it is split (§3, T2). */
export const MAX_UTTERANCE = 600;

const WORDS = {
  en: { code: "(code on screen)", table: "(table on screen)", link: "link" },
  it: { code: "(codice a schermo)", table: "(tabella a schermo)", link: "collegamento" },
} as const;

/**
 * Control characters: C0 (minus `\n`/`\t`, which are whitespace) and DEL. An ANSI
 * escape sequence loses its ESC byte, so it never reaches a synthesiser as a
 * command; the parameter bytes that remain are just text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

/** mobile-voice's wave-1 rule: emoji and box drawing are noise, not words. */
const NOISE_RE =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\u{20E3}|[─-▟]/gu;

const URL_RE = /\bhttps?:\/\/\S+/g;

/** A markdown inline link `[label](href)`. */
const LINK_RE = /\[([^\]]*)\]\(([^)\s]*)\)/g;

/** A fence's opening marker: three or more backticks or tildes, indented ≤ 3. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** What may still BECOME a fence: up to two fence chars, alone on the last line. */
const FENCE_PREFIX_RE = /^ {0,3}[`~]{1,2}$/;

/** Emphasis markers are flattened to their text (mobile-voice's rule, §3). */
const EMPHASIS_RES = [/\*\*(.+?)\*\*/g, /__(.+?)__/g, /\*(.+?)\*/g] as const;

/** Strip control characters, emoji/box noise; collapse whitespace and trim. */
export function clean(text: string): string {
  return text.replace(CONTROL_RE, " ").replace(NOISE_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Split one utterance at sentence boundaries so none exceeds `max`; a single
 * sentence longer than the cap is cut at a space. Joining the result with a
 * space gives the input back, so nothing spoken is lost (lifted from
 * mobile-voice, `splitLong`).
 */
export function splitLong(text: string, max: number = MAX_UTTERANCE): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [text];
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim() !== "") out.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (current.length + sentence.length > max) flush();
    if (sentence.length > max) {
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

/** The fold's state: the language, plus the raw tail not yet spoken. */
export interface SpeakableFilterState {
  readonly lang: SpeechLang;
  /** Raw markdown accepted but not yet emitted (a straddling fence/table/link). */
  readonly pending: string;
  /** Inside a fenced block: everything up to the closing fence is dropped. */
  readonly inFence: boolean;
  /** The fence's own marker, so `~~~` does not close a ` ``` ` block. */
  readonly fenceMark: string;
  /**
   * The next emitted chunk must start with a space: the previous one ended on
   * whitespace this fold collapsed away. It keeps `step`'s outputs concatenable
   * — an edge sends them in order, so a lost boundary space would glue words.
   */
  readonly spaceBefore: boolean;
}

export interface SpeakableStep {
  readonly state: SpeakableFilterState;
  readonly text: string;
}

/** Fold one run of PROSE (no fence, no table) into speakable text. */
function prose(raw: string, lang: SpeechLang): string {
  const linked = raw.replace(LINK_RE, (_m, label: string, href: string) => {
    const kept = clean(label);
    // An autolink's label IS its href: a URL is never read out.
    return kept === "" || kept === href ? WORDS[lang].link : kept;
  });
  const flat = EMPHASIS_RES.reduce((text, re) => text.replace(re, "$1"), linked);
  // Control bytes and emoji/box noise are stripped HERE, not only in `clean`:
  // `emit` is the only path to a synthesiser, so nothing may bypass it (F7).
  return flat.replace(CONTROL_RE, " ").replace(NOISE_RE, " ").replace(URL_RE, WORDS[lang].link);
}

/**
 * Fold settled markdown into speakable text, table rows and their delimiter
 * collapsing to one placeholder. Runs on a whole accumulated chunk, so a table
 * split across deltas is decided here, once.
 */
function emit(raw: string, lang: SpeechLang): string {
  if (raw === "") return "";
  const lines = raw.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const delimiter = lines[i + 1] ?? "";
    if (line.includes("|") && /^ {0,3}\|?[ :|-]*-[ :|-]*\|/.test(delimiter)) {
      out.push(`\n${WORDS[lang].table}\n`);
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|")) i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return prose(out.join("\n"), lang);
}

/** Collapse the fold's output: spacing never doubles up between chunks. */
function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Normalise one chunk's raw text against the stream's boundary state: exactly one
 * interior space per whitespace run, no leading or trailing space in `text`, and
 * `spaceBefore` carried forward so the NEXT chunk opens with the space this one
 * lost. Consecutive `text`s concatenate to the same words as `tidy` of the whole.
 */
function chunk(
  raw: string,
  spaceBefore: boolean,
): { readonly text: string; readonly spaceBefore: boolean } {
  const collapsed = raw.replace(/\s+/g, " ");
  const body = collapsed.replace(/^ /, "").replace(/ $/, "");
  // A chunk that is only whitespace carries its meaning entirely in `spaceBefore`.
  if (body === "") return { text: "", spaceBefore: spaceBefore || collapsed !== "" };
  const lead = spaceBefore || collapsed.startsWith(" ");
  return { text: lead ? ` ${body}` : body, spaceBefore: collapsed.endsWith(" ") };
}

/**
 * The first line that OPENS a fence, with the offset just past its marker. The
 * rest of that line is the info string (a language name): it is skipped with the
 * body, never spoken.
 */
function fenceOpen(buffer: string): { readonly start: number; readonly mark: string } | null {
  let offset = 0;
  for (const line of buffer.split("\n")) {
    const m = FENCE_RE.exec(line);
    if (m?.[1] !== undefined) return { start: offset, mark: m[1] };
    offset += line.length + 1;
  }
  return null;
}

/**
 * Where the settled (safe-to-speak) prefix of `buffer` ends. Everything from
 * here on is held, because it could still change what is spoken:
 *
 * - a trailing run of `|` lines is a table whose delimiter row may not have
 *   arrived yet (speaking it early would read cells);
 * - a trailing line that is still only fence characters may become a fence;
 * - an unterminated `[label](` would otherwise speak the href;
 * - a trailing URL-ish token is only a URL once it stops growing.
 *
 * Ordinary prose is NOT held: a reply that never sends a newline must still be
 * spoken as it arrives.
 */
function holdFrom(buffer: string): number {
  const lines = buffer.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  let hold = buffer.length;

  // 1. The trailing table run (a trailing empty element is the newline itself).
  let last = lines.length - 1;
  if (last > 0 && (lines[last] ?? "") === "") last -= 1;
  let run = last;
  while (run >= 0 && (lines[run] ?? "").includes("|")) run -= 1;
  if (run !== last) hold = Math.min(hold, offsets[run + 1] ?? 0);

  // 2. A last line that could still become a fence (or is an unterminated fence
  //    line's first characters).
  const tail = lines[lines.length - 1] ?? "";
  if (FENCE_PREFIX_RE.test(tail)) hold = Math.min(hold, offsets[lines.length - 1] ?? 0);

  // 3. An unterminated link: from its `[` until its `](href)` completes. Emitting
  //    `[label](` early would let the href through on the next delta.
  const openBracket = buffer.lastIndexOf("[");
  if (openBracket !== -1 && !/\[[^\]]*\]\([^)\s]*\)/.test(buffer.slice(openBracket))) {
    hold = Math.min(hold, openBracket);
  }

  // 4. A trailing BARE url that may still be growing; `prose` would say "link"
  //    too early and the rest would be read as text. A url inside `](` is not
  //    this case: rule 3 already holds until the link is complete.
  const url = /https?:\/\/\S*$/.exec(buffer);
  if (url !== null && buffer.slice(Math.max(0, url.index - 2), url.index) !== "](") {
    hold = Math.min(hold, url.index);
  }

  return Math.max(0, hold);
}

export const speakableFilter = {
  init(lang: SpeechLang): SpeakableFilterState {
    return { lang, pending: "", inFence: false, fenceMark: "", spaceBefore: false };
  },

  /**
   * Consume one delta. Emits the text it is sure of; the rest stays `pending`
   * until a later delta (or `flush`) resolves it.
   */
  step(state: SpeakableFilterState, delta: string): SpeakableStep {
    let buffer = state.pending + delta;
    let inFence = state.inFence;
    let fenceMark = state.fenceMark;
    const out: string[] = [];

    for (;;) {
      if (inFence) {
        const close = buffer.indexOf(fenceMark);
        if (close === -1) break;
        // Drop the body AND the info string before the close; resume after the
        // closing fence's own line.
        const rest = buffer.slice(close + fenceMark.length);
        const newline = rest.indexOf("\n");
        buffer = newline === -1 ? rest.slice(0, 0) : rest.slice(newline + 1);
        inFence = false;
        fenceMark = "";
        out.push(WORDS[state.lang].code);
        continue;
      }
      const fence = fenceOpen(buffer);
      if (fence !== null) {
        out.push(emit(buffer.slice(0, fence.start), state.lang));
        buffer = buffer.slice(fence.start + fence.mark.length);
        inFence = true;
        fenceMark = fence.mark;
        continue;
      }
      const cut = holdFrom(buffer);
      out.push(emit(buffer.slice(0, cut), state.lang));
      buffer = buffer.slice(cut);
      break;
    }

    const next: SpeakableFilterState = { ...state, pending: buffer, inFence, fenceMark };
    const out_ = chunk(out.join(" "), state.spaceBefore);
    return { state: { ...next, spaceBefore: out_.spaceBefore }, text: out_.text };
  },

  /** End of turn: speak whatever was held back, then reset. */
  flush(state: SpeakableFilterState): SpeakableStep {
    const body = state.inFence ? "" : state.pending;
    const parts = [state.inFence ? WORDS[state.lang].code : "", emit(body, state.lang)];
    return {
      state: speakableFilter.init(state.lang),
      text: chunk(parts.join(" "), state.spaceBefore).text,
    };
  },
};

/** A finished reply → what the voice says. */
export function speakableText(text: string, lang: SpeechLang): string {
  const first = speakableFilter.step(speakableFilter.init(lang), text);
  const last = speakableFilter.flush(first.state);
  return tidy(`${first.text}${last.text}`);
}
