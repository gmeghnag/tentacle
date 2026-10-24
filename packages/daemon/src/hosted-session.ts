/**
 * A single hosted conversation on the daemon: wraps the agent `Session`, drives
 * one turn at a time, fans every `session/update` out to the attached clients,
 * suspends a turn on a permission request until a client answers it, and keeps
 * every update in a byte-bounded replay ring (seq-numbered, never reset per turn).
 *
 * The session belongs to the daemon (`SessionHost`), not to a connection: a
 * client ATTACHES (replay of what it missed + live, in one synchronous step, so
 * nothing falls between them) and DETACHES when its connection drops; the turn
 * keeps running. Only `close` ends the session.
 *
 * A turn lives in the stream, not in a request: `prompt` acks at once, the turn
 * is bracketed by `turn_start`/`turn_end` updates, and `prompt`/`enqueue` are
 * idempotent by their client-chosen keys (a retry never runs or injects twice).
 *
 * A turn and a compaction are mutually exclusive: both hold the one busy slot
 * (`controller`), and a request that finds it taken is REJECTED — never queued,
 * never locked (AGENTS §7: the peer dispatches requests concurrently).
 *
 * A permission request is session STATE, not a request to one client: the ask
 * is streamed as `permission_request` (to every attached client; while it is
 * pending it sits past the cut, which cannot move while the agent is blocked on
 * it, so the ring never evicts it and every attach that replays from the cut or
 * from a `since` before it — a fresh open, a resync — gets it again; a `since`
 * at or past it gets only what came after, by design) and settled by
 * the FIRST of: a valid `resolvePermission` from any client, or the turn's abort
 * (cancel, close, model-proxy detach) → `cancelled`. No timer, no socket event,
 * nobody-attached ever settles it: the daemon makes no decision of its own
 * (docs/feat/permission-events.md).
 *
 * Recovery is snapshot + replay at a consistent CUT `{epoch, seq, length}`:
 * `history[0, length)` reflects every update with `seq <= cut.seq`, and the
 * ring replays the rest. The cut moves only where that holds — at the agent's
 * `history_commit` markers, at turn end, and at a compaction (new epoch) — and
 * the snapshot is SLICED to `length`, so a cut that lags behind the history is
 * still exact: what was pushed after it is replayed, never doubled or lost.
 * Sound because the history is append-only past any cut within an epoch (the
 * agent's one `pop` is never behind a marker; compaction starts a new epoch).
 */
import { type AgentEvent, type AskHooksTrust, type Session, sessionTitle } from "@tentacle/agent";
import type {
  ChatMessage,
  JobController,
  PermissionBroker,
  PermissionRequest,
  PermissionResponse,
} from "@tentacle/core";
import {
  BLOCKING_UPDATE_TYPES,
  type HistoryCut,
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  type PermissionOutcome,
  type PromptResult,
  type SendNowMessage,
  type SendNowRefusal,
  type SendNowTarget,
  type SessionUpdate,
  type SnapshotResult,
  type TurnEnd,
  type TurnError,
  clientSupportsUpdate,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import {
  assertTextOnly,
  contentToText,
  eventToUpdate,
  frameFor,
  stopReasonToProtocol,
  toUpdateParams,
} from "./mapping.ts";
import { outcomeToResponse, toPermissionRequestUpdate } from "./permission-map.ts";
import {
  type DaemonSessionState,
  type PendingPermission,
  type PersistedTurnKey,
  type ResumedTurn,
  classifyPending,
} from "./persisted-session.ts";
import { SessionRing } from "./ring.ts";
import type { SessionSummary } from "./session-list.ts";
import type { SessionPersister } from "./session-persister.ts";
import type { SessionLiveness } from "./session-reaper.ts";

/** Receives each streamed `session/update` (one per emitted update). Synchronous; never awaited. */
export type UpdateSink = (params: KnownSessionUpdateParams) => void;

/** One client attached to a session (one per connection that opened it). */
export interface Attachment {
  readonly send: UpdateSink;
  /**
   * The update types its client declared at `initialize` (protocol 10);
   * absent = the v10 base set. Gates BLOCKING types (`BLOCKING_UPDATE_TYPES`).
   */
  readonly updates?: readonly string[];
}

/** A permission request waiting for its first answer (keyed by its nonce). */
interface PendingAsk {
  readonly offered: ReadonlySet<string>;
  /** Streamed to the clients yet (only once its record is durable). */
  shown: boolean;
  /**
   * Resolve the gate's wait with this outcome (detaches the abort listener);
   * `reason`: nobody could answer (the gate tells the model why).
   */
  readonly settle: (outcome: PermissionOutcome, reason?: string) => void;
}

/**
 * Default replay budget per session: ≈ 5 p99 turns of real sessions
 * (calibration in docs/eval/session-event-stream.md §3c).
 */
export const DEFAULT_RING_BYTES = 4 * 1024 * 1024;

/** The answer to "replay me everything after `since`". */
export type ReplayResult =
  | { readonly replay: readonly KnownSessionUpdateParams[] }
  | { readonly resync: true };

/** A consistent cut of the stream (see the module comment). */
interface Cut {
  readonly epoch: string;
  readonly seq: number;
  readonly length: number;
  /** The turn running at the cut, if any (its `turn_start` is at or before `seq`). */
  readonly turnId: string | null;
}

/**
 * A `session/send_now` accepted while its target unwinds: the turn it starts
 * once the slot is free (`settleSuccessor`). Memory only — never on disk, never
 * in `turns`, before it starts (docs/feat/send-now-a.md).
 */
interface Successor {
  readonly turnId: string;
  readonly messages: readonly SendNowMessage[];
  /** `session/enqueue`s bound to the successor's own `turnId` while it waits. */
  readonly steers: { readonly id: string; readonly text: string }[];
  /** A cancel (or close) landed first: it ends without starting. */
  cancelled: boolean;
  readonly askHooksTrust?: AskHooksTrust;
}

/** What a reloaded session brings back besides its history (`SessionHost.restore`). */
export interface RestoredSessionState {
  readonly createdAt: number;
  readonly lastActiveAt: number;
  /** The last conversation change: the record's `updatedAt`, or the reload itself. */
  readonly lastChangeAt: number;
  readonly turns: readonly PersistedTurnKey[];
  readonly enqueueIds: readonly string[];
  /** A turn suspended on a permission at the restart: it runs again (re-asked). */
  readonly resume?: ResumedTurn;
  /** The record had a turn in flight (cut short, or resumed): its history is not a summary. */
  readonly cutShort: boolean;
}

/**
 * `serve` only: the session writes itself at every committed boundary (see
 * `SessionPersister`). Absent on a pod daemon and the in-process worker — no
 * persister, no write, structurally.
 */
export interface SessionPersistence {
  readonly persister: SessionPersister;
  readonly restored?: RestoredSessionState;
}

/** How a failed turn's error leaves the daemon (see `redactTurnError`). */
export interface TurnErrorPolicy {
  /**
   * Put the real message of a non-`RpcError` turn failure in `turn_end.error`.
   * Only for a LOCAL, trusted client (the in-process worker): a provider error
   * can carry endpoint or key material. Default: "internal error".
   */
  readonly exposeTurnErrors?: boolean;
  /** Receives every turn failure, unredacted — never silent. */
  readonly onTurnError?: (error: Error) => void;
}

/** The wire form of a turn failure: same policy as the peer's handler errors. */
export function redactTurnError(error: unknown, expose: boolean): TurnError {
  if (error instanceof RpcError) {
    return { code: error.code, message: error.message };
  }
  if (expose) {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message || "internal error" };
  }
  return { message: "internal error" };
}

