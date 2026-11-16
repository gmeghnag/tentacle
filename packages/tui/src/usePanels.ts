/**
 * The panels' state rules and executors (docs/feat/app-decomposition.md S7).
 * Every DECISION stays where it was and stays pure — `panels/registry.ts` +
 * `panels/<kind>.ts` (a panel's own projection, its key answer, its body-row
 * click) and `sessions-panel.ts` (the list, choose/delete, the refresh gate). This
 * hook is the EXECUTOR: the close/open generation, the open→load→(apply|fail)
 * sequence, and the delete-then-refresh chain.
 *
 * What does NOT move (Fable H1 / M1, and the S6 precedent for render state):
 * - **the panel STATE itself** (`panel`, `setPanel`) and the `panelRef` mirror:
 *   the frame reads them (`listView`, the palette gate) and `panelRef` is assigned
 *   IN RENDER, above every executor — a paste, a timer-flushed paste and a held
 *   `[` read it. They stay `App`'s, and arrive here as port fields.
 * - **no effect**: `App` declares its 22 effects in today's order (the original
 *   20 + session-hop's 2) and this hook
 *   declares none, so the effect list is untouched.
 * - every returned identifier keeps the name `App` already used (`closePanel`,
 *   `openPanel`, `sessionsDelete`, …), so no use site changed.
 *
 * What DOES move: the `kind ===` rules. A test about a panel's OWN state is that
 * kind's rule and lives in `panels/sessions.ts` (`withSessionsState`,
 * `touchPanel`, `withSessionsRefresh`, `isSessionsOpen`); a rule about the panel
 * STATE (open/close, the generation, the delete chain) lives here.
 */
import { useCallback, useRef } from "react";
import type { SessionController, SessionDirectory } from "./app-types.ts";
import { SCHEDULE_UNSUPPORTED } from "./commands/schedule.ts";
import { type OpenPanel, applyPanel } from "./panel.ts";
import { isScheduleOpen, withSchedulesData, withSchedulesState } from "./panels/schedule.ts";
import {
  deleteFailedNotice,
  isSessionsOpen,
  sessionsListError,
  sessionsRefreshApplies,
  touchPanel,
  withSessionsRefresh,
  withSessionsState,
} from "./panels/sessions.ts";
import type { ScheduleDockRow, SchedulesState } from "./schedule-view.ts";
import type { SessionsState } from "./sessions-panel.ts";

/** The narrow port the panels execute through: the App's own state, setters and refs. */
export interface PanelsHost {
  readonly panelRef: { readonly current: OpenPanel | null };
  /** `App`'s own `useState` setter: identity-stable, and the one the frame reads. */
  readonly setPanel: (f: (panel: OpenPanel | null) => OpenPanel | null) => void;
  /** The `/sessions` directory, when this runtime has one (a value: a prop). */
  readonly sessions: SessionDirectory | undefined;
  /** A session switch is latched: `sessionsRefreshApplies` refuses meanwhile. */
  readonly switchingRef: { readonly current: boolean };
  /** A panel's width, for `applyPanel` (a render value, as it was inline). */
  readonly columns: number;
  readonly pushNotice: (text: string) => void;
  /** The live session (the `/schedule` delete goes through its client). */
  readonly sessionRef: { readonly current: SessionController | null };
  /**
   * The ids this TUI deleted, written by a successful `/schedule` delete too
   * (cron-tool fix round 1, finding 1): the departure notice must not explain
   * the panel's own delete as a failure or a fire.
   */
  readonly ownScheduleDeletesRef: { readonly current: Set<string> };
}

/** The panels' actions, under the identifiers `App` already used. */
export interface PanelsLayer {
  /** The close/open generation: a load answering after it is dropped. */
  readonly panelGenRef: { readonly current: number };
  /** A panel action on the LIVE state (`applyPanel`, functional update, at `columns`). */
  panelApply(action: Parameters<typeof applyPanel>[1]): void;
  /** Write the `/sessions` panel's own state (`sessionsDelete`'s arm/answer). */
  setSessionsState(state: SessionsState): void;
  /** The open `/sessions` panel re-read at the next render (its "current" row). */
  touchPanel(): void;
  /** Close the open panel (a new generation: a pending load is dropped). */
  closePanel(): void;
  /** Open `initial` at once, then the loaded panel — if it is still the open one. */
  openPanel(
    initial: OpenPanel,
    load: () => Promise<OpenPanel>,
    describe: (error: unknown) => string,
  ): void;
  /** Delete a `/sessions` row, then refresh the panel if it is still the same one. */
  sessionsDelete(id: string, startedGen: number): void;
  /** Write the `/schedule` panel's own state (its arm/answer, cron-tool S5). */
  setSchedulesState(state: SchedulesState): void;
  /**
   * The open `/schedule` panel follows a REPORT (cron-tool fix round 1, finding
   * 2): the new table, re-stamped, cursor and arm brought back in range. Without
   * it the panel is the snapshot it was opened on.
   */
  setSchedulesData(rows: readonly ScheduleDockRow[] | undefined, now: number): void;
  /** Delete one scheduled wake; the row leaves on the daemon's own frame. */
  deleteSchedule(id: string, startedGen: number): void;
}

