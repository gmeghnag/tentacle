/**
 * What a `serve` daemon persists per session, and how a record becomes a live
 * session again after a restart (docs/feat/daemon-side-persistence.md). Pure:
 * no I/O, no clock — the persister and the registry supply both.
 *
 * Only `serve` persists (its host is the user's own machine). A pod daemon
 * never does: a record it wrote would be pod-supplied history (AGENTS §7).
 */
import { type SessionRecord, suspendedCalls } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import { DomainErrorCode, type TurnEnd } from "@tentacle/protocol";

export const DAEMON_RECORD_KIND = "tentacle.daemon-session";
/** Version of THIS record's shape, independent of `PROTOCOL_VERSION`. */
export const DAEMON_RECORD_VERSION = 1;

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
}

export interface DaemonSessionRecord extends SessionRecord {
  readonly kind: typeof DAEMON_RECORD_KIND;
  readonly schemaVersion: typeof DAEMON_RECORD_VERSION;
  readonly lastActiveAt: number;
  readonly turns: readonly PersistedTurnKey[];
  readonly enqueueIds: readonly string[];
  readonly turn?: PersistedTurn;
}

/** A live session's state as a record (`title` as the client store derives it). */
export function toDaemonRecord(
  state: DaemonSessionState,
  meta: { readonly cwd: string; readonly model: string; readonly title: string },
  updatedAt: number,
): DaemonSessionRecord {
  return {
    id: state.id,
    cwd: meta.cwd,
    model: meta.model,
    createdAt: state.createdAt,
    updatedAt,
    title: meta.title,
    messages: state.messages,
    kind: DAEMON_RECORD_KIND,
    schemaVersion: DAEMON_RECORD_VERSION,
    lastActiveAt: state.lastActiveAt,
    turns: state.turns,
    enqueueIds: state.enqueueIds,
    ...(state.turn ? { turn: state.turn } : {}),
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

function turnProblem(turn: unknown): string | null {
  if (!isObject(turn) || typeof turn.turnId !== "string" || !isStringArray(turn.steering)) {
    return '"turn" is malformed';
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
  if (value.schemaVersion !== DAEMON_RECORD_VERSION) {
    return {
      ok: false,
      reason: `unsupported record version ${JSON.stringify(value.schemaVersion)} (this daemon reads ${DAEMON_RECORD_VERSION})`,
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
    const problem = turnProblem(value.turn);
    if (problem) {
      return { ok: false, reason: problem };
    }
  }
  return { ok: true, record: record as DaemonSessionRecord };
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
  /** The record's pending entry, kept until the re-ask replaces it. */
  readonly pending: PendingPermission;
}

export interface Reconciled {
  readonly messages: ChatMessage[];
  readonly turns: readonly PersistedTurnKey[];
  readonly enqueueIds: readonly string[];
  /** Present iff the turn is continued instead of closed (the history is then untouched). */
  readonly resume?: ResumedTurn;
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
  return { turnId: turn.turnId, toolCallId: pending.toolCallId, steering: turn.steering, pending };
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
 * have started — calls run in order), the steering queue is kept as user
 * messages, and the turn gets its restart end.
 */
export function reconcileOnReload(record: DaemonSessionRecord): Reconciled {
  const messages = [...record.messages];
  const turn = record.turn;
  if (!turn) {
    return { messages, turns: record.turns, enqueueIds: record.enqueueIds };
  }
  const resume = resumableTurn(record);
  if (resume) {
    return { messages, turns: record.turns, enqueueIds: record.enqueueIds, resume };
  }
  const trailing = trailingCalls(messages);
  if (trailing) {
    let first = true;
    for (const call of trailing.calls) {
      if (trailing.answered.has(call.id)) {
        continue;
      }
      let content = NOT_RUN_NOTE;
      if (first) {
        const pending = turn.pending?.toolCallId === call.id ? turn.pending : undefined;
        content = !pending
          ? INTERRUPTED_NOTE
          : pending.resumable
            ? NOT_RUN_NOTE
            : SUBAGENT_INTERRUPTED_NOTE;
        first = false;
      }
      messages.push({ role: "tool", content, toolCallId: call.id });
    }
  }
  for (const text of turn.steering) {
    messages.push({ role: "user", content: text });
  }
  const turns = record.turns.map((key) =>
    key.turnId === turn.turnId && !key.end ? { turnId: key.turnId, end: RESTART_TURN_END } : key,
  );
  return { messages, turns, enqueueIds: record.enqueueIds };
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
