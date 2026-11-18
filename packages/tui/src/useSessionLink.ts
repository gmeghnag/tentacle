import { type WakeModel, wakeStep } from "@tentacle/core";
/**
 * The SESSION LINK (docs/feat/app-decomposition.md S9b): how this TUI follows a
 * session — the activity feed it streams into the transcript (`onActivity`), the
 * subscriptions a follow installs and tears down (`watchSession`), the ONE way
 * the view moves to another session (`swapSession`), and a `/sessions` switch
 * (`switchTo`).
 *
 * Every DECISION stays where it was and stays pure: `nextStep` /
 * `historyAction` / `closedNotice` (`turn-feed.ts`), `openFailedNotice` /
 * `stayingNotice` / `switchRefusedNotice` (`sessions-panel.ts`), `handBackRows` /
 * `takeAll` (`queued.ts`), `resetDock` / `noteSent` (`background-focus.ts`),
 * `subagentNotifyNotice` / `userToSubagentNotice` (`subagent-notify.ts`),
 * `forgetContextFill` / `appendHistory` / `resetHistory` / `startContinuation` /
 * `initialState` (`state.ts`), `wakeStep` (`@tentacle/core`). This hook is the
 * executor for them, owning only the wiring and the ONE latch nothing outside it
 * touches (AGENTS §7).
 *
 * Three constraints from the plan shape the file:
 *
 * 1. **Effects stay in `App`** (Fable H1): this hook declares NO `useEffect`.
 *    `App`'s 22 keep their order and every index (the original 20 + session-hop's
 *    2); the two that DRIVE this code
 *    (the `watchReturned` mount effect, the mount `watchSession` one) stay there
 *    and reach the hook through the returned identifiers.
 * 2. **A shared latch is passed in, never re-created** (Fable M1/H3). Every ref
 *    below is ALSO read or written by a driver this slice does not own — the turn
 *    driver (`heldRef`, `abortRef`, `streamCtrlRef`, `sendNowRef`, `warmingRef`,
 *    `clearingRef`, `ownCompactionsRef`, `ownClearsRef`, `wakeRef`, …), the clear
 *    (`swapSession`'s latches), the key snapshot (`switchingRef`), the frame — so
 *    it arrives as a port field: each read site keeps its identifier and its
 *    SOURCE (a ref read stays a ref read, so two keys with no render between them
 *    behave exactly as on `main`). The ONE ref created HERE is `swapRef` (the
 *    `onActivity` <-> `swapSession` cycle), which nothing outside the hook
 *    touches — `onActivityRef` stays `App`'s, because it is also a port field of
 *    the turn driver (`useTurnDriver`'s drain method resolves through it).
 * 3. **A port field keeps its identity rule** (Fable H2): a stable setter stays
 *    one, a `useCallback` keeps its dep array, a ref stays THE same object, a
 *    prop stays a prop. The `useCallback`s below name their fields in deps —
 *    never `host` — so `useExhaustiveDependencies` keeps seeing each one; every
 *    such field is identity-stable, so no callback's identity changed and the
 *    mount effect does not re-subscribe (S0b's identity test still holds).
 *
 * **Why `armWake`, `wakeIfPending`, `askContext` and `watchReturned` are NOT
 * here** (measured, not chosen — see Execution, drift 1): H1 freezes `App`'s
 * effect list, and each of those four is consumed by an effect or a hook call
 * that sits BEFORE any legal call site for this hook (the jobs subscription's
 * `armWake`, effect #3 at `App.tsx:653`; the `watchReturned` mount, #15 at 1232;
 * the mount wake, #17 at 1319), while `askContext`/`wakeIfPending` are
 * themselves PORT FIELDS of `useTurnDriver`, which is called at 1355. Adding
 * them here would move an effect's index or form a use-before-declaration.
 */
