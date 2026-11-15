import { homedir } from "node:os";
import { Session } from "@tentacle/agent";
import {
  type AttachmentRef,
  DISMISSED,
  type WakeModel,
  initialWake,
  wakeStep,
} from "@tentacle/core";
import { useApp, useInput, useStdout } from "ink";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { AppView } from "./AppView.tsx";
import { frameLayout } from "./app-layout.ts";
import { type AttachDraft, EMPTY_DRAFT, removeLastChip, uploadDone } from "./attach-draft.ts";
import { type AttachedImage, type FileProbe, nodeFileProbe } from "./attach-files.ts";
import {
  type DockOutcome,
  applyLateOutcome,
  clickDock,
  downToDock,
  reconcile,
} from "./background-focus.ts";
import {
  BLINK_HALF_MS,
  BLINK_IDLE,
  type BlinkClock,
  advanceBlink,
  blinkPhase,
  blinkState,
  syncBlink,
} from "./blink.ts";
import { idleChord } from "./chord.ts";
import { copyToClipboard, readClipboard } from "./clipboard.ts";
import { type QuitConfirmFacts, oneLine, paletteStep } from "./commands.ts";
import { dispatchCommand } from "./commands/dispatch.ts";
import { useDockClock, useLineEditor, useLinkIndicator, usePaintScheduler } from "./hooks.ts";
import type { HopSpec } from "./hop-command.ts";
import { hopShownCwd, hopStatusRow } from "./hop-status.ts";
import { startIdleWarm } from "./idle-warm.ts";
import { JOB_TAIL_SHOWN, exitOutcome, jobOutputEntry, refreshDue } from "./job-drawer.ts";
import { type KeyHost, executeEffects } from "./keys/execute.ts";
import { PURE_LAYERS } from "./keys/layers.ts";
import { resolveLineEffects } from "./keys/line-layer.ts";
import { routeKey } from "./keys/route.ts";
import { stoppedNotice } from "./link-status.ts";
import { type OpenPanel, panelClick } from "./panel.ts";
import { pasteTarget, sanitizePasted } from "./paste.ts";
import { insertReply, orphanNotice } from "./permission-reply.ts";
import {
  type AutoAcceptFeed,
  type AutoAcceptSharedFeed,
  type DraftBack,
  autoAcceptTest,
  usePermissionBroker,
} from "./permission-ui.ts";
import { useAttachments } from "./useAttachments.ts";
import { useDock } from "./useDock.ts";
import { useHop } from "./useHop.ts";
import { useMouse } from "./useMouse.ts";
import { usePanels } from "./usePanels.ts";
import { useQuitClear } from "./useQuitClear.ts";
import { useSessionLink } from "./useSessionLink.ts";
import { type HopTurnPort, useTurnDriver } from "./useTurnDriver.ts";
import { tryWake } from "./wake-gate.ts";

export type { AutoAcceptFeed, AutoAcceptSharedFeed };

import { type DaemonQueue, type QueuedRows, handBackRows } from "./queued.ts";
import { type RenderOptions, layoutTranscript, sliceLaid, warmRowsChunk } from "./render-lines.ts";
import { runChunked } from "./run-chunked.ts";
import { anchorOffset, applyScroll, clampOffset, isScrolledUp, windowFor } from "./scroll.ts";
import type { Selection } from "./selection.ts";
import { withRestored } from "./send-now.ts";
import { SkillsSync } from "./skills-sync.ts";
import {
  type DisplayItem,
  type DisplayState,
  type SessionEvent,
  appendBackgroundExit,
  appendNotice,
  backgroundExitNotice,
  initialState,
  pushNoticeItem,
} from "./state.ts";
import type { ContextOpen } from "./status-view.ts";

import { type SessionActivity, warmFailureNotice } from "./turn-feed.ts";

// `AppProps`/`SessionController`/`HopTargetView` are used here; the rest are
// re-exported below so every existing importer (`../src/App.tsx`) keeps working —
// a `from` re-export publishes the module's export, not this import.
import type { AppProps, HopTargetView, SessionController } from "./app-types.ts";

export type {
  AppProps,
  HopFeed,
  HopRun,
  HopTargetView,
  HopPlaceView,
  NoticeFeed,
  SessionController,
  SessionDirectory,
  SettingsNoticeLine,
  TargetFeed,
} from "./app-types.ts";
// `RunQuit` moved with S8 to the hook that executes it; it is re-exported here
// for every importer that names `../src/App.tsx` (the test boundary).
export type { RunQuit } from "./useQuitClear.ts";

const FRAME_MS = 33; // ~30fps streaming throttle
// If a bracketed paste's closing marker never arrives, recover this long after
// the last paste chunk: flush what we captured and leave paste mode, so input
// is never frozen. Real pastes stream their chunks within one pty read window,
// far faster than this, so a legitimate paste never trips it.
const PASTE_TIMEOUT_MS = 250;

const WELCOME = "Tentacle ready. Type a task, or `/help` for commands.";

// Clipboard reads are trimmed: copied terminal output often has a trailing
// newline that would otherwise land as a stray blank line.
const flattenPasted = (text: string): string => sanitizePasted(text).trim();

