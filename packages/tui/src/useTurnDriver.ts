import { type AttachmentRef, DISMISSED, type WakeModel, wakeStep } from "@tentacle/core";
import type { DocumentContent } from "@tentacle/protocol";
/**
 * The TURN DRIVER (docs/feat/app-decomposition.md S9a): how one turn of the
 * session is started, streamed into the transcript, stopped, handed over to a
 * send-now and settled — plus the three things that ride on that loop: a
 * history commit (`commitHistory`, warm-chunked when long), the held-activity
 * drain (`drainHeld`), and `/compact`'s machinery (`startCompaction`, plan M5).
 *
 * Every DECISION stays where it was and stays pure: `planTurnStart`,
 * `planSendNow`, `planRefusal`, `afterOldTurn`, `afterCompactionUnsupported`,
 * `onCompactionSettled`, `onSuccessorError`, `compactionWaitNotice`,
 * `fallbackNotice` (`send-now.ts`); `submitPlan`, `enterConvertsToChips`,
 * `imageRowText`, `attachErrorText` (`attach-draft.ts`); `switchingRefusal`
 * (`sessions-panel.ts`); `handOff`/`onTurnEnd`/`addRow`/`markAcked`/`onReject`/
 * `onSteer`/`takeForSendNow`/`takeAll` (`queued.ts`); `needsWarm`/`lostSlot`/
 * `refusedBeforeStart`/`commitWarmed` (`turn-feed.ts`); `applySessionEvent`/
 * `startTurn`/`startContinuation`/`endWithoutOutcome`/`failTurn`/
 * `withdrawUserTurn` (`state.ts`); `pushHistory` (`history.ts`);
 * `modelErrorNotice` (`model-error.ts`). This hook is the executor for them,
 * owning only its own latches and the wiring (AGENTS §7).
 *
 * Three constraints from the plan shape the file:
 *
 * 1. **Effects stay in `App`** (Fable H1): this hook declares NO `useEffect`, so
 *    `App`'s 22 keep their order and every index (the original 20 + session-hop's
 *    2). The effects that DRIVE this code remain `App`'s — the initial prompt and
 *    the wake (`runRef`, `wakeIfPending`), the jobs subscription — and they reach
 *    the driver through the same identifiers they already used.
 * 2. **A shared latch is passed in, never re-created** (Fable M1/H3). Every ref
 *    below is ALSO read or written by a driver this slice does not own — the
 *    activity handler and `swapSession` (S9b), `useQuitClear`'s settle, the key
 *    snapshot (S3), the frame — so it arrives as a port field: each read site
 *    keeps its identifier and its SOURCE (a ref read stays a ref read, so two
 *    keys with no render between them behave exactly as on `main`). The refs
 *    created HERE are the ones nothing outside the driver touches:
 *    `streamTurnRef` (the `settleSendNow` ↔ `streamTurn` cycle), `ownedIdsRef`
 *    (the ids a send-now ever took) and `compactionOwnedRef` (`/compact`'s
 *    "a send-now took my rows").
 * 3. **A port field keeps its identity rule** (Fable H2): a stable setter stays
 *    one, a `useCallback` keeps its dep array, a ref stays THE same object, a
 *    prop stays a prop. The `useCallback`s below name their fields in deps —
 *    never `host` — so `useExhaustiveDependencies` keeps seeing each one; every
 *    such field is identity-stable, so no callback's identity changed and the
 *    watch effect does not re-subscribe (S0b's identity test still holds).
 */
import { type MutableRefObject, useCallback, useRef } from "react";
import type { HopProposalView, SessionController } from "./app-types.ts";
import type { AttachDraft, AttachMode } from "./attach-draft.ts";
import { attachErrorText, enterConvertsToChips, imageRowText, submitPlan } from "./attach-draft.ts";
import type { AttachedDocument, AttachedImage } from "./attach-files.ts";
import { pushHistory } from "./history.ts";
import type { LineEditor } from "./hooks.ts";
import type { HopNamespace, HopSpec } from "./hop-command.ts";
import { modelErrorNotice } from "./model-error.ts";
import type { DocumentMode } from "./pdf-attach.ts";
import { documentRowText } from "./pdf-attach.ts";
import type { PermissionController } from "./permission-ui.ts";
import {
  addRow,
  handOff,
  markAcked,
  onReject,
  onSteer,
  onTurnEnd,
  takeAll,
  takeForSendNow,
} from "./queued.ts";
import type { QueuedRows } from "./queued.ts";
import type { RenderOptions } from "./render-lines.ts";
import { warmRowsChunk } from "./render-lines.ts";
import { runChunked } from "./run-chunked.ts";
import {
  COMPACTING_NO_TURN,
  type CompactionResult,
  NOTHING_TO_SEND,
  afterCompactionUnsupported,
  afterOldTurn,
  compactionWaitNotice,
  fallbackNotice,
  onCompactionSettled,
  onSuccessorError,
  planRefusal,
  planSendNow,
  planTurnStart,
  withRestored,
} from "./send-now.ts";
import { switchingRefusal } from "./sessions-panel.ts";
import type { SkillsSync } from "./skills-sync.ts";
import {
  type DisplayItem,
  type DisplayState,
  type SessionEvent,
  applySessionEvent,
  endWithoutOutcome,
  failTurn,
  startContinuation,
  startHopWake,
  startTurn,
  withdrawUserTurn,
} from "./state.ts";
import type { SessionActivity } from "./turn-feed.ts";
import {
  SLOT_LOST_NOTICE,
  commitWarmed,
  lostSlot,
  needsWarm,
  refusedBeforeStart,
} from "./turn-feed.ts";

