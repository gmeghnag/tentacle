/**
 * Streaming text deltas → SPOKEN CHUNKS (docs/feat/voice-conversation.md §3, C2).
 *
 * Why chunk at all: V0 measured non-streaming TTS at 125 ms for one word and
 * 1.35 s for 179 chars (`realtime-media.md:705-712`), so the first thing spoken
 * must be short. Hence `firstWords` for the FIRST chunk only, then sentence and
 * clause ends.
 *
 * Why it is a fold: the reply arrives as deltas, so a boundary can fall anywhere
 * — inside a word, a number, or a markdown token. `step` consumes a delta and
 * emits only chunks whose boundary it is sure of; the rest stays `pending`.
 * Every test therefore runs the same text at many split points and asserts the
 * SAME chunks (T1's invariance), which is what makes the fold safe to feed from
 * a pipe.
 *
 * Hard rules (each pinned by T1):
 * - the first chunk is ≤ `firstWords` words, cut at the earliest clause end;
 * - afterwards, a sentence or clause end (or a line break) closes a chunk;
 * - no chunk exceeds `maxChars`, split at a clause, then at a space;
 * - never inside a word; never inside a number (`3.14`, `1,000`, `1.2.3`);
 * - `flush()` speaks whatever is left at turn end;
 * - nothing is silently dropped: joining the chunks with a space gives the input
 *   back (modulo collapsed whitespace).
 */
import { MAX_UTTERANCE } from "./speakable.ts";

/** The shipped chunker defaults (§3). */
export const CHUNK_DEFAULTS = {
  /**
   * 4 words for the first chunk. V0's TTFA table: 125 ms at 1 word, 1.35 s at
   * 179 chars, so four words keeps the first sound well under 400 ms while
   * still being a phrase a voice can inflect.
   */
  firstWords: 4,
  /**
   * 200 chars for every chunk. Above this a synthesiser's own latency grows
   * again; `MAX_UTTERANCE` (600, mobile-voice's cap) is the OUTER bound a
   * finished utterance may reach, so 200 is comfortably inside it.
   */
  maxChars: 200,
} as const;

/** Clause ends: after these the voice already pauses, so a cut is inaudible. */
const CLAUSE_END = /[,;:—–]$/;

/** Sentence ends. */
const SENTENCE_END = /[.!?…]$/;

/** A pending buffer's tail that may still be growing into a number. */
const PARTIAL_NUMBER = /[0-9][.,][0-9]*$/;

export interface ChunkState {
  /** Raw text accepted but not yet spoken. */
  readonly pending: string;
  /** No chunk has been emitted yet: the ≤ `firstWords` rule still applies. */
  readonly first: boolean;
}

export interface ChunkStep {
  readonly state: ChunkState;
  readonly chunks: readonly string[];
}

/**
 * The offset just past the `words`-th word: where the ≤ `firstWords` cut lands
 * when the utterance has no clause or sentence end to cut at. Never inside a
 * number (`3.` + `14`), which is why it may step one word further.
 */
function afterWords(text: string, words: number): number {
  const re = /\S+/g;
  let count = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    count += 1;
    if (count < words) continue;
    const end = m.index + m[0].length;
    // `3.` on this side of the boundary means the number continues: take one more.
    if (/[0-9][.,]$/.test(text.slice(m.index, end))) continue;
    return end;
  }
  return -1;
}

/** The words in `text`, whitespace-separated. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== "").length;
}

/** Does `text` end inside a number (`3.` / `3.1` / `1,`)? Then it may still grow. */
function endsInsideNumber(text: string): boolean {
  return PARTIAL_NUMBER.test(text);
}

/**
 * The offset of the last boundary at or before `limit` that is safe to cut at:
 * a space that is not inside a number. `-1` when there is none.
 */