/** The real file seam and the laptop's own paths (a test injects all three). */
const defaultFileProbe: FileProbe = nodeFileProbe();
/** `os.homedir()`, tolerant of a host that cannot answer (`~` then stays as typed). */
function defaultHome(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}
/** The laptop process's cwd: what a relative `/attach` path means (P15). */
function defaultLocalCwd(): string {
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

/**
 * A send-now in progress (docs/feat/send-now-c.md). `atomic`: the request is
 * out, or its new turn waits for the old turn's end. `fallback` (an older
 * daemon, or no `sendNow`): what is left of the rows is sent once the old
 * turn ends.
 */
/** What a streamed turn is (`streamTurn`). */
interface StreamOpts {
  /** A send-now's new turn: the rows hand off on its first event. */
  readonly successor?: boolean;
  /** Another device's turn (or one running when this TUI attached). */
  readonly foreign?: boolean;
  /**
   * My own prompt: its bubble and text, withdrawn / restored if it loses the
   * slot. `images`: its refs' row texts — an image-only prompt has none of the
   * text, so it is a prompt, never a wake (docs/feat/attachments-tui.md P10).
   */
  readonly own?: {
    readonly item: DisplayItem | undefined;
    readonly text: string;
    readonly images?: readonly string[];
    /** The chips whose refs this prompt named: put back if the daemon refuses them. */
    readonly restoreChips?: readonly AttachedImage[];
  };
}

interface PendingSendNow {
  mode: "atomic" | "fallback";
  /** The new turn's controller (`atomic`): Esc in the window cancels through it. */
  readonly next: AbortController | null;
  /** The new turn's events, once acknowledged. */
  successor: AsyncIterable<SessionEvent> | null;
  /** A resync replaced the transcript since the chord (read by the fallback only). */
  resetSeen: boolean;
}

export function App({
  agent,
  createSession,
  model,
  modelLabel,
  cwd,
  contextWindow = 128000,
  target,
  permissions,
  jobs,
  autoWakeOnJobExit = true,
  subagentsTwoWay = false,
  wakePending = false,
  wakeHanded = false,
  notices,
  link,
  mcpStatus,
  clipboard = copyToClipboard,
  paste = readClipboard,
  fileProbe = defaultFileProbe,
  home = defaultHome(),
  localCwd = defaultLocalCwd(),
  saveFile = (path, content) => Bun.write(path, content).then(() => undefined),
  initialItems,
  initialPrompt,
  daemonInPod = false,
  detachOnQuit = false,
  sessions,
  runQuit,
  autoAccept,
  autoAcceptShared,
  hop,
  targetFeed,
  columns: fixedColumns,
  jobRefreshMs,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // The name the screen SHOWS for the model: the daemon's own, when `connect`
  // learned it at `initialize`; `model` otherwise. Never read by a decision —
  // `model === "remote"` still means "the daemon's model" (the error hint).
  const shownModel = modelLabel ?? model;

  const [size, setSize] = useState(() => ({
    columns: fixedColumns ?? stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));
  const [scrollOffset, setScrollOffset] = useState(0);
  const [expandAll, setExpandAll] = useState(false);
  // The tool calls whose full command is shown wrapped under the header (a left
  // click on ONE call; docs/feat/tui-tool-expand.md). Keyed by the call's stable
  // daemon id, so it survives re-renders and new messages; sorted, so it is a
  // cheap layout cache key. (The click recogniser's state lives in `useMouse`.)
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([]);
  // The ONE blink clock of running tool calls (docs/feat/tui-tool-blink.md).
  // `blink.ts` owns the whole rule — when the clock runs, when it restarts ON,
  // what a tick renders; the App only relays a timer into `advanceBlink` and
  // passes the resulting phase to the layout (AGENTS §7).
  const [blinkClock, setBlinkClock] = useState<BlinkClock>(BLINK_IDLE);
  const field = useLineEditor();
  // The LIVE field value for an async handler: `field` is this render's object,
  // so a promise that lands frames later would read a stale `field.value`
  // (Review H2's placement asks whether the field is empty NOW).
  const fieldValueRef = useRef("");
  fieldValueRef.current = field.value;
  const [commandIndex, setCommandIndex] = useState(0);
  // Messages the user queued while a turn is running (steering), shown above
  // the input until the agent injects them (a `steer` event clears them FIFO).
  // The ref is the truth (a send-now reads it synchronously); the state renders.
  const [queued, setQueued] = useState<QueuedRows>([]);
  const rowsRef = useRef<QueuedRows>([]);
  const setRows = useCallback((f: (rows: QueuedRows) => QueuedRows) => {
    rowsRef.current = f(rowsRef.current);
    setQueued(rowsRef.current);
  }, []);
  // Send-now (`Ctrl+X Ctrl+S`): the chord's state, the one in progress, the
  // ids it ever took (a late enqueue refusal of one says nothing), and the
  // per-session latches (reset when `/clear` opens a new session): the daemon
  // answered `MethodNotFound`; the fallback notice shown.
  const chordRef = useRef(idleChord);
  const sendNowRef = useRef<PendingSendNow | null>(null);
  const ownedIdsRef = useRef(new Set<string>());
  const sendNowUnsupportedRef = useRef(false);
  const fallbackNoticedRef = useRef(false);
  // This TUI's own `/compact` is running (docs/feat/send-now-d.md): Enter
  // queues a local row (no turn to enqueue to), the chord targets it. The ref
  // is the truth; the state renders the rows. `compactionOwnedRef`: a send-now
  // of ours took it — the rows are the send-now's, not the settle hook's.
  const compactingRef = useRef(false);
  /** The session a `/settings sync` is in flight on (docs/feat/session-settings-apply.md F4). */
  const syncingRef = useRef<SessionController | null>(null);
  const [compacting, setCompactingState] = useState(false);
  const setCompacting = useCallback((on: boolean) => {
    compactingRef.current = on;
    setCompactingState(on);
  }, []);
  const compactionOwnedRef = useRef(false);
  // Interactive tool-approval dialog + auto-accept (Shift+Tab), all self-contained.
  // Auto-accept answers only my own turns' requests: the current session decides.
  // A detached run's TUI: auto-accept is its session's, shared (`autoAccept`, B3).
  // A reply draft that was not sent goes back to the input (wired below, once
  // `restoreInput` exists; docs/feat/permission-reply.md).
  const draftBackRef = useRef<DraftBack | null>(null);
  // A pasted text's router (prose → insert, image paths → chips): a ref, because
  // the paste handlers are defined before the one that decides.
  const routeAttachRef = useRef<(text: string) => void>(() => {});
  // The last prompt named images: `/retry` re-sends its TEXT only, and says so
  // (docs/feat/attachments-tui.md decision 8).
  const lastHadImagesRef = useRef(false);
  const permission = usePermissionBroker(
    permissions,
    () => autoAcceptTest(sessionRef.current),
    autoAccept,
    (text, cause) => draftBackRef.current?.(text, cause),
  );
  // The open list panel (`/mcp`, `/skills`, `/sessions`; docs/feat/skills-panel.md)
  // or null. The panel's own state and its generation live in `usePanels` (S7);
  // the STATE stays here because the frame reads it (the palette's gate, the
  // list view) and `panelRef` is assigned in render, above every executor that
  // inserts text outside the key path.
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  // The panel as of the last render, for text inserted outside the key path
  // (a paste, a timer-flushed paste or held "["): behind a panel the hidden
  // input takes none of it.
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  // Bracketed paste: the carry-over buffer while a paste spans chunks, and its
  // recovery timer (see below). The MOUSE hold moved to `useMouse` (S4).
  const pasteBufRef = useRef<string | null>(null);
  // Recovery timer: fires if a paste's closing marker never arrives (see below).
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Shell-style prompt history, kept in refs (session-local, in-memory; the
  // input line is not React state, so no re-render is forced on recall).
  // `histIndexRef === historyRef.length` means "on the live draft" (see
  // `history.ts`); `draftRef` is the text saved when history is first entered,
  // restored once the walk returns to the draft slot.
  const historyRef = useRef<string[]>([]);
  const histIndexRef = useRef(0);
  const draftRef = useRef("");
  // The input's image chips + the upload in flight (docs/feat/attachments-tui.md
  // D6). The REF is the truth an async handler reads; the state renders and
  // feeds `inputBoxRows`. The one-decision-at-a-time chain (two pastes are
  // serialized, so `existing` is always the current chips) lives with the
  // executor, in `useAttachments.ts` — never a second one here; `attachGenRef`
  // stays, and drops a late result after an unmount.
  const [attach, setAttachState] = useState<AttachDraft>(EMPTY_DRAFT);
  const attachRef = useRef<AttachDraft>(EMPTY_DRAFT);
  const setAttach = useCallback((next: AttachDraft | ((prev: AttachDraft) => AttachDraft)) => {
    const value = typeof next === "function" ? next(attachRef.current) : next;
    attachRef.current = value;
    setAttachState(value);
  }, []);
  const attachGenRef = useRef(0);
  // The text a `convert` already probed and put back with `NOT_AN_IMAGE_NOTICE`:
  // the next Enter on that same text sends it as a message instead of probing
  // the same paths again forever (review round 2, finding R2-1).
  const probedTextRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      attachGenRef.current += 1; // a decision landing after this is ignored
      // Nothing is left half-sent on a quit either: an upload in flight is
      // aborted, exactly as Esc aborts it (the failure table's "unmount mid-
      // upload" row; review round 1, finding 3).
      uploadCtrlRef.current?.abort();
      uploadCtrlRef.current = null;
    };
  }, []);
  // Esc aborts an upload in flight (decision 7's neighbour: nothing is left half-sent).
  const uploadCtrlRef = useRef<AbortController | null>(null);

  const stateRef = useRef<DisplayState>({
    ...initialState,
    // A resumed session seeds its prior transcript; otherwise the welcome line.
    items:
      initialItems && initialItems.length > 0
        ? [...initialItems]
        : [{ kind: "assistant", text: WELCOME }],
  });
  const sessionRef = useRef<SessionController | null>(null);
  // What Esc/Ctrl+C aborts: the streamed turn's controller — or, while a
  // send-now's new turn is pending, that turn's (the old one is the daemon's
  // to cancel).
  const abortRef = useRef<AbortController | null>(null);
  // The controller of the turn being streamed, or null when none is.
  const streamCtrlRef = useRef<AbortController | null>(null);
  // This TUI stopped the current turn itself (Esc / Ctrl+C), cleared at the
  // next turn start: a hand-back of my rows then needs no "another device".
  const stoppedHereRef = useRef(false);
  // The current session's `onReturned` subscription (replaced with the session).
  const returnedSubRef = useRef<(() => void) | null>(null);
  // Row ids this TUI put back in the input itself (a send-now cancelled before
  // it started): the daemon's later `returned` of one is not given twice.
  const restoredRef = useRef(new Set<string>());
  // A quit asked for mid-turn: exit as soon as the turn settles (it is saved then).
  const exitPendingRef = useRef(false);
  // `/quit`'s confirmation: who else is attached and which background
  // sub-agents the quit would lose, or null. The ref is the truth for the key
  // handler; the state renders (docs/feat/subagent-background-ui.md).
  const [quitConfirm, setQuitConfirmState] = useState<QuitConfirmFacts | null>(null);
  const quitConfirmRef = useRef<QuitConfirmFacts | null>(null);
  const setQuitConfirm = useCallback((facts: QuitConfirmFacts | null) => {
    quitConfirmRef.current = facts;
    setQuitConfirmState(facts);
  }, []);
  // The controller of the FOREIGN turn being streamed (another device's), or
  // null: `/exit` leaves it running (docs/feat/tui-foreign-turns.md C4).
  const foreignRef = useRef<AbortController | null>(null);
  // Session activities that wait for one of my runs to settle (C2), in order.
  const heldRef = useRef<SessionActivity[]>([]);
  // The current session's `watch` / `onQueued` / `onSubagents` subscriptions
  // (replaced with it).
  const activitySubRef = useRef<(() => void) | null>(null);
  const queueSubRef = useRef<(() => void) | null>(null);
  const agentsSubRef = useRef<(() => void) | null>(null);
  /** The current session's `onJobs` subscription (replaced with it). */
  const jobsSubRef = useRef<(() => void) | null>(null);
  /** The current session's `onSubagentNotify` subscription (replaced with it). */
  const notifySubRef = useRef<(() => void) | null>(null);
  /** The current session's `onSubagentMessage` subscription (replaced with it). */
  const dockMsgSubRef = useRef<(() => void) | null>(null);
  // My `/compact`s whose history has not arrived yet: that compaction's notice
  // is mine ("Context compacted"), not "on another device" (C6).
  const ownCompactionsRef = useRef(0);
  // `/clear` (docs/feat/clear-keeps-jobs.md): one of this TUI's is in flight;
  // how many of its histories have not arrived yet (theirs is not "on another
  // device"); and a clear waiting for the own turn it stopped to end.
  const clearingRef = useRef(false);
  const ownClearsRef = useRef(0);
  const clearAfterTurnRef = useRef(false);
  const runClearRef = useRef<(() => void) | null>(null);
  // A `/move` (docs/feat/session-hop.md D3): its state and its three drivers
  // (`startHop`/`requestHop`/`hopIfQueued`) live in `useHop.ts` (S11), called
  // below. Two things stay here, because App declares them ABOVE that hook: the
  // forward ref an approved proposal starts through (assigned by the hook), and
  // the live place (`targetFeed`), so the badge and `daemonInPod` follow a move.
  const startHopRef = useRef<((spec: HopSpec, opts?: { gateAnswered?: true }) => void) | null>(
    null,
  );
  /**
   * The host's view of this TUI's own turns (docs/feat/session-hop.md D9, slice
   * H5): it folds each event (`hop.turn`), asks the owner at the turn's end
   * (`hop.turnEnd`), and hands back the line the next prompt must carry
   * (`hop.takeLine`). Nothing is decided here — the fold, the prompt's text and
   * the `once`-only rule all live in the cli's pure modules.
   *
   * A ref, not state: the driver reads it, the frame never renders it.
   */
  const hopTurnPort: HopTurnPort = {
    event: (event, own) => hop?.turn?.(event, own),
    end: async (own) => (await hop?.turnEnd?.(own)) ?? { kind: "none" },
    takeLine: () => hop?.takeLine?.() ?? null,
    // An approved proposal is an approved `/move`: the ONE place the view moves
    // starts it (D3), through the ref so no dependency cycle is created.
    approved: (spec, opts) => startHopRef.current?.(spec, opts),
  };
  const [targetView, setTargetView] = useState<HopTargetView | null>(() =>
    targetFeed ? targetFeed.current() : null,
  );
  // The badge and `daemonInPod` follow the place the session is at (D2's feed):
  // a hop changes them, and nothing else about the frame.
  useEffect(() => targetFeed?.onTarget((view) => setTargetView(view)), [targetFeed]);
  /** What the badge paints now (`null`: local, no badge, as today). */
  const shownTarget = targetFeed ? (targetView?.badge ?? null) : (target ?? null);
  /** A fact of the place the session is at now: a spilled file lives in the pod. */
  const shownInPod = targetFeed ? (targetView?.daemonInPod ?? false) : daemonInPod;
  /** The footer's and a tool ask's cwd: the hop target's own when it reports one (D4). */
  const shownCwd = hopShownCwd(targetFeed ? targetView : null, cwd);
  // A long history is being warmed before it is committed (C8): activities wait.
  const warmingRef = useRef(false);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  // The daemon's queue (every writer's waiting rows), as last reported (C7).
  const [daemonQueue, setDaemonQueueState] = useState<DaemonQueue | undefined>(undefined);
  // The same list for the callbacks that must not re-create themselves on every
  // frame (a `/move`'s turn-boundary read, D4): a ref, updated where it is set —
  // here, the ONE setter `useSessionLink` (S9b) calls for every report and reset.
  const daemonQueueRef = useRef<DaemonQueue | undefined>(undefined);
  const setDaemonQueue = useCallback((next: DaemonQueue | undefined) => {
    daemonQueueRef.current = next;
    setDaemonQueueState(next);
  }, []);
  // ── the dock (S5 — docs/feat/app-decomposition.md) ─────────────────────────
  // The background rows, the dock's focus/drafts/`sent`, the per-job output
  // cache and the four dock actions live in `useDock`. Its EFFECTS stay here, in
  // today's order (Fable H1 / owner Q7 (a)): the hook declares none, and returns
  // the refs and derived triggers they read. The destructuring keeps every
  // pre-S5 identifier (Fable M1), so no use site below changes.
  //
  // `pushNotice` is declared BELOW this hook (it needs `flushNow`, and this
  // block's refs are needed by an effect declared above it): it travels as a ref,
  // the same late binding `routeAttachRef`/`runRef`/`warmErrorRef` already use.
  const pushNoticeRef = useRef<(text: string) => void>(() => {});
  const dockLayer = useDock({
    sessionRef,
    field,
    fieldValueRef,
    pushNoticeRef,
    jobRefreshMs,
  });
  const { subagents, subagentsRef, setAgents, dockLastRowsRef } = dockLayer;
  const { jobRows, jobRowsRef, setJobs, dockLastJobRowsRef } = dockLayer;
  const { dockOutcomeRef, dockFinishedRef, dockStoppedRef } = dockLayer;
  const { jobOutputRef, setJobOutputGen, jobReadAtRef } = dockLayer;
  const { dock, dockRef, setDock, dockIds, dockVisible } = dockLayer;
  const { drawerRow, drawerJob } = dockLayer;
  const { dockSeenRef, dockIdKey, jobTargetId, jobEndedWhileOpen, refreshMs } = dockLayer;
  const { killChild, killJob, toggleAgents, submitToTarget } = dockLayer;
  const layoutOptsRef = useRef<RenderOptions>({
    expandAll: false,
    width: 80,
    spillInPod: shownInPod,
  });
  const lastUserRef = useRef<string | null>(null);
  const prevRowsRef = useRef(0);
  // Generation token for the background resize re-layout warm: a newer resize
  // (or unmount) bumps it so the in-flight warm aborts instead of committing.
  const warmGenRef = useRef(0);
  // Cancels the idle warm of the other Ctrl+O view (idle-warm.ts).
  const idleWarmCancelRef = useRef<() => void>(() => {});
  // Where the two background warms (a resize re-layout, the idle warm) surface a
  // throwing chunk. Neither awaits `done`, so without this the throw would be an
  // unhandled rejection (docs/feat/tui-run-chunked.md, Review R1). Set where
  // `pushNotice` is defined, below — the effects only call it later.
  const warmErrorRef = useRef<(error: unknown) => void>(() => {});
  // Autonomous wake on a background-job exit: a job that finishes while a turn
  // is running sets this, so the wake fires once the current turn settles (the
  // running turn won't see the exit — the agent flushes exits at turn START).
  // The decision is `@tentacle/core`'s, shared with a detached run's relay.
  const wakeRef = useRef<WakeModel>(wakePending || wakeHanded ? { pending: true } : initialWake);
  // The relay's wake, handed over: this TUI is its only owner, so if it loses
  // the slot to the adopted turn (not seen here yet) it is owed once more.
  const handedWakeRef = useRef(wakeHanded);
  // Latest `run`, so the jobs subscription and the post-turn check can start a
  // continuation turn without re-subscribing or a circular callback dependency.
  const runRef = useRef<
    | ((
        text: string,
        opts?: {
          continuation?: boolean;
          fallback?: boolean;
          skill?: string;
          attachments?: readonly AttachmentRef[];
          images?: readonly AttachedImage[];
        },
      ) => void)
    | null
  >(null);
  // Build a session from the factory, or from the local agent by default.
  const makeSession = useCallback((): SessionController => {
    if (createSession) {
      return createSession();
    }
    if (!agent) {
      throw new Error("App requires either `agent` or `createSession`");
    }
    return new Session(agent);
  }, [createSession, agent]);
  if (sessionRef.current === null) {
    sessionRef.current = makeSession();
  }
  // The current session's skills and when to ask again (`skills-sync.ts`); a
  // changed `/name` list re-renders the popup.
  const [, setSkillsVersion] = useState(0);
  const skillsSyncRef = useRef<SkillsSync | null>(null);
  if (skillsSyncRef.current === null) {
    skillsSyncRef.current = new SkillsSync(() => setSkillsVersion((n) => n + 1));
  }
  const skillsSync = skillsSyncRef.current;
  const [contextOpen, setContextOpen] = useState<ContextOpen | null>(null);
  const skills = useCallback(() => skillsSync.slash(), [skillsSync]);
  // The latest `handleCommand`: an unknown `/word` resolves again through it.
  const handleCommandRef = useRef<((raw: string, again?: boolean) => void) | null>(null);
  // Typing the `/` that opens the popup asks for a fresh list (not every key).
  const prevInputRef = useRef("");
  useEffect(() => {
    skillsSync.input(prevInputRef.current, field.value);
    prevInputRef.current = field.value;
  }, [field.value, skillsSync]);

  // --- throttled rendering -------------------------------------------------
  const { scheduleFlush, flushNow } = usePaintScheduler(FRAME_MS);
  const linkView = useLinkIndicator(link);

  // `wakeIfPending`, through a ref: the exit handler below is declared first.
  const wakeIfPendingRef = useRef<(() => void) | null>(null);
  // The mount effect that watches the session has run (set by it, below).
  const watchedRef = useRef(false);

  // --- live background-job exits -------------------------------------------
  /**
   * The ONE wake step a live notice arms (a background exit's, a child's
   * message to the agent): if a turn is running, defer to its post-turn check
   * (it flushes the notes at its next start); if idle, start a continuation
   * turn now. Multiple notices coalesce — the agent drains them all at the next
   * turn's start (docs/feat/agent-message-two-way.md Design 7).
   */
  const armWake = useCallback((): void => {
    wakeRef.current = wakeStep(wakeRef.current, { type: "exit" });
    // Before the session is watched (a subscriber's backlog — exits that arrived
    // before the TUI mounted — is delivered inside THIS effect, ahead of the
    // watch effect): never start the turn here. The history the watch replays
    // next would wipe its rows (docs/fix/attach-unflushed-exits.md, round 3).
    // The deferred check runs after every mount effect, re-reading the gate.
    if (!watchedRef.current) {
      wakeIfPendingRef.current?.();
      return;
    }
    // The GATE and the step are `tryWake`'s (S13): `idle` is the negation of the
    // live `running` ref, `blocked` is the `/clear` latch — derived in ONE place,
    // so this path and `wakeIfPending` cannot disagree about either (review H2).
    const attempt = tryWake(wakeRef.current, {
      enabled: autoWakeOnJobExit,
      running: stateRef.current.running,
      clearing: clearingRef.current,
    });
    wakeRef.current = attempt.model;
    if (attempt.wake) {
      runRef.current?.("", { continuation: true });
    }
  }, [autoWakeOnJobExit]);

  // Surface a finished background job the instant it exits, even while idle.
  // The agent also emits a `background_exit` event at the next turn; the shared
  // jobId dedupes (appendBackgroundExit) so the notice shows exactly once.
  useEffect(() => {
    if (!jobs) {
      return;
    }
    return jobs.onExit((job) => {
      // The outcome's RULE is `exitOutcome`'s (S13): a child's own stop reason, or
      // the shell job's record. `endedAt` is stamped ONCE here — this handler runs
      // once per exit, and the drawer's duration is the job's total run time, so a
      // frozen drawer must not keep measuring to `now` (fix round 2).
      const outcome: DockOutcome = exitOutcome(job, dockStoppedRef.current.has(job.id), Date.now());
      dockOutcomeRef.current[job.id] = outcome;
      // An open drawer may already have frozen on the `stopped` fallback (its row
      // left before this record arrived — review 3): the record is the truth, so
      // correct it now, whatever macrotask the transport used.
      setDock((prev) => applyLateOutcome(prev, job.id, outcome));
      // The pill celebrates it for ~5 s (status-view.ts owns the window), then
      // shows the new counts; the LAST one to end leaves no pill at all.
      dockFinishedRef.current = { id: job.id, at: Date.now() };
      stateRef.current = appendBackgroundExit(
        stateRef.current,
        backgroundExitNotice(job.id, job.command, job.status, job.exitCode, job.agent),
      );
      setScrollOffset(0);
      flushNow();
      // Autonomous wake: react to the exit without a user prompt.
      armWake();
    });
    // The dock's refs are STABLE objects (`useDock`'s `useRef`s), so naming them
    // here satisfies the rule without re-subscribing on a render (Fable H2: deps
    // name the fields, never the port).
  }, [jobs, flushNow, armWake, setDock, dockFinishedRef, dockOutcomeRef, dockStoppedRef]);

  // --- host notices ----------------------------------------------------------
  // ONE effect for everything that appends a notice from outside a turn: the
  // host feed, and (below) the session's auto-accept when another DEVICE flips
  // it (docs/feat/session-auto-accept.md D5). App keeps exactly its pinned
  // effect count (the structural tests), so a second notice source joins this
  // one rather than adding an effect.
  const autoAcceptSeenRef = useRef<boolean | null>(null);
  useEffect(() => {
    const announceAutoAccept = (on: boolean): void => {
      const was = autoAcceptSeenRef.current;
      autoAcceptSeenRef.current = on;
      if (was === null || was === on) {
        // `null` at a mount: the state a TUI starts in is never "news".
        return;
      }
      if (!(autoAcceptShared?.remote() ?? false)) {
        // THIS TUI's own flip (or its echo): no notice — the status bar says it.
        return;
      }
      // The setter's label is daemon-supplied text: sanitized, never rendered raw.
      const by = autoAcceptShared?.lastBy();
      const who = by === undefined ? "another device" : oneLine(by);
      stateRef.current = appendNotice(
        stateRef.current,
        `auto-accept turned ${on ? "on" : "off"} from ${who}`,
      );
      setScrollOffset(0);
      flushNow();
    };
    let offAutoAccept: (() => void) | undefined;
    if (autoAcceptShared) {
      // The value it starts in is never news; only a LATER flip is.
      announceAutoAccept(autoAcceptShared.current());
      offAutoAccept = autoAcceptShared.onChange(announceAutoAccept);
    }
    const offNotices = notices?.onNotice((text, hint) => {
      // `host`: an attach's notice outlives the history that follows it (A6).
      stateRef.current = appendNotice(stateRef.current, text, {
        host: true,
        ...(hint ? { hint } : {}),
      });
      setScrollOffset(0);
      flushNow();
    });
    return () => {
      offAutoAccept?.();
      offNotices?.();
    };
  }, [notices, autoAcceptShared, flushNow]);

  // --- a link stop's full reason (the StatusBar row truncates it) -------------
  useEffect(() => {
    if (!link) {
      return;
    }
    // A client stops once; the last text guards a re-subscribe all the same.
    let last: string | null = null;
    return link.onLinkStatus((status) => {
      const text = stoppedNotice(status);
      if (text === null || text === last) {
        return;
      }
      last = text;
      stateRef.current = appendNotice(stateRef.current, text);
      setScrollOffset(0);
      flushNow();
    });
  }, [link, flushNow]);

  // --- terminal resize -----------------------------------------------------
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") {
      return;
    }
    const onResize = (): void => {
      const next = { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
      // Height-only change: wrapping is unaffected, so resize the viewport now.
      if (next.columns === size.columns) {
        setSize(next);
        return;
      }
      // Width change: re-wrapping the whole transcript is O(transcript) and would
      // freeze the frame. Warm the row cache at the new width off the render
      // thread in time-budgeted chunks, then commit — the committing render is
      // then all cache hits. A newer resize bumps the token and supersedes this
      // warm, coalescing a drag storm onto the latest width.
      warmGenRef.current += 1;
      idleWarmCancelRef.current();
      const gen = warmGenRef.current;
      const items = stateRef.current.items;
      // Including `expandedIds`: the warm must fill the slot the committing
      // render will ask for, a clicked call's expanded command too.
      const opts = { expandAll, width: next.columns, spillInPod: shownInPod, expandedIds };
      runChunked(items.length, (from, budgetMs) => warmRowsChunk(items, opts, from, budgetMs), {
        isStale: () => warmGenRef.current !== gen,
        onDone: () => setSize(next),
        onError: (error) => warmErrorRef.current(error),
      });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off?.("resize", onResize);
      warmGenRef.current += 1; // cancel any in-flight warm on unmount/resubscribe
    };
  }, [stdout, size.columns, expandAll, shownInPod, expandedIds]);

  // Reset the palette selection whenever the typed text changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on field.value
  useEffect(() => setCommandIndex(0), [field.value]);

  // --- the frame's view-model (S10 — docs/feat/app-decomposition.md) --------
  // Every row derived below used to be inline here, from `activeRows` down to the
  // status bar's position; they are `app-layout.ts`'s `frameLayout` now (AGENTS §7:
  // computation and branching in a pure module, the component only paints the
  // result). The ONE hook the rows need stays HERE — `useDockClock` owns an
  // effect, and App's effect list keeps its order (Fable H1) — at its old place.
  const dockNow = useDockClock(dock.focus.kind !== "input" || dockVisible());
  /** The transcript's state this frame paints (`stateRef` is the truth; this reads it). */
  const st = stateRef.current;
  const view = frameLayout({
    state: st,
    permission,
    dock,
    dockNow,
    subagents,
    subagentsRef,
    jobRows,
    jobRowsRef,
    drawerRow,
    drawerJob,
    jobOutput: jobOutputRef.current,
    dockFinished: dockFinishedRef.current,
    quitConfirm,
    panel,
    sessionId: sessionRef.current?.sessionId ?? null,
    field,
    attach,
    skills: skills(),
    commandIndex,
    sizeColumns: size.columns,
    sizeRows: size.rows,
    contextOpen,
    queued,
    daemonQueue,
    loading,
    compacting,
  });
  const frame = { ...view, st };
  // The rows App itself still reads (the key path's snapshot, the mouse layer's
  // snapshot, the effect deps, and the model it hands `AppView`).
  const { columns, paletteCommands, paletteOpen, commandSel } = view;
  const { listView, shown, viewport, panelBodyTop, dockTop, dockView, replyMax } = view;
  const replyMaxRef = useRef(0);
  replyMaxRef.current = replyMax;
  const { readMode: readReplyMode, setMode: setReplyMode } = permission;
  /** Text from outside the key path (a paste, Ctrl+V) into the open reply field; false if none is open. */
  const insertIntoReply = useCallback(
    (text: string): boolean => {
      const mode = readReplyMode();
      if (mode.mode !== "reply") {
        return false;
      }
      setReplyMode(insertReply(mode, text, replyMaxRef.current));
      return true;
    },
    [readReplyMode, setReplyMode],
  );
  // Where the STATUS BAR's row is on screen, and the pill's cells on it, as the
  // last render reported them (docs/feat/subagent-panel.md: "a click on the
  // pill's cells opens the dropdown"). `StatusBar` computes the row's layout and
  // reports the range; the App must not re-derive either (AGENTS §7: one source
  // of truth — the component paints and reports, it decides nothing). The ROW is
  // `frame.statusRowY` (the same arithmetic, in the view-model's one place).
  const statusRowRef = useRef<{
    readonly y: number;
    readonly pill: { readonly start: number; readonly end: number } | null;
  } | null>(null);
  // Positional layout only (O(items) cache lookups, no full array): take the
  // row `total` for scroll maths and materialise just the visible window. The
  // whole transcript is assembled on demand (sliceLaid 0..total) only where a
  // full buffer is genuinely needed — a text selection on mouse-release.
  const blink = blinkState(st.items, st.running);
  const layout = layoutTranscript(st.items, {
    expandAll,
    width: columns,
    spillInPod: shownInPod,
    blinkPhase: blinkPhase(blinkClock, blink),
    expandedIds,
  });
  // ARM the ONE blink clock: `blink.running` is the whole gate (the turn runs AND
  // a call is unanswered), so an idle transcript has no timer at all and a dead
  // call left in the transcript by a failed turn cannot blink forever. A new call
  // re-arms it, which restarts the shared phase ON (owner decisions 1 and 2).
  const blinkRuns = blink.running;
  const blinkCalls = blink.calls;
  useEffect(() => {
    if (!blinkRuns) {
      return;
    }
    const id = setInterval(() => setBlinkClock((c) => advanceBlink(c, blinkCalls)), BLINK_HALF_MS);
    return () => clearInterval(id);
  }, [blinkRuns, blinkCalls]);
  // Nothing running → the clock goes back to idle, so the next call starts ON
  // and a finished row is never left on an OFF half. `syncBlink` returns the
  // SAME object when nothing changes, so this cannot loop.
  useEffect(() => {
    setBlinkClock((c) => syncBlink(c, { calls: blinkCalls, running: blinkRuns }));
  }, [blinkRuns, blinkCalls]);
  // The layout options a history warm uses (read off the render thread).
  layoutOptsRef.current = { expandAll, width: columns, spillInPod: shownInPod, expandedIds };
  // Once the transcript is quiet, fill the cache for the OTHER Ctrl+O view in
  // small chunks (idle-warm.ts) so the first toggle is a hit. Any change to the
  // deps (new items, a turn starting, a resize commit, Ctrl+O) cleans up and
  // reschedules; a resize in flight cancels it (onResize).
  const idleItems = st.items;
  const idleRunning = st.running || permission.pending !== null;
  const idleBusy = loading !== null || warmingRef.current;
  useEffect(() => {
    idleWarmCancelRef.current = startIdleWarm(
      {
        items: idleItems,
        opts: { expandAll, width: columns, spillInPod: shownInPod, expandedIds },
        running: idleRunning,
        busy: idleBusy,
      },
      { onError: (error) => warmErrorRef.current(error) },
    );
    return idleWarmCancelRef.current;
  }, [idleItems, idleRunning, idleBusy, expandAll, columns, shownInPod, expandedIds]);
  const total = layout.total;
  const win = windowFor(total, viewport, scrollOffset);
  const visible = sliceLaid(layout.laid, win.start, win.end);
  const scrolledUp = isScrolledUp(scrollOffset, total, viewport);
  const hiddenAbove = win.start;

  // Keep the read position anchored when new rows arrive while scrolled up —
  // or while a text selection is in progress, so the content the user is
  // selecting (e.g. during a running turn) does not scroll out from under them.
  useEffect(() => {
    const prev = prevRowsRef.current;
    if (prev !== total) {
      // The RULE is `anchorOffset`'s (S13). The guard reads THIS render's offset
      // and the updater's arithmetic reads the commit value, as before: the two
      // disagree inside one batched tick, and that window is the point (H3).
      const updater = anchorOffset({
        prevTotal: prev,
        total,
        rendered: scrollOffset,
        selecting: selectionRef.current !== null,
        viewport,
      });
      if (updater !== null) {
        setScrollOffset(updater);
      }
      prevRowsRef.current = total;
    }
  }, [total, viewport, scrollOffset]);

  const pushNotice = useCallback(
    (text: string) => {
      stateRef.current = pushNoticeItem(stateRef.current, text);
      setScrollOffset(0);
      flushNow();
    },
    [flushNow],
  );
  pushNoticeRef.current = pushNotice;

  // Rows changed: the dock keeps its selection BY ID, follows it when the row
  // leaves, and returns to the input when the list empties — `reconcile`'s
  // decision, pure (P5 (a): a finished item leaves at once), with the dock's own
  // memory and trigger now in `useDock` (S5).
  useEffect(() => {
    const ids = dockIdKey === "" ? [] : dockIdKey.split(" ");
    const previous = dockSeenRef.current;
    dockSeenRef.current = ids;
    // The outcome comes from the exit the transcript already got (`jobs.onExit`);
    // a departure nobody named still freezes the drawer, honestly.
    const ended = previous
      .filter((id) => !ids.includes(id))
      .map((id) => ({ id, outcome: dockOutcomeRef.current[id] ?? { kind: "stopped" as const } }));
    // Freeze on the rows as they were BEFORE this report dropped the departed
    // ones (`setAgents`/`setJobs` keep them, in the two `dockLast*RowsRef`s).
    setDock((prev) =>
      reconcile(prev, ids, ended, [
        ...dockLastRowsRef.current,
        ...dockLastJobRowsRef.current.map((row) => ({ kind: "job" as const, row })),
      ]),
    );
  }, [dockIdKey, setDock, dockLastJobRowsRef, dockLastRowsRef, dockOutcomeRef, dockSeenRef]);

  // A job's drawer READS its output: at once on open, then at most once a second
  // (`refreshMs`, `JOB_REFRESH_MS` unless a test shortens it), and only while
  // that job's drawer is open — never for a child, the dropdown, or a job nobody
  // opened (docs/feat/shell-jobs-panel.md). The interval is created ONCE per open
  // job target, keyed by its WIRE id, so a re-render (or a fresh read) cannot
  // re-arm it: the deps name only the target id and the cadence — never the
  // output state (AGENTS §9, M4). The target, the cadence and the refs are
  // `useDock`'s (S5); the effect stays HERE in App's order (Fable H1).
  useEffect(() => {
    if (jobTargetId === null) {
      jobReadAtRef.current = null;
      return;
    }
    const session = sessionRef.current;
    // Bound to the session (`connect` hands the TUI a CLASS instance, whose
    // `jobOutput` reads `this`): a method taken off the object would throw.
    const read = session?.jobOutput === undefined ? undefined : session.jobOutput.bind(session);
    if (read === undefined) {
      // An older daemon: one notice, the drawer stays open and its frame intact.
      pushNotice("_this session cannot show a job's output (older daemon)_");
      return;
    }
    let cancelled = false;
    let last = jobReadAtRef.current;
    if (last?.id !== jobTargetId) {
      last = null;
    }
    const issue = (): void => {
      jobReadAtRef.current = { id: jobTargetId, at: Date.now() };
      void read(jobTargetId, { lines: JOB_TAIL_SHOWN, maxChars: 8192 }).then(
        (result) => {
          // ONE rule for a read's cache entry (S13): the polling read and the
          // final on-exit read below are the same record, built once.
          const entry = jobOutputEntry(result);
          if (cancelled || entry === null) {
            return;
          }
          jobOutputRef.current = { ...jobOutputRef.current, [jobTargetId]: entry };
          setJobOutputGen((n) => n + 1);
        },
        () => {
          // A read that failed changes nothing: the next tick tells.
        },
      );
    };
    // The first read is immediate (`refreshDue` with no prior read: due at once).
    if (refreshDue("job", last?.at ?? null, Date.now(), refreshMs)) {
      issue();
    }
    const timer = setInterval(() => {
      const at = jobReadAtRef.current;
      const lastAt = at?.id === jobTargetId ? at.at : null;
      if (refreshDue("job", lastAt, Date.now(), refreshMs)) {
        issue();
      }
    }, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobTargetId, refreshMs, pushNotice, jobOutputRef, jobReadAtRef, setJobOutputGen]);

  /**
   * One LAST read when the open job's exit is seen: the registry keeps an exited
   * job, so the drawer's final lines land even though the timer is gone (the
   * focus is still `open`, the target unchanged — the effect above does not
   * re-run for an outcome, so this is the only thing that reads it).
   */
  useEffect(() => {
    if (jobTargetId === null || jobEndedWhileOpen === null) {
      return;
    }
    const session = sessionRef.current;
    const read = session?.jobOutput === undefined ? undefined : session.jobOutput.bind(session);
    if (read === undefined) {
      return;
    }
    let cancelled = false;
    void read(jobTargetId, { lines: JOB_TAIL_SHOWN, maxChars: 8192 }).then(
      (result) => {
        const entry = jobOutputEntry(result);
        if (cancelled || entry === null) {
          return;
        }
        jobOutputRef.current = { ...jobOutputRef.current, [jobTargetId]: entry };
        setJobOutputGen((n) => n + 1);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [jobTargetId, jobEndedWhileOpen, jobOutputRef, setJobOutputGen]);

  warmErrorRef.current = (error: unknown) => pushNotice(warmFailureNotice(error));

  /** Put texts a send-now did not deliver back in the input field (after any draft), and say why. */
  const restoreInput = useCallback(
    (text: string, why: string) => {
      if (text !== "") {
        field.update((draft) => withRestored(draft, text));
      }
      pushNotice(why);
    },
    [field.update, pushNotice],
  );
  draftBackRef.current = (text, cause) => restoreInput(text, orphanNotice(cause));

  // --- images in the input (docs/feat/attachments-tui.md D8) ----------------
  // The decisions are `attach-candidates.ts`/`attach-files.ts`/`attach-draft.ts`'s
  // and their executor is `useAttachments` (S6). The DRAFT STATE stays here: the
  // render reads it (the attach row, the input box's row count) and `submit` /
  // Backspace edit it — the same shape S4 gave `selection`. The refs other layers
  // read (`probedTextRef`, `uploadCtrlRef`, `attachGenRef`) stay here too, so
  // effect 1 below keeps its index and every use-site keeps its identifier.
  const { attachMode, restoreChips, routeAttach, attachCommand, convertToChips, sendWithImages } =
    useAttachments({
      field,
      attachRef,
      setAttach,
      attachGenRef,
      probedTextRef,
      uploadCtrlRef,
      sessionRef,
      runRef,
      pushNotice,
      restoreInput,
      fileProbe,
      home,
      localCwd,
    });
  routeAttachRef.current = routeAttach;

  /**
   * Watch `session` for my rows coming back (docs/feat/queued-broadcast.md):
   * they leave the list and go to the input field with the notice. Nothing is
   * sent: the user decides (Enter, or delete).
   */
  const watchReturned = useCallback(
    (session: SessionController | null) => {
      returnedSubRef.current?.();
      returnedSubRef.current =
        session?.onReturned?.((back) => {
          const step = handBackRows(
            rowsRef.current,
            back,
            stoppedHereRef.current,
            restoredRef.current,
          );
          setRows(() => step.rows);
          if (step.notice !== "") {
            restoreInput(step.text, step.notice);
          }
        }) ?? null;
    },
    [restoreInput, setRows],
  );
  useEffect(() => {
    watchReturned(sessionRef.current);
    return () => {
      returnedSubRef.current?.();
      returnedSubRef.current = null;
    };
  }, [watchReturned]);

  /**
   * A background job that exited mid-turn could not be seen by the turn that
   * was running (the agent flushes exits at turn start). Now idle, fire a
   * continuation so the agent reacts to it.
   */
  const wakeIfPending = useCallback(() => {
    if (!wakeRef.current.pending) {
      return;
    }
    setTimeout(() => {
      // A turn running by now keeps it pending: that turn's end asks again. The
      // same `tryWake` as the live path (S13) — one gate, one step.
      const attempt = tryWake(wakeRef.current, {
        enabled: autoWakeOnJobExit,
        running: stateRef.current.running,
        clearing: clearingRef.current,
      });
      wakeRef.current = attempt.model;
      if (attempt.wake) {
        runRef.current?.("", { continuation: true });
      }
    }, 0);
  }, [autoWakeOnJobExit]);
  wakeIfPendingRef.current = wakeIfPending;

  const onActivityRef = useRef<((activity: SessionActivity) => void) | null>(null);
  // A `/sessions` switch is in flight (its detach, then the target's open):
  // `switchingRefusal` / `sessionsChoose` refuse what would act on the old
  // session until it settles (Review R1). Cleared on every outcome.
  const switchingRef = useRef(false);

  // ── the panels (S7 — docs/feat/app-decomposition.md) ──────────────────────
  // The panel's state, its generation, and the open/close/delete executors live
  // in `usePanels`; the panel's OWN projections and key answers live per kind in
  // `panels/<kind>.ts`, reached through `panels/registry.ts` — a new panel is a
  // file plus one registry line, zero lines here. The STATE (`panel`) and
  // `panelRef` stay above, because the frame reads them and the ref is assigned
  // in render. The destructuring keeps every pre-S7 identifier (Fable M1), so no
  // use site below changes. The hook declares NO effect (Fable H1).
  const {
    panelGenRef,
    panelApply,
    setSessionsState,
    touchPanel,
    closePanel,
    openPanel,
    sessionsDelete,
  } = usePanels({
    panelRef,
    setPanel,
    sessions,
    switchingRef,
    columns,
    pushNotice,
  });

  // `run "<prompt>"`: the first message, sent once at mount, like a typed one: a
  // failed send leaves it in the conversation with the error under it (it is
  // not put back in the input).
  const sentFirstRef = useRef(false);
  useEffect(() => {
    if (initialPrompt === undefined || sentFirstRef.current) {
      return;
    }
    sentFirstRef.current = true;
    void runRef.current?.(initialPrompt);
  }, [initialPrompt]);

  // A wake handed over by the relay: now if idle, else at the adopted turn's end.
  useEffect(() => {
    wakeIfPending();
  }, [wakeIfPending]);

  /**
   * Ask the daemon for the session's context (never awaited by render). An
   * answer for a session the view has since left is dropped; a failure leaves
   * the figure as it was (`ctx –/max` until something measures).
   */
  const askContext = useCallback((session: SessionController | null): void => {
    void session?.context?.().then(
      (open) => {
        if (sessionRef.current === session) {
          setContextOpen(open);
        }
      },
      () => {},
    );
  }, []);

  // ── the turn driver (S9a — docs/feat/app-decomposition.md) ────────────────
  // The turn itself — `run`, the ONE `streamTurn` loop, its settle, the
  // send-now, Enter's `submit`, the history commit and `/compact` — lives in
  // `useTurnDriver.ts`. The hook owns only its own latches: every ref below is
  // ALSO read or written by a driver that stays here (the activity handler and
  // `swapSession`, the clear's arm, the key snapshot, the frame), so they are
  // PASSED IN and each use site keeps its identifier and its source (Fable
  // M1/H3). It declares no effect, so the 22 below keep their indices (H1) —
  // the original 20 plus session-hop's `targetFeed` and idle `hopIfQueued` — and
  // it is called before `onActivity`/`watchSession` because they START what it
  // streams (`streamTurn`) — `onActivityRef` is how the driver reaches back.
  const { run, commitHistory, streamTurn, sendNow, submit, startCompaction, drainHeld } =
    useTurnDriver({
      sessionRef,
      stateRef,
      rowsRef,
      setRows,
      setLoading,
      warmingRef,
      layoutOptsRef,
      abortRef,
      streamCtrlRef,
      foreignRef,
      sendNowRef,
      sendNowUnsupportedRef,
      fallbackNoticedRef,
      wakeRef,
      handedWakeRef,
      stoppedHereRef,
      restoredRef,
      heldRef,
      onActivityRef,
      exitPendingRef,
      clearingRef,
      clearAfterTurnRef,
      runClearRef,
      compactingRef,
      ownCompactionsRef,
      setCompacting,
      field,
      historyRef,
      histIndexRef,
      draftRef,
      lastUserRef,
      lastHadImagesRef,
      switchingRef,
      attachRef,
      probedTextRef,
      home,
      flushNow,
      setScrollOffset,
      scheduleFlush,
      pushNotice,
      restoreInput,
      handleCommandRef,
      permission,
      attachMode,
      convertToChips,
      sendWithImages,
      submitToTarget,
      restoreChips,
      model,
      skillsSync,
      askContext,
      wakeIfPending,
      exit,
      runRef,
      // The hop's view of this TUI's turns (D9/H5): absent where no `hop` prop is,
      // i.e. exactly the origins where the model is not offered the tool (D8).
      ...(hop ? { hopTurn: hopTurnPort } : {}),
    });
  // The forward reference the jobs subscription, the initial prompt and the
  // wake read (they are declared and run outside the driver).
  runRef.current = run;

  // ── the session link (S9b — docs/feat/app-decomposition.md) ────────────────
  // How this TUI follows a session — the activity feed it streams, the
  // subscriptions a follow installs, the ONE way the view moves to another
  // session, a `/sessions` switch — lives in `useSessionLink.ts`. The hook owns
  // no state and no effect: every ref below is shared with a driver this slice
  // does not own (the turn driver's, the clear's, the key snapshot's, the
  // frame's), so they are PASSED IN and each use site keeps its identifier and
  // its source (Fable M1/H3). It declares no effect, so the 22 below keep their
  // indices (H1: the original 20 plus session-hop's two); it is called AFTER
  // `useTurnDriver` because `onActivity` starts what that driver streams
  // (`streamTurn`), and BEFORE the mount effect below,
  // which calls `watchSession`. `armWake`/`wakeIfPending`/`askContext`/
  // `watchReturned` stay here: each is read by an effect (or a port) declared
  // before this point, so moving one would move an effect's index (drift 1).
  const { onActivity, watchSession, swapSession, switchTo } = useSessionLink({
    sessionRef,
    stateRef,
    rowsRef,
    setRows,
    setScrollOffset,
    setExpandAll,
    setExpandedIds,
    activitySubRef,
    queueSubRef,
    agentsSubRef,
    jobsSubRef,
    notifySubRef,
    dockMsgSubRef,
    heldRef,
    abortRef,
    streamCtrlRef,
    sendNowRef,
    warmingRef,
    stoppedHereRef,
    clearingRef,
    ownCompactionsRef,
    ownClearsRef,
    clearAfterTurnRef,
    sendNowUnsupportedRef,
    fallbackNoticedRef,
    wakeRef,
    handedWakeRef,
    switchingRef,
    onActivityRef,
    watchReturned,
    flushNow,
    pushNotice,
    restoreInput,
    setCompacting,
    skillsSync,
    setContextOpen,
    setDaemonQueue,
    askContext,
    streamTurn,
    commitHistory,
    drainHeld,
    setAgents,
    setJobs,
    setDock,
    jobOutputRef,
    touchPanel,
    setQuitConfirm,
    runQuit,
    sessions,
    makeSession,
    wakeIfPending,
    armWake,
    subagentsTwoWay,
    exit,
  });
  onActivityRef.current = onActivity;

  useEffect(() => {
    watchSession(sessionRef.current);
    watchedRef.current = true;
    return () => {
      activitySubRef.current?.();
      activitySubRef.current = null;
      queueSubRef.current?.();
      queueSubRef.current = null;
      agentsSubRef.current?.();
      agentsSubRef.current = null;
      jobsSubRef.current?.();
      jobsSubRef.current = null;
      notifySubRef.current?.();
      notifySubRef.current = null;
    };
  }, [watchSession]);

  // --- quit and clear (S8) --------------------------------------------------
  // The three executors live in `useQuitClear.ts`. The hook owns no state and no
  // effect: every ref below is shared with a driver this slice does not own (the
  // turn's settle, the `watch` activity effect, `swapSession`, the key
  // snapshot), so they are PASSED IN — each use site keeps its identifier and its
  // source (Fable M1/H3). `runClearRef` is assigned right below, because the
  // turn's settle calls the clear this hook returns.
  const { requestQuit, runClear, requestClear } = useQuitClear({
    sessionRef,
    stateRef,
    abortRef,
    foreignRef,
    exitPendingRef,
    clearingRef,
    ownClearsRef,
    clearAfterTurnRef,
    stoppedHereRef,
    compactingRef,
    runClearRef,
    subagentsRef,
    jobRowsRef,
    setQuitConfirm,
    runQuit,
    detachOnQuit,
    makeSession,
    swapSession,
    pushNotice,
    wakeIfPending,
    exit,
  });
  runClearRef.current = runClear;

  // ── the hop (S11 — docs/feat/app-decomposition.md) ────────────────────────
  // `/move`'s three drivers — `startHop` (the ONE place the view moves), the
  // typed `/move` (`requestHop`) and the queued hop's start (`hopIfQueued`) —
  // live in `useHop.ts`, with the state they own (`hopRun`, `hopQueued`) and
  // their refs. Every decision they execute is still a pure module's
  // (`parseHopCommand`/`hopStep`/`hopReady`, `hopStatusRow`/`hopMovedNotice`/
  // `hopFailureText`). It declares no effect, so the 22 below keep their indices
  // (H1: the original 20 plus session-hop's `targetFeed` and idle `hopIfQueued`);
  // the idle effect itself stays HERE, because its deps are this render's values
  // (`hopQueued`, `st.running`, `shown.length`) — that is the whole mechanism
  // (D4), and moving it into the hook would make its trigger a callback's
  // identity instead of the render that made the session idle.
  const { hopRun, hopQueued, hopIfQueuedRef, requestHop } = useHop({
    sessionRef,
    stateRef,
    rowsRef,
    daemonQueueRef,
    switchingRef,
    startHopRef,
    hop,
    permission,
    swapSession,
    pushNotice,
    flushNow,
  });
  // A `/move` that waited for a boundary (D4) starts at the first TRUE idle: the
  // own turn over, the daemon's queue empty. This ONE effect is the whole
  // mechanism — every fact D4 names is a dependency, so the render that makes
  // the session idle is the render that starts the hop (no second path to
  // disagree with it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the BODY reads refs; these deps ARE the trigger
  useEffect(() => {
    hopIfQueuedRef.current?.();
  }, [hopQueued, st.running, shown.length]);

  // The hop's own status row (`null`: no hop runs — the normal bar paints).
  const hopRow = hopRun === null ? null : hopStatusRow(hopRun.target, hopRun.phase, columns);

  /**
   * The ONE way typed `/…` text becomes an effect: `dispatchCommand`
   * (commands/dispatch.ts) holds the shared guards and looks the command up in
   * the registry, and `commands/<name>.ts` holds each command's body
   * (docs/feat/app-decomposition.md S2). App only builds the context — the
   * ports below, one per capability, read through refs where the old code read
   * a ref, so two keys with no render between them behave as before (plan H3).
   */
  const handleCommand = useCallback(
    (raw: string, again = false): void => {
      dispatchCommand(
        {
          pushNotice,
          restoreInput,
          historyRef,
          histIndexRef,
          draftRef,
          sessionRef,
          stateRef,
          busyCompacting: () => compactingRef.current,
          syncingRef,
          switchingRef,
          lastUserRef,
          lastHadImagesRef,
          skills,
          skillsSync,
          run,
          requestQuit,
          startCompaction,
          requestClear,
          requestHop,
          reResolve: (line: string) => handleCommandRef.current?.(line, true),
          exit,
          sessions,
          openPanel,
          mcpStatus,
          toggleAgents,
          attachCommand,
          clipboard,
          saveFile,
          cwd,
          shownModel,
          flushNow,
          setScrollOffset,
          askContext,
        },
        raw,
        again,
      );
    },
    [
      askContext,
      attachCommand,
      clipboard,
      cwd,
      exit,
      flushNow,
      mcpStatus,
      openPanel,
      pushNotice,
      requestClear,
      requestHop,
      requestQuit,
      restoreInput,
      run,
      saveFile,
      sessions,
      shownModel,
      skills,
      skillsSync,
      startCompaction,
      toggleAgents,
    ],
  );
  handleCommandRef.current = handleCommand;

  // All line editing lives in `useLineEditor` (pure `editor.ts` ops), so no
  // control key — Ctrl+O, mouse reports, escapes — can ever be echoed into the
  // buffer, independent of input-handler ordering.

  // --- mouse text selection → clipboard ------------------------------------
  // The selection itself stays here: the JSX paints it and the scroll-anchor
  // effect above reads `selectionRef` (docs/feat/app-decomposition.md S4,
  // Fable M1/H1 — no use-site edit, no effect reorder). The mouse layer
  // (`useMouse`) drives it through this setter.
  const setSelection = useCallback((next: Selection | null) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);

  // --- the mouse layer (S4) -------------------------------------------------
  // The chunk state machine and the per-report dispatch are `mouse-stream.ts`'s
  // (pure); this hook owns their state and executes the effects. The RENDER
  // SNAPSHOT each event reads is built at the call site in `useInput` below, so
  // a coalesced chunk's reports all see the frame they landed on (Fable M2).
  const mouse = useMouse({
    panelRef,
    dockRef,
    selectionRef,
    setSelection,
    field,
    clipboard,
    pushNotice,
    setScrollOffset,
    setPanel,
    setDock,
    setExpandedIds,
    dockIds,
    clickDock,
    panelClick,
    clampOffset,
    submit,
  });
  // The hold's unmount cleanup keeps its place in App's ordered effect list
  // (Fable H1); the hook itself declares no effect.
  const clearMouseHold = mouse.clearHold;
  useEffect(() => {
    return () => clearMouseHold();
  }, [clearMouseHold]);

  // --- bracketed-paste freeze recovery -------------------------------------
  const clearPasteTimeout = useCallback(() => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = null;
    }
  }, []);
  const armPasteTimeout = useCallback(() => {
    clearPasteTimeout();
    pasteTimerRef.current = setTimeout(() => {
      pasteTimerRef.current = null;
      const buf = pasteBufRef.current;
      pasteBufRef.current = null;
      if (buf) {
        const clean = sanitizePasted(buf);
        // WHERE it lands is `pasteTarget`'s rule (S13): an open reply field takes
        // it, never the hidden main field; a panel swallows it; else an attachment.
        const target = pasteTarget({
          clean,
          replyOpen: readReplyMode().mode === "reply",
          panelOpen: panelRef.current !== null,
        });
        if (target === "reply") {
          insertIntoReply(clean);
        } else if (target === "attach") {
          routeAttachRef.current(clean);
        }
      }
    }, PASTE_TIMEOUT_MS);
  }, [clearPasteTimeout, insertIntoReply, readReplyMode]);
  useEffect(() => {
    return () => clearPasteTimeout();
  }, [clearPasteTimeout]);

  // --- the key router's executor port (S3) ---------------------------------
  // The ONE place a routing decision becomes a call into the App. Every field is
  // an existing stable callback (the App's own `useCallback`s) or a decision
  // another pure module still owns — so this object needs no `useMemo`, and its
  // fields' identities are exactly the ones the App already has (Fable H2).
  const keyHost: KeyHost = {
    toggleAutoApprove: permission.toggleAutoApprove,
    setQuitConfirm,
    requestQuit,
    closeForAll: () => runQuit?.closeForAll(),
    setChord: (next) => {
      chordRef.current = next;
    },
    sendNow: () => {
      sendNow();
    },
    setPasteBuffer: (next) => {
      pasteBufRef.current = next;
    },
    armPasteTimeout,
    clearPasteTimeout,
    insertReply: (text) => insertIntoReply(text),
    setReplyMode: permission.setMode,
    permissionSelect: permission.setSelected,
    permissionAnswer: permission.answer,
    permissionStop: () => {
      // "Stop everything", not "I refuse this command": no deny goes out (over RPC
      // it would race the cancel and show a false "denied" on every device); the
      // turn's cancel settles the request. With no turn shown here to cancel the
      // dialog stays — dismissing it would orphan the request (suspended, unseen)
      // until the TUI quits. A reply draft goes back to the input.
      if (abortRef.current) {
        permission.answer(DISMISSED);
        stoppedHereRef.current = true;
        abortRef.current.abort();
      }
    },
    pasteReply: () => {
      // Ctrl+V in the reply field: read the clipboard and insert it there.
      void paste().then(
        (text) => {
          const clean = sanitizePasted(text);
          if (clean) {
            insertIntoReply(clean);
          }
        },
        () => pushNotice("_Clipboard unavailable._"),
      );
    },
    exit,
    stopTurn: () => {
      stoppedHereRef.current = true;
      abortRef.current?.abort();
    },
    routeAttach: (text) => routeAttachRef.current(text),
    fieldSet: (text) => field.set(text),
    fieldReset: () => field.reset(),
    cancelUpload: () => {
      const ctrl = uploadCtrlRef.current;
      uploadCtrlRef.current = null;
      setAttach((draft) => uploadDone(draft)); // the row goes now, not at the catch
      ctrl?.abort();
    },
    closePanel,
    panelApply,
    setSessionsState,
    switchTo,
    sessionsDelete,
    killJob,
    killChild,
    setDock,
    toggleAgents,
    toggleExpandAll: () => setExpandAll((v) => !v),
    moveCommandSel: (step) => setCommandIndex((i) => paletteStep(i, paletteCommands.length, step)),
    runCommand: (name) => handleCommand(name),
    pushNotice,
    // --- the line-editing tail (S12): each one call, decided by `line-layer.ts`.
    fieldInsert: (text) => field.insert(text),
    fieldDeleteBack: () => field.deleteBack(),
    fieldDeleteWord: (dir) => field.deleteWord(dir),
    fieldMoveCursor: (delta, extend) => field.moveCursor(delta, extend),
    fieldMoveWord: (dir, extend) => field.moveWord(dir, extend),
    fieldMoveLine: (edge, extend) => field.moveLine(edge, extend),
    fieldMoveVertical: (dir, extend) => field.moveVertical(dir, extend),
    setHistoryCursor: (index, draft) => {
      histIndexRef.current = index;
      draftRef.current = draft;
    },
    dockDown: () => setDock((prev) => downToDock(prev, dockIds())),
    scroll: (dir) => setScrollOffset((o) => applyScroll(o, dir, total, viewport)),
    pasteClipboard: () => {
      // Ctrl+V: read the OS clipboard and insert at the cursor. (The terminal's
      // own paste — Cmd+V on macOS — never reaches us as a key; it arrives as a
      // text chunk, routed to an "insert" action instead.)
      void paste().then(
        (text) => {
          const clean = flattenPasted(text);
          // `pasteTarget`'s rule again (S13), with no reply to consider: this
          // path is the MAIN input's Ctrl+V — the dialog layer already turned a
          // reply-field Ctrl+V into `pasteReply`, so only the panel can veto it.
          if (
            pasteTarget({ clean, replyOpen: false, panelOpen: panelRef.current !== null }) ===
            "attach"
          ) {
            routeAttachRef.current(clean);
          }
        },
        () => pushNotice("_Clipboard unavailable._"),
      );
    },
    submit: (text) => submit(text),
    removeLastChip: () => setAttach((draft) => removeLastChip(draft)),
  };

  useInput((char, key) => {
    // ── the key router (S3 — docs/feat/app-decomposition.md) ────────────────
    // ONE `useInput` for the whole App: Ink calls EVERY active listener for one
    // chunk (`ink/build/hooks/use-input.js:89` — `handleData` returns nothing
    // anyone consumes, so there is no stop-propagation), which is why precedence
    // can only be ONE ordered decision inside one handler. `routeKey` walks the
    // 13 pure layers of `keys/layers.ts` in precedence order, collecting every
    // passing layer's effects and stopping at the first `consumed`;
    // `executeEffects` then applies them through the narrow port below. The
    // SNAPSHOT is built here, at the event, so a chunk's decision reads the frame
    // it landed on — and every field keeps the source it had inline (live refs
    // are getters, render values are values: the table in `keys/snapshot.ts`).
    const routed = routeKey(
      {
        char,
        key,
        quitConfirm: () => quitConfirmRef.current,
        dock: () => dockRef.current,
        chord: () => chordRef.current,
        running: () => stateRef.current.running,
        compacting: () => compactingRef.current,
        pasteBuffer: () => pasteBufRef.current,
        replyMaxChars: replyMax,
        dockIds,
        othersOnSession: () => runQuit?.othersOnSession() ?? 0,
        sessionId: () => sessionRef.current?.sessionId ?? null,
        switching: () => switchingRef.current,
        panelGen: () => panelGenRef.current,
        abortable: () => abortRef.current !== null,
        uploadInFlight: () => uploadCtrlRef.current !== null,
        exitPending: () => exitPendingRef.current,
        subagents: () => subagentsRef.current ?? [],
        jobRows: () => jobRowsRef.current ?? [],
        panel,
        paletteOpen,
        paletteNames: paletteCommands.map((c: { readonly name: string }) => c.name),
        commandSel,
        fieldValue: field.value,
        permission: {
          pending: permission.pending,
          choices: permission.choices,
          selected: permission.selected,
          mode: () => permission.readMode(),
          shownAt: () => permission.shownAt(),
        },
        sessions,
        detachOnQuit,
      },
      PURE_LAYERS,
    );
    executeEffects(routed.effects, keyHost);
    if (routed.verdict === "consumed") {
      return;
    }
    // The MOUSE layer (14th, S4): the ONE layer that is not pure data. Its chunk
    // state machine and per-report dispatch ARE pure (`mouse-stream.ts`); the
    // hook holds their state and applies its effects as it decides. It therefore
    // runs here — after the key path's effects, exactly where the inline handler
    // had its mouse block — and only when nothing above consumed the chunk.
    const mouseStep = mouse.handleChunk(char, key, {
      listView,
      panelOpen: panel !== null,
      columns,
      panelBodyTop,
      dockTop,
      dockView,
      statusRow: statusRowRef.current,
      laid: layout.laid,
      win,
      total,
      viewport,
      visibleCount: visible.length,
      expandAll,
    });
    if (mouseStep === "consumed") {
      return;
    }

    // The LINE-EDITING tail (S12): the terminal consumer, reached only when the
    // 13 pure layers and the mouse layer all passed. Its decisions (history
    // recall and its no-op guard, DOWN's walk into the dock, Backspace's chip
    // rule) are `keys/line-layer.ts`'s, pure; here we only read the sources the
    // inline tail read, at the same moment, and execute them through the port.
    executeEffects(
      resolveLineEffects({
        char,
        key,
        value: field.value,
        cursor: field.cursor,
        history: {
          items: historyRef.current,
          index: histIndexRef.current,
          draft: draftRef.current,
        },
        paletteOpen,
        dockVisible: dockVisible(),
        dockFocus: dockRef.current.focus,
        chipCount: attachRef.current.chips.length,
      }),
      keyHost,
    );
  });

  // --- the frame (S10) ------------------------------------------------------
  // The tree itself left `App.tsx` for `AppView.tsx` — a verbatim move (the
  // plan's M3: "no prop re-plumbing"), so `git diff --color-moved` shows an
  // unchanged tree. Everything it paints is the view-model computed above; the
  // App still owns the state, the effects and the one `useInput` behind it.
  // What Enter does while a child is open lives on the INPUT RULE
  // (`→ sa-1 · enter sends · esc back`), never in the status bar: the bar's
  // right slot is `auto-accept`'s, and a hint there replaced it (round 3 M1).
  return (
    <AppView
      model={{
        ...frame,
        st,
        field,
        permission,
        dock,
        drawerJob,
        linkView,
        shownModel,
        shownTarget,
        cwd: shownCwd,
        contextWindow,
        expandAll,
        selection,
        quitConfirm,
        hopRow,
        loading,
        compacting,
        win,
        visible,
        scrolledUp,
        hiddenAbove,
        onPillRange: (range: { readonly start: number; readonly end: number } | null) => {
          // The row the bar paints on: the frame's own rows, derived exactly as
          // the tree lays them out (the transcript viewport, the spacer, the
          // running rows, the dock, the input box), plus the bar's own one. The
          // arithmetic is `app-layout.ts`'s (`statusRowY`), so the row a click
          // is matched against and the rows the viewport reserved cannot drift
          // apart (S0b's pill-click pins are the behavioural half).
          statusRowRef.current = { y: frame.statusRowY, pill: range };
        },
      }}
    />
  );
}
