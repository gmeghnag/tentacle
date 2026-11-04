/**
 * What a `serve` daemon persists per session, and how a record becomes a live
 * session again after a restart (docs/feat/daemon-side-persistence.md). Pure:
 * no I/O, no clock — the persister and the registry supply both.
 *
 * Only `serve` persists (its host is the user's own machine). A pod daemon
 * never does: a record it wrote would be pod-supplied history (AGENTS §7).
 */
import {
  type SessionRecord,
  type TitleState,
  encodeTitle,
  suspendedInGroup,
} from "@tentacle/agent";
import type { ChatMessage, ToolCall } from "@tentacle/core";
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
 * 7: a user/tool message may carry `contextUsage` (docs/feat/context-awareness.md):
 * a v6 daemon refuses every v7 record instead of dropping the model's context
 * lines at its next write. A v1–v6 record reads as a v7 one with no lines.
 * 8 (docs/feat/permission-reply.md): a tool message may carry `denialReply`,
 * and `head` marks the user message this session installed as its head (a
 * compaction's summary, a context reset's restart message — context-reset
 * slice-2 F1), so a reload knows it even in a record cut short mid-turn. A v7
 * daemon refuses every v8 record instead of dropping either. A v1–v7 record
 * reads as a v8 one with no replies and its head by the reload rule
 * (`legacyHead`, which also covers a v8 record that marks none). One version
 * shared with docs/feat/round-groups-persistence.md, which adds its turn
 * fields under the same `V8` gate: `turn.pending` is a LIST (each entry may
 * name its `groupStart`) and `turn.inFlight` names the calls of a group that
 * may have started. A v1–v7 pending object reads as a one-entry list, its
 * group the call itself; a v1–v7 record never has `inFlight`.
 */
export const DAEMON_RECORD_VERSION = 8;
/** Every version `parseDaemonRecord` reads (each read as the current shape). */
const READABLE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, DAEMON_RECORD_VERSION];
/** The first version whose `title` may be a chosen one (`{ text, source }`). */
const CHOSEN_TITLE_VERSION = 3;
/** The first version with steer ids (`turn.steeringIds`) and `returned` rows. */
const STEER_IDS_VERSION = 4;
/** The first version that marks the installed head (`head`) — and the version of every v8 field. */
const V8 = 8;

/** The permission request a turn was suspended on at the write. */
export interface PendingPermission {
  readonly toolCallId: string;
  readonly tool: string;
  /** The request came from that call itself (false: from a sub-agent inside it). */
  readonly resumable: boolean;
  readonly requestedAt: number;
  /**
   * The first call of the asking call's group (v8): the calls authorized one
   * at a time and then run together. Absent: the call itself.
   */
  readonly groupStart?: string;
}

/** Present iff a turn was running at the write. */
export interface PersistedTurn {
  readonly turnId: string;
  /** The steering queue, verbatim and in order (accepted, not yet drained). */
  readonly steering: readonly string[];
  /** Each steer's enqueue id, parallel to `steering` (v4; absent in a v1–v3 record). */
  readonly steeringIds?: readonly string[];
  /** Every unanswered permission request, in request order (non-empty when present). */
  readonly pending?: readonly PendingPermission[];
  /**
   * The calls of a group that may have started (v8): durable BEFORE any of
   * them runs (`HostedSession.beforeRun`), cleared at the group's commit.
   * Non-empty when present. Absent: calls run one at a time.
   */
  readonly inFlight?: readonly string[];
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
  /** The installed head's index in `messages` (absent = none in the history now). */
  readonly head?: number;
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
  /**
   * v8: the index in `messages` of the user message the session installed as
   * its head (a compaction's summary, a context reset's restart message),
   * while it is still there. A reload treats it as the summary (a send-now
   * there has nothing to answer), cut short or not. Absent: none.
   */
  readonly head?: number;
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
    ...(state.head !== undefined ? { head: state.head } : {}),
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
  // v8 writes the list (round groups); v1–v7 one object, never a group.
  if (turn.pending !== undefined) {
    const list = version >= V8 ? turn.pending : [turn.pending];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      !list.every((p) => pendingEntryOk(p, version >= V8))
    ) {
      return '"turn.pending" is malformed';
    }
  }
  if (
    turn.inFlight !== undefined &&
    (version < V8 || !isStringArray(turn.inFlight) || turn.inFlight.length === 0)
  ) {
    return '"turn.inFlight" is malformed';
  }
  return null;
}

function pendingEntryOk(p: unknown, groups: boolean): boolean {
  return (
    isObject(p) &&
    typeof p.toolCallId === "string" &&
    typeof p.tool === "string" &&
    typeof p.resumable === "boolean" &&
    isFiniteNumber(p.requestedAt) &&
    (p.groupStart === undefined || (groups && typeof p.groupStart === "string"))
  );
}