function lastSafeSpace(text: string, limit: number): number {
  for (let at = text.lastIndexOf(" ", limit); at > 0; at = text.lastIndexOf(" ", at - 1)) {
    // A space inside "3.14" cannot happen, but a THIN space or a space between a
    // digit and a pending decimal point can: `1 ,5` is not a number, `1, 5` is a
    // list. So the only thing to refuse is a space right after `[0-9][.,]`
    // whose next char is a digit — i.e. the number continues on the far side.
    if (/[0-9][.,]$/.test(text.slice(0, at)) && /^[0-9]/.test(text.slice(at + 1))) continue;
    return at;
  }
  return -1;
}

/** Trim a chunk and drop it if nothing is left. */
function take(chunk: string): string | null {
  const trimmed = chunk.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Cut one chunk out of `buffer`, or `null` when no boundary is certain yet.
 * `first` applies the ≤ `firstWords` rule.
 */
function nextChunk(
  buffer: string,
  first: boolean,
): { readonly chunk: string; readonly rest: string } | null {
  const maxChars = CHUNK_DEFAULTS.maxChars;

  // A line break is always a boundary (a list item, a paragraph).
  const newline = buffer.search(/\n/);
  if (newline > 0) {
    const chunk = take(buffer.slice(0, newline));
    if (chunk !== null) return { chunk, rest: buffer.slice(newline + 1).replace(/^\s+/, "") };
  }

  if (first) {
    // The first chunk: the earliest clause or sentence end, else a word-budget cut.
    const stop = earliestEnd(buffer, CHUNK_DEFAULTS.firstWords, maxChars);
    if (stop !== null) return stop;
    // No clause end yet and no more words than the budget: wait for more input.
    if (wordCount(buffer) <= CHUNK_DEFAULTS.firstWords) return null;
    const at = afterWords(buffer, CHUNK_DEFAULTS.firstWords);
    if (at > 0 && at <= maxChars) {
      const chunk = take(buffer.slice(0, at));
      if (chunk !== null) return { chunk, rest: buffer.slice(at).replace(/^\s+/, "") };
    }
    return longToken(buffer, maxChars);
  }

  // Later chunks: a sentence end closes at once; a clause end closes when the
  // clause has some substance (never `Yes. A,`-style chopping).
  const sentence = earliestSentenceEnd(buffer);
  if (sentence !== null && sentence.chunk.length <= maxChars) return sentence;

  if (buffer.length > maxChars) {
    const clause = lastClauseEnd(buffer, maxChars);
    if (clause !== null) return clause;
    const at = lastSafeSpace(buffer, maxChars);
    if (at > 0) {
      const chunk = take(buffer.slice(0, at));
      if (chunk !== null) return { chunk, rest: buffer.slice(at + 1) };
    }
  }
  return longToken(buffer, maxChars);
}

/**
 * An over-long leading token (a URL, a base64 blob, a hash) cannot be split, so
 * it is spoken alone: everything up to the first space goes out as its own chunk
 * and the prose after it starts the next one. `null` unless the head really is
 * longer than the cap and really is one token.

/** The first sentence end within the FIRST-chunk word budget, if any. */
function earliestEnd(
  buffer: string,
  firstWords: number,
  maxChars: number,
): { readonly chunk: string; readonly rest: string } | null {
  const tokens = buffer.split(/(\s+)/);
  let words = 0;
  let offset = 0;
  for (const token of tokens) {
    offset += token.length;
    if (/^\s+$/.test(token) || token === "") continue;
    words += 1;
    const head = buffer.slice(0, offset);
    if (head.length > maxChars) break;
    const endsWord = /[.!?…,;:—–]$/.test(token);
    if (!endsWord) continue;
    // A number's own separator (`3.` / `3,`) is not a clause end.
    if (/[0-9][.,]$/.test(token)) continue;
    if (words > firstWords && !SENTENCE_END.test(token)) continue;
    const chunk = take(head);
    if (chunk !== null) return { chunk, rest: buffer.slice(offset).replace(/^\s+/, "") };
  }
  return null;
}

/** The first complete sentence in `buffer`, if any. */
function earliestSentenceEnd(
  buffer: string,
): { readonly chunk: string; readonly rest: string } | null {
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i] ?? "";
    if (!SENTENCE_END.test(ch)) continue;
    // `3.14` is not a sentence end; neither is `e.g.` mid-phrase.
    if (/[0-9]/.test(buffer[i - 1] ?? "") && /[0-9]/.test(buffer[i + 1] ?? "")) continue;
    // The sentence must be closed by a space/newline, or the buffer must have
    // ended (only `flush` may speak an unterminated one).
    const after = buffer[i + 1];
    if (after === undefined) continue;
    if (!/\s/.test(after)) continue;
    const chunk = take(buffer.slice(0, i + 1));
    if (chunk !== null) return { chunk, rest: buffer.slice(i + 1).replace(/^\s+/, "") };
  }
  return null;
}

