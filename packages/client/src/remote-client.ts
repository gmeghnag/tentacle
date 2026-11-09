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
  type AnswerLostCause,
  type ChatMessage,
  type ChatRequest,
  DISMISSED,
  type ModelProvider,
  type PermissionBroker,
  countTokensBounded,
} from "@tentacle/core";
import {
  type ClientInfo,
  type CompactResult,
  DomainErrorCode,
  type HistoryCut,
  type HooksTrustParams,
  type HooksTrustResult,
  type InitializeResult,
  JsonRpcErrorCode,
  KNOWN_UPDATE_TYPES,
  type KnownLogEntry,
  type LogCursor,
  type LogResult,
  type McpServerStatus,
  type McpStatusResult,
  Method,
  type ModelCountTokensParams,
  type ModelCountTokensResult,
  type ModelPurpose,
  type ModelStreamChunkedParams,
  type ModelStreamChunkedResult,
  type ModelStreamParams,
  type ModelStreamResult,
  Notification,
  type OpenResult,
  PROTOCOL_VERSION,
  type PromptResult,
  type QueueState,
  type RenameResult,
  type SeedTitle,
  type SendNowMessage,
  type SendNowTarget,
  type SessionContextResult,
  type SessionListParams,
  type SessionListResult,
  type SessionSettings,
  type SessionSettingsReport,
  type SessionSkillsResult,
  type SessionTitle,
  type SessionTtlResult,
  type SessionUpdateParams,
  type Sha256,
  type SnapshotResult,
  type UpdateSettingsResult,
  type WireStreamEvent,
  text,
} from "@tentacle/protocol";
import { type DuplexChannel, type RequestContext, RpcError, RpcPeer } from "@tentacle/transport";
import { ATTACH_TIMEOUT_MS } from "./constants.ts";
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
import { answerLostCause, normalizePermissionReply } from "./permission-map.ts";
import { PermissionRouter, type RouterAction } from "./permission-router.ts";
import { RemoteSession } from "./remote-session.ts";
import { type LogOutcome, type LogState, applyLogRead } from "./session-log-reader.ts";
import { SessionLostError } from "./session-lost.ts";
import {
  type StreamEffect,
  type StreamInput,
  type StreamOutput,
  type StreamState,
  initialStream,
  reduceStream,
  sinceOf,
} from "./session-reducer.ts";
import { type DaemonKind, explainVersionMismatch } from "./version-mismatch.ts";

/** A `once` session command whose link dropped before the daemon answered (its outcome is unknown). */
export const DROPPED_NOT_RETRIED = "the connection dropped before the daemon answered; not retried";

/** A daemon's refusal of a `session/update_settings`: it emitted no update. */
const REFUSALS: ReadonlySet<number> = new Set([
  DomainErrorCode.TurnInProgress,
  DomainErrorCode.CompactInProgress,
  DomainErrorCode.UnknownSession,
  JsonRpcErrorCode.MethodNotFound,
  JsonRpcErrorCode.InvalidParams,
]);

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
  /**
   * The daemon refused to re-attach after a drop because the session ended
   * (`SessionArchived` → `closed`) or was deleted (`SessionDeleted` →
   * `deleted`) while the link was down — told by error CODE, before its turns fail.
   */
  ended?(reason: "closed" | "deleted" | "gone"): void;
  /**
   * Other clients share this session (`closeIfLast`): when the daemon no longer
   * has it after a drop, it was closed for everyone while this one was away —
   * it is told so, never recreated from its own copy (docs/fix/detach-live.md R7).
   */
  readonly shared?: boolean;
}

/** Exits kept for a first `onBackgroundExit` subscriber (the count in the open result still says more are owed). */
const EXIT_BACKLOG_MAX = 64;

/** A background-job exit surfaced by the daemon, outside any turn. */
export interface BackgroundExitNotice {
  readonly jobId: string;
  readonly command: string;
  readonly status: string;
  readonly exitCode: number | null;
  /** Set when a sub-agent exited (`jobId` is its `sa-N`); absent for a shell job. */
  readonly agent?: { readonly stopReason: string; readonly toolUses: number };
}

/**
 * The daemon's chosen title of a session changed (generated, or renamed by
 * any client) — or a resync showed one this client had missed. Not
 * turn-scoped: it arrives while idle too. The daemon's fact, never derived.
 */
export interface SessionTitleNotice {
  readonly sessionId: string;
  readonly title: string;
  readonly source: "model" | "user";
}

/**
 * The session's queue as the daemon reports it (a `queued` update, or the
 * snapshot of a resync): the full state, every writer's rows. Not
 * turn-scoped. The daemon's fact, never derived (docs/feat/queued-broadcast.md).
 */
export interface SessionQueueNotice {
  readonly sessionId: string;
  readonly state: QueueState;
}

/**
 * A session's history read back through `session/log` (docs/feat/session-log.md),
 * with the daemon's title (absent: none logged in this read nor before).
 */
export interface ReadBack {
  readonly messages: readonly ChatMessage[];
  readonly title?: SessionTitle;
  /** The validated, re-serialized known entries of this read (F4): what the disk log appends (task 2). */
  readonly entries: readonly KnownLogEntry[];
  /**
   * The daemon's lineage diverged from this client's (F1: a restarted daemon
   * reseeded from another copy): the copy this client held, to be SET ASIDE —
   * `messages` is the daemon's.
   */
  readonly aside?: readonly ChatMessage[];
  /** Entries between this client's head and the daemon's last `base` were not available. */
  readonly gap?: true;
  /**
   * Where this read stood (docs/feat/session-log-laptop-store.md): `from` = the
   * head the read continued (absent: a cold read, or a refused one retried
   * cold), `head` = this client's head after it, `outcome` its classification.
   * The disk writer appends only when a read continues exactly what it wrote.
   */
  readonly read: {
    readonly from?: LogCursor;
    readonly head: LogCursor;
    readonly outcome: LogOutcome;
  };
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

/**
 * The named models a laptop serves to a pod (docs/feat/models-map-pod.md).
 * Built from the laptop's OWN config: this is the allowlist (AGENTS §7).
 */
export interface NamedModels {
  /** A provider; `"unavailable"`: published, but no key here; `undefined`: not published. */
  resolve(name: string): ModelProvider | "unavailable" | undefined;
}

/** Refused names reported to the laptop's log, so a hostile pod cannot flood it. */
const MAX_REFUSED_NAMES_LOGGED = 16;

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
  /** Who this client is, sent in `initialize` (a daemon words a version skew with it). */
  readonly clientInfo?: ClientInfo;
  /** Where the daemon runs (default `serve`): picks the advice for a daemon too old to give its own. */
  readonly daemonKind?: DaemonKind;
  /**
   * Serves the daemon's TITLE calls on the model tunnel (`purpose: "title"`):
   * `model.titleModel`, else the main model. Absent → this laptop's
   * `model.autoTitle` is off and a title call is refused — the gate is here,
   * on the laptop; the pod never names a model (docs/feat/session-titles.md).
   */
  readonly titleModelProvider?: ModelProvider;
  /** The named models this laptop serves to a pod; absent → every name is refused. */
  readonly namedModels?: NamedModels;
  /**
   * The laptop's settings for a pod (docs/feat/config-carry.md), sent wherever a
   * session may be created or described as new; never on an attach. Absent →
   * never sent: `connect` and the worker do not carry anything.
   */
  readonly sessionSettings?: SessionSettings;
  /**
   * SHA-256 (hex) for the `session/log` checkpoints `readBack` verifies.
   * Absent → `Bun.CryptoHasher` when running on Bun; elsewhere (mobile, which
   * never reads back) `readBack` refuses. Injected: this package stays node-free.
   */
  readonly sha256?: Sha256;
}

