/**
 * What a `serve` daemon persists per session, and how a record becomes a live
 * session again after a restart (docs/feat/daemon-side-persistence.md; the
 * files: docs/feat/session-log-serve-store.md, `daemon-state-file.ts`). Pure:
 * no I/O, no clock — the persister and the registry supply both.
 *
 * Only `serve` persists (its host is the user's own machine). A pod daemon
 * never does: a record it wrote would be pod-supplied history (AGENTS §7).
 */
import { type SessionRecord, type TitleState, suspendedInGroup } from "@tentacle/agent";
import type { ChatMessage, ToolCall } from "@tentacle/core";
import {
  DomainErrorCode,
  type KnownLogEntry,
  type LogCursor,
  type ReturnedEntry,
  type TurnEnd,
} from "@tentacle/protocol";

/** The permission request a turn was suspended on at the write. */
export interface PendingPermission {
  readonly toolCallId: string;
  readonly tool: string;
  /** The request came from that call itself (false: from a sub-agent inside it). */
  readonly resumable: boolean;
  readonly requestedAt: number;
  /**
   * The first call of the asking call's group: the calls authorized one at a
   * time and then run together. Absent: the call itself.
   */
  readonly groupStart?: string;
}

/** Present iff a turn was running at the write. */
export interface PersistedTurn {
  readonly turnId: string;
  /** The steering queue, verbatim and in order (accepted, not yet drained). */
  readonly steering: readonly string[];
  /** Each steer's enqueue id, parallel to `steering`. */
  readonly steeringIds: readonly string[];
  /** Every unanswered permission request, in request order (non-empty when present). */
  readonly pending?: readonly PendingPermission[];
  /**
   * The calls of a group that may have started: durable BEFORE any of them
   * runs (`HostedSession.beforeRun`), cleared at the group's commit.
   * Non-empty when present. Absent: calls run one at a time.
   */
  readonly inFlight?: readonly string[];
}

/**
 * The session log's part of a capture (docs/feat/session-log-serve-store.md
 * §2), taken synchronously with the rest: the entries derived since the
 * persister's cursor as references (`SessionLog.since`; `entries` builds their
 * wire form LATER, outside the steering window — same bytes), the log's tip,
 * and its projection there.
 */
export interface DaemonLogCapture {
  /** The derived entries after the cursor (from the last `base` when `rebased` or cold). */
  readonly entries: () => KnownLogEntry[];
  readonly head: LogCursor;
  /** The cursor was not retained (another incarnation, evicted): the entries start at a `base`. */
  readonly rebased: boolean;
  /** The log's projection at `head` (never mutated: each derivation replaces it). */
  readonly logged: readonly ChatMessage[];
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
  /** The session log's part (absent: none — e.g. `archive`'s capture after the close, which reuses the one before). */
  readonly log?: DaemonLogCapture;
}

/** The chat `/clear` is about to drop, captured synchronously before the barrier (docs/feat/clear-fork-history.md). */
export interface ClearForkCapture {
  /** From `forkableMessages`. */
  readonly messages: readonly ChatMessage[];
  /** Before the clear's reset. */
  readonly title: TitleState;
  readonly createdAt: number;
  /** The old chat's last change. */
  readonly updatedAt: number;
}

/** A session as the `serve` daemon keeps it (in memory, and on disk as a log + a state file). */
export interface DaemonSessionRecord extends SessionRecord {
  readonly lastActiveAt: number;
  readonly turns: readonly PersistedTurnKey[];
  readonly enqueueIds: readonly string[];
  readonly turn?: PersistedTurn;
  /** Rows back with their writer until reclaimed. */
  readonly returned: readonly ReturnedEntry[];
  /**
   * Present iff ARCHIVED (ended and kept): not restored at start, listed as
   * archived, reloaded by an explicit reopen. Absent → restored live at start.
   */
  readonly archivedAt?: number;
  /**
   * The index in `messages` of the user message the session installed as
   * its head (a compaction's summary, a context reset's restart message),
   * while it is still there. A reload treats it as the summary (a send-now
   * there has nothing to answer), cut short or not. Absent: none.
   */
  readonly head?: number;
  /** The log's projection at `logHead` (`messages` = its first `k` messages + the overlay). */
  readonly logged: readonly ChatMessage[];
  /** The log entry this record pairs with: a reload continues the session's log lineage from it. */
  readonly logHead: LogCursor;
  /**
   * The state file named an entry its log holds. `false` (FM 4: a crash after
   * a rewrite's rename, before its state file): the log's last segment was
   * loaded as it is — the turn is closed, never resumed, and a new lineage starts.
   */
  readonly paired: boolean;
  /**
   * The sub-agent notes a reload APPENDS to the history
   * (docs/feat/subagent-ledger-log.md): what the log's `subagent_*` markers
   * leave open, minus the ids a message already notes. Empty when there is
   * nothing to say, so an idle resume is untouched.
   */
  readonly loadNotes: readonly ChatMessage[];
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
  /** Their enqueue ids, parallel to `steering` (one per steer: the state file always has them). */
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
 * continues from the group's head. Anything else is closed honestly instead —
 * and so is every turn of an UNPAIRED record (`paired: false`: its history is
 * not provably the capture's, so "pending on disk ⇒ never started" cannot be
 * relied on; FM 4 of docs/feat/session-log-serve-store.md).
 */
function resumableTurn(record: DaemonSessionRecord): ResumedTurn | undefined {
  const turn = record.turn;
  const pending = turn?.pending ?? [];
  const first = pending[0];
  if (!turn || !first || turn.inFlight !== undefined || !record.paired) {
    return undefined;
  }
  // A load note cannot go after a suspended turn's unanswered calls (an
  // invalid history, P8), so a turn with one to append is closed honestly
  // instead (owner Q1 (a), docs/feat/subagent-ledger-log.md): the child's
  // death already changed the turn's premises, and the user re-asks.
  if (record.loadNotes.length > 0) {
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
    steeringIds: turn.steeringIds,
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
 * writers, and the turn gets
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
  // The sub-agent notes a load appends (docs/feat/subagent-ledger-log.md): AFTER
  // the closed turn's repair (the history must end on the turn's own notes,
  // never on a note of another topic), and as is when no turn was open. A
  // resumed turn never gets here with any: `resumableTurn` refuses one (Q1 (a)).
  const appendNotes = (): ChatMessage[] =>
    record.loadNotes.length === 0 ? messages : [...messages, ...record.loadNotes];
  if (!turn) {
    return {
      messages: appendNotes(),
      turns: record.turns,
      enqueueIds: record.enqueueIds,
      returned,
    };
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
  // The undrained steers (owner decision Q2, docs/feat/queued-broadcast.md):
  // the record knows their writers (`turn.steeringIds`, enforced by the
  // parser), so they go back to them like a stopped turn's (`returned`, cause
  // `ended`), never into the history — the next prompt, anyone's, must not
  // answer them by surprise. An id already returned is not returned twice. An
  // archived record's turn has `steering: []` (its close already returned
  // them, `HostedSession.archive`).
  const ids = turn.steeringIds;
  const known = new Set(returned.map((r) => r.id));
  const back = turn.steering.flatMap((text, i) => {
    const id = ids[i];
    return id === undefined || known.has(id) ? [] : [{ id, text, cause: "ended" as const }];
  });
  return {
    messages: appendNotes(),
    turns,
    enqueueIds: record.enqueueIds,
    returned: [...returned, ...back],
  };
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
