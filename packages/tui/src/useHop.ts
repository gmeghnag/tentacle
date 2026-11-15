/**
 * `/move`'s executor (docs/feat/app-decomposition.md S11): the three drivers that
 * run one hop, and the state they own —
 *
 * - `startHop` — start one spec through the host's feed, raise the switching
 *   latch, paint the phase row, and settle the ONE thing a hop changes about the
 *   view: swap the controller with `keepTranscript` (the transcript rows must
 *   land exactly where they were; only the badge and one notice differ).
 * - `requestHop` — a typed `/move`: the grammar (`parseHopCommand`), the turn
 *   boundary (`hopStep`), then start it now or leave it for the first idle (D4).
 * - `hopIfQueued` — the queued hop, re-checked at that idle (`hopReady`).
 *
 * Every DECISION stays where it was and stays pure (AGENTS §7): `parseHopCommand`
 * and `hopStep`/`hopReady` (`hop-command.ts`), `hopStatusRow`/`hopMovedNotice`/
 * `hopFailureText`/`hopPlaceText` (`hop-status.ts`). This hook is the executor for
 * them and owns nothing but the wiring — the same shape as `useQuitClear` (S8)
 * and `useDock` (S5).
 *
 * Two rules from the plan shape the file:
 *
 * 1. **No effect.** The queued hop starts from App's idle effect (1-based #20,
 *    0-based 19): its deps are App's RENDER values (`hopQueued`, the turn's
 *    `running`, the shown rows' length), so it cannot move without changing which
 *    render starts a hop (Fable H1). This hook declares no `useEffect` and hands
 *    `hopIfQueuedRef` back for that effect to read — the late binding is what
 *    keeps the effect's dep list honest (it names values, never this callback).
 * 2. **One state, one owner.** `hopRun`/`hopQueued` and their refs live here and
 *    nowhere else: the ref is what a command reads synchronously (two `/move`s
 *    with no render between them must see the first one's decision, Fable H3),
 *    the state is what the frame paints. A copy left in `App` is precisely the
 *    drift this slice exists to remove.
 *
 * `startHopRef` stays App's, because App's `hopTurnPort` (the D9 adapter the turn
 * driver reads) is declared ABOVE this hook and forwards an approved proposal
 * through it. The hook assigns it — the same render-time ref write
 * `useSessionLink` does for `swapRef`, and what App itself did inline before.
 */
import { type MutableRefObject, useCallback, useRef, useState } from "react";
import type { HopFeed, HopPlaceView, SessionController } from "./app-types.ts";
import {
  HOP_QUEUED_NOTICE,
  type HopSpec,
  hopReady,
  hopStep,
  parseHopCommand,
} from "./hop-command.ts";
import { hopFailureText, hopMovedNotice, hopPlaceText, noticeText } from "./hop-status.ts";
import {
  HOP_WAKE_CHAIN_MAX,
  HOP_WAKE_PAUSED_NOTICE,
  HOP_WAKE_ROW,
  type HopOrigin,
  hopWakeStep,
} from "./hop-wake.ts";
import type { PermissionController } from "./permission-ui.ts";
import type { DaemonQueue, QueuedRows } from "./queued.ts";
import { shownRows } from "./queued.ts";
import type { DisplayState } from "./state.ts";

/** `swapSession`, as this hook needs it (`App`'s own signature, unchanged). */
export type HopSwap = (
  next: SessionController,
  opts?: { readonly keepTranscript?: boolean; readonly onOpened?: (ok: boolean) => void },
) => void;

/**
 * The narrow port a hop executes through: the App's own state, setters, refs and
 * callbacks. A port FIELD keeps its current identity rule (Fable H2) — a
 * `useCallback` keeps its dep array, a prop keeps being a prop, a `useRef` object
 * stays THE same object — and the callbacks below destructure the fields and name
 * them in deps, never `host`. Each ref is PASSED IN, never re-created here, so
 * every read keeps both its identifier and its source (Fable M1/H3: a ref read
 * stays a ref read, so two keys with no render between them behave as today).
 */
