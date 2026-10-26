/**
 * What a `serve` daemon persists per session, and how a record becomes a live
 * session again after a restart (docs/feat/daemon-side-persistence.md). Pure:
 * no I/O, no clock — the persister and the registry supply both.
 *
 * Only `serve` persists (its host is the user's own machine). A pod daemon
 * never does: a record it wrote would be pod-supplied history (AGENTS §7).
 */
import { type SessionRecord, type TitleState, encodeTitle, suspendedCalls } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import { DomainErrorCode, type ReturnedEntry, type TurnEnd } from "@tentacle/protocol";

export const DAEMON_RECORD_KIND = "tentacle.daemon-session";
/**
 * Version of THIS record's shape, independent of `PROTOCOL_VERSION`. 2 added
 * `archivedAt`: a v1 daemon must refuse an archived record (it would restore
 * it live), never half-load it. A v1 record reads as a v2 one, not archived.
 * 3: `title` may be a chosen title (`{ text, source }`, docs/feat/session-titles.md):
 * a v2 daemon refuses every v3 record instead of dropping a rename at its next
 * write. A v1/v2 record's string title reads as `auto`.
 * 4: the turn's steers keep their enqueue ids (`turn.steeringIds`) and the
 * rows returned to their writer are kept (`returned`,
 * docs/feat/queued-broadcast.md): a v3 daemon refuses a v4 record instead of
 * dropping them at its next write. A v1–v3 record reads with no ids and
 * nothing returned.
 * 5: a tool message may carry `spill` (docs/feat/tui-spill-note.md): a v4
 * daemon refuses every v5 record instead of dropping a spill at its next
 * write. A v1–v4 record reads as a v5 one with no spills.
 * 6: a tool message may carry `durationMs` (docs/fix/tool-duration.md): a v5
 * daemon refuses every v6 record instead of dropping durations at its next
 * write. A v1–v5 record reads as a v6 one with no durations.
 */
export const DAEMON_RECORD_VERSION = 6;
/** Every version `parseDaemonRecord` reads (each read as the current shape). */
const READABLE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, DAEMON_RECORD_VERSION];
/** The first version whose `title` may be a chosen one (`{ text, source }`). */
const CHOSEN_TITLE_VERSION = 3;
/** The first version with steer ids (`turn.steeringIds`) and `returned` rows. */
const STEER_IDS_VERSION = 4;

/** The permission request a turn was suspended on at the write. */
export interface PendingPermission {
  readonly toolCallId: string;
  readonly tool: string;
  /** The request came from that call itself (false: from a sub-agent inside it). */
  readonly resumable: boolean;
  readonly requestedAt: number;
}

/** Present iff a turn was running at the write. */
export interface PersistedTurn {
  readonly turnId: string;
  /** The steering queue, verbatim and in order (accepted, not yet drained). */
  readonly steering: readonly string[];
  /** Each steer's enqueue id, parallel to `steering` (v4; absent in a v1–v3 record). */
  readonly steeringIds?: readonly string[];
  readonly pending?: PendingPermission;
}

/** One accepted turn, by its client key (idempotency of `session/prompt`). */
export interface PersistedTurnKey {
  readonly turnId: string;
  readonly end?: TurnEnd;
}

/** What `HostedSession` hands the persister at each write (captured synchronously). */
export interface DaemonSessionState {
  readonly id: string;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  /** The last conversation change (a turn's start or end, a successful compaction, creation): the record's `updatedAt`. */
  readonly lastChangeAt: number;
  readonly messages: readonly ChatMessage[];
  readonly turns: readonly PersistedTurnKey[];
  readonly enqueueIds: readonly string[];
  readonly turn?: PersistedTurn;
  /** Present iff the session was ended and kept (`SessionHost.archive`): when. */
  readonly archivedAt?: number;
  /** The session's title (absent = `auto`, derived from `messages`). */
  readonly title?: TitleState;
  /** Rows back with their writer until reclaimed (oldest first; absent = none). */
  readonly returned?: readonly ReturnedEntry[];
}

