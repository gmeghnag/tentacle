/**
 * The type surface `App` exposes (docs/feat/app-decomposition.md, slice S1): the
 * session contract the TUI drives, the props it takes, and the host feeds it
 * subscribes to. `App.tsx` and `index.ts` both name this list HERE, so adding a
 * controller method is one edit in one file — never an edit to the render tree.
 */
import type { Agent } from "@tentacle/agent";
import type { AttachmentRef, JobController, PermissionBroker } from "@tentacle/core";
import type { JobOutputResult, JobRow } from "@tentacle/protocol";
import type { AttachMode } from "./attach-draft.ts";
import type { FileProbe } from "./attach-files.ts";
import type { BackgroundAgentRow } from "./background-view.ts";
import type { LinkFeed } from "./link-status.ts";
import type { McpServerView } from "./mcp-panel.ts";
import type { AutoAcceptFeed } from "./permission-ui.ts";
import type { DaemonQueue, QueuedMessage, ReturnedCause } from "./queued.ts";
import type { SessionsView } from "./sessions-panel.ts";
import type { SessionSkillsView } from "./skills-sync.ts";
import type { DisplayItem, SessionEvent } from "./state.ts";
import type { ContextOpen } from "./status-view.ts";
import type { SubagentNotifyView } from "./subagent-notify.ts";
import type { TargetBadge } from "./target-view.ts";
import type { SessionActivity } from "./turn-feed.ts";

/**
 * The conversation the App drives. Both the local agent `Session` and the
 * remote `RemoteSession` satisfy it, so the TUI renders a local or remote
 * session identically.
 */
/** One `/settings` line: blue notice text, and a hint drawn grey after it. */
export interface SettingsNoticeLine {
  readonly text: string;
  readonly hint?: string;
}

