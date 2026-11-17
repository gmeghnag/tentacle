/**
 * `/quit` (`/exit`) and `/clear` — the two ways this TUI ends something
 * (docs/feat/app-decomposition.md S8): the quit's decision and its
 * confirmation, the clear's step decision and refusals, and the reset that
 * really clears. Every DECISION stays where it was and stays pure —
 * `quitCommandStep` / `quitConfirmText` (`commands.ts`), `clearCommandStep` /
 * `clearErrorNotice` / `clearNoopNotice` (`clear-command.ts`),
 * `backgroundCount` / `backgroundNames` (`background-view.ts`) — and this hook
 * is the executor for them, owning nothing but the wiring.
 *
 * That is the §7 split, and it is why this hook holds NO state of its own: every
 * ref these three bodies touch is ALSO written or read by a driver this slice
 * does not own (Fable H1 — the 22 effects stay in `App`, in today's order: the
 * original 20 plus session-hop's 2):
 *
 * - `exitPendingRef` — read by the turn's settle (`App`'s `streamTurn`: a quit
 *   asked for mid-turn exits there) and by the key snapshot (S3);
 * - `clearingRef` / `ownClearsRef` — written by the `watch` activity effect (a
 *   `history{clear}` releases the latch and zeroes the own count) and by
 *   `swapSession` (a session-link swap);
 * - `clearAfterTurnRef` — written here, taken by the turn's settle;
 * - `runClearRef` — the forward reference the turn's settle calls (stop-then-
 *   clear), assigned by `App` right after this hook returns;
 * - `stoppedHereRef` / `abortRef` / `sessionRef` / `stateRef` / `foreignRef` /
 *   `compactingRef` / the dock's `subagentsRef` + `jobRowsRef` — every one of
 *   them is shared with at least one layer `App` keeps.
 *
 * They arrive as port fields, the same way S4's `useMouse` takes `selectionRef`
 * and S6's `useAttachments` takes `uploadCtrlRef`: a ref is passed in, never
 * re-created here — so each read site keeps its identifier (Fable M1) and its
 * source (Fable H3: a ref read stays a ref read, so two keys with no render
 * between them behave exactly as today).
 *
 * This hook declares NO effect, so `App`'s effect list is untouched (H1).
 */
import { type MutableRefObject, useCallback } from "react";
import type { SessionController } from "./app-types.ts";
import type { DockJobRow } from "./background-list.ts";
import { backgroundCount, backgroundNames } from "./background-view.ts";
import type { BackgroundAgentRow } from "./background-view.ts";
import { clearCommandStep, clearErrorNotice, clearNoopNotice } from "./clear-command.ts";
import { type QuitConfirmFacts, quitCommandStep } from "./commands.ts";
import type { ScheduleDockRow } from "./schedule-view.ts";
import type { DisplayState } from "./state.ts";

/**
 * A detached run's TUI (docs/fix/detach-live.md A2): `/quit` closes the
 * session for every TUI on it. The host counts the others and acts after Ink
 * unmounted; the App only reports what the user chose and what happened.
 *
 * It lives here, next to the executor that reads it (plan H4(1): a hook slice
 * takes its own types with it), and is re-exported from `App.tsx` and
 * `index.ts` exactly as before — so no importer moves.
 */
export interface RunQuit {
  /** Other live TUIs on this same session (laptop presence). */
  othersOnSession(): number;
  /** The user confirmed: this TUI's quit closes the session for all. */
  closeForAll(): void;
  /** Another TUI closed the session: this one leaves, nothing to save or delete. */
  closedElsewhere(reason: "closed" | "deleted" | "gone"): void;
}

/**
 * The narrow port the quit and the clear execute through: the App's own state,
 * setters, refs and callbacks. A port FIELD keeps its current identity rule
 * (Fable H2) — a `useCallback` keeps its dep array, a prop keeps being a prop,
 * a `useRef` object stays THE same object — and the callbacks below destructure
 * the fields and name them in deps, never `host`.
 */
