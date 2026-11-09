/**
 * The `serve` daemon's state file, `<uid>.state.json`, and how a session is
 * rebuilt from it and its log `<uid>.jsonl` (docs/feat/session-log-serve-store.md).
 * Pure: no I/O, no clock — the persister and the store supply both.
 *
 * The log (`session-log-file.ts`, the laptop's format) holds the committed
 * history; the state file holds everything else a reload needs (the turn and
 * its pending asks, the idempotency keys, the title, the archive stamp) plus
 * the log entry it was captured at (`logHead`) and the OVERLAY: `k`, the
 * length of the prefix the capture shares with the log's projection, and
 * `tail`, the captured messages after it (a prompt accepted but not committed
 * yet; an in-place annotation). The state file is written AFTER the log, so
 * it is the unit's commit marker: a reload folds the log only THROUGH
 * `logHead` (entries after it belong to a capture that never landed). A
 * `logHead` the log does not hold (a crash after a rewrite's rename, before
 * its state file) cannot be paired: the log's last segment is loaded, and the
 * turn is never resumed (`paired: false`, FM 4).
 *
 * Versioned on its own (`DAEMON_STATE_VERSION`), apart from the log's header
 * and the wire: an unknown version is refused and the files are left as they are.
 */
import type { RecordTitle } from "@tentacle/agent";
import { RECORD_TITLE_MAX } from "@tentacle/agent";
import { type ChatMessage, subagentLoadNotes } from "@tentacle/core";
import { ChatMessageSchema, type LogCursor, type ReturnedEntry } from "@tentacle/protocol";
import type {
  DaemonSessionRecord,
  PendingPermission,
  PersistedTurn,
  PersistedTurnKey,
} from "./persisted-session.ts";
import {
  type ParsedLogFile,
  currentSegment,
  entriesThrough,
  foldThrough,
} from "./session-log-file.ts";

/** The state file's `format` tag. */
export const DAEMON_STATE_FORMAT = "tentacle-daemon-state";
/** The state file's own version (separate from the log header's and the wire's). */
export const DAEMON_STATE_VERSION = 1;

/** The state file, as written (compact JSON, one object). */
export interface DaemonSidecar {
  readonly format: typeof DAEMON_STATE_FORMAT;
  readonly schemaVersion: typeof DAEMON_STATE_VERSION;
  readonly id: string;
  /** The log entry this state was captured at: the loader reads the log only through it. */
  readonly logHead: LogCursor;
  /** How many leading messages the capture shares with the log's projection at `logHead`. */
  readonly k: number;
  /** The captured messages after those `k` (the overlay). */
  readonly tail: readonly ChatMessage[];
  readonly lastActiveAt: number;
  /** The last conversation change (never the write time). */
  readonly updatedAt: number;
  /** In the record's form (`encodeTitle`): authoritative for the daemon (the log's `title` entries are for readers). */
  readonly title: string | RecordTitle;
  readonly turns: readonly PersistedTurnKey[];
  readonly enqueueIds: readonly string[];
  readonly returned: readonly ReturnedEntry[];
  readonly turn?: PersistedTurn;
  readonly archivedAt?: number;
  readonly head?: number;
}

/** The length of the prefix `a` and `b` share BY REFERENCE (messages are immutable values). */
export function sharedPrefix(a: readonly ChatMessage[], b: readonly ChatMessage[]): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a[k] === b[k]) k++;
  return k;
}

/** The state file of `record` (its overlay computed against `record.logged`, by reference). */
export function sidecarOf(record: DaemonSessionRecord): DaemonSidecar {
  const k = sharedPrefix(record.logged, record.messages);
  return {
    format: DAEMON_STATE_FORMAT,
    schemaVersion: DAEMON_STATE_VERSION,
    id: record.id,
    logHead: { seq: record.logHead.seq, id: record.logHead.id },
    k,
    tail: record.messages.slice(k),
    lastActiveAt: record.lastActiveAt,
    updatedAt: record.updatedAt,
    title: record.title,
    turns: record.turns,
    enqueueIds: record.enqueueIds,
    returned: record.returned,
    ...(record.turn ? { turn: record.turn } : {}),
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
    ...(record.head !== undefined ? { head: record.head } : {}),
  };
}