/**
 * Settles at the first of `done` settling or `signal` aborting (at once if it
 * already has). Never rejects; drops its abort listener when it settles.
 */
export function untilAborted(done: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    done.then(finish, finish);
  });
}

export class HostedSession {
  readonly id: string;
  private readonly session: Session;
  /** The busy slot: the active turn's OR compaction's controller (`cancel` aborts it). */
  private controller: AbortController | null = null;
  /** Which operation holds the slot: true for a compaction. */
  private compacting = false;
  private activeTurnId: string | null = null;
  /** Every turn this session accepted, by client `turnId`, for its lifetime (retries). */
  private readonly turns = new Map<string, { end?: TurnEnd }>();
  /**
   * The turns `session/send_now` started (memory only): their end carries
   * `delivered: true`. An unstarted one ends `delivered: false` (`endUnstarted`).
   */
  private readonly sendNowTurns = new Set<string>();
  /** Every accepted `enqueue` id, for its lifetime (retries). */
  private readonly enqueued = new Set<string>();
  /**
   * Parallel to the agent's steering queue, in order: each entry's enqueue id
   * (`undefined`: a resumed turn's restored steer — ids are not on disk).
   * Shifted on every `steer` the turn streams (one per drained text).
   */
  private steeringIds: (string | undefined)[] = [];
  /** Enqueue ids injected into the history (drained) in this incarnation. */
  private readonly drained = new Set<string>();
  /** Enqueue ids a previous incarnation accepted: their text is in the history already. */
  private readonly restoredIds = new Set<string>();
  /** The send-now waiting for the slot (see `Successor`). */
  private successor: Successor | null = null;
  /**
   * The summary message the last compaction installed (the object itself:
   * `awaitsAnswer` compares identity). Any later message makes it no longer
   * the tail, so it never needs clearing. Memory only; see the constructor
   * for a reload.
   */
  private compactionSummary: ChatMessage | undefined;
  private readonly errorPolicy: TurnErrorPolicy;
  private currentToolCallId = "";
  private currentToolName = "";
  /** The permission request the turn is suspended on (persisted with the turn). */
  private pending: PendingPermission | undefined;
  /** Every unanswered ask, by `requestId` (one at a time today: calls run in order). */
  private readonly asks = new Map<string, PendingAsk>();
  private readonly persister: SessionPersister | null;
  private readonly createdAt: number;
  private seq = 0;
  private readonly ring: SessionRing<KnownSessionUpdateParams>;
  /** Seq of the barrier that opened the current epoch (0 for the first). */
  private epochStart = 0;
  private cut: Cut;
  /** Insertion-ordered: the last one is the most recently attached. */
  private readonly attachments = new Set<Attachment>();
  private closed = false;
  private readonly jobs: JobController | undefined;
  private readonly unsubscribeExit: (() => void) | undefined;
  private readonly now: () => number;
  /** Liveness stamps for the reaper (meaning: `SessionLiveness`). */
  private lastActiveAt: number;
  private lastDetachAt: number;
  /**
   * The last change of the CONVERSATION — a turn's start (once accepted) or
   * end, a SUCCESSFUL compaction, or creation — and `session/list`'s
   * `updatedAt` as is. Never moved by an attach, a detach, a view, an answer,
   * a refused prompt or a failed compaction: unlike `lastActiveAt` (the TTL).
   */
  private lastChangeAt: number;