export interface QuitClearHost {
  /** The live session (a clear's reset, a swap's target) and the display state. */
  readonly sessionRef: MutableRefObject<SessionController | null>;
  readonly stateRef: MutableRefObject<DisplayState>;
  /** What Esc/Ctrl+C aborts: the streamed turn's controller. */
  readonly abortRef: MutableRefObject<AbortController | null>;
  /** Another device's streamed turn, or null: its own state is not mine to stop. */
  readonly foreignRef: MutableRefObject<AbortController | null>;
  /** A quit asked for mid-turn: exit when the turn has settled (and was saved). */
  readonly exitPendingRef: MutableRefObject<boolean>;
  /** A `/clear` of this TUI's is in flight; the wake gate reads it too. */
  readonly clearingRef: MutableRefObject<boolean>;
  /** How many of this TUI's cleared histories have not arrived yet (C6/L6a). */
  readonly ownClearsRef: MutableRefObject<number>;
  /** A clear waiting for the own turn it stopped to end (read by the settle). */
  readonly clearAfterTurnRef: MutableRefObject<boolean>;
  /** This TUI stopped the current turn itself (`handBackRows`' notice). */
  readonly stoppedHereRef: MutableRefObject<boolean>;
  /** `/compact`'s latch: a clear is refused while one holds the session. */
  readonly compactingRef: MutableRefObject<boolean>;
  /** The forward reference the turn's settle calls; `App` assigns it after this. */
  readonly runClearRef: MutableRefObject<(() => void) | null>;
  /** The dock's rows (S5): a quit counts the children and jobs it would lose. */
  readonly subagentsRef: MutableRefObject<readonly BackgroundAgentRow[] | undefined>;
  readonly jobRowsRef: MutableRefObject<readonly DockJobRow[] | undefined>;
  /**
   * The session's ARMED scheduled wakes (cron-tool S5, M6): a quit that CLOSES
   * the session ends them, so it asks first. Read at quit time, like the jobs'.
   */
  readonly schedulesRef: MutableRefObject<readonly ScheduleDockRow[] | undefined>;
  /** `/quit`'s confirmation facts (the dialog's state is App's: it renders it). */
  readonly setQuitConfirm: (facts: QuitConfirmFacts | null) => void;
  /** A detached run's TUI: `/quit` closes for all, and `others` is asked live. */
  readonly runQuit: RunQuit | undefined;
  /** `connect`: quitting only detaches, so a job or a turn is not lost. */
  readonly detachOnQuit: boolean;
  /** `level: "warn"` marks a harness line the person should notice (docs/feat/harness-notices.md S2). */
  readonly pushNotice: (text: string, level?: "warn") => void;
  readonly wakeIfPending: () => void;
  /** Quit the TUI (Ink's `useApp().exit`). */
  readonly exit: () => void;
  /**
   * docs/feat/session-hop-ux OD6: the session is being REPLACED, so a hop fact
   * about the old one (its place, its cwd) is dropped instead of riding the new
   * conversation's first prompt. Absent: nothing to drop.
   */
  readonly clearHopPending?: () => void;
}

/** What `App` names from this feature. The identifiers are the pre-S8 ones. */
export interface QuitClearLayer {
  /** `/quit`'s decision (`quitCommandStep`) and its `y` confirmation. */
  requestQuit(confirmed: boolean): void;
  /** Ask the daemon to reset the conversation; the `history{clear}` replaces it. */
  runClear(): void;
  /** `/clear`'s step (`clearCommandStep`): its refusals and the hand-off. */
  requestClear(): void;
}

