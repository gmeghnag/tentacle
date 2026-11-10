import { type Agent, Session } from "@tentacle/agent";
import {
  DISMISSED,
  type JobController,
  type PermissionBroker,
  type WakeModel,
  initialWake,
  wakeDue,
  wakeStep,
} from "@tentacle/core";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import {
  type BackgroundAgentRow,
  backgroundCount,
  backgroundNames,
  sameIds,
} from "./background-view.ts";
import {
  BLINK_HALF_MS,
  BLINK_IDLE,
  type BlinkClock,
  advanceBlink,
  blinkPhase,
  blinkState,
  syncBlink,
} from "./blink.ts";
import { idleChord, stepChord } from "./chord.ts";
import { copyToClipboard, readClipboard } from "./clipboard.ts";
import {
  type QuitConfirmFacts,
  ctrlCQuitStep,
  helpText,
  isSessionMutating,
  lastAssistantText,
  lastUserText,
  matchCommands,
  mcpStatusError,
  paletteWindow,
  parseRename,
  quitAction,
  quitCommandStep,
  quitConfirmKey,
  quitConfirmText,
  renameFailedNotice,
  renamedNotice,
  resolveSlash,
  retryPlan,
  skillsListError,
  transcriptToMarkdown,
} from "./commands.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { LineInput } from "./components/LineInput.tsx";
import { ListPanel } from "./components/ListPanel.tsx";
import { PermissionPrompt, permissionPromptRows } from "./components/PermissionPrompt.tsx";
import { QueuedMessages } from "./components/QueuedMessages.tsx";
import { QUIT_CONFIRM_ROWS, QuitConfirm } from "./components/QuitConfirm.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { Thinking } from "./components/Thinking.tsx";
import { pushHistory, recall } from "./history.ts";
import { useLineEditor, useLinkIndicator, usePaintScheduler } from "./hooks.ts";
import { startIdleWarm } from "./idle-warm.ts";
import { resolveLineInput } from "./input-actions.ts";
import { inputRowCount } from "./input-view.ts";
import { type LinkFeed, stoppedNotice } from "./link-status.ts";
import type { McpServerView } from "./mcp-panel.ts";
import { type MouseReport, isMousePrefix, splitMouseReports } from "./mouse.ts";
import {
  type OpenPanel,
  applyPanel,
  mcpPanel,
  panelClick,
  panelView,
  sessionsPanel,
  skillsPanel,
} from "./panel.ts";
import { sanitizePasted, stepPaste } from "./paste.ts";
import { insertReply, orphanNotice, replyView, stepPermissionKey } from "./permission-reply.ts";
import {
  type AutoAcceptFeed,
  type DraftBack,
  permissionAgentLine,
  permissionDetailLines,
  permissionShowsCwd,
  usePermissionBroker,
} from "./permission-ui.ts";

export type { AutoAcceptFeed };
import {
  CLEARED_ELSEWHERE_NOTICE,
  clearCommandStep,
  clearErrorNotice,
  clearNoopNotice,
} from "./clear-command.ts";
import {
  type DaemonQueue,
  type QueuedMessage,
  type QueuedRows,
  type ReturnedCause,
  addRow,
  handBackRows,
  handOff,
  markAcked,
  onReject,
  onSteer,
  onTurnEnd,
  rowTexts,
  shownRows,
  takeAll,
  takeForSendNow,
} from "./queued.ts";
import {
  type RenderOptions,
  layoutTranscript,
  sliceLaid,
  stripAnsi,
  warmRowsChunk,
} from "./render-lines.ts";
import { runChunked } from "./run-chunked.ts";
import { applyScroll, clampOffset, isScrolledUp, windowFor } from "./scroll.ts";
import { type Selection, extractSelection, isNonEmpty, rowSelectionRange } from "./selection.ts";
import {
  COMPACTING_NO_TURN,
  type CompactionResult,
  NOTHING_TO_SEND,
  SEND_NOW_HINT,
  SendNowErrorCode,
  afterCompactionUnsupported,
  afterOldTurn,
  compactionWaitNotice,
  errorCode,
  fallbackNotice,
  onCompactionSettled,
  onSuccessorError,
  planRefusal,
  planSendNow,
  planTurnStart,
  withRestored,
} from "./send-now.ts";
import {
  type SessionsView,
  deleteFailedNotice,
  openFailedNotice,
  refreshedSessions,
  sessionsAt,
  sessionsChoose,
  sessionsDelete,
  sessionsKey,
  sessionsListError,
  sessionsRefreshApplies,
  stayingNotice,
  switchRefusedNotice,
  switchingRefusal,
} from "./sessions-panel.ts";
import { SETTINGS_SYNCING, settingsCommand } from "./settings-command.ts";
import { type SessionSkillsView, SkillsSync } from "./skills-sync.ts";
import {
  type DisplayItem,
  type DisplayState,
  type SessionEvent,
  appendBackgroundExit,
  appendHistory,
  appendNotice,
  applySessionEvent,
  backgroundExitNotice,
  endWithoutOutcome,
  failTurn,
  initialState,
  pushNoticeItem,
  replaceWithNotices,
  resetHistory,
  startContinuation,
  startTurn,
  withdrawUserTurn,
} from "./state.ts";
import { modelBorder } from "./status-line.ts";
import { type ContextOpen, contextShown, statusTokens } from "./status-view.ts";
import { type SubagentNotifyView, subagentNotifyNotice } from "./subagent-notify.ts";
import type { TargetBadge } from "./target-view.ts";
import { dimProps, palette } from "./theme.ts";
import { CLICK_IDLE, type ClickState, nextClick, toggleExpanded } from "./tool-expand.ts";
import { toolCallAtViewport } from "./tool-hit.ts";
import { panelHeight, panelMaxBody, treeKey } from "./tree-panel.ts";
import {
  FOREIGN_COMPACTED_NOTICE,
  SLOT_LOST_NOTICE,
  type SessionActivity,
  closedNotice,
  commitWarmed,
  historyAction,
  loadingLabel,
  lostSlot,
  needsWarm,
  nextStep,
  warmFailureNotice,
} from "./turn-feed.ts";

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
    opts?: { readonly skill?: string },
  ): AsyncIterable<SessionEvent>;
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
  /** Subscribe to the daemon's queue (every writer's waiting rows); returns an unsubscribe. */
  onQueued?(listener: (state: DaemonQueue) => void): () => void;
  /**
   * Subscribe to this session's background sub-agents (the live list, bounded);
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
  readonly cwd: string;
  readonly contextWindow?: number;
  /** In a container/pod: the status bar's accent badge (laptop-side facts). Absent: local. */
  readonly target?: TargetBadge;
  /** Broker whose interactive requester this app installs for tool approvals. */
  readonly permissions?: PermissionBroker;
  /** Background-job registry; the TUI surfaces job exits live when present. */
  readonly jobs?: JobController;
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
}

// Rows reserved below the transcript viewport: a blank spacer, the input/thinking
// line, the status bar, plus one slack row so the frame never overflows the
// terminal (which, on the alternate screen, has no scrollback to absorb it).
const RESERVED_ROWS = 4;
const FRAME_MS = 33; // ~30fps streaming throttle
// If a bracketed paste's closing marker never arrives, recover this long after
// the last paste chunk: flush what we captured and leave paste mode, so input
// is never frozen. Real pastes stream their chunks within one pty read window,
// far faster than this, so a legitimate paste never trips it.
const PASTE_TIMEOUT_MS = 250;
// Max content lines the input box shows before it windows around the cursor.
const MAX_INPUT_ROWS = 10;

const WELCOME = "Tentacle ready. Type a task, or `/help` for commands.";

// Lines scrolled per mouse-wheel notch.
const WHEEL_LINES = 3;
// Clipboard reads are trimmed: copied terminal output often has a trailing
// newline that would otherwise land as a stray blank line.
const flattenPasted = (text: string): string => sanitizePasted(text).trim();