import { type MutableRefObject, useCallback, useRef } from "react";
import type { SessionController, SessionDirectory } from "./app-types.ts";
import { noteSent, resetDock } from "./background-focus.ts";
import type { CapsView } from "./capability-toggles.ts";
import { CLEARED_ELSEWHERE_NOTICE, CLEARED_NOTICE } from "./clear-command.ts";
import type { QuitConfirmFacts } from "./commands.ts";
import { type DaemonQueue, handBackRows, takeAll } from "./queued.ts";
import type { QueuedRows } from "./queued.ts";
import type { ScheduleDockRow } from "./schedule-view.ts";
import { openFailedNotice, stayingNotice, switchRefusedNotice } from "./sessions-panel.ts";
import type { SkillsSync } from "./skills-sync.ts";
import {
  type DisplayState,
  appendHistory,
  appendNotice,
  forgetContextFill,
  initialState,
  resetHistory,
  startContinuation,
} from "./state.ts";
import type { ContextOpen } from "./status-view.ts";
import { subagentNotifyNotice, userToSubagentNotice } from "./subagent-notify.ts";
import {
  type SessionActivity,
  closedNotice,
  compactionSeparatorOf,
  historyAction,
  nextStep,
} from "./turn-feed.ts";
import type { DockLayer } from "./useDock.ts";
import type { PanelsLayer } from "./usePanels.ts";
import type { RunQuit } from "./useQuitClear.ts";
import type { PendingSendNow, TurnLayer } from "./useTurnDriver.ts";

/**
 * The narrow port the session link executes through: `App`'s own state, setters,
 * refs and callbacks, plus the executors of neighbouring slices a follow hands
 * off to (`commitHistory`/`streamTurn`/`drainHeld` from S9a's `useTurnDriver`,
 * `setAgents`/`setJobs`/`setDock`/`jobOutputRef` from S5's `useDock`,
 * `touchPanel` from S7's `usePanels`). A port FIELD keeps its current identity
 * rule (Fable H2); the callbacks below destructure the fields and name them in
 * deps, never `host`.
 */
export interface SessionLinkHost {
  // --- the session, the display state and the transcript
  readonly sessionRef: MutableRefObject<SessionController | null>;
  readonly stateRef: MutableRefObject<DisplayState>;
  /** The queued/steering rows: the ref is the truth, `setRows` renders them. */
  readonly rowsRef: MutableRefObject<QueuedRows>;
  readonly setRows: (f: (rows: QueuedRows) => QueuedRows) => void;
  readonly setScrollOffset: (offset: number) => void;
  /** A replaced history is a new chat: nothing of the old stays expanded. */
  readonly setExpandAll: (next: boolean) => void;
  readonly setExpandedIds: (next: readonly string[]) => void;

  // --- the follow's own subscriptions, all replaced with the session
  readonly activitySubRef: MutableRefObject<(() => void) | null>;
  readonly queueSubRef: MutableRefObject<(() => void) | null>;
  readonly agentsSubRef: MutableRefObject<(() => void) | null>;
  readonly jobsSubRef: MutableRefObject<(() => void) | null>;
  /** The session's armed scheduled wakes (`schedules`, cron-tool S5). */
  readonly schedulesSubRef: MutableRefObject<(() => void) | null>;
  readonly notifySubRef: MutableRefObject<(() => void) | null>;
  readonly dockMsgSubRef: MutableRefObject<(() => void) | null>;
  /** The session's MCP/skill switches (docs/feat/session-capabilities.md S4). */
  readonly capsSubRef: MutableRefObject<(() => void) | null>;
  /** The switches the daemon reported (`App`'s: it renders them). */
  readonly onCapsChange: (caps: CapsView | undefined, by?: string) => void;

  // --- the latches of the turn driver and of a follow (all shared)
  /** Activities held while a run of mine streamed (`onActivity` pushes them). */
  readonly heldRef: MutableRefObject<SessionActivity[]>;
  /** What Esc/Ctrl+C aborts: the foreign turn's controller, once it streams. */
  readonly abortRef: MutableRefObject<AbortController | null>;
  readonly streamCtrlRef: MutableRefObject<AbortController | null>;
  readonly sendNowRef: MutableRefObject<PendingSendNow | null>;
  /** A warmed commit is in flight (`nextStep` reads it as `inFlight`). */
  readonly warmingRef: MutableRefObject<boolean>;
  readonly stoppedHereRef: MutableRefObject<boolean>;
  /** `/clear`'s latch and this TUI's own counts (a follow releases/reset them). */
  readonly clearingRef: MutableRefObject<boolean>;
  readonly ownCompactionsRef: MutableRefObject<number>;
  readonly ownClearsRef: MutableRefObject<number>;
  readonly clearAfterTurnRef: MutableRefObject<boolean>;
  /** The send-now and the wake latches `swapSession` resets (all shared). */
  readonly sendNowUnsupportedRef: MutableRefObject<boolean>;
  readonly fallbackNoticedRef: MutableRefObject<boolean>;
  readonly wakeRef: MutableRefObject<WakeModel>;
  readonly handedWakeRef: MutableRefObject<boolean>;
  /** A `/sessions` switch is in flight (`switchingRefusal` refuses meanwhile). */
  readonly switchingRef: MutableRefObject<boolean>;
  /** The activity handler, read through a ref (the turn driver drains held ones). */
  readonly onActivityRef: MutableRefObject<((activity: SessionActivity) => void) | null>;
  /** Watch the new session's returned rows (`App`'s own; `swapSession`/`switchTo`). */
  readonly watchReturned: (session: SessionController | null) => void;

