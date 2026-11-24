/**
 * The type surface `App` exposes (docs/feat/app-decomposition.md, slice S1): the
 * session contract the TUI drives, the props it takes, and the host feeds it
 * subscribes to. `App.tsx` and `index.ts` both name this list HERE, so adding a
 * controller method is one edit in one file — never an edit to the render tree.
 */
import type { Agent } from "@tentacle/agent";
import type { AttachmentRef, JobController, PermissionBroker } from "@tentacle/core";
import type {
  ArtifactListResult,
  ArtifactMeta,
  CompactResult,
  DocumentContent,
  JobOutputResult,
  JobRow,
  WorkflowCatalogueResult,
  WorkflowRow,
  WorkflowSaveResult,
  WorkflowSourceResult,
  WorkflowStepDetail,
} from "@tentacle/protocol";
import type { AttachMode } from "./attach-draft.ts";
import type { FileProbe } from "./attach-files.ts";
import type { BackgroundAgentRow } from "./background-view.ts";
import type { CapKind, CapsView } from "./capability-toggles.ts";
import type { ChartGlyphs } from "./chart-lines.ts";
import type { HopNamespace, HopSpec } from "./hop-command.ts";
import type { LinkFeed } from "./link-status.ts";
import type { McpServerView } from "./mcp-panel.ts";
import type { ArtifactOpener } from "./os-open.ts";
import type { DocumentMode } from "./pdf-attach.ts";
import type { AutoAcceptFeed, AutoAcceptSharedFeed } from "./permission-ui.ts";
import type { DaemonQueue, QueuedMessage, ReturnedCause, UnqueueAnswer } from "./queued.ts";
import type { ScheduleDockRow } from "./schedule-view.ts";
import type { SessionsView } from "./sessions-panel.ts";
import type { SessionSkillsView } from "./skills-sync.ts";
import type { DisplayItem, SessionEvent } from "./state.ts";
import type { ContextOpen } from "./status-view.ts";
import type { SubagentNotifyView } from "./subagent-notify.ts";
import type { TargetBadge } from "./target-view.ts";
import type { ToolEntryView } from "./tools-panel.ts";
import type { SessionActivity } from "./turn-feed.ts";
import type { RunQuit } from "./useQuitClear.ts";
import type { VoiceConfig } from "./voice-session.ts";
import type { VoiceSpawner } from "./voice-spawn.ts";

/**
 * `RunQuit` left this file with S8: it is declared next to `useQuitClear`, the
 * executor that reads it (plan H4(1): a hook slice takes its own type with it),
 * and re-exported here so every `from "app-types.ts"` importer — including
 * `AppProps` below — keeps working unchanged.
 */
export type { RunQuit } from "./useQuitClear.ts";

/**
 * What the TUI asks of a run, MIRRORED structurally (never the protocol's
 * type — the TUI does not depend on `@tentacle/client`, and the wire's
 * `sessionId`/`turnId` are the client's own to fill: it alone knows which turns
 * this device began). The `turnId` is therefore absent here on purpose.
 */
export type WorkflowActionView =
  | {
      readonly action: "start";
      readonly name: string;
      readonly inputs?: readonly { readonly name: string; readonly value: string }[];
    }
  | { readonly action: "stop"; readonly runId: string }
  | { readonly action: "resume"; readonly runId: string }
  | { readonly action: "rerun_step"; readonly runId: string; readonly stepId: string };

/**
 * What the workflow editor asks to write (`session/workflow_save`, docs/feat/
 * workflow-editor.md D5), MIRRORED structurally for `WorkflowActionView`'s reason:
 * the TUI does not depend on `@tentacle/client`, and `sessionId` is the client's
 * own to fill. Every field the wire requires is here, so a caller can never build
 * a request that forgets `dryRun` (Review) or the prompt files.
 */
export interface WorkflowSaveRequestView {
  readonly name: string;
  /** `create` refuses an existing file; `replace` requires `baseHash` to still be the file's. */
  readonly mode: "create" | "replace";
  /** The draft as JSON text (the phone and the TUI cannot parse YAML either). */
  readonly draft: string;
  readonly prompts: readonly { readonly path: string; readonly text: string }[];
  readonly baseHash?: string;
  /** Required, never defaulted: `true` IS Review, `false` writes. */
  readonly dryRun: boolean;
}

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

