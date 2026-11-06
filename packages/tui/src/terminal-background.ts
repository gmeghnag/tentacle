/**
 * The terminal-background probe's PURE half (docs/feat/tui-light-theme.md S6).
 *
 * The TUI decides its palette once, before Ink mounts, from the terminal's
 * background colour. This module holds every decision and every parser, with no
 * streams, timers or React: the driver in `terminal-background-probe.ts` only
 * wires stdin and a clock. AGENTS §7 — logic in a pure module, so the behaviour
 * is testable in one place.
 *
 * The protocol: OSC 11 asks "what is your background?"; the terminal answers
 * `ESC ] 11 ; rgb:…` terminated by BEL or ST. DA1 (`ESC [ c`) is sent AFTER the
 * query as a SENTINEL: replies arrive in order, so once DA1 is seen no OSC reply
 * can follow, which ends the wait in one round trip instead of the whole timeout
 * on a terminal that ignores OSC 11.
 *
 * Byte forms: 7-bit ONLY — the introducer is `ESC ]`, the terminator BEL or
 * `ESC \`, and the sentinel `ESC [ ? … c` (owner decision Q-D, 2026-11-06). The
 * 8-bit C1 forms (`0x9d`, `0x9c`, `0x9b`) are NOT recognised: they are the only
 * reason the driver ever decoded the stream as latin1, and that decode is what
 * turned a UTF-8 key typed during the window into mojibake (Review MEDIUM 1).
 * stdin is decoded as UTF-8, so a C1 byte cannot even reach this parser.
 *
 * The control characters in the patterns below ARE the subject: this file parses
 * terminal escape sequences, so `\x07` and `\x1b` are expected bytes, not
 * accidents (the same reason `render-lines.ts` ignores the rule for SGR).
 */

import type { ThemeMode } from "./theme.ts";

export type { ThemeMode };
/** What the user's config says: `auto` asks the terminal, the others force it. */
export type ThemeSetting = "auto" | "dark" | "light";

/** An sRGB colour. */
export type Rgb = readonly [number, number, number];

/** OSC 11 (query background) then DA1 (the sentinel), both ST-terminated. */
export const BACKGROUND_QUERY = "\x1b]11;?\x1b\\\x1b[c";

/** The most this may cost at startup on a terminal that answers nothing (Q7). */
export const PROBE_TIMEOUT_MS = 200;

/** How long a late reply stays worth filtering out of Ink's input. */
export const LATE_GUARD_MS = 5_000;

/**
 * Above this luminance black text reads better than white, so the terminal is
 * "light". 0.179 is the exact crossing point: solving
 * `1.05 / (Y + 0.05) = (Y + 0.05) / 0.05` gives `Y = sqrt(1.05 * 0.05) - 0.05`.
 */
const LIGHT_LUMINANCE = 0.179;

/** The most of a never-terminated OSC this keeps before giving up on it. */
const MAX_REPLY_BYTES = 256;

/** WCAG relative luminance of an sRGB triple. */
export function luminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The palette a background colour calls for. */
export function modeOfBackground(rgb: Rgb): ThemeMode {
  return luminance(rgb) > LIGHT_LUMINANCE ? "light" : "dark";
}