/** A sha-256 hex hasher from Bun's runtime, when there is one. */
function bunSha256(): Sha256 | undefined {
  const bun = (
    globalThis as {
      Bun?: {
        CryptoHasher: new (
          algorithm: string,
        ) => { update(text: string): unknown; digest(encoding: "hex"): string };
      };
    }
  ).Bun;
  if (bun === undefined) {
    return undefined;
  }
  return (text) => {
    const hasher = new bun.CryptoHasher("sha256");
    hasher.update(text);
    return hasher.digest("hex");
  };
}

/** Restarts of one `readBack` (a rebase between pages, a refused read retried cold, a drifted checkpoint re-read cold). */
const LOG_ATTEMPTS = 3;
/** Pages one `readBack` may read: a daemon (a pod is not trusted) that never ends fails loudly. */
const LOG_MAX_PAGES = 10_000;

/** What a session did with the settings it was created from (`onSessionSettings`). */
export interface SessionSettingsNotice {
  readonly sessionId: string;
  /** From the daemon, which may be a pod (not trusted): a frontend filters and never prints it raw. */
  readonly report: SessionSettingsReport;
}

/**
 * Another client applied its settings to a session this client has open
 * (`session_settings`, docs/feat/session-settings-apply.md). `previous`: the
 * report this client knew before (absent: none yet). From the daemon, which
 * may be a pod (not trusted): a frontend filters and never prints it raw.
 */
export interface SessionSettingsChange {
  readonly sessionId: string;
  readonly previous?: SessionSettingsReport;
  readonly report: SessionSettingsReport;
}

/** The daemon answered no attach in `ATTACH_TIMEOUT_MS` (docs/feat/session-settings-apply.md S3). */
export class AttachTimeoutError extends Error {
  constructor(ms: number) {
    super(`no answer from the daemon within ${Math.round(ms / 1000)}s (session/open)`);
    this.name = "AttachTimeoutError";
  }
}

/** A snapshot read in full: the history, the cut and turn of its first page, the title. */
interface Snap {
  readonly messages: readonly ChatMessage[];
  readonly since?: HistoryCut;
  readonly turn?: string;
  readonly title?: SessionTitle;
  /** The queue at the cut (absent: an older daemon does not report it). */
  readonly queued?: QueueState;
}

/** The error of a session the reducer gave up on, WITH its cause (docs/fix/detach-live.md KO 3). */
function notResumed(entry: SessionEntry): string {
  const why = entry.failReason !== undefined ? `: ${entry.failReason}` : "";
  return `session ${entry.id} could not be resumed${why}`;
}

/** One session this client opened (or is opening) and has not closed. */
interface SessionEntry {
  readonly id: string;
  state: StreamState;
  listener: SessionStreamListener | null;
  /** The newest history this client read: what a recreate seeds the daemon with. */
  history: readonly ChatMessage[];
  /** The `session/log` this client holds (its last committed `readBack`); null before the first. */
  log: LogState | null;
  /** The newest title a `session/log` read carried (a title entry comes only when it changes). */
  logTitle: SessionTitle | undefined;
  /** A checkpoint drift was reported for this session (once; never a loop). */
  driftReported: boolean;
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
  /** Its `session_closed` arrived: the daemon ended it (for any client). */
  closedSeen: boolean;
  /** Why the reducer gave up on it (`failed`): carried by the "could not be resumed" error. */
  failReason?: string;
  /** `turn_end`s applied from the stream. */
  turnEndsApplied: number;
  /** `turn_end`s already applied when `history` was read: fewer than applied ⇒ `history` lags. */
  turnEndsInHistory: number;
  /**
   * The newest CHOSEN title this client knows (its seed, a `session_title`, a
   * read-back): what a recreate seeds the daemon with, so a lost session is
   * never regenerated over a rename.
   */
  title: SeedTitle | undefined;
  /** The daemon's last reported queue; undefined until it reports one (an older daemon never does). */
  queued: QueueState | undefined;
  /** The session's newest settings report (an open's, an own sync's, a `session_settings`). */
  settings: SessionSettingsReport | undefined;
  /** The exits no turn had flushed when the newest open answered (an older daemon: 0). */
  unflushedExits: number;
  /** How far the attach got: 1 once an open answered, 1 + n once a read reached page n. */
  attachMark: number;
  /** When `attachMark` last rose: the attach bound counts from it. */
  attachProgressAt: number;
  /**
   * Opened by `attachSession`: an existing session, never created. Until it
   * is live once, a recovery re-sends the attach (no `create`), and an
   * `UnknownSession` fails it instead of recreating an empty session under an
   * id another device owns (docs/feat/tui-foreign-turns.md B7).
   */
  attach: { readonly reopen: boolean } | undefined;
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

/**
 * The daemon answered `SessionDeleted` for a session this client opened: it
 * was removed with `session/delete` (another device, while this one was
 * away). The client never recreates it; a frontend drops its own copy.
 */
export interface SessionDeletedNotice {
  readonly sessionId: string;
}

/**
 * A pod asked for a model name this laptop does not serve (`refusedName`). Its
 * message holds only the schema-shaped name, so it alone is safe for an unattended
 * log (the detached relay's): `onError` also carries endpoint bodies and junk.
 */
export class ModelNameRefusedError extends Error {
  constructor(text: string) {
    super(`refused a model call from the pod: ${text}`);
    this.name = "ModelNameRefusedError";
  }
}

/** A shared session the daemon no longer has after a drop: it ended while this client was away (R7). */
class VanishedError extends RpcError {
  constructor() {
    super(DomainErrorCode.SessionArchived, "the session ended while the link was down");
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

/** Reason words for the statuses a user can act on: ours, never the response's. */
const MODEL_STATUS_REASON: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not found",
  429: "rate limited",
};

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
  /** Exits that arrived while `exitListeners` was empty: the first subscriber gets them. */
  private readonly exitBacklog: BackgroundExitNotice[] = [];
  /**
   * A SUB-AGENT's exit, by session: kept apart from `exitListeners` on purpose
   * (a saver subscribing there would drain the backlog the TUI that mounts
   * later is owed — docs/feat/subagent-background.md, Context 5).
   */
  private readonly agentExitListeners = new Set<(sessionId: string) => void>();
  /** Session-independent listeners for title changes (idle or mid-turn). */
  private readonly titleListeners = new Set<(notice: SessionTitleNotice) => void>();
  /** Session-independent listeners for queue changes (idle or mid-turn). */
  private readonly queueListeners = new Set<(notice: SessionQueueNotice) => void>();
  private readonly statusListeners = new Set<(status: LinkStatus) => void>();
  private readonly historyLostListeners = new Set<(notice: HistoryLostNotice) => void>();
  private readonly sessionDeletedListeners = new Set<(notice: SessionDeletedNotice) => void>();
  /** Conditions re-checked after every state change (session live, link stopped, …). */
  private readonly waiters = new Set<() => boolean>();
  /** Closes / deletes / detaches in flight (settled, never rejecting): what `drain` awaits. */
  private readonly ending = new Set<Promise<void>>();
  /** Served model calls in flight (`modelIdle`). */
  private modelCalls = 0;
  private readonly modelIdleWaiters = new Set<() => void>();
  /** Which permission request is prompted / answered (pure; see its module). */
  private readonly router = new PermissionRouter();
  /** The on-screen prompt's abort handle, by `sessionId` + `requestId`. */
  private readonly prompts = new Map<string, AbortController>();