  constructor(
    id: string,
    session: Session,
    permissions: PermissionBroker,
    jobs?: JobController,
    errorPolicy: TurnErrorPolicy = {},
    ringBytes: number = DEFAULT_RING_BYTES,
    now: () => number = Date.now,
    persistence?: SessionPersistence,
  ) {
    this.id = id;
    this.now = now;
    const restored = persistence?.restored;
    this.persister = persistence?.persister ?? null;
    this.createdAt = restored?.createdAt ?? now();
    this.lastActiveAt = restored?.lastActiveAt ?? now();
    this.lastDetachAt = this.lastActiveAt;
    this.lastChangeAt = restored?.lastChangeAt ?? now();
    for (const key of restored?.turns ?? []) {
      this.turns.set(key.turnId, key.end ? { end: key.end } : {});
    }
    for (const enqueueId of restored?.enqueueIds ?? []) {
      this.enqueued.add(enqueueId);
      this.restoredIds.add(enqueueId);
    }
    // A reload lost the summary's identity. An IDLE record whose history is a
    // lone user message after the system prompt may be a just-compacted one
    // (or a first turn that ended with no reply): read it as the summary, so a
    // send-now there is `NoTurnRunning`, never an unasked turn that may run
    // tools. A record cut short mid-turn is never a summary (it continues).
    if (restored && !restored.cutShort) {
      const history = session.messages;
      const at = history[0]?.role === "system" ? 1 : 0;
      if (history.length === at + 1 && history[at]?.role === "user") {
        this.compactionSummary = history[at];
      }
    }
    this.session = session;
    this.jobs = jobs;
    this.errorPolicy = errorPolicy;
    this.ring = new SessionRing(ringBytes);
    const resume = restored?.resume;
    // A fresh epoch per incarnation (decision D1): a `since` from a previous
    // session under the same id never matches. The seed (resume) is covered.
    // A resumed turn is running AT the cut: its prompt is already in the
    // history, so it streams no `turn_start` (a replay would show the prompt
    // twice) — the snapshot's `turn` says it is running.
    this.cut = {
      epoch: crypto.randomUUID(),
      seq: 0,
      length: session.messages.length,
      turnId: resume?.turnId ?? null,
    };
    // The agent's permission gate asks here (the factory's broker, replaced
    // synchronously before any turn can run): the turn suspends until a client
    // answers or the turn is aborted. See the module comment.
    permissions.setRequester((req) => this.awaitDecision(req));
    // A background job can exit while the session is idle (between turns), so we
    // stream the exit the moment it happens — not only at the next turn, where
    // the agent injects a note for the model. The client renders it like a local
    // job-exit notice; the TUI dedupes by job id against that next-turn event.
    this.unsubscribeExit = jobs?.onExit((job) => {
      this.emit({
        type: "background_exit",
        jobId: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
      });
    });
    // A turn suspended at the restart is running again (it holds the slot)
    // BEFORE the first write below, with its steers queued and its old pending
    // entry kept: that write must still read "suspended on this call" — never
    // "idle" over a history with unanswered calls, never "in flight".
    if (resume) {
      for (const text of resume.steering) {
        session.enqueue(text);
        this.steeringIds.push(undefined);
      }
      this.controller = new AbortController();
      this.activeTurnId = resume.turnId;
      this.turns.set(resume.turnId, {});
      this.pending = resume.pending;
    }
    // On disk from the start: a session seeded by `open{messages}` (or one
    // just reloaded and reconciled) survives a restart before its next turn.
    this.persist();
    // Last: every field is set. The call is asked again through the normal
    // requester (a new request id); no state holds the slot without a driver.
    if (resume && this.controller) {
      void this.drive(
        resume.turnId,
        session.resume(resume.toolCallId, this.controller.signal),
        this.controller,
      );
    }
  }

