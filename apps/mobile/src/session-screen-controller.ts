/**
 * The session screen's wiring (docs/feat/mobile-session-view.md 12c): open/
 * attach, the transcript feed, the composer's taps, the permission sheet, and
 * the thumbnails window — pure and injected, so `SessionScreen.tsx` maps a state
 * to elements and owns nothing but looks (AGENTS §7).
 *
 * The invariants it keeps, all of them the plan's:
 * - **ONE broker.** The sheet's requester is set on the client's own broker on
 *   open and `reset()` on leave — never a second `PermissionBroker` (AGENTS §7
 *   "single broker"): with no requester set, a daemon-side ask WAITS.
 * - **Leaving detaches.** `leave` is `RemoteSession.detach` (via the controller),
 *   never `close()`: the session keeps running for every device (decision 4).
 * - **Nothing is lost.** A send the daemon refused before the ack puts its text
 *   back (F13); a link that drops keeps the rows and the draft (F8, F12).
 */
import type { RemoteSession, SessionEvent } from "@tentacle/client";
import type { PermissionBroker, PermissionRequester } from "@tentacle/core";
import type {
  ArtifactListResult,
  ArtifactMeta,
  AttachmentRef,
  DocumentContent,
  JobOutputResult,
  JobRow,
  ScheduleRow,
  SessionContextResult,
  SessionSkillsResult,
  SubagentRow,
} from "@tentacle/protocol";
import { DomainErrorCode } from "@tentacle/transport";
import { RpcError } from "@tentacle/transport";
import { type ActivityMemory, emptyMemory, markOpened, onSubagents } from "./activity-memory.ts";
import type { AppStateName } from "./app-lock.ts";
import type { ArtifactFeed } from "./artifact-feed.ts";
import {
  type ArtifactJoin,
  EMPTY_JOIN,
  joinRows,
  phaseOfError,
  withList,
  withLiveCards,
  withPhase,
} from "./artifact-join.ts";
import {
  COMPACTED_SHOWN_MS,
  type OutcomeLine,
  type SlotView,
  clearOutcome,
  compactOutcome,
  slotView,
} from "./compact-slot.ts";
import type {
  Compose,
  ComposeHandle,
  DocumentPort,
  PhotoPort,
  SendNowStart,
} from "./compose-controller.ts";
import { createCompose } from "./compose-controller.ts";
import {
  type ComposerAction,
  FAILED_NOTICE,
  REFUSED_NOTICE,
  RESYNC_FAILED_NOTICE,
  composerAction,
  restoreAfterFailure,
  returnKeyAction,
} from "./composer.ts";
import type { OutboxDriver } from "./outbox-driver.ts";
import { untilAccepted } from "./outbox-session.ts";
import type { OutboxStore } from "./outbox-store.ts";
import type { OutboxItem } from "./outbox.ts";
import {
  type PermissionSheet,
  type SheetState,
  createPermissionSheet,
} from "./permission-sheet.ts";
import type { QueueTrace } from "./queue-trace.ts";
import { createRenderCoalescer } from "./render-coalesce.ts";
import { type CommandRow, clearConfirm, commandRows } from "./session-commands.ts";
import type { SessionController, SessionHandle, SessionOpenFailure } from "./session-controller.ts";
import { type ForeignTurn, createSessionFeed } from "./session-feed.ts";
import {
  type InfoPort,
  type SessionInfoState,
  createSessionInfo,
} from "./session-info-controller.ts";
import {
  type RenameState,
  renameErrorText,
  renamePlan,
  titleAfterRename,
} from "./session-rename.ts";
import {
  JOB_LINES,
  type SentMemory,
  killChildOutcome,
  killJobOutcome,
  messageOutcome,
  pruneSent,
  recordSent,
} from "./subagent-detail.ts";

export type { RenameState };
import type { ComposeBarView, OutboxRowView, SessionViewInput } from "./session-view.ts";

import { type SessionStatus, type SessionView, sessionView } from "./session-view.ts";
import {
  type ThumbnailDriver,
  type ThumbnailSource,
  type ThumbnailState,
  createThumbnailDriver,
  initialThumbnails,
} from "./thumbnails.ts";
import { type LocalPhoto, documentLabels } from "./transcript-rows.ts";
import { type State, apply, initialState } from "./transcript.ts";

/**
 * The background-work members of `RemoteSession` the Activity sheet uses
 * (docs/feat/mobile-chrome.md Design 5): the live lists, their subscriptions and
 * the actions. Optional: a fake handle (or an older client) has none, and the
 * sheet then shows nothing (F15).
 */
export type ActivityHandle = Partial<
  Pick<
    RemoteSession,
    | "subagents"
    | "onSubagents"
    | "onSubagentMessage"
    | "messageSubagent"
    | "killSubagent"
    | "onJobs"
    | "jobOutput"
    | "killJob"
  >
>;

/**
 * The session's armed scheduled wakes (docs/feat/cron-tool.md S6; the hub's
 * Scheduled item, docs/feat/mobile-hub.md H4a). The SAME client seam the Session
 * info sheet follows (`RemoteSession.schedules`/`onSchedules`, gated by the
 * client's `daemonWakes` trust bit) — not a second subscription mechanism.
 * Optional: a fake handle, or a client whose daemon must not be trusted, has none.
 */
export type WakeHandle = Partial<Pick<RemoteSession, "schedules" | "onSchedules">>;

/**
 * What the Activity sheet reads (slice S8): the daemon's live lists as last
 * reported (`null` until one is), and the phone's Finished memory.
 */
export interface ActivityState {
  readonly subagents: readonly SubagentRow[] | null;
  readonly jobs: { readonly rows: readonly JobRow[]; readonly count: number } | null;
  readonly memory: ActivityMemory;
  /** The person's messages to each child, from the daemon's echo (S9; this attach only). */
  readonly sent: SentMemory;
  /** The open child's detail: its message field and the last action's notice (S9). */
  readonly child: ChildAction | null;
  /** The open shell job's detail: its last output read (S9). */
  readonly job: JobAction | null;
  /**
   * The last ROW Stop's refusal/doubt, by row id (mobile-activity-panel Design 4):
   * a stop fired from a row has no detail to show it in, so it rides the row's
   * meta and is cleared by the next activity update (or a new stop).
   */
  readonly stopNotices: Readonly<Record<string, string>>;
}

export interface ChildAction {
  readonly id: string;
  readonly draft: string;
  /** A message or a Stop is in flight. */
  readonly busy: boolean;
  readonly notice: string | null;
}

export interface JobAction {
  readonly id: string;
  /** The last read; `null` until the first one lands. */
  readonly output: JobOutputResult | null;
  /** A read or a Stop is in flight. */
  readonly busy: boolean;
  readonly notice: string | null;
}

/** What a handle without the S9 members (an older client or daemon) says: a typed refusal (F15). */
export const ACTIVITY_UNSUPPORTED = "This computer's tentacle cannot do this.";