/**
 * `text` with the hop's pending line in front (review M7). The line is the laptop's
 * own (`[move declined]`, `[session moved to …]`) and becomes part of the USER
 * message, so the model reads it in the history rather than as a passing notice.
 */
export function hopWithLine(line: string, text: string): string {
  return line === "" ? text : `${line}\n\n${text}`;
}

/** A hop's view of one turn (docs/feat/session-hop.md D9, slice H5): report events, ask at the end. */
export interface HopTurnPort {
  /** One event of the turn, `own` telling an own turn from another device's. */
  event(event: SessionEvent, own: boolean): void;
  /** The turn is over: the host asks the owner and says what it means. */
  end(own: boolean): Promise<HopProposalView>;
  /**
   * The owner APPROVED a proposed move: the host hands the spec over, and the
   * App starts it exactly as a typed `/move` (one path to the view's move, D3).
   */
  approved(
    spec: HopSpec,
    opts?: {
      readonly gateAnswered?: true;
      readonly autoAccepted?: true;
      readonly namespace?: HopNamespace;
    },
  ): void;
  /**
   * Forget the pending fact: a `/clear` swaps the session, so a fact about the OLD
   * one (its place, its cwd) must not ride the new one's first prompt (OD6).
   */
  clearPending?(): void;
  /**
   * The line the model must read at the start of its next REAL prompt — `[move
   * declined]` after a refusal, `[session moved to …]` after a commit (review M7)
   * — CONSUMED by this read: it belongs to exactly one prompt, so it can neither
   * be lost nor repeated. `null` when there is nothing to say. `ctx.autoAccept` is
   * the TUI's LIVE mode, which a moved line states (docs/feat/session-hop-ux OD6).
   */
  takeLine(ctx: { readonly autoAccept: boolean }): string | null;
  /**
   * The prompt that consumed the line never ran (its send failed): put it back,
   * so the next real prompt carries it (docs/feat/session-hop-ux, failure mode
   * "Wake prompt fails to send"). Absent when the host cannot restore.
   */
  restoreLine?(): void;
  /** OD6: a real user prompt breaks the consecutive-wake chain. */
  onUserPrompt?(): void;
  /**
   * OD6: a MODEL's proposal settled without a spec to build (refused, or unaskable):
   * continue the session so the model reads the line, if the rule allows it.
   */
  wake?(outcome: "declined" | "failed"): void;
}

/**
 * What a streamed turn is (`streamTurn`).
 */
export interface StreamOpts {
  /** A send-now's new turn: the rows hand off on its first event. */ readonly successor?: boolean;
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
    /** The prompt's PDF rows (`[pdf: report.pdf]`), drawn after the image rows. */
    readonly documents?: readonly string[];
    /** The chips whose refs this prompt named: put back if the daemon refuses them. */
    readonly restoreChips?: readonly AttachedImage[];
    /** The PDF chips this prompt attached (docs/feat/pdf-read.md D6), for the same restore. */
    readonly restoreDocuments?: readonly AttachedDocument[];
    /**
     * This prompt consumed the hop's pending line (`hopTurn.takeLine`), so a
     * failure that means it never ran must hand the line back (docs/feat/
     * session-hop-ux, failure mode "Wake prompt fails to send"): the next real
     * prompt carries it, and the model still learns where the session is.
     */
    readonly hopLine?: true;
  };
}

/**
 * A send-now in progress (docs/feat/send-now-c.md). `atomic`: the request is
 * out, or its new turn waits for the old turn's end. `fallback` (an older
 * daemon, or no `sendNow`): what is left of the rows is sent once the old turn
 * ends.
 */
export interface PendingSendNow {
  mode: "atomic" | "fallback";
  /** The new turn's controller (`atomic`): Esc in the window cancels through it. */
  readonly next: AbortController | null;
  /** The new turn's events, once acknowledged. */
  successor: AsyncIterable<SessionEvent> | null;
  /** A resync replaced the transcript since the chord (read by the fallback only). */
  resetSeen: boolean;
}