export interface SessionController {
  /**
   * A remote session also yields the reconnect events (`history_reset`,
   * `user_message`). `opts.skill`: the user activates that skill (`/name`).
   */
  send(
    prompt: string,
    signal?: AbortSignal,
    opts?: { readonly skill?: string; readonly attachments?: readonly AttachmentRef[] },
  ): AsyncIterable<SessionEvent>;
  /**
   * Attach one image to this session and resolve its ref
   * (docs/feat/attachments-tui.md D5): the SESSION does it (only it can await a
   * lazy open), so `App` never needs a daemon id. Rejects with a typed error
   * (`ImagesUnavailableError`, `RangeError`, an upload failure) — never a
   * silent drop. Optional: absent (the in-process fallback) → images are off,
   * with the reason `NO_IMAGE_SEAM` gives.
   */
  attachImage?(
    bytes: Uint8Array,
    meta: { readonly mimeType: string; readonly name?: string },
    opts?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (sent: number, size: number) => void;
    },
  ): Promise<AttachmentRef>;
  /** What this session may do with an image right now (structurally `ImageInput`); present with `attachImage`. */
  imageInput?(): AttachMode;
  /** Compact the conversation (summarise + replace history); optional. */
  compact?(signal?: AbortSignal): Promise<{ before: number; after: number }>;
  /**
   * `/clear` (docs/feat/clear-keeps-jobs.md): reset the conversation inside the
   * session; background jobs and sub-agents keep running. Optional: absent on
   * the in-process fallback, where `/clear` closes the session and starts a new one.
   */
  clear?(): Promise<{ before: number; after: number }>;
  /**
   * The open a RESET needs (`/clear`, `/compact`) on a session whose
   * conversation lives only daemon-side under an id nothing has opened yet
   * (a resumed one, or an attach whose dial is in flight). Awaited by the
   * caller BEFORE it arms its own bookkeeping: the open can attach a live
   * session, and the attach snapshot would read that bookkeeping as another
   * device's (review M1/M2, docs/fix/clear-silent-noop.md). Optional: the
   * reset methods open themselves where this is absent.
   */
  openForReset?(): Promise<void>;
  /**
   * `/settings` (docs/feat/session-settings-apply.md): the session's settings
   * vs this terminal's, as lines the host built. Optional: absent where this
   * terminal carries no settings (the worker, `connect`).
   */
  settings?(): readonly SettingsNoticeLine[];
  /** `/settings sync`: the outcome as lines (never rejects). Present with `settings`. */
  updateSettings?(): Promise<readonly SettingsNoticeLine[]>;
  /**
   * Queue a message mid-turn (steering); optional. Local is sync, remote a
   * Promise. `id`: the TUI's key for the text, which a `sendNow` cites.
   */
  enqueue?(text: string, id?: string): void | Promise<void>;
  /**
   * Send the queued messages now (`Ctrl+X Ctrl+S`, docs/feat/send-now-c.md):
   * cancel the running turn and start one whose prompt is `messages`, in one
   * daemon step. Resolves with the new turn's events (a `user_message` with
   * the prompt the daemon sent; none for a continuation); rejects on a
   * refusal, and the events reject `Cancelled` if it never started. Optional:
   * without it the TUI stops the turn, then sends.
   */
  sendNow?(
    messages: readonly QueuedMessage[],
    target: "turn" | "compaction",
    signal?: AbortSignal,
  ): Promise<AsyncIterable<SessionEvent>>;
  /** End the session (its background jobs included) — `/clear` replaces it; optional. */
  close?(): void;
  /**
   * The session's skills read again from disk (docs/feat/skills-hot-reload.md):
   * the `/name` list and the `/skills` listing, as the daemon will judge a
   * `/name` now. Every runtime implements it; absent (a bare test session) →
   * no skills.
   */
  skills?(): Promise<SessionSkillsView>;
  /**
   * The context size the daemon counts at open (docs/feat/tui-target-badge.md):
   * exact where the provider can count without generating, else an estimate.
   * Asked once per session the view follows; a rejection leaves `ctx –/max`.
   */
  context?(): Promise<ContextOpen>;
  /**
   * Rename the session daemon-side (`/rename`); resolves with the title the
   * daemon stored. Optional: absent where no daemon owns the session.
   */
  rename?(title: string): Promise<string>;
  /**
   * Subscribe to MY queued rows coming back from the daemon (a turn left them
   * undrained, docs/feat/queued-broadcast.md): each row once, with my own
   * text. Never re-sent. Optional: absent where no daemon reports the queue.
   * Returns an unsubscribe.
   */
  onReturned?(
    listener: (
      rows: readonly {
        readonly id: string;
        readonly text: string;
        readonly cause: ReturnedCause;
      }[],
    ) => void,
  ): () => void;
  /**
   * Subscribe to what the session does that this TUI did not start: a turn of
   * another device (rendered like an own one), a history the daemon replaced
   * the screen with, the session ending elsewhere (docs/feat/tui-foreign-turns.md).
   * Activities raised before it are handed over on subscribe. Optional: absent
   * where nobody else can drive the session. Returns an unsubscribe.
   */
  watch?(listener: (activity: SessionActivity) => void): () => void;
  /** Attach to an existing session eagerly (its history, then live); a no-op for a fresh one. */
  open?(): Promise<void>;
  /** `turnId` is one of my own turns (auto-accept answers only those). */
  ownsTurn?(turnId: string): boolean;
  /**
   * Auto-accept's own test, when it is WIDER than `ownsTurn`: an own turn or —
   * on a trusted `serve` daemon that wakes on its own — the session's own wake
   * turn (docs/fix/autoaccept-wake-turns.md A5). Absent → `ownsTurn` decides.
   */
  autoAcceptsTurn?(turnId: string): boolean;
  /** Subscribe to the daemon's queue (every writer's waiting rows); returns an unsubscribe. */
  onQueued?(listener: (state: DaemonQueue) => void): () => void;
  /** Subscribe to this session's background sub-agents (the live list, bounded);
   * returns an unsubscribe (docs/feat/subagent-background-ui.md).
   */
  onSubagents?(listener: (rows: readonly BackgroundAgentRow[]) => void): () => void;
  /**
   * Subscribe to a RUNNING background child's messages to this session's agent
   * (bounded); a notice is a moment, never a backlog. Returns an unsubscribe
   * (docs/feat/agent-message-two-way.md).
   */
  onSubagentNotify?(listener: (notify: SubagentNotifyView) => void): () => void;
  /**
   * Write the user's text into a RUNNING background child
   * (`session/subagent_message`, docs/feat/subagent-panel.md). A refusal is a
   * typed result, never a throw. Optional: absent where the mode has no
   * background sub-agents, and the dock refuses instead of guessing.
   */
  messageSubagent?(agentId: string, text: string): Promise<{ ok: boolean; reason?: string }>;
  /** Stop one background child (`session/agent_kill`); `{killed: false}` if it was not running. */
  killSubagent?(agentId: string): Promise<{ killed: boolean }>;
  /**
   * Subscribe to this session's running background SHELL jobs as the daemon
   * reports them (bounded by the client; `count` is the daemon's own number).
   * The current list, if any, is given at once. Optional: absent on an older
   * daemon, and the dock shows no job rows rather than guessing
   * (docs/feat/shell-jobs-panel.md).
   */
  onJobs?(
    listener: (report: { readonly rows: readonly JobRow[]; readonly count: number }) => void,
  ): (() => void) | undefined;
  /**
   * Read one background shell job's output tail (`session/job_output`). The
   * result is bounded and sanitized by the client; a refusal is `{found: false,
   * reason}`, never a throw. Optional: absent on an older daemon.
   */
  jobOutput?(
    jobId: string,
    opts?: { readonly lines?: number; readonly maxChars?: number },
  ): Promise<JobOutputResult>;
  /** Stop one background SHELL job (`session/job_kill`); `{killed: false}` if it was not running. */
  killJob?(jobId: string): Promise<{ killed: boolean }>;

  /**
   * Subscribe to the USER's own messages to this session's background children
   * (bounded by the client), never given a backlog: a notice is a moment.
   * Returns an unsubscribe (docs/feat/subagent-panel.md).
   */
  onSubagentMessage?(
    listener: (notice: {
      readonly agentId: string;
      readonly text: string;
      readonly n?: number;
    }) => void,
  ): () => void;
  /**
   * Stop following the session WITHOUT ending it — it runs on for any device
   * (`/sessions` switches away with it). Rejects when the daemon cannot (an
   * older one): nothing changed. Optional: absent where nobody else can reach it.
   */
  detach?(): Promise<void>;
  /** The session's id, an opaque key (the `/sessions` row it is, never parsed). */
  readonly sessionId?: string | null;
  /** How many of my queued rows stay on the daemon if this view leaves the session now. */
  stayingRows?(): number;
}