export interface HopHost {
  /** The live session (the uid a hop seeds) and the display state it reads. */
  readonly sessionRef: MutableRefObject<SessionController | null>;
  readonly stateRef: MutableRefObject<DisplayState>;
  /** The queue, for the turn boundary (`hopReady`'s `queued`). */
  readonly rowsRef: MutableRefObject<QueuedRows>;
  readonly daemonQueueRef: MutableRefObject<DaemonQueue | undefined>;
  /** The switching latch: up for the whole hop, so a typed prompt goes back to the input. */
  readonly switchingRef: MutableRefObject<boolean>;
  /**
   * The forward reference an approved PROPOSAL starts through (`hopTurnPort`):
   * App declares it above this hook, and this hook assigns it.
   */
  readonly startHopRef: MutableRefObject<
    ((spec: HopSpec, opts?: { gateAnswered?: true; autoAccepted?: true }) => void) | null
  >;
  /**
   * OD6: the ONE way a turn starts without typing (`run`, the driver's), used to
   * wake the model after a hop. Absent (a host with no driver, a test) ⇒ no wake.
   */
  readonly sendWake?: (text: string) => void;
  /**
   * OD6: assigned here for `hopTurnPort.wake` — a MODEL's proposal that ended with
   * no spec to build (refused, or unaskable) still continues the session. A ref,
   * because the port is declared ABOVE this hook.
   */
  readonly wakeAfterHopRef: MutableRefObject<((outcome: "declined" | "failed") => void) | null>;
  /** The host's feed; ABSENT where a hop is not offered at all (D8). */
  readonly hop: HopFeed | undefined;
  readonly permission: PermissionController;
  readonly swapSession: HopSwap;
  readonly pushNotice: (text: string) => void;
  readonly flushNow: () => void;
}

/** What `App` names from the hop. */
export interface HopLayer {
  /** The hop running NOW (its phase row is STATE): `null` when none runs. */
  readonly hopRun: { readonly target: string; readonly phase: string | null } | null;
  /**
   * A `/move` waiting for the turn boundary (D4). STATE, because App's idle effect
   * re-runs when it changes; the hook's own ref is what a command reads.
   */
  readonly hopQueued: HopSpec | null;
  /** The queued driver, read by App's idle effect (a ref: no dependency cycle). */
  readonly hopIfQueuedRef: MutableRefObject<(() => void) | null>;
  /** `/move …`: the grammar, the boundary, then start it or leave it queued. */
  readonly requestHop: (raw: string) => void;
  /**
   * OD6: the next hop starts from a MODEL's proposal (set by `hopTurnPort.approved`
   * just before it calls `startHopRef`). A ref, because `startHop`'s identity must
   * not change under the port that holds it.
   */
  readonly hopOriginRef: MutableRefObject<HopOrigin>;
  /** OD6: a real user prompt breaks the wake chain (`HOP_WAKE_CHAIN_MAX`). */
  readonly noteUserPrompt: () => void;
}