export interface DaemonSessionRecord extends SessionRecord {
  readonly kind: typeof DAEMON_RECORD_KIND;
  readonly schemaVersion: typeof DAEMON_RECORD_VERSION;
  readonly lastActiveAt: number;
  readonly turns: readonly PersistedTurnKey[];
  readonly enqueueIds: readonly string[];
  readonly turn?: PersistedTurn;
  /** Rows back with their writer until reclaimed (v4 always writes it; read as `[]` from v1–v3). */
  readonly returned: readonly ReturnedEntry[];
  /**
   * Present iff ARCHIVED (ended and kept): not restored at start, listed as
   * archived, reloaded by an explicit reopen. Absent → restored live at start.
   */
  readonly archivedAt?: number;
}

/** A live session's state as a record (`title` in the client store's form: `encodeTitle`). */
export function toDaemonRecord(
  state: DaemonSessionState,
  meta: { readonly cwd: string; readonly model: string },
  updatedAt: number,
): DaemonSessionRecord {
  return {
    id: state.id,
    cwd: meta.cwd,
    model: meta.model,
    createdAt: state.createdAt,
    updatedAt,
    title: encodeTitle(state.title ?? { source: "auto" }, state.messages),
    messages: state.messages,
    kind: DAEMON_RECORD_KIND,
    schemaVersion: DAEMON_RECORD_VERSION,
    lastActiveAt: state.lastActiveAt,
    turns: state.turns,
    enqueueIds: state.enqueueIds,
    returned: state.returned ?? [],
    ...(state.turn ? { turn: state.turn } : {}),
    ...(state.archivedAt !== undefined ? { archivedAt: state.archivedAt } : {}),
  };
}

type Parsed =
  | { readonly ok: true; readonly record: DaemonSessionRecord }
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

function turnProblem(turn: unknown, version: number): string | null {
  if (!isObject(turn) || typeof turn.turnId !== "string" || !isStringArray(turn.steering)) {
    return '"turn" is malformed';
  }
  // v4+ always writes one id per steer: anything else is not a record of ours.
  if (
    version >= STEER_IDS_VERSION &&
    (!isStringArray(turn.steeringIds) || turn.steeringIds.length !== turn.steering.length)
  ) {
    return '"turn.steeringIds" is malformed';
  }
  if (turn.pending !== undefined) {
    const p = turn.pending;
    if (
      !isObject(p) ||
      typeof p.toolCallId !== "string" ||
      typeof p.tool !== "string" ||
      typeof p.resumable !== "boolean" ||
      !isFiniteNumber(p.requestedAt)
    ) {
      return '"turn.pending" is malformed';
    }
  }
  return null;
}

/**
 * Check that a record the session store already validated as a `SessionRecord`
 * (ids, metadata, strict messages) is a daemon record of a version we can read,
 * for this daemon's project (`sameProject`: the caller resolves paths — a
 * symlinked cwd is the same project). A failure names the reason; the caller skips the
 * file and never overwrites it (a newer daemon's data survives a downgrade).
 */