export function usePanels(host: PanelsHost): PanelsLayer {
  // Destructured so the callbacks' deps name FIELDS, never the port (Fable H2).
  const { panelRef, setPanel, sessions, switchingRef, columns, pushNotice, sessionRef } = host;
  const { ownScheduleDeletesRef } = host;

  const panelGenRef = useRef(0);

  const closePanel = useCallback(() => {
    panelGenRef.current += 1;
    setPanel(() => null);
  }, [setPanel]);

  /**
   * Open `initial` (its loading state) at once, then whatever `load` resolves
   * to — only if this panel is still the open one; a failure closes it and
   * says why.
   */
  const openPanel = useCallback(
    (initial: OpenPanel, load: () => Promise<OpenPanel>, describe: (e: unknown) => string) => {
      panelGenRef.current += 1;
      const gen = panelGenRef.current;
      setPanel(() => initial);
      void load().then(
        (loaded) => {
          if (panelGenRef.current === gen) {
            setPanel(() => loaded);
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
    [closePanel, pushNotice, setPanel],
  );

  const panelApply = useCallback(
    (action: Parameters<typeof applyPanel>[1]) =>
      setPanel((p) => (p ? applyPanel(p, action, columns) : p)),
    [columns, setPanel],
  );

  const setSessionsState = useCallback(
    (state: SessionsState) => setPanel((p) => withSessionsState(p, state)),
    [setPanel],
  );

  /** Write the `/schedule` panel's arm/cursor state (cron-tool S5). */
  const setSchedulesState = useCallback(
    (state: SchedulesState) => setPanel((p) => withSchedulesState(p, state)),
    [setPanel],
  );

  /** An open `/schedule` panel follows the daemon's report (cron-tool fix round 1, finding 2). */
  const setSchedulesData = useCallback(
    (rows: readonly ScheduleDockRow[] | undefined, now: number) =>
      setPanel((p) => withSchedulesData(p, rows, now)),
    [setPanel],
  );

  /**
   * Delete one scheduled wake, then refresh the panel — but only if it is still
   * THE SAME panel: the generation the key landed in is compared at the answer,
   * so a reply that lands after the panel closed (or another opened) is dropped.
   * The row itself leaves on the daemon's `schedules` frame, never on this
   * answer: the frame is the ONE truth every surface paints (cron-tool D5).
   */
  const deleteSchedule = useCallback(
    (id: string, startedGen: number): void => {
      const session = sessionRef.current;
      if (!session?.deleteSchedule) {
        pushNotice(SCHEDULE_UNSUPPORTED);
        return;
      }
      const applies = (): boolean =>
        panelGenRef.current === startedGen && isScheduleOpen(panelRef.current);
      void session.deleteSchedule(id).then(
        (result) => {
          if (!applies()) return;
          if (result.deleted) {
            // Ours: the frame that drops it must not be re-explained as a
            // failure (fix round 1, finding 1). Recorded BEFORE that frame can
            // arrive, as the dock's own delete does.
            ownScheduleDeletesRef.current.add(id);
            pushNotice(`_Deleted ${id}._`);
            return;
          }
          pushNotice(`_${id} was not deleted: ${result.reason ?? "the daemon no longer has it"}_`);
        },
        (e: unknown) => {
          if (!applies()) return;
          pushNotice(deleteFailedNotice(e));
        },
      );
    },
    [sessionRef, pushNotice, panelRef, ownScheduleDeletesRef],
  );

  const touch = useCallback(() => setPanel((p) => touchPanel(p)), [setPanel]);

  /**
   * Delete a `/sessions` row, then refresh the panel — but only if it is still
   * THE SAME panel: the generation the key landed in is compared at every async
   * step (`sessionsRefreshApplies`), so a request answering after the panel
   * closed (or another opened) is dropped instead of landing on screen. The
   * decisions are still `sessions-panel.ts`'s; the `open` test is the `/sessions`
   * kind's own rule (`isSessionsOpen`).
   */
  const sessionsDelete = useCallback(
    (id: string, startedGen: number): void => {
      if (!sessions) {
        return;
      }
      const applies = (): boolean =>
        sessionsRefreshApplies({
          startedGen,
          gen: panelGenRef.current,
          open: isSessionsOpen(panelRef.current),
          switching: switchingRef.current,
        });
      void sessions.remove(id).then(
        () => {
          if (!applies()) return;
          void sessions.list().then(
            (view) => {
              if (!applies()) return;
              setPanel((p) => withSessionsRefresh(p, view));
            },
            (e: unknown) => {
              // The panel closed meanwhile: its refresh no longer matters (R4-1).
              if (applies()) pushNotice(sessionsListError(e));
            },
          );
        },
        (e: unknown) => pushNotice(deleteFailedNotice(e)),
      );
    },
    [sessions, pushNotice, panelRef, switchingRef, setPanel],
  );

  return {
    panelGenRef,
    panelApply,
    setSessionsState,
    setSchedulesState,
    setSchedulesData,
    deleteSchedule,
    touchPanel: touch,
    closePanel,
    openPanel,
    sessionsDelete,
  };
}