/** One turn of my own: `App`'s `runRef` type and the command port's `run`. */
export type RunTurn = (
  text: string,
  opts?: {
    continuation?: boolean;
    skill?: string;
    fallback?: boolean;
    /** The prompt's image refs (already uploaded: docs/feat/attachments-tui.md D8). */
    attachments?: readonly AttachmentRef[];
    /** The chips whose refs those are: their `[image: …]` rows and a restore. */
    images?: readonly AttachedImage[];
  },
) => Promise<void>;

/**
 * `App`'s own `runRef` shape — `run` as everyone OUTSIDE the driver names it.
 * `run` really returns a Promise (the turn is awaited by the compaction's settle
 * and by `submit`); the hosts that only fire it do not care, exactly as before.
 */
export type RunRef = (
  text: string,
  opts?: {
    continuation?: boolean;
    fallback?: boolean;
    skill?: string;
    attachments?: readonly AttachmentRef[];
    images?: readonly AttachedImage[];
  },
) => void;

/**
 * The narrow port the turn driver executes through: `App`'s own state, setters,
 * refs and callbacks, plus the executors of neighbouring slices a turn hands off
 * to (`attachMode`/`convertToChips`/`sendWithImages` from S6's
 * `useAttachments`, `submitToTarget` from S5's `useDock`). A port FIELD keeps
 * its current identity rule (Fable H2); the callbacks below destructure the
 * fields and name them in deps, never `host`.
 */
export interface TurnHost {
  // --- the session and the display state (shared with every other driver)
  readonly sessionRef: MutableRefObject<SessionController | null>;
  readonly stateRef: MutableRefObject<DisplayState>;
  /** The queued/steering rows: the ref is the truth, `setRows` renders it. */
  readonly rowsRef: MutableRefObject<QueuedRows>;
  readonly setRows: (f: (rows: QueuedRows) => QueuedRows) => void;
  /** A warmed commit's progress label (the frame reads `loading`). */
  readonly setLoading: (next: { done: number; total: number } | null) => void;
  /** A warmed commit is in flight: the frame, the drain and the send-now read it. */
  readonly warmingRef: MutableRefObject<boolean>;
  readonly layoutOptsRef: MutableRefObject<RenderOptions>;

  // --- the turn's controllers and latches (all shared — see the header)
  readonly abortRef: MutableRefObject<AbortController | null>;
  readonly streamCtrlRef: MutableRefObject<AbortController | null>;
  readonly foreignRef: MutableRefObject<AbortController | null>;
  readonly sendNowRef: MutableRefObject<PendingSendNow | null>;
  readonly sendNowUnsupportedRef: MutableRefObject<boolean>;
  /** The fallback's notice, once per session (`swapSession` resets it). */
  readonly fallbackNoticedRef: MutableRefObject<boolean>;
  /** The wake model: bumped at a turn's start, deferred while busy. */
  readonly wakeRef: MutableRefObject<WakeModel>;
  readonly handedWakeRef: MutableRefObject<boolean>;
  /** This TUI stopped the current turn itself (`handBackRows`' notice). */
  readonly stoppedHereRef: MutableRefObject<boolean>;
  /** Ids whose `restore` the view already took (`watchReturned`, `swapSession`). */
  readonly restoredRef: MutableRefObject<Set<string>>;
  /** Activities held while a run of mine streamed (`onActivity` pushes them). */
  readonly heldRef: MutableRefObject<SessionActivity[]>;
  /** The activity handler, read through a ref (it starts the foreign streams). */
  readonly onActivityRef: MutableRefObject<((activity: SessionActivity) => void) | null>;
  /** A quit asked for mid-turn: the settle exits (also read by the key snapshot). */
  readonly exitPendingRef: MutableRefObject<boolean>;
  /** `/clear`'s latch and its post-turn hand-off (the activity effect reads both). */
  readonly clearingRef: MutableRefObject<boolean>;
  readonly clearAfterTurnRef: MutableRefObject<boolean>;
  /** The clear the settle runs, through a ref (`useQuitClear` owns the callback). */
  readonly runClearRef: MutableRefObject<(() => void) | null>;
  /** `/compact`'s latch and this TUI's own-compaction count (both shared). */
  readonly compactingRef: MutableRefObject<boolean>;
  readonly ownCompactionsRef: MutableRefObject<number>;
  /** Set the compaction flag: the latch and the state the frame renders together. */
  readonly setCompacting: (on: boolean) => void;