/** A handle this screen can also prompt (what the composer's Send needs). */
export interface SendableHandle extends SessionHandle, ActivityHandle, WakeHandle {
  send(
    prompt: string,
    signal?: AbortSignal,
    opts?: {
      readonly turnId?: string;
      readonly attachments?: readonly AttachmentRef[];
      /** The prompt's attached PDFs (docs/feat/pdf-read.md D7, the wire's blocks). */
      readonly documents?: readonly DocumentContent[];
      /** The daemon's ack (`RemoteSession.send`): it holds the turn's key. */
      readonly onAccepted?: () => void;
    },
  ): AsyncIterable<SessionEvent>;
  /**
   * The session's own-vs-foreign turn test (`RemoteSession.autoAcceptsTurn`, the
   * WIDEST the session offers — own turns, and on a trusted `serve` its own wake
   * turns). Absent on a handle that decides nothing: see `autoAcceptsTurnOf`.
   */
  readonly autoAcceptsTurn?: (turnId: string) => boolean;
  /**
   * The session's title changes (`RemoteSession.onTitle`, the daemon's
   * `session_title`): a rename on ANY device reaches the header.
   */
  onTitle?(listener: (notice: { readonly title: string }) => void): () => void;
  /**
   * The skills this session has (`RemoteSession.skills()`, `session/skills`): what
   * Session info lists. Optional because a fake handle need not answer, and an
   * older daemon rejects it — the caller's section then says so (F2/F4).
   */
  skills?(): Promise<SessionSkillsResult>;
  /** The context this session would send now (`session/context`). */
  context?(): Promise<SessionContextResult>;
  /** Rename it (`session/rename`, the TUI's `/rename` path). */
  rename?(title: string): Promise<string>;
  /**
   * Compact it (`RemoteSession.compact`, docs/feat/mobile-hub-commands.md C2): an
   * abort of `signal` cancels it daemon-side. Absent → no Compact row (P6).
   */
  compact?(signal?: AbortSignal): Promise<{ readonly before: number; readonly after: number }>;
  /** Clear it (`RemoteSession.clear`); the daemon keeps the dropped chat archived. Absent → no row. */
  clear?(): Promise<{ readonly before: number; readonly after: number }>;
  /**
   * The artifacts presented in this session (`RemoteSession.listArtifacts`,
   * docs/feat/model-artifacts.md D9): what puts a card under a resumed
   * transcript's `present` row and fills the gallery. Absent on a fake handle —
   * the screen then reads `unsupported`, exactly like an older daemon.
   */
  listArtifacts?(): Promise<ArtifactListResult>;
  /**
   * One version's verified bytes (`RemoteSession.readArtifact`): the card's
   * thumbnail and the viewer's file. Optional for the same reason.
   */
  readArtifact?(
    meta: ArtifactMeta,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array>;
}

/**
 * A handle's own-turn test, when it has one. The screen hands it to the sheet
 * LIVE (the handle only exists after the attach), so a handle without one keeps
 * the sheet's stricter rule: a NAMED turn is the app's, an ask with no turn id
 * never is (`permission-sheet.ts`; docs/feat/session-auto-accept.md D4).
 */
export function autoAcceptsTurnOf(
  handle: SendableHandle | null,
): ((turnId: string) => boolean) | undefined {
  const test = handle?.autoAcceptsTurn;
  return typeof test === "function" ? (turnId: string) => test.call(handle, turnId) : undefined;
}

export interface SessionScreenState {
  readonly status: SessionStatus;
  readonly transcript: State;
  readonly draft: string;
  /** A refused/failed send's notice, shown above the composer until the next one. */
  readonly notice: string | null;
  readonly view: SessionView;
  readonly sheet: SheetState;
  readonly thumbnails: ThumbnailState;
  /** The compose half (13d): the queue, the chips, the outbox. */
  readonly compose: ComposeBarView;
  /**
   * Session info (docs/feat/mobile-session-info.md): the sheet's value, `null`
   * while it is closed. The header's model and context bar live in `view`.
   */
  readonly info: SessionInfoState | null;
  /** Whether the rename field is open (Owner decision 5: tap the title). */
  readonly renaming: RenameState | null;
  /**
   * How many presses SENT the field: a Send, Return, queued steer or Send later
   * that cleared a non-empty field (never Stop, a blank Return, or a second tap
   * that found it empty, F4). The screen dismisses the keyboard and remounts the
   * field on each change (docs/fix/mobile-chat-glitches.md, items 5/6).
   */
  readonly sends: number;
  /** Background sub-agents and shell jobs (docs/feat/mobile-chrome.md S8). */
  readonly activity: ActivityState;
  /**
   * The session's armed scheduled wakes as the daemon last reported them
   * (docs/feat/cron-tool.md S6): `undefined` when no table was reported — no
   * report yet, an older daemon, or a daemon this client must not trust. The
   * hub's Scheduled item is absent on `undefined` (P6/M9), never a dead button.
   */
  readonly schedules: readonly ScheduleRow[] | undefined;
  /**
   * A pull-to-refresh is running (item 3): the `RefreshControl` stays spinning
   * until the re-attach settles, so the gesture never looks ignored.
   */
  readonly refreshing: boolean;
  /**
   * The session's artifacts (docs/feat/model-artifacts.md D9): the list the
   * gallery reads, the per-call join its rows carry, and the phase a screen says
   * when it cannot have them (an older daemon, a dropped link).
   */
  readonly artifacts: ArtifactJoin;
  /** The footer's compaction slot (`compact-slot.ts`), null when none shows. */
  readonly slot: SlotView | null;
  /** The Commands sheet's rows (`session-commands.ts`), always computed. */
  readonly commands: readonly CommandRow[];
}

/**
 * What the compose half needs from the screen (13d). Everything the screen
owns
 * is passed in; everything else is the app's (`compose-controller.ts`).
 */
export interface ComposeWiring {
  readonly computerId: string;
  readonly store: OutboxStore;
  /**
   * 13b's driver for this screen, built with the prompt the COMPOSE acts carry: the
   * turn it starts folds into THIS transcript (a drained stream would show no turn
   * and no answer — 13d's flow 07/18). The app owns the store; the driver is per
   * screen, because the fold is.
   */
  readonly driver: (prompt: {
    readonly prompt: (
      text: string,
      turnId: string,
      refs: readonly AttachmentRef[],
      photos?: readonly LocalPhoto[],
      /** The attached PDFs' wire blocks (D7): the driver's own prompt names them. */
      documents?: readonly DocumentContent[],
    ) => Promise<void>;
    /** 13b's hand-back: an item whose text belongs in the field (F7/F20). */
    readonly onDraft: (item: OutboxItem, why: "archived" | "deleted" | "gone" | "busy") => void;
    /**
     * How much of an item's photo upload the daemon has confirmed, 0–1, or null
     * when nothing is in flight (feat/mobile-thinking-images S4). The screen keeps
     * it in memory and the row draws it; the outbox file never does.
     */
    readonly onProgress: (itemId: string, fraction: number | null) => void;
    /**
     * This screen's OWN compose handle, once the attach answered — what the
     * driver's port must be built over (fix/mobile-media-live item 1). A second
     * `RemoteSession` for the same id replaces the client's stream listener, so
     * the driver opening one steals the very turn it starts ("Running" for ever,
     * no reply — while the daemon finished it).
     */
    readonly handle: () => ComposeHandle | null;
  }) => OutboxDriver;
  readonly photos: PhotoPort;
  /**
   * The PDF adapter (docs/feat/pdf-read.md D7). Absent: this build cannot pick a
   * file — the `+` sheet then offers no PDF row and says so.
   */
  readonly documents?: DocumentPort;
  /**
   * The person's "Send photos at original size" (item 5), read at every pick.
   * Absent = the downscale (the default).
   */
  readonly sendPhotoOriginalSize?: () => boolean;
  /**
   * The chat handle's compose side, once the attach answered — built over THIS
   * screen's own attach handle (owner B4: a port without it could not read the
   * session's facts, so every send died silently after clearing the field).
   */
  readonly handle: (session: SendableHandle) => ComposeHandle | null;
  /** Write the draft (13b's store: the text and the chip copies that outlive the screen). */
  readonly draft: (text: string, photos: readonly string[]) => void;
  readonly mint: () => string;
}

export interface SessionScreenDeps {
  readonly sessionId: string;
  /** The route said it was in the Archived section (Opened with Reopen, Owner Q4). */
  readonly archived: boolean;
  readonly title: string;
  readonly project: string;
  /**
   * The session's working folder as the tapped list row knew it (`SessionRoute.cwd`).
   * Absent → the screen asks `session/list` once after an attach
   * (docs/feat/mobile-header-status.md).
   */
  readonly cwd?: string;
  readonly controller: SessionController<SendableHandle>;
  /**
   * The client's ONE broker: the sheet's requester is set on it on open and
   * withdrawn on leave. `reset(requester)` withdraws ONLY the requester named,
   * so a release that arrives after a newer screen mounted its own leaves that
   * one in place (AGENTS §7 "single broker": a cleared requester holds asks
   * silently).
   */
  readonly broker: Pick<PermissionBroker, "setRequester" | "reset">;
  readonly now: () => number;
  /**
   * The queue-diagnosis trace (docs/fix/mobile-queued-stuck.md): the app's ONE
   * app-log sink, already bound to this session's id. Absent: nothing is traced
   * and no behaviour changes (every test that predates it passes it not at all).
   */
  readonly trace?: QueueTrace;
  /** Injectable for tests: the sheet's clock/arm window and the thumbnail port. */
  readonly sheet?: (deps: { readonly now: () => number }) => PermissionSheet;
  readonly thumbnails?: ThumbnailSource;
  /**
   * This phone's own device name (the one it paired under), for ask's "also
   * asked on" note never naming the device it is shown on
   * (docs/feat/session-auto-accept.md D7). Absent → nothing is dropped.
   */
  readonly phoneName?: () => string | undefined;
  /** Told whenever the state changes (a React setState in the screen). */
  readonly onChange?: (state: SessionScreenState) => void;
  /**
   * The coalescing timer (docs/fix/mobile-fan-jank-device.md): a streamed
   * delta's re-render is armed on it. Injectable for tests; `setTimeout` by default.
   */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * Told once per streamed delta folded (the perf trace's `folds`,
   * docs/fix/mobile-fan-jank-device.md). Diagnostic only.
   */
  readonly onStreamFold?: () => void;
  /** The compose half (13d). Absent: a screen with no queue and no photos (12c's tests). */
  readonly compose?: ComposeWiring;
  /**
   * Session info (docs/feat/mobile-session-info.md): the port the sheet pulls
   * through, built over the ONE client stack. It takes an accessor because the
   * session's handle only exists AFTER the attach (`skills`/`context`/`autoAccept`
   * are the handle's), and the screen is built first.
   */
  readonly info?: (handle: () => SendableHandle | null) => InfoPort;
  /**
   * The artifacts feed this screen PUBLISHES on (docs/feat/model-artifacts.md D9):
   * the gallery screen holds no handle of its own (a second `RemoteSession` of
   * one id steals this screen's stream), so it reads what this one learned.
   * Absent: the join still reaches the rows and the sheet, nothing is published.
   */
  readonly artifacts?: { readonly feed: ArtifactFeed };
}

export interface SessionScreenController {
  state(): SessionScreenState;
  /** The screen's subscription: every state change, plus an unsubscribe. */
  subscribe(listener: (state: SessionScreenState) => void): () => void;
  /** Attach (and re-attach on a Retry). `reopen`: the person's Reopen button. */
  open(reopen?: boolean): Promise<void>;
  /** The Retry button. */
  retry(): void;
  /** The Reopen button (only an archived failure offers it). */
  reopen(): void;
  setDraft(text: string): void;
  /** A tap on the composer's one button. */
  press(): void;
  /**
   * The hub's Stop (docs/feat/mobile-hub.md P2): the composer's own stop branch,
   * decided as if the field were blank — a draft never turns it into a steer.
   * A no-op unless that resolves to `stop` (a turn runs, the link is up).
   */
  stopTurn(): void;
  /**
   * The keyboard's Return (B2): `press` only when `returnKeyAction` allows it on
   * the CURRENT action — never a Stop, never a no-op clear.
   */
  pressReturn(): void;
  /** Up/Down (the client's `onLinkStatus`): the banner's `reconnecting`. */
  link(up: boolean): void;
  /**
   * The app came FOREGROUND (docs/fix/mobile-open-at-end.md, item 2): resync
   * silently, once per transition, when a session is open and the link is up.
   * The bug class `docs/fix/mobile-media-live.md` fixed (updates lost while the
   * link stayed up) had no automatic recovery; this is it — the same
   * `resync()` the pull-to-refresh runs, through the same attach path.
   *
   * The input is the app state itself, not a bare "active" edge: iOS delivers
   * `active` twice for one foreground, and only the transition that FOLLOWS a
   * departure may resync (the first `active` is the mount's own open).
   *
   * Returns whether this call STARTED a re-attach: the screen then re-arms its
   * silent landing (Review round 1, MEDIUM 3), so a foreground resync's history
   * lands at the end without being seen scrolling — exactly what a pull does.
   */
  appState(state: AppStateName): boolean;
  /** Session info opened: start every pull (F1–F5 live in the controller). */
  openInfo(): Promise<void>;
  /** The sheet closed: drop in-flight answers and stop following the link (F5). */
  closeInfo(): void;
  /** Pull-to-refresh, and a `Retry` row (and the port's link `up`, its own). */
  refreshInfo(): Promise<void>;
  /**
   * Re-run ONLY the MCP and skill pulls (docs/feat/mobile-hub-tools.md D4): the
   * hub's dimmed Tools item refreshes the counts that dimmed it, without opening
   * Session info. Resolves when both settled (never rejects).
   */
  pullTools(): Promise<void>;
  /**
   * Re-read `artifact/list` (docs/feat/model-artifacts.md D9). Single-flight: a
   * gallery mount, a refresh request and a landed list at the same moment cost
   * ONE call. Resolves when it settled (never rejects).
   */
  refreshArtifacts(): Promise<void>;
  /** The auto-accept switch (Owner Q3, F11). */
  setAutoAccept(on: boolean): Promise<void>;
  /** The switch's value NOW (the session's shared link: a flip elsewhere is here). */
  autoAcceptOn(): boolean;
  /** An MCP server's or skill's switch (docs/feat/session-capabilities.md S5). */
  setCapability(kind: "mcp" | "skill", name: string, enabled: boolean): Promise<void>;
  /**
   * Delete one armed scheduled wake (docs/feat/cron-tool.md S6, M7): the row's
   * RAW id. The row leaves when the daemon's next table says so — never on a
   * local echo — and a refusal shows the daemon's own reason under the rows.
   */
  deleteSchedule(scheduleId: string): Promise<void>;
  /** Tapping the title: the rename field opens on the CURRENT title (Owner 5). */
  beginRename(): void;
  /** What is typed into it. */
  setRenameText(text: string): void;
  /** Save it: a no-op when empty/unchanged, else `session/rename`. */
  submitRename(): Promise<void>;
  /** Dismiss it without saving. */
  cancelRename(): void;
  /** The person opened a Finished child's report: it is no longer "new" (S8). */
  openReport(agentId: string): void;
  /** A child's detail opened (S9): a fresh message field, no notice. */
  openChild(agentId: string): void;
  /** What is typed into the open child's message field. */
  setChildDraft(text: string): void;
  /** Send the field to the open child; a refusal or a throw keeps it and says why (F14). */
  messageChild(): Promise<void>;
  /** Stop the open child (after the screen's confirm, F17); `{killed:false}` → "already finished". */
  stopChild(): Promise<void>;
  /** A shell job's detail opened: read its output tail (S9). */
  openJob(jobId: string): Promise<void>;
  /** Read the open job's output again (pull to refresh). */
  refreshJob(): Promise<void>;
  /** Stop the open job (after the confirm), then read how it ended (F19). */
  stopJob(): Promise<void>;
  /**
   * Stop a ROW's child or job without opening its detail (mobile-activity-panel
   * Design 4): the row's two-tap arm IS the confirmation. Reuses the detail's
   * kill path (same handling, same wording); the outcome lands on the row.
   */
  stopRow(kind: "child" | "job", id: string): Promise<void>;
  /** The detail closed (back to the list, or the sheet closed). */
  closeDetail(): void;
  /** The person's tap on a link: the sheet's confirmation is the screen's job. */
  onLink(href: string): void;
  /** The FlatList's visible window: which images want bytes (12b's driver). */
  window(first: number, last: number, rows: readonly { readonly kind: string }[]): void;
  /** A permission tap, from the sheet's own UI. */
  sheet(): PermissionSheet;
  /** The photo button's answer: the Library picker or the Camera (13d, D5). */
  pickPhoto(source: "library" | "camera"): Promise<void>;
  /** The `+` sheet's "File (PDF)" (docs/feat/pdf-read.md D7). */
  pickDocument(): Promise<void>;
  /** A chip's × : forget that photo (13d). */
  removeChip(key: string): Promise<void>;
  /** **Send now**, beside the queue (13d, D1). */
  sendNow(): Promise<void>;
  /** A pending bubble's ⇥ Send now: that message alone, the field untouched (Q4). */
  sendNowRow(id: string): Promise<void>;
  /** **Edit** a pending message (docs/feat/mobile-queued-compose.md D6). */
  edit(id: string): Promise<void>;
  /** **Cancel** a pending message (D6). */
  cancel(id: string): Promise<void>;
  /** The editing banner's × (D6): the message is queued again, a new id. */
  editCanceled(): Promise<void>;
  /** A tap on another device's returned row (13d, D3: an explicit act). */
  take(id: string): Promise<void>;
  /** The outbox's four answers, for one item (13d, D4). */
  outbox(
    what: "send" | "steer" | "discard" | "edit" | "open" | "close",
    itemId?: string,
  ): Promise<void>;
  /** The screen unmounted: detach, withdraw the sheet, release the requester. */
  leave(): Promise<void>;
  /**
   * Pull-to-refresh (item 3): re-read this session from the daemon — the reopen
   * the owner did by hand. Replaces the rows from the daemon's history, never
   * appends them; a failed re-attach keeps the rows and says so once.
   */
  resync(silent?: boolean): Promise<void>;
  /** Unsubscribe everything (the screen's cleanup, after `leave`). */
  dispose(): void;
  /**
   * The Commands sheet (docs/feat/mobile-hub-commands.md C2 item 13). Compact:
   * refused unless the link is up, idle and nothing else runs; its outcome is a
   * line, its success the separator + `Compacted ✓`.
   */
  compact(): Promise<void>;
  /** Stop this phone's compaction (the hub's Stop routes here while it runs). */
  cancelCompaction(): void;
  /** Clear's row tapped: the row opens into Cancel / Clear. */
  armClear(): void;
  /** Its Cancel. */
  cancelClear(): void;
  /** Its Clear: runs only when armed (`clearConfirm`), then folds the line. */
  clear(): Promise<void>;
  /** Re-send the last prompt's TEXT through the composer's own send path. */
  retryLast(): void;
}

/**
 * Whether the daemon keeps a cleared chat as an archived session: the phone
 * reaches only `serve` sessions, and `serve` is the daemon with a persister
 * (the plan's load-bearing assumption). A pod path would make this false
 * (eval container-sessions-mobile owns that answer).
 */
const FORK_KEPT = true;
/** Retry re-sends text only (the TUI's `/retry`, decision 8). */
export const RETRY_PHOTOS_NOT_SENT = "the photos were not re-sent";
export const RETRY_FILES_NOT_SENT = "the files were not re-sent";

/** The outbox's rows, from `session-view.ts`'s own projection (never built here). */
function outboxRows(
  items: readonly OutboxItem[],
  base: Omit<SessionViewInput, "outbox">,
  /** The in-memory upload percentages (feat/mobile-thinking-images S4). */
  progress: ReadonlyMap<string, number>,
): readonly OutboxRowView[] {
  return sessionView({ ...base, outbox: items, outboxProgress: progress }).outbox;
}

/** A send refused before the ack is given back, not failed (F13). */
function refusedBeforeStart(error: unknown, streamed: boolean): boolean {
  if (streamed) {
    return false;
  }
  return error instanceof RpcError && error.code === DomainErrorCode.TurnInProgress;
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export function createSessionScreen(deps: SessionScreenDeps): SessionScreenController {
  /** `Loading…` from the first render: the screen mounts already attaching. */
  let status: SessionStatus = { phase: "opening" };
  /** One attach at a time (a `Retry`/`Reopen` during one is a no-op tap). */
  let attaching = false;
  let transcript: State = initialState;
  /**
   * The session's artifacts (docs/feat/model-artifacts.md D9): the daemon's list,
   * the per-call join, and the phase that says why there is none. `loading` until
   * the first answer — never `ready` with an empty list, which would claim a
   * session has no artifacts before anyone looked.
   */
  let join: ArtifactJoin = EMPTY_JOIN;
  /** The `artifact/list` call in flight: one at a time (a gallery mount + a resync). */
  let joinPending: Promise<void> | null = null;
  let draft = "";
  /**
   * The outbox's upload percentages, by item id (feat/mobile-thinking-images S4):
   * the driver's `onProgress`, kept here because it is SCREEN state and memory
   * only — the outbox file never carries it, so no stale "62 %" survives a restart.
   */
  const outboxProgress = new Map<string, number>();
  /** Presses that sent the field (`SessionScreenState.sends`). */
  let sends = 0;
  let notice: string | null = null;
  let thumbnails: ThumbnailState = initialThumbnails;
  let handle: SendableHandle | null = null;
  let foreign: ForeignTurn | null = null;
  /** The session's title as the screen shows it: the route's, then the daemon's (`session_title`/rename). */
  let shownTitle = deps.title;
  /** The last attached handle's title subscription (dropped on a re-attach/leave). */
  let sessionTitleWatch: (() => void) | undefined;
  /**
   * Background work (S8). The lists are the daemon's; the Finished memory lives
   * for this screen (a re-attach keeps it — F13), never persisted.
   */
  let activity: ActivityState = {
    subagents: null,
    jobs: null,
    memory: emptyMemory,
    sent: {},
    child: null,
    job: null,
    stopNotices: {},
  };
  /** The last attached handle's `onSubagents`/`onJobs` subscriptions. */
  let activityWatch: (() => void) | undefined;
  /** The rows whose kill is in flight (mobile-activity-panel Design 4): one per row. */
  const rowStops = new Set<string>();
  /**
   * The daemon's wake table as last reported (docs/feat/cron-tool.md S6):
   * `undefined` = none reported yet, an older daemon, or an untrusted one (its
   * table is dropped client-side). The hub's Scheduled item is absent on it (P6).
   */
  let schedules: readonly ScheduleRow[] | undefined;
  let wakeWatch: (() => void) | undefined;
  /** The rename field (Owner decision 5): `null` while it is closed. */
  let renaming: RenameState | null = null;
  /**
   * Session info (docs/feat/mobile-session-info.md). Built over the ONE client
   * stack (`deps.info` hands back the port the app wired), and it reads the
   * handle LIVE: the attach that creates it happens after this.
   */
  const infoPort = deps.info === undefined ? null : deps.info(() => handle);
  /**
   * The header's folder when the route brought none: the session's own
   * `session/list` entry, asked once per attach until one answer lands. A
   * failure or a session off the first page leaves it unknown (no folder).
   */
  let lookedUpCwd: string | undefined;
  let cwdAsking = false;
  function lookUpCwd(): void {
    if (infoPort === null || deps.cwd !== undefined || lookedUpCwd !== undefined || cwdAsking) {
      return;
    }
    cwdAsking = true;
    void infoPort
      .sessionList()
      .then((page) => {
        lookedUpCwd = page.sessions.find((row) => row.sessionId === infoPort.sessionId)?.cwd ?? "";
        emit();
      })
      .catch(() => {})
      .finally(() => {
        cwdAsking = false;
      });
  }
  /** The folder the header shows: Session info's fresh entry, else the lookup, else the route's. */
  function headerCwd(): string | undefined {
    return info?.state().entryCwd ?? lookedUpCwd ?? deps.cwd;
  }
  /** This phone's own turn's abort (Stop, for `own: true`). */
  let ownControl: AbortController | null = null;
  let disposed = false;
  /** THIS phone's compaction in flight (C2 item 13): its abort is the Stop. */
  let compaction: { readonly control: AbortController; readonly since: number } | null = null;
  /** When it last succeeded (the slot's 3 s); a turn start or a clear drops it. */
  let compactedAt: number | null = null;
  /** The ONE timer that re-renders when `Compacted ✓` goes. */
  let compactedTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last compaction's `▲` text, until the next try. */
  let compactFailed: string | null = null;
  let clearing = false;
  /** Clear's armed inline confirm (`clearConfirm`). */
  let clearArmed = false;
  function dropCompacted(): void {
    compactedAt = null;
    if (compactedTimer !== null) {
      clearTimeout(compactedTimer);
      compactedTimer = null;
    }
  }
  /** Fold a command's own outcome line (`local_notice`). */
  function pushLine(line: OutcomeLine): void {
    transcript = apply(
      transcript,
      {
        type: "local_notice",
        text: line.text,
        ...(line.level === undefined ? {} : { level: line.level }),
      },
      deps.now(),
    );
  }
  const unmount = new AbortController();
  /**
   * The controller object itself, held here because the `appState` method below
   * needs to reach it (a foreground return runs `resync`). Assigned once, at the
   * end; only ever read at call time.
   */
  const holder: { current: SessionScreenController | null } = { current: null };
  /** THIS screen's requester: the identity `releaseRequester` withdraws by. */
  const mounted: PermissionRequester = (req, options) => sheet.requester(req, options);

  const sheet =
    deps.sheet === undefined
      ? createPermissionSheet({
          now: deps.now,
          onChange: () => emit(),
          // The session's shared auto-accept (docs/feat/session-auto-accept.md
          // D6): read through a function, because the handle (and its link) only
          // exists after the attach — the sheet is built first.
          autoAccept: () => handle?.autoAccept,
          // The own-turn test that goes with it (the same one a terminal feeds
          // `autoApproves`), read LIVE: the handle does not exist yet, so this
          // must not be snapshotted here (`undefined` would silently mean "only
          // a named turn"). A handle that offers none keeps that stricter rule.
          autoAcceptsTurn: (turnId: string) => autoAcceptsTurnOf(handle)?.(turnId) === true,
          // This phone's own label, so an ask's "also asked on" never names the
          // device it is shown on (D7). The name the person gave this phone at
          // pairing — the same one the computer lists it under.
          ownHost: () => deps.phoneName?.(),
          // The age guard's release is a clock event: it re-renders through the
          // same `onChange` every other change uses (never a screen-side timer).
          schedule: (fn, ms) => {
            const timer = setTimeout(fn, ms);
            return { cancel: () => clearTimeout(timer) };
          },
        })
      : deps.sheet({ now: deps.now });

  const driver: ThumbnailDriver = createThumbnailDriver(
    deps.thumbnails ?? { fetch: async () => null },
    (next) => {
      thumbnails = next;
      emit();
    },
    unmount.signal,
    initialThumbnails,
  );

  const feed = createSessionFeed({
    state: () => transcript,
    put: (next, cause) => {
      if (cause === "stream") {
        deps.onStreamFold?.();
      }
      // A REPLACED history rebuilds every row from `ChatMessage`s, which carry no
      // tool details: the cards this screen already knows are joined back on HERE,
      // the one place every folded state passes, so a resync never loses them.
      transcript = joinedRows(next);
      // A turn replaces the slot: a lingering `Compacted ✓` must not come back
      // after it, and Clear's armed question is no longer the one on screen
      // (mobile-hub-commands C2). A link drop disarms the confirm too.
      if (transcript.turn !== null) {
        dropCompacted();
        clearArmed = clearConfirm(clearArmed, "turn_started").armed;
      }
      if (transcript.link === "down") {
        clearArmed = clearConfirm(clearArmed, "link_down").armed;
      }
      // A card that arrived LIVE joins the list too: the list is the hub's count
      // (rim + glow) and the gallery's source, and it is only ASKED at the attach
      // (docs/fix/mobile-qa-1118.md, bug 3). De-duplicated by id + version.
      const live = withLiveCards(join, transcript.rows);
      if (live !== join) {
        join = live;
        publishJoin();
      }
      // A streamed delta re-renders at most once per window; anything else at
      // once (and that absorbs a pending delta's render: `render-coalesce.ts`).
      if (cause === "stream") {
        render.soon();
      } else {
        emit();
      }
    },
    setForeign: (turn) => {
      foreign = turn;
      emit();
    },
    // A REPLACED history (a `/clear`, a resync) forgets the measured fill in the
    // fold, and the daemon has to be asked to count what the session holds now:
    // the attach-time `openContext` figure described the chat that was just
    // dropped, and `headerContext` falls back to it (Review round 1, MEDIUM 2;
    // the TUI's `forgetContextFill` + `askContext`).
    onHistoryReplaced: () => {
      if (info !== null) {
        void info.loadContext().catch(() => {});
      }
    },
    // A live row's arrival time (docs/fix/mobile-open-at-end.md, slice B): the
    // stamp a swipe shows. Taken when the fold CREATES the row, never on upsert.
    now: () => deps.now(),
    ...(deps.trace === undefined ? {} : { trace: deps.trace }),
    // The turn is over: the DIAGNOSTIC asks the composer what it still shows.
    // Nothing is cleared here — mobile has no turn-end reconciliation yet, and
    // inventing one before the capture would hide the very frame it hunts
    // (docs/fix/mobile-queued-stuck.md).
    onTurnClosed: () => compose?.turnClosed(),
  });

  /**
   * The compose half (13d). Its own state is a pure module's (`compose-state.ts`);
   * it is created ONLY when the app wired it, so a screen without photos and
   * without an outbox (12c's tests) has no queue either.
   */
  const compose: Compose | null =
    deps.compose === undefined
      ? null
      : createCompose({
          computerId: deps.compose.computerId,
          sessionId: deps.sessionId,
          store: deps.compose.store,
          // The driver is built PER SCREEN, over a port whose `prompt` is THIS
          // screen's folding one: 13b's driver keeps the item and the key, but the
          // turn it starts must stream into this transcript (a drained stream shows
          // nothing — 13d's flow 07/18). The app passes a factory, not a driver.
          driver: deps.compose.driver({
            prompt: (text, turnId, refs, photos, documents) =>
              promptWithRefs(text, turnId, refs, photos, documents),
            // 13b's own hand-back (F7/F20): the item is gone and its text is the
            // field's again — APPENDED, never overwriting what the person typed.
            onDraft: (item) => {
              draft = restoreAfterFailure(draft, item.text);
              deps.compose?.draft(draft, []);
              emit();
            },
            // The driver's port is built over THIS screen's handle — the one that
            // IS the client's stream listener — so the turn a photo message starts
            // folds here (item 1's whole bug: a second handle took the stream).
            handle: () =>
              status.phase === "open" && handle !== null
                ? (deps.compose?.handle(handle) ?? null)
                : null,
            // The upload percent the outbox row shows (S4): memory only, and the
            // driver already coalesces it to whole percentages. `emit` is what
            // redraws the row; a `null` clears it when the upload ends.
            onProgress: (itemId, fraction) => {
              if (fraction === null) {
                outboxProgress.delete(itemId);
              } else {
                outboxProgress.set(itemId, fraction);
              }
              emit();
            },
          }),
          photos: deps.compose.photos,
          ...(deps.compose.documents === undefined ? {} : { documents: deps.compose.documents }),
          ...(deps.compose.sendPhotoOriginalSize === undefined
            ? {}
            : { sendPhotoOriginalSize: deps.compose.sendPhotoOriginalSize }),
          // The handle exists only once the attach answered: a compose act on a
          // half-built screen must never build a frame (AGENTS §7).
          handle: () =>
            status.phase === "open" && handle !== null
              ? (deps.compose?.handle(handle) ?? null)
              : null,
          turnId: () => (foreign !== null ? foreign.turnId : (transcript.turn?.turnId ?? null)),
          stopTurn: (turnId, own) => {
            if (own) {
              ownControl?.abort();
              return;
            }
            // A foreign turn is stoppable only through its own activity's
            // `cancel`; a turn id we never saw stream is not ours to cancel.
            if (foreign !== null && foreign.turnId === turnId) {
              foreign.cancel();
            }
          },
          mint: deps.compose.mint,
          prompt: promptWithRefs,
          followSendNow,
          draft: () => draft,
          setDraft: (text) => {
            draft = text;
            emit();
          },
          // expo-file-system's write (`outbox-fs-expo.ts`) is the store's, and the
          // draft is the same store's data: the app wires the write itself.
          flushDraft: (text, photos) => deps.compose?.draft(text, photos),
          onChange: () => emit(),
          notify: (text) => {
            notice = text;
            emit();
          },
          ...(deps.trace === undefined ? {} : { trace: deps.trace }),
        });

  /**
   * A port or the sheet's controller built over it: `createSessionInfo` is cheap
   * and STATEFUL (its generation counter), so exactly one lives per screen and
   * `open()`/`close()` are what restart it.
   */
  /**
   * One controller per screen. `title` is OVERRIDDEN with this screen's own
   * `shownTitle`: the port's copy is the route's, captured when the screen was
   * built, so the sheet's subtitle kept the old name after a rename this phone
   * (or another) made (Review round 1, LOW).
   */
  const info =
    infoPort === null ? null : createSessionInfo({ ...infoPort, title: () => shownTitle });
  /**
   * The info controller's OWN emits (Review round 1, MEDIUM 1): every pull that
   * lands, the link's `up` refresh and another device's auto-accept flip repaint
   * this screen. Without it the header's bar and the sheet's sections only moved
   * on some UNRELATED event — and on an idle session there is none.
   */
  const unwatchInfo = info === null ? () => {} : info.subscribe(() => emit());

  /** The daemon's model as the header shows it (`undefined`: report nothing). */
  function modelOf(): string | undefined {
    return infoPort?.daemon()?.model;
  }

  /** The context window the bar divides by (`undefined`: no bar, F6). */
  function windowOf(): number | undefined {
    return infoPort?.daemon()?.contextWindow;
  }

  /** The daemon's count at open: the bar's figure until a turn measures one. */
  function measuredContext(): { readonly used: number; readonly exact: boolean } | null {
    return info?.state().openContext ?? null;
  }

  /** The compose view the screen draws (empty when this build has no compose half). */
  function composeView(): { readonly bar: ComposeBarView; readonly items: readonly OutboxItem[] } {
    if (compose === null) {
      return {
        items: [],
        bar: {
          queued: [],
          returnedOthers: [],
          returnedNotice: "",
          outbox: [],
          notSaved: false,
          chips: [],
          attach: { items: ["photo", "camera"], reason: null },
          ownPending: 0,
          sendNow: false,
          pending: [],
          editing: null,
          unqueueOff: false,
        },
      };
    }
    const value = compose.view();
    return {
      items: value.outbox,
      // The ROWS are the pure view-model's (`sessionView`, from the items).
      bar: {
        queued: value.queued,
        returnedOthers: value.returnedOthers,
        returnedNotice: value.returnedNotice,
        outbox: outboxRows(
          value.outbox,
          {
            title: shownTitle,
            project: deps.project,
            status,
            rows: [],
            turn: transcript.turn,
            link: transcript.link,
            ended: transcript.closed,
            draft,
            archived: deps.archived,
          },
          outboxProgress,
        ),
        notSaved: value.notSaved,
        chips: value.chips,
        attach: value.attach,
        ownPending: value.ownPending,
        sendNow: value.sendNow,
        pending: value.pending,
        editing: value.editing,
        unqueueOff: value.unqueueOff,
      },
    };
  }

  function view(): SessionView {
    const composeState = composeView().bar;
    const cwd = headerCwd();
    return sessionView({
      title: shownTitle,
      project: deps.project,
      status,
      rows: transcript.rows,
      turn: transcript.turn,
      link: transcript.link,
      ended: transcript.closed,
      draft,
      archived: deps.archived,
      ...(cwd === undefined ? {} : { cwd }),
      // The header's model and context bar (Owner 2/4): the daemon's handshake
      // facts re-read per open (F7), and the fill THIS session measured — never
      // a fabricated 0 (the bar is absent until there is something to fill).
      ...(info === null
        ? {}
        : {
            header: {
              model: modelOf(),
              measured: transcript.lastTurnTokens?.prompt ?? null,
              open: measuredContext(),
              window: windowOf(),
            },
          }),
      queued: composeState.queued,
      returnedOthers: composeState.returnedOthers,
      ...(composeState.returnedNotice === ""
        ? {}
        : { returnedNotice: composeState.returnedNotice }),
      outbox: composeView().items,
      // The SAME map the bar's rows read (Review round 5, finding 2a): two
      // projections of one list, so a percent must not reach only one of them.
      outboxProgress,
      notSaved: composeState.notSaved,
      photos: composeState.chips.map((chip) => ({
        key: chip.key,
        ...(chip.state === "refused" ? {} : { kind: chip.kind }),
        state: chip.state,
        ...(chip.name === undefined ? {} : { name: chip.name }),
        ...(chip.state === "refused" ? { detail: chip.detail } : {}),
      })),
      ownPending: composeState.ownPending,
      // The pending messages as the TRANSCRIPT draws them (D1) and the edit's
      // banner state (D6): values, never decisions.
      pending: composeState.pending,
      editing: composeState.editing,
      unqueueOff: composeState.unqueueOff,
    });
  }

  /**
   * Pull-to-refresh (item 3): the resync the owner used by hand — leave the
   * session, then attach it again. The daemon's history arrives as a `history`
   * activity (reason `null`) and `withHistory` REPLACES the rows
   * (`transcript.ts:274-281`), so nothing is doubled. `leave()` detaches THIS
   * screen's listener only; another device's view is untouched.
   *
   * Deliberately not a new session path (AGENTS §7): it is `attach(false)`, the
   * same call the screen's mount makes.
   */
  /**
   * The pull-to-refresh GUARD (one re-attach at a time), and `pulling`, which is
   * the spinner the person sees: a foreground resync (item 2) runs without one.
   */
  let refreshing = false;
  let pulling = false;
  /**
   * The app's foreground transition (item 2): whether it has been AWAY since the
   * screen was built. Only a RETURN resyncs — the screen is built while the app
   * is on screen, so a plain `active` with no departure before it is not one.
   * Only `background` sets it: iOS reports `inactive` without the app leaving
   * (Control Center, the notification shade, a call banner, a permission alert,
   * the Face ID prompt itself), and the repo already decided that `inactive` is
   * not leaving the app (`app-lock.ts`). Counting it cost a second full re-read
   * on a single return with the app lock on (Review round 5, MEDIUM 1).
   */
  let appWasAway = false;
  /**
   * A return came while the link was DOWN: the resync it owed runs at the next
   * `up`. The redial alone re-reads nothing on this screen — the device capture
   * (docs/fix/mobile-queued-stuck.md (c)) shows two link-ups after a return with
   * no attach, no history, a stale queue row and a missing answer for 26 s, until
   * the person left and re-entered the session.
   */
  let resyncOnUp = false;

  /** The footer slot NOW (`compact-slot.ts` decides; the clock is the screen's). */
  function slot(): SlotView | null {
    return slotView({
      running: transcript.turn !== null,
      compactingSince: compaction?.since ?? null,
      compactedAt,
      now: deps.now(),
    });
  }

  /** The last user row: what Retry re-sends (its text) and what it cannot (its files). */
  function lastUserRow(): Extract<State["rows"][number], { kind: "user" }> | undefined {
    for (let i = transcript.rows.length - 1; i >= 0; i -= 1) {
      const row = transcript.rows[i];
      if (row?.kind === "user") {
        return row;
      }
    }
    return undefined;
  }

  function commands(): readonly CommandRow[] {
    return commandRows({
      link: transcript.link,
      turnRunning: transcript.turn !== null,
      ended: transcript.closed !== null,
      compacting: compaction !== null,
      compacted: slot()?.kind === "compacted",
      compactFailed,
      clearing,
      confirmClear: clearArmed,
      lastPrompt: lastUserRow()?.text ?? null,
      fieldBusy: draft.trim() !== "" || composeView().bar.chips.length > 0,
      autoAccept: info?.autoAcceptOn() ?? false,
      canCompact: typeof handle?.compact === "function",
      canClear: typeof handle?.clear === "function",
    });
  }

  /** Whether a command's row says it can run now (one rule: `commandRows`). */
  function rowReady(id: CommandRow["id"]): boolean {
    const state = commands().find((row) => row.id === id)?.state.kind;
    return state === "ready" || state === "failed" || state === "done" || state === "confirming";
  }

  function state(): SessionScreenState {
    return {
      slot: slot(),
      commands: commands(),
      status,
      transcript,
      draft,
      notice,
      view: view(),
      sheet: sheet.view(),
      thumbnails,
      compose: composeView().bar,
      info: info === null ? null : info.state(),
      renaming,
      sends,
      activity,
      schedules,
      refreshing: pulling,
      artifacts: join,
    };
  }

  /**
   * Follow the handle's background lists (S8). Each subscription hands the
   * current list at once (the open snapshot's — F13), then every replace. A
   * handle without them (an older client, a fake) leaves both `null` (F15).
   */
  function watchActivity(session: SendableHandle): () => void {
    // The wake table rides the SAME attach (cron-tool S6): `onSchedules` hands the
    // table it already knows AT ONCE (`RemoteSession.onSchedules`), then every
    // change — so one subscription carries both, and there is no second read to
    // fall out of step with it.
    wakeWatch?.();
    wakeWatch = session.onSchedules?.((report) => {
      schedules = report.rows;
      emit();
    });
    const offAgents = session.onSubagents?.((rows) => {
      const memory = onSubagents(activity.memory, rows, deps.now());
      // A child's messages live as long as it is live or Finished (bounded with it).
      const keep = new Set([...rows.map((r) => r.id), ...memory.finished.map((f) => f.row.id)]);
      activity = {
        ...activity,
        subagents: rows,
        memory,
        sent: pruneSent(activity.sent, keep),
        stopNotices: {},
      };
      emit();
    });
    const offJobs = session.onJobs?.((report) => {
      // A replaced list is the newest truth: the row stops it spoke for are gone.
      activity = {
        ...activity,
        jobs: { rows: report.rows, count: report.count },
        stopNotices: {},
      };
      emit();
    });
    // S9: the person's messages to a child, from the daemon's echo only (a
    // message sent from another device shows too, and none twice).
    const offSent = session.onSubagentMessage?.((notice) => {
      activity = {
        ...activity,
        sent: recordSent(activity.sent, notice.agentId, {
          text: notice.text,
          ...(notice.n === undefined ? {} : { n: notice.n }),
        }),
      };
      emit();
    });
    return () => {
      offAgents?.();
      offJobs?.();
      offSent?.();
      wakeWatch?.();
      wakeWatch = undefined;
    };
  }

  /**
   * Patch the open child's detail — only while it is still THAT child's (S9): an
   * answer for a child the person already left never lands on the next one.
   */
  function setChild(open: ChildAction, patch: Partial<Omit<ChildAction, "id">>): void {
    if (activity.child?.id !== open.id) {
      return;
    }
    activity = { ...activity, child: { ...activity.child, ...patch } };
    emit();
  }

  /** Patch the open job's detail, only while it is still that job's (S9). */
  function setJob(jobId: string, patch: Partial<Omit<JobAction, "id">>): void {
    if (activity.job?.id !== jobId) {
      return;
    }
    activity = { ...activity, job: { ...activity.job, ...patch } };
    emit();
  }

  /** Read a job's output tail; a throw is a `found: false` notice, never a throw at the UI (F19). */
  async function readJob(jobId: string): Promise<void> {
    const read = handle?.jobOutput?.bind(handle);
    setJob(jobId, { busy: true });
    const output: JobOutputResult =
      read === undefined
        ? { found: false, jobId, reason: ACTIVITY_UNSUPPORTED }
        : await read(jobId, { lines: JOB_LINES }).catch(
            (e: unknown): JobOutputResult => ({
              found: false,
              jobId,
              reason: `Could not read the output: ${asError(e).message}`,
            }),
          );
    setJob(jobId, { busy: false, output });
  }

  const listeners = new Set<(state: SessionScreenState) => void>();

  /**
   * The transcript a fold produced, with every card this screen knows attached.
   * A REPLACE (a resync, a `/clear`, a `history_reset`) rebuilds rows from
   * `ChatMessage`s, which carry no tool details, so without this a session's
   * cards vanish the moment the link resyncs (the TUI's `joinKnownArtifacts`,
   * docs S6a review finding 2). A row that already carries one is left alone —
   * the live result's is the present call's own answer — and a no-op is the SAME
   * state object, so it cannot re-render.
   */
  function joinedRows(next: State): State {
    if (join.byCall.size === 0) {
      return next;
    }
    const rows = joinRows(next.rows, join.byCall);
    return rows === next.rows ? next : { ...next, rows };
  }

  /** Publish what this screen knows: the gallery screen reads it (it has no handle). */
  function publishJoin(): void {
    deps.artifacts?.feed.publish({ list: join.list, phase: join.phase });
  }

  /**
   * Publish the handle's own verified read for the gallery's viewer (D9). The
   * closure reads the CURRENT `handle` on every call, so one publication serves
   * the whole screen life and a screen with no handle (before the attach, after a
   * resync's `leave`) refuses instead of reading through a dead session.
   */
  function publishReader(): void {
    deps.artifacts?.feed.provideRead((meta, options) => {
      const session = handle;
      const read = session?.readArtifact?.bind(session);
      if (read === undefined) {
        return Promise.reject(new Error("no artifact reader on this session"));
      }
      return read(meta, options);
    });
  }

  /**
   * Re-read `artifact/list` (docs/feat/model-artifacts.md D9). Single-flight: a
   * gallery mount, a refresh request and a landed list can collide, and one
   * answer serves all three. A failure is a PHASE, never a throw — the screen
   * says "needs a newer tentacle" or "offline" and keeps the rows it had.
   */
  function refreshArtifacts(): Promise<void> {
    if (joinPending !== null) {
      return joinPending;
    }
    const session = handle;
    const listed = session?.listArtifacts?.bind(session);
    if (listed === undefined) {
      // An older daemon (no `artifact/list`) or a handle that offers none: no
      // call to make, and retrying could never help.
      join = withPhase(join, "unsupported");
      publishJoin();
      emit();
      return Promise.resolve();
    }
    const run = (async () => {
      try {
        const result = await listed();
        if (disposed) {
          return;
        }
        join = withList(join, result.artifacts);
        // The cards reach the rows through the ONE path that rebuilds them.
        transcript = joinedRows(transcript);
      } catch (error) {
        if (disposed) {
          return;
        }
        join = withPhase(join, phaseOfError(error));
      } finally {
        joinPending = null;
      }
      publishJoin();
      emit();
    })();
    joinPending = run;
    return run;
  }

  /**
   * The gallery asks for fresh bytes when it mounts or is pulled: the owner of
   * the handle answers (the gallery cannot — a second session of one id steals
   * this screen's stream).
   */
  const unwatchRefresh =
    deps.artifacts === undefined
      ? undefined
      : deps.artifacts.feed.onRefresh(() => {
          void refreshArtifacts();
        });

  /**
   * Every state change reaches the screen through here (docs/fix/
   * mobile-fan-jank-device.md): `emit` is immediate, a streamed delta's
   * `render.soon()` is coalesced to one notification per `STREAM_RENDER_MS`.
   */
  const render = createRenderCoalescer({
    fire: notifyListeners,
    clock: () => deps.now(),
    schedule:
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      }),
  });
  function emit(): void {
    render.now();
  }
  function notifyListeners(): void {
    if (disposed) {
      return;
    }
    const next = state();
    deps.onChange?.(next);
    for (const listener of listeners) {
      listener(next);
    }
  }