  private readonly modelProvider?: ModelProvider;
  /** pod-safe model-error text → its full laptop-side message (display only). */
  private readonly laptopTexts = new Map<string, string>();
  private readonly titleModelProvider?: ModelProvider;
  private readonly namedModels?: NamedModels;
  /** The refused names already told to `onError` (bounded). */
  private readonly refusalsLogged = new Set<string>();
  /** `{ settings }`, or nothing: spread into each frame that may create a session. */
  private readonly carried: { readonly settings?: SessionSettings };
  private readonly settingsListeners = new Set<(notice: SessionSettingsNotice) => void>();
  private readonly settingsChangeListeners = new Set<(change: SessionSettingsChange) => void>();
  /**
   * The ids of this client's own `session/update_settings`: its `session_settings`
   * update is not "another terminal". Removed when that update arrives or the
   * daemon refuses; a drop keeps it (the update may still come).
   */
  private readonly ownSettingsIds = new Set<string>();
  private readonly onError?: (error: Error) => void;
  private readonly channelFactory?: () => Promise<DuplexChannel>;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly hooksTrust?: RemoteClientOptions["hooksTrust"];
  private readonly clientInfo?: ClientInfo;
  private readonly daemonKind: DaemonKind;
  /** Sessions with a `hooks/trust` prompt in flight (at most one each). */
  private readonly trustAsking = new Set<string>();
  /** Hashes `session/log` checkpoints (`readBack`); absent → `readBack` refuses. */
  private readonly sha256: Sha256 | undefined;

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
    if (options.clientInfo) {
      this.clientInfo = options.clientInfo;
    }
    this.daemonKind = options.daemonKind ?? "serve";
    if (options.titleModelProvider) {
      this.titleModelProvider = options.titleModelProvider;
    }
    if (options.namedModels) {
      this.namedModels = options.namedModels;
    }
    this.carried = options.sessionSettings ? { settings: options.sessionSettings } : {};
    this.sha256 = options.sha256 ?? bunSha256();
    this.link = { ...initialLink, upSince: this.clock.now() };
    this.lastInboundAt = this.clock.now();
    this.peer = this.makePeer(channel, 0);
  }

