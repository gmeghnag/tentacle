/**
 * The laptop's session file as a typed event log — `<uid>.jsonl`
 * (docs/feat/session-log-laptop-store.md). Pure: no I/O, no clock. The store
 * (`session-log-store.ts`) does the reads, writes and locking.
 *
 * Line 1 is the FILE HEADER, not a log entry (no `type`, so no `critical`
 * value): `{format, schemaVersion, id, cwd, model, createdAt}`. Every other
 * line is one `session/log` entry exactly as the client validated and
 * re-serialized it (F4: never a raw pod frame). Segments start at a `base`;
 * the projection is the LAST complete segment's fold (`projectEntry`, the
 * fold the client's reader shares). A turn open at the end of the file is
 * closed when the file is LOADED (`closeAtLoad`), never when it is saved.
 *
 * Reading is loud on corruption: an unknown `schemaVersion`, an unknown
 * CRITICAL entry, a line that is not JSON or not its schema, a broken segment
 * → the file is refused (`ok: false`), never half-loaded. Two things are
 * tolerated, both by design: a TORN last line (a crash mid-append: no `\n`)
 * is ignored, and an unknown NON-critical entry (a newer build's) is skipped
 * and counted. `prev` links are not re-checked here (an entry dropped in
 * transit leaves a hole; the writer guarantees continuity); `seq` must grow
 * inside a segment, and an exact duplicate `id` (a lock lost to a stale
 * takeover) is skipped.
 */
import type { ChatMessage } from "@tentacle/core";
import {
  type KnownLogEntry,
  KnownLogEntrySchema,
  LOG_ENTRY_CRITICAL,
  type SessionTitle,
  projectEntry,
} from "@tentacle/protocol";
import {
  ENDED_INTERRUPTED_NOTE,
  ENDED_NOT_RUN_NOTE,
  ENDED_TURN_NOTE,
  answerUnansweredCalls,
  labelUnansweredCalls,
} from "./persisted-session.ts";

/** The header's `format` tag. */
export const SESSION_LOG_FORMAT = "tentacle-session-log";
/** The laptop log's own version (separate from the wire's and the daemon record's). */
export const SESSION_LOG_VERSION = 1;

/** Line 1 of a log file: the session's immutable facts. */
export interface LogFileHeader {
  readonly format: typeof SESSION_LOG_FORMAT;
  readonly schemaVersion: typeof SESSION_LOG_VERSION;
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: number;
}

export type BaseEntry = Extract<KnownLogEntry, { type: "base" }>;

/** One segment of a parsed file: its entries (from its `base`) and what they fold to. */
export interface LogSegment {
  readonly base: BaseEntry;
  readonly entries: readonly KnownLogEntry[];
  /** The fold of `entries` (raw: an open turn is NOT closed here). */
  readonly messages: readonly ChatMessage[];
  /** The last `title` entry of the segment. */
  readonly title?: SessionTitle;
  /** The turns open at the segment's end (from `turn_start` / `base.turn`, minus `turn_end`). */
  readonly openTurns: readonly string[];
  /** Every `call_started` callId of the segment. */
  readonly started: ReadonlySet<string>;
  /** Unknown non-critical lines inside it (a newer build's): kept on append, set aside by a rewrite. */
  readonly unknown: number;
  /** Its text range in the file (`[start, end)`, whole lines): carried over byte for byte. */
  readonly start: number;
  readonly end: number;
}

export interface ParsedLogFile {
  readonly ok: true;
  readonly header: LogFileHeader;
  /** Complete segments, in file order; the LAST is the projection. Never empty. */
  readonly segments: readonly LogSegment[];
  /** Chars of a torn last line (no `\n`), ignored. */
  readonly torn: number;
  /** Chars of a torn last segment (a `base` still owed messages at EOF), ignored. */
  readonly tornSegment: number;
  /** Unknown non-critical lines skipped. */
  readonly skipped: number;
  /** Exact duplicate ids skipped. */
  readonly duplicates: number;
  /** The id of the last entry line (known, unknown, or duplicate), if any: where an append continues. */
  readonly lastId?: string;
  /** Where the complete content ends (a writer truncates the file here before it appends). */
  readonly contentEnd: number;
}

export type LogFileResult = ParsedLogFile | { readonly ok: false; readonly reason: string };