export function parseDaemonRecord(
  record: SessionRecord,
  sameProject: (cwd: string) => boolean,
): Parsed {
  const value = record as unknown as Record<string, unknown>;
  if (value.kind !== DAEMON_RECORD_KIND) {
    return {
      ok: false,
      reason: `not a daemon session record (kind ${JSON.stringify(value.kind)})`,
    };
  }
  if (typeof value.schemaVersion !== "number" || !READABLE_VERSIONS.includes(value.schemaVersion)) {
    return {
      ok: false,
      reason: `unsupported record version ${JSON.stringify(value.schemaVersion)} (this daemon reads ${READABLE_VERSIONS.join(", ")})`,
    };
  }
  if (!sameProject(record.cwd)) {
    return { ok: false, reason: `belongs to another project (${record.cwd})` };
  }
  if (!isFiniteNumber(value.lastActiveAt)) {
    return { ok: false, reason: '"lastActiveAt" is not a finite number' };
  }
  // Both go on the wire as they are (`session/list`, whose client rejects the
  // whole page on one bad entry): the store's finite check is not enough.
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (!isWireStamp(value[key])) {
      return { ok: false, reason: `"${key}" is not a non-negative integer` };
    }
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
    const problem = turnProblem(value.turn, value.schemaVersion);
    if (problem) {
      return { ok: false, reason: problem };
    }
  }
  // v1/v2 never wrote a chosen title: an object there is not a record of ours.
  if (value.schemaVersion < CHOSEN_TITLE_VERSION && typeof value.title !== "string") {
    return {
      ok: false,
      reason: `"title" is not a string (record version ${value.schemaVersion})`,
    };
  }
  const returned = value.schemaVersion >= STEER_IDS_VERSION ? returnedRows(value.returned) : [];
  if (returned === null) {
    return { ok: false, reason: '"returned" is malformed' };
  }
  // A v1–v3 turn has no ids, whatever it carries: never read half.
  const turn =
    isObject(value.turn) && value.schemaVersion < STEER_IDS_VERSION
      ? withoutIds(value.turn)
      : value.turn;
  const current: Record<string, unknown> = {
    ...value,
    ...(turn !== undefined ? { turn } : {}),
    returned,
    schemaVersion: DAEMON_RECORD_VERSION,
  };
  if (value.schemaVersion === 1) {
    // v1 had no archive: whatever it carries, it reads as a live record.
    const { archivedAt: _ignored, ...rest } = current;
    return { ok: true, record: rest as unknown as DaemonSessionRecord };
  }
  if (value.archivedAt !== undefined && !isWireStamp(value.archivedAt)) {
    return { ok: false, reason: '"archivedAt" is not a non-negative integer' };
  }
  // A v2 record is a v3 one with an `auto` title; a v3 one a v4 one with no ids, nothing returned.
  return { ok: true, record: current as unknown as DaemonSessionRecord };
}

/** A v4 `returned`: its well-formed rows (copied), or null. */
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

function withoutIds(turn: Record<string, unknown>): Record<string, unknown> {
  const { steeringIds: _ignored, ...rest } = turn;
  return rest;
}

/**
 * Whether a permission request raised while call `currentToolCallId` runs is
 * that call's own (resumable after a restart) rather than a sub-agent's inside
 * it. True iff the tool matches the current call AND the history is exactly
 * suspended before this call (`suspendedCalls` — the same definition the
 * reload and the agent's resume use). A sub-agent's request fails the first
 * check — the parent's current call is `agent_task`, which never asks itself (P7).
 */
export function classifyPending(
  messages: readonly ChatMessage[],
  currentToolCallId: string,
  currentToolName: string,
  requestTool: string,
): boolean {
  return requestTool === currentToolName && suspendedCalls(messages, currentToolCallId) !== null;
}

/** The last assistant message's tool calls and which of them have an answer after it. */
function trailingCalls(
  messages: readonly ChatMessage[],
): { calls: NonNullable<ChatMessage["toolCalls"]>; answered: Set<string> } | null {
  const last = messages.findLastIndex((m) => m.role === "assistant");
  const calls = last >= 0 ? messages[last]?.toolCalls : undefined;
  if (!calls || calls.length === 0) {
    return null;
  }
  const answered = new Set(
    messages
      .slice(last + 1)
      .flatMap((m) => (m.role === "tool" && m.toolCallId !== undefined ? [m.toolCallId] : [])),
  );
  return { calls, answered };
}

/** For a call that was waiting for approval, or queued behind one: it never started. */
export const NOT_RUN_NOTE =
  "Not run: the daemon restarted before this call ran (it was waiting for approval or queued behind one). Ask again if it is still needed.";