  // --- painting, the notice sink and the input line
  readonly flushNow: () => void;
  /**
   * A history that just rebuilt the transcript, cards attached (S6a review
   * finding 2) — and, on a session SWAP, the per-session join forgotten so the
   * new session's own list is asked (`forgetArtifacts`).
   */
  readonly joinCards: (state: DisplayState) => DisplayState;
  readonly forgetArtifacts: () => void;
  /** `level: "warn"` marks a harness line the person should notice (docs/feat/harness-notices.md S2). */
  readonly pushNotice: (text: string, level?: "warn") => void;
  /** A compaction's grey rule (S3); `pushNotice` cannot draw one. */
  readonly pushSeparator: (text: string) => void;
  readonly restoreInput: (text: string, why: string) => void;
  readonly setCompacting: (on: boolean) => void;

  // --- the session's own views (a follow resets each for the new one)
  readonly skillsSync: SkillsSync;
  readonly setContextOpen: (next: ContextOpen | null) => void;
  readonly setDaemonQueue: (next: DaemonQueue | undefined) => void;
  readonly askContext: (session: SessionController | null) => void;

  // --- the neighbours a follow hands off to
  /** The turn driver's three, by the identifiers `App` froze (S9a). */
  readonly streamTurn: TurnLayer["streamTurn"];
  readonly commitHistory: TurnLayer["commitHistory"];
  readonly drainHeld: TurnLayer["drainHeld"];
  /** The dock's rows reset and a child's sent message (`S5`). */
  readonly setAgents: DockLayer["setAgents"];
  readonly setJobs: DockLayer["setJobs"];
  /** The session's armed wake table (`useDock`'s `setSchedules`, cron-tool S5). */
  readonly setSchedules: DockLayer["setSchedules"];
  readonly setDock: DockLayer["setDock"];
  readonly jobOutputRef: DockLayer["jobOutputRef"];
  /** An open `/sessions` panel re-read at the next render (`S7`). */
  readonly touchPanel: PanelsLayer["touchPanel"];

  // --- the App's own, decisive ones
  /** `/quit`'s confirmation facts (the dialog's state is App's: it renders it). */
  readonly setQuitConfirm: (facts: QuitConfirmFacts | null) => void;
  /** A run's TUI: a `closed` activity closes for every TUI, or this one leaves. */
  readonly runQuit: RunQuit | undefined;
  /** The `/sessions` directory, when this runtime has one (a value: a prop). */
  readonly sessions: SessionDirectory | undefined;
  readonly makeSession: () => SessionController;
  /** Fire a deferred autonomous wake (idle-gated; the turn's settle asks again). */
  readonly wakeIfPending: () => void;
  /** The wake a running child's message arms (shared with the jobs effect). */
  readonly armWake: () => void;
  /** A running child's message asks for a wake, and this laptop allows two-way. */
  readonly subagentsTwoWay: boolean;
  /** Quit the TUI (Ink's `useApp().exit`). */
  readonly exit: () => void;
}

/** What `App` names from the session link. The identifiers are the pre-S9b ones. */
export interface SessionLinkLayer {
  /** One activity this TUI did not start: stream it, or apply its history. */
  readonly onActivity: (activity: SessionActivity) => void;
  /** Follow `session`: watch FIRST, then the eager open; drop the old one's. */
  readonly watchSession: (
    session: SessionController | null,
    onOpened?: (ok: boolean) => void,
  ) => void;
  /** The ONE way the view moves to another session (`/clear`, `/sessions`, closed). */
  readonly swapSession: (
    next: SessionController,
    opts?: { readonly keepTranscript?: boolean; readonly onOpened?: (ok: boolean) => void },
  ) => void;
  /** A `/sessions` row: detach the old session, then open and swap to the new. */
  readonly switchTo: (id: string, reopen: boolean) => void;
}