/** The state file's text. */
export function encodeSidecar(sidecar: DaemonSidecar): string {
  return `${JSON.stringify(sidecar)}\n`;
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isWireStamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const STOP_REASONS = new Set(["end_turn", "max_tokens", "max_iterations", "cancelled", "error"]);
const RETURN_CAUSES = new Set(["cancelled", "failed", "ended"]);
const TITLE_KEYS = new Set(["text", "source"]);

function turnEndProblem(end: unknown): string | null {
  if (!isObject(end) || typeof end.stopReason !== "string" || !STOP_REASONS.has(end.stopReason)) {
    return "has an invalid end";
  }
  if (end.error !== undefined) {
    const e = end.error;
    if (!isObject(e) || typeof e.message !== "string") {
      return "has an invalid end error";
    }
    if (e.code !== undefined && !Number.isInteger(e.code)) {
      return "has an invalid end error code";
    }
  }
  if (end.delivered !== undefined && typeof end.delivered !== "boolean") {
    return "has an invalid end delivered";
  }
  return null;
}

function pendingEntryOk(p: unknown): p is PendingPermission {
  return (
    isObject(p) &&
    typeof p.toolCallId === "string" &&
    typeof p.tool === "string" &&
    typeof p.resumable === "boolean" &&
    isFiniteNumber(p.requestedAt) &&
    (p.groupStart === undefined || typeof p.groupStart === "string")
  );
}

/** One id per steer, a non-empty pending list, a non-empty `inFlight`: anything else is not ours. */
function turnProblem(turn: unknown): string | null {
  if (!isObject(turn) || typeof turn.turnId !== "string" || !isStringArray(turn.steering)) {
    return '"turn" is malformed';
  }
  if (!isStringArray(turn.steeringIds) || turn.steeringIds.length !== turn.steering.length) {
    return '"turn.steeringIds" is malformed';
  }
  if (
    turn.pending !== undefined &&
    (!Array.isArray(turn.pending) ||
      turn.pending.length === 0 ||
      !turn.pending.every((p) => pendingEntryOk(p)))
  ) {
    return '"turn.pending" is malformed';
  }
  if (
    turn.inFlight !== undefined &&
    (!isStringArray(turn.inFlight) || turn.inFlight.length === 0)
  ) {
    return '"turn.inFlight" is malformed';
  }
  return null;
}

/** A string, or a chosen title with exactly `text` (non-empty, bounded) and `source` model|user. */
function titleProblem(title: unknown): string | null {
  if (typeof title === "string") {
    return null;
  }
  if (!isObject(title)) {
    return '"title" is not a string or a chosen title';
  }
  const extra = Object.keys(title).find((key) => !TITLE_KEYS.has(key));
  if (extra !== undefined) {
    return `"title" has unknown key "${extra}"`;
  }
  if (typeof title.text !== "string" || title.text === "" || title.text.length > RECORD_TITLE_MAX) {
    return '"title" has an invalid text';
  }
  if (title.source !== "model" && title.source !== "user") {
    return '"title" has an invalid source';
  }
  return null;
}

/** Well-formed returned rows (copied), or null. */
function returnedRows(value: unknown): ReturnedEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows: ReturnedEntry[] = [];
  for (const row of value) {
    if (
      !isObject(row) ||
      typeof row.id !== "string" ||
      row.id === "" ||
      typeof row.text !== "string" ||
      row.text === "" ||
      typeof row.cause !== "string" ||
      !RETURN_CAUSES.has(row.cause)
    ) {
      return null;
    }
    rows.push({ id: row.id, text: row.text, cause: row.cause as ReturnedEntry["cause"] });
  }
  return rows;
}

/**
 * Parse a state file's text for session `id`: loud on anything it does not
 * know (another format, an unknown `schemaVersion`, a malformed field) — the
 * caller then leaves both files as they are and never writes them.
 */