  /** Handshake; rejects on an incompatible daemon version. */
  async initialize(): Promise<InitializeResult> {
    return this.handshake(this.peer);
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
   * The context a session would send now (`session/context`,
   * docs/feat/tui-target-badge.md): exact when the daemon's provider counts it,
   * else its estimate. `sessionId` absent → the fresh conversation a session
   * created now would send. Not re-sent after a drop; the caller treats a
   * rejection as "unknown".
   */
  sessionContext(sessionId?: string, seed?: readonly ChatMessage[]): Promise<SessionContextResult> {
    if (!this.up && this.channelFactory) {
      return Promise.reject(new Error("not connected to the daemon"));
    }
    return this.call(
      this.peer,
      Method.SessionContext,
      sessionId !== undefined
        ? { sessionId }
        : { ...(seed && seed.length > 0 ? { messages: seed } : {}), ...this.carried },
    ).then((result) => result as SessionContextResult);
  }

  /**
   * A session's skills, read again from disk by the daemon (`session/skills`,
   * docs/feat/skills-hot-reload.md): its `/name` list, every skill found and
   * the discovery problems. `sessionId` absent → the skills a session the
   * daemon creates now would have (a session is opened at its first prompt).
   * Not re-sent after a drop: the user just asks again. Schema-validated by
   * the peer (a hostile pod's list is rejected whole).
   */
  sessionSkills(sessionId?: string): Promise<SessionSkillsResult> {
    if (!this.up && this.channelFactory) {
      return Promise.reject(new Error("not connected to the daemon"));
    }
    return this.call(
      this.peer,
      Method.SessionSkills,
      sessionId !== undefined ? { sessionId } : this.carried,
    ).then((result) => result as SessionSkillsResult);
  }

  /**
   * Read (no argument) or change this daemon's idle TTL (`daemon/session_ttl`);
   * `"never"` = never. Resolves to the value now in force. A change lasts until
   * the daemon restarts (`persisted: false`). An older daemon, a pod or the
   * worker (no idle reaper) rejects with `MethodNotFound`. Not re-sent after a
   * drop (a fresh read or set is the caller's call). Schema-validated by the peer.
   */
  sessionTtl(idleTtlMs?: number | "never"): Promise<SessionTtlResult> {
    if (!this.up && this.channelFactory) {
      return Promise.reject(new Error("not connected to the daemon"));
    }
    return this.call(
      this.peer,
      Method.SessionTtl,
      idleTtlMs === undefined ? {} : { idleTtlMs },
    ).then((result) => result as SessionTtlResult);
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

  /**
   * Rename a session (`session/rename`): resolves with the title the daemon
   * stored (one line, its rules). Not re-sent after a drop (the user asks
   * again). Needs no `open`. An older daemon → rejects `MethodNotFound`
   * with "this daemon is too old to rename sessions — update tentacle".
   */
  rename(sessionId: string, title: string): Promise<SessionTitle> {
    if (!this.up && this.channelFactory) {
      return Promise.reject(new Error("not connected to the daemon"));
    }
    return this.call(this.peer, Method.Rename, { sessionId, title }).then(
      (result) => (result as RenameResult).title,
      (error: unknown) => {
        if (error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound) {
          throw new RpcError(
            JsonRpcErrorCode.MethodNotFound,
            "this daemon is too old to rename sessions — update tentacle",
          );
        }
        throw error;
      },
    );
  }

  /**
   * A controller the Ink App drives exactly like a local `Session`. `seedTitle`:
   * the chosen title of the record it resumes (sent with the open that
   * recreates it; a daemon that has it keeps its own). `closeIfLast`: its
   * `close()` is `session/close{ifLast}` (a session other clients share).
   */
  newSession(
    seedMessages?: readonly ChatMessage[],
    sessionId?: string,
    seedTitle?: SeedTitle,
    opts: { readonly attach?: { readonly reopen?: boolean }; readonly closeIfLast?: boolean } = {},
  ): RemoteSession {
    return new RemoteSession(
      this,
      seedMessages,
      sessionId,
      seedTitle,
      opts.attach,
      opts.closeIfLast === true,
    );
  }

  /**
   * Attach to an EXISTING session (`session/open{sessionId, reopen?}`, never
   * `create`, never `messages`) and resolve once it is live: its full history
   * arrives as the listener's first `reset` (a paged snapshot). Rejects —
   * creating nothing — on `SessionArchived` (unless `reopen`),
   * `SessionDeleted` (`onSessionDeleted` fires) or `UnknownSession`
   * (docs/feat/tui-foreign-turns.md B7). Bounded: no progress for
   * `ATTACH_TIMEOUT_MS` (`noteAttachProgress`: no answer, a link that never comes
   * back) → `AttachTimeoutError`. The never-live entry is forgotten, so a late
   * answer is ignored, and nothing is sent to the daemon
   * (docs/feat/session-settings-apply.md S3).
   */
  async attachSession(
    sessionId: string,
    listener: SessionStreamListener,
    opts: { readonly reopen?: boolean } = {},
  ): Promise<string> {
    const entry = this.register(sessionId, [], listener);
    entry.attach ??= { reopen: opts.reopen === true };
    const forget = (): void => {
      if (!entry.everLive && this.sessions.get(sessionId) === entry) {
        this.sessions.delete(sessionId);
        entry.listener = null;
      }
    };
    // Waits for an answer, not for the transfer: the bound counts from the
    // attach's last progress (`noteAttachProgress`).
    entry.attachMark = 0;
    entry.attachProgressAt = this.clock.now();
    let timer: unknown = null;
    const deadline = new Promise<never>((_, reject) => {
      const arm = (ms: number): void => {
        timer = this.clock.setTimeout(() => {
          timer = null;
          const left = entry.attachProgressAt + ATTACH_TIMEOUT_MS - this.clock.now();
          if (left > 0) {
            arm(left);
            return;
          }
          forget();
          reject(new AttachTimeoutError(ATTACH_TIMEOUT_MS));
        }, ms);
      };
      arm(ATTACH_TIMEOUT_MS);
    });
    const attached = (async () => {
      await this.openOn(entry, this.gen, {
        sessionId,
        ...(opts.reopen === true ? { reopen: true } : {}),
      });
      await this.whenLive(entry);
    })();
    try {
      await Promise.race([attached, deadline]);
    } catch (error) {
      forget();
      throw error;
    } finally {
      if (timer !== null) {
        this.clock.clearTimeout(timer);
      }
      // The loser of the race settles unobserved: never an unhandled rejection.
      attached.catch(() => {});
      deadline.catch(() => {});
    }
    return sessionId;
  }

  /** Subscribe to title changes across all sessions (see `SessionTitleNotice`); returns an unsubscribe. */
  onSessionTitle(listener: (notice: SessionTitleNotice) => void): () => void {
    this.titleListeners.add(listener);
    return () => this.titleListeners.delete(listener);
  }

  /** Subscribe to queue changes across all sessions (see `SessionQueueNotice`); returns an unsubscribe. */
  onSessionQueued(listener: (notice: SessionQueueNotice) => void): () => void {
    this.queueListeners.add(listener);
    return () => this.queueListeners.delete(listener);
  }

  /** The session's queue as last reported; undefined if the daemon has not reported one. */
  queuedOf(sessionId: string): QueueState | undefined {
    return this.sessions.get(sessionId)?.queued;
  }

  /**
   * `session/reclaim`: these returned rows are back with their writer (this
   * client). Idempotent daemon-side, so re-sent after a drop. The caller
   * reclaims only ids it sent itself (docs/feat/queued-broadcast.md).
   */
  reclaim(sessionId: string, ids: readonly string[]): Promise<void> {
    return this.sessionCall(sessionId, Method.Reclaim, { sessionId, ids: [...ids] }, "keyed").then(
      () => undefined,
    );
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

  /**
   * Subscribe to the daemon's report of what a session did with its settings
   * (see `SessionSettingsNotice`), on every open that carries one, a re-attach
   * included; returns an unsubscribe.
   */
  onSessionSettings(listener: (notice: SessionSettingsNotice) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  /**
   * Subscribe to "another client applied its settings to a session open here"
   * (see `SessionSettingsChange`); this client's own applies are not told.
   * Returns an unsubscribe.
   */
  onSessionSettingsChanged(listener: (change: SessionSettingsChange) => void): () => void {
    this.settingsChangeListeners.add(listener);
    return () => this.settingsChangeListeners.delete(listener);
  }

  /** The session's newest settings report; undefined before one (or from a daemon that sends none). */
  settingsOf(sessionId: string): SessionSettingsReport | undefined {
    return this.sessions.get(sessionId)?.settings;
  }

  /**
   * `session/update_settings` (docs/feat/session-settings-apply.md): apply the
   * settings this client carries (`RemoteClientOptions.sessionSettings`, the
   * same values the drift notice compares) to the live session. Not re-sent
   * after a drop (`once`): the result of a dropped call is unknown, and the
   * call is idempotent by value, so the user runs it again. Rejects locally,
   * sending nothing, when this client carries nothing (`connect`, the worker).
   * An older daemon → `MethodNotFound`, worded.
   */
  updateSettings(sessionId: string): Promise<UpdateSettingsResult> {
    const settings = this.carried.settings;
    if (!settings) {
      return Promise.reject(new Error("this client carries no settings to apply"));
    }
    const id = crypto.randomUUID();
    this.ownSettingsIds.add(id);
    return this.sessionCall(
      sessionId,
      Method.UpdateSettings,
      { sessionId, id, settings },
      "once",
    ).then(
      (raw) => {
        const result = raw as UpdateSettingsResult;
        const entry = this.sessions.get(sessionId);
        // Its update arrived already (the id left the set): the stream, which
        // may hold a newer sync by now, is the truth.
        if (entry && result.settings && this.ownSettingsIds.has(id)) {
          entry.settings = result.settings;
        }
        if (!result.applied) {
          this.ownSettingsIds.delete(id); // nothing was emitted
        }
        return result;
      },
      (error: unknown) => {
        // The daemon's own refusal: no update will carry this id.
        if (error instanceof RpcError && REFUSALS.has(error.code)) {
          this.ownSettingsIds.delete(id);
        }
        if (error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound) {
          throw new RpcError(
            JsonRpcErrorCode.MethodNotFound,
            "this container's tentacle predates /settings sync: quit and attach again to update it",
          );
        }
        throw error;
      },
    );
  }

  /**
   * Subscribe to "the daemon says this session was deleted" (see
   * `SessionDeletedNotice`); returns an unsubscribe. Decided by the error
   * CODE, never its text.
   */
  onSessionDeleted(listener: (notice: SessionDeletedNotice) => void): () => void {
    this.sessionDeletedListeners.add(listener);
    return () => this.sessionDeletedListeners.delete(listener);
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
    title?: SeedTitle,
  ): Promise<string> {
    const seed = messages ?? [];
    const params = {
      create: true,
      ...(cwd ? { cwd } : {}),
      ...(seed.length > 0 ? { messages: seed } : {}),
      ...(title ? { title } : {}),
      ...this.carried,
    };
    if (sessionId === undefined) {
      const gen = this.gen;
      const result = (await this.call(this.peer, Method.Open, params)) as OpenResult;
      const entry = this.register(result.sessionId, seed, listener, title);
      this.step(entry, { kind: "open_sent" });
      this.applyOpenResult(entry, gen, result);
      await this.whenLive(entry);
      return result.sessionId;
    }
    const entry = this.register(sessionId, seed, listener, title);
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
   * outlive connections, so a client that is done with one says so. A daemon
   * that persists (`serve`) keeps it ARCHIVED (listed, reopenable); elsewhere
   * it is gone. Resolves when the daemon answered — or the request failed
   * (peer closed: moot); never rejects. While the link is down it resolves at
   * once (the daemon reaps a detached idle session).
   */
  closeSession(sessionId: string, opts: { readonly ifLast?: boolean } = {}): Promise<void> {
    return this.endSession(Method.Close, sessionId, opts.ifLast === true).then(() => undefined);
  }

  /**
   * Remove a session daemon-side for good (`session/delete`): a live one is
   * ended first (`session_closed{deleted}` to every client), then the
   * DAEMON's record is removed (this client's own store is its caller's to
   * clean). Same guarantees as `closeSession`; needs no `open`.
   */
  deleteSession(sessionId: string): Promise<void> {
    return this.endSession(Method.SessionDelete, sessionId).then(() => undefined);
  }

  /**
   * Stop following a session on this connection (`session/detach`): it keeps
   * running daemon-side (turn, jobs, pending asks) for any client. Forgotten
   * here, and its open prompts withdrawn, once the daemon answers — or the
   * link drops (the dropped socket detached it daemon-side already); while
   * the link is down it resolves at once. Rejects only on `MethodNotFound`
   * (an older daemon): nothing changed, the session stays followed.
   */
  detachSession(sessionId: string): Promise<void> {
    return this.endSession(Method.Detach, sessionId).then(() => undefined);
  }

  /** Resolves true only when the daemon answered `closed: true` (a close it ended). */
  private endSession(
    method: typeof Method.Close | typeof Method.SessionDelete | typeof Method.Detach,
    sessionId: string,
    ifLast = false,
  ): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    // Routed until the daemon answers: the turn it cancels ends in the stream
    // (`turn_end`, `session_closed`), and those frames precede the response.
    const forget = (): void => {
      if (entry && this.sessions.get(sessionId) === entry) {
        this.sessions.delete(sessionId);
        this.kick();
      }
      // A detach gets no `session_closed`: its prompts are withdrawn here (an
      // `ifLast` close may have been one).
      if (method === Method.Detach || ifLast) {
        this.runPermissionActions(this.router.sessionClosed(sessionId));
      }
    };
    if (entry) {
      entry.closing = true;
      this.kick();
    }
    if (!this.up && this.channelFactory) {
      forget();
      return Promise.resolve(false);
    }
    const params = ifLast ? { sessionId, ifLast } : { sessionId };
    const ending = this.call(this.peer, method, params).then(
      (result) => {
        forget();
        return (result as { closed?: unknown } | undefined)?.closed === true;
      },
      (error: unknown) => {
        if (
          method === Method.Detach &&
          error instanceof RpcError &&
          error.code === JsonRpcErrorCode.MethodNotFound
        ) {
          // An older daemon: nothing changed — keep following the session.
          if (entry && this.sessions.get(sessionId) === entry) {
            entry.closing = false;
          }
          throw error;
        }
        forget();
        return false;
      },
    );
    const tracked = ending.then(
      () => {},
      () => {},
    );
    this.ending.add(tracked);
    void tracked.then(() => this.ending.delete(tracked));
    return ending;
  }

  /**
   * Await every close / delete / detach still in flight — the exit path of a
   * client whose sessions outlive it (`connect`): a `/clear` or `/close` just
   * before quitting still reaches the daemon. AWAIT it before `close()` (the
   * in-memory pair drops a frame written just before closing). Bounded by
   * `timeoutMs`; never rejects.
   */
  async drain(timeoutMs: number = CLOSE_SESSIONS_TIMEOUT_MS): Promise<void> {
    if (this.ending.size === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.ending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Ids of the sessions this client followed live and has not closed, deleted or detached. */
  liveSessionIds(): string[] {
    return [...this.sessions.values()]
      .filter((entry) => entry.everLive && !entry.closing)
      .map((entry) => entry.id);
  }

  /**
   * Close every session this client opened and has not closed yet — the exit
   * path. `session/close{ifLast}` by default: a session another client is
   * still attached to is only detached, so a quit never ends it under them;
   * `ifLast: false` ends it for every client (a confirmed `/quit` of a shared
   * session, docs/fix/detach-live.md D1). AWAIT it before `close()`: a frame written just before closing is not
   * guaranteed to be delivered on every transport (the in-memory pair drops
   * it). Bounded by `timeoutMs` so a hung daemon never blocks the exit; never
   * rejects. Resolves with how many of them the daemon did NOT confirm it
   * closed (`closed: true`, or its `session_closed` seen: another client's
   * close won the race): a detach, a timeout, a dropped link and an older
   * daemon all count — the side a quit deciding a delete must take.
   */
  async closeSessions(
    timeoutMs: number = CLOSE_SESSIONS_TIMEOUT_MS,
    opts: { readonly ifLast?: boolean } = {},
  ): Promise<number> {
    const ifLast = opts.ifLast ?? true;
    let confirmed = 0;
    const pending = [...this.sessions.values()]
      .filter((entry) => !entry.closing)
      .map((entry) =>
        this.endSession(Method.Close, entry.id, ifLast).then((closed) => {
          if (closed || entry.closedSeen) confirmed += 1;
        }),
      );
    if (pending.length === 0) {
      return 0;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    // Read now: a confirmation landing after the bound does not count.
    return pending.length - confirmed;
  }

  /**
   * Resolve once no `model/stream` / `model/streamChunked` (titles included)
   * this client serves is in flight, or after `timeoutMs`; never rejects. A
   * client leaving a session someone else goes on with drains first: its
   * in-flight call would otherwise reject and fail THEIR turn
   * (docs/feat/detached-handover.md, probes C and I).
   */
  async modelIdle(timeoutMs: number): Promise<void> {
    if (this.modelCalls === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        this.modelIdleWaiters.delete(done);
        resolve();
      };
      this.modelIdleWaiters.add(done);
      timer = setTimeout(done, timeoutMs);
    });
    clearTimeout(timer);
  }

  /** Count a served model call until it settles (`modelIdle`). */
  private servingCall<T>(call: () => Promise<T>): Promise<T> {
    this.modelCalls += 1;
    const settled = (): void => {
      // A macrotask later: the peer writes the call's response only after this
      // handler's promise settles, and a `close()` before that write drops it.
      setTimeout(() => {
        this.modelCalls -= 1;
        if (this.modelCalls === 0) {
          for (const waiter of [...this.modelIdleWaiters]) waiter();
        }
      }, 0);
    };
    let running: Promise<T>;
    try {
      running = call();
    } catch (error) {
      settled();
      throw error;
    }
    return running.finally(settled);
  }

  /**
   * Read the session's history back at its current cut (for the main thread to
   * persist), page by page, newest first, joined chronologically. A compaction
   * landing between two pages makes the cursor stale: start over. With a
   * factory it waits out a drop (read-only: safe to repeat).
   */
  async snapshot(sessionId: string): Promise<readonly ChatMessage[]> {
    const entry = this.sessions.get(sessionId);
    const result = (snap: Snap): readonly ChatMessage[] => {
      if (entry) this.titleRead(entry, snap.title);
      return snap.messages;
    };
    if (!this.channelFactory || !entry) {
      const mark = entry?.turnEndsApplied ?? 0;
      const snap = await this.readSnapshot(sessionId, this.peer);
      if (entry) this.historyRead(entry, snap.messages, mark);
      return result(snap);
    }
    for (;;) {
      const gen = await this.whenLive(entry);
      const mark = entry.turnEndsApplied;
      try {
        const snap = await this.readSnapshot(sessionId, this.peer);
        this.historyRead(entry, snap.messages, mark);
        return result(snap);
      } catch (error) {
        if (gen === this.gen && this.up) throw error;
      }
    }
  }

  /**
   * The session's committed history for the main thread to persist, read
   * through `session/log` (docs/feat/session-log.md): only the entries after
   * the last one this client holds, validated (a pod is not trusted) and
   * projected onto its copy. Committed only once the whole read is in and
   * valid (a drop or a refusal mid-read leaves the held copy as it was). With
   * a factory it waits out a drop and reads again (read-only: safe to repeat).
   * The title is the daemon's, as last logged (absent: none known yet).
   */
  async readBack(sessionId: string): Promise<ReadBack> {
    const entry = this.sessions.get(sessionId);
    if (!this.channelFactory || !entry) {
      return this.readLog(sessionId, this.peer, entry);
    }
    for (;;) {
      const gen = await this.whenLive(entry);
      try {
        return await this.readLog(sessionId, this.peer, entry);
      } catch (error) {
        if (gen === this.gen && this.up) throw error;
      }
    }
  }

  /**
   * One `readBack` on `peer`: page `session/log` into a staging list, apply it
   * (`applyLogRead`), commit. A rebase between two pages restarts the read; a
   * refused read is retried once COLD (from the daemon's last base, classified
   * against the held copy); a drifted checkpoint is re-read cold once, then the
   * cold projection is kept and the drift reported once — never a loop.
   */
  private async readLog(
    sessionId: string,
    peer: RpcPeer,
    entry: SessionEntry | undefined,
  ): Promise<ReadBack> {
    const sha256 = this.sha256;
    if (sha256 === undefined) {
      throw new Error("readBack needs a sha256 hasher (RemoteClientOptions.sha256)");
    }
    const mark = entry?.turnEndsApplied ?? 0;
    const held = entry?.log ?? null;
    let cold = false;
    let lastError = "";
    for (let attempt = 1; attempt <= LOG_ATTEMPTS; attempt++) {
      const pages: LogResult[] = [];
      let after = cold ? undefined : held?.head;
      for (;;) {
        if (pages.length >= LOG_MAX_PAGES) {
          throw new RpcError(JsonRpcErrorCode.InternalError, "session/log: too many pages");
        }
        const page = (await this.call(peer, Method.Log, {
          sessionId,
          ...(after ? { after } : {}),
        })) as LogResult;
        pages.push(page);
        const last = page.entries.at(-1);
        if (!page.more) break;
        if (last === undefined || (page.rebased === true && pages.length > 1)) break;
        after = { seq: last.seq, id: last.id };
      }
      const applied = applyLogRead(held, pages, sha256);
      if ("error" in applied) {
        lastError = applied.error;
        cold = true;
        continue;
      }
      // One cold read the FIRST time a session drifts (the daemon's derivation
      // from its last base); once reported, a persistently drifting daemon does
      // not turn every save into a full read (L3). A clean read re-arms it.
      if (applied.drift && !cold && !entry?.driftReported) {
        cold = true;
        continue;
      }
      if (entry && !applied.drift) {
        entry.driftReported = false;
      }
      if (applied.drift && entry && !entry.driftReported) {
        entry.driftReported = true;
        this.onError?.(
          new Error(
            `session ${sessionId}: the daemon's log failed its checkpoint at entry ${applied.drift.seq} (kept the daemon's projection)`,
          ),
        );
      }
      if (entry) {
        entry.log = applied.state;
        if (applied.title) entry.logTitle = applied.title;
        this.historyRead(entry, applied.state.messages, mark);
        this.titleRead(entry, entry.logTitle);
      }
      const title = entry ? entry.logTitle : applied.title;
      const from = cold ? undefined : held?.head;
      return {
        messages: applied.state.messages,
        entries: applied.entries,
        read: {
          ...(from ? { from } : {}),
          head: applied.state.head,
          outcome: applied.outcome,
        },
        ...(title ? { title } : {}),
        ...(applied.aside ? { aside: applied.aside } : {}),
        ...(applied.gap ? { gap: true as const } : {}),
      };
    }
    throw new RpcError(
      JsonRpcErrorCode.InternalError,
      `session/log: the daemon's log was refused: ${lastError}`,
    );
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

  /**
   * A notification: lost while the link is down (the caller re-sends it after
   * `recovered`). `turnId` names the turn meant (any other is left running);
   * absent → whatever runs.
   */
  cancel(sessionId: string, turnId?: string): void {
    if (this.up) {
      this.peer.notify(
        Notification.Cancel,
        turnId === undefined ? { sessionId } : { sessionId, turnId },
      );
    }
  }

  /** (Re)attach the consumer of a session's stream; `null` detaches it. */
  setListener(sessionId: string, listener: SessionStreamListener | null): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.listener = listener;
    }
  }

  /**
   * A background sub-agent exited in a session (`RemoteSession.onAgentExit`).
   * It does NOT touch the exit backlog: never a stand-in for `onBackgroundExit`.
   */
  onAgentExit(listener: (sessionId: string) => void): () => void {
    this.agentExitListeners.add(listener);
    return () => this.agentExitListeners.delete(listener);
  }

  /** Subscribe to background-job exits across all sessions; returns an unsubscribe. */
  onBackgroundExit(listener: (notice: BackgroundExitNotice) => void): () => void {
    // Exits nobody was listening to (a replay on open, a live one before the
    // TUI mounted) go to the first subscriber, once.
    const owed = this.exitBacklog.splice(0);
    this.exitListeners.add(listener);
    for (const notice of owed) {
      listener(notice);
    }
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Exits no turn has flushed, summed over the open sessions, as the newest
   * opens reported them: the TUI starts a wake turn for them (`wakePending`).
   */
  unflushedExits(): number {
    let total = 0;
    for (const entry of this.sessions.values()) {
      total += entry.unflushedExits;
    }
    return total;
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
          return this.servingCall(() => this.onModelStream(params as ModelStreamParams));
        }
        if (method === Method.ModelStreamChunked) {
          return this.servingCall(() =>
            this.onModelStreamChunked(
              peer,
              params as ModelStreamChunkedParams,
              context as RequestContext,
            ),
          );
        }
        if (method === Method.ModelCountTokens) {
          return this.servingCall(() =>
            this.onModelCountTokens(params as ModelCountTokensParams, context?.signal),
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
      ...(this.clientInfo ? { clientInfo: this.clientInfo } : {}),
    }).then(
      (raw) => raw as InitializeResult,
      // A version skew says who must update — at start and on every reconnect.
      (error: unknown) => {
        throw explainVersionMismatch(error, this.daemonKind) ?? error;
      },
    );
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
    title?: SeedTitle,
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
      log: null,
      logTitle: undefined,
      driftReported: false,
      everLive: false,
      recreates: 0,
      noticedRecreates: 0,
      liveGen: -1,
      owesNotice: false,
      closing: false,
      closedSeen: false,
      turnEndsApplied: 0,
      turnEndsInHistory: 0,
      title,
      queued: undefined,
      settings: undefined,
      unflushedExits: 0,
      attachMark: 0,
      attachProgressAt: 0,
      attach: undefined,
    };
    this.sessions.set(id, entry);
    return entry;
  }

  /**
   * The daemon's title as a read showed it: a chosen one this client did not
   * know (an update it missed past a cut) is learned and announced like a
   * `session_title`. An `auto` one, or none (an older daemon), changes nothing.
   */
  private titleRead(entry: SessionEntry, title: SessionTitle | undefined): void {
    if (!title || title.source === "auto") {
      return;
    }
    const known = entry.title;
    if (known && known.text === title.text && known.source === title.source) {
      return;
    }
    this.titleChanged(entry, { text: title.text, source: title.source });
  }

  private titleChanged(entry: SessionEntry, title: SeedTitle): void {
    entry.title = title;
    for (const listener of this.titleListeners) {
      listener({ sessionId: entry.id, title: title.text, source: title.source });
    }
  }

  /** The daemon's queue now (a `queued` update in seq order, or a resync's snapshot): full state. */
  private queuedChanged(entry: SessionEntry, state: QueueState): void {
    entry.queued = state;
    for (const listener of this.queueListeners) {
      listener({ sessionId: entry.id, state });
    }
  }

  /** A `session_settings` in seq order: the newest report; told unless the sync was this client's. */
  private settingsChanged(
    entry: SessionEntry,
    report: SessionSettingsReport,
    id: string | undefined,
  ): void {
    const previous = entry.settings;
    entry.settings = report;
    if (id !== undefined && this.ownSettingsIds.delete(id)) {
      return;
    }
    for (const listener of this.settingsChangeListeners) {
      listener({ sessionId: entry.id, ...(previous ? { previous } : {}), report });
    }
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
          : entry.attach
            ? // An attach never live: attach again, never create.
              { sessionId: entry.id, ...(entry.attach.reopen ? { reopen: true } : {}) }
            : // Never live: its first open may not have reached the daemon.
              {
                sessionId: entry.id,
                create: true,
                ...(entry.history.length > 0 ? { messages: entry.history } : {}),
                ...this.logBaseOf(entry),
                ...(entry.title ? { title: entry.title } : {}),
                ...this.carried,
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
      title?: SeedTitle;
      reopen?: boolean;
      settings?: SessionSettings;
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
      this.noteDeleted(entry, error);
      const unknown = error instanceof RpcError && error.code === DomainErrorCode.UnknownSession;
      if (unknown && params.create !== true && entry.everLive && entry.listener?.shared === true) {
        // A session others share, gone after a drop: another client's close for
        // all (or a reap) ended it. Its end, told as the archive's, not a loss to
        // recreate from this copy (R7): `failSession` ends it for the frontend.
        throw new VanishedError();
      }
      // An attach that was never live has nothing to recreate: the id is gone.
      if (unknown && params.create !== true && (entry.attach === undefined || entry.everLive)) {
        await this.recreate(entry, gen);
        return;
      }
      throw error;
    }
    this.applyOpenResult(entry, gen, result);
  }

  /**
   * The attach got further than ever: the bound restarts. A high-water mark, not
   * "any answer": after a drop the open and the first pages are served again, and
   * a daemon or link that repeats them for ever must still hit the bound.
   */
  private noteAttachProgress(entry: SessionEntry, mark: number): void {
    if (mark > entry.attachMark) {
      entry.attachMark = mark;
      entry.attachProgressAt = this.clock.now();
    }
  }

  private applyOpenResult(entry: SessionEntry, gen: number, result: OpenResult): void {
    if (gen !== this.gen || this.sessions.get(entry.id) !== entry) {
      return;
    }
    this.noteAttachProgress(entry, 1);
    entry.unflushedExits = result.unflushedExits ?? 0;
    this.noteSettings(entry, result);
    this.step(entry, {
      kind: "open_result",
      created: result.created,
      resync: result.resync,
      epoch: result.epoch,
      now: this.clock.now(),
    });
  }

  /** The daemon's report of this open, to whoever listens. */
  private noteSettings(entry: SessionEntry, result: OpenResult): void {
    if (!result.settings) {
      return;
    }
    entry.settings = result.settings;
    for (const listener of this.settingsListeners) {
      listener({ sessionId: entry.id, report: result.settings });
    }
  }

  /**
   * `error` is the daemon's `SessionDeleted` (by code): tell the frontend, so
   * it drops its own copy. The caller still fails the open — never recreates.
   */
  private noteDeleted(entry: SessionEntry, error: unknown): void {
    if (!(error instanceof RpcError) || error.code !== DomainErrorCode.SessionDeleted) {
      return;
    }
    for (const listener of this.sessionDeletedListeners) {
      listener({ sessionId: entry.id });
    }
  }

  /**
   * The daemon lost the session (a daemon that persists nothing: a new stdio
   * daemon, a pod daemon's close or reap while we were away): recreate it from
   * the newest history this client read. A `serve` daemon never gets here for
   * a session it ended or deleted (`SessionArchived` / `SessionDeleted`). The
   * turn in flight is reported lost, never re-run (the dead daemon may have
   * run its tools). A second device racing the recreate attaches instead.
   */
  private async recreate(entry: SessionEntry, gen: number): Promise<void> {
    if (entry.closing) {
      return; // closed meanwhile: recreating it would leave an orphan daemon-side
    }
    const messages = entry.history;
    const lostTurns = entry.turnEndsApplied - entry.turnEndsInHistory;
    let result: OpenResult;
    try {
      result = (await this.call(this.peer, Method.Open, {
        sessionId: entry.id,
        ...(messages.length > 0 ? { messages, ...this.logBaseOf(entry) } : { create: true }),
        // Our copy of its chosen title: a recreate is never regenerated over a rename.
        ...(entry.title ? { title: entry.title } : {}),
        // Nothing was persisted: the laptop that recreates it decides.
        ...this.carried,
      })) as OpenResult;
    } catch (error) {
      // Deleted between the reconnect and this recreate (another device).
      if (gen === this.gen && this.up) this.noteDeleted(entry, error);
      throw error;
    }
    if (gen !== this.gen || this.sessions.get(entry.id) !== entry) {
      return;
    }
    entry.recreates += 1;
    entry.turnEndsInHistory = entry.turnEndsApplied;
    if (result.created) {
      this.noteSettings(entry, result);
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
    let snap: Snap;
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
    // A title change behind the cut is only in the snapshot.
    this.titleRead(entry, snap.title);
    // So is a queue change: the state at the cut, then the buffered updates
    // past it (applied by `step` below, in seq order). Only here — never from
    // `readBack`, whose snapshot lags the live stream (it would go back).
    if (snap.queued) {
      this.queuedChanged(entry, snap.queued);
    }
    this.step(entry, {
      kind: "snapshot",
      messages: snap.messages,
      since: snap.since,
      turn: snap.turn ?? null,
      now: this.clock.now(),
    });
  }

  /**
   * `{logBase}` for a recreate seeded with `entry.history`, only when that
   * history IS the held log's projection (a display resync may have replaced
   * it): the new daemon's first `base` then links to our head (a reseed, not a
   * fork). Numbering only — it grants nothing.
   */
  private logBaseOf(entry: SessionEntry): { logBase?: LogCursor } {
    const log = entry.log;
    return log !== null && log.messages === entry.history && entry.history.length > 0
      ? { logBase: log.head }
      : {};
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
    // Ended or deleted while we were away — told by CODE, never by text: the
    // session is gone for this client (nothing to follow, close or answer).
    const ended =
      error instanceof RpcError
        ? error instanceof VanishedError
          ? "gone"
          : error.code === DomainErrorCode.SessionArchived
            ? "closed"
            : error.code === DomainErrorCode.SessionDeleted
              ? "deleted"
              : null
        : null;
    if (ended !== null) {
      this.sessions.delete(entry.id);
      this.runPermissionActions(this.router.sessionClosed(entry.id));
      entry.listener?.ended?.(ended);
    }
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
    for (const out of result.out) {
      if (out.kind === "failed") {
        entry.failReason = out.reason;
      }
    }
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
        // Attributed to the turn the stream raised it in; the update's own
        // `turnId` (a background child's spawning turn) wins in the router.
        this.runPermissionActions(this.router.request(entry.id, update, out.turn));
      } else if (update.type === "permission_resolved") {
        this.runPermissionActions(this.router.resolved(entry.id, update.requestId));
      } else if (update.type === "background_exit") {
        // Not turn-scoped: the dedicated listeners fire even when no turn is
        // streaming (`RemoteSession` leaves it to them).
        const { jobId, command, status, exitCode, agent } = update;
        const notice: BackgroundExitNotice = {
          jobId,
          command,
          status,
          exitCode,
          ...(agent ? { agent } : {}),
        };
        if (this.exitListeners.size === 0) {
          // Kept for the first subscriber: one per job, the newest 64.
          if (!this.exitBacklog.some((n) => n.jobId === jobId)) {
            this.exitBacklog.push(notice);
            if (this.exitBacklog.length > EXIT_BACKLOG_MAX) {
              this.exitBacklog.shift();
            }
          }
        }
        for (const listener of this.exitListeners) {
          listener(notice);
        }
        // A sub-agent's exit also tells whoever keeps the session's copy (M5).
        if (agent) {
          for (const listener of [...this.agentExitListeners]) {
            listener(entry.id);
          }
        }
      } else if (update.type === "session_title") {
        // Not turn-scoped either: the title listeners fire while idle too.
        this.titleChanged(entry, { text: update.title, source: update.source });
      } else if (update.type === "queued") {
        // Not turn-scoped: the queue listeners fire while idle too.
        this.queuedChanged(entry, { entries: update.entries, returned: update.returned });
      } else if (update.type === "session_settings") {
        // Not turn-scoped: another client's sync is told while idle too.
        this.settingsChanged(entry, update.settings, update.id);
      }
      // Closed daemon-side (by any client): nothing left to close at exit,
      // nothing left to answer.
      if (update.type === "session_closed") {
        entry.closedSeen = true;
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
          reject(new Error(notResumed(entry)));
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
      throw new Error(notResumed(entry));
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
          throw new RpcError(JsonRpcErrorCode.InternalError, DROPPED_NOT_RETRIED);
        }
      }
    }
  }

  private async readSnapshot(sessionId: string, peer: RpcPeer): Promise<Snap> {
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

  private async readSnapshotPages(sessionId: string, peer: RpcPeer): Promise<Snap> {
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
      const entry = this.sessions.get(sessionId);
      if (entry) {
        this.noteAttachProgress(entry, 1 + pages.length);
      }
    } while (cursor !== undefined);
    return {
      messages: pages.reverse().flat(),
      ...(first?.since ? { since: first.since } : {}),
      ...(first?.turn ? { turn: first.turn.turnId } : {}),
      ...(first?.title ? { title: first.title } : {}),
      ...(first?.queued ? { queued: first.queued } : {}),
    };
  }

  /**
   * Serve `model/countTokens` (docs/feat/tui-target-badge.md): the LOCAL
   * provider counts the pod's request without generating. The answer is one
   * number — omitted when this provider cannot count or the count failed (the
   * daemon then estimates); the error itself never crosses to the pod.
   */
  private async onModelCountTokens(
    params: ModelCountTokensParams,
    signal?: AbortSignal,
  ): Promise<ModelCountTokensResult> {
    const model = this.servingModel(Method.ModelCountTokens, undefined);
    // The same 2 s cap as the daemon's own count (`countTokensBounded`): a hung
    // endpoint never holds the pod's request, nor `servingCall`, nor a quit.
    const tokens = await countTokensBounded(
      model,
      params.request as unknown as ChatRequest,
      signal,
    );
    return tokens === undefined ? {} : { tokens };
  }

  /**
   * Serve a `model/stream` request from the daemon (the pod reverse-tunnel),
   * batch cut: run the LOCAL model and return the whole turn's events in one
   * response. Kept so an old daemon (which only knows `model/stream`) works
   * against a new laptop.
   */
  private async onModelStream(params: ModelStreamParams): Promise<ModelStreamResult> {
    // A named call has the main model's exposure: no laptop-side limit and the
    // request as sent (owner Q1 (c), docs/feat/models-map-pod.md F7).
    const model = this.servingModel(Method.ModelStream, params.purpose, params.model);
    const events: WireStreamEvent[] = [];
    try {
      for await (const event of model.stream(params.request as unknown as ChatRequest)) {
        events.push(event as WireStreamEvent);
      }
    } catch (error) {
      throw this.connectionLost(error) ?? error;
    }
    return { events };
  }

  /**
   * A refusal of a name the pod asked for. The first one per name reaches
   * `onError` (the laptop's log): a hostile pod's attempts leave a trace here,
   * where it cannot erase them. The name is safe to echo: the schema shaped it.
   */
  private refusedName(name: string, text: string): RpcError {
    if (!this.refusalsLogged.has(name) && this.refusalsLogged.size < MAX_REFUSED_NAMES_LOGGED) {
      this.refusalsLogged.add(name);
      this.onError?.(new ModelNameRefusedError(text));
    }
    return new RpcError(JsonRpcErrorCode.InvalidRequest, text);
  }

  /**
   * A lost connection to the LOCAL model (`ModelConnectionError`, providers'
   * retry layer) as an `RpcError` the pod may see: a text built here from its
   * code and phase only, never its message (that one can carry the endpoint).
   * The full error still goes to `onError`. So the run's turn ends naming its
   * cause, not "internal error" (docs/fix/detach-live.md round 10). `null`:
   * any other error, left to the peer's opaque default.
   */
  private connectionLost(error: unknown): RpcError | null {
    const e = error as {
      name?: unknown;
      code?: unknown;
      phase?: unknown;
      status?: unknown;
    } | null;
    if (error instanceof Error && e?.name === "ModelRequestError") {
      return this.modelRequestFailed(error, e.status);
    }
    if (
      !(error instanceof Error) ||
      (e?.name !== "ModelConnectionError" && e?.name !== "ModelUnreachableError") ||
      typeof e.code !== "string" ||
      !/^E[A-Z]{2,15}$/.test(e.code)
    ) {
      return null;
    }
    this.onError?.(error);
    // `ModelUnreachableError`: the connect timeout (docs/fix/model-connect-timeout.md);
    // its message names the endpoint, so the pod gets this text instead.
    const what =
      e.name === "ModelUnreachableError"
        ? "model unreachable: the model endpoint did not answer"
        : e.phase === "mid-stream"
          ? "model connection lost mid-stream"
          : e.code === "ECONNREFUSED"
            ? "could not connect to the model endpoint"
            : "model connection lost";
    const text = `${what} (${e.code})`;
    if (e.name === "ModelUnreachableError") {
      // Kept ON THE LAPTOP only: `laptopText` swaps it back in when the turn's
      // error is shown here, so a pod run reads like a local run.
      this.laptopTexts.set(text, error.message);
    }
    return new RpcError(JsonRpcErrorCode.InternalError, text);
  }

  /**
   * An HTTP error answered by the LOCAL model (`ModelRequestError`) as an
   * `RpcError` the pod may see (docs/fix/detached-model-error-reason.md). The
   * text is built from the integer status and OUR OWN reason table only, never
   * from the error's message (it can carry the endpoint or a key; AGENTS §7).
   * The full error still goes to `onError`.
   */
  private modelRequestFailed(error: Error, status: unknown): RpcError {
    this.onError?.(error);
    let text = "the model endpoint reported an error";
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      const reason = MODEL_STATUS_REASON[status];
      text = `the model endpoint answered ${status}${reason ? ` (${reason})` : ""}`;
    }
    return new RpcError(JsonRpcErrorCode.InternalError, text);
  }

