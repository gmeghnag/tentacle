/**
 * The client runtime: an `RpcPeer` over the control channel that performs the
 * handshake, opens (and, when done with them, closes) sessions, turns the
 * streamed permission requests into prompts on the local `PermissionBroker` (the
 * TUI's dialog) and the user's answers into `session/resolve_permission` — via
 * the pure `PermissionRouter` — and routes the other `session/update`s to the
 * right `RemoteSession`, in `seq` order (the pure `session-reducer`).
 *
 * Re-attach (docs/feat/client-reattach.md): given a `channelFactory`, a dropped
 * link is not the end. The client dials again (backoff from the pure
 * `link-machine`), builds a new peer — a new GENERATION; frames of an old one
 * are ignored — handshakes, and re-opens every session with the `since` it
 * applied (or resyncs from a snapshot), so a turn, its permission prompt and
 * its stream continue where they were. Session commands wait for their session
 * to be live again; keyed ones (`prompt{turnId}`, `enqueue{id}`, a permission
 * answer) are re-sent, the daemon dedupes. The broker is never rebuilt
 * (AGENTS §7 single-broker invariant). Without a factory a drop is terminal,
 * exactly as before.
 */
import {
  type ChatMessage,
  type ChatRequest,
  DISMISSED,
  type ModelProvider,
  type PermissionBroker,
} from "@tentacle/core";
import {
  type CompactResult,
  DomainErrorCode,
  type HistoryCut,
  type HooksTrustParams,
  type HooksTrustResult,
  type InitializeResult,
  JsonRpcErrorCode,
  KNOWN_UPDATE_TYPES,
  type McpServerStatus,
  type McpStatusResult,
  Method,
  type ModelStreamChunkedParams,
  type ModelStreamChunkedResult,
  type ModelStreamParams,
  type ModelStreamResult,
  Notification,
  type OpenResult,
  PROTOCOL_VERSION,
  type PromptResult,
  type SendNowMessage,
  type SendNowTarget,
  type SessionListParams,
  type SessionListResult,
  type SessionUpdateParams,
  type SkillSummary,
  type SkillsListResult,
  type SnapshotResult,
  type WireStreamEvent,
  text,
} from "@tentacle/protocol";
import { type DuplexChannel, type RequestContext, RpcError, RpcPeer } from "@tentacle/transport";
import {
  ChannelError,
  LIVENESS_MS,
  type LinkState,
  type LinkStatus,
  type LinkStep,
  dialFailed,
  initialLink,
  linkDropped,
  linkUp,
  liveness,
  stopped,
} from "./link-machine.ts";
import { PermissionRouter, type RouterAction } from "./permission-router.ts";
import { RemoteSession } from "./remote-session.ts";
import {
  type StreamEffect,
  type StreamInput,
  type StreamOutput,
  type StreamState,
  initialStream,
  reduceStream,
  sinceOf,
} from "./session-reducer.ts";

/** How long the exit path waits for the daemon to acknowledge `session/close`s. */
export const CLOSE_SESSIONS_TIMEOUT_MS = 1000;
/** Page size `snapshot` reads the history with (bounded frames for long sessions). */
const SNAPSHOT_PAGE = 200;
/** Restarts of a paged `snapshot` after a compaction raced it, before giving up. */
const SNAPSHOT_ATTEMPTS = 3;
/**
 * Pages one `snapshot` may read (10 000 × 200 messages): a daemon — a pod is
 * not trusted — that never stops returning a cursor fails loudly here instead
 * of growing the laptop's memory without bound.
 */
const SNAPSHOT_MAX_PAGES = 10_000;

/**
 * A session's consumer (`RemoteSession`, a mobile view): its ordered stream
 * outputs, and notices about the link.
 */
export interface SessionStreamListener {
  output(out: StreamOutput): void;
  /** The session is live again after a drop or a forced reopen; `recreated`: the daemon had lost it. */
  recovered(info: { readonly recreated: boolean }): void;
  /** The link is gone for good (no factory, a terminal failure, `close()`). */
  linkClosed(error: Error): void;
}

/** A background-job exit surfaced by the daemon, outside any turn. */
export interface BackgroundExitNotice {
  readonly jobId: string;
  readonly command: string;
  readonly status: string;
  readonly exitCode: number | null;
}

/** Timers, injectable so tests drive reconnects deterministically. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RemoteClientOptions {
  readonly onError?: (error: Error) => void;
  /**
   * Opens a fresh channel to the same daemon. Present → a dropped link is
   * re-dialled and every session resumes; absent → a drop is terminal. Reject
   * with a `ChannelError{kind: "unauthorized"}` to stop retrying.
   */
  readonly channelFactory?: () => Promise<DuplexChannel>;
  readonly clock?: Clock;
  /** Jitter source for the backoff, in [0, 1). */
  readonly random?: () => number;
  /**
   * Answers the daemon's `hooks/trust` (docs/feat/hooks-project-trust.md):
   * the laptop decides, through the single broker. `signal` aborts when the
   * link drops (the prompt is withdrawn). Absent → `{ trusted: false }`.
   */
  readonly hooksTrust?: (
    params: HooksTrustParams,
    signal?: AbortSignal,
  ) => Promise<HooksTrustResult>;
}

/** One session this client opened (or is opening) and has not closed. */
interface SessionEntry {
  readonly id: string;
  state: StreamState;
  listener: SessionStreamListener | null;
  /** The newest history this client read: what a recreate seeds the daemon with. */
  history: readonly ChatMessage[];
  /** It was live once: a recovery re-attaches (vs. creates). */
  everLive: boolean;
  /** Times the daemon lost it and it was recreated; keyed commands never cross one. */
  recreates: number;
  /** `recreates` when the listener was last told it recovered. */
  noticedRecreates: number;
  /** The generation on which it is live, or -1. */
  liveGen: number;
  /** A drop or forced reopen happened: tell the listener once it is live again. */
  owesNotice: boolean;
  /** `closeSession` was called: no recovery, no new commands; forgotten once the daemon answers. */
  closing: boolean;
  /** `turn_end`s applied from the stream. */
  turnEndsApplied: number;
  /** `turn_end`s already applied when `history` was read: fewer than applied ⇒ `history` lags. */
  turnEndsInHistory: number;
}