  /**
   * Take the sheet's requester on the client's ONE broker (never a second one).
   * The requester itself is the identity the release compares against: it is
   * created once, with this screen, so no other screen's can equal it.
   */
  function mountRequester(): void {
    deps.broker.setRequester(mounted);
  }

  /** Withdraw the requester IF it is still this screen's (a newer screen keeps its own). */
  function releaseRequester(): void {
    deps.broker.reset(mounted);
  }

  /**
   * An archived row shows its banner and Reopen from the first render, so a tap
   * can arrive while the FIRST attach is still in flight: remember it and run
   * it when that attach settles, instead of swallowing the tap.
   */
  let queuedReopen = false;

  /**
   * Attach. `reopen` is the person's explicit Reopen button (Owner Q4) — the
   * FIRST attach of an archived session never passes it, so merely opening the
   * screen cannot revive a session or count against the daemon's cap.
   */
  async function attach(reopen: boolean): Promise<void> {
    if (attaching) {
      if (reopen) {
        queuedReopen = true;
      }
      return;
    }
    attaching = true;
    status = { phase: "opening", ...(reopen ? { reopenRequested: true as const } : {}) };
    deps.trace?.({ kind: "attach", state: "start", reopen });
    emit();
    const result = await deps.controller.open(deps.sessionId, {
      ...(reopen ? { reopen: true } : {}),
      watch: (activity) => feed.activity(activity),
    });
    attaching = false;
    if (disposed) {
      return;
    }
    if (!result.ok) {
      deps.trace?.({ kind: "attach", state: "fail", reopen, reason: result.reason });
      status = {
        phase: "failed",
        failure: result.reason,
        ...(reopen ? { reopenRequested: true as const } : {}),
      };
      emit();
      if (queuedReopen) {
        // The person tapped Reopen while this attach was still running: honour
        // it now rather than making them tap the same button twice.
        queuedReopen = false;
        void attach(true);
      }
      return;
    }
    queuedReopen = false;
    handle = result.session;
    deps.trace?.({ kind: "attach", state: "ok", reopen });
    status = { phase: "open" };
    // The daemon's title can move while this screen is open (another device's
    // rename, or this one's): the header follows it, never the route's copy.
    sessionTitleWatch?.();
    sessionTitleWatch = result.session.onTitle?.((notice) => {
      shownTitle = titleAfterRename(notice.title);
      emit();
    });
    activityWatch?.();
    activityWatch = watchActivity(result.session);
    // The header's context bar needs a figure NOW: a session attached after its
    // turns has no `agent_usage` to measure from (the TUI asks at attach too).
    if (info !== null) {
      void info.loadContext().catch(() => {});
    }
    // The header's folder, when the route brought none (a push, a new session).
    lookUpCwd();
    // The cards of a resumed transcript (docs/feat/model-artifacts.md D9): the
    // history that landed has no tool details, so the daemon's list is the only
    // source. Asked at every attach — a live turn's card arrives by itself.
    publishReader();
    void refreshArtifacts();
    // Asks reach the person from now on. Set AFTER the attach, so a replayed ask
    // is queued by the broker until the sheet is up and then delivered in order
    // (F1) — never to a half-built screen.
    mountRequester();
    // The compose half follows the queue from here (13d): its store is loaded
    // once, and a `queued` broadcast is applied by `compose-state.ts`.
    if (compose !== null) {
      const wired = deps.compose?.handle(result.session) ?? null;
      if (wired !== null) {
        void compose.start(wired);
        // The outbox may have items from a killed app: `up` + re-sync is when
        // they get their chance (`decide`, D4), never a blind send.
        void compose.runOutbox();
      }
    }
    emit();
  }