const KNOWN: ReadonlySet<string> = new Set(Object.keys(LOG_ENTRY_CRITICAL));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The header line's problem, or null. */
function headerProblem(value: unknown, id: string): string | null {
  if (!isObject(value)) {
    return "the header is not a JSON object";
  }
  if (value.format !== SESSION_LOG_FORMAT) {
    return "not a tentacle session log (no header)";
  }
  if (value.schemaVersion !== SESSION_LOG_VERSION) {
    return `session log schemaVersion ${JSON.stringify(value.schemaVersion)} is not ${SESSION_LOG_VERSION} (written by another tentacle version): update tentacle`;
  }
  if (value.id !== id) {
    return `id ${JSON.stringify(value.id)} does not match the file name`;
  }
  for (const key of ["cwd", "model"]) {
    if (typeof value[key] !== "string") {
      return `"${key}" is not a string`;
    }
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    return '"createdAt" is not a finite number';
  }
  return null;
}

/**
 * The structural minimum of a known entry WITHOUT its schema (`lax`, for the
 * listing): what the fold, the turn tracking and the summary read. The full
 * schema parse runs on `load` of the chosen session.
 */
function laxEntry(value: Record<string, unknown>): KnownLogEntry | null {
  if (typeof value.seq !== "number" || typeof value.id !== "string") {
    return null;
  }
  switch (value.type) {
    case "base":
      return typeof value.count === "number" && typeof value.inc === "string"
        ? (value as unknown as KnownLogEntry)
        : null;
    case "message":
      return isObject(value.message) && typeof value.message.role === "string"
        ? (value as unknown as KnownLogEntry)
        : null;
    case "replace":
      return typeof value.index === "number" && isObject(value.message)
        ? (value as unknown as KnownLogEntry)
        : null;
    case "truncate":
      return typeof value.length === "number" ? (value as unknown as KnownLogEntry) : null;
    case "title":
      return isObject(value.title) && typeof value.title.source === "string"
        ? (value as unknown as KnownLogEntry)
        : null;
    default:
      return value as unknown as KnownLogEntry;
  }
}

interface OpenSegment {
  base: BaseEntry;
  entries: KnownLogEntry[];
  messages: ChatMessage[];
  title?: SessionTitle;
  open: Set<string>;
  started: Set<string>;
  unknown: number;
  start: number;
  owed: number;
  lastSeq: number;
}

/**
 * Parse a log file's text for session `id`. `lax`: known entries are checked
 * structurally only (the listing); default: each by its own schema (`load`).
 */
