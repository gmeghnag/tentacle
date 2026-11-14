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
import type { HopFeed, SessionController } from "./app-types.ts";
import {
  HOP_QUEUED_NOTICE,
  type HopSpec,
  hopReady,
  hopStep,
  parseHopCommand,
} from "./hop-command.ts";
import { hopFailureText, hopMovedNotice, hopPlaceText, noticeText } from "./hop-status.ts";
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
    ((spec: HopSpec, opts?: { gateAnswered?: true }) => void) | null
  >;
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
   * Start one hop (docs/feat/session-hop.md D3/D4), and be the ONLY place the
   * view moves for one: `switchingRef` goes up while it runs (a typed prompt goes
   * back to the input, P3), the phase row is the host's own words, and the view
   * swaps with `keepTranscript` — the transcript rows must land exactly where they
   * were, only the badge and the one notice differ. Everything effectful is the
   * host's (`HopFeed`): the App never builds a runtime.
   */
  const startHop = useCallback(
    (spec: HopSpec, opts?: { gateAnswered?: true }): void => {
      if (!hop) {
        return;
      }
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
      void run.done.then(
        (outcome) => {
          if ("moved" in outcome) {
            // D9: a hop never inherits an approval — auto-accept goes off with
            // the move, said in the same notice (the feed, or this TUI's own).
            // `clearAutoApprove`, never `autoAccept.set`: the feed's `set` only
            // publishes the flip for the OTHER terminals, so this one's state
            // (and its status bar) would still say "auto-accept on" while the
            // notice claims otherwise.
            const wasOn = permission.autoApprove;
            if (wasOn) {
              permission.clearAutoApprove();
            }
            swapSession(outcome.moved, { keepTranscript: true });
            settle();
            pushNotice(hopMovedNotice(hopPlaceText(outcome.view.place), wasOn, outcome.note));
            return;
          }
          // A failed hop changes nothing: same session, same badge, same rows.
          settle();
          pushNotice(`_${noticeText(outcome.failed)}_`);
        },
        (error: unknown) => {
          // `HopRun.done` never rejects by contract; a host that does anyway is
          // still one notice, and the latch must not stay up.
          settle();
          pushNotice(`_${noticeText(hopFailureText(error))}_`);
        },
      );
    },
    [flushNow, hop, permission, pushNotice, sessionRef, swapSession, switchingRef],
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
    startHopRef.current?.(spec);
  }, [daemonQueueRef, hopQueued, rowsRef, startHopRef, stateRef]);
  hopIfQueuedRef.current = hopIfQueued;

  return { hopRun, hopQueued, hopIfQueuedRef, requestHop };
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