/**
 * The daemon lost a session (a pod's new exec) and the history this client
 * could recreate it from lagged its stream: `turns` finished turns are gone —
 * from the daemon's history, so from the model's context and from the next save.
 */
export interface HistoryLostNotice {
  readonly sessionId: string;
  readonly turns: number;
}

/** A command that must not cross a session recreate (its turn/request is gone). */
class SessionLostError extends RpcError {
  constructor() {
    super(
      DomainErrorCode.UnknownSession,
      "the daemon lost the session (it was recreated): not re-sent",
    );
  }
}

/**
 * `model/streamChunked` coalescing (a leading-edge throttle): after a quiet
 * period an event goes out AT ONCE (no added first-token latency); events that
 * arrive within the next window ride one `$/progress` frame as a batch, so a
 * fast model (or a slow link: k8s exec through the API server, a WAN
 * `connect`) pays per-frame overhead at most once per window, not per event.
 */
export const MODEL_STREAM_COALESCE_MS = 30;
/**
 * Upper bound on one batch's serialized size (UTF-16 units). A batch is closed
 * before it would exceed this, far below a receiver's `maxFrameBytes` (8 MiB on
 * the ws-server); a single event larger than it travels alone.
 */
export const MODEL_STREAM_BATCH_MAX_CHARS = 64 * 1024;

export class RemoteClient {
  /** The current generation's peer. */
  private peer: RpcPeer;
  /** Bumped per channel; callbacks of an older one are ignored. */
  private gen = 0;
  /** The current generation is handshaken (or is the caller's gen 0) and open. */
  private up = true;
  private link: LinkState;
  private dialTimer: unknown = null;
  private disposed = false;
  /** When the current generation last received a frame (liveness; factory only). */
  private lastInboundAt: number;
  /** Outstanding watched requests (issue time), see `call`. */
  private readonly watched = new Map<object, number>();
  private livenessTimer: unknown = null;
  /** The bound on the factory call in flight (`dialChannel`). */
  private dialDeadline: unknown = null;
  /** Set when the link is gone for good: every wait rejects with it. */
  private stopError: Error | null = null;

  private readonly permissions: PermissionBroker;
  private readonly sessions = new Map<string, SessionEntry>();
  /** Session-independent listeners for background-job exits (idle or mid-turn). */
  private readonly exitListeners = new Set<(notice: BackgroundExitNotice) => void>();
  private readonly statusListeners = new Set<(status: LinkStatus) => void>();
  /** The daemon's `/name` skills, from the latest handshake (a reconnect refreshes it). */
  private skillCatalog: readonly SkillSummary[] = [];
  private readonly historyLostListeners = new Set<(notice: HistoryLostNotice) => void>();
  /** Conditions re-checked after every state change (session live, link stopped, …). */
  private readonly waiters = new Set<() => boolean>();
  /** Which permission request is prompted / answered (pure; see its module). */
  private readonly router = new PermissionRouter();
  /** The on-screen prompt's abort handle, by `sessionId` + `requestId`. */
  private readonly prompts = new Map<string, AbortController>();

  private readonly modelProvider?: ModelProvider;
  private readonly onError?: (error: Error) => void;
  private readonly channelFactory?: () => Promise<DuplexChannel>;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly hooksTrust?: RemoteClientOptions["hooksTrust"];
  /** Sessions with a `hooks/trust` prompt in flight (at most one each). */
  private readonly trustAsking = new Set<string>();

  constructor(
    channel: DuplexChannel,
    permissions: PermissionBroker,
    modelProvider?: ModelProvider,
    options: RemoteClientOptions = {},
  ) {
    this.permissions = permissions;
    if (modelProvider) {
      this.modelProvider = modelProvider;
    }
    if (options.onError) {
      this.onError = options.onError;
    }
    if (options.channelFactory) {
      this.channelFactory = options.channelFactory;
    }
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    if (options.hooksTrust) {
      this.hooksTrust = options.hooksTrust;
    }
    this.link = { ...initialLink, upSince: this.clock.now() };
    this.lastInboundAt = this.clock.now();
    this.peer = this.makePeer(channel, 0);
  }

  /** Handshake; rejects on an incompatible daemon version. */
  async initialize(): Promise<InitializeResult> {
    return this.handshake(this.peer);
  }

  /**
   * The skills the user can activate on the daemon (`/name`), as of the latest
   * handshake: empty before the first one; refreshed by every reconnect (a
   * restarted daemon may have other skills). Schema-validated by the peer.
   */
  skills(): readonly SkillSummary[] {
    return this.skillCatalog;
  }

  /**
   * The daemon's MCP servers and whether each is reachable now (`/mcp`). Not
   * re-sent after a drop: it is a fresh probe, the user just asks again. An
   * older daemon rejects with `MethodNotFound`. Schema-validated by the peer.
   */
  mcpStatus(): Promise<readonly McpServerStatus[]> {
    if (!this.up && this.channelFactory) {
      return Promise.reject(new Error("not connected to the daemon"));
    }
    return this.call(this.peer, Method.McpStatus, {}).then(
      (result) => (result as McpStatusResult).servers,
    );
  }

  /**
   * Every skill the daemon discovered and its discovery problems (`/skills`).
   * Static on the daemon, but asked each time (cheap; never stale after a
   * redial to a restarted daemon). An older daemon rejects with
   * `MethodNotFound`. Schema-validated by the peer.
   */
  skillsList(): Promise<SkillsListResult> {
    if (!this.up && this.channelFactory) {
      return Promise.reject(new Error("not connected to the daemon"));
    }
    return this.call(this.peer, Method.SkillsList, {}).then((result) => result as SkillsListResult);
  }

  /**
   * One page of the daemon's sessions (`session/list`), most recent first; pass
   * `cursor` back for the next. Not re-sent after a drop (a fresh read: ask
   * again). An older daemon rejects with `MethodNotFound`. Schema-validated by
   * the peer.
   */
  sessionList(params: SessionListParams = {}): Promise<SessionListResult> {
    if (!this.up && this.channelFactory) {
      return Promise.reject(new Error("not connected to the daemon"));
    }
    return this.call(this.peer, Method.SessionList, params).then(
      (result) => result as SessionListResult,
    );
  }

  /** A controller the Ink App drives exactly like a local `Session`. */
  newSession(seedMessages?: readonly ChatMessage[], sessionId?: string): RemoteSession {
    return new RemoteSession(this, seedMessages, sessionId);
  }