export function parseLogFile(
  text: string,
  id: string,
  options: { readonly lax?: boolean } = {},
): LogFileResult {
  const contentEnd = text.lastIndexOf("\n") + 1;
  const torn = text.length - contentEnd;
  if (contentEnd === 0) {
    return { ok: false, reason: "no segment (an empty or header-less file)" };
  }
  const segments: LogSegment[] = [];
  let current: OpenSegment | null = null;
  let skipped = 0;
  let duplicates = 0;
  let lastId: string | undefined;
  const seen = new Set<string>();
  let header: LogFileHeader | null = null;
  let lineNo = 0;
  let at = 0;
  const close = (end: number): void => {
    if (current === null) return;
    segments.push({
      base: current.base,
      entries: current.entries,
      messages: current.messages,
      ...(current.title ? { title: current.title } : {}),
      openTurns: [...current.open],
      started: current.started,
      unknown: current.unknown,
      start: current.start,
      end,
    });
    current = null;
  };
  while (at < contentEnd) {
    const nl = text.indexOf("\n", at);
    const line = text.slice(at, nl);
    const lineStart = at;
    at = nl + 1;
    lineNo++;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { ok: false, reason: `line ${lineNo} is not JSON` };
    }
    if (header === null) {
      const problem = headerProblem(value, id);
      if (problem !== null) {
        return { ok: false, reason: problem };
      }
      header = value as unknown as LogFileHeader;
      continue;
    }
    if (!isObject(value) || typeof value.type !== "string") {
      return { ok: false, reason: `line ${lineNo} is not a log entry` };
    }
    const entryId = typeof value.id === "string" ? value.id : undefined;
    if (!KNOWN.has(value.type)) {
      if (value.critical === true) {
        return {
          ok: false,
          reason: `line ${lineNo} is a critical entry of a type this build does not know (${value.type}): update tentacle`,
        };
      }
      if (entryId !== undefined) lastId = entryId;
      skipped++;
      if (current !== null) (current as OpenSegment).unknown++;
      continue;
    }
    let entry: KnownLogEntry | null;
    if (options.lax === true) {
      entry = laxEntry(value);
    } else {
      const parsed = KnownLogEntrySchema.safeParse(value);
      entry = parsed.success ? parsed.data : null;
    }
    if (entry === null) {
      return { ok: false, reason: `line ${lineNo} is a malformed ${value.type} entry` };
    }
    lastId = entry.id;
    if (seen.has(entry.id)) {
      duplicates++;
      continue;
    }
    seen.add(entry.id);
    if (entry.type === "base") {
      if (current !== null && (current as OpenSegment).owed > 0) {
        return { ok: false, reason: `line ${lineNo}: a base still owes messages` };
      }
      close(lineStart);
      current = {
        base: entry,
        entries: [entry],
        messages: [],
        open: new Set(entry.turn ? [entry.turn] : []),
        started: new Set(),
        unknown: 0,
        start: lineStart,
        owed: entry.count,
        lastSeq: entry.seq,
      };
      continue;
    }
    const seg = current as OpenSegment | null;
    if (seg === null) {
      return { ok: false, reason: `line ${lineNo}: an entry before any base` };
    }
    if (entry.seq <= seg.lastSeq) {
      return { ok: false, reason: `line ${lineNo}: seq ${entry.seq} does not grow` };
    }
    seg.lastSeq = entry.seq;
    if (seg.owed > 0) {
      if (entry.type !== "message") {
        return { ok: false, reason: `line ${lineNo}: a base owes ${seg.owed} messages` };
      }
      seg.owed--;
    }
    const problem = projectEntry(seg.messages, entry, (m) => m as ChatMessage);
    if (problem !== null) {
      return { ok: false, reason: `line ${lineNo}: ${problem}` };
    }
    seg.entries.push(entry);
    switch (entry.type) {
      case "title":
        seg.title = entry.title;
        break;
      case "turn_start":
        seg.open.add(entry.turnId);
        break;
      case "turn_end":
        seg.open.delete(entry.turnId);
        break;
      case "call_started":
        seg.started.add(entry.callId);
        break;
      default:
        break;
    }
  }
  if (header === null) {
    return { ok: false, reason: "no segment (an empty or header-less file)" };
  }
  // A last segment whose base still owes messages: a torn append of a
  // compaction batch (keepSuperseded). Dropped; the previous one projects.
  let tornSegment = 0;
  const last = current as OpenSegment | null;
  if (last !== null && last.owed > 0) {
    tornSegment = contentEnd - last.start;
    current = null;
  } else {
    close(contentEnd);
  }
  if (segments.length === 0) {
    return { ok: false, reason: "no segment (a header with no complete base)" };
  }
  return {
    ok: true,
    header,
    segments,
    torn,
    tornSegment,
    skipped,
    duplicates,
    ...(lastId !== undefined ? { lastId } : {}),
    contentEnd,
  };
}

/**
 * The projection THROUGH entry `head` (same `seq` and `id`): the fold of the
 * segment holding it, from its `base` up to and including it — the `serve`
 * loader reads the log only up to the entry its state file names
 * (docs/feat/session-log-serve-store.md §6). `null` when no complete segment
 * holds it, or when it falls inside a base's owed messages (never a capture
 * point): the pair cannot be proven.
 */
export function foldThrough(
  parsed: ParsedLogFile,
  head: { readonly seq: number; readonly id: string },
): ChatMessage[] | null {
  const through = entriesThrough(parsed, head);
  if (through === null) {
    return null;
  }
  const list: ChatMessage[] = [];
  for (const entry of through) {
    if (projectEntry(list, entry, (m) => m as ChatMessage) !== null) {
      return null;
    }
  }
  return list;
}

/**
 * The ENTRIES of the segment holding `head`, from its `base` up to and
 * including it (`foldThrough`'s find loop, shared: the `serve` reload derives
 * its sub-agent notes from the same cut projection it loads). `null` on the
 * same terms as `foldThrough`.
 */
export function entriesThrough(
  parsed: ParsedLogFile,
  head: { readonly seq: number; readonly id: string },
): KnownLogEntry[] | null {
  for (let s = parsed.segments.length - 1; s >= 0; s--) {
    const segment = parsed.segments[s];
    if (segment === undefined) continue;
    const at = segment.entries.findIndex((e) => e.id === head.id);
    if (at < 0) continue;
    // Entries 1..count are the base's owed messages: a head among them is no capture point.
    if (segment.entries[at]?.seq !== head.seq || at < segment.base.count) return null;
    return segment.entries.slice(0, at + 1);
  }
  return null;
}