export function useSessionLink(host: SessionLinkHost): SessionLinkLayer {
  // Destructured so the callbacks' deps name FIELDS, never the port (Fable H2).
  const {
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
    schedulesSubRef,
    notifySubRef,
    dockMsgSubRef,
    capsSubRef,
    onCapsChange,
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
    forgetArtifacts,
    joinCards,
    pushNotice,
    pushSeparator,
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
    setSchedules,
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
  } = host;

  // The ONE ref this hook creates: the `onActivity` <-> `swapSession` cycle, in
  // the declaration order the App always had (the handler is written first).
  const swapRef = useRef<
    | ((
        next: SessionController,
        opts?: { readonly keepTranscript?: boolean; readonly onOpened?: (ok: boolean) => void },
      ) => void)
    | null
  >(null);

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
        if (action === "separator") {
          // Another device compacted (owner Q6: the SAME rule as my own, never a
          // device-blaming notice). The figures come from the new history's
          // summary message: a legacy one gives `compacted` alone.
          pushSeparator(compactionSeparatorOf(activity.messages));
        } else if (action === "replace" || action === "append") {
          const apply = action === "append" ? appendHistory : resetHistory;
          // `joinCards` inside the compute: the repo's cards are attached BEFORE
          // the rows are warmed, so the screenshot-in-progress frame already has
          // them (S6a review finding 2). The commit's own tail joins again,
          // which is a no-op once the map is filled.
          void commitHistory((s) => apply(s, activity.messages)).then(() => {
            setScrollOffset(0);
            if (cleared) {
              // After the replace: it would wipe a notice pushed before it. This
              // TUI's own `/clear` said nothing at all under `connect` — the
              // cleared transcript just vanished (docs/fix/connect-functest-batch.md
              // item E); another device's clear already has its own words.
              pushNotice(ownClear ? CLEARED_NOTICE : CLEARED_ELSEWHERE_NOTICE);
            }
            flushNow();
            drainHeld();
            // The meter must follow a REPLACED history at once: its figure came
            // from the chat this clear just dropped, and waiting for the next
            // turn's usage left it stale on screen (docs/fix/connect-functest-batch.md
            // item E). The measured fill is forgotten, then the daemon is asked
            // to count what the session holds now.
            if (cleared || action === "replace") {
              stateRef.current = forgetContextFill(stateRef.current);
              askContext(sessionRef.current);
            }
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
      abortRef,
      askContext,
      clearingRef,
      commitHistory,
      drainHeld,
      exit,
      flushNow,
      heldRef,
      makeSession,
      ownClearsRef,
      ownCompactionsRef,
      pushNotice,
      pushSeparator,
      runQuit,
      sendNowRef,
      sessionRef,
      sessions,
      setExpandAll,
      setExpandedIds,
      setQuitConfirm,
      setScrollOffset,
      stateRef,
      stoppedHereRef,
      streamCtrlRef,
      streamTurn,
      wakeIfPending,
      warmingRef,
    ],
  );
  onActivityRef.current = onActivity;

  /**
   * Follow `session` (C9): its activities and the daemon's queue — watch
   * FIRST, then the eager open (a fresh session's is a no-op), so its first
   * history is never missed. The previous session's subscriptions end, and
   * what was held for it is dropped.
   */
  const watchSession = useCallback(
    (session: SessionController | null, onOpened?: (ok: boolean) => void) => {
      activitySubRef.current?.();
      queueSubRef.current?.();
      agentsSubRef.current?.();
      jobsSubRef.current?.();
      schedulesSubRef.current?.();
      notifySubRef.current?.();
      dockMsgSubRef.current?.();
      capsSubRef.current?.();
      heldRef.current = [];
      setDaemonQueue(undefined);
      setAgents(undefined);
      setJobs(undefined);
      setSchedules(undefined);
      jobOutputRef.current = {};
      // The dock belongs to a session: a switch starts it over (its drafts and
      // its `sent` are per session, docs/feat/subagent-panel.md).
      setDock(resetDock());
      // Its own skills (a remote session waits for its eager open first).
      skillsSync.use(session);
      // The context at open (never awaited by render): an answer for a session
      // the view has since left is dropped.
      setContextOpen(null);
      askContext(session);
      activitySubRef.current = session?.watch?.((a) => onActivityRef.current?.(a)) ?? null;
      queueSubRef.current = session?.onQueued?.((q) => setDaemonQueue(q)) ?? null;
      agentsSubRef.current = session?.onSubagents?.((rows) => setAgents(rows)) ?? null;
      jobsSubRef.current = session?.onJobs?.((report) => setJobs(report.rows)) ?? null;
      // The session's armed scheduled wakes (cron-tool S5): the SAME per-session
      // feed the dock and `/schedule` paint. `undefined` when this session has no
      // table to report (a pod, an older daemon), never an empty claim.
      schedulesSubRef.current =
        session?.onSchedules?.((report) => setSchedules(report.rows)) ?? null;
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
      // The USER's own message to a child (`session/subagent_message`): ONE live
      // notice — the daemon broadcasts it, so the sender's own TUI and every
      // other one agree — and the drawer keeps its last three as `you → sa-N`.
      dockMsgSubRef.current =
        session?.onSubagentMessage?.((m) => {
          stateRef.current = appendNotice(stateRef.current, userToSubagentNotice(m));
          setScrollOffset(0);
          flushNow();
          setDock((prev) => noteSent(prev, m.agentId, m.text, m.n));
        }) ?? null;
      // The session's MCP/skill switches (docs/feat/session-capabilities.md
      // S4): its current state at once (never news: no `by`), then every
      // snapshot and change the daemon reports.
      onCapsChange(session?.capabilities?.());
      capsSubRef.current = session?.onCapabilities?.((caps, by) => onCapsChange(caps, by)) ?? null;
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
    [
      activitySubRef,
      agentsSubRef,
      armWake,
      askContext,
      capsSubRef,
      dockMsgSubRef,
      flushNow,
      heldRef,
      jobOutputRef,
      jobsSubRef,
      schedulesSubRef,
      notifySubRef,
      onActivityRef,
      onCapsChange,
      pushNotice,
      queueSubRef,
      sessionRef,
      setAgents,
      setContextOpen,
      setDaemonQueue,
      setDock,
      setJobs,
      setSchedules,
      setScrollOffset,
      skillsSync,
      stateRef,
      // Every field the body reads is named here (Fable H2's rule 3): they are
      // all identity-stable — `useRef` objects, `useState` setters, `useCallback`s
      // whose own deps are stable — so naming them changes no callback's
      // identity and the mount effect does not re-subscribe. The pre-S9b arrays
      // named only the ones Biome could see through the App's own closures; the
      // ones below are the SAME fields, now destructured from a port.
      // The dock's own refs (S5) keep their comment: STABLE `useRef` objects.
      subagentsTwoWay,
    ],
  );

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
      // The NEW session's artifacts are not the old one's: forget what was
      // learned (a `callId` from another session must never attach a card here),
      // and re-join what the new transcript already holds — for a kept
      // transcript, and for whatever its eager open brings (S6a review finding 2).
      forgetArtifacts();
      // An open `/sessions` panel marks the live session as current, and must be
      // re-read at the next render: its "current" row is read live (Review R2-1,
      // R3-1). The rule is the `/sessions` kind's own (`panels/sessions.ts`).
      touchPanel();
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
      // Whatever the new view holds NOW is joined against the new session's list
      // (a kept transcript: its `present` rows have no card either). The history
      // its eager open brings joins at its own commit.
      stateRef.current = joinCards(stateRef.current);
      flushNow();
    },
    [
      clearAfterTurnRef,
      clearingRef,
      fallbackNoticedRef,
      flushNow,
      forgetArtifacts,
      handedWakeRef,
      joinCards,
      ownClearsRef,
      ownCompactionsRef,
      restoreInput,
      rowsRef,
      sendNowUnsupportedRef,
      sessionRef,
      setCompacting,
      setExpandAll,
      setExpandedIds,
      setRows,
      setScrollOffset,
      stateRef,
      touchPanel,
      wakeRef,
      watchReturned,
      watchSession,
    ],
  );
  swapRef.current = swapSession;

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
    [
      makeSession,
      pushNotice,
      sessionRef,
      sessions,
      swapSession,
      switchingRef,
      watchReturned,
      watchSession,
    ],
  );

  return { onActivity, watchSession, swapSession, switchTo };
}