  /**
   * Subscribe to "a recreate could not restore the latest turns" (see
   * `HistoryLostNotice`); returns an unsubscribe. Never silent: a frontend
   * shows it.
   */
  onHistoryLost(listener: (notice: HistoryLostNotice) => void): () => void {
    this.historyLostListeners.add(listener);
    return () => this.historyLostListeners.delete(listener);
  }

  /** Subscribe to the link's status (for a frontend's "reconnecting…"); returns an unsubscribe. */
  onLinkStatus(listener: (status: LinkStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Open the remote session and resolve its id once it is live (attached and,
   * if it was live elsewhere, resynced). `create: true`: a daemon that already
   * has a live one under `sessionId` attaches instead. With a `sessionId` the
   * session's updates are routed (buffered) from before `open` is sent, so
   * nothing a replay sends ahead of the response is lost; without one the
   * daemon picks it (a new session has no updates yet). `listener` receives
   * the session's ordered stream from the first update on.
   */
  async openSession(
    cwd?: string,
    messages?: readonly ChatMessage[],
    sessionId?: string,
    listener?: SessionStreamListener,
  ): Promise<string> {
    const seed = messages ?? [];
    const params = {
      create: true,
      ...(cwd ? { cwd } : {}),
      ...(seed.length > 0 ? { messages: seed } : {}),
    };
    if (sessionId === undefined) {
      const gen = this.gen;
      const result = (await this.call(this.peer, Method.Open, params)) as OpenResult;
      const entry = this.register(result.sessionId, seed, listener);
      this.step(entry, { kind: "open_sent" });
      this.applyOpenResult(entry, gen, result);
      await this.whenLive(entry);
      return result.sessionId;
    }
    const entry = this.register(sessionId, seed, listener);
    try {
      await this.openOn(entry, this.gen, { ...params, sessionId });
      await this.whenLive(entry);
    } catch (error) {
      if (!entry.everLive && this.sessions.get(sessionId) === entry) {
        this.sessions.delete(sessionId);
      }
      throw error;
    }
    return sessionId;
  }

  /**
   * End a session daemon-side (its turn, its background jobs) — sessions
   * outlive connections, so a client that is done with one says so. Resolves
   * when the daemon answered — or the request failed (peer closed: moot);
   * never rejects. While the link is down it resolves at once (the daemon
   * reaps a detached idle session).
   */
  closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    // Routed until the daemon answers: the turn it cancels ends in the stream
    // (`turn_end`, `session_closed`), and those frames precede the response.
    const forget = (): void => {
      if (entry && this.sessions.get(sessionId) === entry) {
        this.sessions.delete(sessionId);
        this.kick();
      }
    };
    if (entry) {
      entry.closing = true;
      this.kick();
    }
    if (!this.up && this.channelFactory) {
      forget();
      return Promise.resolve();
    }
    return this.call(this.peer, Method.Close, { sessionId }).then(forget, forget);
  }

  /**
   * Close every session this client opened and has not closed yet — the exit
   * path. AWAIT it before `close()`: a frame written just before closing is not
   * guaranteed to be delivered on every transport (the in-memory pair drops
   * it). Bounded by `timeoutMs` so a hung daemon never blocks the exit; never
   * rejects.
   */
  async closeSessions(timeoutMs: number = CLOSE_SESSIONS_TIMEOUT_MS): Promise<void> {
    const pending = [...this.sessions.values()]
      .filter((entry) => !entry.closing)
      .map((entry) => this.closeSession(entry.id));
    if (pending.length === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Read the session's history back at its current cut (for the main thread to
   * persist), page by page, newest first, joined chronologically. A compaction
   * landing between two pages makes the cursor stale: start over. With a
   * factory it waits out a drop (read-only: safe to repeat).
   */
  async snapshot(sessionId: string): Promise<readonly ChatMessage[]> {
    const entry = this.sessions.get(sessionId);
    if (!this.channelFactory || !entry) {
      const mark = entry?.turnEndsApplied ?? 0;
      const { messages } = await this.readSnapshot(sessionId, this.peer);
      if (entry) this.historyRead(entry, messages, mark);
      return messages;
    }
    for (;;) {
      const gen = await this.whenLive(entry);
      const mark = entry.turnEndsApplied;
      try {
        const { messages } = await this.readSnapshot(sessionId, this.peer);
        this.historyRead(entry, messages, mark);
        return messages;
      } catch (error) {
        if (gen === this.gen && this.up) throw error;
      }
    }
  }

  /**
   * Start a turn; resolves with the daemon's ack (the turn ends in the stream).
   * Re-sent after a drop (with the same params, `skill` included). `onSent`
   * fires when the frame is first written to a channel: until then no daemon
   * can have run it. `skill`: the user's `/name` activation (structured — the
   * daemon never parses `prompt`).
   */
  prompt(
    sessionId: string,
    turnId: string,
    prompt: string,
    onSent?: () => void,
    skill?: string,
  ): Promise<PromptResult> {
    return this.sessionCall(
      sessionId,
      Method.Prompt,
      { sessionId, turnId, content: [text(prompt)], ...(skill !== undefined ? { skill } : {}) },
      "keyed",
      onSent,
    ).then((result) => result as PromptResult);
  }

  /**
   * `session/send_now`: cancel `interrupt` and start turn `turnId` whose prompt
   * is `messages` (contract: `protocol/src/session.ts`). Resolves with the new
   * turn's ack, keyed by `turnId` like `prompt` (re-sent after a drop, run
   * once); rejects with the daemon's refusal (`MethodNotFound` from an older
   * daemon, `TurnInProgress`, `NoTurnRunning`). `onSent` as for `prompt`.
   */
  sendNow(
    sessionId: string,
    turnId: string,
    interrupt: SendNowTarget,
    messages: readonly SendNowMessage[],
    onSent?: () => void,
  ): Promise<PromptResult> {
    return this.sessionCall(
      sessionId,
      Method.SendNow,
      { sessionId, turnId, interrupt, messages },
      "keyed",
      onSent,
    ).then((result) => result as PromptResult);
  }

  /** Not re-sent after a drop (no idempotency key: a second compaction would summarise a summary). */
  compact(sessionId: string): Promise<{ before: number; after: number }> {
    return this.sessionCall(sessionId, Method.Compact, { sessionId }, "once").then(
      (result) => result as CompactResult,
    );
  }

  /**
   * Queue a user message for the running turn `turnId` (steering, mid-turn
   * only). `id` is the idempotency key: resending it is a no-op success.
   */
  enqueue(sessionId: string, id: string, turnId: string, text: string): Promise<void> {
    return this.sessionCall(
      sessionId,
      Method.Enqueue,
      { sessionId, id, turnId, text },
      "keyed",
    ).then(() => undefined);
  }

  /** A notification: lost while the link is down (the caller re-sends it after `recovered`). */
  cancel(sessionId: string): void {
    if (this.up) {
      this.peer.notify(Notification.Cancel, { sessionId });
    }
  }

  /** (Re)attach the consumer of a session's stream; `null` detaches it. */
  setListener(sessionId: string, listener: SessionStreamListener | null): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.listener = listener;
    }
  }