  // --- the input line and the prompt history (`submit` writes them)
  readonly field: LineEditor;
  readonly historyRef: MutableRefObject<string[]>;
  readonly histIndexRef: MutableRefObject<number>;
  readonly draftRef: MutableRefObject<string>;
  /** The last prompt (and whether it named images): `/retry` re-sends it. */
  readonly lastUserRef: MutableRefObject<string | null>;
  readonly lastHadImagesRef: MutableRefObject<boolean>;
  /** A `/sessions` switch is in flight: a prompt goes back to the input. */
  readonly switchingRef: MutableRefObject<boolean>;
  /** The draft's chips and the probed drop `submit` decides on. */
  readonly attachRef: MutableRefObject<AttachDraft>;
  readonly probedTextRef: MutableRefObject<string | null>;
  /** The laptop's home, for `~` in a dropped path. */
  readonly home: string | undefined;

  // --- painting and the notice sink
  readonly flushNow: () => void;
  /** A new turn starts at the bottom of the transcript. */
  readonly setScrollOffset: (offset: number) => void;
  readonly scheduleFlush: () => void;
  /** `level: "warn"` marks a harness line the person should notice (docs/feat/harness-notices.md S2). */
  readonly pushNotice: (text: string, level?: "warn") => void;
  readonly restoreInput: (text: string, why: string) => void;

  // --- the neighbours a turn hands off to
  /**
   * `/…` text: the command layer (S2) decides, this only routes to it. Through
   * the ref `App` already keeps for it, because the command port needs this
   * driver's `run`/`startCompaction` and the driver needs the router — the cycle
   * the App resolves with the same late binding it used before (plan H3).
   */
  readonly handleCommandRef: MutableRefObject<((raw: string, again?: boolean) => void) | null>;
  readonly permission: PermissionController;
  readonly attachMode: () => AttachMode;
  readonly convertToChips: (text: string) => void;
  readonly sendWithImages: (
    text: string,
    chips: readonly AttachedImage[],
    documents?: readonly AttachedDocument[],
  ) => void;
  readonly submitToTarget: (value: string) => boolean;
  readonly restoreChips: (chips: readonly AttachedImage[] | undefined) => void;
  /** What the session takes as a PDF (docs/feat/pdf-read.md D6): `submitPlan` reads it. */
  readonly documentMode: () => DocumentMode;
  /** A refused PDF prompt's chips come back with its text (the `restoreChips` rule). */
  readonly restoreDocuments: (documents: readonly AttachedDocument[] | undefined) => void;
  /**
   * A hop's view of this TUI's turns (docs/feat/session-hop.md D9, slice H5): the
   * host folds each OWN turn's events for a `move_session` proposal and asks the
   * owner at the turn's end. Absent where no `hop` prop is (D8's other origins).
   */
  readonly hopTurn?: HopTurnPort;
  /** The model name the error hint reads (`remote` means the daemon's model). */
  readonly model: string;
  /** A `context_reset` re-reads the skills (`skills-sync.ts`'s one settle). */
  readonly skillsSync: SkillsSync;
  /**
   * A history that just replaced (or appended to) the transcript, with the
   * cards this TUI already knows attached (S6a review finding 2). A rebuild
   * from `ChatMessage`s carries no `present` detail, so the App's
   * `ArtifactJoin` supplies it — and asks the daemon when it cannot.
   */
  readonly joinCards: (state: DisplayState) => DisplayState;
  /** Ask the daemon for the context figure (never awaited by render). */
  readonly askContext: (session: SessionController | null) => void;
  /** Fire a deferred autonomous wake (idle-gated; the settle asks again). */
  readonly wakeIfPending: () => void;
  /** Quit the TUI (Ink's `useApp().exit`): a mid-turn quit exits from the settle. */
  readonly exit: () => void;
  /**
   * `run`, through a ref: `App`'s jobs subscription and its two effects use it,
   * and it is the widest of the forms (`=> void`, as the TUI has always declared
   * it), so this hook's Promise-returning `run` is assignable to it unchanged.
   */
  readonly runRef: MutableRefObject<RunRef | null>;
}

/** What `App` names from the turn driver. The identifiers are the pre-S9a ones. */
export interface TurnLayer {
  /** Start one turn of my own (Enter, a wake, a compaction's queue, `/retry`). */
  readonly run: RunTurn;
  /** A history replacing the transcript, warm-chunked when it is long. */
  readonly commitHistory: (compute: (state: DisplayState) => DisplayState) => Promise<void>;
  /** Stream one turn's events (own, a send-now's successor, another device's). */
  readonly streamTurn: (
    open: () => AsyncIterable<SessionEvent>,
    controller: AbortController,
    opts: StreamOpts,
  ) => Promise<void>;
  /** `Ctrl+X Ctrl+S`: send my queued rows now. False: nothing to do. */
  readonly sendNow: () => boolean;
  /** Enter on the input line: the dock's text, a prompt, a `/command`, a queue. */
  readonly submit: (value: string) => void;
  /** `/compact`'s machinery: the reset's open, the compaction, its one settle. */
  readonly startCompaction: () => void;
  /** Activities held while a run of mine streamed, handled in order once idle. */
  readonly drainHeld: () => void;
}

