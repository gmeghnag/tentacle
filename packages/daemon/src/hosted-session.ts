import { createHash } from "node:crypto";
import { redactText } from "@tentacle/agent";
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
 * `history_commit` markers, at turn end, and at a history replacement (new
 * epoch): a compaction, or a context reset inside a turn, whose cut names that
 * turn — and the snapshot is SLICED to `length`, so a cut that lags behind the
 * history is still exact: what was pushed after it is replayed, never doubled
 * or lost. Sound because the history is append-only past any cut within an
 * epoch (the agent's one `pop` is never behind a marker; a replacement starts
 * a new epoch).
 */
import type {
  Agent,
  AgentEvent,
  AskHooksTrust,
  BeforeRun,
  CapabilityOp,
  Session,
  SessionCapabilities,
  SessionGrants,
} from "@tentacle/agent";
import { EMPTY_TITLE, NO_CAPABILITIES, applyCapabilityOp, sessionTitle } from "@tentacle/agent";
import {
  AGENT_MESSAGE_MAX_CHARS,
  type AgentJob,
  AgentJobLedger,
  type AgentJobs,
  type ChatMessage,
  DISMISSED,
  type JobController,
  type ModelProvider,
  NOTE_KIND,
  type PermissionBroker,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
  SCHEDULE_ID_PREFIX,
  type ScheduleCreateResult,
  type ScheduleLimits,
  type ScheduleLink,
  type ScheduleRequest,
  type ScheduledJob,
  type SubagentBackgroundBody,
  type SubagentEndBody,
  anySignal,
  attachmentLabel,
  checkAttachmentRefs,
  daemonWakeGate,
  formatBytes,
  scheduleCheckDelayMs,
  scheduleCreate,
  scheduleDelete,
  schedulePromptText,
  scheduleSettled,
  scheduleStep,
  wakeDue,
} from "@tentacle/core";
import {
  type AttachmentRef,
  BLOCKING_UPDATE_TYPES,
  type HistoryCut,
  type JobOutputResult,
  type JobRow,
  JsonRpcErrorCode,
  type KnownLogEntry,
  type KnownSessionUpdateParams,
  LOG_PAGE_MAX_CHARS,
  type LogCursor,
  type LogResult,
  MAX_DISABLED_CAPABILITIES,
  MAX_SESSION_TITLE,
  type PermissionOutcome,
  type PermissionRequestUpdate,
  type PromptContentBlock,
  type PromptResult,
  type QueueState,
  type QueuedEntry,
  type ReturnedEntry,
  SCHEDULE_LABEL_MAX,
  type ScheduleDeleteResult,
  type ScheduleRow,
  type SendNowMessage,
  type SendNowRefusal,
  type SendNowTarget,
  type SessionCapabilitiesWire,
  type SessionContextResult,
  type SessionSettingsReport,
  type SessionSkillsResult,
  type SessionTitle,
  type SessionUpdate,
  type SetAutoAcceptResult,
  type SetCapabilityResult,
  type Sha256,
  type SnapshotResult,
  type SubagentRow,
  type TurnEnd,
  type TurnError,
  type VoiceTurn,
  WAKE_TURN_PREFIX,
  type WatchCategory,
  type WatchNextResult,
  type WatchResult,
  clientSupportsUpdate,
  watchAccepts,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import { AttachmentStore, UploadBudget } from "./attachment-store.ts";
import type { ModelLink } from "./connection.ts";
import { jobRows, sameJobs } from "./jobs-view.ts";
import {
  contentToText,
  eventToUpdate,
  frameFor,
  splitPrompt,
  stopReasonToProtocol,
  toSessionSkills,
  toUpdateParams,
  toWireCapabilities,
  wireLine,
} from "./mapping.ts";
import { outcomeToResponse, toPermissionRequestUpdate } from "./permission-map.ts";
import {
  type ClearForkCapture,
  type DaemonLogCapture,
  type DaemonSessionState,
  type PendingPermission,
  type PersistedTurnKey,
  type ResumedTurn,
  classifyPending,
  closeFailedTurn,
} from "./persisted-session.ts";
import type { PushAttached } from "./push-rules.ts";
import { EMPTY_QUEUE, leftovers, queueView, returnCause, sameState } from "./queue-view.ts";
import { SessionRing } from "./ring.ts";
import {
  sameScheduleRows,
  scheduleEndOf,
  scheduleRows,
  scheduleSeqSeed,
} from "./schedules-view.ts";
import { forkableMessages } from "./session-fork.ts";
import type { ImagePolicy, WorkloadShellsLike } from "./session-host.ts";
import type { SessionSummary } from "./session-list.ts";
import { type LogBase, SessionLog, replayFromBase } from "./session-log.ts";
import type { SessionPersister } from "./session-persister.ts";
import type { SessionLiveness } from "./session-reaper.ts";
import {
  TITLE_TIMEOUT_MS,
  type TitleState,
  applyGenerated,
  applyRename,
  cleanTitle,
  renameText,
  shouldGenerate,
  titleInput,
  titleRequest,
  titleText,
} from "./session-title.ts";
import { SettledAnswers } from "./settled-answers.ts";
import { sameRows, subagentRows } from "./subagents-view.ts";
import { SessionWatchers } from "./watchers.ts";

/**
 * How long a burst of a child's progress waits for one frame: at most four
 * frames a second for the list, while a start and an end publish at once.
 */
export const SUBAGENTS_COALESCE_MS = 250;

const nodeSha256: Sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The session's `session/log` (docs/feat/session-log.md). `base`: the client's
 * head for the messages it seeded (`open{logBase}`, a create only) — numbering,
 * it grants nothing. `reason`: why this incarnation's first segment starts
 * (default `create`; a reload is always `reload`). `verify` (tests, D1): told
 * after every derivation the log's replay and the committed prefix it must equal.
 */
export interface SessionLogOptions {
  readonly base?: LogBase;
  readonly reason?: "create" | "seed";
  readonly sha256?: Sha256;
  readonly verify?: (replayed: readonly ChatMessage[], committed: readonly ChatMessage[]) => void;
}

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
  /**
   * Its client declared `hop` (D8/D9): it can put a `move_session` proposal to its
   * owner. Read from the attachment that CREATED the session, so the tool is
   * offered to exactly the sessions whose client has a prompt to raise.
   */
  readonly hop?: true;
  /**
   * Its connection, when that connection serves the model (the pod
   * reverse-tunnel): the session's model calls may go through it (`modelLink`).
   */
  readonly model?: ModelLink;
  /**
   * Its client's declared device label (`ClientInfo.host`, docs/feat/
   * session-auto-accept.md D7): stamped into each ask's `askedOn`, so a sibling
   * asks one list. Display only; an absent label simply omits that attachment.
   */
  readonly host?: string;
  /**
   * The device this client is, when the connection authenticated one
   * (`ConnectionPrincipal.kind === "device"`). Set by `Connection` from its own
   * principal — the socket's key already decided it (AGENTS §7, nothing here
   * decides access). Absent for a token client, a pairing connection and the
   * in-process worker.
   *
   * Push reads it for ONE thing: a device attached to this session is showing
   * the sheet, so it is not pushed to (docs/feat/mobile-push.md Design 1).
   */
  readonly deviceId?: string;
}

/** A permission request waiting for its first answer (keyed by its nonce). */
interface PendingAsk {
  /** The request as it was streamed: what a fresh watcher's `state.pending` repeats. */
  readonly update: PermissionRequestUpdate;
  readonly offered: ReadonlySet<string>;
  /**
   * The options a reply may come with (the `reject_*` kinds), when the ask
   * offered `reply`; empty otherwise (docs/feat/permission-reply.md).
   */
  readonly replyable: ReadonlySet<string>;
  /**
   * What the record says of it while it is unanswered (`turn.pending`). `null`:
   * a BACKGROUND child's ask — never on disk (the child is lost on a reload).
   */
  readonly record: PendingPermission | null;
  /**
   * A background child's ask: the request, offered again at every attach and
   * right after every `history_replaced`, because the parent keeps committing
   * (the cut moves past it) and a barrier withdraws what nothing re-offers.
   */
  readonly reoffer?: PermissionRequestUpdate;
  /** Streamed to the clients yet (only once its record is durable). */
  shown: boolean;
  /**
   * Resolve the gate's wait with this outcome (detaches the abort listener);
   * `reason`: nobody could answer (the gate tells the model why); `message`:
   * the person's reply with a refusal.
   */
  readonly settle: (outcome: PermissionOutcome, reason?: string, message?: string) => void;
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
  /** The queue as of the cut: the last `queued` state emitted (seq <= `seq`). */
  readonly queued: QueueState;
  /** The background sub-agents as of the cut: the last `subagents` list emitted. */
  readonly subagents: readonly SubagentRow[];
  /** The running background SHELL jobs as of the cut: the last `jobs` list emitted. */
  readonly jobs: readonly JobRow[];
  /** The scheduled wakes as of the cut: the last `schedules` list emitted (docs/feat/cron-tool.md D5). */
  readonly schedules: readonly ScheduleRow[];
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
  /**
   * The session's auto-accept at the restart (`DaemonSessionRecord.autoAccept`):
   * a restart KEEPS it (owner Q3 — the same live session, and with owner Q1
   * nothing is answered until a device attaches). Absent → off.
   */
  readonly autoAccept?: boolean;
  /**
   * The scheduled wakes at the restart or the reopen (`DaemonSessionRecord.schedules`,
   * docs/feat/cron-tool.md D6): re-armed at once, so an overdue one fires ONCE
   * at the first idle check (catch-up, D3). Absent → none.
   */
  readonly schedules?: readonly ScheduledJob[];
  /**
   * The session's MCP/skill switches at the restart, from its log's last
   * `capabilities` entry (`DaemonSessionRecord.capabilities`,
   * docs/feat/session-capabilities.md S3b). Absent → everything on.
   */
  readonly capabilities?: SessionCapabilities;
  /**
   * The record's installed head (`DaemonSessionRecord.head`: its index in the
   * reloaded history): the summary again, cut short or not. Absent: none.
   */
  readonly head?: number;
  /** The record's title (absent = `auto`). */
  readonly title?: TitleState;
  /** The rows the record kept for their writer (absent = none). */
  readonly returned?: readonly ReturnedEntry[];
  /**
   * The log entry the record paired with and the log's projection there
   * (`DaemonSessionRecord.logHead` / `logged`): the new incarnation's log
   * CONTINUES that lineage — its `base{reload}` restates exactly `logged`
   * (`prev` = `head`), and the reload's repair follows as ordinary entries
   * (docs/feat/session-log-serve-store.md §5). Absent (an unpaired record):
   * a new lineage, from the reloaded history.
   */
  readonly log?: { readonly head: LogCursor; readonly logged: readonly ChatMessage[] };
}

/**
 * The session's title generation (docs/feat/session-titles.md). `model`: the
 * provider that answers the title request (absent → never generated: the
 * title stays `auto` unless renamed). `seed`: the title of a session created
 * by `open{title}`. `timeoutMs`: the request's bound (default `TITLE_TIMEOUT_MS`).
 */
export interface SessionTitling {
  readonly model?: ModelProvider;
  readonly seed?: TitleState;
  readonly timeoutMs?: number;
}

/**
 * `serve` only: the session writes itself at every committed boundary (see
 * `SessionPersister`). Absent on a pod daemon and the in-process worker — no
 * persister, no write, structurally.
 */
export interface SessionPersistence {
  readonly persister: SessionPersister;
  readonly restored?: RestoredSessionState;
  /** `/clear` hands the chat it drops here, to be kept as its own archived session (docs/feat/clear-fork-history.md). */
  readonly keepFork?: (sourceId: string, capture: ClearForkCapture) => void;
}

/**
 * `serve` only (docs/feat/serve-autowake.md): the session starts a
 * continuation turn by itself when a background job exits — idle, after a
 * normal end, attached clients or not: the daemon is the ONLY waker (a client
 * watches the wake turn live and may cancel it). Present = on (the `serve`
 * host's own `autoWake`); absent on a pod daemon and the in-process worker —
 * structurally off (there a TUI or the relay wakes).
 */
export interface SessionWake {
  /** One line per wake started (the session id only — never a job's command). */
  readonly onAudit?: (line: string) => void;
}

/**
 * `serve` and the in-process worker only (docs/feat/cron-tool.md D1): the
 * session keeps the agent's scheduled wakes and fires each through `prompt()`
 * under a `wake-` id when it is due and the slot is free. Present = on; absent
 * on a pod daemon — no table, no link, so its factory never offers the tools
 * (a pod must not decide when turns start on the laptop's model key, AGENTS §7).
 */