export function useHop(host: HopHost): HopLayer {
  // Destructured so the callbacks' deps name FIELDS, never the port (Fable H2).
  const {
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
    sendWake,
    wakeAfterHopRef,
  } = host;

  // The hop running NOW (its phase row is state, the handle is a ref so a queued
  // hop can start it from the turn's end), and the spec a `/move` typed mid-turn
  // left for the first true idle (D4).
  const [hopRun, setHopRun] = useState<{ target: string; phase: string | null } | null>(null);
  const hopRef = useRef<HopRunHandle | null>(null);
  const [hopQueued, setHopQueued] = useState<HopSpec | null>(null);
  const hopQueuedRef = useRef<HopSpec | null>(null);
  /** The queued-hop driver, read from App's idle effect (a ref: no dependency cycle). */
  const hopIfQueuedRef = useRef<(() => void) | null>(null);
  /**
   * OD6: the origin of the hop being STARTED. `startHopRef` is the one entry point
   * every path goes through, so the origin is set by the caller just before it
   * (a proposal: `hopTurnPort.approved`; a queued `/move`: `hopIfQueued`; an idle
   * one: `requestHop`) and read by `startHop`. A ref, because `startHop`'s
   * identity must not change with it (the port holds it).
   */
  const hopOriginRef = useRef<HopOrigin>("idle");
  /**
   * OD6: how many wake turns have run since the user last typed. A real prompt
   * resets it (`noteUserPrompt`, called by the driver's own send path), so the
   * cap counts CONSECUTIVE self-continues, not all of a session's moves.
   */
  const wakeChainRef = useRef(0);

  /**
   * Start one hop (docs/feat/session-hop.md D3/D4), and be the ONLY place the
   * view moves for one: `switchingRef` goes up while it runs (a typed prompt goes
   * back to the input, P3), the phase row is the host's own words, and the view
   * swaps with `keepTranscript` — the transcript rows must land exactly where they
   * were, only the badge and the one notice differ. Everything effectful is the
   * host's (`HopFeed`): the App never builds a runtime.
   */
  const startHop = useCallback(
    (spec: HopSpec, opts?: { gateAnswered?: true; autoAccepted?: true }): void => {
      if (!hop) {
        return;
      }
      // OD6: where this hop came from decides whether the session continues by
      // itself after it (`hopWakeStep`, pure). A model's proposal or a `/move`
      // typed mid-task wakes; a `/move` typed at rest does not. Read from the ref
      // its caller just set, and consumed: the next hop starts from `idle` unless
      // somebody says otherwise.
      const origin: HopOrigin = hopOriginRef.current;
      hopOriginRef.current = "idle";
      // OD4: did auto-accept answer the prompt that produced this spec?
      const autoApproved = opts?.autoAccepted === true ? { autoAccepted: true as const } : null;
      const run = hop.start(spec, sessionRef.current?.sessionId ?? null, opts);
      hopRef.current = run;
      setHopRun({ target: hop.label(spec), phase: null });
      switchingRef.current = true;
      const stopStatus = run.onStatus((line) => {
        setHopRun({ target: hop.label(spec), phase: line });
        flushNow();
      });
      const settle = (): void => {
        stopStatus();
        hopRef.current = null;
        hopQueuedRef.current = null;
        setHopQueued(null);
        switchingRef.current = false;
        setHopRun(null);
        flushNow();
      };
      /**
       * OD6: whether THIS settled hop continues the session by itself, and the
       * one notice that says what happened. `wake` sends ONE real prompt (the
       * driver prepends the laptop's wake line, so the model learns where it is);
       * `hold` leaves that line for the user's next prompt (`takeLine` consumes
       * it there — never lost, never doubled). The chain cap is `hopWakeStep`'s.
       */
      const after = (
        outcome: "moved" | "failed",
        where?: HopPlaceView,
        note?: string,
        autoAccepted = false,
      ): void => {
        const step = hopWakeStep({
          origin,
          outcome,
          chain: wakeChainRef.current,
          // Never two turns at once (review round 1, MEDIUM 2): a job wake fired
          // by `wakeIfPending`, or a foreign turn `drainHeld` started, owns the
          // slot by now — the line then waits for the next real prompt.
          ready: hopReady(boundary(stateRef, rowsRef, daemonQueueRef)),
        });
        const continues = step === "wake" && sendWake !== undefined;
        if (continues) {
          wakeChainRef.current += 1;
        }
        if (where !== undefined) {
          pushNotice(
            hopMovedNotice(
              hopPlaceText(where),
              permission.autoApprove,
              note,
              continues,
              autoAccepted,
            ),
          );
        }
        if (continues) {
          sendWake?.(HOP_WAKE_ROW);
          return;
        }
        if (step === "hold" && wakeChainRef.current >= HOP_WAKE_CHAIN_MAX) {
          // The chain stopped one move short: say so ONCE, then start over — the
          // line still rides the user's next prompt, so nothing is lost.
          wakeChainRef.current = 0;
          pushNotice(`_${HOP_WAKE_PAUSED_NOTICE}_`);
        }
      };
      void run.done.then(
        (outcome) => {
          if ("moved" in outcome) {
            // OD5 (reversing D9): auto-accept SURVIVES a move — the owner's
            // decision — so nothing is cleared here. Session "always" approvals
            // are still re-asked: they live daemon-side, and the daemon changed.
            swapSession(outcome.moved, { keepTranscript: true });
            settle();
            // OD4's logged allow-once: the answer came from auto-accept, so the
            // record says no prompt was shown.
            after("moved", outcome.view.place, outcome.note, autoApproved?.autoAccepted === true);
            return;
          }
          // A failed hop changes nothing: same session, same badge, same rows.
          settle();
          pushNotice(`_${noticeText(outcome.failed)}_`);
          after("failed");
        },
        (error: unknown) => {
          // `HopRun.done` never rejects by contract; a host that does anyway is
          // still one notice, and the latch must not stay up.
          settle();
          pushNotice(`_${noticeText(hopFailureText(error))}_`);
          after("failed");
        },
      );
    },
    [
      daemonQueueRef,
      flushNow,
      hop,
      permission,
      pushNotice,
      rowsRef,
      sendWake,
      sessionRef,
      stateRef,
      swapSession,
      switchingRef,
    ],
  );
  startHopRef.current = startHop;

  /**
   * `/move`'s machinery (docs/feat/session-hop.md D3): the grammar, the turn
   * boundary decision (`hopStep`, pure), then start it now or leave it for the
   * first true idle. The draft field is never touched — a `/move` is a command,
   * and a hop that fails leaves everything as it was.
   */
  const requestHop = useCallback(
    (raw: string): void => {
      const step = hopStep({
        parse: parseHopCommand(raw),
        available: hop !== undefined,
        hopping: hopRef.current !== null,
        hopQueued: hopQueuedRef.current !== null,
        ...boundary(stateRef, rowsRef, daemonQueueRef),
      });
      if (step.kind === "notice") {
        pushNotice(`_${step.text}_`);
        return;
      }
      if (step.kind === "cancel") {
        hopQueuedRef.current = null;
        setHopQueued(null);
        hop?.cancel?.();
        pushNotice("_Move cancelled._");
        return;
      }
      if (step.kind === "queue") {
        hopQueuedRef.current = step.spec;
        setHopQueued(step.spec);
        pushNotice(HOP_QUEUED_NOTICE);
        return;
      }
      hopOriginRef.current = "idle";
      startHopRef.current?.(step.spec);
    },
    [daemonQueueRef, hop, pushNotice, rowsRef, startHopRef, stateRef],
  );

  /** Run a `/move` that waited for the turn boundary (D4): the first true idle. */
  const hopIfQueued = useCallback((): void => {
    const spec = hopQueued;
    if (spec === null || hopRef.current !== null) {
      return;
    }
    // Still busy: it stays queued, and the next idle asks again — never two
    // hops, and never one forgotten. The SAME rule the typed path used
    // (`hopReady`), so the two paths cannot disagree about when a hop may start.
    if (!hopReady(boundary(stateRef, rowsRef, daemonQueueRef))) {
      return;
    }
    hopQueuedRef.current = null;
    setHopQueued(null);
    hopOriginRef.current = "queued";
    startHopRef.current?.(spec);
  }, [daemonQueueRef, hopQueued, rowsRef, startHopRef, stateRef]);
  hopIfQueuedRef.current = hopIfQueued;

  const noteUserPrompt = useCallback((): void => {
    wakeChainRef.current = 0;
  }, []);

  /**
   * OD6: a proposal settled with nothing to build. The model is woken to read the
   * line (`hopWakeStep` decides — the origin is a proposal by definition here), or
   * the line waits for the user's next prompt. Set on the ref App's port reads.
   */
  const wakeSettled = useCallback(
    (outcome: "declined" | "failed"): void => {
      const step = hopWakeStep({
        origin: "proposal",
        outcome,
        chain: wakeChainRef.current,
        // Same rule as `after()`: the settle is asynchronous (the ask can wait on
        // a human), so by now a job wake or a drained foreign turn may own the
        // slot — the line is then carried by the next real prompt.
        ready: hopReady(boundary(stateRef, rowsRef, daemonQueueRef)),
      });
      if (step !== "wake" || sendWake === undefined) {
        return;
      }
      wakeChainRef.current += 1;
      sendWake(HOP_WAKE_ROW);
    },
    [daemonQueueRef, rowsRef, sendWake, stateRef],
  );
  wakeAfterHopRef.current = wakeSettled;

  return { hopRun, hopQueued, hopIfQueuedRef, requestHop, hopOriginRef, noteUserPrompt };
}

/**
 * The boundary's two FACTS, read from their live sources: this TUI's turn
 * (`stateRef`, never a render closure — a `/move` typed in the chunk a turn ended
 * must see it ended) and the shown rows (`shownRows`, the daemon's queue folded
 * with mine). Kept as one reader so both callers feed `hopReady` the same thing.
 */
function boundary(
  stateRef: MutableRefObject<DisplayState>,
  rowsRef: MutableRefObject<QueuedRows>,
  daemonQueueRef: MutableRefObject<DaemonQueue | undefined>,
): { readonly running: boolean; readonly queued: number } {
  return {
    running: stateRef.current.running,
    queued: shownRows(rowsRef.current, daemonQueueRef.current).length,
  };
}

/** What a started hop hands back (the hook holds it; App never names it). */
type HopRunHandle = NonNullable<ReturnType<HopFeed["start"]>>;