export function useTurnDriver(host: TurnHost): TurnLayer {
  // Destructured so the callbacks' deps name FIELDS, never the port (Fable H2).
  const {
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
    documentMode,
    restoreDocuments,
    model,
    skillsSync,
    joinCards,
    askContext,
    wakeIfPending,
    exit,
    runRef,
    hopTurn,
  } = host;

  // The ids a send-now ever took: a late enqueue refusal of one says nothing.
  // READ by `submit` only, so it is the driver's own (nothing outside writes it).
  const ownedIdsRef = useRef(new Set<string>());
  // A send-now of ours took the compaction's rows: its settle must not send them.
  const compactionOwnedRef = useRef(false);
  /** No turn streams any more: show the TUI idle (a send-now kept it running). */
  const showIdle = useCallback(() => {
    if (stateRef.current.running && !streamCtrlRef.current) {
      stateRef.current = applySessionEvent(
        stateRef.current,
        { type: "turn_end", reason: "cancelled" },
        Date.now(),
      );
    }
  }, [stateRef, streamCtrlRef]);

  /** The fallback's notice, once per App (it does not repeat on later chords). */
  const noticeFallback = useCallback(() => {
    if (!fallbackNoticedRef.current) {
      fallbackNoticedRef.current = true;
      pushNotice(fallbackNotice());
    }
  }, [fallbackNoticedRef, pushNotice]);

  // `streamTurn`, through a ref: it and `settleSendNow` call each other.
  const streamTurnRef = useRef<
    | ((
        open: () => AsyncIterable<SessionEvent>,
        controller: AbortController,
        opts: StreamOpts,
      ) => Promise<void>)
    | null
  >(null);

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
    // Every name here is a STABLE object (a `useRef`), so naming them keeps this
    // callback's identity (Fable H2) — the verbatim `[]` hid the reads from
    // `useExhaustiveDependencies`, and a re-created ref is the bug it hunts.
  }, [heldRef, onActivityRef, sendNowRef, streamCtrlRef, warmingRef]);

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
      stateRef.current = joinCards({
        ...next,
        items: commitWarmed(before, stateRef.current.items, next.items),
        running: stateRef.current.running,
      });
    },
    [joinCards, layoutOptsRef, setLoading, stateRef, warmingRef],
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
    [restoreInput, rowsRef, runRef, sendNowRef, setRows, stateRef, wakeRef],
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
          // A hop's proposal is watched HERE (docs/feat/session-hop.md D9, slice
          // H5): the host folds the events of THIS TUI's own turn (`own`, never a
          // foreign one — its owner is asked on their own terminal) and asks at the
          // turn's end. Nothing is decided in this component.
          hopTurn?.event(event, opts.own !== undefined && opts.foreign !== true);
          if (!handedOff && event.type !== "unsupported") {
            handedOff = true;
            setRows(handOff); // the sent texts are its prompt now
          }
          if (event.type === "history_reset" && needsWarm(event.messages.length)) {
            await commitHistory((s) => applySessionEvent(s, event, Date.now()));
          } else if (event.type === "history_reset" || event.type === "context_reset") {
            // A resync's replace — and a context reset's APPENDED history —
            // rebuilds rows from `ChatMessage`s: the cards this TUI knows are
            // re-attached (S6a review finding 2). Gated on these two events so
            // the streaming hot path pays nothing.
            stateRef.current = joinCards(applySessionEvent(stateRef.current, event, Date.now()));
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
        // A prompt that never RAN must not burn the hop's line (docs/feat/
        // session-hop-ux, failure mode "Wake prompt fails to send"): its text —
        // the moved/declined/failed line included — never reached the daemon, so
        // the line goes back and the next real prompt carries it, exactly as
        // `restoreChips` gives an image prompt its images back. A turn that DID
        // stream carried the line inside its user message, so nothing is restored
        // then: it was delivered, and saying it twice would be a lie.
        if (opts.own?.hopLine === true && !streamed) {
          hopTurn?.restoreLine?.();
        }
        if (opts.own && lostSlot(error, streamed)) {
          // Another device's turn took the slot first: my prompt never ran.
          // Its bubble goes and its text is back in the input — never lost
          // (decision 15); the held foreign turn renders once this settles.
          stateRef.current = withdrawUserTurn(stateRef.current, opts.own.item);
          // An image-only prompt has no text but IS a prompt, not a wake (P10).
          if (opts.own.text !== "" || (opts.own.images?.length ?? 0) > 0) {
            restoreInput(opts.own.text, SLOT_LOST_NOTICE);
            restoreChips(opts.own.restoreChips);
            restoreDocuments(opts.own.restoreDocuments);
          } else if (handedWakeRef.current) {
            // Once: `wakeIfPending` below fires it when the turn that won ends.
            handedWakeRef.current = false;
            wakeRef.current = wakeStep(wakeRef.current, { type: "refused" });
          }
        } else if (opts.own && refusedBeforeStart(error, streamed)) {
          // The daemon refused these images BEFORE the turn started
          // (docs/feat/attachments-tui.md D8): the bubble goes, the text is back
          // in the input and the chips with it, and the reason is said —
          // Enter uploads and tries again (the put is idempotent).
          stateRef.current = withdrawUserTurn(stateRef.current, opts.own.item);
          abortRef.current = null;
          restoreInput(opts.own.text, attachErrorText(error));
          restoreChips(opts.own.restoreChips);
          restoreDocuments(opts.own.restoreDocuments);
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
          stateRef.current = failTurn(
            stateRef.current,
            modelErrorNotice(error, model === "remote"),
            Date.now(),
          );
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
          // The model proposed a move and this turn is now over: the owner is
          // asked, ONCE, through the single broker (D9/H5). A yes arrives as an
          // approved spec; the App starts it exactly as a typed `/move` (one path
          // to the view's move, D3). Never awaited by the frame: the ask can wait
          // on a human. A refusal keeps the `[move declined]` line for the next
          // prompt (M7), which `takeLine` hands over.
          if (opts.own !== undefined && opts.foreign !== true) {
            void hopTurn?.end(true).then(
              (outcome) => {
                if (outcome.kind === "approved") {
                  // OD3: the pin's provenance rides the SAME hand-over as the
                  // gate's answer, so the build states WHY that namespace
                  // instead of re-resolving it (`explicit`, fix round 2).
                  const opts = {
                    ...(outcome.gateAnswered === true ? { gateAnswered: true as const } : {}),
                    ...(outcome.autoAccepted === true ? { autoAccepted: true as const } : {}),
                    ...(outcome.namespace === undefined ? {} : { namespace: outcome.namespace }),
                  };
                  hopTurn.approved(outcome.spec, Object.keys(opts).length === 0 ? undefined : opts);
                  return;
                }
                // OD6: a refusal, or a move that could not even be asked about,
                // leaves a line for the model — and a MODEL's proposal is one of
                // the origins allowed to continue the session by itself, so it is
                // woken to read it (`hopWakeStep` decides; the App fires).
                if (outcome.kind === "declined" || outcome.kind === "failed") {
                  hopTurn.wake?.(outcome.kind);
                }
              },
              () => {
                // A host that rejected is a host bug: the turn is over either
                // way, and nothing moved (the broker's own refusal path is the
                // one that answers a human).
              },
            );
          }
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
      abortRef,
      clearAfterTurnRef,
      clearingRef,
      commitHistory,
      drainHeld,
      exit,
      exitPendingRef,
      flushNow,
      foreignRef,
      handedWakeRef,
      joinCards,
      model,
      pushNotice,
      restoreChips,
      restoreDocuments,
      restoreInput,
      restoredRef,
      rowsRef,
      runClearRef,
      scheduleFlush,
      sendNowRef,
      setRows,
      settleSendNow,
      skillsSync,
      stateRef,
      streamCtrlRef,
      wakeIfPending,
      wakeRef,
      hopTurn,
    ],
  );
  streamTurnRef.current = streamTurn;

  const run = useCallback(
    async (
      text: string,
      opts?: {
        continuation?: boolean;
        skill?: string;
        fallback?: boolean;
        /** The prompt's image refs (already uploaded: docs/feat/attachments-tui.md D8). */
        attachments?: readonly AttachmentRef[];
        /** The chips whose refs those are: their `[image: …]` rows and a restore. */
        images?: readonly AttachedImage[];
        /**
         * The prompt's attached PDFs, already wire blocks (docs/feat/pdf-read.md
         * D6): `attachDocument` built each one, so this driver never decides where
         * an extraction happens.
         */
        documents?: readonly DocumentContent[];
        /** The PDF chips whose blocks those are: their `[pdf: …]` rows and a restore. */
        documentChips?: readonly AttachedDocument[];
        /**
         * docs/feat/session-hop-ux OD6: the turn is a hop's OWN wake — it carries
         * the pending hop line and paints the dim `↻ continuing after the move` row
         * instead of a user bubble, so the frame says why a turn started by itself.
         */
        hopWake?: boolean;
      },
    ) => {
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
      // OD6: a hop's wake is a REAL prompt (it carries the hop line, and it is saved
      // as conversation) that shows NO user bubble — the dim row below says why a
      // turn started by itself. It is not a continuation: a continuation takes no
      // hop line at all, and this one exists to carry one.
      const hopWake = opts?.hopWake === true;
      const noBubble = continuation || hopWake;
      if (!noBubble) {
        lastUserRef.current = text;
        lastHadImagesRef.current = (opts?.images?.length ?? 0) > 0;
        // OD6: a typed prompt breaks the wake chain (HOP_WAKE_CHAIN_MAX counts
        // CONSECUTIVE self-continues, so one user word starts the count over).
        hopTurn?.onUserPrompt?.();
      }
      const images = (opts?.images ?? []).map((chip) => imageRowText(chip.ref));
      // The PDF rows (docs/feat/pdf-read.md D5): the page count is the DAEMON's
      // fact — the client never saw it on this turn (it extracted server-side, or
      // this laptop did and kept only the block) — so the row says the name.
      const documentRows = (opts?.documentChips ?? []).map((chip) => documentRowText(chip.name));
      const controller = new AbortController();
      abortRef.current = controller;
      stoppedHereRef.current = false;
      stateRef.current = continuation
        ? startContinuation(stateRef.current, Date.now())
        : hopWake
          ? startHopWake(stateRef.current, Date.now())
          : startTurn(
              stateRef.current,
              text,
              Date.now(),
              images.length > 0 ? images : undefined,
              documentRows.length > 0 ? documentRows : undefined,
            );
      setScrollOffset(0);
      flushNow();
      // The bubble `startTurn` appended (none for a continuation): withdrawn by
      // identity if the prompt loses the slot (C3).
      const item = noBubble ? undefined : stateRef.current.items.at(-1);
      // The one line the model reads at the start of a real prompt (M7): CONSUMED,
      // so it is neither lost nor repeated. A continuation prompt takes none. The
      // mode is the TUI's LIVE one (OD6), so a moved line never states a stale
      // `auto-accept on|off`.
      const line = continuation
        ? ""
        : (hopTurn?.takeLine({ autoAccept: permission.autoApprove }) ?? "");
      const sendOpts = {
        ...(opts?.skill !== undefined ? { skill: opts.skill } : {}),
        ...(opts?.attachments !== undefined && opts.attachments.length > 0
          ? { attachments: opts.attachments }
          : {}),
        ...(opts?.documents !== undefined && opts.documents.length > 0
          ? { documents: opts.documents }
          : {}),
      };
      await streamTurn(
        () =>
          session.send(
            // A REAL prompt (not a continuation) carries the pending hop line:
            // `[move declined]`, or `[session moved to …]` (review M7). It is part
            // of the user message, so it is saved as conversation. Taken ONCE.
            continuation ? "" : hopWithLine(line, text),
            controller.signal,
            Object.keys(sendOpts).length > 0 ? sendOpts : undefined,
          ),
        controller,
        {
          own: {
            item,
            text: continuation ? "" : text,
            ...(images.length > 0 ? { images } : {}),
            ...(documentRows.length > 0 ? { documents: documentRows } : {}),
            ...(opts?.images !== undefined && opts.images.length > 0
              ? { restoreChips: opts.images }
              : {}),
            ...(opts?.documentChips !== undefined && opts.documentChips.length > 0
              ? { restoreDocuments: opts.documentChips }
              : {}),
            // A line was CONSUMED for this prompt: if it never runs, it must go
            // back (see the driver's catch) rather than die with the send.
            ...(line === "" ? {} : { hopLine: true as const }),
          },
        },
      );
    },
    [
      abortRef,
      compactingRef,
      flushNow,
      lastHadImagesRef,
      lastUserRef,
      pushNotice,
      sessionRef,
      setScrollOffset,
      stateRef,
      stoppedHereRef,
      streamTurn,
      wakeRef,
      hopTurn,
      // OD6: the hop's wake line states the auto-accept mode, so `run` must be
      // rebuilt when the mode changes (`permission` is the render's live object).
      permission,
    ],
  );
  // NOTE: `App` installs this into its own `runRef` right after the hook returns
  // (the ref is the App's: its jobs subscription and two effects read it). The
  // driver only READS that ref (`settleSendNow`'s fallback send), so it does not
  // write it — one writer, as on `main`.

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
      latchedUnsupported: sendNowUnsupportedRef.current,
    });
    if (plan.kind === "none" || !ctrl) {
      return false;
    }
    if (plan.kind === "wait") {
      // No way to cancel the compaction: the rows stay, its end sends them.
      pushNotice(compactionWaitNotice());
      return true;
    }
    const taken = takeForSendNow(rowsRef.current);
    setRows(() => taken.rows);
    for (const m of taken.messages) {
      ownedIdsRef.current.add(m.id);
    }
    if (plan.kind === "fallback") {
      // The fallback stops the turn itself, for sure: like Ctrl+C, dismissed
      // (not denied) — the turn's cancel settles the ask.
      if (permission.pending) {
        permission.answer(DISMISSED);
      }
      sendNowRef.current = { mode: "fallback", next: null, successor: null, resetSeen: false };
      noticeFallback();
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
          pushNotice(compactionWaitNotice());
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
        noticeFallback();
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
    abortRef,
    compactingRef,
    drainHeld,
    flushNow,
    noticeFallback,
    permission.answer,
    permission.pending,
    pushNotice,
    restoreInput,
    rowsRef,
    runRef,
    sendNowRef,
    sendNowUnsupportedRef,
    sessionRef,
    setRows,
    settleSendNow,
    showIdle,
    stateRef,
    stoppedHereRef,
    streamCtrlRef,
    wakeIfPending,
    wakeRef,
  ]);

  /**
   * `/compact`'s machinery (docs/feat/app-decomposition.md M5): the
   * compaction's own refs, its one settle, and the compaction-time queue it
   * ends live HERE, not in a command file — its guards do (`commands/compact.ts`).
   * It moves with S9a (the turn driver), which is why it is an App-level
   * function and not a command's body.
   */
  const startCompaction = useCallback((): void => {
    const session = sessionRef.current;
    if (!session) {
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
      pushNotice(out.notice, out.level);
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
  }, [
    askContext,
    ownCompactionsRef,
    pushNotice,
    restoreInput,
    rowsRef,
    run,
    sessionRef,
    setCompacting,
    setRows,
    stateRef,
    wakeIfPending,
    wakeRef,
  ]);

  const submit = useCallback(
    (value: string) => {
      // The dock may own this text (a child open): it decides, we execute.
      if (submitToTarget(value)) {
        return;
      }
      const text = value.trim();
      // A probed drop is a PATH, never a command: `looksLikeCommand` already said
      // so before the disk was read, so the coarse `/`-prefix branch below must
      // not turn it into "Unknown command" (round 2, R2-1).
      const probedText = probedTextRef.current;
      const isProbedDrop = probedText !== null && probedText === text;
      if (probedText !== text) {
        probedTextRef.current = null; // an edited (or cleared) drop is a new drop
      }
      // Enter WITH images is decided before the field is reset: a refusal must
      // leave the text where it is (docs/feat/attachments-tui.md D8), and an
      // image-only prompt ("") is a real submit.
      const plan = submitPlan({
        text,
        draft: attachRef.current,
        running: stateRef.current.running,
        compacting: compactingRef.current,
        dockOpen: false, // `submitToTarget` already took a child-owned text
        mode: attachMode(),
        documentMode: documentMode(),
        onlyPaths: enterConvertsToChips(text, probedText, home !== undefined ? { home } : {}),
      });
      if (plan.kind === "refuse") {
        pushNotice(plan.notice);
        return;
      }
      // The notice promised exactly ONE Enter; this is it (a refusal above keeps
      // it, since the text stayed put). Round 2, R2-1.
      probedTextRef.current = null;
      if (plan.kind === "send") {
        field.reset();
        historyRef.current = pushHistory(historyRef.current, plan.text);
        histIndexRef.current = historyRef.current.length;
        draftRef.current = "";
        const refusedPrompt = switchingRefusal(switchingRef.current, { kind: "prompt" });
        if (refusedPrompt) {
          restoreInput(plan.text, refusedPrompt);
          return;
        }
        sendWithImages(plan.text, plan.images, plan.documents);
        return;
      }
      if (plan.kind === "convert") {
        // An unbracketed drop: the paths become chips and NOTHING is sent (decision 5).
        field.reset();
        convertToChips(text);
        return;
      }
      field.reset();
      if (text === "") {
        return;
      }
      if (text.startsWith("/") && !isProbedDrop) {
        handleCommandRef.current?.(text);
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
    [
      attachMode,
      attachRef,
      compactingRef,
      convertToChips,
      documentMode,
      draftRef,
      // `field.reset`, not `field`: the line editor's object is re-made every
      // render, its `reset` is a stable `useCallback` — the dep array `main` had,
      // so `submit`'s identity is unchanged by the move (Fable H2).
      field.reset,
      handleCommandRef,
      histIndexRef,
      historyRef,
      home,
      probedTextRef,
      pushNotice,
      restoreInput,
      rowsRef,
      run,
      sendWithImages,
      sessionRef,
      setRows,
      stateRef,
      submitToTarget,
      switchingRef,
    ],
  );

  // The identifiers `App` names are the pre-S9a ones (Fable M1): every use site
  // above and below this call is unchanged.
  return { run, commitHistory, streamTurn, sendNow, submit, startCompaction, drainHeld };
}