export interface SessionSchedules {
  /** One line per fire and per job the session drops on its own (ids only — never a prompt). */
  readonly onAudit?: (line: string) => void;
  /**
   * The HOST's own create limits (its `schedules.*` config, never carried —
   * docs/feat/cron-tool.md D3, owner Q6). Absent = `DEFAULT_SCHEDULE_LIMITS`.
   */
  readonly limits?: ScheduleLimits;
  /** The ONE timer's clock (tests inject it; default the globals). */
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** `unref`'d: a schedule never keeps a process alive on its own (the worker quits with its TUI). */
const defaultSetTimeout = (fn: () => void, ms: number): unknown => {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
};
const defaultClearTimeout = (handle: unknown): void =>
  clearTimeout(handle as ReturnType<typeof setTimeout>);

/**
 * The updates a push observer is given: exactly the four whose timing the push
 * rules decide on (docs/feat/mobile-push.md Design 1). Nothing else reaches it —
 * a `token`/`subagent_message`/`history_replaced` is not a notification.
 */
type UpdateOf<K extends SessionUpdate["type"]> = Extract<SessionUpdate, { type: K }>;
export type PushWatchedUpdate =
  | UpdateOf<"permission_request">
  | UpdateOf<"permission_resolved">
  | UpdateOf<"turn_end">
  | UpdateOf<"session_closed">
  // Task 18's Live Activity needs three more (docs/feat/mobile-live-activity.md
  // L7): a turn's start (the elapsed timer's origin and the 20 s threshold), each
  // tool call (the current tool), and the title. Still display-class kinds only:
  // a `tool_call_update` (high frequency, and its result rides `tool_call`) is
  // deliberately NOT watched.
  | UpdateOf<"turn_start">
  | UpdateOf<"tool_call">
  | UpdateOf<"session_title">;

/**
 * What a push observer is told, when (`PushEvent` in `push-rules.ts` is the
 * shell's own form of exactly these facts).
 *
 * `update` is the session event itself (one of the four above); `attachment`
 * says only "the attached set changed" — a client attached or detached. That
 * second case exists because the exclusion is read at the push DEADLINE: a
 * phone locked mid-grace detaches, and without this event it would still count
 * as showing the sheet (F17). It carries no ask and pushes nothing itself.
 */
export type PushHookEvent =
  | { readonly type: "update"; readonly update: PushWatchedUpdate }
  | { readonly type: "attachment" };

/**
 * `serve` only (docs/feat/mobile-push.md Design 5, slice P7): an OBSERVER of a
 * session's events, for push notifications.
 *
 * Deliberately NOT an `Attachment`, and that is the whole design:
 * `attachments.size` drives `blockingUnsupported`/`recheckAsks` (a pending ask
 * is denied when no attached client can show it), the idle reaper,
 * `session/list`'s `attached` and `modelLink`. An observer registered there
 * would make the daemon believe a client is watching — it would both silence
 * the turn-end push it exists to send and deny asks nobody is holding
 * (AGENTS §7 one session path; `watchers.ts` keeps followers apart for the same
 * reason). It answers nothing, records nothing, and cannot become a model link.
 *
 * Synchronous and O(1), called from inside `emit` and inside the steering
 * no-await window (`finishTurn`): the implementation must defer its own I/O.
 * A throw is caught and reported, never thrown into the turn (F24).
 */
export interface SessionPushObserver {
  onPushEvent(sessionId: string, event: PushHookEvent, attached: PushAttached): void;
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

/** The most of a failed turn's message the wire carries (it may be an upstream body). */
export const TURN_ERROR_MAX = 400;

/** A state from outside (a client's seed, a reloaded log entry): sorted and de-duplicated, like every applied op. */
function normalizeCapabilities(state: SessionCapabilities): SessionCapabilities {
  const norm = (names: readonly string[]) => [...new Set(names)].sort();
  return { disabledMcp: norm(state.disabledMcp), disabledSkills: norm(state.disabledSkills) };
}

/** Something is turned off (else the state is the default, and the log says nothing). */
function hasDisabled(state: SessionCapabilities): boolean {
  return state.disabledMcp.length > 0 || state.disabledSkills.length > 0;
}

/** One line: every whitespace run and control character becomes a single space, and
 * the bidi/zero-width controls that could reorder or hide what follows are dropped. */
function oneLineText(text: string): string {
  let out = "";
  let space = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // Whitespace, C0 controls and DEL: one space between the visible runs.
    if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      space = true;
      continue;
    }
    // Zero-width and bidi controls (overrides that reorder a transcript): gone.
    if (
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      continue;
    }
    if (space && out !== "") {
      out += " ";
    }
    space = false;
    out += char;
  }
  return out;
}

/**
 * A failed turn's message, safe to put on the wire to a TRUSTED client (the
 * in-process worker, and `serve` — whose host is the user's own, AGENTS §7).
 * Never raw: one line (no control or bidi characters, no embedded frames), the
 * secret shapes a provider message can echo masked (`redactText`), and capped.
 */
export function sanitizeTurnError(error: unknown): TurnError {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactText(oneLineText(raw));
  if (message === "") {
    return { message: "internal error" };
  }
  return {
    message: message.length > TURN_ERROR_MAX ? `${message.slice(0, TURN_ERROR_MAX - 1)}…` : message,
  };
}