/**
 * How an artifact read is driven (structurally the client's
 * `ArtifactReadOptions`): `signal` stops issuing chunks, `onProgress` reports
 * `(have, size)` against the META's own size.
 */
export interface ArtifactOpenOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (have: number, size: number) => void;
}

export interface SessionController {
  /**
   * A remote session also yields the reconnect events (`history_reset`,
   * `user_message`). `opts.skill`: the user activates that skill (`/name`).
   */
  send(
    prompt: string,
    signal?: AbortSignal,
    opts?: {
      readonly skill?: string;
      readonly attachments?: readonly AttachmentRef[];
      /**
       * Attached PDFs, already turned into wire blocks by `attachDocument`
       * (docs/feat/pdf-read.md D6) — the TUI never builds one itself.
       */
      readonly documents?: readonly DocumentContent[];
    },
  ): AsyncIterable<SessionEvent>;
  /**
   * Attach one image to this session and resolve its ref
   * (docs/feat/attachments-tui.md D5): the SESSION does it (only it can await a
   * lazy open), so `App` never needs a daemon id. Rejects with a typed error
   * (`ImagesUnavailableError`, `RangeError`, an upload failure) — never a
   * silent drop. Not optional: every runtime this TUI drives has an image seam
   * (docs/feat/remove-in-process.md — the in-process session it was optional for
   * is gone), so a session that cannot take images says so THROUGH `imageInput`
   * (`{kind: "off", reason}`), never by the member being absent.
   */
  attachImage(
    bytes: Uint8Array,
    meta: { readonly mimeType: string; readonly name?: string },
    opts?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (sent: number, size: number) => void;
    },
  ): Promise<AttachmentRef>;
  /** What this session may do with an image right now (structurally `ImageInput`). */
  imageInput(): AttachMode;
  /**
   * Attach one PDF to this session and resolve the wire block a prompt names
   * (docs/feat/pdf-read.md D6): upload-then-`ref` when the daemon extracts, or
   * the LAPTOP's own extraction as `text` for a pod (AGENTS §7). Rejects with
   * a typed error (`DocumentsUnavailableError`, `RangeError`,
   * `DocumentExtractError`) — never a silent drop. Required for the same reason
   * as `attachImage`: a session that takes no PDFs says so THROUGH
   * `documentsInput()` (`{kind: "off", reason}`).
   */
  attachDocument(
    bytes: Uint8Array,
    meta: { readonly name: string },
    opts?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (sent: number, size: number) => void;
    },
  ): Promise<DocumentContent>;
  /** What this session may do with a PDF right now (structurally `DocumentsInput`). */
  documentsInput(): DocumentMode;
  /** Compact the conversation (summarise + replace history); optional. The token sizes are optional (an older daemon omits them). */
  compact?(signal?: AbortSignal): Promise<CompactResult>;
  /**
   * `/clear` (docs/feat/clear-keeps-jobs.md): reset the conversation inside the
   * session; background jobs and sub-agents keep running. Required: there is no
   * in-process fallback whose `/clear` was a close-and-replace any more
   * (docs/feat/remove-in-process.md), so `clearCommandStep` no longer has a
   * `legacy` branch to decide.
   */
  clear(): Promise<{ before: number; after: number }>;
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
   * Take queued rows back before the model reads them (docs/feat/queue-unqueue.md);
   * optional (absent → ↑ never pulls a row back). `"unsupported"`: an older daemon.
   */
  unqueue?(ids: readonly string[]): Promise<UnqueueAnswer>;
  /**
   * Send the queued messages now (`Ctrl+X Ctrl+S`, docs/feat/send-now-c.md):
   * cancel the running turn and start one whose prompt is `messages`, in one
   * daemon step. Resolves with the new turn's events (a `user_message` with
   * the prompt the daemon sent; none for a continuation); rejects on a
   * refusal, and the events reject `Cancelled` if it never started. Not
   * optional: the in-process session that had no `sendNow` is gone, so the only
   * fallback left is the daemon's own `MethodNotFound` (an older daemon).
   */
  sendNow(
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
   * The session's registered built-in tools (`session/tools`,
   * docs/feat/tool-toggles.md D6): group, `~tokens`, switch, `locked`. Absent
   * (a bare test session) → `/tools` says the list isn't available.
   */
  tools?(): Promise<{ readonly tools: readonly ToolEntryView[] }>;
  /**
   * The session's MCP/skill switches as the daemon last reported them
   * (docs/feat/session-capabilities.md S4): undefined until an open says it
   * has them, and when the daemon has none (an older one). Optional with the
   * two below: absent where no daemon owns the session.
   */
  capabilities?(): CapsView | undefined;
  /**
   * Follow the switches: the daemon's state on every snapshot and change (`by`
   * only on a change: the device that made it, untrusted text), undefined when
   * the daemon turns out not to have them. Returns an unsubscribe.
   */
  onCapabilities?(listener: (caps: CapsView | undefined, by?: string) => void): () => void;
  /**
   * `session/set_capability`: turn one MCP server, skill or built-in tool/group
   * (`tool`, docs/feat/tool-toggles.md) on/off for the
   * model. The rows follow the daemon's echo (`onCapabilities`), never this
   * answer. Rejects on a refusal.
   */
  setCapability?(kind: CapKind, name: string, enabled: boolean): Promise<unknown>;
  /**
   * The artifacts the model presented in this session
   * (docs/feat/model-artifacts.md D6/D8), as the daemon's `artifact/list`
   * answered — `truncated` passed on, never dropped. Optional: absent on an
   * older daemon AND on a session whose runtime has no artifact store, and the
   * `/artifacts` panel says so instead of opening empty.
   */
  listArtifacts?(): Promise<ArtifactListResult>;
  /**
   * One artifact version's bytes, verified against `meta` (every chunk's length,
   * the answer's `size`, and the whole's sha256) — docs/feat/model-artifacts.md
   * D6. The opener (S6b) reads through THIS; absent with `listArtifacts` above.
   */
  readArtifact?(meta: ArtifactMeta, options?: ArtifactOpenOptions): Promise<Uint8Array>;
  /**
   * The session is open daemon-side (a fresh or resumed one opens at its first
   * message): no switches yet means "not started", not "not supported".
   */
  opened?(): boolean;
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
   * The session's ARMED scheduled wakes (`schedules`, docs/feat/cron-tool.md S5):
   * the daemon's table, bounded and sanitized by the client (`spec`/`prompt` are
   * a MODEL's text, D5). The current table, if any, is given at once; then every
   * change (create, delete, fire, expiry, failure stop). The rows are MIRRORED
   * structurally (`ScheduleDockRow`), never the protocol's type: the TUI does not
   * depend on it (`background-view.ts`'s rule). Optional: absent on a pod's
   * client and on an older daemon — where no table exists, and painting an empty
   * one would claim there are no wakes.
   */
  onSchedules?(
    listener: (report: {
      readonly rows: readonly ScheduleDockRow[];
      readonly count: number;
    }) => void,
  ): (() => void) | undefined;
  /**
   * Drop one scheduled wake (`session/schedule_delete`). A refusal is a typed
   * RESULT with a `reason`, never a throw: an unknown id, an older daemon, or a
   * client whose daemon is not trusted to schedule (`daemonWakes` off) each say
   * their own. Optional with `onSchedules`.
   */
  deleteSchedule?(scheduleId: string): Promise<{ deleted: boolean; reason?: string }>;
  /**
   * The session's workflow runs (`workflows`, docs/feat/workflows-ui.md D2): the
   * current run plus the last few ended, bounded and sanitized by the client (a
   * `run` step's `reason` is a MODEL's text on its way to a terminal, and a
   * pod's daemon is not trusted). The current list, if any, is given at once;
   * then every change, since a run lives between turns. Optional: absent on a
   * pod's client, on an older daemon and on a client whose daemon is not trusted
   * to run workflows — where no run exists, and painting an empty rail would
   * claim there is none.
   */
  onWorkflows?(listener: (rows: readonly WorkflowRow[]) => void): (() => void) | undefined;
  /**
   * Start, stop or resume a run, or re-run one step (`session/workflow`). A
   * refusal — one run already going, the file's hash changed, an older daemon,
   * a client whose daemon is not trusted — is a typed RESULT with a `reason`,
   * never a throw. The turn id a `start`/`resume`/`rerun_step` is attributed to
   * is the client's own (it alone knows which turns this device began). Optional
   * with `onWorkflows`.
   */
  workflow?(params: WorkflowActionView): Promise<{ ok: boolean; runId?: string; reason?: string }>;
  /**
   * ONE step execution's `prompt`/`report` (`session/workflow_step`, D1): the
   * detail a run's row deliberately does not carry. `detail` absent means "not
   * available" (never ran, or a compaction dropped its entry). Optional: absent
   * on an older daemon.
   */
  workflowStep?(
    runId: string,
    stepId: string,
    attempt?: number,
  ): Promise<{ detail?: WorkflowStepDetail } | { unsupported: true }>;
  /**
   * The project's workflows (`session/workflow_catalogue`, slice 5a / D6): the
   * rows a start screen lists, each with its hash and inputs. A read — nothing is
   * asked, nothing runs. Optional: absent on an older daemon, which answers
   * `{unsupported: true}`.
   */
  workflowCatalogue?(): Promise<WorkflowCatalogueResult | { unsupported: true }>;
  /**
   * What the workflow editor opens for ONE file (`session/workflow_source`,
   * docs/feat/workflow-editor.md D5): its bytes, its draft, its prompts, and
   * either its hash or the validator's errors. A read — nothing is asked,
   * nothing runs, nothing is written. Optional: absent on an older daemon, which
   * answers `{unsupported: true}`.
   */
  workflowSource?(name: string): Promise<WorkflowSourceResult | { unsupported: true }>;
  /**
   * The editor's write (`session/workflow_save`): `dryRun: true` is Review (every
   * check, nothing written), `false` writes and refuses `changed` unless
   * `baseHash` is still the file's. A refusal is a RESULT (`refusal` + `reason`),
   * never a throw; an older daemon answers `{unsupported: true}`. Optional: the
   * TUI has no editor in this task.
   */
  workflowSave?(
    request: WorkflowSaveRequestView,
  ): Promise<WorkflowSaveResult | { unsupported: true }>;
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

/** Where the session is, as the badge paints it (`local`: no badge, today's rule). */
export interface HopTargetView {
  /** `local`, or the workload as the badge and every notice say it. */
  readonly place: HopPlaceView;
  /** The status bar's accent badge; absent for `local` (as a plain TUI has none). */
  readonly badge?: TargetBadge;
  /** The daemon now runs in a pod: a spilled result's file is "saved in the pod". */
  readonly daemonInPod: boolean;
  /**
   * The daemon session's own cwd after a hop (its `session/list` entry) — what
   * the footer and a tool ask show; absent → the laptop's
   * (docs/fix/session-hop-live.md D4).
   */
  readonly cwd?: string;
}

/**
 * A place, structurally the cli's `HopPlace` (the TUI does not depend on the
 * cli): `local`, or an engine + workload name (+ the k8s container).
 */
export type HopPlaceView =
  | { readonly kind: "local" }
  | {
      readonly kind: "workload";
      readonly engine: "kubernetes" | "docker" | "podman";
      readonly name: string;
      readonly container?: string;
      /** k8s only (OD1): the namespace, printed as `kubernetes:<ns>/<pod>[/<c>]`. */
      readonly namespace?: string;
    };

/** The place the session is at NOW, and every later move (`AppProps.targetFeed`). */
export interface TargetFeed {
  current(): HopTargetView;
  /** Told of every move; returns the unsubscribe. */
  onTarget(listener: (view: HopTargetView) => void): () => void;
}

/** What one started hop reports while it runs. */
export interface HopRun {
  /**
   * The phase lines the hop reports (the orchestrator's own words, D6), until it
   * settles. A feed, like every other one here (`onLinkStatus`, `onTarget`): the
   * host emits, the App paints; returns the unsubscribe.
   */
  onStatus(listener: (line: string | null) => void): () => void;
  /**
   * Settles when the hop is over: the target's controller on success (the App
   * swaps to it with `keepTranscript`), or the one line saying why it did not
   * move. Never rejects — a hop always answers the view. `note`: what went
   * wrong AFTER the move (`the old session did not close`, a leave notice) —
   * the App's one moved line carries it; nobody else says the outcome.
   */
  readonly done: Promise<
    | { readonly moved: SessionController; readonly view: HopTargetView; readonly note?: string }
    | { readonly failed: string }
  >;
}

/**
 * `/move` (docs/feat/session-hop.md D3): present only where a session MAY move
 * — the local worker TUI and a TUI already on a hop target (D8). Every effect
 * (building the target, the plan's refusals, the commit) is the host's; the App
 * only decides WHEN, from its own turn state (D4), and moves the view.
 */
export interface HopFeed {
  /** Where the session is going, for the status row before the first phase. */
  label(spec: HopSpec): string;
  /**
   * Start the hop. `sessionId` is the uid of the session being moved — the App
   * knows it (its controller's `sessionId`), and the host cannot guess it without
   * minting a second one (D1 step 3 seeds the SAME uid). `opts.gateAnswered`: the
   * owner approved a PROPOSAL whose prompt already carried the mount gate's
   * warning (D9/M6), so the build must not ask a second time.
   */
  start(
    spec: HopSpec,
    sessionId: string | null,
    opts?: { gateAnswered?: true; namespace?: HopNamespace },
  ): HopRun;
  /**
   * Abort the hop in flight (D3's `/move cancel`). Optional: a host that cannot
   * stop a build half-way leaves it to its own failure path, and the App then
   * only clears a QUEUED hop.
   */
  cancel?(): void;
  /**
   * One event of a turn, forwarded as it streams (docs/feat/session-hop.md D9,
   * slice H5). The host folds it (`cli/src/hop-turn.ts`, pure) to see a
   * `move_session` call finish; the App decides NOTHING here and keeps no state —
   * it only reports what its own stream saw, `own` being its own-turn fact.
   * Present only where the host offers the tool at all (D8's other origins have
   * no proposal to watch).
   */
  turn?(event: SessionEvent, own: boolean): void;
  /**
   * The turn is over: ask the owner, if the model proposed a move (D9). The host
   * puts ONE `session_hop` request through the single broker (auto-accept answers
   * it only when the laptop's own rule marked it, docs/feat/session-hop-ux OD4),
   * and resolves with what its answer means for the App: an approved spec to move
   * (the App starts it as if it had been typed), or nothing. It never rejects: an
   * unaskable prompt is a refusal, and the model is told.
   */
  turnEnd?(own: boolean): Promise<HopProposalView>;
  /**
   * The line the next REAL prompt must carry, CONSUMED by this read (review M7):
   * `[move declined]`, `[session moved to …]`, `[move failed: …]`. It belongs to
   * exactly one prompt, so it can neither be lost nor repeated. `ctx.autoAccept`
   * is the TUI's LIVE mode: the host renders the line from it at this moment, so a
   * moved line never states a stale `auto-accept on|off` (OD6).
   */
  takeLine?(ctx: { readonly autoAccept: boolean }): string | null;
  /**
   * Hand the line taken by the last `takeLine` BACK: the prompt that consumed it
   * never ran (its send failed — a link down, a lost slot), so the line must not
   * die with it (docs/feat/session-hop-ux, failure mode "Wake prompt fails to
   * send"). The next real prompt carries it instead, so the model still learns
   * that the session moved. A no-op when nothing was taken or a NEWER fact has
   * arrived since (that one describes the world better).
   */
  restoreLine?(): void;
  /**
   * Forget the pending fact: a `/clear` swaps the session, so a fact about the OLD
   * one (its place, its cwd) must not ride the new one's first prompt (OD6).
   */
  clearPending?(): void;
}

/**
 * What a turn's end decided about a proposal, as the App needs it (structurally
 * the cli's `HopProposalOutcome`, which is where the decision is made).
 */
export type HopProposalView =
  | { readonly kind: "none" }
  /**
   * `gateAnswered`: the prompt this Yes answered already carried the mount gate's
   * warning. `autoAccepted`: NO prompt was shown (auto-accept answered it, OD4).
   * `namespace`: k8s only, the pin's PROVENANCE (OD3) — the answer the turn end
   * resolved, carried to the build so the row and the outcome state WHY that
   * namespace instead of re-resolving (a re-resolution always says `explicit`,
   * fix round 2 finding 1).
   */
  | {
      readonly kind: "approved";
      readonly spec: HopSpec;
      readonly gateAnswered?: true;
      readonly autoAccepted?: true;
      readonly namespace?: HopNamespace;
    }
  | { readonly kind: "declined" }
  /** The pin or the ask could not be made at all (a kubeconfig with no context): nothing moved. */
  | { readonly kind: "failed" };

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
  /**
   * This tentacle's release version, painted in the startup header's first line
   * (docs/feat/tui-mascot.md D5). The TUI package cannot import it (cli → tui),
   * so the CLI passes it; absent → the line is `tentacle` alone.
   */
  readonly version?: string;
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
   * Voice dictation settings (docs/feat/voice-dictation.md). Absent: the defaults
   * in `voice-session.ts` (`VOICE_DEFAULTS`) — OFF, Ctrl+R, `auto` language,
   * no auto-stop. A LOCAL input device: never carried to a pod, and the helper is
   * only ever spawned when `voiceAvailability` says this is a local Mac terminal.
   */
  readonly voice?: VoiceConfig;
  /**
   * Where the helper's log and `<configDir>/voice/bin` live. The CLI passes the
   * real config dir (Review round 1, MEDIUM 8: absent, the log path was
   * `/voice/helper.log`). Absent in a test/host-less mount: no log file is opened.
   */
  readonly voiceConfigDir?: string;
  /**
   * TEST ONLY: the voice helper spawner. The real one is `Bun.spawn`; a test
   * passes a fake so no child process (and no microphone) exists in `bun test`.
   */
  readonly voiceSpawner?: VoiceSpawner;
  /**
   * TEST ONLY: the platform/env `voiceAvailability` reads. Default: this
   * process's. A test passes `{ platform: "darwin", env: {} }` so it does not
   * fail on a Linux runner or over SSH (Review round 1, MEDIUM 6).
   */
  readonly voiceHost?: {
    readonly platform: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
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
  /**
   * The OS side of opening an artifact (docs/feat/model-artifacts.md D8, S6b):
   * write the planned temp file and spawn the OS opener, or save a copy to
   * `~/Downloads`. The DECISION (name, CSP wrap, a pod's confirm) is
   * `artifact-open.ts`'s and the bytes come from `readArtifact` (verified); this
   * port only executes. `startTui` passes `createArtifactOpener()`. Absent → the
   * App says opening is not available here, and nothing is read or opened.
   */
  readonly artifactOpener?: ArtifactOpener;
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
   * The session's auto-accept is SHARED with other devices (docs/feat/
   * session-auto-accept.md D5): a flip this TUI did not make adds one
   * transcript notice naming its device. The routing feed, when it routes to a
   * shared session; absent for a pod's or a detached run's laptop-only feed.
   */
  readonly autoAcceptShared?: AutoAcceptSharedFeed;
  /**
   * `/move` (docs/feat/session-hop.md D3): this session may move to another
   * target. Absent → `/move` says it is not available here (D8).
   */
  readonly hop?: HopFeed;
  /**
   * Where the session is, live (`docs/feat/session-hop.md` D2/D3): the badge and
   * `daemonInPod` follow a hop. Absent → the static `target`/`daemonInPod` props.
   */
  readonly targetFeed?: TargetFeed;
  /**
   * The width to render at, overriding the terminal's (`ink-testing-library`
   * reports 100). Never set by a runtime: it exists so a frame test can pin a
   * tier (the dock's 100/80/56, docs/feat/subagent-panel.md).
   */
  readonly columns?: number;
  /**
   * A chart's plot glyphs (`tui.chartGlyphs`, docs/feat/model-charts.md D5):
   * absent → `braille` (2×4 dots per cell); `blocks` is for a font with no
   * braille, which a terminal cannot report. A LAPTOP-ONLY display setting:
   * constant for the App's lifetime, never carried to a pod.
   */
  readonly chartGlyphs?: ChartGlyphs;
}