/** For the call that was in flight: its side effects may have happened. */
export const INTERRUPTED_NOTE =
  "Interrupted: the daemon restarted while this tool was running; it may or may not have completed. Check before retrying.";
/** For an `agent_task` whose sub-agent was waiting for approval (decision D4). */
export const SUBAGENT_INTERRUPTED_NOTE =
  "Interrupted: the daemon restarted while a sub-agent of this task was waiting for approval; its partial work is lost and may have had side effects. Check before retrying.";

/** `NOT_RUN_NOTE` for a session that was ENDED mid-turn (closed, admin-capped) and archived. */
export const ENDED_NOT_RUN_NOTE =
  "Not run: the session was ended before this call ran (it was waiting for approval or queued behind one). Ask again if it is still needed.";
/** `INTERRUPTED_NOTE` for an ended session. */
export const ENDED_INTERRUPTED_NOTE =
  "Interrupted: the session was ended while this tool was running; it may or may not have completed. Check before retrying.";
/** `SUBAGENT_INTERRUPTED_NOTE` for an ended session. */
export const ENDED_SUBAGENT_INTERRUPTED_NOTE =
  "Interrupted: the session was ended while a sub-agent of this task was waiting for approval; its partial work is lost and may have had side effects. Check before retrying.";

/** The end of a turn its session's close cut short: what the live close streamed. */
export const ARCHIVED_TURN_END: TurnEnd = { stopReason: "cancelled" };

/** The cached end of the turn a restart cut short (a retried `prompt` gets it). */
export const RESTART_TURN_END: TurnEnd = {
  stopReason: "error",
  error: {
    code: DomainErrorCode.DaemonRestarted,
    message: "interrupted: the daemon restarted during this turn",
  },
};

/** A turn the reload continues: suspended on its own call's permission (`reconcileOnReload`). */
export interface ResumedTurn {
  readonly turnId: string;
  /** The call it waits on: asked again, then it and the rest of its round run. */
  readonly toolCallId: string;
  /** Accepted, not yet drained — re-queued, drained where they would have been. */
  readonly steering: readonly string[];
  /** Their enqueue ids, parallel to `steering` (v4); absent from an older record (minted at the reload). */
  readonly steeringIds?: readonly string[];
  /** The record's pending entry, kept until the re-ask replaces it. */
  readonly pending: PendingPermission;
}

export interface Reconciled {
  readonly messages: ChatMessage[];
  readonly turns: readonly PersistedTurnKey[];
  readonly enqueueIds: readonly string[];
  /** Present iff the turn is continued instead of closed (the history is then untouched). */
  readonly resume?: ResumedTurn;
  /** The rows back with their writer, as the record kept them. */
  readonly returned: readonly ReturnedEntry[];
}

/**
 * The turn of `record` that can be continued, if any: suspended on a
 * permission of its OWN call (not a sub-agent's, D4), the history exactly
 * suspended before that call, the call the one that asked, and the turn's key
 * still open. Anything else is closed honestly instead.
 */
function resumableTurn(record: DaemonSessionRecord): ResumedTurn | undefined {
  const turn = record.turn;
  const pending = turn?.pending;
  if (!turn || !pending?.resumable) {
    return undefined;
  }
  const calls = suspendedCalls(record.messages, pending.toolCallId);
  const key = record.turns.find((k) => k.turnId === turn.turnId);
  if (!calls || calls[0]?.name !== pending.tool || !key || key.end) {
    return undefined;
  }
  return {
    turnId: turn.turnId,
    toolCallId: pending.toolCallId,
    steering: turn.steering,
    ...(turn.steeringIds ? { steeringIds: turn.steeringIds } : {}),
    pending,
  };
}