/** `#RGB`, `#RRGGBB` and `#RRRRGGGGBBBB` as one parser. */
function parseHash(spec: string): Rgb | null {
  const hex = spec.slice(1);
  if (!/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  // `#RGB` (1 each), `#RRGGBB` (2 each), `#RRRGGGBBB` (3 each) and
  // `#RRRRGGGGBBBB` (4 each).
  const perChannel =
    hex.length === 3 ? 1 : hex.length === 6 ? 2 : hex.length === 9 ? 3 : hex.length === 12 ? 4 : 0;
  if (perChannel === 0) {
    return null;
  }
  const read = (index: number): number => {
    const part = hex.slice(index * perChannel, (index + 1) * perChannel);
    const value = Number.parseInt(part, 16);
    // Scale by the channel width: `f`→255, `ff`→255, `fff`→255, `ffff`→255, `8000`→128.
    return Math.round((value / (16 ** perChannel - 1)) * 255);
  };
  return [read(0), read(1), read(2)];
}

/**
 * An X11 colour spec as an sRGB triple: `rgb:H/H/H` (1–4 hex digits per channel,
 * each scaled by its own width), `rgba:H/H/H[/A]` (alpha ignored), or a `#` form.
 * Anything else is `null` — never a guess.
 */
export function parseColorSpec(spec: string): Rgb | null {
  const text = spec.trim();
  if (text.startsWith("#")) {
    return parseHash(text);
  }
  const match =
    /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i.exec(text);
  if (!match) {
    return null;
  }
  const channel = (part: string | undefined): number => {
    const digits = part ?? "";
    // Mixed widths are legal: each channel scales by ITS OWN width.
    return Math.round((Number.parseInt(digits, 16) / (16 ** digits.length - 1)) * 255);
  };
  return [channel(match[1]), channel(match[2]), channel(match[3])];
}

/**
 * `COLORFGBG` ("foreground;background" ANSI indices, sometimes with a middle
 * `default`). The background is the LAST field: 0–6 and 8 are dark, 7 and 9–15
 * are light. Anything unknown is `null`.
 */
export function modeOfColorFgBg(value: string | undefined): ThemeMode | null {
  if (value === undefined) {
    return null;
  }
  const fields = value.split(";");
  const last = fields[fields.length - 1];
  if (last === undefined || !/^\d{1,2}$/.test(last.trim())) {
    return null;
  }
  const index = Number(last.trim());
  if (index === 7 || (index >= 9 && index <= 15)) {
    return "light";
  }
  if (index <= 8) {
    return "dark";
  }
  return null;
}

/** Whether a query is worth sending at all. */
export function canProbe(io: {
  readonly stdinTty: boolean;
  readonly stdoutTty: boolean;
  readonly term?: string | undefined;
  readonly chalkLevel: number;
}): boolean {
  return io.stdinTty && io.stdoutTty && io.term !== "dumb" && io.chalkLevel > 0;
}

/** The final answer: a forced setting, else the probe, else `COLORFGBG`, else dark. */
export function resolveMode(
  setting: ThemeSetting,
  probed: Rgb | null,
  colorFgBg: string | undefined,
): ThemeMode {
  if (setting !== "auto") {
    return setting;
  }
  if (probed !== null) {
    return modeOfBackground(probed);
  }
  return modeOfColorFgBg(colorFgBg) ?? "dark";
}

// ── The incremental reply reader ────────────────────────────────────────────

export interface ProbeState {
  /** Every byte that is definitely NOT part of a reply, in order. */
  readonly rest: string;
  /** A reply seen so far but not yet terminated, held for the next chunk. */
  readonly pending: string;
  /** The background, once a well-formed OSC 11 reply has arrived. */
  readonly color: Rgb | null;
  /** DA1 arrived: no reply can follow, so the wait is over. */
  readonly sentinel: boolean;
}

export function initialProbe(): ProbeState {
  return { rest: "", pending: "", color: null, sentinel: false };
}

/** A reply's introducer: `ESC ]` (two bytes). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const OSC_INTRO = /^\x1b\]/;
/** A DA1 sentinel (`ESC [ ? … c`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const DA1 = /^\x1b\[\?[\d;]*c/;

/**
 * Could `text` still become a background reply? Used to decide whether an
 * unterminated tail is a partial reply (hold it) or ordinary input (hand it back).
 *
 * This matters because a real tty MIXES type-ahead into the reply: a key typed
 * during the read can land between two of the reply's bytes. Holding blindly
 * would swallow the keystroke and corrupt the reply; recognising that the tail
 * can no longer be a reply means both are handled honestly.
 *
 * The spec is checked as a PREFIX of a valid one, which is also what makes a
 * GARBAGE spec split across chunks come back as a garbage line rather than being
 * swallowed — accepted (Review LOW 7): a garbage line in the editor beats losing
 * what the user typed (`parseColorSpec` still answers `null`, so the palette
 * falls back).
 */
function isReplyPrefix(text: string): boolean {
  // A DA1 in progress (`ESC [` / `ESC [?1;` …): the sentinel must survive a split.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
  if (/^\x1b\[\?[\d;]{0,8}$/.test(text) || /^\x1b\[$/.test(text)) {
    return true;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
  const intro = /^\x1b\]/.exec(text);
  if (!intro) {
    // Only a LONE ESC can still become an introducer — `ESC q` is the Esc key
    // followed by the letter q, never a reply.
    return text === "\x1b";
  }
  const body = text.slice(intro[0].length);
  // A trailing ESC may be the first half of an ST terminator: it still completes
  // into a reply, so an unterminated tail ending in ESC is a reply prefix.
  const trimmed = body.endsWith("\x1b") ? body.slice(0, -1) : body;
  const S = "11;";
  if (trimmed.length < S.length) {
    return S.startsWith(trimmed);
  }
  if (!trimmed.startsWith(S)) {
    return false;
  }
  const spec = trimmed.slice(S.length);
  if (spec === "") {
    return true;
  }
  if (spec.startsWith("#")) {
    return /^#[0-9a-fA-F]{0,12}$/.test(spec);
  }
  // `rgb:` / `rgba:` then 1–4 hex digits per channel, `/`-separated, at most four
  // fields (the alpha is optional). Every prefix of a valid spec must pass, so a
  // reply split anywhere still completes.
  const head = /^rgba?:/.exec(spec);
  if (!head) {
    return "rgba:".startsWith(spec) || "rgb:".startsWith(spec);
  }
  const fields = spec.slice(head[0].length);
  if (fields === "") {
    return true;
  }
  const parts = fields.split("/");
  if (parts.length > 4) {
    return false;
  }
  return parts.every((part, i) => {
    if (!/^[0-9a-fA-F]{0,4}$/.test(part)) {
      return false;
    }
    // A trailing empty field is only legal while MORE may follow (a `/` just seen).
    return !(part === "" && i < parts.length - 1);
  });
}

/**
 * One chunk through the reader. Chunk boundaries may fall ANYWHERE — inside the
 * introducer, the payload or the terminator — so a partial tail is held, not
 * parsed. A non-reply byte is kept in `rest` in order.
 */
export function stepProbe(state: ProbeState, chunk: string): ProbeState {
  let buffer = state.pending + chunk;
  let rest = state.rest;
  let pending = "";
  let color = state.color;
  let sentinel = state.sentinel;

  while (buffer.length > 0) {
    const da1 = DA1.exec(buffer);
    if (da1) {
      sentinel = true;
      buffer = buffer.slice(da1[0].length);
      continue;
    }
    const osc = OSC_INTRO.exec(buffer);
    if (!osc) {
      // Not the start of an OSC reply. It may still be a DA1 in progress (the
      // sentinel) or a lone ESC that becomes one, so hold such a tail rather
      // than leaking half a sentinel into Ink's input.
      if (isReplyPrefix(buffer)) {
        pending = buffer;
        buffer = "";
        break;
      }
      rest += buffer[0];
      buffer = buffer.slice(1);
      continue;
    }
    // A reply starts here: find its terminator (BEL or ST).
    // `ESC \` is EITHER an ST terminator or the start of a DA1: look for the
    // whole ST (`\x1b\\`) rather than a bare ESC, or a following `[?…c` would be
    // mistaken for the end of the OSC.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
    const terminator = /\x07|\x1b\\/.exec(buffer.slice(osc[0].length));
    if (!terminator) {
      if (buffer.length > MAX_REPLY_BYTES) {
        // Never terminated and too long to be one: it is the user's input after
        // all, and a garbage line beats losing keystrokes.
        rest += buffer;
        buffer = "";
        break;
      }
      // Incomplete: hold it for the next chunk — NOT in `rest`, which is what the
      // caller gives back to Ink. Only a tail that could STILL be a reply is
      // held; anything else is the user typing mid-reply, and becomes input.
      if (!isReplyPrefix(buffer)) {
        // The held prefix is no longer a reply candidate: give it back, in order,
        // so the keystroke it really was is not lost.
        rest += buffer;
        buffer = "";
        break;
      }
      pending = buffer;
      buffer = "";
      break;
    }
    const end = osc[0].length + terminator.index + terminator[0].length;
    const body = buffer.slice(osc[0].length, osc[0].length + terminator.index);
    buffer = buffer.slice(end);
    // The introducer already consumed `ESC ]`, so the body is `11;rgb:…`.
    // A bare `11;?` is the QUERY, which we never answer ourselves.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
    const payload = /^11;([^\x07\x1b]*)$/.exec(body);
    if (payload) {
      const parsed = parseColorSpec(payload[1] ?? "");
      if (parsed !== null) {
        color = parsed;
      }
    }
    // Any other OSC (a title, a hyperlink) is consumed but changes nothing.
  }

  return { rest, pending, color, sentinel };
}

/**
 * Every byte that is not part of a reply, in the order it arrived, and that can
 * be the user's: `rest`, plus the held tail when it is NOT reply residue.
 *
 * At a SENTINEL nothing more can come (replies are ordered), so the whole held
 * tail is the user's. At a TIMEOUT a reply may still arrive, so the held tail is
 * handed to the late guard (`residueOf`) instead of to Ink — EXCEPT a lone `ESC`,
 * which is the Esc key and is never dropped (Design §2, Review MEDIUM 4).
 */
export function restOf(state: ProbeState): string {
  if (state.sentinel) {
    return state.rest + state.pending;
  }
  return state.rest + (state.pending === "\x1b" ? state.pending : "");
}

/**
 * The held tail that may be the HEAD of a reply cut by the timeout: it must
 * reach the late guard as its `pending`, so the reply's tail is stripped with it
 * rather than landing in the prompt as typed text (Review MEDIUM 4).
 */
export function residueOf(state: ProbeState): string {
  if (state.sentinel || state.pending === "\x1b") {
    return "";
  }
  return state.pending;
}

// ── The late-reply guard ────────────────────────────────────────────────────

export interface LateFilter {
  /** Still watching for a stray reply: false once one was stripped (or at the deadline). */
  readonly armed: boolean;
  /**
   * The bytes held from the end of the last chunk: a reply still arriving. It is
   * emitted, in order, the moment it can no longer be a reply — so a chunk
   * boundary anywhere gives the same answer and no byte is ever lost.
   */
  readonly pending: string;
  /** An OSC was stripped and its DA1 sentinel has not arrived yet. */
  readonly awaitingSentinel: boolean;
  /** When the filter gives up, in the caller's clock. */
  readonly deadline: number;
}

export function initialLateFilter(now = 0): LateFilter {
  return { armed: true, pending: "", awaitingSentinel: false, deadline: now + LATE_GUARD_MS };
}

/**
 * A complete stray reply at the start of the text, with its optional DA1
 * sentinel. The `(?:\x1b)?` is deliberate: the reply's ESC may already have passed
 * as the Esc key, in which case only `]11;…` remains.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const FULL_REPLY = /^(?:\x1b)?\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/;

/**
 * A DA1 sentinel at a REPLY BOUNDARY (the start of the text), where its ESC may
 * already have passed as the Esc key: `ESC[?1;2c` or the frameless `[?1;2c`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const LONE_SENTINEL = /^(?:\x1b\[\?[\d;]*c|\[\?[\d;]*c)/;

/**
 * The same DA1, but MID-CHUNK, where it must carry its own ESC: a frameless
 * `[?1c` in the middle of typed text is typing (`foo[?1cbar`), and eating it also
 * disarmed the guard (Review fix round 2, LOW 5).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const FRAMED_SENTINEL = /^\x1b\[\?[\d;]*c/;

/**
 * A DA1 sentinel still owed from an OSC that was already stripped: it follows a
 * reply, so it is at a boundary too (`filter.awaitingSentinel` is only set when
 * the rest of the buffer starts a fresh reply's tail).
 */
const SENTINEL = LONE_SENTINEL;

/**
 * Could `text` still become the DA1 sentinel, with enough framing to be worth
 * HOLDING? A bare `[` is far more often typed than half a sentinel, so it passes
 * at once; `ESC[` and `ESC[?…` are held anywhere (Review MEDIUM 3), and the
 * frameless `[?…` only at a reply boundary, where its ESC went first (LOW 5).
 */
function continueSentinel(text: string, boundary: boolean): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
  if (/^\x1b\[(?:\?[\d;]{0,8})?$/.test(text)) {
    return true;
  }
  // The frameless `[?…` is only a candidate where its ESC may have passed.
  return boundary && /^\[\?[\d;]{0,8}$/.test(text);
}

/** Could `text` still become the DA1 sentinel (`[`, `[?1;`, `ESC[?2`, …)? */
function isSentinelPrefix(text: string): boolean {
  return (
    // Nothing yet: the DA1 may open the very next chunk.
    text === "" ||
    // A lone ESC: the sentinel's own introducer.
    text === "\x1b" ||
    // `[`, `[?1;`, `ESC[`, `ESC[?2`, …
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
    /^(?:\x1b\[|\[)\??[\d;]{0,8}$/.test(text)
  );
}

/**
 * Could `text` still become a complete reply once its ESC has been consumed? This
 * is the STRICT prefix rule `stepProbe` uses (`isReplyPrefix`), not a loose
 * "anything after `11;`": the guard holds a candidate only while it is still a
 * prefix of a real reply, so the first key that cannot be part of one releases
 * the user's bytes AT ONCE instead of holding them to the deadline (Review fix
 * round 2, MEDIUM 2).
 *
 * The introducer's ESC is OPTIONAL here on purpose: the Esc key passes at once (it
 * must), so a reply split right after its ESC arrives as `]11;…`, and it must
 * still be recognised and stripped.
 */
function replyPrefix(text: string): boolean {
  if (isReplyPrefix(text)) {
    return true;
  }
  // The ESC-optional form applies to the OSC reply ONLY: prefixing a `[?1` with
  // an ESC would make any half-typed DA1 look like a held reply.
  return text.startsWith("]") && isReplyPrefix(`\x1b${text}`);
}

/**
 * Is a held candidate certainly REPLY RESIDUE, and therefore the only kind of
 * buffer allowed to be dropped at the deadline? It must carry the reply's `11;`
 * selector behind an OSC introducer — `ESC]11;`, `]11;` (the ESC already passed
 * as the Esc key). A bare `]` or `]1` is far more likely a typed key (a regex, an
 * index), so it is handed to the user instead of vanishing (Review LOW 6).
 */
function isReplyResidue(text: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
  return /^(?:\x1b\]|\])11;/.test(text);
}

/**
 * Strip a stray background reply from Ink's input, ONCE.
 *
 * A timed-out probe leaves the terminal raw, so a late reply reaches Ink as
 * ordinary input, where Ink's key parser turns it into junk in the prompt. This
 * removes one OSC 11 reply and its DA1 sentinel, keeps every other byte in order,
 * and holds an unfinished reply across chunks.
 *
 * The one deliberate trade-off: a LONE `ESC` passes AT ONCE, because it is the
 * Esc key and delaying it would make Escape feel broken. So a reply split exactly
 * after its ESC leaves that single ESC on screen (its `]11;…` remainder is still
 * stripped). A user typing literally `]11;rgb:` within `LATE_GUARD_MS` of a
 * timed-out probe loses those characters — the accepted cost of a usable Escape.
 */
export function stepLateFilter(
  filter: LateFilter,
  chunk: string,
  now: number,
): { readonly filter: LateFilter; readonly pass: string } {
  if (!filter.armed) {
    return { filter, pass: chunk };
  }
  if (now > filter.deadline) {
    // Too late to be the reply we were waiting for: everything passes again. A
    // held candidate is dropped only when it can ONLY be reply residue — a `]` the
    // user typed must not vanish (Review LOW 6).
    return {
      filter: { ...filter, armed: false, awaitingSentinel: false, pending: "" },
      pass: (isReplyResidue(filter.pending) ? "" : filter.pending) + chunk,
    };
  }

  // A held RESIDUE — the cut head of a reply the timeout already gave up on —
  // can only be the terminal's, never the user's. If this chunk neither finishes
  // it nor leaves it completable, drop it and read the chunk on its own, so the
  // first key that cannot be part of a reply releases the user's bytes AT ONCE
  // instead of holding them to the deadline and then losing them (Review fix
  // round 2, MEDIUM 2).
  let pending = filter.pending;
  if (
    pending !== "" &&
    isReplyResidue(pending) &&
    !FULL_REPLY.test(pending + chunk) &&
    !replyPrefix(pending + chunk)
  ) {
    pending = "";
  }
  const text = pending + chunk;
  let out = "";
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);
    // A DA1 sentinel still owed from an OSC that was already stripped.
    if (i === 0 && filter.armed && filter.awaitingSentinel) {
      const sentinel = SENTINEL.exec(rest);
      if (sentinel) {
        return {
          filter: { ...filter, armed: false, awaitingSentinel: false, pending: "" },
          pass: out + rest.slice(sentinel[0].length),
        };
      }
      if (isSentinelPrefix(rest)) {
        return { filter: { ...filter, pending: rest }, pass: out };
      }
      // No sentinel is coming: the rest is the user's.
      return {
        filter: { ...filter, armed: false, awaitingSentinel: false, pending: "" },
        pass: out + rest,
      };
    }
    const whole = FULL_REPLY.exec(rest);
    if (whole) {
      // The OSC is gone. Its DA1 sentinel may still arrive (this chunk or the
      // next), so stay armed until it is seen or a non-sentinel byte proves none
      // is coming — otherwise a reply split before the DA1 leaks `[?1;2c`.
      const after = rest.slice(whole[0].length);
      const sentinel = SENTINEL.exec(after);
      if (sentinel) {
        return {
          filter: { ...filter, armed: false, awaitingSentinel: false, pending: "" },
          pass: out + after.slice(sentinel[0].length),
        };
      }
      // A partial sentinel (`[`, `[?1;`, or nothing yet) is held; anything else
      // ends the watch.
      if (isSentinelPrefix(after)) {
        return {
          filter: { ...filter, armed: true, awaitingSentinel: true, pending: after },
          pass: out,
        };
      }
      return {
        filter: { ...filter, armed: false, awaitingSentinel: false, pending: "" },
        pass: out + after,
      };
    }
    // A DA1 with NO OSC before it (Review MEDIUM 3): strip it, and disarm — with
    // the sentinel seen, nothing more can come. A FRAMELESS `[?1c` is only
    // recognised at a reply boundary (`i === 0`, where its ESC may have passed as
    // the Esc key); mid-chunk it is typing (LOW 5).
    const lone = (i === 0 ? LONE_SENTINEL : FRAMED_SENTINEL).exec(rest);
    if (lone) {
      return {
        filter: { ...filter, armed: false, awaitingSentinel: false, pending: "" },
        pass: out + rest.slice(lone[0].length),
      };
    }
    if (continueSentinel(rest, i === 0)) {
      // Half a sentinel: held for the next chunk (an arrow key's `ESC[` included —
      // it resolves as soon as its letter arrives, or at the deadline).
      return { filter: { ...filter, pending: rest }, pass: out };
    }
    if (replyPrefix(rest)) {
      if (rest === "\x1b") {
        // The Esc key passes at once; if `]11;` follows, `FULL_REPLY` still
        // matches it (its ESC is optional), so nothing is lost.
        return { filter: { ...filter, pending: "" }, pass: out + rest };
      }
      // Hold the unfinished reply for the next chunk.
      return { filter: { ...filter, pending: rest }, pass: out };
    }
    // Not a reply: the first byte is the user's. Emit it and look again.
    out += rest[0];
    i += 1;
  }

  return { filter: { ...filter, pending: "" }, pass: out };
}