  /** Subscribe to background-job exits across all sessions; returns an unsubscribe. */
  onBackgroundExit(listener: (notice: BackgroundExitNotice) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Close the link for good: no reconnect, every wait rejects. */
  close(): void {
    this.disposed = true;
    if (this.dialTimer !== null) {
      this.clock.clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
    this.armLiveness(); // disposed: clears it
    if (this.dialDeadline !== null) {
      this.clock.clearTimeout(this.dialDeadline);
      this.dialDeadline = null;
    }
    // Stop first: the peer's close callback then finds the link already down.
    this.stop(new RpcError(JsonRpcErrorCode.InternalError, "connection closed"), "closed");
    this.peer.close();
  }

  /**
   * `hooks/trust`: never trusted without a resolver, for a session this
   * client did not open (or is closing), or while one is already asked for
   * that session — a daemon (maybe a pod) cannot spam prompts.
   */
  private async onHooksTrust(
    params: HooksTrustParams,
    signal?: AbortSignal,
  ): Promise<HooksTrustResult> {
    const entry = this.sessions.get(params.sessionId);
    if (!this.hooksTrust || !entry || entry.closing || this.trustAsking.has(params.sessionId)) {
      return { trusted: false };
    }
    this.trustAsking.add(params.sessionId);
    try {
      return await this.hooksTrust(params, signal);
    } finally {
      this.trustAsking.delete(params.sessionId);
    }
  }

  // --- generations -------------------------------------------------------

  private makePeer(raw: DuplexChannel, gen: number): RpcPeer {
    const current = (): boolean => gen === this.gen;
    // With a factory, every inbound frame is a sign of life (see `call`).
    const channel: DuplexChannel = this.channelFactory
      ? {
          send: (data) => raw.send(data),
          close: () => raw.close(),
          setOnClose: (handler) => raw.setOnClose(handler),
          setOnMessage: (handler) =>
            raw.setOnMessage((data) => {
              if (current()) this.lastInboundAt = this.clock.now();
              handler(data);
            }),
        }
      : raw;
    const peer: RpcPeer = new RpcPeer(channel, {
      onNotification: (method, params) => {
        if (current() && method === Notification.SessionUpdate) {
          this.onUpdate(params as SessionUpdateParams);
        }
      },
      onRequest: async (method, params, context) => {
        if (method === Method.ModelStream) {
          return this.onModelStream(params as ModelStreamParams);
        }
        if (method === Method.ModelStreamChunked) {
          return this.onModelStreamChunked(
            peer,
            params as ModelStreamChunkedParams,
            context as RequestContext,
          );
        }
        if (method === Method.HooksTrust) {
          return this.onHooksTrust(params as HooksTrustParams, context?.signal);
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unexpected request: ${method}`);
      },
      // A `session/update` whose ENVELOPE failed the schema (no `seq`, a
      // non-object update, …) never reaches the reducer: fail its session's
      // turn here, or a broken `turn_end` would hang it. `onError` already got
      // the error from the peer. An unreadable `sessionId` cannot be routed.
      onInvalidNotification: (method, params) => {
        if (!current() || method !== Notification.SessionUpdate) return;
        const sessionId =
          params && typeof params === "object" ? (params as { sessionId?: unknown }).sessionId : "";
        if (typeof sessionId === "string") {
          this.sessions.get(sessionId)?.listener?.output({
            kind: "error",
            error: new Error("malformed session/update frame from the daemon"),
          });
        }
      },
      onClose: () => this.onLinkClosed(gen),
      // Log non-fatal peer errors (a stray/malformed notification, a bad frame)
      // instead of dropping them silently. Routed to the caller's sink, NEVER a
      // raw terminal write (§7): the laptop's stdout is the RPC channel/Ink's.
      ...(this.onError
        ? {
            onError: (error: Error) => {
              if (current()) this.onError?.(error);
            },
          }
        : {}),
    });
    return peer;
  }

  private handshake(peer: RpcPeer): Promise<InitializeResult> {
    return this.call(peer, Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      // Every update type this build understands: the daemon emits a
      // BLOCKING type only to a client that lists it (protocol 10).
      clientCapabilities: { streaming: true, updates: [...KNOWN_UPDATE_TYPES] },
    }).then((raw) => {
      const result = raw as InitializeResult;
      // Only the current link's answer: a superseded handshake must not
      // overwrite the catalog of the daemon we are now talking to. Defensive:
      // a peer is replaced only after it closed, and closing rejects its
      // pending requests (transport/peer.ts), so this should never trigger.
      if (peer === this.peer) {
        this.skillCatalog = result.skills;
      }
      return result;
    });
  }

  /**
   * Every request this client sends. With a factory it is WATCHED (except
   * `compact`, which runs a model call before it answers): a link with a
   * watched request outstanding and no inbound frame for `LIVENESS_MS` is
   * presumed dead (a half-open socket) and closed, so the normal drop path
   * reconnects and re-sends keyed commands. Without a factory: unchanged.
   */
  private call(peer: RpcPeer, method: string, params: unknown): Promise<unknown> {
    const sent = peer.request(method, params);
    if (!this.channelFactory || method === Method.Compact) {
      return sent;
    }
    const token = {};
    this.watched.set(token, this.clock.now());
    this.armLiveness();
    const settled = (): void => {
      this.watched.delete(token);
      this.armLiveness();
    };
    sent.then(settled, settled);
    return sent;
  }

  /** Re-evaluate liveness and (re)arm its single timer. */
  private armLiveness(): void {
    if (this.livenessTimer !== null) {
      this.clock.clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.disposed || this.stopError) {
      return;
    }
    let watchedSince: number | null = null;
    for (const at of this.watched.values()) {
      watchedSince = watchedSince === null ? at : Math.min(watchedSince, at);
    }
    const verdict = liveness({
      now: this.clock.now(),
      lastInboundAt: this.lastInboundAt,
      watchedSince,
    });
    if (verdict.kind === "alive") {
      this.livenessTimer = this.clock.setTimeout(() => {
        this.livenessTimer = null;
        this.armLiveness();
      }, verdict.checkInMs);
    } else if (verdict.kind === "dead") {
      this.onError?.(
        new Error(`no frame from the daemon for ${LIVENESS_MS / 1000}s: the link is presumed dead`),
      );
      // Its pending requests reject (→ settled); its close runs the drop path
      // (or, mid-handshake, the dial's own retry).
      this.peer.close();
    }
  }

  /**
   * The factory, bounded by `LIVENESS_MS`: a dial that never settles (a
   * black-holed SYN) counts as a failed one; its channel, if it ever arrives,
   * is closed (no orphan generation).
   */
  private dialChannel(factory: () => Promise<DuplexChannel>): Promise<DuplexChannel> {
    return new Promise((resolve, reject) => {
      let late = false;
      const timer = this.clock.setTimeout(() => {
        late = true;
        this.dialDeadline = null;
        reject(new ChannelError("unreachable", `no connection after ${LIVENESS_MS / 1000}s`));
      }, LIVENESS_MS);
      this.dialDeadline = timer;
      const settled = (): void => {
        this.clock.clearTimeout(timer);
        if (this.dialDeadline === timer) this.dialDeadline = null;
      };
      factory().then(
        (channel) => {
          // Too late, or `close()` cleared the deadline meanwhile: `dial`
          // closes a channel that arrives after `close()`.
          if (late) {
            channel.close();
            return;
          }
          settled();
          resolve(channel);
        },
        (error: unknown) => {
          if (late) return;
          settled();
          reject(error);
        },
      );
    });
  }

  /** The current generation's channel closed. */
  private onLinkClosed(gen: number): void {
    if (gen !== this.gen || !this.up) {
      return;
    }
    this.up = false;
    if (!this.channelFactory || this.disposed) {
      // No reconnect: the turn's outcome would never arrive, so end every open
      // turn explicitly (same error a pending request gets).
      this.stop(new RpcError(JsonRpcErrorCode.InternalError, "connection closed"), "disconnected");
      return;
    }
    for (const entry of this.sessions.values()) {
      entry.owesNotice = true;
      this.step(entry, { kind: "link_down" });
    }
    this.schedule(linkDropped(this.link, this.clock.now(), this.random));
  }

  /** The link is gone for good. */
  private stop(error: Error, reason: string): void {
    if (this.stopError) {
      return;
    }
    this.stopError = error;
    this.up = false;
    this.link = stopped(this.link, reason).state;
    this.emitStatus({ state: "stopped", reason });
    this.runPermissionActions(this.router.connectionClosed());
    for (const entry of [...this.sessions.values()]) {
      entry.listener?.linkClosed(error);
    }
    this.kick();
  }

  private schedule(step: LinkStep): void {
    this.link = step.state;
    if (step.status.state === "stopped") {
      this.stop(
        new RpcError(JsonRpcErrorCode.InternalError, step.status.reason),
        step.status.reason,
      );
      return;
    }
    this.emitStatus(step.status);
    if (step.dialInMs !== undefined) {
      this.dialTimer = this.clock.setTimeout(() => {
        this.dialTimer = null;
        void this.dial();
      }, step.dialInMs);
    }
  }

  /** Open a new generation: channel, peer, handshake, then re-open every session. */
  private async dial(): Promise<void> {
    if (this.disposed || this.stopError || !this.channelFactory) {
      return;
    }
    this.link = { ...this.link, kind: "dialing" };
    let channel: DuplexChannel;
    try {
      channel = await this.dialChannel(this.channelFactory);
    } catch (error) {
      this.redial(error);
      return;
    }
    if (this.disposed) {
      channel.close();
      return;
    }
    const gen = ++this.gen;
    this.lastInboundAt = this.clock.now();
    const peer = this.makePeer(channel, gen);
    this.peer = peer;
    try {
      await this.handshake(peer);
    } catch (error) {
      if (gen !== this.gen) return;
      peer.close(); // its onClose finds `up` false: no double schedule
      this.redial(error);
      return;
    }
    if (gen !== this.gen || this.disposed) {
      return;
    }
    this.up = true;
    const step = linkUp(this.link, this.clock.now());
    this.link = step.state;
    this.emitStatus(step.status);
    for (const entry of [...this.sessions.values()]) {
      void this.recover(entry, gen);
    }
    this.kick();
  }

  private redial(error: unknown): void {
    if (this.disposed || this.stopError) return;
    this.schedule(dialFailed(this.link, error, this.clock.now(), this.random));
  }

  private emitStatus(status: LinkStatus): void {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  // --- sessions ------------------------------------------------------------

  private register(
    id: string,
    seed: readonly ChatMessage[],
    listener: SessionStreamListener | undefined,
  ): SessionEntry {
    const existing = this.sessions.get(id);
    if (existing && !existing.closing) {
      if (listener) existing.listener = listener;
      return existing;
    }
    const entry: SessionEntry = {
      id,
      state: initialStream,
      listener: listener ?? null,
      history: seed,
      everLive: false,
      recreates: 0,
      noticedRecreates: 0,
      liveGen: -1,
      owesNotice: false,
      closing: false,
      turnEndsApplied: 0,
      turnEndsInHistory: 0,
    };
    this.sessions.set(id, entry);
    return entry;
  }

  /** Re-attach one session on a new generation. */
  private async recover(entry: SessionEntry, gen: number): Promise<void> {
    if (entry.closing) {
      this.sessions.delete(entry.id);
      return;
    }
    const since = sinceOf(entry.state);
    try {
      await this.openOn(
        entry,
        gen,
        entry.everLive
          ? { sessionId: entry.id, ...(since ? { since } : {}) }
          : // Never live: its first open may not have reached the daemon.
            {
              sessionId: entry.id,
              create: true,
              ...(entry.history.length > 0 ? { messages: entry.history } : {}),
            },
      );
    } catch (error) {
      this.failSession(entry, gen, error);
    }
  }

  /** Send `open` for `entry` on `gen`, with its updates buffered from before the frame leaves. */
  private async openOn(
    entry: SessionEntry,
    gen: number,
    params: {
      sessionId: string;
      since?: HistoryCut;
      create?: boolean;
      messages?: readonly ChatMessage[];
      cwd?: string;
    },
  ): Promise<void> {
    this.step(entry, { kind: "open_sent" });
    const peer = this.peer;
    let result: OpenResult;
    try {
      result = (await this.call(peer, Method.Open, params)) as OpenResult;
    } catch (error) {
      if (gen !== this.gen || !this.up) {
        return; // a drop: the next generation opens it again
      }
      const unknown = error instanceof RpcError && error.code === DomainErrorCode.UnknownSession;
      if (unknown && params.create !== true) {
        await this.recreate(entry, gen);
        return;
      }
      throw error;
    }
    this.applyOpenResult(entry, gen, result);
  }

  private applyOpenResult(entry: SessionEntry, gen: number, result: OpenResult): void {
    if (gen !== this.gen || this.sessions.get(entry.id) !== entry) {
      return;
    }
    this.step(entry, {
      kind: "open_result",
      created: result.created,
      resync: result.resync,
      epoch: result.epoch,
      now: this.clock.now(),
    });
  }

  /**
   * The daemon lost the session (a new stdio daemon, a close or reap while we
   * were away): recreate it from the newest history this client read. The turn
   * in flight is reported lost, never re-run (the dead daemon may have run its
   * tools). A second device racing the recreate attaches instead.
   */
  private async recreate(entry: SessionEntry, gen: number): Promise<void> {
    if (entry.closing) {
      return; // closed meanwhile: recreating it would leave an orphan daemon-side
    }
    const messages = entry.history;
    const lostTurns = entry.turnEndsApplied - entry.turnEndsInHistory;
    const result = (await this.call(this.peer, Method.Open, {
      sessionId: entry.id,
      ...(messages.length > 0 ? { messages } : { create: true }),
    })) as OpenResult;
    if (gen !== this.gen || this.sessions.get(entry.id) !== entry) {
      return;
    }
    entry.recreates += 1;
    entry.turnEndsInHistory = entry.turnEndsApplied;
    if (result.created) {
      // Seeded from OUR history: what it lagged is gone (a racing device that
      // recreated it first seeded its own — not ours to report).
      if (lostTurns > 0) {
        for (const listener of this.historyLostListeners) {
          listener({ sessionId: entry.id, turns: lostTurns });
        }
      }
      this.step(entry, { kind: "recreated", epoch: result.epoch, messages, now: this.clock.now() });
      return;
    }
    this.deliver(entry, [{ kind: "turn_lost" }]);
    this.applyOpenResult(entry, gen, result);
  }

  /** Page a snapshot and fold it in (a resync, or the barrier after a compaction). */
  private async resync(entry: SessionEntry, gen: number): Promise<void> {
    let snap: { messages: readonly ChatMessage[]; since?: HistoryCut; turn?: string };
    const mark = entry.turnEndsApplied;
    try {
      snap = await this.readSnapshot(entry.id, this.peer);
    } catch (error) {
      this.failSession(entry, gen, error);
      return;
    }
    if (gen !== this.gen || this.sessions.get(entry.id) !== entry) {
      return;
    }
    if (!snap.since) {
      this.failSession(entry, gen, new Error("the daemon's snapshot carries no cut"));
      return;
    }
    this.historyRead(entry, snap.messages, mark);
    this.step(entry, {
      kind: "snapshot",
      messages: snap.messages,
      since: snap.since,
      turn: snap.turn ?? null,
      now: this.clock.now(),
    });
  }

  /** `messages` is the daemon's history as of a read issued when `mark` turn ends were applied. */
  private historyRead(entry: SessionEntry, messages: readonly ChatMessage[], mark: number): void {
    entry.history = messages;
    entry.turnEndsInHistory = Math.max(entry.turnEndsInHistory, mark);
  }

  private failSession(entry: SessionEntry, gen: number, error: unknown): void {
    if (gen !== this.gen || !this.up || this.sessions.get(entry.id) !== entry) {
      return; // a drop: the next generation retries
    }
    const reason = error instanceof Error ? error.message : String(error);
    this.onError?.(new Error(`session ${entry.id}: recovery failed: ${reason}`));
    this.step(entry, { kind: "fail", reason: `could not resume the session: ${reason}` });
  }

  private onUpdate(params: SessionUpdateParams): void {
    const entry = this.sessions.get(params.sessionId);
    if (entry) {
      this.step(entry, { kind: "update", params, now: this.clock.now() });
    }
  }

  /** Feed the reducer, deliver its outputs, run its effects. */
  private step(entry: SessionEntry, input: StreamInput): void {
    const result = reduceStream(entry.state, input);
    entry.state = result.state;
    const live = result.state.phase === "live";
    entry.liveGen = live ? this.gen : -1;
    if (live) {
      entry.everLive = true;
    }
    this.deliver(entry, result.out);
    for (const effect of result.effects) {
      this.runEffect(entry, effect);
    }
    if (live && entry.owesNotice && entry.state.phase === "live") {
      entry.owesNotice = false;
      const recreated = entry.recreates !== entry.noticedRecreates;
      entry.noticedRecreates = entry.recreates;
      entry.listener?.recovered({ recreated });
    }
    this.kick();
  }

  private runEffect(entry: SessionEntry, effect: StreamEffect): void {
    const gen = this.gen;
    if (effect.kind === "fetch_snapshot") {
      void this.resync(entry, gen);
      return;
    }
    // A gap: resync on this same link (the reducer guards the rate).
    entry.owesNotice = true;
    void this.openOn(entry, gen, { sessionId: entry.id }).catch((error: unknown) =>
      this.failSession(entry, gen, error),
    );
  }

  /**
   * Route outputs: permission and job events to their owners first; then every
   * output to the session's listener, so it sees the complete ordered stream.
   */
  private deliver(entry: SessionEntry, outs: readonly StreamOutput[]): void {
    for (const out of outs) {
      if (out.kind === "reset") {
        entry.history = out.messages;
        this.runPermissionActions(this.router.retainOnly(entry.id, out.keepRequests));
        entry.listener?.output(out);
        continue;
      }
      if (out.kind === "error") {
        this.onError?.(out.error);
        entry.listener?.output(out);
        continue;
      }
      if (out.kind !== "update") {
        entry.listener?.output(out);
        continue;
      }
      const update = out.update;
      if (update.type === "turn_end") {
        entry.turnEndsApplied += 1;
      }
      // Permission events are session state, not turn-scoped (a re-attach
      // replays a pending one): the router decides, never the turn handler.
      if (update.type === "permission_request") {
        this.runPermissionActions(this.router.request(entry.id, update));
      } else if (update.type === "permission_resolved") {
        this.runPermissionActions(this.router.resolved(entry.id, update.requestId));
      } else if (update.type === "background_exit") {
        // Not turn-scoped: the dedicated listeners fire even when no turn is
        // streaming (`RemoteSession` leaves it to them).
        const { jobId, command, status, exitCode } = update;
        for (const listener of this.exitListeners) {
          listener({ jobId, command, status, exitCode });
        }
      }
      // Closed daemon-side (by any client): nothing left to close at exit,
      // nothing left to answer.
      if (update.type === "session_closed") {
        if (this.sessions.get(entry.id) === entry) {
          this.sessions.delete(entry.id);
        }
        this.runPermissionActions(this.router.sessionClosed(entry.id));
      }
      entry.listener?.output(out);
    }
  }

  /** Re-check every waiter; drop the settled ones. */
  private kick(): void {
    for (const check of [...this.waiters]) {
      if (check()) {
        this.waiters.delete(check);
      }
    }
  }

  /** Resolve with the generation once `entry` is live on the current link; reject when it never will be. */
  private whenLive(entry: SessionEntry): Promise<number> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (this.stopError) {
          reject(this.stopError);
          return true;
        }
        if (
          this.sessions.get(entry.id) !== entry ||
          entry.closing ||
          entry.state.phase === "closed"
        ) {
          reject(new RpcError(DomainErrorCode.UnknownSession, "the session was closed"));
          return true;
        }
        if (entry.state.phase === "failed") {
          reject(new Error(`session ${entry.id} could not be resumed`));
          return true;
        }
        if (this.up && entry.state.phase === "live" && entry.liveGen === this.gen) {
          resolve(this.gen);
          return true;
        }
        return false;
      };
      if (!check()) {
        this.waiters.add(check);
      }
    });
  }

  /**
   * A session command. Without a factory: straight to the peer (a drop
   * rejects, as before). With one: wait until the session is live on the
   * current link; on a drop, `keyed` commands are re-sent (the daemon dedupes
   * by key) unless the session was recreated since they were first SENT (the
   * dead daemon may have acted on them), `once` commands reject. A command
   * never written to a channel before a recreate goes to the new session: no
   * daemon has seen it.
   */
  private async sessionCall(
    sessionId: string,
    method: string,
    params: unknown,
    policy: "keyed" | "once",
    onSent?: () => void,
  ): Promise<unknown> {
    const entry = this.sessions.get(sessionId);
    if (entry?.state.phase === "failed") {
      // Its stream is no longer applied: a turn sent now would never end.
      throw new Error(`session ${entry.id} could not be resumed`);
    }
    if (!this.channelFactory || !entry) {
      onSent?.();
      return this.call(this.peer, method, params);
    }
    /** `entry.recreates` when the command was first written (null: not yet). */
    let sentIn: number | null = null;
    for (;;) {
      const gen = await this.whenLive(entry);
      if (sentIn !== null && entry.recreates !== sentIn) {
        throw new SessionLostError();
      }
      if (sentIn === null) {
        sentIn = entry.recreates;
        onSent?.();
      }
      try {
        return await this.call(this.peer, method, params);
      } catch (error) {
        if (gen === this.gen && this.up) {
          throw error; // the daemon's own answer
        }
        if (policy === "once") {
          throw new RpcError(
            JsonRpcErrorCode.InternalError,
            "the connection dropped before the daemon answered; not retried",
          );
        }
      }
    }
  }

  private async readSnapshot(
    sessionId: string,
    peer: RpcPeer,
  ): Promise<{ messages: readonly ChatMessage[]; since?: HistoryCut; turn?: string }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.readSnapshotPages(sessionId, peer);
      } catch (error) {
        const stale = error instanceof RpcError && error.code === DomainErrorCode.StaleCursor;
        if (!stale || attempt >= SNAPSHOT_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  private async readSnapshotPages(
    sessionId: string,
    peer: RpcPeer,
  ): Promise<{ messages: readonly ChatMessage[]; since?: HistoryCut; turn?: string }> {
    const pages: (readonly ChatMessage[])[] = [];
    let first: SnapshotResult | undefined;
    let cursor: string | undefined;
    do {
      if (pages.length >= SNAPSHOT_MAX_PAGES) {
        throw new RpcError(JsonRpcErrorCode.InternalError, "snapshot: too many pages");
      }
      const previous = cursor;
      const result = (await this.call(peer, Method.Snapshot, {
        sessionId,
        limit: SNAPSHOT_PAGE,
        ...(cursor !== undefined ? { cursor } : {}),
      })) as SnapshotResult;
      first ??= result;
      cursor = result.cursor;
      // Every page that points further back must make progress.
      if (cursor !== undefined && (result.messages.length === 0 || cursor === previous)) {
        throw new RpcError(JsonRpcErrorCode.InternalError, "snapshot: cursor made no progress");
      }
      pages.push(result.messages as readonly ChatMessage[]);
    } while (cursor !== undefined);
    return {
      messages: pages.reverse().flat(),
      ...(first?.since ? { since: first.since } : {}),
      ...(first?.turn ? { turn: first.turn.turnId } : {}),
    };
  }

  /**
   * Serve a `model/stream` request from the daemon (the pod reverse-tunnel),
   * batch cut: run the LOCAL model and return the whole turn's events in one
   * response. Kept so an old daemon (which only knows `model/stream`) works
   * against a new laptop.
   */
  private async onModelStream(params: ModelStreamParams): Promise<ModelStreamResult> {
    if (!this.modelProvider) {
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, "no local model to serve model/stream");
    }
    const events: WireStreamEvent[] = [];
    for await (const event of this.modelProvider.stream(params.request as unknown as ChatRequest)) {
      events.push(event as WireStreamEvent);
    }
    return { events };
  }

  /**
   * Serve a `model/streamChunked` request (the streaming cut): run the LOCAL
   * model and forward its events to the daemon as `$/progress` notifications
   * tied to the request id, coalesced into batches, then reply with only a
   * frame count. The events cross as `$/progress` (NOT re-sent in the result), so
   * the daemon can yield them as they are produced.
   *
   * Ordering is the load-bearing guarantee: every `$/progress` for this request
   * is sent **before** the result frame (the coalescer flushes synchronously on
   * end/error), and the channel is ordered, so the daemon's peer routes all
   * chunks before it resolves the result. The count check then proves
   * completeness.
   */
  private async onModelStreamChunked(
    peer: RpcPeer,
    params: ModelStreamChunkedParams,
    context: RequestContext,
  ): Promise<ModelStreamChunkedResult> {
    if (!this.modelProvider) {
      throw new RpcError(
        JsonRpcErrorCode.MethodNotFound,
        "no local model to serve model/streamChunked",
      );
    }
    const signal = context.signal;
    const id = String(context.id);
    // Coalesce into batches (see MODEL_STREAM_COALESCE_MS): one frame per
    // window at most, a quiet stream's next event at once, a size cap per
    // batch. `seq` counts FRAMES. The final flush is synchronous, before the
    // result/error frame, so no event is ever delayed past it.
    let batch: WireStreamEvent[] = [];
    let batchChars = 2; // "[]"
    let seq = 0;
    let window: ReturnType<typeof setTimeout> | undefined;
    const sendBatch = (): void => {
      if (batch.length === 0) {
        return;
      }
      peer.notify(Notification.Progress, { id, seq, value: batch });
      seq += 1;
      batch = [];
      batchChars = 2;
    };
    const onWindowEnd = (): void => {
      window = undefined;
      if (batch.length > 0) {
        sendBatch();
        window = setTimeout(onWindowEnd, MODEL_STREAM_COALESCE_MS);
      }
    };
    const push = (event: WireStreamEvent): void => {
      const size = JSON.stringify(event).length + 1; // + the separating comma
      if (batch.length > 0 && batchChars + size > MODEL_STREAM_BATCH_MAX_CHARS) {
        sendBatch(); // close the batch before it would exceed the cap
      }
      batch.push(event);
      batchChars += size;
      if (window === undefined) {
        // Leading edge: the stream was quiet, so send now and open a window.
        sendBatch();
        window = setTimeout(onWindowEnd, MODEL_STREAM_COALESCE_MS);
      } else if (batchChars >= MODEL_STREAM_BATCH_MAX_CHARS) {
        sendBatch(); // an oversize event travels alone, without waiting
      }
    };
    const flush = (): void => {
      if (window) {
        clearTimeout(window);
        window = undefined;
      }
      sendBatch();
    };
    try {
      for await (const event of this.modelProvider.stream({
        ...(params.request as unknown as ChatRequest),
        ...(signal ? { signal } : {}),
      })) {
        const wire = event as WireStreamEvent;
        push(wire);
      }
    } catch (error) {
      // Flush whatever was produced before the failure so the daemon sees the
      // partial stream, then surface the error (the daemon drains, then throws).
      flush();
      if (
        signal.aborted ||
        (error && typeof error === "object" && (error as { name?: string }).name === "cancelled")
      ) {
        throw new RpcError(JsonRpcErrorCode.InternalError, "model stream cancelled");
      }
      // Rethrow as-is (NOT an RpcError): the peer reports it to `onError` on
      // the laptop and answers the pod with an opaque "internal error", like
      // `model/stream`. A provider message can carry the endpoint or key
      // material, and the pod is not trusted (AGENTS §7).
      throw error;
    }
    // Flush the tail synchronously so the last events precede the result frame.
    flush();
    return { chunks: seq };
  }

  /**
   * Execute the router's decisions: a prompt goes to the broker with an abort
   * handle (its answer comes back to the router), an abort withdraws it, a
   * send answers the daemon. A losing answer (`PermissionNotPending`) is
   * expected and silent — the winner arrives as `permission_resolved`.
   */
  private runPermissionActions(actions: readonly RouterAction[]): void {
    for (const action of actions) {
      const { sessionId, requestId } = action;
      const key = `${sessionId}\u0000${requestId}`;
      if (action.kind === "prompt") {
        const controller = new AbortController();
        this.prompts.set(key, controller);
        const answered = (response: Parameters<PermissionRouter["answered"]>[2]): void => {
          if (this.prompts.get(key) === controller) {
            this.prompts.delete(key);
          }
          this.runPermissionActions(this.router.answered(sessionId, requestId, response));
        };
        this.permissions
          .request(action.request, { signal: controller.signal })
          .then(answered, (error: unknown) => {
            this.onError?.(error instanceof Error ? error : new Error(String(error)));
            answered(DISMISSED);
          });
      } else if (action.kind === "unoffered") {
        this.onError?.(
          new Error(
            `permission answer "${action.optionId}" was not offered by the daemon for request ${requestId}: not sent`,
          ),
        );
      } else if (action.kind === "abort") {
        this.prompts.get(key)?.abort();
        this.prompts.delete(key);
      } else {
        // Keyed by `requestId`: an answer given while the link is down waits for
        // the session to be live again. A request answered elsewhere, or gone
        // with a recreated session, is not an error.
        this.sessionCall(
          sessionId,
          Method.ResolvePermission,
          { sessionId, requestId, optionId: action.optionId },
          "keyed",
        )
          .then(() => undefined)
          .catch((error: unknown) => {
            if (
              (error instanceof RpcError && error.code === DomainErrorCode.PermissionNotPending) ||
              error instanceof SessionLostError
            ) {
              return;
            }
            // Not delivered: a later replay must offer the request again.
            this.router.answerFailed(sessionId, requestId);
            this.onError?.(error instanceof Error ? error : new Error(String(error)));
          });
      }
    }
  }
}