  /**
   * The text of a turn error as the laptop shows it: the pod-safe model-error
   * text (`connectionLost`) swapped for the full laptop-side message, which
   * names the endpoint. Display only; nothing of it is ever sent to the pod.
   */
  laptopText(message: string): string {
    let out = message;
    for (const [safe, full] of this.laptopTexts) {
      out = out.replaceAll(safe, full);
    }
    return out;
  }

  /**
   * The LOCAL model that serves a tunnelled call. A turn → the main one; a
   * title (`purpose: "title"`) → `titleModelProvider`, refused when this
   * laptop's `model.autoTitle` is off. A name → that entry, ONLY if this laptop
   * published it (`namedModels`, from its own config): this is the gate on what
   * a pod can reach; whatever the pod daemon checks first is UX (AGENTS §7).
   * The laptop decides, never the pod.
   */
  private servingModel(
    method: string,
    purpose: ModelPurpose | undefined,
    name?: string,
  ): ModelProvider {
    if (!this.modelProvider) {
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, `no local model to serve ${method}`);
    }
    if (name !== undefined) {
      if (purpose !== undefined) {
        throw new RpcError(JsonRpcErrorCode.InvalidRequest, "a title call names no model");
      }
      const served = this.namedModels?.resolve(name);
      if (served === "unavailable") {
        throw this.refusedName(
          name,
          `model "${name}" is unavailable on this laptop: its key command did not succeed here`,
        );
      }
      if (served === undefined) {
        throw this.refusedName(name, `model "${name}" is not published by this laptop`);
      }
      return served;
    }
    if (purpose !== "title") {
      return this.modelProvider;
    }
    if (!this.titleModelProvider) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidRequest,
        "titles are off on this laptop (model.autoTitle is false)",
      );
    }
    return this.titleModelProvider;
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
    const model = this.servingModel(Method.ModelStreamChunked, params.purpose, params.model);
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
      for await (const event of model.stream({
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
      // material, and the pod is not trusted (AGENTS §7). Except a lost model
      // connection or an HTTP error: a text built from code/status only
      // (`connectionLost`).
      throw this.connectionLost(error) ?? error;
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
   *
   * A person's reply (docs/feat/permission-reply.md) is never lost silently:
   * an answer carrying one that is not sent (withdrawn meanwhile, a request
   * that offered no reply) or not delivered (lost to another answer, the
   * session lost, a failure) calls the answer's `onAnswerLost` once, so the
   * frontend hands the words back. `onLost`: that callback, for the `send`.
   */
  private runPermissionActions(
    actions: readonly RouterAction[],
    onLost?: (cause: AnswerLostCause) => void,
  ): void {
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
          const next = this.router.answered(sessionId, requestId, response);
          const lost = response.onAnswerLost;
          const replied =
            !response.allowed &&
            response.message !== undefined &&
            normalizePermissionReply(response.message, Number.POSITIVE_INFINITY) !== null;
          const sent = next.some(
            (a) => a.kind === "send" && a.requestId === requestId && a.message !== undefined,
          );
          if (replied && !sent) {
            const unreplyable = next.some(
              (a) => a.kind === "unreplyable" && a.requestId === requestId,
            );
            lost?.(unreplyable ? "unreplyable" : "settled");
          }
          this.runPermissionActions(next, replied && sent ? lost : undefined);
        };
        this.permissions
          .request(action.request, {
            signal: controller.signal,
            ...(action.turnId !== undefined ? { turnId: action.turnId } : {}),
            ...(action.agent !== undefined ? { agent: action.agent } : {}),
          })
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
      } else if (action.kind === "unreplyable") {
        this.onError?.(
          new Error(
            `permission request ${requestId} does not take a reply (an older daemon): your reply was not sent`,
          ),
        );
      } else if (action.kind === "abort") {
        this.prompts.get(key)?.abort();
        this.prompts.delete(key);
      } else {
        // Keyed by `requestId`: an answer given while the link is down waits for
        // the session to be live again. A request answered elsewhere, or gone
        // with a recreated session, is not an error. The daemon takes a re-send
        // of the answer that already settled it (after a drop) as a success.
        const lost = action.message !== undefined ? onLost : undefined;
        this.sessionCall(
          sessionId,
          Method.ResolvePermission,
          {
            sessionId,
            requestId,
            optionId: action.optionId,
            ...(action.message !== undefined ? { message: action.message } : {}),
          },
          "keyed",
        )
          .then(() => undefined)
          .catch((error: unknown) => {
            // The decision stays silent; only the person's words come back.
            lost?.(answerLostCause(error));
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