const INPUT_PLACEHOLDER = "Type a task or /command";

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
  /** My own prompt: its bubble and text, withdrawn / restored if it loses the slot. */
  readonly own?: { readonly item: DisplayItem | undefined; readonly text: string };
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
  saveFile = (path, content) => Bun.write(path, content).then(() => undefined),
  initialItems,
  initialPrompt,
  daemonInPod = false,
  detachOnQuit = false,
  sessions,
  runQuit,
  autoAccept,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [size, setSize] = useState(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));
  const [scrollOffset, setScrollOffset] = useState(0);
  const [expandAll, setExpandAll] = useState(false);
  // The tool calls whose full command is shown wrapped under the header (a left
  // click on ONE call; docs/feat/tui-tool-expand.md). Keyed by the call's stable
  // daemon id, so it survives re-renders and new messages; sorted, so it is a
  // cheap layout cache key. The click recogniser's state rides beside it.
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([]);
  const clickRef = useRef<ClickState>(CLICK_IDLE);
  // The ONE blink clock of running tool calls (docs/feat/tui-tool-blink.md).
  // `blink.ts` owns the whole rule — when the clock runs, when it restarts ON,
  // what a tick renders; the App only relays a timer into `advanceBlink` and
  // passes the resulting phase to the layout (AGENTS §7).
  const [blinkClock, setBlinkClock] = useState<BlinkClock>(BLINK_IDLE);
  const field = useLineEditor();
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
  const permission = usePermissionBroker(
    permissions,
    () => {
      const session = sessionRef.current;
      return session?.ownsTurn
        ? (turnId: string) => session.ownsTurn?.(turnId) === true
        : undefined;
    },
    autoAccept,
    (text, cause) => draftBackRef.current?.(text, cause),
  );
  // The open list panel (`/mcp`, `/skills`; docs/feat/skills-panel.md) or null.
  // Each open and close bumps the generation, so a request answering after its
  // panel closed (or another opened) is dropped instead of landing on screen.
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const panelGenRef = useRef(0);
  // The panel as of the last render, for text inserted outside the key path
  // (a paste, a timer-flushed paste or held "["): behind a panel the hidden
  // input takes none of it.
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  // Partial SGR mouse report held across data chunks (see the mouse handling
  // in useInput): some terminals/ptys split a report in half.
  const pendingMouseRef = useRef("");
  const pendingMouseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Carry-over buffer while a bracketed paste spans multiple input chunks.
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
  /** The current session's `onSubagentNotify` subscription (replaced with it). */
  const notifySubRef = useRef<(() => void) | null>(null);
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
  // A long history is being warmed before it is committed (C8): activities wait.
  const warmingRef = useRef(false);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  // The daemon's queue (every writer's waiting rows), as last reported (C7).
  const [daemonQueue, setDaemonQueue] = useState<DaemonQueue | undefined>(undefined);
  // The session's background sub-agents, as last reported (undefined: not reported).
  const [subagents, setSubagents] = useState<readonly BackgroundAgentRow[] | undefined>(undefined);
  // The same list for the callbacks that must not re-create themselves on every
  // frame (`requestQuit`, the key handler): a ref, updated where it is set.
  const subagentsRef = useRef<readonly BackgroundAgentRow[] | undefined>(undefined);
  const setAgents = useCallback((rows: readonly BackgroundAgentRow[] | undefined) => {
    // The ref always tracks the daemon's report (the key handler and
    // `requestQuit` read it); the STATE only changes when the count or the ids
    // do — the frame carries up to 4 full states a second, and re-rendering the
    // whole App for an unchanged list is pure waste (LOW-4).
    const previous = subagentsRef.current;
    subagentsRef.current = rows;
    if (!sameIds(previous, rows)) {
      setSubagents(rows);
    }
  }, []);
  const layoutOptsRef = useRef<RenderOptions>({
    expandAll: false,
    width: 80,
    spillInPod: daemonInPod,
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
    ((text: string, opts?: { continuation?: boolean; fallback?: boolean }) => void) | null
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
    const gate = {
      enabled: autoWakeOnJobExit,
      idle: !stateRef.current.running,
      // A `/clear` in flight: its history has not been applied yet, a turn
      // now would be wiped by it (review H2). `wakeIfPending` runs again then.
      blocked: clearingRef.current,
    };
    if (wakeDue(wakeRef.current, gate)) {
      wakeRef.current = wakeStep(wakeRef.current, { type: "turn_started" });
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
      stateRef.current = appendBackgroundExit(
        stateRef.current,
        backgroundExitNotice(job.id, job.command, job.status, job.exitCode, job.agent),
      );
      setScrollOffset(0);
      flushNow();
      // Autonomous wake: react to the exit without a user prompt.
      armWake();
    });
  }, [jobs, flushNow, armWake]);

  // --- host notices ----------------------------------------------------------
  useEffect(() => {
    if (!notices) {
      return;
    }
    return notices.onNotice((text, hint) => {
      // `host`: an attach's notice outlives the history that follows it (A6).
      stateRef.current = appendNotice(stateRef.current, text, {
        host: true,
        ...(hint ? { hint } : {}),
      });
      setScrollOffset(0);
      flushNow();
    });
  }, [notices, flushNow]);

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
      const opts = { expandAll, width: next.columns, spillInPod: daemonInPod, expandedIds };
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
  }, [stdout, size.columns, expandAll, daemonInPod, expandedIds]);

  // Reset the palette selection whenever the typed text changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on field.value
  useEffect(() => setCommandIndex(0), [field.value]);

  // --- derived layout (recomputed each render) -----------------------------
  const st = stateRef.current;
  const tokensShown = statusTokens(st);
  const ctxShown = contextShown(tokensShown.context, contextOpen);
  const columns = Math.max(20, size.columns);
  const termRows = Math.max(8, size.rows);
  // Slash-command autocomplete: open only while idle and typing a `/command`.
  const paletteCommands =
    !permission.pending && !st.running && !panel ? matchCommands(field.value, skills()) : [];
  const paletteOpen = paletteCommands.length > 0;
  const commandSel = paletteOpen
    ? Math.min(Math.max(0, commandIndex), paletteCommands.length - 1)
    : 0;
  // With many skills a bare "/" lists them all: show a window around the selection.
  const paletteWin = paletteWindow(paletteCommands.length, commandSel);
  const paletteRows = paletteCommands.slice(paletteWin.start, paletteWin.end);
  // The input box grows with a multi-line prompt (paste / `\`-continuation),
  // (and with a soft-wrapped long line), capped at MAX_INPUT_ROWS content rows;
  // +2 for its top/bottom borders.
  const inputContentLines = inputRowCount(field.value, field.cursor, columns, MAX_INPUT_ROWS);
  const inputBoxRows = inputContentLines + 2;
  const listView = panel
    ? panelView(panel, columns, panelMaxBody(termRows), sessionRef.current?.sessionId ?? null)
    : null;
  // Rows above the input/panel while a turn runs: the thinking line + the
  // queued-message lines (each one row: `wrap="truncate-end"`) + the send-now
  // hint row under them + one blank row between the hint and the thinking line.
  // The rows shown: the daemon's list (every writer's) + my rows not acked yet (C7).
  const shown = shownRows(queued, daemonQueue);
  const runningRows =
    (st.running || loading ? 1 : 0) +
    (st.running || compacting ? shown.length + (shown.length > 0 ? 1 : 0) : 0) +
    (st.running && shown.length > 0 ? 1 : 0);
  // Rows the bottom area occupies: the permission dialog; or the running rows,
  // then the list panel or the input box (plus any open palette rows, which
  // only open while idle).
  // The reply field's view while it is open (its rows feed the viewport maths).
  const replyMax = permission.pending?.reply?.maxChars ?? 0;
  const replyShown =
    permission.pending && permission.mode.mode === "reply"
      ? replyView(permission.mode, columns, replyMax)
      : undefined;
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
  const activeRows =
    quitConfirm !== null
      ? QUIT_CONFIRM_ROWS
      : permission.pending
        ? permissionPromptRows(
            permission.choices.length,
            permissionDetailLines(permission.pending).length,
            permissionShowsCwd(permission.pending),
            replyShown?.rows.length,
            permission.pendingAgent !== null,
          )
        : runningRows + (listView ? panelHeight(listView) : inputBoxRows + paletteRows.length);
  const viewport = Math.max(3, termRows - (RESERVED_ROWS - 1 + activeRows));
  // Terminal row (1-based) of the panel's first body row: the transcript
  // viewport, the bottom area's marginTop row, the running rows, the title rule.
  const panelBodyTop = viewport + 1 + runningRows + 2;
  // Positional layout only (O(items) cache lookups, no full array): take the
  // row `total` for scroll maths and materialise just the visible window. The
  // whole transcript is assembled on demand (sliceLaid 0..total) only where a
  // full buffer is genuinely needed — a text selection on mouse-release.
  const blink = blinkState(st.items, st.running);
  const layout = layoutTranscript(st.items, {
    expandAll,
    width: columns,
    spillInPod: daemonInPod,
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
  layoutOptsRef.current = { expandAll, width: columns, spillInPod: daemonInPod, expandedIds };
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
        opts: { expandAll, width: columns, spillInPod: daemonInPod, expandedIds },
        running: idleRunning,
        busy: idleBusy,
      },
      { onError: (error) => warmErrorRef.current(error) },
    );
    return idleWarmCancelRef.current;
  }, [idleItems, idleRunning, idleBusy, expandAll, columns, daemonInPod, expandedIds]);
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
      const selecting = selectionRef.current !== null;
      if (total > prev && (scrollOffset > 0 || selecting)) {
        setScrollOffset((o) => clampOffset(o + (total - prev), total, viewport));
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
  warmErrorRef.current = (error: unknown) => pushNotice(warmFailureNotice(error));

  const closePanel = useCallback(() => {
    panelGenRef.current += 1;
    setPanel(null);
  }, []);

  /**
   * Open `initial` (its loading state) at once, then whatever `load` resolves
   * to — only if this panel is still the open one; a failure closes it and
   * says why.
   */
  const openPanel = useCallback(
    (initial: OpenPanel, load: () => Promise<OpenPanel>, describe: (e: unknown) => string) => {
      panelGenRef.current += 1;
      const gen = panelGenRef.current;
      setPanel(initial);
      void load().then(
        (loaded) => {
          if (panelGenRef.current === gen) {
            setPanel(loaded);
          }
        },
        (e) => {
          if (panelGenRef.current === gen) {
            closePanel();
            pushNotice(describe(e));
          }
        },
      );
    },
    [closePanel, pushNotice],
  );

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

  /** No turn streams any more: show the TUI idle (a send-now kept it running). */
  const showIdle = useCallback(() => {
    if (stateRef.current.running && !streamCtrlRef.current) {
      stateRef.current = applySessionEvent(
        stateRef.current,
        { type: "turn_end", reason: "cancelled" },
        Date.now(),
      );
    }
  }, []);

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
      // A turn running by now keeps it pending: that turn's end asks again.
      const gate = {
        enabled: autoWakeOnJobExit,
        idle: !stateRef.current.running,
        // A `/clear` in flight (review H2): its history is applied first, and
        // `wakeIfPending` is asked again from there (or from a refused clear).
        blocked: clearingRef.current,
      };
      if (wakeDue(wakeRef.current, gate)) {
        wakeRef.current = wakeStep(wakeRef.current, { type: "turn_started" });
        runRef.current?.("", { continuation: true });
      }
    }, 0);
  }, [autoWakeOnJobExit]);
  wakeIfPendingRef.current = wakeIfPending;

  // `streamTurn`, through a ref: it and `settleSendNow` call each other.
  const streamTurnRef = useRef<
    | ((
        open: () => AsyncIterable<SessionEvent>,
        controller: AbortController,
        opts: StreamOpts,
      ) => Promise<void>)
    | null
  >(null);
  // The session-activity handler, through a ref: `streamTurn`'s settle drains
  // the held ones, and the handler starts streams (C2).
  const onActivityRef = useRef<((activity: SessionActivity) => void) | null>(null);
  // `swapSession`, through a ref: the activity handler (closed elsewhere) is defined before it.
  const swapRef = useRef<
    | ((
        next: SessionController,
        opts?: { readonly keepTranscript?: boolean; readonly onOpened?: (ok: boolean) => void },
      ) => void)
    | null
  >(null);
  // A `/sessions` switch is in flight (its detach, then the target's open):
  // `switchingRefusal` / `sessionsChoose` refuse what would act on the old
  // session until it settles (Review R1). Cleared on every outcome.
  const switchingRef = useRef(false);

  /** Activities held while a run of mine streamed: handled in order once nothing is in flight. */
  const drainHeld = useCallback(() => {
    while (
      heldRef.current.length > 0 &&
      !streamCtrlRef.current &&
      !sendNowRef.current &&
      !warmingRef.current
    ) {
      const next = heldRef.current.shift();
      if (next) onActivityRef.current?.(next);
    }
  }, []);

  /**
   * Commit `compute(state)` — a history replacing the transcript — after
   * warming its rows in time-budgeted chunks when it is long (C8, the resize
   * pattern): input stays live, the running line says how far it is. Items
   * appended meanwhile (a notice) are kept after it.
   */
  const commitHistory = useCallback(
    async (compute: (state: DisplayState) => DisplayState): Promise<void> => {
      const before = stateRef.current.items;
      const next = compute(stateRef.current);
      if (needsWarm(next.items.length)) {
        warmingRef.current = true;
        const total = next.items.length;
        let shownAt = 0;
        setLoading({ done: 0, total });
        // `main` yielded once after the last chunk too, so the commit always landed
        // one macrotask later — a queued input/timer ran first. Keep that hop
        // (docs/feat/tui-run-chunked.md, Review F2). `done` only settles `true`
        // here: a throw leaves this function at the `await` (Review R3).
        await runChunked(
          total,
          (from, budgetMs) => warmRowsChunk(next.items, layoutOptsRef.current, from, budgetMs),
          {
            onProgress: (done) => {
              const now = Date.now();
              if (now - shownAt > 50) {
                shownAt = now;
                setLoading({ done, total });
              }
            },
          },
        ).done;
        await new Promise((r) => setTimeout(r, 0));
        setLoading(null);
        warmingRef.current = false;
      }
      stateRef.current = {
        ...next,
        items: commitWarmed(before, stateRef.current.items, next.items),
        running: stateRef.current.running,
      };
    },
    [],
  );

  /**
   * The old turn is over (or was found over): settle the send-now waiting on
   * it. `atomic`: its new turn starts, or, with the ack still on its way, the
   * TUI keeps showing a running turn (the rows stay up). `fallback` (an older
   * daemon: no facts to ask for): what is left of the rows is sent as a
   * prompt, or restored after a resync.
   * True when a turn goes on (do not end the TUI's turn).
   */
  const settleSendNow = useCallback(
    (p: PendingSendNow): boolean => {
      if (p.mode === "atomic") {
        stateRef.current = startContinuation(stateRef.current, Date.now());
        const events = p.successor;
        if (events && p.next) {
          sendNowRef.current = null;
          wakeRef.current = wakeStep(wakeRef.current, { type: "turn_started" }); // the new turn flushes the job exits at its start
          void streamTurnRef.current?.(() => events, p.next, { successor: true });
        }
        return true;
      }
      sendNowRef.current = null;
      const { text } = takeAll(rowsRef.current);
      setRows(() => []);
      const step = afterOldTurn({ text, resetSeen: p.resetSeen });
      if (step === "send") {
        wakeRef.current = wakeStep(wakeRef.current, { type: "turn_started" });
        runRef.current?.(text, { fallback: true });
        return true;
      }
      if (step === "restore") {
        restoreInput(
          text,
          "_send-now (older daemon): the transcript was resynced — your queued messages are back in the input; check them before sending_",
        );
      }
      return false;
    },
    [restoreInput, setRows],
  );

  /**
   * Stream one turn's events into the transcript — ONE loop for every turn of
   * the session: a prompt's (`run`, `own`), a send-now's new turn
   * (`successor`, its rows hand off on its first event), another device's
   * (`foreign`, docs/feat/tui-foreign-turns.md C1).
   */
  const streamTurn = useCallback(
    async (
      open: () => AsyncIterable<SessionEvent>,
      controller: AbortController,
      opts: StreamOpts,
    ) => {
      streamCtrlRef.current = controller;
      if (opts.foreign) {
        foreignRef.current = controller;
      }
      let handedOff = !opts.successor;
      // Anything but an `unsupported` notice streamed: the daemon ran this turn.
      let streamed = false;
      // The model renewed its context: its skill set changed with it.
      let reset = false;
      try {
        for await (const event of open()) {
          if (event.type !== "unsupported") {
            streamed = true;
            handedWakeRef.current = false; // a turn ran: any later refusal is an ordinary one
          }
          if (event.type === "context_reset") {
            reset = true;
          }
          if (!handedOff && event.type !== "unsupported") {
            handedOff = true;
            setRows(handOff); // the sent texts are its prompt now
          }
          if (event.type === "history_reset" && needsWarm(event.messages.length)) {
            await commitHistory((s) => applySessionEvent(s, event, Date.now()));
          } else {
            stateRef.current = applySessionEvent(stateRef.current, event, Date.now());
          }
          // A queued message was just injected — drop it from the pending list.
          if (event.type === "steer") {
            const { id } = event;
            setRows((rows) => onSteer(rows, id));
          }
          const pending = sendNowRef.current;
          if (event.type === "history_reset" && pending) {
            pending.resetSeen = true;
          }
          // The cleared history of a `/clear` in flight reached this turn as its
          // snapshot (the client hands a turn started after the barrier the
          // snapshot in-turn, review H2): nothing else will release the latch.
          if (event.type === "history_reset" && clearingRef.current) {
            clearingRef.current = false;
          }
          if (event.type === "text") {
            scheduleFlush();
          } else {
            flushNow();
          }
        }
        // A foreign stream that closed with no end: it ended behind a resync's
        // cut — idle, with no stop reason (never a guessed one).
        if (opts.foreign && stateRef.current.running) {
          stateRef.current = endWithoutOutcome(stateRef.current);
        }
      } catch (error) {
        const failed = opts.successor
          ? onSuccessorError(error, rowsRef.current)
          : ({ kind: "fail" } as const);
        if (opts.own && lostSlot(error, streamed)) {
          // Another device's turn took the slot first: my prompt never ran.
          // Its bubble goes and its text is back in the input — never lost
          // (decision 15); the held foreign turn renders once this settles.
          stateRef.current = withdrawUserTurn(stateRef.current, opts.own.item);
          if (opts.own.text !== "") {
            restoreInput(opts.own.text, SLOT_LOST_NOTICE);
          } else if (handedWakeRef.current) {
            // Once: `wakeIfPending` below fires it when the turn that won ends.
            handedWakeRef.current = false;
            wakeRef.current = wakeStep(wakeRef.current, { type: "refused" });
          }
        } else if (failed.kind === "restore") {
          for (const id of failed.ids) restoredRef.current.add(id);
          setRows(() => []);
          stateRef.current = applySessionEvent(
            stateRef.current,
            { type: "turn_end", reason: "cancelled" },
            Date.now(),
          );
          restoreInput(failed.text, failed.notice);
        } else {
          stateRef.current = failTurn(stateRef.current, String(error), Date.now());
        }
      } finally {
        if (reset) {
          void skillsSync.settle(); // the `model` marks flip (docs/feat/skills-hot-reload.md)
        }
        if (streamCtrlRef.current === controller) {
          streamCtrlRef.current = null;
        }
        if (foreignRef.current === controller) {
          foreignRef.current = null;
        }
        // Only this turn's: a send-now's new turn installed its own.
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        const pending = sendNowRef.current;
        // A `/clear` that stopped this turn: it runs once the turn has settled,
        // and only here (taken now, so no path leaves it armed).
        const clearNow = clearAfterTurnRef.current;
        clearAfterTurnRef.current = false;
        // A quit asked for mid-turn: the turn has settled (and was saved by the
        // session's own `finally`), so exit now — and wake nothing. A send-now's
        // new turn then runs daemon-side unobserved, as any turn after a quit.
        if (exitPendingRef.current) {
          sendNowRef.current = null;
          setRows(onTurnEnd);
          flushNow();
          exit();
        } else if (!(pending && settleSendNow(pending))) {
          setRows(onTurnEnd); // the turn is over; nothing stays queued
          flushNow();
          // A foreign turn (or history) held while this ran comes now (C2).
          drainHeld();
          if (clearNow) {
            runClearRef.current?.();
          }
          wakeIfPending();
        } else {
          flushNow();
          // A send-now took over and started a new turn: the `/clear` that
          // stopped this one is not run — said, never dropped silently (M3).
          if (clearNow) {
            pushNotice("_/clear not run: a send-now started a new turn — run /clear again_");
          }
        }
      }
    },
    [
      flushNow,
      scheduleFlush,
      exit,
      restoreInput,
      setRows,
      settleSendNow,
      pushNotice,
      wakeIfPending,
      commitHistory,
      drainHeld,
      skillsSync,
    ],
  );
  streamTurnRef.current = streamTurn;

  const run = useCallback(
    async (text: string, opts?: { continuation?: boolean; skill?: string; fallback?: boolean }) => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      // A continuation turn has no user input (an autonomous wake reacting to a
      // background-job exit): no user bubble, and an empty prompt to `send` so
      // the session runs over existing history without appending a user message.
      const continuation = opts?.continuation ?? false;
      // No turn of ours during our own `/compact` (docs/feat/send-now-d.md
      // follow-up 1): the daemon would refuse it, and its end would clear the
      // compaction-time rows. A wake waits for the compaction's end.
      const start = planTurnStart({ compacting: compactingRef.current, continuation });
      if (start === "defer") {
        wakeRef.current = wakeStep(wakeRef.current, { type: "refused" });
        return;
      }
      if (start === "refuse") {
        pushNotice(COMPACTING_NO_TURN);
        return;
      }
      if (!continuation) {
        lastUserRef.current = text;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      stoppedHereRef.current = false;
      stateRef.current = continuation
        ? startContinuation(stateRef.current, Date.now())
        : startTurn(stateRef.current, text, Date.now());
      setScrollOffset(0);
      flushNow();
      // The bubble `startTurn` appended (none for a continuation): withdrawn by
      // identity if the prompt loses the slot (C3).
      const item = continuation ? undefined : stateRef.current.items.at(-1);
      const sendOpts = opts?.skill !== undefined ? { skill: opts.skill } : undefined;
      await streamTurn(
        () => session.send(continuation ? "" : text, controller.signal, sendOpts),
        controller,
        { own: { item, text: continuation ? "" : text } },
      );
    },
    [flushNow, pushNotice, streamTurn],
  );
  runRef.current = run;

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
   * One activity of the session that this TUI did not start (C1/C2/C6): the
   * decision is `turn-feed.ts`'s; this executes it. A foreign turn streams
   * through the SAME loop as an own one; its controller's abort cancels it
   * (Esc / Ctrl+C stop what runs, whoever started it — owner Q2).
   */
  const onActivity = useCallback(
    (activity: SessionActivity): void => {
      const inFlight =
        streamCtrlRef.current !== null || sendNowRef.current !== null || warmingRef.current;
      const step = nextStep({ inFlight, activity });
      if (step === "hold") {
        heldRef.current.push(activity);
        return;
      }
      if (activity.kind === "closed" && runQuit) {
        // A run's session closed by another TUI's `/quit` (A2): this one
        // leaves; never a fresh session in a resident being removed.
        runQuit.closedElsewhere(activity.reason);
        setQuitConfirm(null);
        exit();
        return;
      }
      if (activity.kind === "closed") {
        // Ended on another device (live, or refused on reconnect): say so, and
        // hand the next prompt to a fresh session — the transcript stays as
        // scrollback (docs/feat/connect-sessions.md).
        pushNotice(closedNotice(activity.reason, sessions !== undefined));
        swapRef.current?.(makeSession(), { keepTranscript: true });
        return;
      }
      if (activity.kind === "history") {
        const own = ownCompactionsRef.current > 0;
        const action = historyAction({ reason: activity.reason, ownCompaction: own });
        if (activity.reason === "compact" && own) {
          ownCompactionsRef.current -= 1;
        }
        // A cleared chat is a new one: nothing of the old is expanded. The
        // wake state, the sub-agent list and queued rows are the SESSION's and
        // stay (the same session goes on).
        const cleared = activity.reason === "clear";
        const ownClear = cleared && ownClearsRef.current > 0;
        if (ownClear) {
          ownClearsRef.current -= 1;
        }
        if (cleared) {
          setExpandAll(false);
          setExpandedIds([]);
        }
        // The history a `/clear` waits for (or a snapshot, which also stands in
        // for one a dropped link lost): the latch lets go, so the stack cannot
        // be left "clearing" (review H2c). A snapshot also settles the count of
        // my clears whose history never came (L6a).
        if (clearingRef.current && (cleared || activity.reason === null)) {
          clearingRef.current = false;
        }
        if (activity.reason === null) {
          ownClearsRef.current = 0;
        }
        if (action === "notice") {
          pushNotice(FOREIGN_COMPACTED_NOTICE);
        } else if (action === "replace" || action === "append") {
          const apply = action === "append" ? appendHistory : resetHistory;
          void commitHistory((s) => apply(s, activity.messages)).then(() => {
            setScrollOffset(0);
            if (cleared && !ownClear) {
              // After the replace: it would wipe a notice pushed before it.
              pushNotice(CLEARED_ELSEWHERE_NOTICE);
            }
            flushNow();
            drainHeld();
            // A wake the latch held back: the cleared chat is on screen now.
            wakeIfPending();
          });
        }
        return;
      }
      const controller = new AbortController();
      controller.signal.addEventListener("abort", () => activity.cancel(), { once: true });
      abortRef.current = controller;
      stoppedHereRef.current = false;
      // No local bubble: its `user_message` (the daemon's prompt) draws it.
      stateRef.current = startContinuation(stateRef.current, Date.now());
      setScrollOffset(0);
      flushNow();
      void streamTurn(() => activity.events, controller, { foreign: true });
    },
    [
      commitHistory,
      drainHeld,
      exit,
      flushNow,
      makeSession,
      pushNotice,
      runQuit,
      sessions,
      setQuitConfirm,
      streamTurn,
      wakeIfPending,
    ],
  );
  onActivityRef.current = onActivity;

  /**
   * Follow `session` (C9): its activities and the daemon's queue — watch
   * FIRST, then the eager open (a fresh session's is a no-op), so its first
   * history is never missed. The previous session's subscriptions end, and
   * what was held for it is dropped.
   */
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
  const watchSession = useCallback(
    (session: SessionController | null, onOpened?: (ok: boolean) => void) => {
      activitySubRef.current?.();
      queueSubRef.current?.();
      agentsSubRef.current?.();
      notifySubRef.current?.();
      heldRef.current = [];
      setDaemonQueue(undefined);
      setAgents(undefined);
      // Its own skills (a remote session waits for its eager open first).
      skillsSync.use(session);
      // The context at open (never awaited by render): an answer for a session
      // the view has since left is dropped.
      setContextOpen(null);
      askContext(session);
      activitySubRef.current = session?.watch?.((a) => onActivityRef.current?.(a)) ?? null;
      queueSubRef.current = session?.onQueued?.((q) => setDaemonQueue(q)) ?? null;
      agentsSubRef.current = session?.onSubagents?.((rows) => setAgents(rows)) ?? null;
      // A RUNNING background child's message to the agent
      // (docs/feat/agent-message-two-way.md): the notice at once, and — when it
      // asks for one and this laptop allows two-way — the same wake an exit arms.
      notifySubRef.current =
        session?.onSubagentNotify?.((n) => {
          stateRef.current = appendNotice(stateRef.current, subagentNotifyNotice(n));
          setScrollOffset(0);
          flushNow();
          if (n.wake && subagentsTwoWay) {
            armWake();
          }
        }) ?? null;
      const opening = session?.open?.();
      if (!opening) {
        onOpened?.(true); // nothing to open (a local session)
        return;
      }
      opening.then(
        () => onOpened?.(true),
        (error: unknown) => {
          if (sessionRef.current === session) {
            pushNotice(openFailedNotice(error));
          }
          onOpened?.(false);
        },
      );
    },
    [pushNotice, skillsSync, askContext, setAgents, flushNow, armWake, subagentsTwoWay],
  );
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
      notifySubRef.current?.();
      notifySubRef.current = null;
    };
  }, [watchSession]);

  /**
   * The ONE way the view moves to another session (`/clear`, a `/sessions`
   * switch, a session closed elsewhere; docs/feat/connect-sessions.md): follow
   * `next` (returned rows, activities, then its eager open), drop the old
   * session's per-session latches, put rows queued during a compaction back in
   * the input. The transcript is reset unless `keepTranscript` (closed
   * elsewhere: it stays as scrollback). What happens to the OLD session (close,
   * detach, nothing) is the caller's.
   */
  const swapSession = useCallback(
    (
      next: SessionController,
      opts: { readonly keepTranscript?: boolean; readonly onOpened?: (ok: boolean) => void } = {},
    ): void => {
      sessionRef.current = next;
      // An open `/sessions` panel marks the live session as current (Review R2-1).
      // An open `/sessions` panel re-renders: its "current" row is read live (Review R3-1).
      setPanel((p) => (p?.kind === "sessions" ? { ...p } : p));
      watchReturned(next);
      watchSession(next, opts.onOpened);
      ownCompactionsRef.current = 0;
      clearingRef.current = false;
      ownClearsRef.current = 0;
      clearAfterTurnRef.current = false;
      // The send-now latches are per session: the new one asks (and says) afresh.
      sendNowUnsupportedRef.current = false;
      fallbackNoticedRef.current = false;
      // A wake deferred during the old session's compaction is that
      // session's: it must not fire in the new one.
      wakeRef.current = wakeStep(wakeRef.current, { type: "reset" });
      handedWakeRef.current = false;
      if (opts.keepTranscript !== true) {
        stateRef.current = initialState;
        setExpandAll(false);
        setExpandedIds([]);
      }
      setScrollOffset(0);
      // Rows queued during the old session's compaction never reach the
      // new one: back to the input field, visibly (never sent by itself).
      setCompacting(false);
      if (rowsRef.current.length > 0) {
        restoreInput(takeAll(rowsRef.current).text, "_your queued messages are back in the input_");
        setRows(() => []);
      }
      flushNow();
    },
    [flushNow, restoreInput, setCompacting, setRows, watchReturned, watchSession],
  );
  swapRef.current = swapSession;

  /** The fallback's notice, once per App (it does not repeat on later chords). */
  const noticeFallback = useCallback(
    (who: "daemon" | "session") => {
      if (!fallbackNoticedRef.current) {
        fallbackNoticedRef.current = true;
        pushNotice(fallbackNotice(who));
      }
    },
    [pushNotice],
  );

  /**
   * `Ctrl+X Ctrl+S`: send my queued rows now (docs/feat/send-now-c.md). The
   * decisions are `send-now.ts`'s; this executes them. False: nothing to do
   * (the key changes nothing, e.g. the permission dialog stays).
   */
  const sendNow = useCallback((): boolean => {
    const ctrl = sessionRef.current;
    const plan = planSendNow({
      hasQueued: rowsRef.current.some((r) => r.state === "queued"),
      running: stateRef.current.running && streamCtrlRef.current !== null,
      compacting: compactingRef.current,
      pending: sendNowRef.current !== null,
      canSendNow: ctrl?.sendNow !== undefined,
      latchedUnsupported: sendNowUnsupportedRef.current,
    });
    if (plan.kind === "none" || !ctrl) {
      return false;
    }
    if (plan.kind === "wait") {
      // No way to cancel the compaction: the rows stay, its end sends them.
      pushNotice(compactionWaitNotice(ctrl.sendNow ? "daemon" : "session"));
      return true;
    }
    const taken = takeForSendNow(rowsRef.current);
    setRows(() => taken.rows);
    for (const m of taken.messages) {
      ownedIdsRef.current.add(m.id);
    }
    if (plan.kind === "fallback" || !ctrl.sendNow) {
      // The fallback stops the turn itself, for sure: like Ctrl+C, dismissed
      // (not denied) — the turn's cancel settles the ask.
      if (permission.pending) {
        permission.answer(DISMISSED);
      }
      sendNowRef.current = { mode: "fallback", next: null, successor: null, resetSeen: false };
      noticeFallback(ctrl.sendNow ? "daemon" : "session");
      streamCtrlRef.current?.abort();
      return true;
    }
    // An open permission dialog stays: an accepted send-now aborts the turn
    // daemon-side, which withdraws the ask (the dialog closes, nothing is
    // sent); a refused one leaves the turn — and its ask — to the user.
    // The new turn's controller from now on: Esc in the window cancels it (the
    // daemon already cancels the old one; a second abort of it sends nothing).
    const next = new AbortController();
    const pending: PendingSendNow = { mode: "atomic", next, successor: null, resetSeen: false };
    sendNowRef.current = pending;
    abortRef.current = next;
    // A new turn of ours: whoever stops it from here on is not known yet.
    stoppedHereRef.current = false;
    const onCompaction = plan.target === "compaction";
    if (onCompaction) {
      // The rows are the send-now's now (the compaction's end sends nothing),
      // and the TUI shows its turn at once — the client installs it at once
      // (no live turn to wait for), so Enter enqueues to it from here on.
      compactionOwnedRef.current = true;
      stateRef.current = startContinuation(stateRef.current, Date.now());
      flushNow();
    }
    ctrl.sendNow(taken.messages, plan.target, next.signal).then(
      (events) => {
        if (sendNowRef.current !== pending) {
          return; // settled otherwise (a quit)
        }
        pending.successor = events;
        if (!streamCtrlRef.current) {
          settleSendNow(pending); // the old turn is already over
          flushNow();
        }
      },
      (error: unknown) => {
        if (sendNowRef.current !== pending) {
          return;
        }
        const old = streamCtrlRef.current;
        if (abortRef.current === next) {
          abortRef.current = old;
        }
        const step = planRefusal(error, rowsRef.current, old !== null);
        if (onCompaction) {
          compactionOwnedRef.current = false; // the rows are not the send-now's any more
        }
        if (step.kind === "fallback" && onCompaction) {
          // An older daemon: it cannot cancel the compaction, so the rows
          // wait for its end — or go now if it already ended meanwhile.
          sendNowRef.current = null;
          sendNowUnsupportedRef.current = true;
          const after = afterCompactionUnsupported(rowsRef.current, compactingRef.current);
          setRows(() => after.rows);
          showIdle();
          drainHeld();
          pushNotice(compactionWaitNotice("daemon"));
          if (after.send !== null) {
            wakeRef.current = wakeStep(wakeRef.current, { type: "turn_started" }); // its turn flushes the job exits at its start
            void runRef.current?.(after.send, { fallback: true });
          } else {
            wakeIfPending(); // while still compacting, `run` defers it again
          }
          flushNow();
          return;
        }
        if (step.kind !== "fallback") {
          sendNowRef.current = null;
          setRows(() => step.rows);
          if (!old) {
            showIdle();
            drainHeld();
            wakeIfPending();
          }
          if (step.kind === "restore") {
            restoreInput(step.text, step.notice);
          } else {
            pushNotice(NOTHING_TO_SEND);
          }
          return;
        }
        pending.mode = "fallback";
        sendNowUnsupportedRef.current = true;
        noticeFallback("daemon");
        if (old) {
          // As the latched fallback: it stops the turn itself, so an open
          // dialog (that turn's ask) is dismissed — not denied — at once; an
          // older daemon may never withdraw it. `answer` acts on whatever is
          // pending NOW (a no-op when nothing is), never on a stale render.
          permission.answer(DISMISSED);
          old.abort();
          return; // its end settles the send-now
        }
        if (!settleSendNow(pending)) {
          showIdle();
          drainHeld();
          wakeIfPending();
        }
        flushNow();
      },
    );
    return true;
  }, [
    drainHeld,
    flushNow,
    noticeFallback,
    permission.answer,
    permission.pending,
    pushNotice,
    restoreInput,
    setRows,
    settleSendNow,
    showIdle,
    wakeIfPending,
  ]);

  /**
   * `/quit` and `/exit`: the decision is `quitCommandStep`'s (A1); `confirmed`
   * is the `y` of its confirmation. Another device's turn is not mine to stop
   * on the way out (C4), but a run TUI's quit ends the session, so it stops
   * that one too. On `connect` (`detachOnQuit`) quitting only detaches.
   */
  const requestQuit = useCallback(
    (confirmed: boolean): void => {
      const agents = backgroundCount(subagentsRef.current);
      const step = quitCommandStep({
        running: stateRef.current.running,
        exitPending: exitPendingRef.current,
        foreign: foreignRef.current !== null,
        detaches: detachOnQuit,
        endsSession: runQuit !== undefined,
        others: confirmed ? 0 : (runQuit?.othersOnSession() ?? 0),
        agents: confirmed ? 0 : agents,
        confirmed,
      });
      if (step === "confirm") {
        setQuitConfirm({
          others: runQuit?.othersOnSession() ?? 0,
          agents,
          names: backgroundNames(subagentsRef.current),
        });
        return;
      }
      if (step === "exit") {
        exit();
        return;
      }
      exitPendingRef.current = true;
      pushNotice(
        "_Stopping the turn so it is saved before exiting — /exit or Ctrl+C again to quit now._",
      );
      abortRef.current?.abort();
    },
    [detachOnQuit, exit, pushNotice, runQuit, setQuitConfirm],
  );

  /**
   * Ask the daemon to reset the conversation (docs/feat/clear-keeps-jobs.md).
   * The transcript is replaced by the `history{clear}` activity, never here; a
   * refusal changes nothing and says so. Nothing escapes: both settle paths are
   * guarded (a throw in a void promise would be an unhandled rejection).
   */
  const runClear = useCallback((): void => {
    const session = sessionRef.current;
    if (!session?.clear) {
      return;
    }
    const { clear } = session;
    clearingRef.current = true;
    // The open a reset needs comes FIRST (review M1): it can ATTACH a session
    // another device keeps live, and that attach's snapshot is a
    // `history{reason: null}` — which releases the latch and zeroes the
    // own-clear count. Arming the count before it made my own `/clear` look like
    // another device's ("cleared on another device"). The latch still goes up
    // first: it also gates the wake a clear must delay.
    const send = (): void => {
      clearingRef.current = true;
      ownClearsRef.current += 1;
      let call: Promise<unknown>;
      try {
        call = clear();
      } catch (error) {
        call = Promise.reject(error);
      }
      void call.then(
        (result) => {
          try {
            if (sessionRef.current !== session) {
              return;
            }
            // The answer comes BEFORE the cleared history (the barrier makes the
            // client read a snapshot): the latch stays up until the `history`
            // activity applies it (review H2) — it wakes from there. Only a clear
            // that did nothing (no session open yet: `{0, 0}`, no history coming)
            // lets go here (review L6b) — and, with a chat on screen, says so
            // (docs/fix/clear-silent-noop.md: a silent no-op is a §7 drop).
            const r = result as { before?: number; after?: number } | undefined;
            if (r?.before === 0 && r.after === 0) {
              clearingRef.current = false;
              if (ownClearsRef.current > 0) {
                ownClearsRef.current -= 1;
              }
              const noop = clearNoopNotice({
                before: 0,
                after: 0,
                // A conversation on screen: any prompt or tool row. A fresh
                // session's welcome line is neither, so it stays quiet.
                chatShown: stateRef.current.items.some(
                  (i) => i.kind === "user" || i.kind === "tool",
                ),
              });
              if (noop !== null) {
                pushNotice(noop);
              }
              wakeIfPending();
            }
          } catch {
            // Nothing to do: the cleared chat arrives through the history activity.
          }
        },
        (error: unknown) => {
          try {
            if (sessionRef.current === session) {
              const message = error instanceof Error ? error.message : String(error);
              clearingRef.current = false;
              // A dropped link ("not retried") may have landed: its history (a
              // replay or a snapshot) is then still MINE — keep the count (L6a);
              // a snapshot (`reason: null`) zeroes it. Any other error replaced nothing.
              if (!/not retried/i.test(message) && ownClearsRef.current > 0) {
                ownClearsRef.current -= 1;
              }
              pushNotice(clearErrorNotice(message));
              // The gate held a wake back: nothing else would start it (review H2d).
              wakeIfPending();
            }
          } catch {
            // Nothing to do: the notice is a courtesy.
          }
        },
      );
    };
    // Settles only once the attach snapshot (if any) has been applied: the
    // bookkeeping above is armed after it, never before (review M1).
    void Promise.resolve(session.openForReset?.()).then(
      () => {
        if (sessionRef.current === session) {
          send();
        }
      },
      (error: unknown) => {
        try {
          if (sessionRef.current === session) {
            // Nothing was armed: the count was never raised here.
            clearingRef.current = false;
            pushNotice(clearErrorNotice(error instanceof Error ? error.message : String(error)));
            // The gate held a wake back: nothing else would start it (H2d).
            wakeIfPending();
          }
        } catch {
          // Nothing to do: the notice is a courtesy.
        }
      },
    );
  }, [pushNotice, wakeIfPending]);
  runClearRef.current = runClear;

  const handleCommand = useCallback(
    (raw: string, again = false): void => {
      const resolved = resolveSlash(raw, skills());
      if (resolved.kind === "skill") {
        // A skill activation is a prompt (it starts a turn): recallable with
        // ↑, and refused mid-turn — it is a round, not a steering message.
        historyRef.current = pushHistory(historyRef.current, resolved.text);
        histIndexRef.current = historyRef.current.length;
        draftRef.current = "";
        if (stateRef.current.running) {
          pushNotice(
            `_Can't run /${resolved.name} while a turn is running — stop it first (esc)._`,
          );
          return;
        }
        const refusedSkill = switchingRefusal(switchingRef.current, { kind: "prompt" });
        if (refusedSkill) {
          restoreInput(raw, refusedSkill);
          return;
        }
        void run(resolved.text, { skill: resolved.name });
        return;
      }
      const cmd = raw.split(/\s+/)[0];
      const refused = cmd
        ? switchingRefusal(switchingRef.current, { kind: "command", name: cmd })
        : null;
      if (refused) {
        pushNotice(refused);
        return;
      }
      // Guard turn-starting / session-swapping commands while a turn runs: they
      // would corrupt the session (concurrent send) or cancel-handle state.
      // `/clear` on a session that can `clear` is exempt: it resets in place
      // (it stops an own turn first, and the daemon refuses another device's);
      // only the legacy close-and-replace would swap the session under a turn.
      const clearsInPlace = cmd === "/clear" && typeof sessionRef.current?.clear === "function";
      if (cmd && isSessionMutating(cmd) && stateRef.current.running && !clearsInPlace) {
        pushNotice(`_Can't run ${cmd} while a turn is running — stop it first (esc)._`);
        return;
      }
      switch (cmd) {
        case "/exit":
        case "/quit":
          requestQuit(false);
          return;
        case "/help":
          // The skills part is asked fresh (docs/feat/skills-hot-reload.md).
          void skillsSync.settle().then(() => pushNotice(helpText(skills())));
          return;
        case "/clear": {
          const step = clearCommandStep({
            canClear: typeof sessionRef.current?.clear === "function",
            running: stateRef.current.running,
            ownTurn: foreignRef.current === null,
            compacting: compactingRef.current,
            clearing: clearingRef.current,
          });
          if (step === "legacy") {
            // A session without `clear` (the in-process fallback): the old
            // session ends (with its jobs) before the fresh one starts
            // (decision D3).
            sessionRef.current?.close?.();
            swapSession(makeSession());
          } else if (step === "busy") {
            pushNotice("_A /clear is already running._");
          } else if (step === "compacting") {
            pushNotice("_Can't clear while a compaction is running._");
          } else if (step === "stop_then_clear" && abortRef.current) {
            // Stop the own turn like Esc; the clear runs when it has settled.
            clearAfterTurnRef.current = true;
            stoppedHereRef.current = true;
            abortRef.current.abort();
          } else {
            // Another device's running turn: the daemon answers TurnInProgress.
            runClearRef.current?.();
          }
          return;
        }
        case "/close":
          // End this session (every device sees it closed) and quit; the
          // runtime's exit path delivers the close before the socket goes.
          sessionRef.current?.close?.();
          exit();
          return;
        case "/sessions": {
          if (!sessions) {
            pushNotice("_Sessions aren't available on this runtime._");
            return;
          }
          // No "current" captured here: it is read live when rendered and used (R3-1).
          openPanel(
            sessionsPanel(Date.now()),
            () => sessions.list().then((view) => sessionsPanel(Date.now(), view)),
            sessionsListError,
          );
          return;
        }
        case "/compact": {
          const session = sessionRef.current;
          if (!session?.compact) {
            pushNotice("_Compaction isn't available for this session._");
            return;
          }
          if (stateRef.current.running) {
            pushNotice("_Can't compact while a turn is running._");
            return;
          }
          if (compactingRef.current) {
            pushNotice("_A compaction is already running._");
            return;
          }
          pushNotice("_Compacting the conversation…_");
          setCompacting(true);
          compactionOwnedRef.current = false;
          // Whether THIS handler raised its own-compaction count: only then may
          // its settle lower it again (an open that failed raised none).
          let armed = false;
          armed = true;
          // Its one settle (success or failure) ends the compaction-time queue
          // (D3c): sent as one prompt unless a send-now took it. A `/clear`
          // meanwhile already took the rows (a new session: ignore it).
          const settled = (result: CompactionResult) => {
            if (sessionRef.current !== session) {
              return;
            }
            if (!result.ok && armed && ownCompactionsRef.current > 0) {
              ownCompactionsRef.current -= 1; // it replaced nothing: no history of mine to come
            }
            setCompacting(false);
            const out = onCompactionSettled({
              result,
              rows: rowsRef.current,
              sendNowOwns: compactionOwnedRef.current,
              turnRunning: stateRef.current.running,
            });
            pushNotice(out.notice);
            if (out.send !== null) {
              setRows(() => []);
              wakeRef.current = wakeStep(wakeRef.current, { type: "turn_started" }); // its turn flushes the job exits at its start
              // As a fallback send: restored if another client's prompt won the slot.
              void run(out.send, { fallback: true });
              return;
            }
            if (out.restore !== null) {
              setRows(() => []);
              restoreInput(out.restore, "_your queued messages are back in the input_");
            }
            wakeIfPending(); // a wake deferred during the compaction
          };
          // The open a reset needs comes FIRST, as `/clear`'s does (review
          // M2): a resumed session nothing has opened yet holds its chat only
          // as this client's seed, and counting the compaction before the open
          // left the count armed for a compaction that never happened. The
          // latch (`compacting`) is up meanwhile, so nothing starts a turn.
          void Promise.resolve(session.openForReset?.()).then(
            () => {
              if (sessionRef.current !== session) {
                return;
              }
              // Its history (if it compacts) is mine: no "on another device" (C6).
              ownCompactionsRef.current += 1;
              armed = true;
              void session.compact?.().then(
                (r) => {
                  settled({ ok: true, before: r.before, after: r.after });
                  // The history shrank: the open figure is stale until a turn measures.
                  askContext(session);
                },
                (error: unknown) => settled({ ok: false, error }),
              );
            },
            (error: unknown) => settled({ ok: false, error }),
          );
          return;
        }
        case "/settings": {
          // docs/feat/session-settings-apply.md: the host builds the lines.
          const session = sessionRef.current;
          const lines = (shown: readonly SettingsNoticeLine[]) => {
            for (const { text, hint } of shown) {
              stateRef.current = appendNotice(stateRef.current, text, hint ? { hint } : {});
            }
            setScrollOffset(0);
            flushNow();
          };
          const step = settingsCommand(raw, {
            running: stateRef.current.running,
            compacting: compactingRef.current,
            available: session?.settings !== undefined && session.updateSettings !== undefined,
            syncing: session !== null && syncingRef.current === session,
          });
          if (step.kind === "notice") {
            lines([{ text: step.text }]);
          } else if (step.kind === "show") {
            lines(session?.settings?.() ?? []);
          } else if (session?.updateSettings) {
            // During an outage it waits for the link: never nothing on screen.
            syncingRef.current = session;
            lines([{ text: SETTINGS_SYNCING }]);
            const pending = stateRef.current.items.at(-1);
            const settled = (outcome: readonly SettingsNoticeLine[]) => {
              if (syncingRef.current === session) {
                syncingRef.current = null;
              }
              // Moved to another session meanwhile: not that session's news
              // (`/settings` on this one tells the truth when you are back), so
              // the pending line just goes, where a swap kept the transcript.
              const moved = sessionRef.current !== session;
              if (pending !== undefined) {
                stateRef.current = replaceWithNotices(
                  stateRef.current,
                  pending,
                  moved ? [] : outcome,
                );
              }
              flushNow();
              if (!moved) {
                setScrollOffset(0);
                // The prompt or tools may have changed: the open figure is stale.
                askContext(session);
              }
            };
            void session
              .updateSettings()
              .then(settled, () => settled([{ text: "Could not sync the settings." }]));
          }
          return;
        }
        case "/rename": {
          const session = sessionRef.current;
          if (!session?.rename) {
            pushNotice("_Renaming isn't available on this runtime._");
            return;
          }
          const parsed = parseRename(raw);
          if ("usage" in parsed) {
            pushNotice(parsed.usage);
            return;
          }
          void session.rename(parsed.title).then(
            (text) => pushNotice(renamedNotice(text)),
            (error: unknown) => pushNotice(renameFailedNotice(error)),
          );
          return;
        }
        case "/model":
          pushNotice(`Model: \`${model}\``);
          return;
        case "/mcp": {
          if (!mcpStatus) {
            pushNotice("_MCP status isn't available on this runtime._");
            return;
          }
          openPanel(
            mcpPanel(),
            () => mcpStatus().then((servers) => mcpPanel(servers)),
            mcpStatusError,
          );
          return;
        }
        case "/skills": {
          // The session's skills read again (docs/feat/skills-hot-reload.md).
          openPanel(
            skillsPanel(),
            () => skillsSync.refresh().then((list) => skillsPanel(list)),
            skillsListError,
          );
          return;
        }
        case "/tokens": {
          const t = stateRef.current.sessionTokens;
          pushNotice(
            `Tokens — prompt ${t.prompt}, completion ${t.completion}, total ${t.prompt + t.completion}`,
          );
          return;
        }
        case "/retry": {
          const last = lastUserRef.current ?? lastUserText(stateRef.current.items);
          if (!last) {
            pushNotice("_Nothing to retry yet._");
            return;
          }
          const plan = retryPlan(last, skills());
          if (plan.kind === "gone") {
            pushNotice(`_Can't retry: ${plan.command} is no longer available._`);
          } else if (plan.kind === "skill") {
            void run(plan.text, { skill: plan.name });
          } else {
            void run(plan.text);
          }
          return;
        }
        case "/copy": {
          const text = lastAssistantText(stateRef.current.items);
          if (!text) {
            pushNotice("_No assistant reply to copy._");
            return;
          }
          void clipboard(text).then(
            () => pushNotice("_Copied last reply to the clipboard._"),
            () => pushNotice("_Clipboard unavailable._"),
          );
          return;
        }
        case "/save": {
          const path = `${cwd}/tentacle-transcript-${Date.now()}.md`;
          const md = transcriptToMarkdown(stateRef.current.items);
          void saveFile(path, md).then(
            () => pushNotice(`_Saved transcript to ${path}_`),
            (e) => pushNotice(`_Save failed: ${String(e)}_`),
          );
          return;
        }
        default:
          // Maybe a skill made since the list was last asked: ask once more,
          // then resolve the text AGAIN, once (docs/feat/skills-hot-reload.md).
          if (!again && skillsSync.stale()) {
            void skillsSync.settle().then((same) => {
              if (same) {
                handleCommandRef.current?.(raw, true); // not on a session switched meanwhile
              }
            });
            return;
          }
          pushNotice(`_Unknown command: ${cmd}. Try /help._`);
      }
    },
    [
      makeSession,
      swapSession,
      clipboard,
      openPanel,
      cwd,
      exit,
      mcpStatus,
      sessions,
      skillsSync,
      askContext,
      flushNow,
      model,
      pushNotice,
      requestQuit,
      restoreInput,
      run,
      saveFile,
      setCompacting,
      setRows,
      skills,
      wakeIfPending,
    ],
  );
  handleCommandRef.current = handleCommand;

  /**
   * Switch the view to session `id` (a `/sessions` row; the panel already
   * decided it may): stop following the current one — detach FIRST, then open
   * (the other order would hold two attachments and route prompts twice) — and
   * swap to a NEW attach-only controller. A detach the daemon refuses (an
   * older one) changes nothing: the current session is followed again. A
   * target that fails to open hands the view to a fresh session.
   */
  const switchTo = useCallback(
    (id: string, reopen: boolean): void => {
      const old = sessionRef.current;
      if (!sessions || !old?.detach) {
        pushNotice(switchRefusedNotice(id));
        return;
      }
      const staying = stayingNotice(old.stayingRows?.() ?? 0);
      // Latched until the switch settles, whatever the outcome (Review R1).
      switchingRef.current = true;
      // In the same step: the old session's activities stop reaching the view.
      watchSession(null);
      watchReturned(null);
      old.detach().then(
        () => {
          let target: SessionController;
          try {
            target = sessions.open(id, reopen);
          } catch (error) {
            pushNotice(openFailedNotice(error));
            swapSession(makeSession(), { keepTranscript: true });
            switchingRef.current = false;
            return;
          }
          swapSession(target, {
            onOpened: (ok) => {
              if (!ok && sessionRef.current === target) {
                swapSession(makeSession(), { keepTranscript: true });
              }
              switchingRef.current = false;
            },
          });
          // After the swap (it resets the transcript): said in the new view.
          if (staying) pushNotice(staying);
        },
        () => {
          watchReturned(old);
          watchSession(old);
          pushNotice(switchRefusedNotice(id));
          switchingRef.current = false;
        },
      );
    },
    [makeSession, pushNotice, sessions, swapSession, watchReturned, watchSession],
  );

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      field.reset();
      if (text === "") {
        return;
      }
      if (text.startsWith("/")) {
        handleCommand(text);
        return;
      }
      // Record the prompt in history (dedup is inside `pushHistory`) and return
      // to the live-draft slot: the next Up starts a fresh walk from the newest
      // entry. Done before the running branch so a steering prompt is recalled
      // too.
      historyRef.current = pushHistory(historyRef.current, text);
      histIndexRef.current = historyRef.current.length;
      draftRef.current = "";
      // A switch in flight: the old session is detaching and the new one not
      // yet followed — the text goes back to the input, never lost (Review R1).
      const refusedPrompt = switchingRefusal(switchingRef.current, { kind: "prompt" });
      if (refusedPrompt) {
        restoreInput(text, refusedPrompt);
        return;
      }
      // Mid-turn: queue the task (steering) so it is handed to the agent before
      // its next round, instead of starting a new turn. Call through the session
      // (not a detached reference) so `this` is preserved.
      if (stateRef.current.running) {
        const ctrl = sessionRef.current;
        if (ctrl?.enqueue) {
          // The row's id is the enqueue key: a send-now names exactly this row.
          const id = crypto.randomUUID();
          setRows((rows) => addRow(rows, text, id)); // optimistic (responsive UX)
          // enqueue is sync (local) or a Promise (worker/pod/remote). On a
          // reject (e.g. MethodNotFound from an older remote daemon, or a
          // transport drop) the entry will never get a `steer` echo, so drop
          // it — otherwise it masks a send that never happened. `Promise.resolve`
          // normalises the sync case (it never rejects → no local behaviour change).
          Promise.resolve(ctrl.enqueue(text, id)).then(
            // Accepted: from now on the daemon's list says where the row is (C7).
            () => setRows((rows) => markAcked(rows, id)),
            (error: unknown) => {
              const res = onReject(rowsRef.current, id, ownedIdsRef.current);
              if (!res.notify) {
                return; // a send-now took it: its text travels with the send-now
              }
              setRows(() => res.rows);
              const reason = error instanceof Error ? error.message : String(error);
              pushNotice(`_message not queued: ${reason}_`);
            },
          );
        }
        return;
      }
      // During this TUI's `/compact` no turn runs, so nothing to enqueue to:
      // a local row, sent when the compaction ends or by the chord (D3c).
      if (compactingRef.current) {
        setRows((rows) => addRow(rows, text, crypto.randomUUID()));
        return;
      }
      void run(text);
    },
    [handleCommand, pushNotice, restoreInput, run, field.reset, setRows],
  );

  // All line editing lives in `useLineEditor` (pure `editor.ts` ops), so no
  // control key — Ctrl+O, mouse reports, escapes — can ever be echoed into the
  // buffer, independent of input-handler ordering.

  // --- mouse text selection → clipboard ------------------------------------
  const setSelection = useCallback((next: Selection | null) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);

  /** Copy the current selection's text, then clear it. `rows` is the colour buffer. */
  const finishSelection = useCallback(
    (rows: readonly string[]) => {
      const sel = selectionRef.current;
      setSelection(null);
      if (!sel || !isNonEmpty(sel)) {
        return;
      }
      const text = extractSelection(rows.map(stripAnsi), sel);
      if (text.trim() === "") {
        return;
      }
      // Copy silently on success: the on-screen notice made the viewport jump
      // (pushNotice resets scrollOffset to the tail). Surface failures only.
      void clipboard(text).catch(() => pushNotice("_Clipboard unavailable._"));
    },
    [clipboard, pushNotice, setSelection],
  );

  // --- fragmented SGR mouse reports ----------------------------------------
  // Hold a partial report until the next data chunk completes it. The timer
  // releases the hold when nothing follows — i.e. the held "[" was really a
  // typed bracket (the two halves of a real report arrive within the same pty
  // read window, so 100 ms is far longer than any split).
  const clearMouseHold = useCallback(() => {
    if (pendingMouseTimerRef.current) {
      clearTimeout(pendingMouseTimerRef.current);
      pendingMouseTimerRef.current = null;
    }
  }, []);
  const holdMouse = useCallback(
    (partial: string) => {
      pendingMouseRef.current = partial;
      if (pendingMouseTimerRef.current) {
        clearTimeout(pendingMouseTimerRef.current);
      }
      pendingMouseTimerRef.current = setTimeout(() => {
        pendingMouseTimerRef.current = null;
        const p = pendingMouseRef.current;
        pendingMouseRef.current = "";
        if (p === "[" && !panelRef.current) {
          field.insert(p); // it was a typed bracket after all
        }
        // A longer p was a truncated report: drop it.
      }, 100);
    },
    [field.insert],
  );
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
        // An open reply field takes it, never the hidden main field.
        if (clean && !insertIntoReply(clean) && !panelRef.current) {
          field.insert(clean);
        }
      }
    }, PASTE_TIMEOUT_MS);
  }, [clearPasteTimeout, field.insert, insertIntoReply]);
  useEffect(() => {
    return () => clearPasteTimeout();
  }, [clearPasteTimeout]);

  useInput((char, key) => {
    // Shift+Tab toggles auto-accept in any state (idle, running, or with a
    // prompt showing). Checked first so it never reaches the palette's Tab.
    if (key.tab && key.shift) {
      permission.toggleAutoApprove();
      return;
    }
    // `/quit`'s confirmation: every other key answers it, before the chord and
    // the permission dialog, so its `y` never approves an ask opened meanwhile.
    // Only a plain `y` closes (`quitConfirmKey`); Ctrl+C is "No" — it dismisses,
    // as before 6a-2 (owner 2026-11-09, a), so the `(y/N)` text stays true and
    // a user must press `y` to lose children.
    if (quitConfirmRef.current !== null) {
      // Read the facts BEFORE clearing: who the dialog spoke for decides whether
      // `y` closes others' session, and Ctrl+C's dismiss drops the dialog.
      const facts = quitConfirmRef.current;
      setQuitConfirm(null);
      if (quitConfirmKey(char, key.ctrl || key.meta) === "yes") {
        // `closeForAll` is only for a dialog that SAID "close the session for
        // all": it skips attach-run's "someone registered meanwhile" re-check.
        if (facts.others > 0) {
          runQuit?.closeForAll();
        }
        requestQuit(true);
        return;
      }
      // Ctrl+C here is "No" (owner 2026-11-09, a): it dismisses, as before
      // 6a-2. The loss is irreversible and the dialog exists to catch exactly
      // that reflex, so only `y` loses children; the dialog said `(y/N)`, and
      // this keeps it true. Never a trap: the next Ctrl+C asks again.
      return;
    }
    // The `Ctrl+X Ctrl+S` chord (send the queued messages now): before the
    // permission dialog, so it works while one is up (D3). A key that breaks
    // the chord goes on below unchanged.
    const chord = stepChord(chordRef.current, char, key, Date.now());
    chordRef.current = chord.state;
    if (chord.action === "consumed") {
      return;
    }
    if (chord.action === "sendNow") {
      sendNow();
      return;
    }
    // While the permission dialog is up, keys drive it (nothing else). Every
    // decision is `stepPermissionKey`'s (docs/feat/permission-reply.md); this
    // executes it.
    if (permission.pending) {
      const mode = permission.readMode();
      // The open reply field takes a bracketed paste (sanitized, clipped) —
      // never the hidden main field, never read as y/n keys.
      if (mode.mode === "reply") {
        const pasteStep = stepPaste(pasteBufRef.current, char);
        if (pasteStep.consumed) {
          pasteBufRef.current = pasteStep.buffer;
          if (pasteStep.buffer !== null) {
            armPasteTimeout();
          } else {
            clearPasteTimeout();
          }
          if (pasteStep.text !== undefined) {
            const clean = sanitizePasted(pasteStep.text);
            if (clean) {
              insertIntoReply(clean);
            }
          }
          return;
        }
      }
      const { state, action } = stepPermissionKey(mode, char, key, {
        choices: permission.choices,
        selected: permission.selected,
        maxChars: replyMax,
      });
      if (state !== mode) {
        permission.setMode(state);
      }
      switch (action.kind) {
        case "stop":
          // "Stop everything", not "I refuse this command": no deny goes out
          // (over RPC it would race the cancel and show a false "denied" on every
          // device); the turn's cancel settles the request — whoever started the
          // turn (a foreign one too, owner Q2). With no turn shown here to cancel
          // the dialog stays: dismissing it would orphan the request (suspended,
          // unseen) until the TUI quits. A reply draft goes back to the input.
          if (abortRef.current) {
            permission.answer(DISMISSED);
            stoppedHereRef.current = true;
            abortRef.current.abort();
          }
          break;
        case "select":
          permission.setSelected(action.index);
          break;
        case "answer":
          permission.answer(action.response);
          break;
        case "pasteClipboard":
          void paste().then(
            (text) => {
              const clean = sanitizePasted(text);
              if (clean) {
                insertIntoReply(clean);
              }
            },
            () => pushNotice("_Clipboard unavailable._"),
          );
          break;
        default:
          break;
      }
      return;
    }
    if (key.ctrl && char === "c") {
      // One decision in `ctrlCQuitStep` (docs/feat/subagent-background-ui.md): an
      // idle Ctrl+C with background sub-agents running asks before losing them.
      const agents = backgroundCount(subagentsRef.current);
      const others = runQuit?.othersOnSession() ?? 0;
      const step = ctrlCQuitStep({
        running: stateRef.current.running,
        exitPending: exitPendingRef.current,
        detaches: detachOnQuit,
        others,
        agents,
      });
      if (step === "confirm") {
        setQuitConfirm({ others: 0, agents, names: backgroundNames(subagentsRef.current) });
        return;
      }
      // No abort handle (the turn is already settling) → nothing to stop: quit.
      if (step === "exit" || !abortRef.current) {
        exit();
      } else {
        stoppedHereRef.current = true;
        abortRef.current.abort();
      }
      return;
    }
    // Bracketed paste: capture pasted text (markers stripped) before the
    // escape-abort below, since a paste's leading ESC can look like Escape. Runs
    // whether idle or mid-turn, so text can be pasted into a queued task too.
    const pasteStep = stepPaste(pasteBufRef.current, char);
    if (pasteStep.consumed) {
      pasteBufRef.current = pasteStep.buffer;
      // Still inside a paste → arm the recovery timer; finished → disarm it.
      if (pasteStep.buffer !== null) {
        armPasteTimeout();
      } else {
        clearPasteTimeout();
      }
      if (pasteStep.text !== undefined) {
        const clean = sanitizePasted(pasteStep.text);
        if (clean && !panel) {
          field.insert(clean);
        }
      }
      return;
    }
    // The list panel: its keys first (so Esc closes it rather than stopping
    // a running turn). Mouse reports fall through to the dispatch below; any
    // other key is swallowed there — no line editing behind the panel.
    const sessionsAction = panel?.kind === "sessions" ? sessionsKey(char, key) : "none";
    if (panel?.kind === "sessions" && sessionsAction === "none" && panel.state.armed !== null) {
      // Any other key disarms a pending delete (then falls through, like the tree panels).
      setPanel((p) => (p?.kind === "sessions" ? { ...p, state: { ...p.state, armed: null } } : p));
    }
    if (panel?.kind === "sessions" && sessionsAction !== "none") {
      // `/sessions`: every decision is `sessions-panel.ts`'s; this executes it.
      const action = sessionsAction;
      const entry = sessionsAt(panel.data, panel.state);
      // The session being viewed, read NOW — the one source (Review R3-1).
      const current = sessionRef.current?.sessionId ?? null;
      if (action === "close") {
        closePanel();
      } else if (action === "up" || action === "down") {
        setPanel((p) => (p ? applyPanel(p, action, columns) : p));
      } else if (action === "choose" && entry) {
        const busy = stateRef.current.running || compactingRef.current;
        const choice = sessionsChoose(entry, current, busy, switchingRef.current);
        if (choice.kind === "refused") {
          pushNotice(choice.text);
        } else {
          closePanel();
          if (choice.kind === "switch") {
            switchTo(choice.id, choice.reopen);
          }
        }
      } else if (action === "delete" && entry && sessions) {
        const step = sessionsDelete(panel.state, entry, current);
        setPanel((p) => (p?.kind === "sessions" ? { ...p, state: step.state } : p));
        if (step.kind === "refused") {
          pushNotice(step.text);
        } else if (step.kind === "delete") {
          // The refresh updates only THIS panel, if still open (never re-opens one).
          const startedGen = panelGenRef.current;
          const applies = (): boolean =>
            sessionsRefreshApplies({
              startedGen,
              gen: panelGenRef.current,
              open: panelRef.current?.kind === "sessions",
              switching: switchingRef.current,
            });
          void sessions.remove(step.id).then(
            () => {
              if (!applies()) return;
              void sessions.list().then(
                (view) => {
                  if (!applies()) return;
                  setPanel((p) =>
                    p?.kind === "sessions"
                      ? {
                          ...p,
                          data: view,
                          now: Date.now(),
                          state: refreshedSessions(p.state, view),
                        }
                      : p,
                  );
                },
                (e: unknown) => {
                  // The panel closed meanwhile: its refresh no longer matters (R4-1).
                  if (applies()) pushNotice(sessionsListError(e));
                },
              );
            },
            (e: unknown) => pushNotice(deleteFailedNotice(e)),
          );
        }
      }
      return;
    }
    if (panel && panel.kind !== "sessions") {
      const action = treeKey(char, key);
      if (action === "close") {
        closePanel();
        return;
      }
      if (action !== "none") {
        setPanel((p) => (p ? applyPanel(p, action, columns) : p));
        return;
      }
    }
    if (key.escape && stateRef.current.running && abortRef.current) {
      stoppedHereRef.current = true;
      abortRef.current.abort();
      return;
    }
    if (key.ctrl && char === "o") {
      setExpandAll((v) => !v);
      return;
    }
    // Slash-command palette: when open, arrows move the selection, Tab completes
    // the name, Enter runs the highlighted command, Esc dismisses it. These take
    // priority over scrolling/line-editing so the menu is drivable.
    if (paletteOpen) {
      const n = paletteCommands.length;
      if (key.upArrow) {
        setCommandIndex((i) => (Math.min(i, n - 1) - 1 + n) % n);
        return;
      }
      if (key.downArrow) {
        setCommandIndex((i) => (Math.min(i, n - 1) + 1) % n);
        return;
      }
      if (key.tab) {
        const name = paletteCommands[commandSel]?.name;
        if (name) {
          field.set(name);
        }
        return;
      }
      if (key.return) {
        const name = paletteCommands[commandSel]?.name;
        if (name) {
          field.reset();
          handleCommand(name);
        }
        return;
      }
      if (key.escape) {
        field.reset();
        return;
      }
    }
    // Mouse (SGR 1006). Ink strips the leading ESC and hands us the report(s)
    // as `char`. A fast wheel or drag coalesces several reports into one chunk,
    // and some terminals/ptys split one report across two chunks (the first
    // half then arriving as a bare "[", indistinguishable from a typed
    // bracket). So a chunk may carry any number of complete reports plus, at
    // the end, a half-delivered one. We dispatch every complete report and hold
    // any trailing partial, so no report byte ever leaks into the input.
    const dispatchMouse = (r: MouseReport): void => {
      // Wheel notches (64=up, 65=down).
      if (r.btn & 64) {
        const dir = r.btn & 1 ? -WHEEL_LINES : WHEEL_LINES;
        setScrollOffset((o) => clampOffset(o + dir, total, viewport));
        return;
      }
      // A left press on a list panel body row selects it (a head row also
      // expands/collapses). Drags and releases there do nothing.
      if (listView && r.y >= panelBodyTop && r.y < panelBodyTop + listView.rows.length) {
        if (r.press && r.btn === 0) {
          const bodyIndex = r.y - panelBodyTop;
          setPanel((p) => (p ? panelClick(p, listView, bodyIndex, columns) : p));
        }
        return;
      }
      // Left button, part 1: classify the report as click / drag / neither.
      // The whole rule is `tool-expand.ts`'s (`nextClick`); here we only feed it
      // and act on a completed click. A click is a press and a release on the
      // SAME cell with no motion in between, and a coalesced chunk (both reports
      // in one write) is seen as press then release, in order.
      const step = nextClick(clickRef.current, r);
      clickRef.current = step.state;
      if (step.click) {
        // The call under the cursor's SCREEN row, or null when the row is
        // outside the transcript viewport (the prompt rule, the input box, the
        // status bar) — `tool-hit.ts` owns the whole rule, window included.
        // Under Ctrl+O every call's command already shows, so a click has
        // nothing to reveal and must not toggle the hidden per-call state.
        const id = expandAll ? null : toolCallAtViewport(layout.laid, win, step.click.y);
        // Only a tool call's HEADER row is a control; anywhere else the click
        // stays what it is today (a zero-length selection, i.e. nothing).
        if (id !== null) {
          setSelection(null);
          setExpandedIds((ids) => toggleExpanded(ids, id));
          return;
        }
      }
      // Left button, part 2: release copies the selection, press/drag starts/extends it.
      if (!r.press) {
        // Selection can span rows scrolled out of view, so assemble the whole
        // buffer here — only on release, never on the per-frame render path.
        finishSelection(sliceLaid(layout.laid, 0, total));
        return;
      }
      const visibleIndex = r.y - 1;
      if ((r.btn & 3) === 0 && visibleIndex >= 0 && visibleIndex < visible.length) {
        const row = win.start + visibleIndex;
        const col = Math.max(0, r.x - 1);
        const point = { row, col };
        const dragging = (r.btn & 32) !== 0;
        setSelection(
          dragging && selectionRef.current
            ? { anchor: selectionRef.current.anchor, head: point }
            : { anchor: point, head: point },
        );
      }
    };

    // Prepend any partial report held from the previous chunk.
    const held = pendingMouseRef.current;
    if (held) {
      pendingMouseRef.current = "";
      clearMouseHold();
    }
    const data = held + char;
    const { reports, rest } = splitMouseReports(data);
    if (reports.length > 0) {
      for (const r of reports) {
        dispatchMouse(r);
      }
      if (isMousePrefix(rest)) {
        holdMouse(rest); // a trailing, half-delivered report
      }
      return;
    }
    // No complete report. If the chunk is still a growable report prefix (and
    // this event is not a real keypress), keep holding it for the next chunk.
    const plainKey =
      !key.return &&
      !key.ctrl &&
      !key.meta &&
      !key.tab &&
      !key.escape &&
      !key.upArrow &&
      !key.downArrow &&
      !key.pageUp &&
      !key.pageDown &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.backspace &&
      !key.delete;
    if (isMousePrefix(data) && plainKey) {
      holdMouse(data);
      return;
    }
    // Behind a list panel nothing edits the (hidden) input.
    if (panel) {
      return;
    }
    // Not a report or a continuable prefix: a held bare "[" was a typed bracket,
    // so restore it (a longer truncated hold is dropped). It precedes whatever
    // this event's own key does below.
    const restored = held === "[" ? "[" : "";
    if (restored) {
      if (key.return) {
        // Same-event submit: `field` is still the pre-insert closure value, so
        // append the restored bracket here instead of inserting it.
        submit(field.value + restored);
        return;
      }
      field.insert(restored);
    }

    // Line editing works while idle AND while a turn runs (so a task can be
    // typed and queued for steering). The routing decision is pure
    // (`resolveLineInput`); here we only execute it. History recall is
    // inherently stateful (session refs + the live draft), so it stays a local
    // closure the "history" action calls into.
    const historyStep = (dir: -1 | 1): void => {
      // On the draft slot the live value IS the draft (saved by the first Up);
      // inside history the saved draft is what a Down past the newest restores.
      const onDraftSlot = histIndexRef.current >= historyRef.current.length;
      const prevIndex = histIndexRef.current;
      const res = recall(
        { items: historyRef.current, index: prevIndex },
        dir,
        onDraftSlot ? field.value : draftRef.current,
      );
      histIndexRef.current = res.index;
      draftRef.current = res.draft;
      // A no-op recall (e.g. Up with an empty history) must not touch the
      // field, or a mid-buffer cursor would jump to the end.
      if (res.value === field.value && res.index === prevIndex) {
        return;
      }
      // Shell convention: the cursor lands at the end of the recalled entry.
      field.set(res.value);
    };

    const action = resolveLineInput(char, key, { value: field.value, cursor: field.cursor });
    switch (action.kind) {
      case "moveVertical":
        field.moveVertical(action.dir, action.extend);
        return;
      case "history":
        historyStep(action.dir);
        return;
      case "scroll":
        setScrollOffset((o) => applyScroll(o, action.dir, total, viewport));
        return;
      case "pasteClipboard":
        // Ctrl+V: read the OS clipboard and insert at the cursor. (The terminal's
        // own paste — Cmd+V on macOS — never reaches us as a key; it arrives as a
        // text chunk, routed to an "insert" action instead.)
        void paste().then(
          (text) => {
            const clean = flattenPasted(text);
            if (clean && !panelRef.current) {
              field.insert(clean);
            }
          },
          () => pushNotice("_Clipboard unavailable._"),
        );
        return;
      case "newline":
        // A trailing `\` before the cursor is a line continuation, not a submit.
        field.deleteBack();
        field.insert("\n");
        return;
      case "submit":
        submit(field.value);
        return;
      case "moveWord":
        field.moveWord(action.dir, action.extend);
        return;
      case "moveCursor":
        field.moveCursor(action.delta, action.extend);
        return;
      case "moveLine":
        field.moveLine(action.edge, action.extend);
        return;
      case "deleteBack":
        field.deleteBack();
        return;
      case "deleteWord":
        field.deleteWord(action.dir);
        return;
      case "insert":
        field.insert(action.text);
        return;
      case "none":
        return;
    }
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={viewport}>
        {selection ? (
          visible.map((row, i) => {
            const absRow = win.start + i;
            const plain = stripAnsi(row);
            // Ink measures an empty <Text> as 0x0, so blank separator rows
            // would collapse and shift the transcript up. A single space keeps
            // every row at height 1 (the grid trimEnd()s it back to "").
            const display = row === "" ? " " : row;
            const line = row === "" ? " " : plain;
            const range = rowSelectionRange(selection, absRow, plain.length);
            if (!range) {
              return <Text key={i}>{display}</Text>;
            }
            const [c0, c1] = range;
            return (
              <Text key={i}>
                {line.slice(0, c0)}
                <Text inverse>{line.slice(c0, c1)}</Text>
                {line.slice(c1)}
              </Text>
            );
          })
        ) : (
          <Text>{visible.join("\n")}</Text>
        )}
      </Box>

      <Box marginTop={1}>
        {quitConfirm !== null ? (
          <QuitConfirm text={quitConfirmText(quitConfirm)} columns={columns} />
        ) : permission.pending ? (
          <PermissionPrompt
            req={permission.pending}
            options={permission.choices.map((c) => c.label)}
            selected={permission.selected}
            cwd={cwd}
            columns={columns}
            {...(replyShown ? { reply: replyShown } : {})}
            replyable={permission.choices.some((c) => c.reply === true)}
            {...(permission.pendingAgent
              ? { agentLine: permissionAgentLine(permission.pendingAgent, columns) }
              : {})}
          />
        ) : (
          <Box flexDirection="column" width={columns}>
            {/* Queued messages sit where a sent message would (right under the
                conversation); the thinking/working line stays just above the
                input, under them (owner, 2026-10-25). */}
            {st.running || compacting ? (
              <QueuedMessages queued={rowTexts(shown)} hint={SEND_NOW_HINT} columns={columns} />
            ) : null}
            {/* One blank row between the send-now hint and the thinking line. */}
            {st.running && shown.length > 0 ? <Text> </Text> : null}
            {loading ? (
              <Text {...dimProps()}>{loadingLabel(loading.done, loading.total)}</Text>
            ) : st.running ? (
              <Thinking
                since={
                  st.reasoning && st.reasoningStartedAt !== null
                    ? st.reasoningStartedAt
                    : (st.turnStartedAt ?? Date.now())
                }
                label={st.reasoning ? "Thinking…" : "Working…"}
              />
            ) : null}
            {listView ? (
              <ListPanel view={listView} columns={columns} />
            ) : (
              <>
                {paletteOpen ? (
                  <CommandPalette
                    commands={paletteRows}
                    selected={commandSel - paletteWin.start}
                    columns={columns}
                  />
                ) : null}
                {/* The top border carries the model name, right-aligned
                    (`modelBorder`, pure): Ink's own border has no title. */}
                <Text color={palette().border}>{modelBorder(model, columns)}</Text>
                <Box
                  width={columns}
                  borderStyle="round"
                  borderColor={palette().border}
                  borderTop={false}
                  borderLeft={false}
                  borderRight={false}
                >
                  <LineInput
                    value={field.value}
                    cursor={field.cursor}
                    anchor={field.anchor}
                    placeholder={st.running ? "Queue a task…" : INPUT_PLACEHOLDER}
                    maxRows={MAX_INPUT_ROWS}
                    width={columns}
                  />
                </Box>
              </>
            )}
          </Box>
        )}
      </Box>

      <StatusBar
        cwd={cwd}
        target={target ?? null}
        tokens={tokensShown.totals}
        contextTokens={ctxShown.used}
        contextApprox={ctxShown.approx}
        contextWindow={contextWindow}
        columns={columns}
        scrolledUp={scrolledUp}
        hiddenAbove={hiddenAbove}
        expandAll={expandAll}
        autoApprove={permission.autoApprove}
        background={backgroundCount(subagents)}
        link={linkView}
      />
    </Box>
  );
}