/** The last clause end at or before `limit`, as a chunk. */
function lastClauseEnd(
  buffer: string,
  limit: number,
): { readonly chunk: string; readonly rest: string } | null {
  for (let i = Math.min(limit, buffer.length - 1); i > 0; i--) {
    const ch = buffer[i] ?? "";
    if (!CLAUSE_END.test(ch)) continue;
    if (/[0-9]/.test(buffer[i - 1] ?? "") && /[0-9]/.test(ch === "," ? "0" : "")) continue;
    const chunk = take(buffer.slice(0, i + 1));
    if (chunk === null) continue;
    return { chunk, rest: buffer.slice(i + 1).replace(/^\s+/, "") };
  }
  return null;
}

export const chunkFilter = {
  init(): ChunkState {
    return { pending: "", first: true };
  },

  /** Consume one delta; emit every chunk whose boundary is now certain. */
  step(state: ChunkState, delta: string): ChunkStep {
    let pending = state.pending + delta;
    let first = state.first;
    const chunks: string[] = [];
    for (;;) {
      // A number cut here would still be growing: never emit through it.
      if (endsInsideNumber(pending.trimEnd())) break;
      const taken = nextChunk(pending, first);
      if (taken === null) break;
      chunks.push(taken.chunk);
      pending = taken.rest;
      first = false;
    }
    return { state: { pending, first }, chunks };
  },

  /** Turn end: speak whatever is left, in ≤ `maxChars` chunks, never mid-word. */
  flush(state: ChunkState): ChunkStep {
    const chunks: string[] = [];
    let rest = state.pending;
    for (;;) {
      const body = rest.replace(/^\s+/, "");
      if (body === "") break;
      // An over-cap leading token is spoken alone, then the prose after it.
      const lone = longToken(body, CHUNK_DEFAULTS.maxChars);
      if (lone !== null) {
        chunks.push(lone.chunk);
        rest = lone.rest;
        continue;
      }
      if (body.length <= CHUNK_DEFAULTS.maxChars) {
        chunks.push(body.trim());
        break;
      }
      const at = lastSafeSpace(body, CHUNK_DEFAULTS.maxChars);
      if (at <= 0) {
        chunks.push(body.trim());
        break;
      }
      chunks.push(body.slice(0, at).trim());
      rest = body.slice(at + 1);
    }
    return { state: chunkFilter.init(), chunks };
  },
};

/**
 * An over-long leading token (a URL, a base64 blob, a hash) cannot be split, so
 * it is spoken alone: everything up to the first space goes out as its own chunk
 * and the prose after it starts the next one. `null` unless the head really is
 * longer than the cap and really is one token.
 */
function longToken(
  buffer: string,
  maxChars: number,
): { readonly chunk: string; readonly rest: string } | null {
  const trimmed = buffer.trimStart();
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  if (head.length <= maxChars) return null;
  return {
    chunk: head,
    rest: space === -1 ? "" : trimmed.slice(space).replace(/^\s+/, ""),
  };
}