  async function send(action: Extract<ComposerAction, { kind: "send" }>): Promise<void> {
    const session = handle;
    if (session === null) {
      return;
    }
    const text = action.text;
    const turnId = crypto.randomUUID();
    const control = new AbortController();
    ownControl = control;
    draft = "";
    notice = null;
    emit();
    let streamed = false;
    let failure: unknown;
    const events = (async function* guarded(): AsyncIterable<SessionEvent> {
      try {
        for await (const event of session.send(text, control.signal, { turnId })) {
          streamed = true;
          yield event;
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    })();
    await feed.ownTurn(turnId, events, { text }).catch(() => {
      // The stream threw: the feed folded it as LOST (F8/F19), and `failure` below
      // is what decides whether the person's words come back (F13).
    });
    ownControl = null;
    if (failure === undefined) {
      emit();
      return;
    }
    // Nothing streamed and the daemon refused it before the ack: the person's
    // words come BACK (F13). Anything else is a loss the transcript says itself.
    if (refusedBeforeStart(failure, streamed)) {
      draft = restoreAfterFailure(draft, text);
      notice = REFUSED_NOTICE;
      emit();
      return;
    }
    if (!streamed) {
      draft = restoreAfterFailure(draft, text);
      notice = FAILED_NOTICE;
      emit();
    }
  }

  /**
   * A send-now's successor turn, folded here as the phone's OWN (the composer's
   * Stop aborts it: `ownControl`). Resolves at the daemon's ack; a refusal
   * rejects and leaves nothing behind. Before docs/fix/mobile-queued-stuck.md
   * (b) the handle drained it: the turn ran on the daemon and the phone saw no
   * `turn-start`, no answer, until a re-entry read the history.
   */
  async function followSendNow(start: SendNowStart): Promise<void> {
    const turnId = crypto.randomUUID();
    const control = new AbortController();
    const before = ownControl;
    ownControl = control;
    let events: AsyncIterable<SessionEvent>;
    try {
      events = await start({ turnId, signal: control.signal });
    } catch (error) {
      if (ownControl === control) {
        ownControl = before;
      }
      throw error;
    }
    void feed
      .successorTurn(turnId, events)
      .catch(() => {
        // Folded as LOST by the feed; nothing of the field's comes back after an ack.
      })
      .then(() => {
        if (ownControl === control) {
          ownControl = null;
        }
        emit();
      });
  }

  /**
   * ONE prompt with image refs (13d), folded into this screen's transcript as the
   * phone's OWN turn — 12c's fold, not a drained stream: the compose half hands its
   * turn here (`compose-controller.ts`'s `prompt`), and `turn-running`/the answers
   * appear because this is where the events are applied.
   *
   * RESOLVES AT THE DAEMON'S ACK (`untilAccepted`), while the turn keeps folding:
   * the caller settles the outbox item then, not at the turn's end (bug 2 of
   * docs/fix/mobile-chat-glitches.md — a "Sending…" row for the whole turn).
   * Rejects with the refusal before the ack (a foreign turn, a busy door, a dead
   * link), so the caller gives the person's words back (F7); or with
   * `SessionNotOpenError("link")` if the stream ended unanswered (the item waits
   * with its key). Once accepted, a loss is the transcript's to say: restoring
   * the text would send the same words twice.
   */
  function promptWithRefs(
    text: string,
    turnId: string,
    refs: readonly AttachmentRef[],
    photos?: readonly LocalPhoto[],
    /** The attached PDFs' wire blocks (docs/feat/pdf-read.md D7), when there are any. */
    documents?: readonly DocumentContent[],
  ): Promise<void> {
    const session = handle;
    if (session === null) {
      return Promise.resolve();
    }
    const control = new AbortController();
    ownControl = control;
    notice = null;
    emit();
    /** The live row's own labels: the file's name, and a page count only when
     * THIS client extracted it (`document{text}` — the daemon's count for an
     * uploaded PDF never travels back on the turn). */
    const labels = documents === undefined ? undefined : documentLabels(documents);
    const run = untilAccepted(
      (onAccepted) =>
        session.send(text, control.signal, {
          turnId,
          attachments: refs,
          ...(documents === undefined ? {} : { documents }),
          onAccepted,
        }),
      // Folded as LOST by the feed on a throw; what the CALLER does about it is
      // `accepted`'s rejection.
      (events, accepted) =>
        feed.ownTurn(
          turnId,
          events,
          {
            text,
            attachments: refs,
            photos,
            ...(labels === undefined ? {} : { documents: labels }),
          },
          accepted,
        ),
    );
    void run.done.then(() => {
      if (ownControl === control) {
        ownControl = null;
      }
      emit();
    });
    return run.accepted;
  }

  /**
   * A press, counted in `sends` when it SENT the field. Every send path clears
   * the field in the same synchronous step that reads it (F4: `compose.press`,
   * 12c's `send`), so "non-empty before, empty after" is exactly "this press
   * sent it" — Stop and a blank Return leave the field as it was, and a second
   * tap in the same frame finds it already empty.
   */
  function press(): void {
    const before = draft;
    act();
    if (before.trim() !== "" && draft === "") {
      sends += 1;
      emit();
    }
  }

  function act(): void {
    const action = view().composer.action;
    if (action.kind === "send") {
      // With the compose half wired, the ONE tap decides between the wire (no
      // photos) and the outbox (photos, and every offline act) — see
      // `compose-controller.ts`'s `press`, which reads the FIELD itself and clears
      // it in the same step. Clearing it here first would make that read empty and
      // the send would do nothing (the first iOS 26 run's failure of flow 07).
      if (compose !== null) {
        notice = null;
        emit();
        void compose.press(action);
        return;
      }
      void send(action);
      return;
    }
    if (action.kind === "queue" || action.kind === "send-later") {
      // A steer (a turn runs) or an offline item: the compose half's own path.
      if (compose !== null) {
        void compose.press(action);
      }
      return;
    }
    stop(action);
  }

  /** The ONE stop path: the composer's button and the hub's Stop both end here. */
  function stop(action: ComposerAction): void {
    if (action.kind !== "stop") {
      return;
    }
    if (action.own) {
      // This phone's own turn: the same call its `send` gave a signal for.
      ownControl?.abort();
      return;
    }
    foreign?.cancel();
  }

  /** The hub's Stop: the composer's truth table with nothing to send (P2). */
  function stopTurn(): void {
    // My own compaction holds the session's one slot (no turn can run): the
    // hub's Stop is its cancel (harness-notices Q7, mobile-hub-commands C2 14).
    if (compaction !== null) {
      compaction.control.abort();
      return;
    }
    stop(
      composerAction({
        link: transcript.link,
        text: "",
        turn: transcript.turn,
        ended: transcript.closed,
        photos: 0,
      }),
    );
  }

  const controller: SessionScreenController = {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: () => attach(false),
    retry() {
      void attach(status.phase === "failed" && status.reopenRequested === true);
    },
    reopen() {
      void attach(true);
    },
    setDraft(text) {
      draft = text;
      emit();
    },
    press,
    stopTurn,
    pressReturn() {
      // The gate reads the action NOW, as `press` does: a second Return before
      // the screen re-rendered must not see a stale `send` and then Stop.
      if (returnKeyAction(view().composer.action) !== null) {
        press();
      }
    },
    link(up) {
      feed.link(up);
      if (up && compose !== null && !disposed && status.phase === "open") {
        // 13b's design: an outbox run happens at `up` (its `decide` reads the
        // re-synced facts). Only the attach ran it, so an item written offline on
        // this OPEN screen waited for a reopen (fix/mobile-e2e-reds, flow 17).
        void compose.runOutbox();
      }
      if (!up || !resyncOnUp) {
        return;
      }
      resyncOnUp = false;
      if (!disposed && !refreshing && !attaching && status.phase === "open") {
        void holder.current?.resync(true);
      }
    },
    appState(name) {
      // The app's foreground gate (item 2). The FIRST `active` is the mount, not
      // a return: nothing to recover, and the open's own attach is the read. A
      // return runs the SAME `resync()` the pull does — silently (no pull
      // spinner: `resync`'s own re-entry guard makes a concurrent pull a no-op)
      // — and never while offline, where the redial re-attach owns the recovery.
      // ONLY `background` is a departure: `inactive` is Control Center, a call
      // banner, a permission alert or the Face ID prompt itself, not the app
      // leaving (`app-lock.ts`) — counting it resynced twice per return with the
      // app lock on (Review round 5, MEDIUM 1).
      if (name !== "active") {
        if (name === "background") {
          appWasAway = true;
        }
        return false;
      }
      if (!appWasAway) {
        return false; // a duplicate `active` (iOS) — at most one resync per return
      }
      appWasAway = false;
      if (disposed || refreshing || attaching || status.phase !== "open") {
        return false; // a pull is already re-reading, or there is no live attach
      }
      if (transcript.link === "down") {
        // Owed, not dropped: it runs at the next `up` (see `resyncOnUp`).
        resyncOnUp = true;
        return false;
      }
      void holder.current?.resync(true);
      return true;
    },
    async openInfo() {
      await info?.open();
      emit();
    },
    closeInfo() {
      info?.close();
      emit();
    },
    async refreshInfo() {
      await info?.refresh();
      emit();
    },
    async pullTools() {
      await info?.pullTools();
      emit();
    },
    async refreshArtifacts() {
      await refreshArtifacts();
    },
    async setAutoAccept(on) {
      await info?.setAutoAccept(on);
      emit();
    },
    autoAcceptOn() {
      return info?.autoAcceptOn() ?? false;
    },
    async setCapability(kind, name, enabled) {
      await info?.setCapability(kind, name, enabled);
      emit();
    },
    openReport(agentId) {
      activity = { ...activity, memory: markOpened(activity.memory, agentId) };
      emit();
    },
    openChild(agentId) {
      activity = {
        ...activity,
        child: { id: agentId, draft: "", busy: false, notice: null },
        job: null,
      };
      emit();
    },
    setChildDraft(text) {
      if (activity.child !== null) {
        activity = { ...activity, child: { ...activity.child, draft: text } };
        emit();
      }
    },
    async messageChild() {
      const open = activity.child;
      const text = open?.draft.trim() ?? "";
      if (open === null || open.busy || text === "") {
        return;
      }
      setChild(open, { busy: true, notice: null });
      const send = handle?.messageSubagent?.bind(handle);
      const result = await (send === undefined
        ? Promise.resolve({ ok: false, reason: ACTIVITY_UNSUPPORTED })
        : send(open.id, text).catch((e: unknown) => asError(e)));
      const outcome = messageOutcome(result);
      setChild(open, {
        busy: false,
        notice: outcome.notice,
        ...(outcome.keepDraft ? {} : { draft: "" }),
      });
    },
    async stopChild() {
      const open = activity.child;
      if (open === null || open.busy) {
        return;
      }
      setChild(open, { busy: true, notice: null });
      const kill = handle?.killSubagent?.bind(handle);
      const notice =
        kill === undefined
          ? ACTIVITY_UNSUPPORTED
          : killChildOutcome(open.id, await kill(open.id).catch((e: unknown) => asError(e)));
      setChild(open, { busy: false, notice });
    },
    async openJob(jobId) {
      activity = {
        ...activity,
        job: { id: jobId, output: null, busy: false, notice: null },
        child: null,
      };
      emit();
      await readJob(jobId);
    },
    async refreshJob() {
      const open = activity.job;
      if (open !== null && !open.busy) {
        await readJob(open.id);
      }
    },
    async stopJob() {
      const open = activity.job;
      if (open === null || open.busy) {
        return;
      }
      setJob(open.id, { busy: true, notice: null });
      const kill = handle?.killJob?.bind(handle);
      const notice =
        kill === undefined
          ? ACTIVITY_UNSUPPORTED
          : killJobOutcome(open.id, await kill(open.id).catch((e: unknown) => asError(e)));
      setJob(open.id, { busy: false, notice });
      // How it ended (or that it already had): the detail shows it (F19).
      await readJob(open.id);
    },
    async stopRow(kind, id) {
      // One in-flight stop per row: a second tap would overwrite a success with
      // "already finished" (the detail's own `busy` rule, S9).
      if (rowStops.has(id)) {
        return;
      }
      rowStops.add(id);
      const kill =
        kind === "job" ? handle?.killJob?.bind(handle) : handle?.killSubagent?.bind(handle);
      try {
        const notice =
          kill === undefined
            ? ACTIVITY_UNSUPPORTED
            : kind === "job"
              ? killJobOutcome(id, await kill(id).catch((e: unknown) => asError(e)))
              : killChildOutcome(id, await kill(id).catch((e: unknown) => asError(e)));
        // A detail's own notice is its state's (S9): a row never writes there.
        if (notice !== null) {
          activity = { ...activity, stopNotices: { ...activity.stopNotices, [id]: notice } };
          emit();
        }
      } finally {
        rowStops.delete(id);
      }
    },
    closeDetail() {
      if (activity.child !== null || activity.job !== null) {
        activity = { ...activity, child: null, job: null };
        emit();
      }
    },
    async deleteSchedule(scheduleId) {
      await info?.deleteSchedule(scheduleId);
      emit();
    },
    beginRename() {
      renaming = { text: shownTitle, saving: false, error: null };
      emit();
    },
    setRenameText(text) {
      if (renaming === null) {
        return;
      }
      renaming = { ...renaming, text, error: null };
      emit();
    },
    async submitRename() {
      const field = renaming;
      const session = handle;
      if (field === null) {
        return;
      }
      const plan = renamePlan(shownTitle, field.text);
      if (plan.kind === "noop") {
        // Empty or unchanged is a NO-OP (Owner decision 5): the sheet closes and
        // nothing is sent — the title's source is not needlessly rewritten.
        renaming = null;
        emit();
        return;
      }
      if (plan.kind === "invalid") {
        renaming = { ...field, saving: false, error: plan.reason };
        emit();
        return;
      }
      if (session === null || session.rename === undefined) {
        // No handle: the attach never answered (`not-attached` phase). Blaming the
        // computer's build would be a lie — nothing was even asked (Review round
        // 1, LOW).
        renaming = {
          ...field,
          saving: false,
          error:
            session === null
              ? "Not connected to that session."
              : "This computer's tentacle is too old to rename sessions.",
        };
        emit();
        return;
      }
      renaming = { ...field, saving: true, error: null };
      emit();
      try {
        const stored = await session.rename(plan.title);
        shownTitle = titleAfterRename(stored);
        renaming = null;
      } catch (error) {
        // The field stays open with the person's text and the reason: a failed
        // rename must never look like it worked.
        renaming = { ...field, saving: false, error: renameErrorText(error) };
      }
      emit();
    },
    cancelRename() {
      renaming = null;
      emit();
    },
    onLink(href) {
      // The screen shows the confirmation (`links.ts`); nothing is opened here.
      void href;
    },
    window(first, last, rows) {
      driver.view(rows, first, last);
    },
    sheet: () => sheet,
    async pickPhoto(source) {
      if (compose === null) {
        return;
      }
      await (source === "library" ? compose.pickLibrary() : compose.pickCamera());
      emit();
    },
    async pickDocument() {
      await compose?.pickDocument();
      emit();
    },
    async removeChip(key) {
      await compose?.removeChip(key);
      emit();
    },
    async sendNow() {
      await compose?.sendNow();
      emit();
    },
    async sendNowRow(id) {
      await compose?.sendNowRow(id);
      emit();
    },
    async edit(id) {
      await compose?.edit(id);
      emit();
    },
    async cancel(id) {
      await compose?.cancel(id);
      emit();
    },
    async editCanceled() {
      await compose?.editCanceled();
      emit();
    },
    async take(id) {
      await compose?.take(id);
      emit();
    },
    async outbox(what, itemId) {
      if (compose === null) {
        return;
      }
      switch (what) {
        case "send":
          await compose.outboxSend(itemId ?? "");
          return;
        case "steer":
          await compose.outboxSteer(itemId ?? "");
          return;
        case "discard":
          await compose.outboxDiscard(itemId ?? "");
          return;
        case "edit":
          await compose.outboxEdit(itemId ?? "");
          return;
        case "open":
          // The sheet is the SCREEN's (`OutboxDecisionSheet.tsx`): its own state.
          return;
        case "close":
          return;
      }
    },
    async leave() {
      sheet.dismiss();
      // Withdraw only THIS screen's requester (never a newer screen's: the app
      // has one link, hence one broker, shared by every screen on it).
      releaseRequester();
      compose?.stop();
      info?.close();
      sessionTitleWatch?.();
      sessionTitleWatch = undefined;
      activityWatch?.();
      activityWatch = undefined;
      await deps.controller.leave(deps.sessionId);
      emit();
    },
    async resync(silent = false) {
      // Already running, or nothing to re-read: a second pull is a no-op (the
      // list would otherwise re-enter `attach` and be refused by its own guard).
      if (refreshing || disposed) {
        return;
      }
      deps.trace?.({ kind: "resync", state: "start" });
      refreshing = true;
      // A FOREGROUND resync (item 2) is silent: no pull spinner, because the
      // person made no gesture and nothing is left to look ignored.
      if (!silent) {
        pulling = true;
        emit();
      }
      const before = transcript.rows.length;
      try {
        // The owner's own recovery: leave, then re-attach. `attach` is the ONE
        // path in (AGENTS §7), so a resync cannot diverge from a first mount.
        await deps.controller.leave(deps.sessionId);
        handle = null;
        if (disposed) {
          return;
        }
        await attach(false);
        if (status.phase !== "open") {
          // Offline / archived / gone: the re-attach failed typed. The rows are
          // KEPT (never an empty transcript) and the failure is honest — the
          // banner already shows its reason, so this only says why nothing moved.
          notice = RESYNC_FAILED_NOTICE;
          deps.trace?.({ kind: "resync", state: "failed" });
        } else if (transcript.rows.length === before && before > 0) {
          // The daemon answered with exactly what is shown: worth saying only
          // when there was something to compare, so a fresh empty session is quiet.
          notice = null;
          deps.trace?.({ kind: "resync", state: "kept" });
        } else {
          deps.trace?.({ kind: "resync", state: "done" });
        }
      } finally {
        refreshing = false;
        pulling = false;
        emit();
      }
    },
    async compact() {
      const session = handle;
      if (session?.compact === undefined || status.phase !== "open" || !rowReady("compact")) {
        return;
      }
      const control = new AbortController();
      const mine = { control, since: deps.now() };
      compaction = mine;
      compactFailed = null;
      dropCompacted();
      emit();
      let line: OutcomeLine | null;
      try {
        await session.compact(control.signal);
        line = compactOutcome({ ok: true });
      } catch (error) {
        line = compactOutcome({ ok: false, error });
      }
      // A late answer (the screen left, or another try replaced it): the daemon
      // keeps its result, and this screen has nothing left to say about it.
      if (disposed || compaction !== mine) {
        return;
      }
      compaction = null;
      if (line === null) {
        compactedAt = deps.now();
        compactedTimer = setTimeout(() => {
          compactedTimer = null;
          emit();
        }, COMPACTED_SHOWN_MS);
      } else {
        pushLine(line);
        compactFailed = line.level === "warn" ? line.text : null;
      }
      emit();
    },
    cancelCompaction() {
      compaction?.control.abort();
    },
    armClear() {
      if (!rowReady("clear")) {
        return;
      }
      clearArmed = clearConfirm(clearArmed, "arm").armed;
      emit();
    },
    cancelClear() {
      clearArmed = clearConfirm(clearArmed, "cancel").armed;
      emit();
    },
    async clear() {
      const ready = rowReady("clear");
      const step = clearConfirm(clearArmed, "confirm");
      clearArmed = step.armed;
      const session = handle;
      if (!step.run || !ready || session?.clear === undefined || status.phase !== "open") {
        emit();
        return;
      }
      clearing = true;
      emit();
      let line: OutcomeLine;
      try {
        const result = await session.clear();
        line = clearOutcome({ ok: true, ...result }, FORK_KEPT);
      } catch (error) {
        line = clearOutcome({ ok: false, error }, FORK_KEPT);
      }
      if (disposed) {
        return;
      }
      clearing = false;
      // The `history{clear}` already replaced the rows; the line follows them.
      pushLine(line);
      dropCompacted();
      compactFailed = null;
      emit();
    },
    retryLast() {
      const last = lastUserRow();
      if (last === undefined || !rowReady("retry")) {
        return;
      }
      // The composer's OWN path: the text goes into the (empty — `fieldBusy`)
      // field and the one tap decides wire, queue or outbox, refusal handling
      // unchanged. Files are not re-sent (TUI `/retry`), and a line says so.
      draft = last.text;
      act();
      if (last.images.length > 0 || (last.documents?.length ?? 0) > 0) {
        pushLine({
          text: last.images.length > 0 ? RETRY_PHOTOS_NOT_SENT : RETRY_FILES_NOT_SENT,
        });
      }
      emit();
    },
    dispose() {
      disposed = true;
      render.dispose();
      dropCompacted();
      listeners.clear();
      unwatchInfo();
      unwatchRefresh?.();
      unmount.abort();
      compose?.stop();
      info?.close();
      sessionTitleWatch?.();
      sessionTitleWatch = undefined;
      activityWatch?.();
      activityWatch = undefined;
      // Idempotent and identity-scoped: a dispose that lands AFTER the next
      // screen mounted its requester withdraws nothing.
      releaseRequester();
    },
  };
  holder.current = controller;
  return controller;
}