export function parseSidecar(text: string, id: string): Result<DaemonSidecar> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the state file is not JSON" };
  }
  if (!isObject(value) || value.format !== DAEMON_STATE_FORMAT) {
    return { ok: false, reason: "not a tentacle daemon state file" };
  }
  if (value.schemaVersion !== DAEMON_STATE_VERSION) {
    return {
      ok: false,
      reason: `state file schemaVersion ${JSON.stringify(value.schemaVersion)} is not ${DAEMON_STATE_VERSION} (written by another tentacle version): update tentacle`,
    };
  }
  if (value.id !== id) {
    return { ok: false, reason: `id ${JSON.stringify(value.id)} does not match the file name` };
  }
  const head = value.logHead;
  if (
    !isObject(head) ||
    !Number.isSafeInteger(head.seq) ||
    (head.seq as number) < 1 ||
    typeof head.id !== "string" ||
    head.id === ""
  ) {
    return { ok: false, reason: '"logHead" is malformed' };
  }
  if (!isWireStamp(value.k)) {
    return { ok: false, reason: '"k" is not a non-negative integer' };
  }
  if (!Array.isArray(value.tail)) {
    return { ok: false, reason: '"tail" is not an array' };
  }
  const tail: ChatMessage[] = [];
  for (const [index, message] of value.tail.entries()) {
    const parsed = ChatMessageSchema.safeParse(message);
    if (!parsed.success) {
      return { ok: false, reason: `tail message ${index} is malformed` };
    }
    tail.push(parsed.data as ChatMessage);
  }
  if (!isFiniteNumber(value.lastActiveAt)) {
    return { ok: false, reason: '"lastActiveAt" is not a finite number' };
  }
  // On the wire as it is (`session/list`, whose client rejects the whole page on one bad entry).
  if (!isWireStamp(value.updatedAt)) {
    return { ok: false, reason: '"updatedAt" is not a non-negative integer' };
  }
  const titleIssue = titleProblem(value.title);
  if (titleIssue !== null) {
    return { ok: false, reason: titleIssue };
  }
  if (!isStringArray(value.enqueueIds)) {
    return { ok: false, reason: '"enqueueIds" is not a string array' };
  }
  if (!Array.isArray(value.turns)) {
    return { ok: false, reason: '"turns" is not an array' };
  }
  for (const [index, key] of value.turns.entries()) {
    if (!isObject(key) || typeof key.turnId !== "string") {
      return { ok: false, reason: `turn key ${index} is malformed` };
    }
    const problem = key.end === undefined ? null : turnEndProblem(key.end);
    if (problem) {
      return { ok: false, reason: `turn key ${index} ${problem}` };
    }
  }
  if (value.turn !== undefined) {
    const problem = turnProblem(value.turn);
    if (problem) {
      return { ok: false, reason: problem };
    }
  }
  const returned = returnedRows(value.returned);
  if (returned === null) {
    return { ok: false, reason: '"returned" is malformed' };
  }
  if (value.archivedAt !== undefined && !isWireStamp(value.archivedAt)) {
    return { ok: false, reason: '"archivedAt" is not a non-negative integer' };
  }
  if (value.head !== undefined && !Number.isInteger(value.head)) {
    return { ok: false, reason: '"head" is malformed' };
  }
  return {
    ok: true,
    value: {
      format: DAEMON_STATE_FORMAT,
      schemaVersion: DAEMON_STATE_VERSION,
      id,
      logHead: { seq: head.seq as number, id: head.id },
      k: value.k,
      tail,
      lastActiveAt: value.lastActiveAt,
      updatedAt: value.updatedAt,
      title: value.title as string | RecordTitle,
      turns: value.turns as PersistedTurnKey[],
      enqueueIds: value.enqueueIds,
      returned,
      ...(value.turn !== undefined ? { turn: value.turn as unknown as PersistedTurn } : {}),
      ...(value.archivedAt !== undefined ? { archivedAt: value.archivedAt } : {}),
      ...(value.head !== undefined ? { head: value.head as number } : {}),
    },
  };
}

