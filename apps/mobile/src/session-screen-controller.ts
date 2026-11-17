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
  JobOutputResult,
  JobRow,
  SessionContextResult,
  SessionSkillsResult,
  SubagentRow,
} from "@tentacle/protocol";
import { DomainErrorCode } from "@tentacle/transport";
import { RpcError } from "@tentacle/transport";
import { type ActivityMemory, emptyMemory, markOpened, onSubagents } from "./activity-memory.ts";
import type { ArtifactFeed } from "./artifact-feed.ts";
import {
  EMPTY_JOIN,
  type ArtifactJoin,
  joinRows,
  phaseOfError,
  withList,
  withPhase,
} from "./artifact-join.ts";
import type { Compose, ComposeHandle, PhotoPort } from "./compose-controller.ts";
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
import type { LocalPhoto } from "./transcript-rows.ts";
import { type State, initialState } from "./transcript.ts";

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
export interface SendableHandle extends SessionHandle, ActivityHandle {
  send(
    prompt: string,
    signal?: AbortSignal,
    opts?: {
      readonly turnId?: string;
      readonly attachments?: readonly AttachmentRef[];
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
    ) => Promise<void>;
    /** 13b's hand-back: an item whose text belongs in the field (F7/F20). */
    readonly onDraft: (item: OutboxItem, why: "archived" | "deleted" | "gone" | "busy") => void;
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
  /** Session info opened: start every pull (F1–F5 live in the controller). */
  openInfo(): Promise<void>;
  /** The sheet closed: drop in-flight answers and stop following the link (F5). */
  closeInfo(): void;
  /** Pull-to-refresh, and a `Retry` row (and the port's link `up`, its own). */
  refreshInfo(): Promise<void>;
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
  /** A chip's × : forget that photo (13d). */
  removeChip(key: string): Promise<void>;
  /** **Send now**, beside the queue (13d, D1). */
  sendNow(): Promise<void>;
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
  resync(): Promise<void>;
  /** Unsubscribe everything (the screen's cleanup, after `leave`). */
  dispose(): void;
}

/** The outbox's rows, from `session-view.ts`'s own projection (never built here). */
function outboxRows(
  items: readonly OutboxItem[],
  base: Omit<SessionViewInput, "outbox">,
): readonly OutboxRowView[] {
  return sessionView({ ...base, outbox: items }).outbox;
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
  };
  /** The last attached handle's `onSubagents`/`onJobs` subscriptions. */
  let activityWatch: (() => void) | undefined;
  /** The rename field (Owner decision 5): `null` while it is closed. */
  let renaming: RenameState | null = null;
  /**
   * Session info (docs/feat/mobile-session-info.md). Built over the ONE client
   * stack (`deps.info` hands back the port the app wired), and it reads the
   * handle LIVE: the attach that creates it happens after this.
   */
  const infoPort = deps.info === undefined ? null : deps.info(() => handle);
  /** This phone's own turn's abort (Stop, for `own: true`). */
  let ownControl: AbortController | null = null;
  let disposed = false;
  const unmount = new AbortController();
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
    put: (next) => {
      // A REPLACED history rebuilds every row from `ChatMessage`s, which carry no
      // tool details: the cards this screen already knows are joined back on HERE,
      // the one place every folded state passes, so a resync never loses them.
      transcript = joinedRows(next);
      emit();
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
            prompt: (text, turnId, refs, photos) => promptWithRefs(text, turnId, refs, photos),
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
          }),
          photos: deps.compose.photos,
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
          ownQueue: 0,
          sendNow: false,
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
        outbox: outboxRows(value.outbox, {
          title: shownTitle,
          project: deps.project,
          status,
          rows: [],
          turn: transcript.turn,
          link: transcript.link,
          ended: transcript.closed,
          draft,
          archived: deps.archived,
        }),
        notSaved: value.notSaved,
        chips: value.chips,
        ownQueue: value.ownQueue,
        sendNow: value.sendNow,
      },
    };
  }

  function view(): SessionView {
    const composeState = composeView().bar;
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
      notSaved: composeState.notSaved,
      photos: composeState.chips.map((chip) => ({
        key: chip.key,
        state: chip.state,
        ...(chip.name === undefined ? {} : { name: chip.name }),
        ...(chip.state === "refused" ? { detail: chip.detail } : {}),
      })),
      ownQueue: composeState.ownQueue,
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
  let refreshing = false;

  function state(): SessionScreenState {
    return {
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
      refreshing,
      artifacts: join,
    };
  }

  /**
   * Follow the handle's background lists (S8). Each subscription hands the
   * current list at once (the open snapshot's — F13), then every replace. A
   * handle without them (an older client, a fake) leaves both `null` (F15).
   */
  function watchActivity(session: SendableHandle): () => void {
    const offAgents = session.onSubagents?.((rows) => {
      const memory = onSubagents(activity.memory, rows, deps.now());
      // A child's messages live as long as it is live or Finished (bounded with it).
      const keep = new Set([...rows.map((r) => r.id), ...memory.finished.map((f) => f.row.id)]);
      activity = { ...activity, subagents: rows, memory, sent: pruneSent(activity.sent, keep) };
      emit();
    });
    const offJobs = session.onJobs?.((report) => {
      activity = { ...activity, jobs: { rows: report.rows, count: report.count } };
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

  function emit(): void {
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
    // The cards of a resumed transcript (docs/feat/model-artifacts.md D9): the
    // history that landed has no tool details, so the daemon's list is the only
    // source. Asked at every attach — a live turn's card arrives by itself.
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
  ): Promise<void> {
    const session = handle;
    if (session === null) {
      return Promise.resolve();
    }
    const control = new AbortController();
    ownControl = control;
    notice = null;
    emit();
    const run = untilAccepted(
      (onAccepted) => session.send(text, control.signal, { turnId, attachments: refs, onAccepted }),
      // Folded as LOST by the feed on a throw; what the CALLER does about it is
      // `accepted`'s rejection.
      (events, accepted) =>
        feed.ownTurn(turnId, events, { text, attachments: refs, photos }, accepted),
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

  return {
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
    async removeChip(key) {
      await compose?.removeChip(key);
      emit();
    },
    async sendNow() {
      await compose?.sendNow();
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
    async resync() {
      // Already running, or nothing to re-read: a second pull is a no-op (the
      // list would otherwise re-enter `attach` and be refused by its own guard).
      if (refreshing || disposed) {
        return;
      }
      refreshing = true;
      emit();
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
        } else if (transcript.rows.length === before && before > 0) {
          // The daemon answered with exactly what is shown: worth saying only
          // when there was something to compare, so a fresh empty session is quiet.
          notice = null;
        }
      } finally {
        refreshing = false;
        emit();
      }
    },
    dispose() {
      disposed = true;
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
}
