/**
 * A remote conversation that presents the *same* interface as the local agent
 * `Session`: `send(text, signal)` yields `AgentEvent`s — plus, after a
 * reconnect that had to resync, a `history_reset` (replace what is shown) and
 * a `user_message` (the turn's prompt, re-delivered after the reset). The Ink
 * App folds them, so a connected TUI renders a remote session identically to a
 * local one. The remote session id is created lazily on the first `send`;
 * `close` ends it daemon-side (a session outlives the connection that opened
 * it). It is its session's stream listener: `RemoteClient` hands it the
 * ordered outputs of the pure reducer.
 */
import type { ChatMessage } from "@tentacle/core";
import {
  DomainErrorCode,
  type JobOutputResult,
  type JobRow,
  JsonRpcErrorCode,
  type QueueState,
  type SeedTitle,
  type SendNowMessage,
  type SendNowTarget,
  type SessionSettingsReport,
  type SessionSkillsResult,
  type SessionUpdate,
  type SubagentRow,
  type TurnEnd,
  type UpdateSettingsResult,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { type ReturnedRow, handBack, restoredByRefusal, stayingRows } from "./hand-back.ts";
import { turnRecovery } from "./link-machine.ts";
import { type SessionEvent, stopReasonFromProtocol, updateToEvent } from "./mapping.ts";
import { AsyncQueue } from "./queue.ts";
import type {
  ReadBack,
  RemoteClient,
  SessionStreamListener,
  SessionTitleNotice,
} from "./remote-client.ts";
import type { StreamOutput } from "./session-reducer.ts";
import type { SubagentNotify } from "./subagents.ts";

/** Own turns remembered by `ownsTurn` after they end (the oldest fall off). */
const MINTED_TURNS_MAX = 256;

/** The turn this session is streaming. */
interface ActiveTurn {
  readonly turnId: string;
  readonly prompt: string;
  /** The user's `/name` activation, re-sent with the prompt. */
  readonly skill?: string;
  readonly queue: AsyncQueue<SessionEvent>;
  /** Tool names by call id (a `tool_call_update` omits it). */
  readonly toolNames: Map<string, string>;
  /** Calls the last reset already showed: their replayed `tool_call` is not shown again. */
  shownTools: Set<string>;
  /** A reset replaced the screen during this turn. */
  reset: boolean;
  ended: boolean;
  /** The daemon acknowledged `prompt{turnId}`. */
  acked: boolean;
  /** `prompt{turnId}` was written to a channel: a daemon may have run it. */
  sent: boolean;
  /** The user cancelled; re-sent on the prompt's ack (a cancel can beat the prompt, or be lost). */
  abortWanted: boolean;
  /** Set for a turn started by `session/send_now` (its request is re-sent instead of `prompt`). */
  readonly sendNow?: {
    readonly interrupt: SendNowTarget;
    readonly messages: readonly SendNowMessage[];
  };
  /**
   * A send-now turn's `turn_start` was seen (or a reset showed it running).
   * Only the fallback when its end carries no `delivered` (an older daemon).
   */
  started: boolean;
  /**
   * A turn this session did not start (another device's, or one already
   * running when it attached): never sent, never acked, never re-sent.
   */
  readonly foreign?: true;
}

/**
 * What the session does that no call of this client started
 * (docs/feat/tui-foreign-turns.md B6). One listener (`watch`).
 */
export type SessionActivity =
  /** A turn this session did not start (or one already running when it attached). */
  | {
      readonly kind: "turn";
      readonly turnId: string;
      readonly events: AsyncIterable<SessionEvent>;
      /** Stop it (`session/cancel{turnId}`): whoever started it. */
      cancel(): void;
    }
  /**
   * The daemon's history replaced what is shown while no turn runs (eager
   * open, a resync, a compaction). `reason`: the barrier that caused it — a
   * compaction, or a context reset whose turn this client no longer tracks
   * (both keep what is shown) — null for any other history (it replaces it).
   */
  | {
      readonly kind: "history";
      readonly messages: readonly ChatMessage[];
      readonly reason: "compact" | "context_reset" | "clear" | null;
    }
  /** The session ended daemon-side (another device's close / delete, the reaper). */
  | { readonly kind: "closed"; readonly reason: EndReason };

/**
 * How a session ended for this client: a close seen live, a delete, or `gone`:
 * it vanished while the link was down (a close for all, a reap, a restarted
 * pod daemon) and nobody can say who ended it.
 */
export type EndReason = "closed" | "deleted" | "gone";

export class RemoteSession implements SessionStreamListener {
  private readonly client: RemoteClient;
  private readonly seedMessages?: readonly ChatMessage[];
  private readonly desiredId?: string;
  /** The resumed record's chosen title: seeds the open that creates the session daemon-side. */
  private readonly seedTitle: SeedTitle | undefined;
  private id: string | null = null;
  /** The in-flight `session/open` of the first `send`, until `id` is known. */
  private opening: Promise<string> | null = null;
  private closed = false;
  /**
   * The client-chosen id of the latest turn (steering binds to it), or null
   * before the first send. Kept after the turn ends ON PURPOSE: a steer typed
   * in the window where the TUI still shows the turn running then reaches the
   * daemon, which rejects it `NoTurnRunning` — so the TUI can say "not queued"
   * instead of the text vanishing in a local no-op.
   */
  private turnId: string | null = null;
  /** The turn being streamed, or null when idle. */
  private active: ActiveTurn | null = null;
  /**
   * A send-now turn waiting for `active` to end: promoted (and `turnId`
   * switched) when it does. The daemon emits the old `turn_end` before any
   * update of its successor, so routing by order stays correct.
   */
  private next: ActiveTurn | null = null;
  /**
   * The old turn a resync past the hand-off promoted away from: its
   * `turn_end` is behind the cut, so it waits for its real end from its
   * re-sent `prompt` (`recovered`), which the daemon answers from its cache.
   */
  private settling: ActiveTurn | null = null;
  /** `unsupported` notices that arrived while idle: shown at the start of the next turn. */
  private idleNotices: SessionEvent[] = [];
  /**
   * Every row id this session sent (`enqueue`, a send-now's messages), with
   * my text. "Mine" is exactly this — the daemon has no device identity
   * (docs/feat/queued-broadcast.md).
   */
  private readonly mine = new Map<string, string>();
  /** Ids already given back to the user by any path: never given twice. */
  private readonly handedBack = new Set<string>();
  /** Reclaims in flight (a failed one is re-sent at the next state that lists it). */
  private readonly reclaiming = new Set<string>();
  private readonly returnedListeners = new Set<(rows: readonly ReturnedRow[]) => void>();
  private unsubscribeQueue: (() => void) | null = null;
  /** Built to attach to an existing session (`open`), never to create one. */
  private readonly attach: { readonly reopen?: boolean } | undefined;
  /** The memoized eager attach (`open`). */
  private attaching: Promise<void> | null = null;
  /** The memoized create-or-attach of a seeded session (`openSeeded`, or the first send). */
  private creating: Promise<string> | null = null;
  /**
   * A session other clients may share (a detached run's TUIs): `close()` (the
   * `/clear`) is `session/close{ifLast}`, so it never ends it under them.
   */
  private readonly closeIfLast: boolean;
  /**
   * The turn the daemon's stream says runs (own or foreign): set by a
   * `turn_start` or a reset that names one, cleared by its `turn_end`. What
   * steering, send-now and the activity cancel bind to.
   */
  private streamingId: string | null = null;
  private readonly idleListeners = new Set<() => void>();
  private get streaming(): string | null {
    return this.streamingId;
  }
  private set streaming(id: string | null) {
    const was = this.streamingId;
    this.streamingId = id;
    // LOAD-BEARING (docs/fix/detach-live.md R9): the idle listeners run
    // SYNCHRONOUSLY, inside this setter. `persistingController`'s listener
    // starts the post-turn save (its `flush` clears `confirmed`) before anything
    // can read `saveConfirmed`; an async notification would let an exit net read
    // `true` for a turn the laptop has not saved, and delete the workload.
    // Pinned by test/idle-sync.test.ts (and cli/test/local-runtime.test.ts "R9 synchrony").
    if (was !== null && id === null) {
      for (const listener of [...this.idleListeners]) listener();
    }
  }
  /** A turn runs on the daemon (own or foreign), by its stream: set at an attach mid-turn too. */
  get busy(): boolean {
    return this.streamingId !== null;
  }
  /** The running turn ended (its `turn_end`, or a resync that shows none): a save after it is due. */
  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }
  /** The foreign turn being streamed (at most one: the daemon has one slot). */
  private foreign: ActiveTurn | null = null;
  /**
   * A `history_replaced` was applied: the next reset is its snapshot (a daemon
   * fact) — a compaction's, or a context reset's inside the turn the reducer
   * stamped the barrier with.
   */
  private replaced: {
    readonly reason: "compact" | "context_reset" | "clear";
    readonly turnId: string | null;
  } | null = null;
  /** The session ended daemon-side (`session_closed`): a later send is refused clearly. */
  private remoteClosed = false;
  /**
   * The calls of the running turn the daemon said START (`tool_call_phase`
   * `running`, docs/feat/parallel-tools.md), recorded at receipt in `output`
   * — before any consumer pulls an event — and cleared at a `turn_start`.
   */
  private readonly started = new Set<string>();
  private watcher: ((activity: SessionActivity) => void) | null = null;
  /** Activities raised before `watch`: handed over on subscribe, in order. */
  private unwatched: SessionActivity[] = [];

  constructor(
    client: RemoteClient,
    seedMessages?: readonly ChatMessage[],
    desiredId?: string,
    seedTitle?: SeedTitle,
    attach?: { readonly reopen?: boolean },
    closeIfLast = false,
  ) {
    this.client = client;
    this.seedMessages = seedMessages;
    this.desiredId = desiredId;
    this.seedTitle = seedTitle;
    this.attach = attach;
    this.closeIfLast = closeIfLast;
  }

  /**
   * Subscribe to what the session does that this client did not start (see
   * `SessionActivity`). One listener: a second replaces the first. Activities
   * raised before it are delivered now, in order. Returns an unsubscribe.
   */
  watch(listener: (activity: SessionActivity) => void): () => void {
    this.watcher = listener;
    for (const activity of this.unwatched.splice(0)) {
      listener(activity);
    }
    return () => {
      if (this.watcher === listener) {
        this.watcher = null;
      }
    };
  }

  /** `turnId` is one this session minted and still tracks: an own turn (else foreign). */
  ownsTurn(turnId: string): boolean {
    return (
      turnId === this.turnId ||
      this.mintedTurns.has(turnId) ||
      [this.active, this.next, this.settling].some((turn) => turn?.turnId === turnId)
    );
  }

  /**
   * The turns this session minted, bounded (the oldest fall off): a background
   * child's ask names the turn that SPAWNED it, which may have ended long ago —
   * `ownsTurn` must still say "mine" so auto-accept keeps working.
   */
  private readonly mintedTurns = new Set<string>();

  private mint(turnId: string): void {
    this.mintedTurns.delete(turnId);
    this.mintedTurns.add(turnId);
    if (this.mintedTurns.size > MINTED_TURNS_MAX) {
      const oldest = this.mintedTurns.values().next();
      if (!oldest.done) {
        this.mintedTurns.delete(oldest.value);
      }
    }
  }

  /**
   * The eager attach of a session built with `attach` (`newSession(…, {attach})`):
   * `session/open{sessionId, reopen?}`, never a create; its full history comes
   * as a `history` activity (or a foreign turn, mid-turn), then live. Rejects
   * on an archived (without `reopen`), deleted or unknown id — nothing is
   * created; a later call tries again. A no-op for a fresh session: it stays
   * lazy (opened by the first `send`).
   */
  open(): Promise<void> {
    const id = this.desiredId;
    if (!this.attach || id === undefined || this.id !== null) {
      return Promise.resolve();
    }
    if (!this.attaching) {
      const opening = this.client.attachSession(id, this, {
        ...(this.attach.reopen === true ? { reopen: true } : {}),
      });
      this.opening = opening;
      this.attaching = opening.then(
        (sessionId) => {
          this.id = sessionId;
          this.opening = null;
        },
        (error: unknown) => {
          this.opening = null;
          this.attaching = null;
          throw error;
        },
      );
    }
    return this.attaching;
  }

  /**
   * Open a session built WITHOUT `attach` now instead of at its first send:
   * `session/open{sessionId, create, messages?}`. The daemon's open is atomic,
   * so a live id is ATTACHED (its history wins, it arrives as a `history`
   * activity) and only an absent one is created from the seed. A client
   * sharing the session (a TUI of a run reopened after a close,
   * docs/fix/detach-live.md KO 4) is then on it from the start: it sees the
   * others' turns and their close, and never re-seeds it from a stale copy.
   * Once open (or opening), it returns the same open. A no-op for an attach.
   */
  openSeeded(): Promise<void> {
    return this.createOrAttach().then(() => {});
  }

  /**
   * `openSeeded`'s one open, memoized. The first send awaits THIS promise: it
   * subscribed first, so its prompt leaves before an enqueue or a send-now
   * that awaited the same open resumes (they find a turn running).
   */
  private createOrAttach(): Promise<unknown> {
    if (this.attach || this.id !== null) {
      return Promise.resolve();
    }
    if (!this.creating) {
      // The id is set INSIDE `opening`: whoever awaits it (an enqueue, a
      // send-now racing the first send) finds the session open.
      const opening = this.client
        .openSession(undefined, this.seedMessages, this.desiredId, this, this.seedTitle)
        .then(
          (sessionId) => {
            this.id = sessionId;
            this.opening = null;
            this.client.setListener(sessionId, this);
            return sessionId;
          },
          (error: unknown) => {
            this.opening = null;
            this.creating = null;
            throw error;
          },
        );
      this.opening = opening;
      this.creating = opening;
    }
    return this.creating;
  }

  private raise(activity: SessionActivity): void {
    if (this.watcher) {
      this.watcher(activity);
      return;
    }
    if (activity.kind === "history") {
      // A newer history supersedes an older one nobody saw.
      this.unwatched = this.unwatched.filter((a) => a.kind !== "history");
    }
    this.unwatched.push(activity);
  }

  /**
   * Rename this session daemon-side (`session/rename`); resolves with the
   * text the daemon stored. Before the first send there is no daemon-side
   * session: rejects "nothing to rename yet". While that send is still
   * opening it, waits for the id.
   */
  async rename(title: string): Promise<string> {
    const id = this.id ?? (this.opening ? await this.opening : null);
    if (!id || this.closed) {
      throw new Error("nothing to rename yet — send a first message");
    }
    return (await this.client.rename(id, title)).text;
  }

  /**
   * A background sub-agent of THIS session exited (its report may now be in the
   * history): the laptop's copy saves on it (M5). Not `onBackgroundExit`: that
   * one owns the exit backlog.
   */
  onAgentExit(listener: () => void): () => void {
    return this.client.onAgentExit((sessionId) => {
      if (sessionId === this.id) {
        listener();
      }
    });
  }

  /**
   * Subscribe to this session's title changes (the daemon's `session_title`,
   * idle or mid-turn, or one a resync revealed); returns an unsubscribe.
   */
  onTitle(listener: (notice: SessionTitleNotice) => void): () => void {
    return this.client.onSessionTitle((notice) => {
      if (notice.sessionId === this.id) {
        listener(notice);
      }
    });
  }

  /**
   * The session's queue as the daemon last reported it — every writer's rows,
   * waiting and returned. Undefined: no report yet, or a daemon that does not
   * report the queue (an older one) — a capability signal, never a guess.
   */
  get queued(): QueueState | undefined {
    return this.id ? this.client.queuedOf(this.id) : undefined;
  }

  /**
   * The session's background sub-agents as the daemon last reported them (bounded
   * here). Undefined: no report yet, or an older daemon does not report them.
   */
  get subagents(): readonly SubagentRow[] | undefined {
    return this.id ? this.client.subagentsOf(this.id) : undefined;
  }

  /**
   * The session's running background SHELL jobs as the daemon last reported them
   * (bounded here). Undefined: no report yet, or an older daemon does not
   * report them (docs/feat/shell-jobs-panel.md).
   */
  get jobs(): readonly JobRow[] | undefined {
    return this.id ? this.client.jobsOf(this.id) : undefined;
  }

  /**
   * Subscribe to this session's queue as the daemon reports it (every
   * writer's rows, live or a resync's); the current state, if any, is given
   * at once. Returns an unsubscribe (docs/feat/tui-foreign-turns.md C7).
   */
  onQueued(listener: (state: QueueState) => void): () => void {
    const unsubscribe = this.client.onSessionQueued((notice) => {
      if (notice.sessionId === this.id) {
        listener(notice.state);
      }
    });
    const now = this.queued;
    if (now) {
      listener(now);
    }
    return unsubscribe;
  }

  /**
   * Subscribe to this session's background sub-agents as the daemon reports
   * them (bounded and sanitized by the client); the current list, if any, is
   * given at once. A child runs between turns, so this fires while idle.
   * Returns an unsubscribe (docs/feat/subagent-background-ui.md).
   */
  onSubagents(listener: (rows: readonly SubagentRow[]) => void): () => void {
    const unsubscribe = this.client.onSessionSubagents((notice) => {
      if (notice.sessionId === this.id) {
        listener(notice.rows);
      }
    });
    const now = this.subagents;
    if (now) {
      listener(now);
    }
    return unsubscribe;
  }

  /**
   * Subscribe to this session's running background SHELL jobs as the daemon
   * reports them (bounded and sanitized by the client); the current list, if
   * any, is given at once. A job runs between turns, so this fires while idle.
   * The notice carries the daemon's own running count beside the rows (H1).
   * Returns an unsubscribe (docs/feat/shell-jobs-panel.md).
   */
  onJobs(listener: (report: { rows: readonly JobRow[]; count: number }) => void): () => void {
    const unsubscribe = this.client.onSessionJobs((notice) => {
      if (notice.sessionId === this.id) {
        listener({ rows: notice.rows, count: notice.count });
      }
    });
    const now = this.jobs;
    if (now) {
      // A list already reported: the count is its length (the daemon caps
      // nothing, so nothing was cut from it — H1).
      listener({ rows: now, count: now.length });
    }
    return unsubscribe;
  }

  /**
   * Subscribe to a RUNNING background child's messages to this session's agent
   * (bounded and sanitized by the client), never given a backlog: a notice is a
   * moment, not state (docs/feat/agent-message-two-way.md). Returns an unsubscribe.
   */
  onSubagentNotify(listener: (notify: SubagentNotify) => void): () => void {
    return this.client.onSessionSubagentNotify((notice) => {
      if (notice.sessionId === this.id) {
        listener(notice.notify);
      }
    });
  }

  /**
   * Subscribe to the USER's own messages to this session's background children
   * (bounded and sanitized by the client), never given a backlog: a notice is a
   * moment, not state (docs/feat/subagent-panel.md). Returns an unsubscribe.
   */
  onSubagentMessage(listener: (notice: { agentId: string; text: string }) => void): () => void {
    return this.client.onSessionSubagentMessage((notice) => {
      if (notice.sessionId === this.id) {
        listener({ agentId: notice.agentId, text: notice.text });
      }
    });
  }

  /**
   * Write the user's text into a RUNNING background child
   * (`session/subagent_message`, docs/feat/subagent-panel.md). Resolves a typed
   * result: a refusal (not running, full, finishing, an older daemon) is
   * `{ok: false, reason}`, never a throw at the TUI.
   */
  messageSubagent(agentId: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.id) {
      return Promise.resolve({
        ok: false,
        reason: "this session is not open yet: nothing was sent",
      });
    }
    return this.client.messageSubagent(this.id, agentId, text);
  }

  /** Stop one background child (`session/agent_kill`); `{killed: false}` when it was not running. */
  killSubagent(agentId: string): Promise<{ killed: boolean }> {
    if (!this.id) {
      return Promise.resolve({ killed: false });
    }
    return this.client.killSubagent(this.id, agentId);
  }

  /**
   * Read one background SHELL job's output tail (`session/job_output`,
   * docs/feat/shell-jobs-panel.md). The result is bounded and sanitized by the
   * client; a refusal (unknown id, an older daemon) is `{found: false, reason}`,
   * never a throw at the TUI. One merged line array, as the model sees it.
   */
  jobOutput(
    jobId: string,
    opts?: { readonly lines?: number; readonly maxChars?: number },
  ): Promise<JobOutputResult> {
    if (!this.id) {
      return Promise.resolve({ found: false, jobId, reason: "this session is not open yet" });
    }
    return this.client.jobOutput(this.id, jobId, opts);
  }

  /** Stop one background SHELL job (`session/job_kill`); `{killed: false}` when it was not running. */
  killJob(jobId: string): Promise<{ killed: boolean }> {
    if (!this.id) {
      return Promise.resolve({ killed: false });
    }
    return this.client.killJob(this.id, jobId);
  }

  /**
   * Subscribe to MY rows coming back (docs/feat/queued-broadcast.md): a row I
   * queued that its turn left undrained, which no send-now carried on. Each
   * row is given once, with the text I typed (never the daemon's), then
   * reclaimed daemon-side. The listener puts them back in front of the user;
   * nothing is ever re-sent by itself. A send-now cancelled before it started
   * gives back only its own texts (they reject with its events); a row the
   * listener already restored by itself meanwhile comes here too — it skips
   * it (the client never guesses what the caller still holds). With no listener nothing is reclaimed:
   * the rows wait daemon-side (a reclaim with nobody to show them to would be
   * a silent drop). Returns an unsubscribe.
   */
  onReturned(listener: (rows: readonly ReturnedRow[]) => void): () => void {
    this.returnedListeners.add(listener);
    this.unsubscribeQueue ??= this.client.onSessionQueued((notice) => {
      if (notice.sessionId === this.id) {
        this.queueChanged(notice.state);
      }
    });
    const now = this.queued;
    if (now) {
      this.queueChanged(now);
    }
    return () => {
      this.returnedListeners.delete(listener);
      if (this.returnedListeners.size === 0) {
        this.unsubscribeQueue?.();
        this.unsubscribeQueue = null;
      }
    };
  }

  /** A queue state (live or a resync's): give back my new returned rows, reclaim all of mine. */
  private queueChanged(state: QueueState): void {
    const id = this.id;
    if (!id || this.returnedListeners.size === 0) {
      return;
    }
    // The ids my live send-now carries: its end covers them (sent or restored).
    const carried = new Set(
      [this.active, this.next].flatMap((turn) =>
        turn?.sendNow && !turn.ended ? turn.sendNow.messages.map((m) => m.id) : [],
      ),
    );
    const { give, reclaim } = handBack(state, this.mine, this.handedBack, carried);
    for (const row of give) {
      this.handedBack.add(row.id);
    }
    if (give.length > 0) {
      for (const listener of [...this.returnedListeners]) {
        listener(give);
      }
    }
    const ids = reclaim.filter((key) => !this.reclaiming.has(key));
    if (ids.length === 0) {
      return;
    }
    for (const key of ids) this.reclaiming.add(key);
    // Fire-and-forget: a failure (a drop, a closed session) is retried at the
    // next state that still lists them; never a second hand-back.
    this.client.reclaim(id, ids).then(
      () => {
        for (const key of ids) this.reclaiming.delete(key);
      },
      () => {
        for (const key of ids) this.reclaiming.delete(key);
      },
    );
  }

  /** `snapshot`, with the daemon's title (see `RemoteClient.readBack`); null before the first send. */
  async readBack(): Promise<ReadBack | null> {
    return this.id ? this.client.readBack(this.id) : null;
  }

  /**
   * End the remote session daemon-side (its turn, its background jobs): the
   * TUI's `/clear`. Idempotent; fire-and-forget. While the first `send` is
   * still opening it, the close follows the open. A no-op before any send.
   * Built with `closeIfLast`: only detached while another client is attached.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeQueue?.();
    this.unsubscribeQueue = null;
    const opts = this.closeIfLast ? { ifLast: true } : {};
    if (this.id) {
      void this.client.closeSession(this.id, opts);
    } else if (this.opening) {
      this.opening.then(
        (id) => this.client.closeSession(id, opts),
        () => {},
      );
    }
  }

  /**
   * The session's id (the daemon's once opened, else the one it will open):
   * an opaque key for the caller — shown, never parsed.
   */
  /** Others share this session (built with `closeIfLast`): see `SessionStreamListener.shared`. */
  get shared(): boolean {
    return this.closeIfLast;
  }

  get sessionId(): string | null {
    return this.id ?? this.desiredId ?? null;
  }

  /** How many of my queued rows stay on the daemon if this session stops being followed now (QN2). */
  stayingRows(): number {
    const state = this.queued;
    return state ? stayingRows(state, this.mine, this.handedBack) : 0;
  }

  /**
   * Stop following this session WITHOUT ending it (`session/detach`): it runs
   * on daemon-side for any client (turn, jobs, asks, queue). Later sends are
   * refused like after `close()`. Once the daemon answered, a foreign turn's
   * stream ends with no outcome (never a guessed `turn_end`) and what was held
   * for `watch` is dropped. While the first open is in flight, the detach
   * follows it; before any open, nothing exists daemon-side. Rejects only
   * `MethodNotFound` (an older daemon): nothing changed, sends work again.
   */
  async detach(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    let id = this.id;
    if (!id && this.opening) {
      id = await this.opening.then(
        (opened) => opened,
        () => null,
      );
    }
    if (id) {
      try {
        await this.client.detachSession(id);
      } catch (error) {
        this.closed = false;
        throw error;
      }
    }
    this.unsubscribeQueue?.();
    this.unsubscribeQueue = null;
    this.watcher = null;
    this.unwatched = [];
    this.streaming = null;
    if (this.foreign) {
      this.closeWithoutOutcome(this.foreign);
    }
  }

  /**
   * This session's skills, read again from disk by the daemon (`session/skills`,
   * docs/feat/skills-hot-reload.md). Before the first send there is no
   * daemon-side session: the skills a session created now would have — what
   * that send's `/name` is checked against. While that send (or the eager
   * attach) is still opening it, waits for the id.
   */
  async skills(): Promise<SessionSkillsResult> {
    const id = this.id ?? (this.opening ? await this.opening : null);
    return this.client.sessionSkills(id ?? undefined);
  }

  /**
   * The context the daemon counts for this session (`session/context`,
   * docs/feat/tui-target-badge.md): exact when its provider can count, else an
   * estimate. Before the first send there is no daemon-side session: the fresh
   * conversation a session created now would send. While the eager attach is
   * still opening the session, waits for the id.
   */
  async context(): Promise<{ readonly used: number; readonly exact: boolean }> {
    let id = this.id ?? (this.opening ? await this.opening : null);
    // An attach not opened yet (the TUI asks before its eager open): open it
    // first and count THAT history — never a fresh empty conversation. A failed
    // attach rejects (no figure), it does not fall through.
    if (id === null && this.attach && this.desiredId !== undefined) {
      await this.open();
      id = this.id;
    }
    if (id !== null) {
      return this.client.sessionContext(id);
    }
    // A resumed session not opened yet: its seed is what the first prompt sends.
    return this.client.sessionContext(undefined, this.seedMessages);
  }

  /**
   * Reset the remote conversation in place. A RESUMED session nothing has
   * opened yet (`/clear` typed before any turn, docs/fix/clear-silent-noop.md)
   * holds its conversation only as this client's SEED, with nothing daemon-side
   * under its id: `openForReset` opens it exactly as the first prompt would,
   * and THAT is cleared — never a hollow `{0, 0}` with the chat and its context
   * untouched. A session with nothing to open (a fresh one) stays the plain
   * no-op: a clear never CREATES one.
   */
  async clear(): Promise<{ before: number; after: number }> {
    await this.openForReset();
    const id = this.id;
    if (!id) {
      return { before: 0, after: 0 };
    }
    return this.client.clear(id);
  }

  /**
   * The open a RESET (`/clear`, `/compact`) needs and no other path does: a
   * session whose conversation lives ONLY on the daemon side under an id this
   * client has not opened yet — a resumed one (its chat is this client's SEED)
   * or an attach whose eager dial is still in flight (`connect`, `attach`) — is
   * opened FIRST, exactly as the first prompt would, so the reset reaches the
   * real conversation and keeps a copy of what it drops. A separate step so the
   * caller can read the pre-clear history back FIRST (that read is what the fork
   * is made of) and arm its own bookkeeping only once the open has settled (its
   * attach snapshot would otherwise be read as another device's, review M1).
   * A fresh session with nothing to reset is never opened: a reset never
   * CREATES a session.
   */
  async openForReset(): Promise<void> {
    if (this.id !== null) {
      return; // already open: the ordinary path
    }
    if (this.attach) {
      await this.open(); // the eager attach (in flight, or now): that session, never created
      return;
    }
    if ((this.seedMessages?.length ?? 0) === 0) {
      return; // a fresh session: nothing daemon-side to reset
    }
    await this.openSeeded();
  }

  /**
   * Compact the remote conversation. A resumed session nothing has opened yet
   * holds its chat only as this client's SEED: the open comes first, exactly as
   * `/clear`'s does, so a compaction reaches the real conversation instead of
   * answering a hollow `{0, 0}` (review M2). A fresh session stays the plain
   * no-op: a compaction never CREATES one.
   */
  async compact(): Promise<{ before: number; after: number }> {
    await this.openForReset();
    if (!this.id) {
      return { before: 0, after: 0 };
    }
    return this.client.compact(this.id);
  }

  /**
   * Apply this client's carried settings to the session (`/settings sync`,
   * docs/feat/session-settings-apply.md). Null when no session is open yet: a
   * session opened later is created from these settings anyway.
   */
  async applySettings(): Promise<UpdateSettingsResult | null> {
    if (!this.id) {
      return null;
    }
    return this.client.updateSettings(this.id);
  }

  /** The session's settings as last reported: `open` false before it is opened. */
  settingsState(): { readonly open: boolean; readonly report?: SessionSettingsReport } {
    if (!this.id) {
      return { open: false };
    }
    const report = this.client.settingsOf(this.id);
    return { open: true, ...(report ? { report } : {}) };
  }

  /** The remote session's current history, or null if none was opened yet. */
  async snapshot(): Promise<readonly ChatMessage[] | null> {
    return this.id ? this.client.snapshot(this.id) : null;
  }

  /**
   * Queue a user message mid-turn (steering). Resolves when the daemon has
   * accepted it; REJECTS on a delivery failure (e.g. `MethodNotFound` from an
   * older remote daemon, or a transport drop) so the caller can reconcile its
   * optimistic pending entry. While the first send is still opening the
   * session it waits for the id (the turn is already running for the caller);
   * a no-op (resolved) before any send. `id`: the caller's key for this text
   * (a later `sendNow` cites it); a fresh one when omitted.
   */
  enqueue(text: string, id?: string): Promise<void> {
    // The turn the daemon runs (a foreign one: any device can steer it); an
    // own turn not started yet keeps its own id.
    const turnId = this.streaming ?? this.turnId;
    if (turnId === null) {
      return Promise.resolve();
    }
    const key = id ?? crypto.randomUUID();
    // Mine from now on: if the daemon ever returns this id, it is my text.
    if (!this.mine.has(key)) {
      this.mine.set(key, text);
    }
    if (this.id) {
      return this.client.enqueue(this.id, key, turnId, text);
    }
    if (this.opening) {
      return this.opening.then((id) => this.client.enqueue(id, key, turnId, text));
    }
    return Promise.resolve();
  }

  /**
   * `opts.skill`: the user activates that skill (`/name`) with this prompt.
   * `opts.turnId`: the turn's id, minted by the caller (a detached run's relay
   * records it so the TUIs that take the run over own its turn,
   * docs/fix/detach-live.md B2); else a fresh one.
   */
  async *send(
    prompt: string,
    signal?: AbortSignal,
    opts: { readonly skill?: string; readonly turnId?: string } = {},
  ): AsyncGenerator<SessionEvent> {
    // Known before the first `await`, so a steer typed while the session is
    // still opening is already bound to this turn.
    const turnId = opts.turnId ?? crypto.randomUUID();
    this.turnId = turnId;
    this.mint(turnId);
    yield* this.runTurn(turnId, prompt, signal, opts.skill);
  }

  /**
   * `session/send_now`: cancel the running turn (`target: "turn"`) or
   * compaction and start a new turn whose prompt is `messages` (`id`: the
   * `enqueue` key, if it was enqueued). Resolves on the daemon's ack with the
   * new turn's events: a `user_message` with the prompt the daemon actually
   * sent (none for a continuation, prompt ""), then the turn as `send` yields
   * it. REJECTS, with nothing changed, on a refusal: `MethodNotFound` (an
   * older daemon), `TurnInProgress`, `NoTurnRunning`, `InvalidParams` (no
   * messages). The events reject `Cancelled` if the turn was cancelled before
   * it started: it delivered nothing, so the caller restores its texts.
   * Enqueues keep binding to the old turn until it ends (the daemon carries
   * them over).
   *
   * Never a client-side guess (owner principle): with no live turn here (the
   * old one already ended, e.g. its `turn_end` arrived first) the request
   * still goes out, naming the last turn — the daemon decides: a turn with
   * the texts it did not get, a continuation, or `NoTurnRunning`. While the
   * first `send` is still opening the session it waits for the id. Refused
   * locally only when there is no daemon-side session or turn at all.
   */
  async sendNow(
    messages: readonly SendNowMessage[],
    target: "turn" | "compaction",
    signal?: AbortSignal,
  ): Promise<AsyncIterable<SessionEvent>> {
    if (messages.length === 0) {
      throw new RpcError(JsonRpcErrorCode.InvalidParams, "send-now needs at least one message");
    }
    if (this.closed) {
      throw new RpcError(DomainErrorCode.UnknownSession, "this session was closed");
    }
    // The first send's open resumes first (it awaited first): its turn is
    // installed and its prompt written before this request.
    const id = this.id ?? (this.opening ? await this.opening : null);
    if (this.closed) {
      throw new RpcError(DomainErrorCode.UnknownSession, "this session was closed");
    }
    this.refuseIfRemoteClosed();
    // A streaming foreign turn is the current one too: the successor waits
    // for its end; the interrupt names the turn the daemon runs.
    const foreign = this.foreign && !this.foreign.ended ? this.foreign : null;
    const current = this.active && !this.active.ended ? this.active : foreign;
    const bound = this.streaming ?? this.turnId;
    if (!id || (target === "turn" && bound === null)) {
      throw new RpcError(DomainErrorCode.NoTurnRunning, "no turn is running");
    }
    if (this.next) {
      // Refused here, not by the daemon: the caller restores every text.
      const refusal = new RpcError(DomainErrorCode.TurnInProgress, "a send-now is already waiting");
      for (const key of restoredByRefusal(refusal, messages)) this.handedBack.add(key);
      throw refusal;
    }
    const interrupt: SendNowTarget =
      target === "turn" && bound !== null
        ? { kind: "turn", turnId: bound }
        : { kind: "compaction" };
    const turn: ActiveTurn = {
      turnId: crypto.randomUUID(),
      prompt: "",
      queue: new AsyncQueue<SessionEvent>(),
      toolNames: new Map(),
      shownTools: new Set(),
      reset: false,
      ended: false,
      acked: false,
      sent: false,
      abortWanted: false,
      sendNow: { interrupt, messages: [...messages] },
      started: false,
    };
    for (const m of messages) {
      if (!this.mine.has(m.id)) {
        this.mine.set(m.id, m.text);
      }
    }
    // Installed BEFORE the request goes out: the daemon may hand over (old
    // `turn_end`, then this turn's updates) before its ack arrives.
    const before = this.turnId;
    if (current) {
      this.next = turn;
    } else {
      this.install(turn);
    }
    // Esc cancels it like `send`'s, also before the ack (re-sent on the ack:
    // only then does the daemon hold the new turn) or before the caller iterates.
    const onAbort = (): void => {
      turn.abortWanted = true;
      this.client.cancel(id, turn.turnId);
    };
    signal?.addEventListener("abort", onAbort);
    try {
      await new Promise<void>((resolve, reject) => {
        this.sendPrompt(id, turn, (error) => (error === undefined ? resolve() : reject(error)));
      });
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      // The caller restores the texts the daemon does not report holding: those
      // are given back already — a later `returned` of one is only reclaimed.
      for (const key of restoredByRefusal(error, messages)) {
        this.handedBack.add(key);
      }
      // Refused: the client is left as before the call.
      if (this.next === turn) {
        this.next = null;
      }
      if (this.active === turn) {
        // Installed (no turn to wait for, or promoted at the old turn's end):
        // its `unsupported` notices (idle ones it took, any since) go back to
        // the idle list, never dropped; nobody iterated its queue.
        this.active = null;
        this.turnId = before;
        const notices = turn.queue.takeBuffered().filter((e) => e.type === "unsupported");
        this.idleNotices = [...notices, ...this.idleNotices];
      }
      throw error;
    }
    return this.stream(turn, () => signal?.removeEventListener("abort", onAbort));
  }

  /** A send-now turn's events, until its end. */
  private async *stream(turn: ActiveTurn, done: () => void): AsyncGenerator<SessionEvent> {
    try {
      yield* turn.queue;
    } finally {
      done();
      if (this.active === turn) {
        this.active = null;
      }
    }
  }

  /** `turn` becomes the streamed one: steering binds to it from now on. */
  private install(turn: ActiveTurn): void {
    this.active = turn;
    this.turnId = turn.turnId;
    // Defensive: `install` only gets own turns today (foreign ones go through
    // `startForeign`).
    if (turn.foreign !== true) {
      this.mint(turn.turnId);
    }
    for (const notice of this.idleNotices.splice(0)) {
      turn.queue.push(notice);
    }
  }

  /** `ended` was the active turn: hand the stream to the waiting send-now, if any. */
  private promote(ended: ActiveTurn): void {
    if (this.settling === ended) {
      this.settling = null; // its real end arrived: nothing to hand over
      return;
    }
    const next = this.next;
    // A send-now on a foreign turn waits for ITS end (with no own turn in
    // flight: an own prompt that lost the slot promotes it when it fails).
    const own = this.active && !this.active.ended ? this.active : null;
    if (next && (this.active === ended || (ended.foreign === true && own === null))) {
      this.next = null;
      this.install(next);
    }
  }

  /** A send after another device closed (or deleted) the session: a clear refusal. */
  private refuseIfRemoteClosed(): void {
    if (this.remoteClosed) {
      throw new RpcError(
        DomainErrorCode.UnknownSession,
        "this session was closed on another device",
      );
    }
  }

  private async *runTurn(
    turnId: string,
    prompt: string,
    signal?: AbortSignal,
    skill?: string,
  ): AsyncGenerator<SessionEvent> {
    if (this.closed) {
      throw new RpcError(DomainErrorCode.UnknownSession, "this session was closed");
    }
    this.refuseIfRemoteClosed();
    if (this.attach) {
      // An attach-only session is never created by a send: the attach first.
      await this.open();
    } else {
      await this.createOrAttach();
    }
    const id = this.id;
    if (id === null) {
      throw new RpcError(DomainErrorCode.UnknownSession, "the session is not open");
    }
    // A send never CLOBBERS a turn already in flight: the old turn would lose
    // its owner here, its `turn_end` would find no turn to end (`turnFor` does
    // not see it), and its stream would never settle — the session stays
    // "running" for ever and every later send is queued or refused (the
    // owner's engine-restart repro). Refused with the daemon's own code, so a
    // caller that handles a daemon refusal handles this one too.
    if (this.active !== null && !this.active.ended) {
      throw new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
    }
    const turn: ActiveTurn = {
      turnId,
      prompt,
      ...(skill !== undefined ? { skill } : {}),
      queue: new AsyncQueue<SessionEvent>(),
      toolNames: new Map(),
      shownTools: new Set(),
      reset: false,
      ended: false,
      acked: false,
      sent: false,
      abortWanted: false,
      started: false,
    };
    this.active = turn;
    for (const notice of this.idleNotices.splice(0)) {
      turn.queue.push(notice);
    }
    const onAbort = (): void => {
      turn.abortWanted = true;
      this.client.cancel(id, turn.turnId);
    };
    signal?.addEventListener("abort", onAbort);
    this.sendPrompt(id, turn);
    try {
      yield* turn.queue;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.active === turn) {
        this.active = null;
      }
    }
  }

  /**
   * `prompt{turnId}`, or `send_now{turnId}` for a send-now turn (re-sent with
   * the same key after a drop: the daemon runs it once). `settled`: called
   * once the request is answered (no argument) or refused (the error).
   */
  private sendPrompt(id: string, turn: ActiveTurn, settled?: (error?: unknown) => void): void {
    const sent = (): void => {
      turn.sent = true;
    };
    const request = turn.sendNow
      ? this.client.sendNow(id, turn.turnId, turn.sendNow.interrupt, turn.sendNow.messages, sent)
      : this.client.prompt(id, turn.turnId, turn.prompt, sent, turn.skill);
    request.then(
      // A plain ack: the stream ends the turn. `ended` (a retried turn that
      // already finished — also while this client was away) ends it from the
      // ack; a no-op if the stream did.
      (ack) => {
        turn.acked = true;
        if (ack.ended) {
          this.finish(turn, ack.ended);
        } else if (turn.abortWanted) {
          // Esc before the daemon had the turn (e.g. while the link was down):
          // that cancel found nothing to cancel; now it does.
          this.client.cancel(id, turn.turnId);
        }
        settled?.();
      },
      (error) => {
        this.fail(turn, error);
        settled?.(error);
      },
    );
  }

  // --- the session's stream (SessionStreamListener) -----------------------

  /**
   * One ordered output of the session's stream. A turn-scoped update goes to
   * the turn the reducer stamped it with (`out.turn`) — own or foreign, never
   * "the active own turn" (an own prompt that lost the slot would show the
   * other turn's output). Session-level updates are never routed to a turn
   * (docs/feat/tui-foreign-turns.md B2).
   */
  output(out: StreamOutput): void {
    const old = this.active;
    const next = this.next;
    if (old && !old.ended && next && out.kind === "reset" && out.turn === next.turnId) {
      // A resync whose cut is past the hand-off: the old turn's `turn_end` is
      // behind the cut and will never stream. The successor takes the stream
      // now; the old turn ends with its REAL outcome from its re-sent prompt's
      // `ended` (`recovered` runs right after this reset). It is never guessed:
      // the successor started, so the daemon has the old turn's end cached.
      this.settling = old;
      this.next = null;
      this.install(next);
    }
    switch (out.kind) {
      case "reset":
        this.onReset(out);
        return;
      case "update":
        this.noteStarted(out.update);
        this.route(out.update, out.turn);
        return;
      case "error": {
        // A frame this client cannot act on (unknown mandatory, malformed):
        // fail the turn loudly, and cancel MY turns by id so the daemon does
        // not run them unobserved (my waiting send-now too). Another device's
        // turn only fails HERE: it is not mine to stop (F1,
        // docs/feat/connect-sessions.md). A settling turn is left to its prompt.
        const mine = [this.active, this.next].flatMap((turn) =>
          turn && !turn.ended ? [turn.turnId] : [],
        );
        this.failAll(out.error);
        const id = this.id;
        if (id) {
          for (const turnId of mine) this.client.cancel(id, turnId);
        }
        return;
      }
      case "unsupported": {
        // The reducer reports an unknown type once: shown in the turn that
        // streams, or kept for the next turn while idle — never dropped
        // (docs/feat/protocol-v10-forward-compat.md).
        const turn = this.streamedTurn();
        if (turn) {
          turn.queue.push({ type: "unsupported", kind: out.type });
        } else {
          this.idleNotices.push({ type: "unsupported", kind: out.type });
        }
        return;
      }
      case "turn_lost":
        // A settling old turn is not failed here: its re-sent `prompt` is in
        // flight, and `sessionCall` rejects it (a keyed call never crosses a
        // recreate), which fails it through `sendPrompt`.
        this.streaming = null;
        // A foreign turn died with the daemon's session too.
        if (this.foreign && !this.foreign.ended) {
          this.fail(
            this.foreign,
            new RpcError(
              DomainErrorCode.UnknownSession,
              "the daemon lost the session; the turn in flight was not re-run",
            ),
          );
        }
        // The active turn, then (promoted by its failure) a waiting send-now.
        for (let lost = this.active; lost && !lost.ended; lost = this.active) {
          if (!lost.sent) {
            // Typed while the link was down: no daemon ever had it, so it is
            // not lost — it goes to the recreated session (`sessionCall`).
            return;
          }
          this.fail(
            lost,
            new RpcError(
              DomainErrorCode.UnknownSession,
              "the daemon lost the session; the turn in flight was not re-run",
            ),
          );
        }
        return;
      case "failed":
        this.failAll(new Error(out.reason));
        return;
    }
  }

  /** The tracked turn (own or foreign) with this id, ended or not. */
  private turnFor(turnId: string): ActiveTurn | null {
    for (const turn of [this.settling, this.active, this.next, this.foreign]) {
      if (turn?.turnId === turnId) {
        return turn;
      }
    }
    return null;
  }

  /** The unended turn the stream shows running, else the own turn in flight. */
  private streamedTurn(): ActiveTurn | null {
    const streamed = this.streaming !== null ? this.turnFor(this.streaming) : null;
    if (streamed && !streamed.ended) {
      return streamed;
    }
    return this.active && !this.active.ended ? this.active : null;
  }

  /** A turn this session did not start: tracked, announced to the watcher, never sent. */
  private startForeign(turnId: string, prompt: string): ActiveTurn {
    const turn: ActiveTurn = {
      turnId,
      prompt,
      queue: new AsyncQueue<SessionEvent>(),
      toolNames: new Map(),
      shownTools: new Set(),
      reset: false,
      ended: false,
      acked: false,
      sent: false,
      abortWanted: false,
      started: true,
      foreign: true,
    };
    this.foreign = turn;
    for (const notice of this.idleNotices.splice(0)) {
      turn.queue.push(notice);
    }
    // Its prompt, as the daemon sent it (none for a continuation, or for a
    // turn already running at a reset: the snapshot shows it).
    if (prompt !== "") {
      turn.queue.push({ type: "user_message", text: prompt });
    }
    this.raise({
      kind: "turn",
      turnId,
      events: turn.queue,
      cancel: () => {
        if (this.id) this.client.cancel(this.id, turnId);
      },
    });
    return turn;
  }

  /**
   * A foreign turn that ended behind a resync's cut: its outcome is not known
   * here and is never guessed — its stream closes with no `turn_end` (the
   * snapshot shows what it did).
   */
  private closeWithoutOutcome(turn: ActiveTurn): void {
    if (turn.ended) {
      return;
    }
    turn.ended = true;
    turn.queue.close();
    this.promote(turn);
  }

  /** A snapshot replaced the history: into the turn running at the cut, else a `history` activity. */
  private onReset(out: Extract<StreamOutput, { kind: "reset" }>): void {
    const replaced = this.replaced;
    this.replaced = null;
    if (replaced?.reason === "context_reset") {
      this.onContextReset(out, replaced.turnId);
      return;
    }
    // A compaction holds the slot, so no own prompt can be in flight at its
    // barrier. A `/clear` does not: an own turn (a wake, a prompt) may start
    // between the barrier and this snapshot (docs/feat/clear-keeps-jobs.md,
    // review H2). That turn's updates are AFTER the barrier's seq, so it takes
    // the snapshot IN-TURN (below): never a separate replace that would later
    // wipe it from the screen.
    const compacted = replaced !== null && replaced.reason !== "clear";
    const shown = this.foreign;
    if (shown && !shown.ended && shown.turnId !== out.turn) {
      this.closeWithoutOutcome(shown);
    }
    this.streaming = out.turn;
    let turn: ActiveTurn | null = null;
    if (out.turn !== null) {
      // A resumed turn after a daemon restart, or one running when we
      // attached, streams no `turn_start`: the reset names it.
      turn = this.turnFor(out.turn) ?? this.startForeign(out.turn, "");
    } else if (!compacted && this.active && !this.active.ended) {
      turn = this.active; // an own prompt not started at the cut (today's reset)
    }
    if (!turn || turn.ended) {
      // `replaced.reason` is `compact` or `clear` here: `context_reset` returned above.
      this.raise({
        kind: "history",
        messages: out.messages,
        reason: replaced !== null ? replaced.reason : null,
      });
      return;
    }
    // Everything shown is replaced by the snapshot; tool calls it already
    // lists are re-announced by the replay — shown once (upsert).
    turn.reset = true;
    if (out.turn === turn.turnId) {
      turn.started = true; // running at the cut: its prompt is in the snapshot
    }
    turn.shownTools = new Set(out.messages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
    for (const m of out.messages) {
      for (const call of m.toolCalls ?? []) turn.toolNames.set(call.id, call.name);
    }
    turn.queue.push({ type: "history_reset", messages: out.messages });
  }

  /**
   * A context reset's snapshot: the model renewed its context INSIDE the turn
   * `resetIn` (the barrier's stamp). That turn's screen is KEPT — a
   * `context_reset` event appends the new history — and its updates past the
   * cut follow. A cut that no longer names it: it ended behind the cut (its
   * `turn_end` never streams) — a foreign one closes with no outcome, an own
   * one learns its REAL end by re-sending its prompt (same key: the daemon
   * answers `ended` from its cache; never guessed). Untracked: a `history`
   * activity that keeps the screen too. A newer turn running at the cut is
   * tracked as at any reset.
   */
  private onContextReset(
    out: Extract<StreamOutput, { kind: "reset" }>,
    resetIn: string | null,
  ): void {
    const shown = this.foreign;
    this.streaming = out.turn;
    // Still running at the cut but not tracked here (its own consumer stopped
    // reading): taken up as at any reset, so its updates past the cut are not
    // dropped.
    const turn =
      resetIn === null
        ? null
        : (this.turnFor(resetIn) ?? (out.turn === resetIn ? this.startForeign(resetIn, "") : null));
    if (turn && !turn.ended) {
      // The calls it lists are shown by the event: a replayed `tool_call` is not shown again.
      for (const m of out.messages) {
        for (const call of m.toolCalls ?? []) {
          turn.toolNames.set(call.id, call.name);
          turn.shownTools.add(call.id);
        }
      }
      turn.queue.push({ type: "context_reset", messages: out.messages });
      if (out.turn !== turn.turnId) {
        this.endedBehindCut(turn);
      }
    } else {
      this.raise({ kind: "history", messages: out.messages, reason: "context_reset" });
    }
    if (shown && !shown.ended && shown.turnId !== out.turn) {
      this.closeWithoutOutcome(shown);
    }
    if (out.turn !== null && out.turn !== resetIn) {
      const running = this.turnFor(out.turn) ?? this.startForeign(out.turn, "");
      running.started = true; // running at the cut: its prompt is in the snapshot
    }
  }

  /** `turn` ended behind a cut: its outcome comes from the daemon, never a guess. */
  private endedBehindCut(turn: ActiveTurn): void {
    if (turn.foreign) {
      this.closeWithoutOutcome(turn);
      return;
    }
    // An ack still in flight carries `ended` itself.
    const id = this.id;
    if (
      id &&
      turnRecovery({ recreated: false, ended: turn.ended, acked: turn.acked }).resendPrompt
    ) {
      this.sendPrompt(id, turn);
    }
  }

  /**
   * The calls of the running turn that STARTED, as the daemon streamed them
   * (`running` precedes each start in stream order): what a cut labels
   * "Interrupted"; every other unanswered call "Not run".
   */
  runningCalls(): ReadonlySet<string> {
    return new Set(this.started);
  }

  /** Record a start signal (or forget the last turn's) at receipt. */
  private noteStarted(update: SessionUpdate): void {
    if (update.type === "turn_start") {
      this.started.clear();
    } else if (update.type === "tool_call_phase" && update.phase === "running") {
      this.started.add(update.toolCallId);
    }
  }

  /** One applied update: by its turn (`turnId`, the reducer's stamp), or session-level. */
  private route(update: SessionUpdate, turnId: string | null): void {
    switch (update.type) {
      case "turn_start": {
        this.streaming = update.turnId;
        const own = this.turnFor(update.turnId);
        if (own) {
          if (!own.ended) this.onUpdate(own, update);
          return;
        }
        this.startForeign(update.turnId, update.prompt);
        return;
      }
      case "turn_end": {
        if (this.streaming === update.turnId) {
          this.streaming = null;
        }
        // None tracked: a foreign send-now that never started (it delivered nothing).
        const turn = this.turnFor(update.turnId);
        if (turn && !turn.ended) this.onUpdate(turn, update);
        return;
      }
      case "session_closed":
        this.onClosed(update.reason);
        return;
      case "history_replaced":
        // The barrier: the next reset is its snapshot (a daemon fact, never a guess).
        this.replaced = { reason: update.reason, turnId };
        return;
      // Owned elsewhere: the permission router (the dialog), the job-exit, the
      // title, the queue and the sub-agent list listeners (they fire even while idle).
      case "permission_request":
      case "permission_resolved":
      case "background_exit":
      case "session_title":
      case "queued":
      case "subagents":
      case "jobs":
      case "subagent_notify":
      case "subagent_message":
        return;
      default: {
        // Turn-scoped: always inside its turn's brackets (T-B0), so a null or
        // untracked stamp is dropped.
        const turn = turnId !== null ? this.turnFor(turnId) : null;
        if (turn && !turn.ended) this.onUpdate(turn, update);
      }
    }
  }

  /** Closed daemon-side: every open turn ends (each got `turn_end{cancelled}` before), then the notice. */
  private onClosed(reason: EndReason): void {
    this.remoteClosed = true;
    this.streaming = null;
    this.failAll(new RpcError(DomainErrorCode.UnknownSession, "the session was closed"));
    if (!this.closed) {
      // Not after my own `close` (`/clear`): that is no news to this device.
      this.raise({ kind: "closed", reason });
    }
  }

  /** Back after a drop or a forced reopen: re-send what the link may have lost. */
  recovered(info: { readonly recreated: boolean }): void {
    const id = this.id;
    if (!id) {
      return;
    }
    // The old turn first: its ack can end it (and promote the send-now). A
    // settling old turn learns its real end the same way.
    for (const turn of [this.settling, this.active, this.next]) {
      if (turn && turnRecovery({ ...info, ended: turn.ended, acked: turn.acked }).resendPrompt) {
        this.sendPrompt(id, turn);
      }
    }
  }

  /** Ended or deleted daemon-side while the link was down (the reconnect's refusal, by code). */
  ended(reason: EndReason): void {
    this.onClosed(reason);
  }

  /** The link is gone for good: the turn's outcome can never arrive. */
  linkClosed(error: Error): void {
    this.failAll(error);
  }

  /**
   * Fail the active turn, then the send-now its failure promoted. A settling
   * old turn is left to its in-flight `prompt`: on a dead link or a failed
   * session `sessionCall` rejects it (`whenLive`); on an `error` frame (the
   * link is fine) its real end still arrives — failing it would be a guess.
   */
  private failAll(error: unknown): void {
    // A foreign turn too: its outcome can never arrive either.
    if (this.foreign && !this.foreign.ended) {
      this.fail(this.foreign, error);
    }
    for (let turn = this.active; turn && !turn.ended; turn = this.active) {
      this.fail(turn, error);
    }
  }

  /** One update of `turn` (`route` picked it by id; session-level ones never get here). */
  private onUpdate(turn: ActiveTurn, update: SessionUpdate): void {
    if (update.type === "turn_start") {
      // Our own prompt is already on screen — unless a reset replaced the
      // screen before the replay re-delivered it. A send-now's prompt is never
      // on screen: the daemon's is what it sent (texts it injected meanwhile
      // are left out; "" for a continuation). Another turn's: ignored.
      if (update.turnId === turn.turnId) {
        if (turn.sendNow) {
          turn.started = true;
        }
        if ((turn.sendNow || turn.reset) && update.prompt !== "") {
          turn.queue.push({ type: "user_message", text: update.prompt });
        }
      }
      return;
    }
    if (update.type === "turn_end") {
      if (update.turnId === turn.turnId) {
        this.finish(turn, update);
      }
      return;
    }
    // Owned elsewhere: the permission router (the dialog), the job-exit, the
    // title, the queue and the sub-agent list listeners (they fire even while idle).
    if (
      update.type === "permission_request" ||
      update.type === "permission_resolved" ||
      update.type === "background_exit" ||
      update.type === "session_title" ||
      update.type === "queued" ||
      update.type === "subagents" ||
      update.type === "jobs" ||
      update.type === "subagent_notify" ||
      update.type === "subagent_message"
    ) {
      return;
    }
    if (update.type === "tool_call" && turn.shownTools.has(update.toolCallId)) {
      turn.toolNames.set(update.toolCallId, update.title);
      return; // already shown by the reset
    }
    const event = updateToEvent(update, turn.toolNames);
    if (event) {
      turn.queue.push(event);
    }
  }

  // The turn ends from the stream (`turn_end` with OUR turnId), whatever the
  // order of the ack and the turn's updates: a model that yields without
  // awaiting can finish the whole turn before the ack frame is sent.
  private end(turn: ActiveTurn, outcome: TurnEnd): void {
    if (turn.ended) {
      return;
    }
    turn.ended = true;
    if (outcome.stopReason === "error") {
      // Same class the old `prompt` rejection had, so the TUI renders it alike.
      turn.queue.fail(
        new RpcError(
          outcome.error?.code ?? JsonRpcErrorCode.InternalError,
          this.client.laptopText(outcome.error?.message ?? "turn failed"),
        ),
      );
    } else {
      turn.queue.push({ type: "turn_end", reason: stopReasonFromProtocol(outcome.stopReason) });
      turn.queue.close();
    }
    this.promote(turn);
  }

  /**
   * The daemon's end of `turn` (stream or ack). A send-now turn cancelled
   * before it started delivered nothing (the `session/send_now` contract):
   * its events reject `Cancelled` so the caller restores its texts. The end's
   * `delivered` is the daemon's fact and decides; a seen `turn_start` is only
   * the fallback for an older daemon (no field) — a resync can hide one, so
   * the fallback restores rather than risk a loss.
   */
  private finish(turn: ActiveTurn, outcome: TurnEnd): void {
    const undelivered =
      outcome.delivered !== undefined
        ? !outcome.delivered
        : !turn.started && outcome.stopReason === "cancelled";
    if (turn.sendNow && undelivered) {
      // Its caller restores the send-now's texts: given back. Any other row of
      // mine comes back only as the daemon's `returned` fact — a caller that
      // also restored it itself dedupes it (review F1: a guess here lost the
      // rows the caller no longer held).
      for (const m of turn.sendNow.messages) this.handedBack.add(m.id);
      this.fail(
        turn,
        new RpcError(DomainErrorCode.Cancelled, "send-now cancelled before it started"),
      );
      return;
    }
    this.end(turn, outcome);
  }

  private fail(turn: ActiveTurn, error: unknown): void {
    if (turn.ended) {
      return;
    }
    turn.ended = true;
    turn.queue.fail(error);
    this.promote(turn);
  }
}