/**
 * The daemon's sessions, for `/sessions` (`connect` only,
 * docs/feat/connect-sessions.md): one list page, a NEW attach-only controller
 * for a chosen id (the App watches, then opens it), and delete.
 */
export interface SessionDirectory {
  list(): Promise<SessionsView>;
  open(id: string, reopen: boolean): SessionController;
  remove(id: string): Promise<void>;
}

/**
 * Out-of-band notices from the host (e.g. "couldn't save the session"), shown
 * as a system line even while idle. Returns the unsubscribe function.
 */
export interface NoticeFeed {
  onNotice(listener: (text: string, hint?: string) => void): () => void;
}

/**
 * A detached run's TUI (docs/fix/detach-live.md A2): `/quit` closes the
 * session for every TUI on it. The host counts the others and acts after Ink
 * unmounted; the App only reports what the user chose and what happened.
 */
export interface RunQuit {
  /** Other live TUIs on this same session (laptop presence). */
  othersOnSession(): number;
  /** The user confirmed: this TUI's quit closes the session for all. */
  closeForAll(): void;
  /** Another TUI closed the session: this one leaves, nothing to save or delete. */
  closedElsewhere(reason: "closed" | "deleted" | "gone"): void;
}

export interface AppProps {
  /** A local agent; used to build sessions unless `createSession` is given. */
  readonly agent?: Agent;
  /** Factory for a session (local or remote). Overrides `agent` when present. */
  readonly createSession?: () => SessionController;
  readonly model: string;
  /**
   * What to PAINT as the model's name when it differs from `model` (a `connect`
   * session's daemon runs its own model: docs/fix/connect-model-error-drops-connection.md
   * round 2). Presentation only — every semantic use still reads `model`, so
   * `model === "remote"` keeps meaning "the model is the daemon's".
   */
  readonly modelLabel?: string;
  readonly cwd: string;
  readonly contextWindow?: number;
  /** In a container/pod: the status bar's accent badge (laptop-side facts). Absent: local. */
  readonly target?: TargetBadge;
  /** Broker whose interactive requester this app installs for tool approvals. */
  readonly permissions?: PermissionBroker;
  /** Background-job registry; the TUI surfaces job exits live when present. */
  readonly jobs?: JobController;
  /**
   * TEST ONLY: how often an open job drawer re-reads its output. The App's real
   * cadence is `JOB_REFRESH_MS` (≤ 1/s); a frame test shortens it so an exact
   * read count is provable without waiting a second (AGENTS §9, M4). Nothing
   * else reads it, and no production caller passes it.
   */
  readonly jobRefreshMs?: number;
  /**
   * Auto-wake: when a background job exits while idle, start a continuation turn
   * so the agent reacts to it without a user prompt. Default: true.
   */
  readonly autoWakeOnJobExit?: boolean;
  /**
   * `subagents.twoWay`: a running background child may message this agent, and
   * its message may wake it (docs/feat/agent-message-two-way.md). False → a
   * notice is still shown, nothing is armed. Default: false.
   */
  readonly subagentsTwoWay?: boolean;
  /** A detached run's relay handed over a job's exit no turn has flushed (docs/fix/detached-autowake.md). */
  readonly wakePending?: boolean;
  /** The wake was HANDED OVER by a relay (it owns it): a refused continuation is retried once. wakePending alone (the open reported unflushed exits) is never retried: another TUI may serve it. */
  readonly wakeHanded?: boolean;
  /** Host notices to surface live (never a raw terminal write while Ink owns it). */
  readonly notices?: NoticeFeed;
  /** The runtime's link status, shown in the StatusBar while it is not up. */
  readonly link?: LinkFeed;
  /** The daemon's MCP servers, probed live (`/mcp`). Absent → `/mcp` says it's unavailable. */
  readonly mcpStatus?: () => Promise<readonly McpServerView[]>;
  /** Injectable for tests (defaults to the OS clipboard + Bun.write). */
  readonly clipboard?: (text: string) => Promise<void>;
  /** Injectable for tests (defaults to the OS clipboard read). */
  readonly paste?: () => Promise<string>;
  /**
   * The file-system seam an attachment is decided from
   * (docs/feat/attachments-tui.md D8). Injectable for tests; the default reads
   * the real disk.
   */
  readonly fileProbe?: FileProbe;
  /** The user's home directory, for `~` expansion in a pasted/`/attach` path. */
  readonly home?: string;
  /**
   * The LAPTOP's working directory, which a relative `/attach` path resolves
   * against. Never `cwd`: under `connect` that prop is the daemon's URL (P15),
   * while the bytes are always this machine's.
   */
  readonly localCwd?: string;
  readonly saveFile?: (path: string, content: string) => Promise<void>;
  /** Transcript to seed on start (a resumed session); replaces the welcome line. */
  readonly initialItems?: readonly DisplayItem[];
  /**
   * `run "<prompt>"`: sent ONCE at mount as the first message, through the same
   * `run` as a typed one — raw text, never a `/command`. A `/clear` or a
   * re-render never sends it again (docs/feat/run-prompt.md).
   */
  readonly initialPrompt?: string;
  /**
   * The daemon runs in a pod (`run`/`attach`, set only by `runEngineTui`): a
   * spilled result's file is "saved in the pod to" its path. A fact of the
   * runtime the laptop started, never guessed (docs/feat/tui-spill-note.md).
   */
  readonly daemonInPod?: boolean;
  /**
   * Quitting only detaches (`connect`): the daemon keeps the session and any
   * running turn, so `/exit` leaves at once even mid-turn. Default false (the
   * worker and pods stop the turn first: their daemon dies with them).
   */
  readonly detachOnQuit?: boolean;
  /** The daemon's sessions (`/sessions`). Absent → "isn't available on this runtime". */
  readonly sessions?: SessionDirectory;
  /** A detached run's TUI: `/quit` closes the session for all, `closed` leaves. */
  readonly runQuit?: RunQuit;
  /** A detached run's TUI: auto-accept is its session's, shared by its TUIs (B3). */
  readonly autoAccept?: AutoAcceptFeed;
  /**
   * The width to render at, overriding the terminal's (`ink-testing-library`
   * reports 100). Never set by a runtime: it exists so a frame test can pin a
   * tier (the dock's 100/80/56, docs/feat/subagent-panel.md).
   */
  readonly columns?: number;
}