export function useQuitClear(host: QuitClearHost): QuitClearLayer {
  // Destructured so the callbacks' deps name FIELDS, never the port (Fable H2).
  const {
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
    schedulesRef,
    setQuitConfirm,
    runQuit,
    detachOnQuit,
    pushNotice,
    clearHopPending,
    wakeIfPending,
    exit,
  } = host;

  /**
   * `/quit` and `/exit`: the decision is `quitCommandStep`'s (A1); `confirmed`
   * is the `y` of its confirmation. Another device's turn is not mine to stop
   * on the way out (C4), but a run TUI's quit ends the session, so it stops
   * that one too. On `connect` (`detachOnQuit`) quitting only detaches.
   */
  const requestQuit = useCallback(
    (confirmed: boolean): void => {
      const agents = backgroundCount(subagentsRef.current);
      // A running SHELL job dies with the session too (owner Q3 (a)) — but only a
      // quit that CLOSES it loses one, so a `connect` detach passes none.
      const jobs = detachOnQuit ? 0 : (jobRowsRef.current?.length ?? 0);
      // A scheduled wake lives in the SESSION (cron-tool D6): a quit that ends
      // it ends them all, and nobody would be left to be woken. A `connect`
      // quit only detaches, so the daemon keeps them armed.
      const scheduleIds = detachOnQuit ? [] : (schedulesRef.current ?? []).map((row) => row.id);
      const step = quitCommandStep({
        running: stateRef.current.running,
        exitPending: exitPendingRef.current,
        foreign: foreignRef.current !== null,
        detaches: detachOnQuit,
        endsSession: runQuit !== undefined,
        others: confirmed ? 0 : (runQuit?.othersOnSession() ?? 0),
        agents: confirmed ? 0 : agents,
        jobs: confirmed ? 0 : jobs,
        schedules: confirmed ? 0 : scheduleIds.length,
        confirmed,
      });
      if (step === "confirm") {
        setQuitConfirm({
          others: runQuit?.othersOnSession() ?? 0,
          agents,
          jobs,
          ...(scheduleIds.length === 0 ? {} : { scheduleIds }),
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
    // Every ref here is a STABLE object (the App's own `useRef`) arriving as a
    // port field: naming them keeps the identity rule (Fable H2) and never
    // re-creates this callback.
    [
      abortRef,
      detachOnQuit,
      exit,
      exitPendingRef,
      foreignRef,
      jobRowsRef,
      schedulesRef,
      pushNotice,
      runQuit,
      setQuitConfirm,
      stateRef,
      subagentsRef,
    ],
  );

  /**
   * Ask the daemon to reset the conversation (docs/feat/clear-keeps-jobs.md).
   * The transcript is replaced by the `history{clear}` activity, never here; a
   * refusal changes nothing and says so. Nothing escapes: both settle paths are
   * guarded (a throw in a void promise would be an unhandled rejection).
   */
  const runClear = useCallback((): void => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    // Called ON the session: under `connect` this is the `RemoteSession` CLASS
    // instance, whose `clear` reads `this` (`this.openForReset()`) — a method
    // taken off the object and called alone loses `this`
    // (docs/fix/clear-connect-unbound.md).
    const clear = session.clear.bind(session);
    clearingRef.current = true;
    // OD6: the conversation being dropped may have had a hop fact pending; the
    // new one must not be told "you are in <the old place>". (A ref read at call
    // time, like every other seam here: it is not a render value.)
    clearHopPending?.();
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
  }, [clearingRef, clearHopPending, ownClearsRef, pushNotice, sessionRef, stateRef, wakeIfPending]);

  /**
   * `/clear`'s step (docs/feat/app-decomposition.md M5): the refusals, the
   * latch and the stop-then-clear hand-off. The decision is
   * `clearCommandStep`'s; this only carries it out.
   */
  const requestClear = useCallback((): void => {
    const step = clearCommandStep({
      running: stateRef.current.running,
      ownTurn: foreignRef.current === null,
      compacting: compactingRef.current,
      clearing: clearingRef.current,
    });
    if (step === "busy") {
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
  }, [
    abortRef,
    clearAfterTurnRef,
    clearingRef,
    compactingRef,
    foreignRef,
    pushNotice,
    runClearRef,
    stateRef,
    stoppedHereRef,
  ]);

  return { requestQuit, runClear, requestClear };
}