/** `index` is an integer naming a user message of `messages`. */
function isUserIndex(messages: readonly ChatMessage[], index: unknown): boolean {
  return Number.isInteger(index) && messages[index as number]?.role === "user";
}

/**
 * The head a state file does not mark (or, unpaired, cannot be trusted to):
 * the reload rule. An IDLE history that is a lone user message after the
 * system prompt may be a just-compacted one (or a first turn that ended with
 * no reply): read it as the summary, so a send-now there is `NoTurnRunning`,
 * never an unasked turn that may run tools. A capture cut short mid-turn has
 * none by this rule.
 */
function legacyHead(messages: readonly ChatMessage[], cutShort: boolean): number | undefined {
  const at = messages[0]?.role === "system" ? 1 : 0;
  return !cutShort && messages.length === at + 1 && messages[at]?.role === "user" ? at : undefined;
}

/**
 * The session `parsed` (its log) and `sidecar` (its state file) reload as, for
 * this daemon's project (`sameProject`). Paired (the log holds `logHead`): the
 * history is the log's projection THROUGH `logHead`, its first `k` messages,
 * then the overlay. Unpaired: the log's last segment as it is, `paired:
 * false` (the turn is then closed, never resumed). A failure names the reason:
 * the caller leaves both files untouched.
 */
export function rebuild(
  parsed: ParsedLogFile,
  sidecar: DaemonSidecar,
  sameProject: (cwd: string) => boolean,
): Result<DaemonSessionRecord> {
  const header = parsed.header;
  if (!sameProject(header.cwd)) {
    return { ok: false, reason: `belongs to another project (${header.cwd})` };
  }
  if (!isWireStamp(header.createdAt)) {
    return { ok: false, reason: '"createdAt" is not a non-negative integer' };
  }
  const through = foldThrough(parsed, sidecar.logHead);
  let logged: readonly ChatMessage[];
  let messages: readonly ChatMessage[];
  let head: number | undefined;
  // The entries the sub-agent notes are derived from: the segment THROUGH
  // `logHead` when paired (a marker after it belongs to a write whose sidecar
  // did not land — ignored, as the whole tail is, FM 17), else the last
  // segment's.
  const derivedFrom =
    through !== null
      ? (entriesThrough(parsed, sidecar.logHead) ?? currentSegment(parsed).entries)
      : currentSegment(parsed).entries;
  if (through !== null) {
    if (sidecar.k > through.length) {
      return {
        ok: false,
        reason: `"k" (${sidecar.k}) is past the log's history (${through.length})`,
      };
    }
    logged = through;
    messages = [...through.slice(0, sidecar.k), ...sidecar.tail];
    if (sidecar.head !== undefined && !isUserIndex(messages, sidecar.head)) {
      return { ok: false, reason: '"head" is malformed' };
    }
    head = sidecar.head ?? legacyHead(messages, sidecar.turn !== undefined);
  } else {
    // FM 4: the capture's history is not provable — the log's own last segment.
    logged = currentSegment(parsed).messages;
    messages = logged;
    head = legacyHead(messages, sidecar.turn !== undefined);
  }
  // The notes a load appends (docs/feat/subagent-ledger-log.md), over the FINAL
  // messages: a note delivered after the last log write is in the sidecar's
  // tail, and closes its id. `reconcileOnReload` appends them.
  const loadNotes = subagentLoadNotes(derivedFrom, messages);
  return {
    ok: true,
    value: {
      id: sidecar.id,
      cwd: header.cwd,
      model: header.model,
      createdAt: header.createdAt,
      updatedAt: sidecar.updatedAt,
      title: sidecar.title,
      messages,
      lastActiveAt: sidecar.lastActiveAt,
      turns: sidecar.turns,
      enqueueIds: sidecar.enqueueIds,
      returned: sidecar.returned,
      ...(sidecar.turn ? { turn: sidecar.turn } : {}),
      ...(sidecar.archivedAt !== undefined ? { archivedAt: sidecar.archivedAt } : {}),
      ...(head !== undefined ? { head } : {}),
      logged,
      logHead: sidecar.logHead,
      paired: through !== null,
      loadNotes,
    },
  };
}