/**
 * Turn a record into the session it reloads as. Without `turn` it is used as
 * is. A turn suspended on its own call's permission (`resumableTurn`) is
 * CONTINUED: the history is untouched and the turn is asked again
 * (docs/feat/suspended-turn-resume.md). Any other turn (the daemon died
 * mid-turn) is closed honestly — nothing is re-run and nothing is denied on
 * the user's behalf:
 * every unanswered call of the trailing assistant message gets a synthetic
 * answer (which one: see the notes above; only the FIRST unanswered call can
 * have started — calls run in order), the steering queue goes back to its
 * writers (v4; an older record keeps it as user messages), and the turn gets
 * its restart end.
 *
 * An ARCHIVED record's turn (`archivedAt`: the session was ENDED mid-turn — a
 * close, the admin cap) is never continued: whoever ended the session ended
 * its turn too, so a pending permission is not asked again. It is closed the
 * same honest way, with the "session was ended" notes and the end the live
 * close streamed (`cancelled`).
 */
export function reconcileOnReload(record: DaemonSessionRecord): Reconciled {
  const messages = [...record.messages];
  const turn = record.turn;
  const returned = record.returned;
  if (!turn) {
    return { messages, turns: record.turns, enqueueIds: record.enqueueIds, returned };
  }
  const ended = record.archivedAt !== undefined;
  const resume = ended ? undefined : resumableTurn(record);
  if (resume) {
    return { messages, turns: record.turns, enqueueIds: record.enqueueIds, resume, returned };
  }
  const notes = ended
    ? {
        notRun: ENDED_NOT_RUN_NOTE,
        interrupted: ENDED_INTERRUPTED_NOTE,
        subagent: ENDED_SUBAGENT_INTERRUPTED_NOTE,
      }
    : { notRun: NOT_RUN_NOTE, interrupted: INTERRUPTED_NOTE, subagent: SUBAGENT_INTERRUPTED_NOTE };
  const trailing = trailingCalls(messages);
  if (trailing) {
    let first = true;
    for (const call of trailing.calls) {
      if (trailing.answered.has(call.id)) {
        continue;
      }
      let content = notes.notRun;
      if (first) {
        const pending = turn.pending?.toolCallId === call.id ? turn.pending : undefined;
        content = !pending ? notes.interrupted : pending.resumable ? notes.notRun : notes.subagent;
        first = false;
      }
      messages.push({ role: "tool", content, toolCallId: call.id });
    }
  }
  const end = ended ? ARCHIVED_TURN_END : RESTART_TURN_END;
  const turns = record.turns.map((key) =>
    key.turnId === turn.turnId && !key.end ? { turnId: key.turnId, end } : key,
  );
  // The undrained steers (owner decision Q2, docs/feat/queued-broadcast.md).
  // A v4 record knows their writers (`turn.steeringIds`, enforced by the
  // parser): they go back to them like a stopped turn's (`returned`, cause
  // `ended`), never into the history — the next prompt, anyone's, must not
  // answer them by surprise. An id already returned is not returned twice.
  // An older record knows no writer: they stay user messages ("delivered,
  // unanswered"). An archived record's turn has `steering: []` (its close
  // already returned them, `HostedSession.archive`).
  const ids = turn.steeringIds;
  if (ids) {
    const known = new Set(returned.map((r) => r.id));
    const back = turn.steering.flatMap((text, i) => {
      const id = ids[i];
      return id === undefined || known.has(id) ? [] : [{ id, text, cause: "ended" as const }];
    });
    return {
      messages,
      turns,
      enqueueIds: record.enqueueIds,
      returned: [...returned, ...back],
    };
  }
  for (const text of turn.steering) {
    messages.push({ role: "user", content: text });
  }
  return { messages, turns, enqueueIds: record.enqueueIds, returned };
}

/**
 * The idle-TTL clock of a reloaded session. Written while idle: its
 * `lastActiveAt` is exact (nothing ended since). Written mid-turn: it was busy
 * until the crash, at an unknown time no later than `now` — so `now`, erring
 * on keeping the session longer, never on destroying it.
 */
export function restoredActivity(record: DaemonSessionRecord, now: number): number {
  return record.turn ? now : record.lastActiveAt;
}