/** The wire form of a turn failure: same policy as the peer's handler errors. */
export function redactTurnError(error: unknown, expose: boolean): TurnError {
  if (error instanceof RpcError) {
    return { code: error.code, message: error.message };
  }
  if (expose) {
    return sanitizeTurnError(error);
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
  /**
   * This session's image store (`attachment/put`, docs/feat/attachments-upload.md):
   * the bytes behind the refs its history names, and sub-task 2b's
   * `AttachmentSource`. It lives with the SESSION, not a connection, so a
   * detached-then-reattached client resumes where it stopped.
   */
  readonly uploads: AttachmentStore;
  /** What the factory did with `session/open.settings`; told to whoever attaches. */
  settingsReport: SessionSettingsReport | undefined;
  /**
   * What this daemon does with image prompts (`SessionHost.build` sets it, like
   * `settingsReport`). Unset = off, so a `HostedSession` built by hand refuses
   * images exactly as a daemon with no policy does.
   */
  imagesPolicy: ImagePolicy | undefined;
  /** The session's approvals (the factory's), handed to the next agent on a settings sync. */
  grants: SessionGrants | undefined;
  /**
   * The session's shells (docs/feat/workload-shell.md D4), when this build
   * offered `workload_shell`. Disposed at the session's END, beside `jobs` —
   * this is the "no leftovers" site: the remote shell and its children go, and
   * nothing is left in the workload.
   */
  workloadShells: WorkloadShellsLike | undefined = undefined;
  /**
   * The client that CREATED this session declared `hop` (D8/D9): it can put a
   * `move_session` proposal to its owner, so this session's agent may be offered
   * the tool — and a settings sync must keep that (`updateSettings` reads it).
   */
  hop = false;
  /**
   * The session's auto-accept (docs/feat/session-auto-accept.md D3): the state
   * every attached client follows, so the switch is the SESSION's and a
   * terminal's Shift+Tab or the phone's sheet switch changes it for everyone.
   * The daemon HOLDS and broadcasts it; it never answers an ask with it (owner
   * Q1: each attached device decides, through its own broker's requester).
   * Off at creation unless `session/open{autoAccept}` seeded it.
   */
  autoAccept = false;
  /**
   * The session's MCP/skill switches (docs/feat/session-capabilities.md): what
   * the model is NOT offered. Held here, not only on the agent, because a
   * settings sync builds a fresh agent (everything on) and `swapAgent`
   * re-applies it. Everything on at creation unless `session/open{capabilities}`
   * seeded it (`seedCapabilities`).
   */
  private caps: SessionCapabilities = NO_CAPABILITIES;
  private readonly session: Session;
  /** The factory's broker: its requester is this session's (installed once, below). */
  private readonly permissions: PermissionBroker;
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
   * The agent's steering queue, mirrored in order with each text's enqueue id
   * (a resumed turn's restored steer: its record's id, or one minted at the
   * reload for an older record — nobody's). Shifted on every `steer` the turn
   * streams (one per drained text); emptied at a turn's end unless a live
   * send-now carries it over (`finishTurn`). The ONE source of the queue: the
   * agent's own leftover after a turn is never read (docs/feat/queued-broadcast.md).
   */
  private queue: QueuedEntry[] = [];
  /**
   * Rows a turn left undrained, back with their writer (oldest first): they
   * leave only by a `reclaim` or a send-now that carries them. Persisted.
   */
  private returned: ReturnedEntry[] = [];
  /** The last `queued` state emitted (or the initial one): what the cut records. */
  private lastQueued: QueueState = EMPTY_QUEUE;
  /** The last `subagents` list emitted (or the initial empty one): what the cut records. */
  private lastSubagents: readonly SubagentRow[] = [];
  /** The last `jobs` list emitted (or the initial empty one): what the cut records. */
  private lastJobs: readonly JobRow[] = [];
  /** A coalescing frame is due (`kickSubagents`): one timer at a time. */
  private subagentsKick: ReturnType<typeof setTimeout> | null = null;
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
  /**
   * A resumed turn's pending entries from the record, each until its call is
   * asked again (an ask for the same call replaces it) or answered without a
   * re-ask (all cleared at the next commit, a context reset, the turn's end).
   */
  private carried: readonly PendingPermission[] = [];
  /**
   * The calls of a group that may have started (`beforeRun`, R2): written
   * before any of them runs, cleared where `carried` is — at the group's ONE
   * commit, a context reset, the turn's end
   * (docs/feat/round-groups-persistence.md). Absent: calls run one at a time.
   */
  private inFlight: readonly string[] | undefined;
  /**
   * Every unanswered ask, by `requestId`, in request order — with `carried`,
   * the one truth of what is pending (persisted with the turn,
   * `pendingList`). One at a time today: calls run in order.
   */
  private readonly asks = new Map<string, PendingAsk>();
  /** The answers that settled recent asks: an identical re-send is a success. */
  private readonly answered = new SettledAnswers();
  private readonly persister: SessionPersister | null;
  private readonly keepFork: ((sourceId: string, capture: ClearForkCapture) => void) | null;
  private readonly createdAt: number;
  private seq = 0;
  private readonly ring: SessionRing<KnownSessionUpdateParams>;
  /**
   * This session's read-only followers (`tentacle logs -f`, docs/feat/logs-cmd.md):
   * NEVER an `Attachment` — not in `attachments`, never a model link, never
   * counted by `attached`, never offered an ask to answer (see `watchers.ts`).
   */
  private readonly watchers: SessionWatchers;
  /** Seq of the barrier that opened the current epoch (0 for the first). */
  private epochStart = 0;
  private cut: Cut;
  /** Insertion-ordered: the last one is the most recently attached. */
  private readonly attachments = new Set<Attachment>();
  private closed = false;
  /**
   * The `history_repaired` notice was already sent for this loaded session
   * (docs/feat/history-validity-invariant.md, Part C): once per session, in
   * memory — persisting it would change the sidecar format for a notice.
   */
  private historyRepairNoticed = false;
  private readonly jobs: JobController | undefined;
  /**
   * The push observer (docs/feat/mobile-push.md P7), absent everywhere but a
   * `serve` with push on. It is NOT an attachment: see `SessionPushObserver`.
   * Set by `SessionHost.build` after construction, like `imagesPolicy` — the
   * session is not reachable (hence not attachable) until `build` returns.
   */
  pushObserver: SessionPushObserver | undefined = undefined;
  private readonly unsubscribeExit: (() => void) | undefined;
  private readonly unsubscribeStart: (() => void) | undefined;
  /**
   * The background sub-agent runtime (controllers + the cap), carried across a
   * settings sync. The DURABLE half is `agentJobs` (the ledger), below.
   */
  private readonly agentRuntime: AgentJobs | undefined;
  private readonly unsubscribeAgentExit: (() => void) | undefined;
  /** The `AgentJobs.onNotify` subscription (a child's message to the agent); removed in `close`. */
  private readonly unsubscribeAgentNotify: (() => void) | undefined;
  /** The `AgentJobs.onChange` subscription (the live list); removed in `close`. */
  private readonly unsubscribeAgentRows: (() => void) | undefined;
  /** Background child id → the turn that spawned it (its ask names it on the wire). */
  private readonly spawnTurns = new Map<string, string>();
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
  /** The title, one truth (`session-title.ts`). */
  private title: TitleState;
  /** Replaced with the agent by a settings sync (`autoTitle` is the laptop's to toggle). */
  private titleModel: ModelProvider | undefined;
  private readonly titleTimeoutMs: number;
  /** The title request in flight; aborted by whatever takes the slot (never in the user's way). */
  private titleJob: AbortController | null = null;
  /** A title request scheduled at a turn's end (after the steering window), not started yet. */
  private titleKick: ReturnType<typeof setTimeout> | null = null;
  /** Failed title requests in this incarnation (an abort by the slot is not one). */
  private titleFailures = 0;
  /** The autonomous wake (`SessionWake`); absent = never. */
  private readonly wake: SessionWake | undefined;
  /**
   * A wake check scheduled (a macrotask): after a turn's end — outside the
   * steering window — and after a job exit (so every agent listener, including
   * one a settings sync registered after ours, has counted it first).
   */
  private wakeKick: ReturnType<typeof setTimeout> | null = null;
  /**
   * The last turn ended `error` or `cancelled` (memory only): no wake until a
   * turn ends normally — a failing model or a user's stop ends the chain.
   */
  private lastEndBad = false;
  /**
   * The wake turn whose start has not flushed the exits yet: its start WILL
   * flush every pending one, so `unflushedExits` says 0 meanwhile (an attaching
   * client must not wake for them too).
   */
  private wakeUnflushed: string | null = null;
  /** The scheduled wakes (`SessionSchedules`); absent = this runtime never schedules. */
  private readonly scheduling: SessionSchedules | undefined;
  /**
   * The table (docs/feat/cron-tool.md D3): SESSION state, here and not on the
   * agent, so a settings sync (which rebuilds the agent) keeps it, and `/clear`
   * keeps it (owner Q7). Replaced, never mutated (the core rules return a new one).
   */
  private scheduleTable: readonly ScheduledJob[] = [];
  /** The last `sc-N` handed out: ids are never reused in a session (D2). */
  private scheduleSeq = 0;
  /** The ONE schedule timer (a check at the next slot, ≤ 60 s; 0 after a turn's end). */
  private scheduleTimer: unknown = null;
  /** The last `schedules` list emitted (or the initial one): what the cut records. */
  private lastSchedules: readonly ScheduleRow[] = [];
  /** The fired turns that have not ended, by turnId → the job that fired each (its failure budget). */
  private readonly firedTurns = new Map<string, string>();
  /** The committed history as a typed log (`session/log`), derived at the cut's own points. */
  private readonly log: SessionLog;
  private readonly logSha256: Sha256;
  private readonly logVerify: SessionLogOptions["verify"];
  /**
   * The background sub-agents' durable facts (docs/feat/subagent-ledger-log.md).
   * SESSION-level, like `jobs`: it survives a `swapAgent` (the model is not the
   * children). It is the one ledger the live path (6a) and a replay share.
   */
  private readonly agentJobs: AgentJobLedger;

  constructor(
    id: string,
    session: Session,
    permissions: PermissionBroker,
    jobs?: JobController,
    errorPolicy: TurnErrorPolicy = {},
    ringBytes: number = DEFAULT_RING_BYTES,
    now: () => number = Date.now,
    persistence?: SessionPersistence,
    titling: SessionTitling = {},
    wake?: SessionWake,
    logOptions: SessionLogOptions = {},
    agentRuntime?: AgentJobs,
    uploads: AttachmentStore = new AttachmentStore(new UploadBudget()),
    schedules?: SessionSchedules,
  ) {
    this.id = id;
    this.uploads = uploads;
    this.now = now;
    this.wake = wake;
    this.scheduling = schedules;
    const restored = persistence?.restored;
    this.persister = persistence?.persister ?? null;
    this.keepFork = persistence?.keepFork ?? null;
    this.title = restored?.title ?? titling.seed ?? { source: "auto" };
    this.titleModel = titling.model;
    this.titleTimeoutMs = titling.timeoutMs ?? TITLE_TIMEOUT_MS;
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
    // A reload lost the summary's identity: the record names it (`head`, or
    // the reload rule when none is marked, `rebuild`) — so a send-now
    // there is `NoTurnRunning`, never an unasked turn that may run tools, even
    // after a crash at a context reset's barrier.
    if (restored?.head !== undefined) {
      const head = session.messages[restored.head];
      if (head?.role === "user") {
        this.compactionSummary = head;
      }
    }
    this.session = session;
    this.permissions = permissions;
    this.jobs = jobs;
    // Seeded from the reloaded history: an id the model has already seen (a
    // `started in background as sa-N` result, a note) is never handed out again.
    this.agentJobs = AgentJobLedger.fromHistory(session.messages);
    this.errorPolicy = errorPolicy;
    this.ring = new SessionRing(ringBytes);
    this.watchers = new SessionWatchers(now);
    const resume = restored?.resume;
    this.autoAccept = restored?.autoAccept === true;
    // The switches a restart reloads (before the log's first segment, which
    // states them again: `logSegmentFacts`).
    if (restored?.capabilities !== undefined) {
      this.caps = normalizeCapabilities(restored.capabilities);
      session.currentAgent().setCapabilities(this.caps);
    }
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
      queued: EMPTY_QUEUE,
      subagents: [],
      // A session is built with an EMPTY registry (a `serve` reload starts with
      // no jobs), and every later job announces itself through `onStart`.
      jobs: [],
      schedules: [],
    };
    // The scheduled wakes a restart or a reopen brings back (D6), with the
    // counter seeded from them and the history: no id the model saw is reused.
    this.scheduleTable = restored?.schedules ?? [];
    this.scheduleSeq = scheduleSeqSeed(session.messages, this.scheduleTable);
    this.lastSchedules = scheduleRows(this.scheduleTable);
    this.cut = { ...this.cut, schedules: this.lastSchedules };
    // Re-armed at once: an overdue one fires at the first idle check (catch-up ONCE).
    this.armSchedules();
    // The log's first segment: this incarnation's history at the cut (a
    // reload's after its repair; a resumed turn is open at it).
    this.logSha256 = logOptions.sha256 ?? nodeSha256;
    this.logVerify = logOptions.verify;
    this.log = new SessionLog(crypto.randomUUID(), now);
    if (restored?.log) {
      // A reload of a paired record continues its lineage: the base restates
      // EXACTLY what the last landed write logged (a reader holding that head
      // reseeds instead of forking), then the overlay and the repair notes
      // become ordinary entries (pointer compares only).
      this.log.start(restored.log.logged, "reload", restored.log.head, resume?.turnId);
      this.log.commit(session.messages, session.messages.length);
    } else {
      this.log.start(
        session.messages,
        restored ? "reload" : (logOptions.reason ?? "create"),
        restored ? undefined : logOptions.base,
        resume?.turnId,
      );
    }
    this.logSegmentFacts();
    this.verifyLog();
    this.returned = (restored?.returned ?? []).map((r) => ({ ...r }));
    // A returned row's text is with its writer, not in the history: never
    // "delivered", so a send-now citing it sends it (a crash-cut turn's steers
    // land here on reload, docs/feat/queued-broadcast.md Q2).
    for (const r of this.returned) {
      this.restoredIds.delete(r.id);
    }
    // The agent's permission gate asks here (the factory's broker, replaced
    // synchronously before any turn can run): the turn suspends until a client
    // answers or the turn is aborted. See the module comment.
    permissions.setRequester((req, options) => this.awaitDecision(req, options));
    // A background job can exit while the session is idle (between turns), so we
    // stream the exit the moment it happens — not only at the next turn, where
    // the agent injects a note for the model. The client renders it like a local
    // job-exit notice; the TUI dedupes by job id against that next-turn event.
    this.unsubscribeExit = jobs?.onExit((job) => {
      // THE EXIT FIRST, THEN the list (fix round 1, review 3). It used to be the
      // other way round ("a row must never outlive the death it shows"), but a
      // client freezes an open drawer the moment its row leaves and takes the
      // outcome from its exit listener — so with the list first, a transport that
      // delivered the two frames in separate macrotasks (a pod's exec WebSocket
      // does) froze a CLEAN exit as `✗ stopped`, and nothing re-read it. Frames
      // are ordered, so the outcome is recorded before the row goes; a panel row
      // still cannot outlive its death, because the list that drops it is the
      // very next frame.
      this.emit({
        type: "background_exit",
        jobId: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
      });
      this.publishJobs();
      // The daemon may wake (re-checked on the macrotask).
      this.kickWake();
    });
    // A job's START is the only other moment the running set changes, so the
    // list is published there and nowhere else — never a stream, never a poll.
    this.unsubscribeStart = jobs?.onStart(() => this.publishJobs());
    // A background sub-agent: the id and the markers go through this session's
    // ledger; its exit rides `background_exit` like a shell job's, and wakes.
    this.agentRuntime = agentRuntime;
    agentRuntime?.bind({
      // The host's clock, for a row's `startedAt` (Design 2: "passed in by the
      // host"): the daemon's own `now`, so a test's clock reaches the wire.
      now: () => this.now(),
      launched: (spec) => {
        const agentId = this.backgroundAgent(spec);
        if (this.activeTurnId !== null) {
          this.spawnTurns.set(agentId, this.activeTurnId);
        }
        return agentId;
      },
      ended: (agentId, stopReason, report) => {
        this.spawnTurns.delete(agentId);
        this.agentEnded(agentId, stopReason, report);
      },
    });
    this.unsubscribeAgentExit = agentRuntime?.onExit((exit) => {
      // The list first (its row is gone), then the exit notice, then the wake.
      // `drive` already published the end through `changed()`, so no kick here:
      // a kick would only arm a timer that sends nothing.
      this.emit({
        type: "background_exit",
        jobId: exit.agentId,
        command: wireLine(exit.description, 512),
        status: exit.stopReason === "cancelled" ? "killed" : "exited",
        exitCode: null,
        agent: { stopReason: exit.stopReason, toolUses: exit.toolUses },
      });
      this.kickWake();
    });
    // A running child spoke to the agent (docs/feat/agent-message-two-way.md):
    // the laptop gets the notice, and a waking one asks for the continuation.
    // The Agent's own listener was registered at its construction — BEFORE this
    // one — so the note is already in `pendingExits` when `kickWake` reads it.
    this.unsubscribeAgentNotify = agentRuntime?.onNotify((note) => {
      this.emit({
        type: "subagent_notify",
        agentId: wireLine(note.agentId, 64),
        text: wireLine(note.text, AGENT_MESSAGE_MAX_CHARS),
        wake: note.wakes,
      });
      if (note.wakes) {
        this.kickWake();
      }
    });
    // A child's visible state changed: a start and an end publish at once, a
    // progress event coalesces (docs/feat/subagent-background-ui.md Design 3).
    this.unsubscribeAgentRows = agentRuntime?.onChange(() => this.kickSubagents()) ?? undefined;
    // A turn suspended at the restart is running again (it holds the slot)
    // BEFORE the first write below, with its steers queued and its old pending
    // entry kept: that write must still read "suspended on this call" — never
    // "idle" over a history with unanswered calls, never "in flight".
    if (resume) {
      resume.steering.forEach((text, i) => {
        // A v4 record kept the id (its writer still knows it); an older one
        // did not: minted, nobody's. Queued again, so not in the history.
        const id = resume.steeringIds?.[i] ?? crypto.randomUUID();
        session.enqueue(text);
        this.queue.push({ id, text });
        this.restoredIds.delete(id);
      });
      this.controller = new AbortController();
      this.activeTurnId = resume.turnId;
      this.turns.set(resume.turnId, {});
      this.carried = resume.pending;
    }
    // The state at the cut (seq 0): a resumed turn's steers, the reloaded
    // returned rows. Nothing is streamed for it — the snapshot carries it.
    this.lastQueued = this.queueState();
    this.cut = { ...this.cut, queued: this.lastQueued };
    // On disk from the start: a session seeded by `open{messages}` (or one
    // just reloaded and reconciled) survives a restart before its next turn.
    this.persist();
    // Last: every field is set. The call is asked again through the normal
    // requester (a new request id); no state holds the slot without a driver.
    if (resume && this.controller) {
      void this.drive(
        resume.turnId,
        // From the group's head: its calls are asked again, in order.
        session.resume(resume.from, this.controller.signal, {
          beforeRun: this.beforeRunFn,
          beforeResumedCall: (signal) => this.beforeResumedCall(signal),
        }),
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
   *
   * The call it is for comes from the requester's `options` (the gate's own
   * call, or a sub-agent's parent `agent_task` call) — never from the last
   * `tool_start`, which names the wrong call once calls overlap
   * (docs/feat/permission-call-attribution.md). Absent: `"pending"` on the
   * wire, never resumable.
   */
  private awaitDecision(
    req: PermissionRequest,
    options?: PermissionRequestOptions,
  ): Promise<PermissionResponse> {
    // A BACKGROUND child's ask outlives any turn: it has its own path.
    if (options?.agent?.id !== undefined) {
      return this.awaitBackgroundDecision(req, options, options.agent.id);
    }
    const signal = this.compacting ? undefined : this.controller?.signal;
    if (!signal || signal.aborted) {
      // No live turn to ask for: a cancel landed between `tool_start` and the
      // ask. Nobody is prompted and the tool does not run (the agent records
      // it as cancelled) — not a decision: there is no turn to approve for.
      return Promise.resolve(outcomeToResponse({ outcome: "cancelled" }));
    }
    // The ask settles at the first of: the turn's abort, or the ASKER's own
    // withdrawal (a foreground child moving to the background re-asks it as
    // `sa-N`: docs/feat/subagent-detach.md Design 3).
    const settleOn = options?.withdraw ? anySignal([signal, options.withdraw]) : signal;
    // A blocking update only to a session one of whose clients can answer it
    // (docs/feat/protocol-v10-forward-compat.md): otherwise refuse at once,
    // with the reason the model sees — never suspend on a client that cannot
    // show it. Nobody attached: unchanged (held for a client to attach).
    const unsupported = this.blockingUnsupported("permission_request");
    if (unsupported !== undefined) {
      return Promise.resolve({ allowed: false, reason: unsupported });
    }
    const requestId = crypto.randomUUID();
    const toolCallId = options?.toolCallId || undefined;
    const asked = this.askedOn();
    const update = {
      ...toPermissionRequestUpdate(requestId, toolCallId ?? "pending", req, options?.agent),
      ...(asked !== undefined ? { askedOn: asked } : {}),
    };
    // The asking call's group head (a call alone: itself), kept with the entry:
    // a reload resumes from it and never recomputes the group.
    const groupStart = toolCallId !== undefined ? options?.groupStart || undefined : undefined;
    const record: PendingPermission = {
      toolCallId: toolCallId ?? "",
      tool: req.tool,
      resumable: classifyPending(
        this.session.messages,
        toolCallId,
        options?.origin,
        req.tool,
        groupStart,
      ),
      requestedAt: this.now(),
      ...(groupStart !== undefined ? { groupStart } : {}),
    };
    const decided = this.registerAsk(requestId, update, record, settleOn);
    // The resumed call asked again: its live ask replaces the record's entry.
    if (toolCallId !== undefined) {
      this.carried = this.carried.filter((p) => p.toolCallId !== toolCallId);
    }
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
    return decided.then(async ({ outcome, reason, message }) => {
      // `settle` already took this ask out of `asks`: write the record without
      // it. And without ANY carried entry: an answered ask means the resumed
      // group has begun (its head may run now), so a record still saying
      // "resume from the group's head" would run that call twice
      // (docs/feat/round-groups-persistence.md, Review F1).
      this.carried = [];
      this.persist();
      // The turn's abort ends this wait: a hung disk must never trap a cancel
      // (docs/fix/cancel-hung-disk.md). Safe: the agent checks the abort
      // before the answer (agent.ts `runTool`), so an aborted turn never runs
      // the tool and "pending on disk ⇒ never started" still holds. The
      // asker's own WITHDRAWAL must never trap the re-ask either — but it
      // withdraws only an UNANSWERED ask: an ANSWERED one (`allow`) still runs
      // its tool, so it waits for the write that clears `turn.pending` even
      // when a steer withdraws the (already settled) ask meanwhile. Skipping
      // it there leaves the entry on disk while the tool runs, and a crash
      // reloads "pending" and runs the same call twice
      // (docs/feat/subagent-detach.md, Review M1).
      await untilAborted(this.persisted(), outcome.outcome === "cancelled" ? settleOn : signal);
      // Withdrawn by the ASKER (`options.withdraw`): nobody decided, and the
      // asker is about to ask it again itself (docs/feat/subagent-detach.md).
      if (outcome.outcome === "cancelled" && options?.withdraw?.aborted) {
        return DISMISSED;
      }
      if (reason !== undefined) {
        return { allowed: false, reason };
      }
      // A message only ever comes with a reject (`resolvePermission` checked it).
      const response = outcomeToResponse(outcome);
      return message !== undefined ? { ...response, message } : response;
    });
  }

  /**
   * Register one unanswered ask under `requestId` and return the promise its
   * first settle resolves; `signal`'s abort settles it `cancelled`. Shared by a
   * turn's ask (`awaitDecision`, with a record) and a background child's
   * (`awaitBackgroundDecision`, with none and a `reoffer`).
   */
  private registerAsk(
    requestId: string,
    update: PermissionRequestUpdate,
    record: PendingPermission | null,
    signal: AbortSignal,
    reoffer?: PermissionRequestUpdate,
  ): Promise<{ outcome: PermissionOutcome; reason?: string; message?: string }> {
    return new Promise((resolve) => {
      const onAbort = (): void => this.settle(requestId, { outcome: "cancelled" });
      this.asks.set(requestId, {
        update,
        offered: new Set(update.options.map((o) => o.optionId)),
        replyable: new Set(
          update.reply
            ? update.options.filter((o) => o.kind.startsWith("reject_")).map((o) => o.optionId)
            : [],
        ),
        record,
        ...(reoffer ? { reoffer } : {}),
        shown: false,
        settle: (outcome, reason, message) => {
          signal.removeEventListener("abort", onAbort);
          resolve({
            outcome,
            ...(reason !== undefined ? { reason } : {}),
            ...(message !== undefined ? { message } : {}),
          });
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * A background child's ask (docs/feat/subagent-background.md, H3). It is held
   * APART from every turn: it settles with the CHILD's signal (never a turn's
   * Esc), is shown whether or not a turn runs, names the spawning turn on the
   * wire, and writes nothing — no `turn.pending`, never `carried`, `inFlight`
   * or `compacting` (the child is lost on a reload, so a record would only
   * make a reload run a call twice). Offered again at every attach and after
   * every barrier (`reofferBackgroundAsks`).
   */
  private awaitBackgroundDecision(
    req: PermissionRequest,
    options: PermissionRequestOptions,
    agentId: string,
  ): Promise<PermissionResponse> {
    const signal = options.signal;
    if (this.closed || !signal || signal.aborted) {
      return Promise.resolve(outcomeToResponse({ outcome: "cancelled" }));
    }
    const unsupported = this.blockingUnsupported("permission_request");
    if (unsupported !== undefined) {
      return Promise.resolve({ allowed: false, reason: unsupported });
    }
    const requestId = crypto.randomUUID();
    const spawnTurn = this.spawnTurns.get(agentId);
    const asked = this.askedOn();
    const update: PermissionRequestUpdate = {
      ...toPermissionRequestUpdate(requestId, options.toolCallId || "pending", req, options.agent),
      ...(spawnTurn !== undefined ? { turnId: spawnTurn } : {}),
      ...(asked !== undefined ? { askedOn: asked } : {}),
    };
    const decided = this.registerAsk(requestId, update, null, signal, update);
    const ask = this.asks.get(requestId);
    if (ask) {
      ask.shown = true;
    }
    try {
      this.emit(update);
    } catch (error) {
      this.reportTurnError(error);
    }
    return decided.then(({ outcome, reason, message }) => {
      if (reason !== undefined) {
        return { allowed: false, reason };
      }
      const response = outcomeToResponse(outcome);
      return message !== undefined ? { ...response, message } : response;
    });
  }

  /**
   * Emit each pending background ask again (same `requestId`, a new `seq`): the
   * parent keeps committing, so a fresh attach's replay from the cut would no
   * longer reach the first one, and a barrier's snapshot keeps only the
   * requests the replay re-offers. The router dedupes by id.
   */
  private reofferBackgroundAsks(): void {
    for (const ask of [...this.asks.values()]) {
      if (ask.reoffer !== undefined && ask.shown) {
        try {
          this.emit(ask.reoffer);
        } catch (error) {
          this.reportTurnError(error);
        }
      }
    }
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
   * The device labels an ask is raised to (docs/feat/session-auto-accept.md D7):
   * the `ClientInfo.host` of every attachment whose client declared it can show
   * an ask. The SAME list goes to every recipient (it rides the replay ring
   * unchanged, P2), so a device can say what else is being asked. Undefined when
   * nobody named a host — an older client, or a pod-side one, which never sends
   * one.
   */
  private askedOn(): string[] | undefined {
    const labels: string[] = [];
    for (const attachment of this.attachments) {
      if (attachment.host === undefined) continue;
      // Only a client that can actually be shown this ask is a sibling it would
      // be raised to; an older one takes the fallback and is never asked.
      if (!clientSupportsUpdate(attachment.updates, "permission_request")) continue;
      if (!labels.includes(attachment.host)) labels.push(attachment.host);
    }
    return labels.length === 0 ? undefined : labels;
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
   * answer is never a denial. So is a `message` (the person's reply,
   * docs/feat/permission-reply.md) with an option that is not a `reject_*`
   * one, or for an ask that did not offer `reply`. The SAME answer as the one
   * that settled it (a `keyed` re-send after a link drop) is a success with no
   * effect (`SettledAnswers`); a different one is `PermissionNotPending`.
   */
  resolvePermission(requestId: string, optionId: string, message?: string): void {
    const ask = this.asks.get(requestId);
    if (!ask) {
      if (this.answered.isRepeat(requestId, { optionId, message })) {
        return;
      }
      throw new RpcError(DomainErrorCode.PermissionNotPending, "permission request not pending");
    }
    if (!ask.offered.has(optionId)) {
      throw new RpcError(JsonRpcErrorCode.InvalidParams, "option not offered for this request");
    }
    if (message !== undefined && !ask.replyable.has(optionId)) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidParams,
        "a reply comes only with a refusal of a request that offered one",
      );
    }
    this.answered.remember(requestId, { optionId, message });
    this.settle(requestId, { outcome: "selected", optionId }, undefined, message);
  }

  /**
   * First-wins: the first caller removes the entry; any later one finds none.
   * `permission_resolved` goes out BEFORE the gate is woken, so its seq
   * precedes everything the tool's execution streams.
   */
  private settle(
    requestId: string,
    outcome: PermissionOutcome,
    reason?: string,
    message?: string,
  ): void {
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
      // The text never rides `permission_resolved`: only the gate gets it.
      ask.settle(outcome, reason, message);
    }
  }

  /** Hand the persister this session's state as of NOW (a no-op without one, or once closed). */
  private persist(): void {
    this.pinAutoTitle();
    if (this.persister && !this.closed) {
      this.persister.schedule(this.id, (after) => this.persistedState(after));
    }
  }

  /**
   * Name the session NOW, if it is still derived (`auto`, with no text) and its
   * first real user message is in the history.
   *
   * An `auto` title is derived from the history's first user message
   * (`sessionTitle`), and a compaction (or the model's own context reset)
   * REPLACES that message with the summary / restart text it installs — so
   * every later derivation named the session after the summary, in `/sessions`
   * and every list (docs/fix/connect-functest-batch.md item C). Pinning the
   * derived name at the first save keeps the session's own name for good; a
   * model- or user-chosen title still wins (`applyGenerated` / `applyRename`),
   * and `/clear` drops the pin (a fresh chat names itself).
   */
  private pinAutoTitle(): void {
    if (this.title.source !== "auto" || this.title.text !== undefined) {
      return;
    }
    const text = sessionTitle(this.session.messages);
    if (text === EMPTY_TITLE) {
      return; // nothing the person wrote yet: derive again next time
    }
    this.title = { source: "auto", text };
  }

  /**
   * Resolves once everything this session wrote so far is on disk (or failed,
   * which the persister reports). Immediate without a persister. Never awaited
   * in the steering window (only mid-round, inside the gate, and by `enqueue`).
   */
  persisted(): Promise<void> {
    return this.persister ? this.persister.flush(this.id) : Promise.resolve();
  }

  /** What is pending now, in request order: the resumed turn's carried entries, then each live ask. */
  private pendingList(): PendingPermission[] {
    const live = [...this.asks.values()].flatMap((ask) => (ask.record ? [ask.record] : []));
    return [...this.carried, ...live];
  }

  /** `RunOptions.beforeRun` for this session's turns (one function: passed to every send/resume). */
  private readonly beforeRunFn: BeforeRun = (ids, signal) => this.beforeRun(ids, signal);

  /**
   * A group of calls is about to run (R2, docs/feat/round-groups-persistence.md):
   * its ids go on disk as `turn.inFlight` BEFORE any of them starts, so a
   * reload labels each one "Interrupted" and never "Not run". Awaited by the
   * agent, never by `drive` (the steering window stays await-free); a cancel
   * ends the wait at once (a hung disk never traps it — the agent re-checks
   * the abort before running). Resolves whether the set landed: `false` on a
   * failed write, a cancel, or a closed session. No persister (pods, the
   * worker), or one that never writes this session (a blocked file, an unsafe
   * id): nothing to make durable, `true` at once.
   */
  private async beforeRun(ids: readonly string[], signal: AbortSignal): Promise<boolean> {
    if (this.closed || signal.aborted) {
      return false;
    }
    this.inFlight = [...ids];
    if (!this.persister || !this.persister.writable(this.id)) {
      return true;
    }
    const landed = this.persister.write(this.id, (after) => this.persistedState(after));
    await untilAborted(landed, signal);
    return signal.aborted ? false : landed;
  }

  /**
   * A call of the resumed round passed the gate and is about to run
   * (docs/fix/resumed-call-pending.md). A carried entry still set means no ask
   * settled for it (F1 clears them there): the gate allowed it WITHOUT one — a
   * hook `force: "allow"`, a permission now `none`. Drop every carried entry
   * and wait for that write, so "pending on disk ⇒ never started" holds: a
   * reload closes the turn ("Interrupted") instead of running the call again.
   * Nothing carried (an ask settled, a later call): immediate, no write. As
   * after an ask, a failed write is reported by the persister and the call
   * runs anyway; a cancel ends the wait at once (the agent re-checks it).
   */
  private async beforeResumedCall(signal: AbortSignal): Promise<void> {
    if (this.carried.length === 0) {
      return;
    }
    this.carried = [];
    this.persist();
    await untilAborted(this.persisted(), signal);
  }

  /**
   * The state a record captures, copied now (the arrays are live) — with its
   * log part: references to the entries derived after `after` (the
   * persister's cursor; absent: from the last `base`) and the log's
   * projection, nothing materialized or hashed here (docs/feat/session-log-serve-store.md
   * §2: this runs inside the steering window). `withLog: false` → none.
   */
  private persistedState(after?: LogCursor, withLog = true): DaemonSessionState {
    const turns: PersistedTurnKey[] = [];
    for (const [turnId, entry] of this.turns) {
      turns.push(entry.end ? { turnId, end: entry.end } : { turnId });
    }
    const turnId = this.compacting ? null : this.activeTurnId;
    const pending = this.pendingList();
    const inFlight = this.inFlight;
    // By identity, like `awaitsAnswer`: gone from the history → not marked.
    const head =
      this.compactionSummary === undefined
        ? -1
        : this.session.messages.indexOf(this.compactionSummary);
    return {
      id: this.id,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      lastChangeAt: this.lastChangeAt,
      messages: [...this.session.messages],
      turns,
      enqueueIds: [...this.enqueued],
      title: this.title,
      returned: this.returned.map((r) => ({ ...r })),
      ...(head >= 0 ? { head } : {}),
      autoAccept: this.autoAccept,
      // The table as of NOW (D6): written only when non-empty (the sidecar's v3).
      ...(this.scheduleTable.length > 0 ? { schedules: [...this.scheduleTable] } : {}),
      ...(withLog ? { log: this.logCapture(after) } : {}),
      // From the mirror (= the agent's queue in every stretch, the module's
      // load-bearing assumption), so texts and ids never disagree.
      ...(turnId !== null
        ? {
            turn: {
              turnId,
              steering: this.queue.map((r) => r.text),
              steeringIds: this.queue.map((r) => r.id),
              ...(pending.length > 0 ? { pending } : {}),
              ...(inFlight !== undefined ? { inFlight: [...inFlight] } : {}),
            },
          }
        : {}),
    };
  }

  /** The log's part of a capture: O(Δ) slot references + the projection (no wire form built). */
  private logCapture(after: LogCursor | undefined): DaemonLogCapture {
    const { slots, head, rebased } = this.log.since(after);
    const log = this.log;
    const sha256 = this.logSha256;
    return {
      entries: () => slots.map((slot) => log.materialize(slot, sha256)),
      head,
      rebased,
      logged: log.projection,
    };
  }

  /** The queue as every client sees it now (`queue-view.ts`). */
  private queueState(): QueueState {
    return queueView({
      turnRunning: this.activeTurnId !== null && !this.compacting,
      queue: this.queue,
      successor: this.successorView(),
      isDelivered: (id) => this.isDelivered(id),
      returned: this.returned,
    });
  }

  /** The reserved send-now as the queue sees it: a close ends it unstarted, like a cancel. */
  private successorView(): Successor | null {
    const next = this.successor;
    return next && this.closed ? { ...next, cancelled: true } : next;
  }

  /**
   * Stream the queue if it changed since the last `queued` (full state; a
   * retried enqueue or an unchanged view sends nothing). Called LAST by every
   * stretch that changes it — synchronous, never awaited: it runs inside the
   * steering window. Never throws (a sink error is reported, as `emit`'s).
   */
  /**
   * The model id the session's MAIN agent runs on right now, when this daemon can
   * know it: a child's row shows its own model only when it differs, so the
   * comparison must read the CURRENT agent, not the one the child started under
   * (docs/feat/subagent-panel.md, Review round 3 M2). `undefined` over the pod
   * model tunnel — the laptop's model id stays there (AGENTS §7).
   */
  private mainModelId(): string | undefined {
    return this.session.currentAgent().mainModelId;
  }

  private publishQueue(): void {
    const state = this.queueState();
    if (sameState(state, this.lastQueued)) {
      return;
    }
    this.lastQueued = state;
    try {
      this.emit({ type: "queued", ...state });
    } catch (error) {
      this.reportTurnError(error);
    }
  }

  /**
   * Note that a child's visible state changed. A START or an END (the set of ids
   * differs from what clients have) publishes at once: the list's truth must
   * never lag a spawn or a death. A progress event coalesces within one window
   * (a burst of labels is not 100 frames). One timer at a time; cleared by `close`.
   */
  private kickSubagents(): void {
    if (this.closed) {
      return;
    }
    const rows = subagentRows(this.agentRuntime?.rows() ?? [], this.mainModelId());
    const structural =
      rows.length !== this.lastSubagents.length ||
      rows.some((row, i) => row.id !== this.lastSubagents[i]?.id);
    if (structural) {
      if (this.subagentsKick !== null) {
        clearTimeout(this.subagentsKick);
        this.subagentsKick = null;
      }
      this.publishSubagents(rows);
      return;
    }
    if (this.subagentsKick !== null) {
      return;
    }
    this.subagentsKick = setTimeout(() => {
      this.subagentsKick = null;
      // `publishSubagents` reports its OWN failures (the sink); the idle
      // `recordCut` behind it does not, and a throw in a timer escapes as an
      // uncaught error (Bun exits on one). Report it like any turn error.
      try {
        this.publishSubagents();
      } catch (error) {
        this.reportTurnError(error);
      }
    }, SUBAGENTS_COALESCE_MS);
  }

  /**
   * Stream the live list if it changed since the last `subagents` (full state;
   * an unchanged list sends nothing). Never throws (a sink error is reported,
   * as `emit`'s). Idle: the cut then moves to "now", so the ring's pin follows
   * the frame instead of holding a whole burst until the next commit.
   */
  private publishSubagents(
    rows = subagentRows(this.agentRuntime?.rows() ?? [], this.mainModelId()),
  ): void {
    if (sameRows(rows, this.lastSubagents)) {
      return;
    }
    this.lastSubagents = rows;
    try {
      this.emit({ type: "subagents", agents: [...rows] });
    } catch (error) {
      this.reportTurnError(error);
    }
    // Idle: nothing is being committed, so the frame is safe to pin AND to let
    // go of. Mid-turn the pin stays at the last commit (the turn's own rule).
    if (this.controller === null) {
      this.recordCut(null);
    }
  }

  /**
   * Stream the running-jobs list if it changed since the last `jobs` frame
   * (full state; an unchanged list sends nothing). Called ONLY on a start and
   * on an exit, so no coalescing timer is needed or wanted. Never throws (a
   * sink error is reported, as `emit`'s). Idle: the cut then moves to "now",
   * like `publishSubagents`.
   */
  private publishJobs(): void {
    // A closing session disposes the registry, whose kills fire `onExit`:
    // those must not frame a session that is going away.
    if (this.closed) {
      return;
    }
    const rows = jobRows(this.jobs?.list() ?? []);
    if (sameJobs(rows, this.lastJobs)) {
      return;
    }
    this.lastJobs = rows;
    try {
      this.emit({ type: "jobs", jobs: [...rows] });
    } catch (error) {
      this.reportTurnError(error);
    }
    if (this.controller === null) {
      this.recordCut(null);
    }
  }

  /**
   * `session/reclaim`: the writer took these returned rows back (they are in
   * its input now). Unknown or already gone → ignored (a retry is a no-op).
   * Synchronous, like `enqueue`; on disk (a capture), then streamed.
   */
  reclaim(ids: readonly string[]): void {
    const gone = new Set(ids);
    const kept = this.returned.filter((r) => !gone.has(r.id));
    if (kept.length === this.returned.length) {
      return;
    }
    this.returned = kept;
    this.persist();
    this.publishQueue();
  }

  /** A turn or a compaction is active. */
  get running(): boolean {
    return this.controller !== null;
  }

  /** The current cut (what a first snapshot page returns as `since`). */
  get historyCut(): HistoryCut {
    return { epoch: this.cut.epoch, seq: this.cut.seq };
  }

  /**
   * Background-job exits no turn has flushed yet (`session/open`'s
   * `unflushedExits`) — 0 while this daemon's own wake turn is about to flush
   * them (its start does, by construction): one wake per exit, never two.
   */
  get unflushedExits(): number {
    if (this.wakeUnflushed !== null && this.wakeUnflushed === this.activeTurnId) {
      return 0;
    }
    return this.session.pendingExitCount;
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
      title: titleText(this.title, this.session.messages),
      cwd,
      archived: false,
      // Shell jobs and background sub-agents (docs/feat/subagent-background.md).
      jobs:
        (this.jobs?.list().filter((job) => job.status === "running").length ?? 0) +
        (this.agentRuntime?.list().length ?? 0),
      // A count, only where the session schedules (docs/feat/cron-tool.md D5).
      ...(this.scheduling ? { schedules: this.scheduleTable.length } : {}),
    };
  }

  /** What the reaper decides on (rules in `session-reaper.ts`). */
  liveness(): SessionLiveness {
    return {
      id: this.id,
      attached: this.attachments.size,
      // A running background sub-agent keeps the session busy (shell jobs do not:
      // a forgotten dev server is what the TTL frees). docs/feat/subagent-background.md H2.
      // An ARMED scheduled wake too (owner Q5, docs/feat/cron-tool.md D7): a daily
      // reminder must not be archived after a day of silence. Bounded by its
      // 7-day expiry; the admin cap still applies (it ignores `busy`).
      busy:
        this.running ||
        (this.agentRuntime?.list().length ?? 0) > 0 ||
        (this.scheduling !== undefined && this.scheduleTable.length > 0),
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
      // A device that left is no longer showing the sheet. The push rules read
      // the attached set at their DEADLINE, so a phone locked mid-grace must be
      // reported as detached, or the ask is never pushed (F17). One place for
      // every removal path (`detach`, and the fan-out's own throw cleanup).
      this.offerPushAttachment();
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
    // A pending background ask goes out again BEFORE the replay is computed, so
    // its frame is in it (the cut may have moved past the first one).
    this.reofferBackgroundAsks();
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
    // AFTER the set moved (and after `recheckAsks`, which may settle an ask):
    // the push rules read the attached set at their deadline, so they must know
    // a device attached (F17's inverse).
    this.offerPushAttachment();
    return { resync: covered === undefined || !("replay" in covered), epoch: this.cut.epoch };
  }

  /**
   * Where this session's next model call goes: the most recently attached
   * client that serves the model (a re-attach moves a client to "most recent",
   * so the newest owner takes new calls — the hand-over), or `null` when none
   * is attached. Looked up per call, never cached.
   */
  modelLink(): ModelLink | null {
    let link: ModelLink | null = null;
    for (const attachment of this.attachments) {
      if (attachment.model) {
        link = attachment.model;
      }
    }
    return link;
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
      ...(cursor === undefined ? { title: this.wireTitle() } : {}),
      // As of the cut, like the history: later changes are in the replay.
      ...(cursor === undefined ? { queued: cut.queued } : {}),
      ...(cursor === undefined ? { subagents: [...cut.subagents] } : {}),
      ...(cursor === undefined ? { jobs: [...cut.jobs] } : {}),
      // Only where the session schedules (a pod daemon sends none, D5).
      ...(cursor === undefined && this.scheduling ? { schedules: [...cut.schedules] } : {}),
    };
  }

  /** The title as the wire carries it: one line, never empty (as `session/list` shows it). */
  private wireTitle(): SessionTitle {
    const text = wireLine(titleText(this.title, this.session.messages), MAX_SESSION_TITLE);
    return { text: text || "(empty)", source: this.title.source };
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
    const oldLength = this.cut.length;
    this.cut = {
      epoch: this.cut.epoch,
      seq: this.seq,
      length: this.session.messages.length,
      turnId,
      queued: this.lastQueued,
      subagents: this.lastSubagents,
      jobs: this.lastJobs,
      schedules: this.lastSchedules,
    };
    this.ring.evict(this.seq);
    // The committed prefix moved: its changes join the log (pointer compares only).
    this.log.commit(this.session.messages, this.cut.length);
    // A committed note CLOSES its sub-agent (docs/feat/subagent-ledger-log.md):
    // delivery is structural, whoever pushed it. Synchronous and O(new ones).
    for (let i = oldLength; i < this.cut.length; i++) {
      const note = this.session.messages[i]?.note;
      if (note !== undefined) {
        this.agentJobs.noteSeen(note);
      }
    }
    this.log.title(this.wireTitle());
    this.verifyLog();
  }

  /**
   * The markers a segment start carries (L1, docs/feat/subagent-ledger-log.md):
   * the title, then one entry per open sub-agent (`running` → its `bg`;
   * ended-undelivered → `bg` + `end{report}`), so a compaction or a context
   * reset never loses the fact that a child exists — the summary may drop the
   * `started in background as sa-N` tool result. An EMPTY ledger is exactly the
   * old behaviour (the title alone).
   */
  private logSegmentFacts(): void {
    this.log.title(this.wireTitle());
    // The switches too, when something is off (docs/feat/session-capabilities.md
    // F12): a segment is self-contained even when the older ones are dropped.
    // Everything on logs nothing — the fold's default.
    if (hasDisabled(this.caps)) {
      this.log.capabilities(this.caps);
    }
    for (const fact of this.agentJobs.segmentFacts()) {
      if ("stopReason" in fact) {
        this.log.subagentEnd(fact);
      } else {
        this.log.subagentBackground(fact);
      }
    }
  }

  /**
   * 6a's seam: a child started in the background. Returns its id (`sa-N`) for
   * the tool result; the marker is logged at once (synchronously, no `await`),
   * and the next persist makes it durable. The counter is seeded from the
   * history, so an id the model has seen is never handed out again.
   */
  backgroundAgent(job: {
    readonly callId: string;
    readonly agentType: string;
    readonly description: string;
  }): string {
    const agentId = this.agentJobs.nextId();
    const body: SubagentBackgroundBody | null = this.agentJobs.background({
      agentId,
      callId: job.callId,
      agentType: job.agentType,
      description: job.description,
    });
    if (body !== null) {
      this.log.subagentBackground(body);
      this.verifyLog();
      // Durable NOW (a `schedule`: captured synchronously, never awaited — the
      // steering window, as `agentEnded`): a crash before the tool result
      // commits must not lose the fact the child exists (review M2, FM 1).
      this.persist();
    }
    return agentId;
  }

  /**
   * 6a's seam: a background child ended. The `end` (with its capped report) is
   * logged and PERSISTED NOW — a child may end while the session is idle, and
   * the work product must reach disk without a turn (as `setTitle` does). A
   * `null` from the ledger (a duplicate or late end) logs nothing: first wins.
   */
  agentEnded(agentId: string, stopReason: string, report?: string): void {
    const body: SubagentEndBody | null = this.agentJobs.end(agentId, stopReason, report);
    if (body === null) {
      return;
    }
    this.log.subagentEnd(body);
    this.verifyLog();
    // A child's end is the moment the session may become idle (`SessionLiveness`'s
    // rule: the stamp is taken when something that keeps it in use ENDS).
    this.lastActiveAt = this.now();
    this.persist();
  }

  /** The background sub-agents still running (6a's liveness, the quit count, `/clear`'s hand-over). */
  agentJobsRunning(): readonly AgentJob[] {
    return this.agentJobs.running();
  }

  /**
   * `session/subagent_message` (docs/feat/subagent-panel.md): the USER's text
   * into a running background child — the same seam the model's `agent_control`
   * tool uses (`AgentJobs.message`), so the child drains it at its next
   * boundary. Synchronous end to end and never throwing, so it holds no lock
   * and runs concurrently with a `session/prompt` (AGENTS §7).
   *
   * On acceptance: the parent's `[user → sa-N]` note is queued (the next turn
   * reads it; it wakes nobody) and ONE `subagent_message` update goes to every
   * attached client, the sender's included — one render path, no local echo, so
   * two TUIs on the session stay consistent. A refusal notes and emits nothing.
   */
  messageSubagent(agentId: string, text: string): { ok: boolean; reason?: string } {
    const runtime = this.agentRuntime;
    if (runtime === undefined) {
      return {
        ok: false,
        reason: "background sub-agents are not available in this mode: nothing was sent.",
      };
    }
    const result = runtime.message(agentId, text, "user");
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    // The note the parent's agent reads at its next turn (never a wake).
    this.session.noteUserToSubagent(agentId, text);
    try {
      // `n`: this message's place among the user's messages to this child, so a
      // client can say `✓ read` once its row's `userRead` reaches it
      // (docs/fix/autoaccept-wake-turns.md, part B).
      this.emit({ type: "subagent_message", agentId, text, n: result.index });
    } catch (error) {
      this.reportTurnError(error);
    }
    // Idle: nothing is being committed, so the frame is safe to pin AND to let
    // go of (the same rule as `publishSubagents`).
    if (this.controller === null) {
      this.recordCut(null);
    }
    return { ok: true };
  }

  /**
   * `session/agent_kill` (docs/feat/subagent-panel.md): the user stops one
   * background child — the same decision the model's `agent_control{action:"kill"}` makes
   * (`AgentJobs.kill`). Synchronous; the exit, its note and the list's next
   * update all follow the EXISTING path.
   */
  killSubagent(agentId: string): { killed: boolean } {
    return { killed: this.agentRuntime?.kill(agentId) ?? false };
  }

  /**
   * `session/job_output` (docs/feat/shell-jobs-panel.md): the tail of one
   * background shell job — a UI's read, never the model's: `JobController.tail`
   * is cursor-free by construction, so a chatty job's panel read cannot starve
   * the model's next `shell_output`. Synchronous, lock-free, never throws: a
   * registry without `tail` answers a typed `found: false` (never a guess).
   * Sizes are bounded here (capacity); trust is the CLIENT's (`boundJobOutput`):
   * a pod's bytes are untrusted (§7).
   */
  jobOutput(
    jobId: string,
    opts?: { readonly lines?: number; readonly maxChars?: number },
  ): JobOutputResult {
    const tail = this.jobs?.tail?.(jobId, opts);
    if (!tail) {
      return {
        found: false,
        jobId,
        reason: "this session cannot show a job's output here",
      };
    }
    return {
      found: true,
      jobId,
      status: tail.job.status,
      // Omitted, never null: while running there is no code, and a signal kill
      // has none either (`status` says `killed`).
      ...(tail.job.exitCode === null ? {} : { exitCode: tail.job.exitCode }),
      startedAt: tail.job.startedAt,
      command: wireLine(tail.job.command, 512),
      // Owner A (fix round 1): ONE array in ARRIVAL order — stdout and stderr as
      // the process interleaved them, exactly the stream the model's
      // `shell_output` reads. `tail` applies ONE `lines` budget to it, so a
      // stderr-heavy job can no longer push its stdout out of the window (which
      // is what two per-stream reads then concatenated did). Raw: the client
      // sanitises.
      output: [...tail.output],
      truncated: tail.truncated,
    };
  }

  /**
   * `session/job_kill` (docs/feat/shell-jobs-panel.md): the user stops one
   * background SHELL job — the same decision the model's `shell_kill` tool
   * makes (`JobController.kill`). Laptop-originated (the user's `ctrl+x` then `ctrl+x`),
   * and it acts only on THIS daemon's own registry: no laptop effect, no
   * lasting approval (§7). Synchronous; the exit, its `background_exit` and the
   * list's next frame all follow the existing path.
   */
  jobKill(jobId: string): { killed: boolean } {
    return { killed: this.jobs?.kill(jobId) ?? false };
  }

  /**
   * `session/log`: one page of the committed log after `after` (see
   * `SessionLog.read`). Synchronous, served from derived entries only — never
   * from the live history — so it is exact at any microtask (AGENTS §7: the
   * peer dispatches requests concurrently; no lock here).
   */
  logRead(after?: LogCursor, maxChars: number = LOG_PAGE_MAX_CHARS): LogResult {
    return this.log.read(after, maxChars, this.logSha256);
  }

  /**
   * `session/watch` (docs/feat/logs-cmd.md sub-task 2): start a READ-ONLY
   * follower. Attaches nothing, opens nothing, revives nothing — an id that is
   * not live is refused by the caller's lookup. The state it answers is the
   * turn running now and every ask already pending, FILTERED by `only`, so a
   * follower that arrives mid-turn never misses the ask it waits for.
   */
  watch(only?: readonly WatchCategory[]): WatchResult {
    const pending = [...this.asks.values()]
      .map((ask) => ask.update)
      .filter((update) => watchAccepts(only, update));
    const watchId = this.watchers.open(only);
    return {
      watchId,
      state: {
        running: this.running,
        ...(this.activeTurnId !== null ? { turnId: this.activeTurnId } : {}),
        pending,
      },
    };
  }

  /**
   * `session/watch_next`: one batch, held until something arrives or the hold
   * times out (no lock, no await chain on the peer — AGENTS §7).
   */
  watchNext(watchId: string, timeoutMs?: number): Promise<WatchNextResult> {
    return this.watchers.next(watchId, timeoutMs).then((batch) => ({
      updates: batch.updates,
      lost: batch.lost,
      ...(batch.ended !== undefined ? { ended: batch.ended } : {}),
    }));
  }

  /** `session/unwatch`, idempotent. */
  unwatch(watchId: string): void {
    this.watchers.close(watchId);
  }

  /** D1 (tests): the log's replay equals the committed prefix, after every derivation. */
  private verifyLog(): void {
    if (this.logVerify === undefined) {
      return;
    }
    const all: KnownLogEntry[] = [];
    let after: LogCursor | undefined;
    for (;;) {
      const page = this.log.read(after, LOG_PAGE_MAX_CHARS, this.logSha256);
      all.push(...(page.entries as KnownLogEntry[]));
      const last = page.entries.at(-1);
      if (!page.more || last === undefined) break;
      after = { seq: last.seq, id: last.id };
    }
    this.logVerify(replayFromBase(all), this.session.messages.slice(0, this.cut.length));
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
    // The watchers AFTER the attachment loop, and synchronous (each one is an
    // O(1) enqueue, never an await): a follower can neither reorder nor delay a
    // client's stream, and a watcher's bug is dropped by `offer` itself.
    this.watchers.offer(params);
    // The push observer LAST, for the same reason, and only for the four
    // updates a notification is about (docs/feat/mobile-push.md Design 5).
    this.offerPush(update);
  }

  /**
   * Hand one update to the push observer, if this daemon has one (a `serve`
   * only) and it is one of the four the rules decide on. O(1) and synchronous,
   * so `turn_end` stays inside the steering no-await window; a throw is
   * reported, never thrown into the turn or at the other clients (F24).
   */
  private offerPush(update: SessionUpdate): void {
    const observer = this.pushObserver;
    if (observer === undefined) {
      return;
    }
    if (
      update.type !== "permission_request" &&
      update.type !== "permission_resolved" &&
      update.type !== "turn_end" &&
      update.type !== "session_closed" &&
      // Task 18 (L7): the Live Activity's three extra kinds. Widening this filter
      // is the WHOLE daemon change this task makes here — the observer stays out
      // of `attachments`, stays synchronous, and is still never awaited.
      update.type !== "turn_start" &&
      update.type !== "tool_call" &&
      update.type !== "session_title"
    ) {
      return;
    }
    try {
      observer.onPushEvent(this.id, { type: "update", update }, this.pushAttached());
    } catch (error) {
      this.reportTurnError(error);
    }
  }

  /**
   * The attached set as a push rule reads it: how many clients of ANY kind are
   * watching (a TUI silences a turn-end push too), and which DEVICES among them
   * (those show the sheet already, so they are not pushed to). Read live, so a
   * detach mid-grace is seen at the deadline (F17).
   */
  private pushAttached(): PushAttached {
    const devices: string[] = [];
    for (const attachment of this.attachments) {
      if (attachment.deviceId !== undefined) {
        devices.push(attachment.deviceId);
      }
    }
    return { clients: this.attachments.size, devices };
  }

  /**
   * Tell the push observer that the attached set changed (an attach or a
   * detach). The rules need it as its OWN event: they exclude the devices
   * attached at the deadline, not the ones attached at the last ask, so a phone
   * locked during the grace must be pushed to (F17, fix round 1). Same
   * contract as `offerPush`: synchronous, O(1), a throw is reported.
   */
  private offerPushAttachment(): void {
    const observer = this.pushObserver;
    if (observer === undefined) {
      return;
    }
    try {
      observer.onPushEvent(this.id, { type: "attachment" }, this.pushAttached());
    } catch (error) {
      this.reportTurnError(error);
    }
  }

  /**
   * `session/skills` (docs/feat/skills-hot-reload.md): this session's skills
   * read again from disk — its `/name` activator replaced, its model's set
   * untouched — wire-safe. Idle or mid-turn alike; no lock (a concurrent ask
   * shares the scan). Rejects when the scan does: nothing changes.
   */
  async skills(): Promise<SessionSkillsResult> {
    const listing = await this.session.refreshSkills();
    // Read after the scan: a toggle that landed during it is reported.
    return toSessionSkills(listing, this.caps.disabledSkills);
  }

  /**
   * `session/context` (docs/feat/tui-target-badge.md): the context this session
   * would send now — the provider's exact count when it can, else an estimate.
   * Never throws, bounded; mid-turn or idle alike, no lock.
   */
  context(signal?: AbortSignal): Promise<SessionContextResult> {
    return this.session.contextUsage(signal);
  }

  /**
   * Refuse a prompt's image refs BEFORE anything is recorded
   * (docs/feat/attachments-prompt.md D3), synchronously — `prompt` acks in the
   * same stretch, so a refusal leaves no turn, no log entry and nothing to
   * retry. The reason is structured so a client branches without matching text.
   *
   * With a `store` policy the daemon holds the bytes, so it can check them;
   * with `client` it CANNOT (the laptop has them, upload Owner Q2) and the
   * laptop's own gate decides — exactly the rule "whoever runs the provider
   * holds the bytes".
   */
  private checkPromptImages(refs: readonly AttachmentRef[]): void {
    const policy = this.imagesPolicy;
    if (!policy) {
      throw new RpcError(
        DomainErrorCode.AttachmentRefused,
        "this session's model does not take images (model.images is off, or the daemon predates images)",
        { reason: "images_off" },
      );
    }
    try {
      checkAttachmentRefs(refs);
    } catch (error) {
      throw new RpcError(
        DomainErrorCode.AttachmentRefused,
        error instanceof Error ? error.message : String(error),
        { reason: "invalid_ref" },
      );
    }
    if (policy.source !== "store") {
      return;
    }
    for (const ref of refs) {
      if (ref.size > policy.maxBytes) {
        throw new RpcError(
          DomainErrorCode.AttachmentRefused,
          `${attachmentLabel(ref)}: ${formatBytes(ref.size)} is over the ${formatBytes(policy.maxBytes)} limit`,
          { reason: "invalid_ref" },
        );
      }
      if (!this.uploads.holds(ref)) {
        throw new RpcError(
          DomainErrorCode.AttachmentRefused,
          `image ${attachmentLabel(ref)} is not on this daemon — upload it again`,
          { reason: "not_uploaded" },
        );
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
    content: readonly PromptContentBlock[],
    skill?: string,
    askHooksTrust?: AskHooksTrust,
    voice?: VoiceTurn,
    /** The scheduled wake that fires this turn (`fireSchedule` only; display data for `turn_start`). */
    schedule?: { readonly id: string; readonly spec: string },
  ): PromptResult {
    // The key first: a retry is answered even while a turn runs, or after it ended.
    const known = this.turns.get(turnId);
    if (known) {
      return known.end ? { turnId, ended: known.end } : { turnId };
    }
    // Before the busy check: a rejected prompt starts and records nothing.
    const { text, refs } = splitPrompt(content);
    if (refs.length > 0) {
      this.checkPromptImages(refs);
    }
    if (skill !== undefined && (text === "" || !this.session.canActivateSkill(skill))) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidParams,
        `unknown skill "${skill}": not invocable in this session`,
      );
    }
    this.assertIdle();
    // Accepted: a title request never competes with the user's turn.
    this.abortTitle();
    const controller = new AbortController();
    this.controller = controller;
    this.activeTurnId = turnId;
    this.turns.set(turnId, {});
    // The prompt joins the history: a conversation change. It is also the
    // running session's `session/list` key — stable for the whole turn (the
    // keyset cursor needs that), and never above the stamp its end will set.
    this.lastChangeAt = this.now();
    // Before the turn's messages (they join the log at its first commit).
    this.log.turnStart(turnId);
    try {
      this.emit({
        type: "turn_start",
        turnId,
        prompt: text,
        // Another client's rows (docs/feat/attachments-tui.md D2): the refs the
        // prompt named, absent for a text-only turn (never `[]`).
        ...(refs.length > 0 ? { attachments: refs } : {}),
        // A fired scheduled wake (D5, owner Q9 = B): the client styles the row.
        ...(schedule !== undefined ? { schedule } : {}),
      });
    } catch (error) {
      // The turn is accepted (state above): a throwing sink must not strand it
      // as "running" forever — run it anyway; it ends through `finishTurn`.
      this.reportTurnError(error);
    }
    // The agent resets its queue at `send`: so does its mirror (already empty:
    // a turn's end returns or carries every leftover).
    this.queue = [];
    void this.drive(
      turnId,
      this.session.send(text, controller.signal, {
        ...(skill !== undefined ? { skill } : {}),
        ...(refs.length > 0 ? { attachments: refs } : {}),
        ...(askHooksTrust !== undefined ? { askHooksTrust } : {}),
        ...(voice !== undefined ? { voice } : {}),
        beforeRun: this.beforeRunFn,
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
      // BEFORE the abort: the child must be unlinked from the turn first, or
      // this cancel would kill it with the turn
      // (docs/feat/subagent-detach.md, Q13). Its call's result is pushed and
      // committed, and it lives on as `sa-N`.
      this.agentRuntime?.detachForeground();
      this.controller.abort();
      // The reserved turn's prompt and the rows it carries are the queue now.
      this.publishQueue();
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
    // After its `turn_start`: a cited returned row left `returned`.
    this.publishQueue();
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
   * cancelled or aborted is NOT held: its turn's end returns it to its writer
   * (`finishTurn`, docs/feat/queued-broadcast.md), and the caller restores
   * it now — its client then only reclaims it, never hands it back twice.
   */
  private refusal(error: RpcError, messages: readonly SendNowMessage[]): RpcError {
    const next = this.successor;
    const turn = this.controller;
    const live =
      (next !== null && !next.cancelled) ||
      (turn !== null && !turn.signal.aborted && !this.compacting);
    const queued = new Set(live ? this.queue.map((r) => r.id) : []);
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
    this.abortTitle();
    const remaining = next.messages.filter((m) => !this.isDelivered(m.id));
    const ours = new Set(remaining.map((m) => m.id));
    // The cancelled turn's undrained steers carry over (foreign or resumed
    // ones too, in order), minus ours — those are in the prompt — then the
    // steers typed for the successor itself. From the mirror, never the
    // agent's leftover: a turn that ended with no live successor emptied it
    // (its rows went back to their writer), so nothing is resurrected.
    const seedRows: QueuedEntry[] = [
      ...this.queue.filter((r) => !ours.has(r.id)),
      ...next.steers.map((s) => ({ id: s.id, text: s.text })),
    ];
    const seed = seedRows.map((r) => r.text);
    // Sent now: a returned row cited by this prompt is with its writer no more.
    this.returned = this.returned.filter((r) => !ours.has(r.id));
    // Delivered from here on: a late `session/enqueue` of one is a no-op success.
    for (const id of [...next.messages.map((m) => m.id), ...next.steers.map((s) => s.id)]) {
      this.enqueued.add(id);
    }
    // In the prompt = in the history: a later send-now never sends them again.
    for (const id of ours) {
      this.drained.add(id);
    }
    this.queue = seedRows;
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
    this.log.turnStart(next.turnId);
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
        beforeRun: this.beforeRunFn,
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

  /** What a rebuilt agent takes over (`AgentContext.reuse`, docs/feat/session-settings-apply.md). */
  reusable(): {
    readonly permissions: PermissionBroker;
    readonly jobs?: JobController;
    readonly agentJobs?: AgentJobs;
    readonly grants?: SessionGrants;
    readonly workloadShells?: WorkloadShellsLike;
  } {
    return {
      permissions: this.permissions,
      ...(this.jobs ? { jobs: this.jobs } : {}),
      ...(this.agentRuntime ? { agentJobs: this.agentRuntime } : {}),
      ...(this.grants ? { grants: this.grants } : {}),
      ...(this.workloadShells ? { workloadShells: this.workloadShells } : {}),
    };
  }

  /**
   * Run the next turns on `next` (a settings sync). The caller checked
   * `assertIdle` in the same synchronous stretch and built `next` on this
   * session's broker and jobs: the old agent's undrained job exits move to it,
   * and the old one stops collecting. Then every attached client is told
   * (`session_settings`, display). Not a conversation change: `lastChangeAt`
   * stays (the system head, replaced in place, is not a turn).
   */
  swapAgent(
    next: Agent,
    state: {
      readonly settingsReport: SessionSettingsReport;
      readonly titleModel?: ModelProvider;
      readonly grants?: SessionGrants;
      readonly id: string;
    },
  ): void {
    // A fresh agent starts with everything on: the session's switches carry over.
    next.setCapabilities(this.caps);
    const previous = this.session.replaceAgent(next);
    // The system head was replaced IN PLACE behind the cut (same length): the
    // one change no cut follows — derived here, or the log would miss it.
    this.log.commit(this.session.messages, this.cut.length);
    this.verifyLog();
    next.adoptExits(previous.retire());
    this.titleModel = state.titleModel;
    this.grants = state.grants;
    this.settingsReport = state.settingsReport;
    this.persist();
    this.emit({ type: "session_settings", settings: state.settingsReport, id: state.id });
    // The main model may just have changed, and a running child's `model` label
    // is decided AGAINST it (`subagentRows`, Review round 3 M2): the list is
    // republished now, not at the child's next progress event.
    this.publishSubagents();
  }

  /**
   * `session/set_auto_accept` (docs/feat/session-auto-accept.md D3): apply the
   * session's auto-accept, tell every attachment if it CHANGED, and persist it
   * (`serve` only — the sidecar). Idempotent by value: a re-sent set after a
   * drop returns without an emit, so two clients' retries cannot flap the
   * others. Synchronous, holds no lock (AGENTS §7): it never awaits a turn, and
   * `emit` fans out synchronously (P2), so two sets are applied and emitted in
   * one total order and every client converges on the last value.
   */
  setAutoAccept(on: boolean, by?: string): SetAutoAcceptResult {
    this.assertKnown();
    if (this.autoAccept !== on) {
      this.autoAccept = on;
      this.persist();
      this.emit({ type: "auto_accept", on, ...(by ? { by } : {}) });
    }
    return { on: this.autoAccept };
  }

  /** The session's switches now: the `OpenResult.capabilities` snapshot (F5). */
  capabilities(): SessionCapabilitiesWire {
    return toWireCapabilities(this.caps);
  }

  /**
   * The switches of a session this open CREATED (`session/open{capabilities}`,
   * exactly like `autoAccept`): applied to the agent before its first turn, no
   * emit (no client is attached yet that has not read the snapshot).
   */
  seedCapabilities(seed: SessionCapabilities): void {
    // Client-supplied: kept sorted and de-duplicated, like every applied op.
    const state = normalizeCapabilities(seed);
    this.caps = state;
    this.session.currentAgent().setCapabilities(state);
    // Recorded (S3b): the first segment was logged before the seed, so the
    // carried state (a resume, a fork, a hop) follows it. Everything on: nothing.
    if (hasDisabled(state)) {
      this.log.capabilities(state);
      // The create's first write was captured before this entry (`serve`):
      // another one, or it lands only with the next change.
      this.persist();
    }
  }

  /**
   * `session/set_capability` (docs/feat/session-capabilities.md): apply ONE
   * delta to the session's switches, hand the result to the agent (from its
   * next model call; a round in flight keeps its snapshot, F1/F2), and tell
   * every attachment if it CHANGED. Idempotent: a set to the current value
   * returns without an emit. Synchronous, no lock (AGENTS §7): two deltas are
   * applied and emitted in one total order, so different items both land and
   * every client converges on the last echo (F4). A new name past
   * `MAX_DISABLED_CAPABILITIES` in its set is `InvalidParams` (F10).
   */
  setCapability(op: CapabilityOp, by?: string): SetCapabilityResult {
    this.assertKnown();
    const next = applyCapabilityOp(this.caps, op);
    if (next !== this.caps) {
      const set = op.kind === "mcp" ? next.disabledMcp : next.disabledSkills;
      if (set.length > MAX_DISABLED_CAPABILITIES) {
        throw new RpcError(
          JsonRpcErrorCode.InvalidParams,
          `at most ${MAX_DISABLED_CAPABILITIES} ${op.kind} names may be turned off`,
        );
      }
      this.caps = next;
      this.session.currentAgent().setCapabilities(next);
      // The record is the log (S3b): the whole state after, then a write
      // (`serve`; a no-op elsewhere). A crash before it lands loses this one
      // change, and the reload says what it has (F6).
      this.log.capabilities(next);
      this.persist();
      this.emit({
        type: "capabilities",
        capabilities: toWireCapabilities(next),
        ...(by ? { by } : {}),
      });
    }
    return { capabilities: toWireCapabilities(this.caps) };
  }

  /**
   * A session that ended takes no new state: a set on it is refused rather than
   * silently applied to nothing (its `lookup` already dropped it, so this is the
   * belt to that brace).
   */
  private assertKnown(): void {
    if (this.closed) {
      throw new RpcError(DomainErrorCode.UnknownSession, `session ${this.id} is closed`);
    }
  }

  /**
   * Refuse a new operation while the busy slot is held. Every taker of the slot
   * calls this and takes it in the same synchronous stretch, so two concurrent
   * requests can never both pass. Package-visible for `SessionHost.updateSettings`,
   * which checks it and swaps the agent in the same synchronous stretch.
   */
  assertIdle(): void {
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
          // A resumed turn's carried entry still set here is for a call that
          // was answered without being asked again (cancelled) — never write
          // it as pending. Live asks stay: each is cleared by its own settle
          // (a sibling call's commit must not drop it, once calls overlap).
          // A group's ONE commit carries its results: no call of it is in
          // flight any more, captured in the same write.
          this.carried = [];
          this.inFlight = undefined;
          this.recordCut(turnId);
          this.persist();
          continue;
        }
        // The model renewed its context: the history was replaced in place,
        // in this same stretch (no `await` between the agent's replacement
        // and here). The barrier, mid-turn — then the record holds the fresh
        // history at once, with the turn in flight.
        if (event.type === "context_reset") {
          this.carried = [];
          this.inFlight = undefined;
          this.historyReplaced("context_reset");
          this.persist();
          continue;
        }
        // The wake turn's start flushed the exits: the agent's count is the truth again.
        if (event.type === "background_exit" && this.wakeUnflushed === turnId) {
          this.wakeUnflushed = null;
        }
        // A sub-agent's report note is pushed by this flush: delivery is closed
        // HERE, not only at the next commit, so a context reset in the same
        // uncommitted window never re-notes it (task 5 review L3).
        if (event.type === "background_exit" && event.agent !== undefined) {
          this.agentJobs.noteSeen({ kind: NOTE_KIND.subagentReport, id: event.jobId });
        }
        let named: AgentEvent = event;
        if (event.type === "steer") {
          // One per drained text, in queue order: the mirror's head is its id
          // — streamed with it, so no client guesses whose row went.
          const row = this.queue.shift();
          if (row !== undefined) {
            this.drained.add(row.id);
            named = { ...event, id: row.id };
          }
        }
        // The agent's "about to start" signal (the call starts on the next
        // pull): the log says it may have run — "interrupted", never "not run".
        if (event.type === "tool_phase" && event.phase === "running") {
          this.log.callStarted(event.id);
        }
        if (event.type === "history_repaired") {
          // Synchronous, no await: the drive-loop invariant holds. The user is
          // told ONCE per loaded session (a restart notifies again, once).
          if (this.historyRepairNoticed) {
            continue;
          }
          this.historyRepairNoticed = true;
        }
        const update = eventToUpdate(named);
        if (update) {
          this.emit(update);
        }
        // `steer`, then the queue without it (same stretch).
        if (event.type === "steer") {
          this.publishQueue();
        }
      }
      // The generator ended without a `turn_end` (not an agent path today).
      this.finishTurn(turnId, { stopReason: "end_turn" });
    } catch (error) {
      // The agent (model/tool) failed — or the sink threw. Either way: report
      // it unredacted, then end the turn. `finishTurn` is idempotent, so a
      // throw from its own `turn_end` emit sends no second `turn_end`.
      this.reportTurnError(error);
      const wire = redactTurnError(error, this.errorPolicy.exposeTurnErrors === true);
      // The history says how the turn ended, in the wire's words (never more):
      // `finishTurn` moves the cut and persists it with the rest.
      closeFailedTurn(this.session.messages, wire.message);
      try {
        this.finishTurn(turnId, {
          stopReason: "error",
          error: wire,
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
    if (this.wakeUnflushed === turnId) {
      this.wakeUnflushed = null;
    }
    if (this.activeTurnId === turnId) {
      this.controller = null;
      this.activeTurnId = null;
      this.lastEndBad = end.stopReason === "error" || end.stopReason === "cancelled";
      this.lastActiveAt = this.now();
      this.lastChangeAt = this.lastActiveAt;
      // The rows it left undrained: carried by a live send-now (D4), else
      // back to their writer — never kept for "the next turn, whoever starts
      // it" (docs/feat/queued-broadcast.md, D-return). State first, like the
      // rest: the record captured below has them.
      const back = leftovers(this.queue, this.successorView());
      if (back !== null) {
        const cause = returnCause(this.closed, end.stopReason);
        this.returned.push(...back.map((r) => ({ id: r.id, text: r.text, cause })));
        this.queue = [];
      }
    }
    // A fired scheduled wake's end counts against its job (D3 failure stop):
    // state first, like the rest — the capture below has it.
    const firedBy = this.firedTurns.get(turnId);
    if (firedBy !== undefined) {
      this.firedTurns.delete(turnId);
      this.settleFired(firedBy, end.stopReason);
    }
    try {
      this.emit({ type: "turn_end", turnId, ...end });
    } finally {
      this.recordCut(this.activeTurnId);
      // After the turn's last message (derived just above); the checkpoint's
      // digest is lazy (the first read hashes, never this window).
      this.log.turnEnd(turnId, end.stopReason);
      this.log.checkpoint();
      // Inside the steering window, and safe there: this method cannot await,
      // and `persist` only captures — the I/O starts after the window.
      this.carried = [];
      this.inFlight = undefined;
      this.persist();
      // Last, in the same stretch: a reserved send-now takes the slot now.
      this.settleSuccessor();
      // After the successor's `turn_start` (a hand-off stays `turn_end`,
      // `turn_start` back to back): the queue it left, or carried.
      this.publishQueue();
      // Only SCHEDULES (a macrotask): no work in the steering window.
      this.kickTitle();
      // An exit the turn's start did not flush (it came later): the daemon
      // wakes for it. Scheduled too.
      this.kickWake();
      // A failure stop's list, then a scheduled wake that came due while the
      // turn held the slot: checked on the next macrotask (only a timer here).
      this.publishSchedules();
      this.kickSchedules();
    }
  }

  /**
   * Check the autonomous wake on the next macrotask (`SessionWake`): outside
   * the steering window, after every exit listener ran. One pending check at a
   * time; the macrotask re-checks everything (`maybeWake`).
   */
  private kickWake(): void {
    if (!this.wake || this.closed || this.wakeKick !== null) {
      return;
    }
    this.wakeKick = setTimeout(() => {
      this.wakeKick = null;
      this.maybeWake();
    }, 0);
  }

  /**
   * Start ONE continuation turn if an exit is unflushed, the slot is free and
   * the last turn ended normally (`daemonWakeGate`) — attached clients or not:
   * on `serve` the daemon is the only waker (they watch it live). The
   * agent's own count decides — a turn that flushed leaves 0, so a wake never
   * repeats for the same exit; one refused leaves it, so the next check retries.
   */
  private maybeWake(): void {
    const due = wakeDue(
      { pending: this.session.pendingExitCount > 0 },
      daemonWakeGate({
        enabled: this.wake !== undefined,
        busy: this.running,
        lastEndBad: this.lastEndBad,
        closed: this.closed,
      }),
    );
    if (!due) {
      return;
    }
    const turnId = `${WAKE_TURN_PREFIX}${crypto.randomUUID()}`;
    // Idle: the history reflects every emit, so the cut may move to "now". It
    // leaves the session-level `background_exit` frames of the exits this turn
    // will flush BEFORE the cut: a client attaching mid-wake gets them through
    // the snapshot plus the turn's own flush note, never as a live exit notice
    // that would arm its own wake — one turn per exit (Review finding 1).
    this.recordCut(null);
    // Before `prompt`: its turn's start may flush synchronously, or after an
    // await (project-hook trust) — either way an attach meanwhile reads 0.
    this.wakeUnflushed = turnId;
    try {
      // An empty prompt is a continuation: the start injects the exit notes.
      this.prompt(turnId, []);
    } catch (error) {
      this.wakeUnflushed = null;
      // The gate checked the slot in this same stretch: a throw is unexpected.
      this.reportTurnError(error);
      return;
    }
    try {
      this.wake?.onAudit?.(`wake: background job exit ${this.id}`);
    } catch {
      // The audit sink failed: the turn runs regardless.
    }
  }

  // --- scheduled wakes (docs/feat/cron-tool.md S3) ----------------------------

  /**
   * The table as this session's tools see it (`AgentContext.schedules`, P1), or
   * `null` where the session does not schedule (a pod daemon) or has ended.
   * Looked up per call by the tool, never cached: the agent may be rebuilt.
   */
  scheduleLink(): ScheduleLink | null {
    if (this.scheduling === undefined || this.closed) {
      return null;
    }
    return {
      now: () => this.now(),
      create: (request) => this.createSchedule(request),
      list: () => this.scheduleTable,
      delete: (id) => this.removeSchedule(id),
    };
  }

  /** The model's create (`schedule_create`, asked through the broker before it gets here). */
  private createSchedule(request: ScheduleRequest): ScheduleCreateResult {
    if (this.closed) {
      return { ok: false, reason: "this session has ended" };
    }
    const result = scheduleCreate(this.scheduleTable, request, {
      id: `${SCHEDULE_ID_PREFIX}${this.scheduleSeq + 1}`,
      now: this.now(),
      createdBy: this.activeTurnId ?? "",
      ...(this.scheduling?.limits ? { limits: this.scheduling.limits } : {}),
    });
    if (result.ok) {
      this.scheduleSeq += 1;
      this.scheduleChanged(result.table);
    }
    return result;
  }

  /** Drop one job (the model's `schedule_control{delete}` or the user's method). */
  private removeSchedule(id: string): boolean {
    const { table, deleted } = scheduleDelete(this.scheduleTable, id);
    if (deleted) {
      this.scheduleChanged(table);
    }
    return deleted;
  }

  /**
   * `session/schedule_delete` (D5): the user drops one wake by hand — the same
   * decision as the model's delete. Synchronous (§7: never awaits a turn), and
   * a refusal is an answer with its reason, never a throw.
   */
  deleteSchedule(scheduleId: string): ScheduleDeleteResult {
    if (this.removeSchedule(scheduleId)) {
      return { deleted: true };
    }
    return {
      deleted: false,
      reason:
        this.scheduling === undefined && this.scheduleTable.length === 0
          ? "this session has no scheduled wakes"
          : `no scheduled wake ${wireLine(scheduleId, 64)} in this session`,
    };
  }

  /** A new table: the write (synchronous capture), the list, the timer. */
  private scheduleChanged(table: readonly ScheduledJob[]): void {
    this.scheduleTable = table;
    this.persist();
    this.publishSchedules();
    this.armSchedules();
  }

  /**
   * ONE check of the table (the timer's body; tests call it directly): sweep
   * expiry, and when the slot is free fire the ONE due job (D3). The job is
   * advanced and the advance captured BEFORE `prompt()` (at-most-once: a crash
   * mid-turn never fires that slot again). `lastEndBad` is NOT honoured: a
   * user's Esc on some turn must not silence a reminder (the failure stop bounds
   * a dead model instead). Re-arms the timer last, whatever happened.
   */
  checkSchedules(): void {
    if (this.scheduling === undefined || this.closed) {
      return;
    }
    // The same pure gate as the job-exit wake, with the slot as its only input
    // besides `closed` (no `lastEndBad`, above).
    const idle = wakeDue(
      { pending: true },
      { enabled: true, idle: !this.running, blocked: this.closed },
    );
    const step = scheduleStep(this.scheduleTable, this.now(), { idle });
    const changed =
      step.table.length !== this.scheduleTable.length ||
      step.table.some((job, i) => job !== this.scheduleTable[i]);
    for (const job of step.expired) {
      this.scheduleAudit(`schedule: ${job.id} expired ${this.id}`);
    }
    if (step.due === null) {
      if (changed) {
        this.scheduleTable = step.table;
        this.persist();
        this.publishSchedules();
      }
      this.armSchedules();
      return;
    }
    this.fireSchedule(step.due, step.table);
  }

  /** Fire `job` (already advanced in `table`): commit, capture, publish, THEN `prompt()`. */
  private fireSchedule(job: ScheduledJob, table: readonly ScheduledJob[]): void {
    this.scheduleTable = table;
    // The advance is on disk-bound state BEFORE the turn exists (D3).
    this.persist();
    this.publishSchedules();
    const turnId = `${WAKE_TURN_PREFIX}${crypto.randomUUID()}`;
    // As the job-exit wake: the cut moves to "now", and the turn's start will
    // flush every pending exit — so an attach meanwhile reads 0 (one turn).
    this.recordCut(null);
    this.wakeUnflushed = turnId;
    this.firedTurns.set(turnId, job.id);
    try {
      this.prompt(
        turnId,
        [{ type: "text", text: schedulePromptText(job) }],
        undefined,
        undefined,
        undefined,
        {
          id: job.id,
          spec: job.spec.slice(0, SCHEDULE_LABEL_MAX),
        },
      );
    } catch (error) {
      // The slot was free in this same stretch: unexpected. The slot stays
      // consumed (at-most-once), and the timer is re-armed below.
      this.wakeUnflushed = null;
      this.firedTurns.delete(turnId);
      this.reportTurnError(error);
    }
    this.scheduleAudit(`wake: scheduled ${job.id} ${this.id}`);
    this.armSchedules();
  }

  /** A fired turn ended: count it against its job (3 errors in a row → removed, D3). */
  private settleFired(jobId: string, stopReason: string): void {
    const { table, removed } = scheduleSettled(
      this.scheduleTable,
      jobId,
      scheduleEndOf(stopReason),
    );
    this.scheduleTable = table;
    if (removed) {
      this.scheduleAudit(`schedule: ${jobId} stopped after failures ${this.id}`);
    }
  }

  /**
   * Arm the ONE timer for the next check: at the next slot, ≤ 60 s; a full
   * interval while the slot is held (never a 0 ms spin — `kickSchedules` checks
   * at the turn's end). Nothing armed for an empty table or a closed session.
   */
  private armSchedules(delayMs?: number): void {
    this.disarmSchedules();
    if (this.scheduling === undefined || this.closed) {
      return;
    }
    const delay =
      this.scheduleTable.length === 0
        ? null
        : (delayMs ??
          scheduleCheckDelayMs(this.scheduleTable, this.now(), { idle: !this.running }));
    if (delay === null) {
      return;
    }
    const set = this.scheduling.setTimeout ?? defaultSetTimeout;
    this.scheduleTimer = set(() => {
      this.scheduleTimer = null;
      this.checkSchedules();
    }, delay);
  }

  private disarmSchedules(): void {
    if (this.scheduleTimer !== null) {
      (this.scheduling?.clearTimeout ?? defaultClearTimeout)(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  /** The slot was freed (a turn's or a compaction's end): check on the next macrotask. */
  private kickSchedules(): void {
    this.armSchedules(0);
  }

  /**
   * Stream the table if it changed since the last `schedules` frame (full
   * state; an unchanged list sends nothing). Never throws. Idle: the cut then
   * moves to "now", like `publishJobs`.
   */
  private publishSchedules(): void {
    if (this.closed || this.scheduling === undefined) {
      return;
    }
    const rows = scheduleRows(this.scheduleTable);
    if (sameScheduleRows(rows, this.lastSchedules)) {
      return;
    }
    this.lastSchedules = rows;
    try {
      this.emit({ type: "schedules", schedules: [...rows] });
    } catch (error) {
      this.reportTurnError(error);
    }
    if (this.controller === null) {
      this.recordCut(null);
    }
  }

  private scheduleAudit(line: string): void {
    try {
      this.scheduling?.onAudit?.(line);
    } catch {
      // The audit sink failed: the schedule goes on regardless.
    }
  }

  /**
   * After a turn's end: ask for a title on the next macrotask — outside the
   * steering window (`drive`'s INVARIANT) — if the session may still get one.
   * The macrotask re-checks everything: the slot may be taken by then (a
   * send-now successor, a new prompt), the title renamed, the session closed.
   */
  private kickTitle(): void {
    if (
      this.closed ||
      !this.titleModel ||
      this.titleKick !== null ||
      this.title.source !== "auto"
    ) {
      return;
    }
    this.titleKick = setTimeout(() => {
      this.titleKick = null;
      if (this.running || !this.mayGenerate()) {
        return;
      }
      void this.generateTitle();
    }, 0);
  }

  private mayGenerate(): boolean {
    return shouldGenerate({
      state: this.title,
      messages: this.session.messages,
      failures: this.titleFailures,
      inFlight: this.titleJob !== null,
      closed: this.closed,
    });
  }

  /** Abort the title request in flight (synchronous). Not a failure: the next turn end retries. */
  private abortTitle(): void {
    const job = this.titleJob;
    this.titleJob = null;
    job?.abort();
  }

  /**
   * One title request, fire-and-forget: never awaited by anything, never
   * throws out. Success over an `auto` title → `model`, persisted, streamed.
   * An error, a timeout or an unusable reply → still `auto` (the first
   * message — never untitled), logged through the turn-error sink (the
   * daemon's log, never a terminal), counted. An abort by the slot (or a
   * rename, a close) → nothing, not counted.
   */
  private async generateTitle(): Promise<void> {
    const model = this.titleModel;
    const input = titleInput(this.session.messages);
    if (!model || !input) {
      return;
    }
    const job = new AbortController();
    this.titleJob = job;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      job.abort();
    }, this.titleTimeoutMs);
    let raw = "";
    let failure: string | null = null;
    try {
      for await (const event of model.stream({ ...titleRequest(input), signal: job.signal })) {
        if (event.type === "text") {
          raw += event.delta;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (this.titleJob === job) {
      this.titleJob = null;
    }
    // Taken over (a turn, a compaction, a rename, a close): not ours to finish.
    if ((job.signal.aborted && !timedOut) || this.closed) {
      return;
    }
    // A provider may end its stream quietly on an abort.
    if (timedOut) {
      failure = `no answer within ${this.titleTimeoutMs}ms`;
    }
    const text = failure === null ? cleanTitle(raw) : null;
    if (text === null) {
      this.titleFailures++;
      this.reportTurnError(
        new Error(`title generation failed: ${failure ?? "the model returned no usable title"}`),
      );
      return;
    }
    const next = applyGenerated(this.title, text);
    if (next === this.title || next.source === "auto") {
      return;
    }
    this.setTitle(next);
  }

  /** A chosen title is now the session's: on disk (a capture), then to every client. */
  private setTitle(next: Extract<TitleState, { readonly text: string }>): void {
    this.title = next;
    this.log.title(this.wireTitle());
    this.persist();
    try {
      this.emit({ type: "session_title", title: next.text, source: next.source });
    } catch (error) {
      this.reportTurnError(error);
    }
  }

  /**
   * `session/rename`: the user's title wins, now and later (a request in
   * flight is aborted; a late answer changes nothing). Synchronous, no lock:
   * allowed mid-turn (it touches neither the history nor the slot). Not a
   * conversation change (`lastChangeAt` stays). Nothing visible → `InvalidParams`.
   */
  rename(raw: string): SessionTitle {
    const text = renameText(raw);
    if (text === null) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidParams,
        "a title needs at least one visible character",
      );
    }
    this.abortTitle();
    this.setTitle(applyRename(this.title, text));
    return { text, source: "user" };
  }

  /**
   * Queue a user message for injection at the next model-round boundary of the
   * turn `turnId`. Synchronous. The key is checked BEFORE the running check: a
   * retry of an accepted id is a no-op success even after its turn ended (never
   * `NoTurnRunning`, never injected twice). A rejected attempt is not recorded.
   */
  enqueue(id: string, turnId: string, text: string, voice?: VoiceTurn): void {
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
      this.publishQueue();
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
    this.session.enqueue(text, voice);
    this.queue.push({ id, text });
    // A person wrote while a foreground child runs: it moves to the background
    // NOW, in this synchronous stretch, so the call it holds is answered in
    // this round and this steer is drained at the next boundary
    // (docs/feat/subagent-detach.md). Only here: the three earlier returns and
    // the throw never detach.
    this.agentRuntime?.detachForeground();
    this.persist();
    this.publishQueue();
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
    // The compaction's model call goes first (one slot on a local server).
    this.abortTitle();
    const controller = new AbortController();
    this.controller = controller;
    this.compacting = true;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { before, after } = await this.session.compact(controller.signal, () =>
        this.historyReplaced("compact"),
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
      // The projection after it (replaced or untouched), digest lazy.
      this.log.checkpoint();
      // Last, in the same stretch: a reserved send-now takes the slot now.
      this.settleSuccessor();
      this.publishQueue();
      // An exit that came while the slot was the compaction's (scheduled).
      this.kickWake();
      // A scheduled wake that came due during it, likewise.
      this.kickSchedules();
    }
  }

  /**
   * `session/clear` (docs/feat/clear-keeps-jobs.md): reset the conversation IN
   * PLACE through the same barrier a compaction uses, so background jobs,
   * sub-agents, their asks and their pending exits stay wired to this session.
   * SYNCHRONOUS and atomic: it throws at `assertIdle` before touching anything,
   * or it completes (the barrier must not throw). Holds no lock (AGENTS §7).
   */
  clear(): { before: number; after: number } {
    this.assertIdle();
    // BEFORE the title reset and the barrier: the old chat, as it stands
    // (`filter` returns a new array, the in-place replacement cannot touch it).
    const kept = this.keepFork ? forkableMessages(this.session.messages) : null;
    const fork: ClearForkCapture | null = kept
      ? {
          messages: kept,
          title: this.title,
          createdAt: this.createdAt,
          updatedAt: this.lastChangeAt,
        }
      : null;
    this.abortTitle();
    if (this.titleKick !== null) {
      clearTimeout(this.titleKick);
      this.titleKick = null;
    }
    // BEFORE the barrier: its segment's `title` entry must reflect the reset. A
    // `user` rename stays (it names the session, which goes on).
    // An `auto` title's PIN drops too: the fresh chat has no first message yet,
    // so it must name itself at its own first prompt rather than keep the old
    // chat's words (docs/fix/connect-functest-batch.md item C).
    if (this.title.source !== "user") {
      this.title = { source: "auto" };
    }
    const result = this.session.clearConversation(() => this.historyReplaced("clear"));
    // The session approvals go for everyone, running children included (QB).
    if (this.grants) {
      this.grants.clear();
    } else {
      // A factory that forgot the store (review H1): the approvals survive, and
      // the embedder's log says so — never a silent skip.
      this.reportTurnError(
        new Error("/clear: this session has no approvals store; its session approvals were kept"),
      );
    }
    // A fresh chat: an earlier stop or failure no longer blocks the wake.
    this.lastEndBad = false;
    // Handed to the store BEFORE the `persist()` below: the fork precedes the
    // save that drops the old chat from the source's file.
    if (fork) {
      try {
        this.keepFork?.(this.id, fork);
      } catch (error) {
        // The clear already happened: never fail it now.
        this.reportTurnError(error);
      }
    }
    this.lastChangeAt = this.now();
    this.lastActiveAt = this.now();
    this.persist();
    this.log.checkpoint();
    this.publishQueue();
    this.kickWake();
    return result;
  }

  /**
   * The barrier, run synchronously right after the history was replaced —
   * inside `Session.compact` (between turns), or on the agent's
   * `context_reset` (INSIDE a turn): a new epoch, `history_replaced`, the cut.
   * Must not throw (the replacement already happened): a sink error is reported.
   */
  private historyReplaced(reason: "compact" | "context_reset" | "clear"): void {
    // The cut is final BEFORE the emit — it names the barrier's own seq (the
    // next one) — so even a sink that reads the snapshot re-entrantly sees a
    // consistent new epoch, never the new epoch with the old history length.
    // `compactedHistory` builds `[system?, summary, (skill call, result)*]`, a
    // reset `[system, restart message, (skill call, result)*]`: their first
    // user message is the head this session installed.
    this.compactionSummary = this.session.messages.find((m) => m.role === "user");
    this.epochStart = this.seq + 1;
    this.cut = {
      epoch: crypto.randomUUID(),
      seq: this.epochStart,
      length: this.session.messages.length,
      // A reset runs inside its turn: the cut names it, so a client that
      // resyncs on the barrier keeps the rest of the turn (a compaction holds
      // no turn).
      turnId: this.compacting ? null : this.activeTurnId,
      // As of the last `queued` emitted (a compaction's: no turn, no queue;
      // the returned rows stay).
      queued: this.lastQueued,
      // Children outlive a compaction, a reset of the history and `/clear`
      // (an in-place reset): the list is the live state.
      subagents: this.lastSubagents,
      // Likewise the shell jobs (`/clear` keeps them).
      jobs: this.lastJobs,
      // And the scheduled wakes (owner Q7: `/clear` keeps them; a compaction too).
      schedules: this.lastSchedules,
    };
    // A new log segment: the SAME array was replaced in place, so it is never
    // diffed — the reference copy is reset (F3). Before the emit, like the cut.
    // A `/clear` segment is logged as `compact`: `base.reason` is a critical
    // entry's enum, so a new value would make an older build refuse the file
    // (docs/feat/clear-keeps-jobs.md); `compact` already means "superseding".
    this.log.replaced(
      this.session.messages,
      reason === "clear" ? "compact" : reason,
      this.cut.turnId,
    );
    this.logSegmentFacts();
    this.verifyLog();
    try {
      this.emit({ type: "history_replaced", reason });
    } catch (error) {
      this.reportTurnError(error);
    }
    // The barrier withdraws every request nothing re-offers (the client keeps
    // only what the replay re-offers): a background ask is offered again.
    this.reofferBackgroundAsks();
  }

  /**
   * Abort the active turn or compaction (if any), and a send-now waiting on
   * it. With `turnId` (`session/cancel{turnId}`) only the turn it names: the
   * active turn (a reserved successor is a newer intent and still starts), or
   * the waiting send-now (its target is already being interrupted). Any other
   * id — an ended turn, a compaction's slot — is stale: nothing is cancelled.
   */
  cancel(turnId?: string): void {
    if (turnId === undefined) {
      this.controller?.abort();
      if (this.successor) {
        this.successor.cancelled = true;
      }
    } else if (turnId === this.activeTurnId && !this.compacting) {
      this.controller?.abort();
    } else if (this.successor && turnId === this.successor.turnId) {
      this.successor.cancelled = true;
    }
    // A cancelled send-now's rows leave the queue (its sender restores them).
    this.publishQueue();
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
    this.abortTitle();
    if (this.titleKick !== null) {
      clearTimeout(this.titleKick);
      this.titleKick = null;
    }
    if (this.wakeKick !== null) {
      clearTimeout(this.wakeKick);
      this.wakeKick = null;
    }
    // The table itself stays (an archive keeps it frozen, D6); only the timer goes.
    this.disarmSchedules();
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
    // The rows its turn left reach every attached writer before the end.
    this.publishQueue();
    try {
      this.emit({ type: "session_closed", reason });
    } catch (error) {
      this.reportTurnError(error);
    }
    // A child's visible state (the live list) is a frame the ring never needs
    // to pin past the next cut.
    if (this.subagentsKick !== null) {
      clearTimeout(this.subagentsKick);
      this.subagentsKick = null;
    }
    this.attachments.clear();
    // A watcher is a follower, not a client: its last batch says the session
    // ended (after `session_closed`, which it just received above).
    this.watchers.endAll("closed");
    // The single END of a live session covers close, archive, the reaper, the
    // detached cap and delete (P4): the upload reservations go back here.
    this.uploads.dispose();
    this.unsubscribeExit?.();
    this.unsubscribeStart?.();
    this.jobs?.dispose();
    // The session is ENDing: close every shell (EOF + kill tree), best effort and
    // bounded, so nothing is left running in the workload (D4).
    void this.workloadShells?.dispose();
    // Children abort (their signal settles a pending ask); no `end`, no exit
    // frame: at a reopen the `bg` without an `end` gives the lost note.
    this.unsubscribeAgentExit?.();
    this.unsubscribeAgentNotify?.();
    this.unsubscribeAgentRows?.();
    this.agentRuntime?.dispose();
  }

  /**
   * `close` this session and return the state its ARCHIVED record keeps. The
   * history and the turn are taken just BEFORE the close: a turn cut short
   * keeps its pending ask, the shape a crash leaves, which the
   * reopen closes as ended (`reconcileOnReload`). The turn keys and the stamps
   * are taken AFTER it: the ends the close streamed (`turn_end{cancelled}`,
   * and a waiting send-now's `delivered: false` — memory only until here) are
   * the ends a retried `prompt` / `send_now` must get after the reopen.
   * The turn's steers too are taken AFTER it: the close returned them to
   * their writer (`returned`, as streamed), so the reopen must not also
   * append them as user messages — handed back AND delivered.
   */
  archive(after?: LogCursor): DaemonSessionState {
    const before = this.persistedState(after);
    this.close("closed");
    // The log part is the one BEFORE the close (docs/feat/session-log-serve-store.md
    // §2): an archived session's log is the shape a crash leaves — no
    // `turn_end` of the turn the close cut — and the reopen closes it as ended.
    const closed = this.persistedState(undefined, false);
    return {
      ...closed,
      ...(before.log ? { log: before.log } : {}),
      ...(before.turn ? { turn: { ...before.turn, steering: [], steeringIds: [] } } : {}),
    };
  }
}