  /**
   * Suspend the asking tool call until the first of: a valid answer
   * (`resolvePermission`) or the turn's abort (`cancelled`). Persisted
   * (serve): the suspension is DURABLE before the request is streamed — a
   * request a person saw survives a restart (the reload asks it again) — and
   * cleared durably once it settles, BEFORE the gate may run the tool — so
   * "pending" on disk always means "never started" (never run twice).
   */
  private awaitDecision(req: PermissionRequest): Promise<PermissionResponse> {
    const signal = this.compacting ? undefined : this.controller?.signal;
    if (!signal || signal.aborted) {
      // No live turn to ask for: a cancel landed between `tool_start` and the
      // ask. Nobody is prompted and the tool does not run (the agent records
      // it as cancelled) — not a decision: there is no turn to approve for.
      return Promise.resolve(outcomeToResponse({ outcome: "cancelled" }));
    }
    // A blocking update only to a session one of whose clients can answer it
    // (docs/feat/protocol-v10-forward-compat.md): otherwise refuse at once,
    // with the reason the model sees — never suspend on a client that cannot
    // show it. Nobody attached: unchanged (held for a client to attach).
    const unsupported = this.blockingUnsupported("permission_request");
    if (unsupported !== undefined) {
      return Promise.resolve({ allowed: false, reason: unsupported });
    }
    const requestId = crypto.randomUUID();
    const update = toPermissionRequestUpdate(requestId, this.currentToolCallId || "pending", req);
    const record: PendingPermission = {
      toolCallId: this.currentToolCallId,
      tool: req.tool,
      resumable: classifyPending(
        this.session.messages,
        this.currentToolCallId,
        this.currentToolName,
        req.tool,
      ),
      requestedAt: this.now(),
    };
    const decided = new Promise<{ outcome: PermissionOutcome; reason?: string }>((resolve) => {
      const onAbort = (): void => this.settle(requestId, { outcome: "cancelled" });
      this.asks.set(requestId, {
        offered: new Set(update.options.map((o) => o.optionId)),
        shown: false,
        settle: (outcome, reason) => {
          signal.removeEventListener("abort", onAbort);
          resolve(reason !== undefined ? { outcome, reason } : { outcome });
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.pending = record;
    this.persist();
    // Shown once on disk (`persisted` never rejects: a failed write is logged
    // and the request is shown anyway — the daemon decides nothing itself). An
    // ask settled meanwhile (a cancel) was never seen: nothing is streamed.
    void this.persisted().then(() => {
      const ask = this.asks.get(requestId);
      if (!ask) {
        return;
      }
      ask.shown = true;
      try {
        this.emit(update);
      } catch (error) {
        this.reportTurnError(error);
      }
    });
    return decided.then(async ({ outcome, reason }) => {
      if (this.pending === record) {
        this.pending = undefined;
        this.persist();
        // The turn's abort ends this wait: a hung disk must never trap a cancel
        // (docs/fix/cancel-hung-disk.md). Safe: the agent checks the abort
        // before the answer (agent.ts `runTool`), so an aborted turn never runs
        // the tool and "pending on disk ⇒ never started" still holds.
        await untilAborted(this.persisted(), signal);
      }
      return reason !== undefined ? { allowed: false, reason } : outcomeToResponse(outcome);
    });
  }

  /**
   * Why a BLOCKING update `type` cannot be answered — some client is attached
   * and none declared it — or undefined (one can, or none is attached: then
   * the ask waits for a client, the owner's exception; a cancel settles it).
   */
  private blockingUnsupported(type: SessionUpdate["type"]): string | undefined {
    if (!BLOCKING_UPDATE_TYPES.has(type) || this.attachments.size === 0) {
      return undefined;
    }
    for (const attachment of this.attachments) {
      if (clientSupportsUpdate(attachment.updates, type)) {
        return undefined;
      }
    }
    return `client does not support ${type}; update tentacle`;
  }

  /**
   * The attached clients changed (an attach or a detach): a pending ask that
   * no attached client can answer any more takes the fallback now — denied
   * with the reason — instead of waiting on a client that cannot show it.
   */
  private recheckAsks(): void {
    const reason = this.blockingUnsupported("permission_request");
    if (reason === undefined) {
      return;
    }
    for (const requestId of [...this.asks.keys()]) {
      this.settle(requestId, { outcome: "cancelled" }, reason);
    }
  }

  /**
   * Answer a pending request with one of its offered options. Synchronous end
   * to end (look up → delete → `permission_resolved` → wake the gate), so of
   * two answers — in any order, in the same tick or not — exactly one wins.
   * Not pending → `PermissionNotPending` (no effect). An option that was not
   * offered → `InvalidParams`, and the request STAYS pending: a malformed
   * answer is never a denial.
   */
  resolvePermission(requestId: string, optionId: string): void {
    const ask = this.asks.get(requestId);
    if (!ask) {
      throw new RpcError(DomainErrorCode.PermissionNotPending, "permission request not pending");
    }
    if (!ask.offered.has(optionId)) {
      throw new RpcError(JsonRpcErrorCode.InvalidParams, "option not offered for this request");
    }
    this.settle(requestId, { outcome: "selected", optionId });
  }

  /**
   * First-wins: the first caller removes the entry; any later one finds none.
   * `permission_resolved` goes out BEFORE the gate is woken, so its seq
   * precedes everything the tool's execution streams.
   */
  private settle(requestId: string, outcome: PermissionOutcome, reason?: string): void {
    const ask = this.asks.get(requestId);
    if (!ask) {
      return;
    }
    this.asks.delete(requestId);
    try {
      // A request nobody was shown is not resolved in the stream either.
      if (ask.shown) {
        this.emit({ type: "permission_resolved", requestId, outcome });
      }
    } finally {
      ask.settle(outcome, reason);
    }
  }

  /** Hand the persister this session's state as of NOW (a no-op without one, or once closed). */
  private persist(): void {
    if (this.persister && !this.closed) {
      this.persister.schedule(this.id, () => this.persistedState());
    }
  }

  /**
   * Resolves once everything this session wrote so far is on disk (or failed,
   * which the persister reports). Immediate without a persister. Never awaited
   * in the steering window (only mid-round, inside the gate, and by `enqueue`).
   */
  persisted(): Promise<void> {
    return this.persister ? this.persister.flush(this.id) : Promise.resolve();
  }

  /** The state a record captures, copied now (the arrays are live). */
  private persistedState(): DaemonSessionState {
    const turns: PersistedTurnKey[] = [];
    for (const [turnId, entry] of this.turns) {
      turns.push(entry.end ? { turnId, end: entry.end } : { turnId });
    }
    const turnId = this.compacting ? null : this.activeTurnId;
    return {
      id: this.id,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      lastChangeAt: this.lastChangeAt,
      messages: [...this.session.messages],
      turns,
      enqueueIds: [...this.enqueued],
      ...(turnId !== null
        ? {
            turn: {
              turnId,
              steering: this.session.pendingSteering(),
              ...(this.pending ? { pending: this.pending } : {}),
            },
          }
        : {}),
    };
  }

  /** A turn or a compaction is active. */
  get running(): boolean {
    return this.controller !== null;
  }

  /** The current cut (what a first snapshot page returns as `since`). */
  get historyCut(): HistoryCut {
    return { epoch: this.cut.epoch, seq: this.cut.seq };
  }

  /** Number of attached clients. */
  get attachedCount(): number {
    return this.attachments.size;
  }

  /** What `session/list` shows of this session (it runs in `cwd`). A read: no stamp, no write. */
  summary(cwd: string): SessionSummary {
    return {
      id: this.id,
      createdAt: this.createdAt,
      lastChangeAt: this.lastChangeAt,
      running: this.running,
      attached: this.attachments.size,
      title: sessionTitle(this.session.messages),
      cwd,
      archived: false,
    };
  }

  /** What the reaper decides on (rules in `session-reaper.ts`). */
  liveness(): SessionLiveness {
    return {
      id: this.id,
      attached: this.attachments.size,
      busy: this.running,
      lastActiveAt: this.lastActiveAt,
      lastDetachAt: this.lastDetachAt,
    };
  }

  /** An attachment was removed: the session may have just become detached/idle. */
  private removeAttachment(attachment: Attachment): void {
    if (this.attachments.delete(attachment)) {
      this.lastDetachAt = this.now();
      this.lastActiveAt = this.lastDetachAt;
      // The TTL clock moved: a restart must see it (the reaper counts a detach
      // as activity). A capture only — safe anywhere, the fan-out included.
      this.persist();
    }
  }

  /**
   * Attach a client: replay what it missed, then add it to the fan-out — ONE
   * synchronous segment (no `await` of any kind), so no update can be emitted
   * between the replay and the live stream (a gap nothing could repair).
   * `since` covered → the updates after it, `resync: false`. Otherwise →
   * `resync: true` and the updates after the current cut: a snapshot taken
   * later is at a cut at or past it, so snapshot + buffered updates past its
   * `since` is complete. Re-attaching moves the client to "most recent".
   */
  attach(attachment: Attachment, since?: HistoryCut): { resync: boolean; epoch: string } {
    if (this.closed) {
      throw new Error(`session ${this.id} is closed`);
    }
    const covered = since !== undefined ? this.replayFrom(since) : undefined;
    let replay: readonly KnownSessionUpdateParams[];
    if (covered !== undefined && "replay" in covered) {
      replay = covered.replay;
    } else {
      const fromCut = this.replayFrom(this.historyCut);
      // Never: the ring pins everything after the cut.
      if (!("replay" in fromCut)) {
        throw new Error(`session ${this.id}: replay ring lost its cut`);
      }
      replay = fromCut.replay;
    }
    for (const update of replay) {
      attachment.send(frameFor(update, attachment.updates));
    }
    this.attachments.delete(attachment);
    this.attachments.add(attachment);
    this.recheckAsks();
    return { resync: covered === undefined || !("replay" in covered), epoch: this.cut.epoch };
  }

  /** Stop delivering to `attachment` (its connection went away). The session lives on. */
  detach(attachment: Attachment): void {
    this.removeAttachment(attachment);
    this.recheckAsks();
  }

  /**
   * Every update after `since`, or `resync` when that cannot be exact: another
   * epoch (a compaction or another incarnation since), a seq before the current
   * epoch began or in the future (a buggy/hostile client), or evicted from the
   * ring. Synchronous, so a caller can attach a sink in the same tick.
   */
  replayFrom(since: HistoryCut): ReplayResult {
    if (
      since.epoch !== this.cut.epoch ||
      !Number.isSafeInteger(since.seq) ||
      since.seq < this.epochStart ||
      since.seq > this.seq
    ) {
      return { resync: true };
    }
    const replay = this.ring.since(since.seq);
    return replay ? { replay } : { resync: true };
  }

  /**
   * One page of the history at the current cut, newest first (see
   * `SnapshotResult`). Without `cursor`: the slice ending at the cut, plus the
   * cut itself and the turn running at it. With `cursor` (an earlier page's):
   * the slice before it — same epoch only, `StaleCursor` otherwise. `limit`
   * omitted: everything up to the end, in one page.
   */
  snapshotPage(cursor?: string, limit?: number): SnapshotResult {
    const cut = this.cut;
    let end = cut.length;
    if (cursor !== undefined) {
      end = this.parseCursor(cursor, cut);
    }
    const start = limit === undefined ? 0 : Math.max(0, end - limit);
    // core `ChatMessage` is structurally the wire schema; the slice is a copy.
    const messages = this.session.messages.slice(start, end) as SnapshotResult["messages"];
    return {
      messages,
      ...(cursor === undefined ? { since: { epoch: cut.epoch, seq: cut.seq } } : {}),
      ...(cursor === undefined && cut.turnId !== null ? { turn: { turnId: cut.turnId } } : {}),
      ...(start > 0 ? { cursor: `${cut.epoch}/${start}` } : {}),
    };
  }

  /** `"<epoch>/<end>"` → `end`, validated against the current cut. */
  private parseCursor(cursor: string, cut: Cut): number {
    const slash = cursor.lastIndexOf("/");
    const epoch = cursor.slice(0, slash);
    const raw = cursor.slice(slash + 1);
    const end = /^[0-9]{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
    if (slash <= 0 || !Number.isSafeInteger(end)) {
      throw new RpcError(JsonRpcErrorCode.InvalidParams, "invalid snapshot cursor");
    }
    if (epoch !== cut.epoch) {
      throw new RpcError(
        DomainErrorCode.StaleCursor,
        "stale snapshot cursor: the history was replaced — restart from the first page",
      );
    }
    if (end <= 0 || end > cut.length) {
      throw new RpcError(JsonRpcErrorCode.InvalidParams, "invalid snapshot cursor");
    }
    return end;
  }

  /** Move the cut to "now" (the caller guarantees the history reflects every emit). */
  private recordCut(turnId: string | null): void {
    this.cut = {
      epoch: this.cut.epoch,
      seq: this.seq,
      length: this.session.messages.length,
      turnId,
    };
    this.ring.evict(this.seq);
  }

  /**
   * Number, buffer, then fan out one update. Synchronous and never awaited: a
   * slow client cannot stall the agent loop (its transport buffers or drops
   * it), and `turn_end` stays inside the steering no-await window. A sink that
   * throws (a programming error — closed peers no-op) is detached and reported;
   * the others still get the update. Iterates a copy: a detach mid-fan-out
   * never skips a sibling.
   */
  private emit(update: SessionUpdate): void {
    const params = toUpdateParams(this.id, ++this.seq, update);
    this.ring.push(params, this.cut.seq);
    for (const attachment of [...this.attachments]) {
      try {
        attachment.send(frameFor(params, attachment.updates));
      } catch (error) {
        this.removeAttachment(attachment);
        this.reportTurnError(error);
      }
    }
  }

  /**
   * Accept a turn and ack at once; the turn itself runs in `drive` and ends
   * with a `turn_end` update. Synchronous up to the ack ON PURPOSE: two prompts
   * arriving together must see the first one's controller (an `await` before it
   * would admit both). A retried `turnId` returns the cached ack — with the
   * outcome if that turn already ended — and never runs a second turn.
   *
   * `skill` (the user's `/name`) is checked here, before anything is recorded:
   * one this session cannot activate for the user → `InvalidParams`.
   */
  prompt(
    turnId: string,
    content: Parameters<typeof contentToText>[0],
    skill?: string,
    askHooksTrust?: AskHooksTrust,
  ): PromptResult {
    // The key first: a retry is answered even while a turn runs, or after it ended.
    const known = this.turns.get(turnId);
    if (known) {
      return known.end ? { turnId, ended: known.end } : { turnId };
    }
    // Before the busy check: a rejected prompt starts and records nothing.
    assertTextOnly(content);
    const text = contentToText(content);
    if (skill !== undefined && (text === "" || !this.session.canActivateSkill(skill))) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidParams,
        `unknown skill "${skill}": not invocable on this daemon`,
      );
    }
    this.assertIdle();
    const controller = new AbortController();
    this.controller = controller;
    this.activeTurnId = turnId;
    this.turns.set(turnId, {});
    // The prompt joins the history: a conversation change. It is also the
    // running session's `session/list` key — stable for the whole turn (the
    // keyset cursor needs that), and never above the stamp its end will set.
    this.lastChangeAt = this.now();
    try {
      this.emit({ type: "turn_start", turnId, prompt: text });
    } catch (error) {
      // The turn is accepted (state above): a throwing sink must not strand it
      // as "running" forever — run it anyway; it ends through `finishTurn`.
      this.reportTurnError(error);
    }
    // The agent resets its queue at `send`: so does its id mirror.
    this.steeringIds = [];
    void this.drive(
      turnId,
      this.session.send(text, controller.signal, {
        ...(skill !== undefined ? { skill } : {}),
        ...(askHooksTrust !== undefined ? { askHooksTrust } : {}),
      }),
      controller,
    );
    // After `drive` started: the generator has pushed the prompt by now (it
    // runs up to its first await inside the first `next()`), so the turn key
    // and the prompt are on disk together, before the model is called.
    this.persist();
    return { turnId };
  }

  /**
   * `session/send_now`: cancel `interrupt` and start turn `turnId` whose
   * prompt is `messages`' texts not injected yet, joined with "\n\n". Acks at
   * once, synchronously (like `prompt`). While the target unwinds the new turn
   * is RESERVED (memory only); the code that frees the slot hands it over in
   * the same synchronous stretch (`settleSuccessor`), so no other request can
   * take the slot in between. A target that no longer runs is never replaced
   * by a cancel of something else: `TurnInProgress` if the slot is held.
   */
  sendNow(
    turnId: string,
    interrupt: SendNowTarget,
    messages: readonly SendNowMessage[],
    askHooksTrust?: AskHooksTrust,
  ): PromptResult {
    const known = this.turns.get(turnId);
    if (known) {
      return known.end ? { turnId, ended: known.end } : { turnId };
    }
    if (this.successor?.turnId === turnId) {
      return { turnId };
    }
    if (this.successor !== null) {
      throw this.refusal(
        new RpcError(DomainErrorCode.TurnInProgress, "a send-now is already waiting"),
        messages,
      );
    }
    const reserve = (): Successor => ({
      turnId,
      messages,
      steers: [],
      cancelled: false,
      ...(askHooksTrust !== undefined ? { askHooksTrust } : {}),
    });
    const running =
      interrupt.kind === "turn"
        ? !this.compacting && this.activeTurnId === interrupt.turnId
        : this.compacting;
    if (running && this.controller) {
      this.successor = reserve();
      this.controller.abort();
      return { turnId };
    }
    // The target ended already: someone else's turn or compaction holds the slot.
    try {
      this.assertIdle();
    } catch (error) {
      throw error instanceof RpcError ? this.refusal(error, messages) : error;
    }
    // Every text reached the history: a continuation turn (prompt "") if one
    // still waits for its answer (a drain with no model round after it — a
    // reload, the `max_iterations` or hook-stop drain), else nothing to send.
    if (messages.every((m) => this.isDelivered(m.id)) && !this.awaitsAnswer()) {
      throw new RpcError(DomainErrorCode.NoTurnRunning, "no turn is running");
    }
    this.successor = reserve();
    this.settleSuccessor();
    return { turnId };
  }

  /**
   * The history awaits an answer: STRUCTURAL, never by text (a `ChatMessage`
   * has no id; texts repeat, and compaction rewrites them). Its last message is
   * a user turn — whoever wrote it — and not the compaction summary this
   * session installed (`compactionSummary`, by identity: `[system?, user]` is
   * also a first turn's shape). An `assistant`, `tool` (a turn cancelled after
   * a tool ran) or `system` tail, or an empty history, awaits nothing.
   */
  private awaitsAnswer(): boolean {
    const last = this.session.messages.at(-1);
    return last?.role === "user" && last !== this.compactionSummary;
  }

  /**
   * A refused send-now, with the fact the caller must not guess
   * (`SendNowRefusal`): which of its texts this daemon holds. In the history
   * (`isDelivered`), or queued for a turn that WILL drain them — a reserved
   * send-now not cancelled (it carries the queue over, `startSuccessor`), or
   * a running turn not aborted. A queue whose only consumer is already
   * cancelled or aborted is NOT held: `endUnstarted` / the next `prompt`
   * drops it (debt, docs/feat/send-now-c.md follow-up 3), so the caller
   * restores it.
   */
  private refusal(error: RpcError, messages: readonly SendNowMessage[]): RpcError {
    const next = this.successor;
    const turn = this.controller;
    const live =
      (next !== null && !next.cancelled) ||
      (turn !== null && !turn.signal.aborted && !this.compacting);
    const queued = new Set(live ? this.steeringIds : []);
    const data: SendNowRefusal = {
      held: messages.filter((m) => this.isDelivered(m.id) || queued.has(m.id)).map((m) => m.id),
    };
    return new RpcError(error.code, error.message, data);
  }

  /** The text of enqueue `id` is in the history (drained here, or accepted before a reload). */
  private isDelivered(id: string): boolean {
    return this.drained.has(id) || this.restoredIds.has(id);
  }

  /**
   * Hand the freed slot to the reserved send-now, if any. Called LAST by the
   * code that frees the slot (`finishTurn`, `compact`), in its synchronous
   * stretch: no `await` — the steering window (`drive`'s INVARIANT) runs
   * through here.
   */
  private settleSuccessor(): void {
    const next = this.successor;
    if (next === null || this.controller !== null) {
      return;
    }
    if (this.closed || next.cancelled) {
      this.endUnstarted(next);
    } else {
      this.startSuccessor(next);
    }
  }

  /** Start the reserved turn: one path, like `prompt` past its checks. */
  private startSuccessor(next: Successor): void {
    const remaining = next.messages.filter((m) => !this.isDelivered(m.id));
    const ours = new Set(remaining.map((m) => m.id));
    // The cancelled turn's undrained steers carry over (foreign or resumed
    // ones too, in order), minus ours — those are in the prompt — then the
    // steers typed for the successor itself.
    const seed: string[] = [];
    const seedIds: (string | undefined)[] = [];
    this.session.pendingSteering().forEach((text, i) => {
      const id = this.steeringIds[i];
      if (id !== undefined && ours.has(id)) {
        return;
      }
      seed.push(text);
      seedIds.push(id);
    });
    for (const steer of next.steers) {
      seed.push(steer.text);
      seedIds.push(steer.id);
    }
    // Delivered from here on: a late `session/enqueue` of one is a no-op success.
    for (const id of [...next.messages.map((m) => m.id), ...next.steers.map((s) => s.id)]) {
      this.enqueued.add(id);
    }
    // In the prompt = in the history: a later send-now never sends them again.
    for (const id of ours) {
      this.drained.add(id);
    }
    this.steeringIds = seedIds;
    const controller = new AbortController();
    this.controller = controller;
    this.activeTurnId = next.turnId;
    this.turns.set(next.turnId, {});
    this.sendNowTurns.add(next.turnId);
    this.successor = null;
    // A turn start, like `prompt`'s (task 1's `session/list` key).
    this.lastChangeAt = this.now();
    // "" when every text was injected meanwhile: a continuation turn answers them.
    const prompt = remaining.map((m) => m.text).join("\n\n");
    try {
      this.emit({ type: "turn_start", turnId: next.turnId, prompt });
    } catch (error) {
      this.reportTurnError(error);
    }
    void this.drive(
      next.turnId,
      this.session.send(prompt, controller.signal, {
        steering: seed,
        ...(next.askHooksTrust !== undefined ? { askHooksTrust: next.askHooksTrust } : {}),
      }),
      controller,
    );
    // As `prompt`: the turn key and the prompt reach the disk together.
    this.persist();
  }

  /**
   * A reserved send-now cancelled (or its session closed) before it started.
   * The wire contract: a `turn_end` with no `turn_start` delivered NOTHING —
   * neither its prompt nor a steer enqueued to it; its client restores them.
   */
  private endUnstarted(next: Successor): void {
    this.successor = null;
    const end: TurnEnd = { stopReason: "cancelled", delivered: false };
    this.turns.set(next.turnId, { end });
    try {
      this.emit({ type: "turn_end", turnId: next.turnId, ...end });
    } catch (error) {
      this.reportTurnError(error);
    }
    this.persist();
  }

  /**
   * Refuse a new operation while the busy slot is held. Every taker of the slot
   * calls this and takes it in the same synchronous stretch, so two concurrent
   * requests can never both pass.
   */
  private assertIdle(): void {
    if (this.controller) {
      throw this.compacting
        ? new RpcError(DomainErrorCode.CompactInProgress, "a compaction is running")
        : new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
    }
  }

  /**
   * Consume the agent's turn and stream it. Never rejects: every exit ends in
   * exactly one effective `finishTurn`, and every failure reaches `onTurnError`.
   *
   * INVARIANT (steering, see the comment at agent.ts's late-steer drain): from
   * the agent's last drain to `finishTurn` clearing the controller there is NO
   * `await` here — `finishTurn` runs synchronously inside the loop body on the
   * agent's `turn_end` event, BEFORE the `return` that resumes the generator.
   * Pinned by the daemon test "no macrotask fits between the last steering
   * drain and the turn's end"; a microtask-only `await` would not be caught by
   * it, so keep this loop free of any.
   */
  private async drive(
    turnId: string,
    events: AsyncGenerator<AgentEvent>,
    controller: AbortController,
  ): Promise<void> {
    try {
      for await (const event of events) {
        if (event.type === "turn_end") {
          this.finishTurn(turnId, { stopReason: stopReasonToProtocol(event.reason) });
          return;
        }
        // The history reflects every update so far: the snapshot cut moves here.
        if (event.type === "history_commit") {
          // No ask can be pending at a commit (the agent commits only between
          // calls): one still set is a resumed turn's, whose call was answered
          // without being asked again (cancelled) — never write it as pending.
          this.pending = undefined;
          this.recordCut(turnId);
          this.persist();
          continue;
        }
        if (event.type === "tool_start") {
          this.currentToolCallId = event.id;
          this.currentToolName = event.name;
        }
        if (event.type === "steer") {
          // One per drained text, in queue order: the mirror's head is its id.
          const id = this.steeringIds.shift();
          if (id !== undefined) {
            this.drained.add(id);
          }
        }
        const update = eventToUpdate(event);
        if (update) {
          this.emit(update);
        }
      }
      // The generator ended without a `turn_end` (not an agent path today).
      this.finishTurn(turnId, { stopReason: "end_turn" });
    } catch (error) {
      // The agent (model/tool) failed — or the sink threw. Either way: report
      // it unredacted, then end the turn. `finishTurn` is idempotent, so a
      // throw from its own `turn_end` emit sends no second `turn_end`.
      this.reportTurnError(error);
      try {
        this.finishTurn(turnId, {
          stopReason: "error",
          error: redactTurnError(error, this.errorPolicy.exposeTurnErrors === true),
        });
      } catch (sinkError) {
        // The state is already final (set before the emit); only the frame is lost.
        this.reportTurnError(sinkError);
      }
    }
  }

  private reportTurnError(error: unknown): void {
    try {
      this.errorPolicy.onTurnError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // The embedder's log sink failed: there is nowhere left to report it,
      // and it must not strand the turn as running or reject `drive`.
    }
  }

  /**
   * End the turn: record its outcome, clear the controller, stream `turn_end`,
   * move the cut past it (the history is final here, on every path).
   * Synchronous, and idempotent per turn. State is set BEFORE the emit, so a
   * throwing sink can never leave the session "running" — nor skip the cut.
   */
  private finishTurn(turnId: string, outcome: TurnEnd): void {
    const record = this.turns.get(turnId);
    if (!record || record.end) {
      return;
    }
    // A send-now turn that reached here started: its texts are in the history.
    const end = this.sendNowTurns.has(turnId) ? { ...outcome, delivered: true } : outcome;
    record.end = end;
    if (this.activeTurnId === turnId) {
      this.controller = null;
      this.activeTurnId = null;
      this.lastActiveAt = this.now();
      this.lastChangeAt = this.lastActiveAt;
    }
    try {
      this.emit({ type: "turn_end", turnId, ...end });
    } finally {
      this.recordCut(this.activeTurnId);
      // Inside the steering window, and safe there: this method cannot await,
      // and `persist` only captures — the I/O starts after the window.
      this.pending = undefined;
      this.persist();
      // Last, in the same stretch: a reserved send-now takes the slot now.
      this.settleSuccessor();
    }
  }

  /**
   * Queue a user message for injection at the next model-round boundary of the
   * turn `turnId`. Synchronous. The key is checked BEFORE the running check: a
   * retry of an accepted id is a no-op success even after its turn ended (never
   * `NoTurnRunning`, never injected twice). A rejected attempt is not recorded.
   */
  enqueue(id: string, turnId: string, text: string): void {
    if (this.enqueued.has(id)) {
      return;
    }
    // Typed for a reserved send-now: it is that turn's first steer. Memory
    // only until it starts (an unstarted successor delivered nothing).
    const next = this.successor;
    if (next !== null && next.turnId === turnId) {
      const known = next.steers.some((s) => s.id === id) || next.messages.some((m) => m.id === id);
      if (!known) {
        next.steers.push({ id, text });
      }
      return;
    }
    // Accepting it while idle would be a fake success: the next turn starts by
    // resetting the steering queue, so the text would be dropped silently. And
    // it must be THIS turn: a retry that outlived its turn must not steer the
    // next one.
    if (this.controller === null || this.activeTurnId !== turnId) {
      throw new RpcError(DomainErrorCode.NoTurnRunning, "no turn is running");
    }
    this.enqueued.add(id);
    this.session.enqueue(text);
    this.steeringIds.push(id);
    this.persist();
  }

  /**
   * Compact the conversation; returns message counts before/after. Takes the
   * busy slot before its first `await` (see `assertIdle`), so it is exclusive
   * with a turn, and `cancel` — or `signal` (the request's own cancel) — aborts
   * it: it then rejects `Cancelled` and leaves the history untouched.
   */
  async compact(signal?: AbortSignal): Promise<{ before: number; after: number }> {
    this.assertIdle();
    // Cancelled before it started: no slot, no model call.
    if (signal?.aborted) {
      throw new RpcError(DomainErrorCode.Cancelled, "compaction cancelled");
    }
    const controller = new AbortController();
    this.controller = controller;
    this.compacting = true;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { before, after } = await this.session.compact(controller.signal, () =>
        this.historyReplaced(),
      );
      // Only a compaction that replaced the history is a conversation change:
      // a failed or cancelled one left it as it was (the `finally` writes it).
      this.lastChangeAt = this.now();
      return { before, after };
    } catch (error) {
      // Providers throw anything on abort; give the client one clean code.
      if (controller.signal.aborted) {
        throw new RpcError(DomainErrorCode.Cancelled, "compaction cancelled");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      // Ours for sure: no one takes the slot without `assertIdle`.
      this.controller = null;
      this.compacting = false;
      this.lastActiveAt = this.now();
      // The compaction's write (history replaced, or untouched on a failure)
      // with its clock: after the slot is free, so the record has no `turn`.
      this.persist();
      // Last, in the same stretch: a reserved send-now takes the slot now.
      this.settleSuccessor();
    }
  }

  /**
   * The barrier, run synchronously inside `Session.compact` right after the
   * history was replaced: a new epoch, `history_replaced`, the cut. Must not
   * throw (the replacement already happened): a sink error is reported.
   */
  private historyReplaced(): void {
    // The cut is final BEFORE the emit — it names the barrier's own seq (the
    // next one) — so even a sink that reads the snapshot re-entrantly sees a
    // consistent new epoch, never the new epoch with the old history length.
    // `compactedHistory` builds `[system?, summary, (skill call, result)*]`:
    // its first user message is the summary.
    this.compactionSummary = this.session.messages.find((m) => m.role === "user");
    this.epochStart = this.seq + 1;
    this.cut = {
      epoch: crypto.randomUUID(),
      seq: this.epochStart,
      length: this.session.messages.length,
      turnId: null,
    };
    try {
      this.emit({ type: "history_replaced", reason: "compact" });
    } catch (error) {
      this.reportTurnError(error);
    }
  }

  /** Abort the active turn or compaction (if any), and a send-now waiting on it. */
  cancel(): void {
    this.controller?.abort();
    if (this.successor) {
      this.successor.cancelled = true;
    }
  }

  /**
   * End the session for every client. Synchronous and idempotent. A running
   * turn ends HERE, in the stream (`turn_end{cancelled}`, then the unwinding
   * `drive` is a no-op): its asynchronous end would come after the clients are
   * detached, and an attached client would wait for it forever. Then
   * `session_closed` (the last update anyone gets), detach all, stop
   * listening to job exits, and kill the jobs (no exit notice for the kills).
   * `reason` is what `session_closed` tells the clients: `deleted` by
   * `session/delete`, else `closed`.
   */
  close(reason: "closed" | "deleted" = "closed"): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.controller?.abort();
    if (this.activeTurnId !== null) {
      try {
        this.finishTurn(this.activeTurnId, { stopReason: "cancelled" });
      } catch (error) {
        this.reportTurnError(error);
      }
    }
    // A send-now still waiting (its compaction unwinds asynchronously): ended
    // unstarted, before `session_closed`.
    if (this.successor) {
      this.endUnstarted(this.successor);
    }
    try {
      this.emit({ type: "session_closed", reason });
    } catch (error) {
      this.reportTurnError(error);
    }
    this.attachments.clear();
    this.unsubscribeExit?.();
    this.jobs?.dispose();
  }

  /**
   * `close` this session and return the state its ARCHIVED record keeps. The
   * history and the turn are taken just BEFORE the close: a turn cut short
   * keeps its pending ask and its steers, the shape a crash leaves, which the
   * reopen closes as ended (`reconcileOnReload`). The turn keys and the stamps
   * are taken AFTER it: the ends the close streamed (`turn_end{cancelled}`,
   * and a waiting send-now's `delivered: false` — memory only until here) are
   * the ends a retried `prompt` / `send_now` must get after the reopen.
   */
  archive(): DaemonSessionState {
    const before = this.persistedState();
    this.close("closed");
    const after = this.persistedState();
    return { ...after, ...(before.turn ? { turn: before.turn } : {}) };
  }
}