/** A turn as the current version holds it: a v1–v3 one without ids, a v1–v7 pending as a list. */
function currentTurn(turn: Record<string, unknown>, version: number): Record<string, unknown> {
  const ided = version < STEER_IDS_VERSION ? withoutIds(turn) : turn;
  return version < V8 && ided.pending !== undefined ? { ...ided, pending: [ided.pending] } : ided;
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
  // A v1–v3 turn has no ids, whatever it carries: never read half. A v1–v7
  // pending object is the one-entry list v8 writes.
  const turn = isObject(value.turn) ? currentTurn(value.turn, value.schemaVersion) : value.turn;
  // The marked head (v8), else the old rule — which stays for every version:
  // its idle `[system?, user]` reading is a decision of its own (no unasked
  // turn after a reload), not only a stand-in for the missing mark.
  if (
    value.schemaVersion >= V8 &&
    value.head !== undefined &&
    !isUserIndex(record.messages, value.head)
  ) {
    return { ok: false, reason: '"head" is malformed' };
  }
  const marked = value.schemaVersion >= V8 ? (value.head as number | undefined) : undefined;
  const head = marked ?? legacyHead(record.messages, value.turn !== undefined);
  // Only a v8+ `head` is read: an older record's is derived, never taken.
  const { head: _raw, ...fields } = value;
  const current: Record<string, unknown> = {
    ...fields,
    ...(turn !== undefined ? { turn } : {}),
    returned,
    ...(head !== undefined ? { head } : {}),
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

/** `index` is an integer naming a user message of `messages`. */
function isUserIndex(messages: readonly ChatMessage[], index: unknown): boolean {
  return Number.isInteger(index) && messages[index as number]?.role === "user";
}

/**
 * The head a record does not mark (any v1–v7 record; a v8 one with no
 * `head`): the reload rule. An IDLE history that is a lone user message after
 * the system prompt may be a just-compacted one (or a first turn that ended
 * with no reply): read it as the summary, so a send-now there is
 * `NoTurnRunning`, never an unasked turn that may run tools. A record cut
 * short mid-turn has none by this rule (a reset's restart message there is
 * what v8's mark adds: context-reset slice-2 F1).
 */
function legacyHead(messages: readonly ChatMessage[], cutShort: boolean): number | undefined {
  const at = messages[0]?.role === "system" ? 1 : 0;
  return !cutShort && messages.length === at + 1 && messages[at]?.role === "user" ? at : undefined;
}

function withoutIds(turn: Record<string, unknown>): Record<string, unknown> {
  const { steeringIds: _ignored, ...rest } = turn;
  return rest;
}

/**
 * Whether a permission request attributed to call `toolCallId` is resumable
 * after a restart: the call asked for ITSELF (`origin: "call"`, never a
 * sub-agent inside it, D4), the history is exactly suspended before its
 * group's head with that call among the calls still to run
 * (`suspendedInGroup` — the same definition the reload uses; the agent's
 * resume checks the head with `suspendedCalls`), and that call is the asked
 * tool. Explicit, from the requester's options
 * (docs/feat/permission-call-attribution.md); no attribution → false.
 * `groupStart` absent → the call itself (a call alone).
 */
export function classifyPending(
  messages: readonly ChatMessage[],
  toolCallId: string | undefined,
  origin: "call" | "subagent" | undefined,
  requestTool: string,
  groupStart?: string,
): boolean {
  return (
    origin === "call" &&
    toolCallId !== undefined &&
    askingCall(messages, groupStart ?? toolCallId, toolCallId)?.name === requestTool
  );
}

/** The asking call when the history is suspended inside its group (`suspendedInGroup`), else undefined. */
function askingCall(
  messages: readonly ChatMessage[],
  groupStart: string,
  toolCallId: string,
): ToolCall | undefined {
  return suspendedInGroup(messages, groupStart, toolCallId)?.find((c) => c.id === toolCallId);
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

/**
 * Close a history a turn was cut in (appends to `messages`): every unanswered
 * call of the trailing assistant message gets a synthetic answer. Only the
 * FIRST unanswered call can have started (calls run in order): `firstNote`
 * says what it gets (by its call id); the rest get `notRun`. The reload's
 * rule, shared with a laptop copy saved while the session was ended under a
 * running turn (docs/fix/detach-live.md Q2).
 */
export function answerUnansweredCalls(
  messages: ChatMessage[],
  notRun: string,
  firstNote: (callId: string) => string,
): void {
  labelUnansweredCalls(messages, (callId, first) => (first ? firstNote(callId) : notRun));
}

/**
 * The general form of `answerUnansweredCalls`: each unanswered call of the
 * trailing assistant message gets `noteFor(its id, whether it is the first
 * unanswered one)`, in call order (docs/feat/round-groups-persistence.md: a
 * group's calls may all have started, so the first is not the only one).
 */
export function labelUnansweredCalls(
  messages: ChatMessage[],
  noteFor: (callId: string, first: boolean) => string,
): void {
  const trailing = trailingCalls(messages);
  if (!trailing) {
    return;
  }
  let first = true;
  for (const call of trailing.calls) {
    if (trailing.answered.has(call.id)) {
      continue;
    }
    messages.push({ role: "tool", content: noteFor(call.id, first), toolCallId: call.id });
    first = false;
  }
}

/**
 * The tail of a history a turn was cut in before it answered (the model was
 * still streaming, or its next call had not come back): the history would end
 * on the user's prompt or a tool result, with no sign the turn was interrupted.
 */
export const ENDED_TURN_NOTE =
  "Interrupted: the session was ended before this turn finished answering.";

/** What a failed turn's history ends on: its cause as the wire carries it (`redactTurnError`). */
export function failedTurnNote(cause: string): string {
  return `Failed: ${cause}. The turn stopped here; the reply above, if any, is incomplete.`;
}

/**
 * Close the history of a turn that failed (in place), so a client that
 * attaches or resumes later sees how it ended (docs/fix/detach-live.md round
 * 10, owner B): the partial reply the agent kept gets the note appended; a
 * history ending on the prompt or a tool result gets the note as the
 * assistant's answer. A trailing call nobody answered is left to the reload's
 * rule (`answerUnansweredCalls`). One assistant message either way: the roles
 * keep alternating.
 */
export function closeFailedTurn(messages: ChatMessage[], cause: string): void {
  const note = failedTurnNote(cause);
  const at = messages.length - 1;
  const last = messages[at];
  if (last?.role === "assistant" && (last.toolCalls?.length ?? 0) === 0) {
    messages[at] = { ...last, content: last.content !== "" ? `${last.content}\n\n${note}` : note };
  } else if (last?.role === "user" || last?.role === "tool") {
    messages.push({ role: "assistant", content: note });
  }
}

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
  /**
   * The first call it continues from — the asking call's group head (the
   * asking call itself when it was alone): it and every later call of the
   * round are asked again, then run.
   */
  readonly from: string;
  /** Accepted, not yet drained — re-queued, drained where they would have been. */
  readonly steering: readonly string[];
  /** Their enqueue ids, parallel to `steering` (v4); absent from an older record (minted at the reload). */
  readonly steeringIds?: readonly string[];
  /** The record's pending entries, each kept until its call's re-ask replaces it. */
  readonly pending: readonly PendingPermission[];
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
 * The turn of `record` that can be continued, if any: no call of it may have
 * started (no `inFlight`), and every pending request is of its OWN call (not
 * a sub-agent's, D4), all in ONE group, the history exactly suspended before
 * that group's head with each asking call among the calls still to run and
 * named as asked (`suspendedInGroup`), and the turn's key still open. It
 * continues from the group's head. Anything else is closed honestly instead.
 */
function resumableTurn(record: DaemonSessionRecord): ResumedTurn | undefined {
  const turn = record.turn;
  const pending = turn?.pending ?? [];
  const first = pending[0];
  if (!turn || !first || turn.inFlight !== undefined) {
    return undefined;
  }
  const from = first.groupStart ?? first.toolCallId;
  const key = record.turns.find((k) => k.turnId === turn.turnId);
  const ok = pending.every(
    (p) =>
      p.resumable &&
      (p.groupStart ?? p.toolCallId) === from &&
      askingCall(record.messages, from, p.toolCallId)?.name === p.tool,
  );
  if (!ok || !key || key.end) {
    return undefined;
  }
  return {
    turnId: turn.turnId,
    from,
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
 * answer (which one: see the notes above; the calls that may have started are
 * the record's `inFlight` group, else only the FIRST unanswered call — calls
 * run in order), the steering queue goes back to its
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
  // Which calls may have started: a group's `inFlight` set when the record has
  // one (durable before any of them ran), else only the first unanswered call
  // (calls run one at a time). A call that may have started is "Interrupted" —
  // with the sub-agent note when a sub-agent of it was asking — unless its own
  // ask was pending and no group was running (then it never started).
  const inFlight = turn.inFlight;
  labelUnansweredCalls(messages, (callId, first) => {
    if (!(inFlight ? inFlight.includes(callId) : first)) {
      return notes.notRun;
    }
    const pending = turn.pending?.find((p) => p.toolCallId === callId);
    if (!pending) {
      return notes.interrupted;
    }
    return !pending.resumable ? notes.subagent : inFlight ? notes.interrupted : notes.notRun;
  });
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
