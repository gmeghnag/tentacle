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
  JsonRpcErrorCode,
  type QueueState,
  type SeedTitle,
  type SendNowMessage,
  type SendNowTarget,
  type SessionUpdate,
  type TurnEnd,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { type ReturnedRow, handBack, restoredByRefusal } from "./hand-back.ts";
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
  /** The daemon's history replaced what is shown while no turn runs (eager open, a resync, a compaction). */
  | {
      readonly kind: "history";
      readonly messages: readonly ChatMessage[];
      readonly compacted: boolean;
    }
  /** The session ended daemon-side (another device's close / delete, the reaper). */
  | { readonly kind: "closed"; readonly reason: "closed" | "deleted" };

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
  /**
   * The turn the daemon's stream says runs (own or foreign): set by a
   * `turn_start` or a reset that names one, cleared by its `turn_end`. What
   * steering, send-now and the activity cancel bind to.
   */
  private streaming: string | null = null;
  /** The foreign turn being streamed (at most one: the daemon has one slot). */
  private foreign: ActiveTurn | null = null;
  /** A `history_replaced` was applied: the next reset is a compaction's (a daemon fact). */
  private compactedPending = false;
  /** The session ended daemon-side (`session_closed`): a later send is refused clearly. */
  private remoteClosed = false;
  private watcher: ((activity: SessionActivity) => void) | null = null;
  /** Activities raised before `watch`: handed over on subscribe, in order. */
  private unwatched: SessionActivity[] = [];

  constructor(
    client: RemoteClient,
    seedMessages?: readonly ChatMessage[],
    desiredId?: string,
    seedTitle?: SeedTitle,
    attach?: { readonly reopen?: boolean },
  ) {
    this.client = client;
    this.seedMessages = seedMessages;
    this.desiredId = desiredId;
    this.seedTitle = seedTitle;
    this.attach = attach;
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
      [this.active, this.next, this.settling].some((turn) => turn?.turnId === turnId)
    );
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
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeQueue?.();
    this.unsubscribeQueue = null;
    if (this.id) {
      void this.client.closeSession(this.id);
    } else if (this.opening) {
      this.opening.then(
        (id) => this.client.closeSession(id),
        () => {},
      );
    }
  }

  /** Compact the remote conversation (no-op if no session was opened yet). */
  async compact(): Promise<{ before: number; after: number }> {
    if (!this.id) {
      return { before: 0, after: 0 };
    }
    return this.client.compact(this.id);
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

  /** `opts.skill`: the user activates that skill (`/name`) with this prompt. */
  async *send(
    prompt: string,
    signal?: AbortSignal,
    opts: { readonly skill?: string } = {},
  ): AsyncGenerator<SessionEvent> {
    // Known before the first `await`, so a steer typed while the session is
    // still opening is already bound to this turn.
    const turnId = crypto.randomUUID();
    this.turnId = turnId;
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
    } else if (!this.id) {
      this.opening = this.client.openSession(
        undefined,
        this.seedMessages,
        this.desiredId,
        this,
        this.seedTitle,
      );
      try {
        this.id = await this.opening;
      } finally {
        this.opening = null;
      }
      this.client.setListener(this.id, this);
    }
    const id = this.id;
    if (id === null) {
      throw new RpcError(DomainErrorCode.UnknownSession, "the session is not open");
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
        this.route(out.update, out.turn);
        return;
      case "error":
        // A frame this client cannot act on (unknown mandatory, malformed):
        // fail the turn loudly, and cancel it so the daemon does not run it
        // unobserved (the cancel also reaches a waiting send-now: fail it too).
        this.failAll(out.error);
        if (this.id) this.client.cancel(this.id);
        return;
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
    const compacted = this.compactedPending;
    this.compactedPending = false;
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
      this.raise({ kind: "history", messages: out.messages, compacted });
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
        // The barrier: the next reset is a compaction's (a daemon fact, never a guess).
        this.compactedPending = true;
        return;
      // Owned elsewhere: the permission router (the dialog), the job-exit, the
      // title and the queue listeners (they fire even while idle).
      case "permission_request":
      case "permission_resolved":
      case "background_exit":
      case "session_title":
      case "queued":
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
  private onClosed(reason: "closed" | "deleted"): void {
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
    // title and the queue listeners (they fire even while idle).
    if (
      update.type === "permission_request" ||
      update.type === "permission_resolved" ||
      update.type === "background_exit" ||
      update.type === "session_title" ||
      update.type === "queued"
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
          outcome.error?.message ?? "turn failed",
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