/** A header line's facts for session `id` (the first line of a log file), or why it is not one. */
export function parseHeaderLine(
  line: string,
  id: string,
):
  | { readonly ok: true; readonly header: LogFileHeader }
  | { readonly ok: false; readonly reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: "line 1 is not JSON" };
  }
  const problem = headerProblem(value, id);
  return problem === null
    ? { ok: true, header: value as LogFileHeader }
    : { ok: false, reason: problem };
}

/** The projection's segment (the last complete one). */
export function currentSegment(parsed: ParsedLogFile): LogSegment {
  const last = parsed.segments[parsed.segments.length - 1];
  if (last === undefined) {
    throw new Error("a parsed log file has at least one segment");
  }
  return last;
}

/**
 * `messages` as a session ended mid-turn keeps them, so the resumed history
 * never stops on a call nobody answered. `started`: the calls the log says
 * START (`call_started`) — each reads "Interrupted", every other unanswered
 * call (queued, asking, not reached) "Not run". `null` (no record of starts):
 * the daemon reload's rule for an ended session (`answerUnansweredCalls`: only
 * the first unanswered call may have started).
 */
export function cutHistory(
  messages: readonly ChatMessage[],
  started: ReadonlySet<string> | null,
): readonly ChatMessage[] {
  const closed = [...messages];
  if (started === null) {
    answerUnansweredCalls(closed, ENDED_NOT_RUN_NOTE, () => ENDED_INTERRUPTED_NOTE);
  } else {
    labelUnansweredCalls(closed, (callId) =>
      started.has(callId) ? ENDED_INTERRUPTED_NOTE : ENDED_NOT_RUN_NOTE,
    );
  }
  // A cut before the model answered: the tail is the prompt or a tool result.
  // A finished turn ends on an assistant message.
  const last = closed.at(-1)?.role;
  if (last === "user" || last === "tool") {
    closed.push({ role: "assistant", content: ENDED_TURN_NOTE });
  }
  return closed;
}

/**
 * The history a LOAD gives (Q11): a turn open at the end of the segment (no
 * `turn_end`) was cut — closed as the save-time cut used to (`call_started`
 * → "Interrupted", the rest "Not run", a tail prompt/result → the note). With
 * no open turn but a trailing call nobody answered (a safety net), the
 * reload's rule. Anything else is returned as it is.
 */
export function closeAtLoad(segment: LogSegment): readonly ChatMessage[] {
  if (segment.openTurns.length > 0) {
    return cutHistory(segment.messages, segment.started);
  }
  const probe = [...segment.messages];
  answerUnansweredCalls(probe, ENDED_NOT_RUN_NOTE, () => ENDED_INTERRUPTED_NOTE);
  return probe.length > segment.messages.length
    ? cutHistory(segment.messages, null)
    : segment.messages;
}

/** The header line (with its `\n`). */
export function headerLine(header: Omit<LogFileHeader, "format" | "schemaVersion">): string {
  const full: LogFileHeader = {
    format: SESSION_LOG_FORMAT,
    schemaVersion: SESSION_LOG_VERSION,
    id: header.id,
    cwd: header.cwd,
    model: header.model,
    createdAt: header.createdAt,
  };
  return `${JSON.stringify(full)}\n`;
}

/** Entries as log lines (each `\n`-terminated). */
export function entryLines(entries: readonly KnownLogEntry[]): string {
  let out = "";
  for (const e of entries) {
    out += `${JSON.stringify(e)}\n`;
  }
  return out;
}

/**
 * A laptop-minted segment for a history with no daemon log (the in-process
 * path, a held copy set aside): `base{create}` + one `message` per message +
 * a `title` for a chosen title. Known types only, with their fixed `critical`
 * values (`LOG_ENTRY_CRITICAL`); no new type.
 */
export function segmentFromMessages(
  messages: readonly ChatMessage[],
  title: SessionTitle | undefined,
  inc: string,
  ts: number,
): KnownLogEntry[] {
  const out: KnownLogEntry[] = [];
  let seq = 1;
  let prev: string | undefined;
  const push = (body: Record<string, unknown>): void => {
    const id = `${inc}/${seq}`;
    out.push({ ...body, seq, id, ...(prev ? { prev } : {}), ts } as KnownLogEntry);
    prev = id;
    seq++;
  };
  push({ type: "base", critical: true, inc, reason: "create", count: messages.length });
  for (const message of messages) {
    push({ type: "message", critical: true, message });
  }
  if (title !== undefined) {
    push({ type: "title", title });
  }
  return out;
}
