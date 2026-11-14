/**
 * The dock's STATE and ACTIONS (docs/feat/app-decomposition.md S5): the
 * background sub-agents' and shell jobs' rows as last reported, the dock's own
 * focus/drafts/`sent`, the per-job output cache the drawer paints, and the four
 * actions that act on them (`killChild`, `killJob`, `toggleAgents`,
 * `submitToTarget`). Every DECISION is already a pure module's — `reconcile`,
 * `dockKey`, `sendTarget`, `toggleList`, `refusalPlacement`, `listVisible`,
 * `backgroundListView` (`background-focus.ts` / `background-list.ts`) — so this
 * hook owns only refs, state and the RPC calls that carry a decision out
 * (AGENTS §7).
 *
 * Two rules from the plan that shape the file:
 *
 * 1. **No effect.** The four dock effects (`jobs.onExit`, the id-key reconcile,
 *    the output refresh, the last read at an exit) stay in `App` in today's
 *    order (Fable H1 / owner Q7 (a)): an effect may move into a hook only when
 *    its index among App's 22 is unchanged (the original 20 + session-hop's 2),
 *    and these are 4, 12, 13, 14. So the refs and the derived triggers
 *    (`dockIdKey`, `jobTargetId`, `jobEndedWhileOpen`, `refreshMs`) are returned
 *    for those effects to read, and this hook declares no `useEffect` at all.
 * 2. **Frozen identifiers (Fable M1).** The hook destructures into the SAME
 *    names `App` already used (`dockRef`, `setDock`, `dockIds`, `killJob`, …),
 *    so every use site is untouched. A port FIELD keeps its current identity
 *    rule (H2): a stable `useState` setter stays one, a `useCallback` keeps its
 *    dep array, a ref stays a ref.
 *
 * `pushNotice` is the ONE forward reference: it is declared below this hook in
 * `App` (it needs `flushNow`, and the dock's refs are needed by an effect
 * declared above it), so it travels as a ref — the same late-binding the file
 * already uses for `routeAttachRef` / `runRef` / `warmErrorRef`, and it keeps
 * this hook's callbacks from changing identity every time the sink does.
 */
import { useCallback, useRef, useState } from "react";
import type { SessionController } from "./app-types.ts";
import {
  type DockOutcome,
  type DockState,
  INPUT_DOCK,
  dockKindOf,
  refusalPlacement,
  restoreRefused,
  sendTarget,
  toggleList,
} from "./background-focus.ts";
import { type DockJobRow, frozenAgent, frozenJob, listVisible } from "./background-list.ts";
import { type BackgroundAgentRow, sameIds, sameJobIds, sameReads } from "./background-view.ts";
import type { LineEditor } from "./hooks.ts";
import { JOB_REFRESH_MS } from "./job-drawer.ts";

/**
 * What the dock takes from `App`. Three ref-backed fields and the open line
 * editor — no layout, no other feature's state: the dock's view-models are still
 * built in `App`, where the layout that sizes them is.
 */
export interface DockHost {
  /** The current session (the RPCs a stop or a child message goes through). */
  readonly sessionRef: { readonly current: SessionController | null };
  /** The prompt line, for a refusal that must put the text back or clear it. */
  readonly field: LineEditor;
  /** The LIVE field text (a refusal's placement asks whether it is empty NOW). */
  readonly fieldValueRef: { readonly current: string };
  /**
   * `pushNotice`, through a ref: it is declared BELOW this hook in `App`, and a
   * by-value port would either move the dock's refs below that effect or churn
   * this hook's callbacks. The ref keeps both impossible.
   */
  readonly pushNoticeRef: { current: (text: string) => void };
  /** The test seam for the job-output cadence (`AppProps.jobRefreshMs`). */
  readonly jobRefreshMs: number | undefined;
}

/** Everything `App` names from the dock. The identifiers are the pre-S5 ones. */
export interface DockLayer {
  // --- the rows, as last reported (state renders; ref is what a key reads)
  readonly subagents: readonly BackgroundAgentRow[] | undefined;
  readonly subagentsRef: { current: readonly BackgroundAgentRow[] | undefined };
  readonly setAgents: (rows: readonly BackgroundAgentRow[] | undefined) => void;
  readonly dockLastRowsRef: { current: readonly BackgroundAgentRow[] };
  readonly jobRows: readonly DockJobRow[] | undefined;
  readonly jobRowsRef: { current: readonly DockJobRow[] | undefined };
  readonly setJobs: (rows: readonly DockJobRow[] | undefined) => void;
  readonly dockLastJobRowsRef: { current: readonly DockJobRow[] };

  // --- exits and output (written by App's ordered effects)
  readonly dockOutcomeRef: { current: Record<string, DockOutcome> };
  readonly dockFinishedRef: { current: { readonly id: string; readonly at: number } | null };
  readonly dockStoppedRef: { current: Set<string> };
  readonly jobOutputRef: {
    current: Record<
      string,
      {
        readonly output: readonly string[];
        readonly truncated?: boolean;
        readonly exitCode?: number | null;
      }
    >;
  };
  readonly setJobOutputGen: (f: (n: number) => number) => void;
  readonly jobReadAtRef: { current: { readonly id: string; readonly at: number } | null };

  // --- the dock itself
  readonly dock: DockState;
  readonly dockRef: { current: DockState };
  readonly setDock: (next: DockState | ((prev: DockState) => DockState)) => void;
  readonly dockIds: () => readonly string[];
  readonly dockVisible: () => boolean;
  /** The item an open drawer paints: its live row, or the frozen one. */
  readonly drawerRow: BackgroundAgentRow | null;
  readonly drawerJob: DockJobRow | null;
  /** App's reconcile memory, and its trigger as a VALUE (not a ref read). */
  readonly dockSeenRef: { current: readonly string[] };
  readonly dockIdKey: string;
  /** The drawer's read cadence, as the two App effects key it. */
  readonly jobTargetId: string | null;
  readonly jobEndedWhileOpen: DockOutcome | null;
  readonly refreshMs: number;

  // --- the actions
  readonly killChild: (id: string) => void;
  readonly killJob: (id: string) => void;
  readonly toggleAgents: () => void;
  /** `true` means the dock owned the text; the caller's own submit must not run. */
  readonly submitToTarget: (value: string) => boolean;
}

export function useDock(host: DockHost): DockLayer {
  // Destructured so every callback's deps name FIELDS, never the host (Fable H2).
  const { sessionRef, field, fieldValueRef, pushNoticeRef, jobRefreshMs } = host;

  const pushNotice = useCallback(
    (text: string): void => pushNoticeRef.current(text),
    [pushNoticeRef],
  );

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
    // Keep the last rows the dock could paint BEFORE they are replaced: an open
    // child that this report drops freezes its drawer on them (`reconcile`).
    if (previous !== undefined && previous.length > 0) {
      dockLastRowsRef.current = previous;
    }
    subagentsRef.current = rows;
    // A read count alone must still reach the frame: the drawer's `✓ read`
    // reads it (docs/fix/autoaccept-wake-turns.md part B). `sameIds` alone would
    // swallow it, exactly as the daemon's `sameRows` would.
    if (!sameIds(previous, rows) || !sameReads(previous, rows)) {
      setSubagents(rows);
    }
  }, []);
  /** The last non-empty rows the dock could paint: what an ended drawer freezes on. */
  const dockLastRowsRef = useRef<readonly BackgroundAgentRow[]>([]);
  // The session's running shell jobs, as last reported (undefined: not reported).
  const [jobRows, setJobRowsState] = useState<readonly DockJobRow[] | undefined>(undefined);
  /** The same list for the callbacks that must not re-create on every frame. */
  const jobRowsRef = useRef<readonly DockJobRow[] | undefined>(undefined);
  const setJobs = useCallback((rows: readonly DockJobRow[] | undefined) => {
    const previous = jobRowsRef.current;
    // Keep the last rows the dock could paint BEFORE they are replaced: an open
    // job that this report drops freezes its drawer on them (`reconcile`).
    if (previous !== undefined && previous.length > 0) {
      dockLastJobRowsRef.current = previous;
    }
    jobRowsRef.current = rows;
    if (!sameJobIds(previous, rows)) {
      setJobRowsState(rows);
    }
  }, []);
  /** The last non-empty rows a job's drawer can freeze on. */
  const dockLastJobRowsRef = useRef<readonly DockJobRow[]>([]);
  /**
   * A child's exit as the transcript's notice already learns it, by id: the
   * `end_turn` that means "finished" (what a frozen drawer says).
   */
  const dockOutcomeRef = useRef<Record<string, DockOutcome>>({});
  /**
   * The child that just ENDED and when, for the pill's `✓ sa-1 done` (~5 s; the
   * window and the wording are `status-view.ts`'s `PILL_DONE_MS`). Written by the
   * same `jobs.onExit` feed that records the outcome, so the pill and the
   * transcript's notice can never disagree about who ended.
   */
  const dockFinishedRef = useRef<{ readonly id: string; readonly at: number } | null>(null);
  /**
   * The jobs THIS dock asked to stop (`x` then `y`). A job's exit record only
   * says `killed` — it cannot tell the user's own stop (`✗ stopped`) from a
   * signal nobody here sent (`✗ killed`), which owner B wants apart (fix round 1).
   */
  const dockStoppedRef = useRef<Set<string>>(new Set());
  /**
   * Each open job's last read, by wire id: what its drawer paints. A REF, never
   * state the refresh effect depends on — a fresh read must not re-arm the timer
   * (that is what would break the ≤ 1/s rule); the `jobOutputGen` state beside it
   * is only a render trigger.
   */
  const jobOutputRef = useRef<
    Record<
      string,
      {
        readonly output: readonly string[];
        readonly truncated?: boolean;
        readonly exitCode?: number | null;
      }
    >
  >({});
  const [, setJobOutputGen] = useState(0);
  /** When the last read was issued (ms), and for which job: the `refreshDue` input. */
  const jobReadAtRef = useRef<{ readonly id: string; readonly at: number } | null>(null);
  // The dock (docs/feat/subagent-panel.md): its focus, the drafts per target and
  // the messages sent to each child. `dockRef` is the truth for the key handler
  // (a keypress must read what the last one wrote); the state renders.
  const [dock, setDockState] = useState<DockState>(INPUT_DOCK);
  const dockRef = useRef<DockState>(INPUT_DOCK);
  const setDock = useCallback((next: DockState | ((prev: DockState) => DockState)) => {
    // The ref is written EAGERLY, from itself: a keypress handled later in the
    // same tick (or before React commits) must read what the last one decided.
    // (A ref written inside the state updater lands at render time — too late,
    // which would let an ended child's Enter send.)
    const value = typeof next === "function" ? next(dockRef.current) : next;
    dockRef.current = value;
    setDockState(value);
  }, []);
  /**
   * The dock's item ids in paint order: the children, then the jobs — the order
   * `backgroundListView` paints (a job never jumps above a child that started
   * later). Both kinds' ids are wire ids (`sa-N` / `bg-N`), so they never collide.
   */
  const dockIds = useCallback(
    (): readonly string[] => [
      ...(subagentsRef.current ?? []).map((r) => r.id),
      ...(jobRowsRef.current ?? []).map((r) => r.id),
    ],
    [],
  );
  /** Whether the list has anything to show (the dock's `listVisible`). */
  const dockVisible = useCallback(
    (): boolean => listVisible(subagentsRef.current, jobRowsRef.current),
    [],
  );
  /** The item an open drawer paints: its live row (child or job), or the frozen one. */
  const drawerSubject:
    | { kind: "agent"; row: BackgroundAgentRow }
    | { kind: "job"; row: DockJobRow }
    | null =
    dock.focus.kind !== "open"
      ? null
      : (() => {
          const id = (dock.focus as { id: string }).id;
          const live = subagentsRef.current?.find((r) => r.id === id);
          if (live !== undefined) {
            return { kind: "agent" as const, row: live };
          }
          const liveJob = jobRowsRef.current?.find((r) => r.id === id);
          if (liveJob !== undefined) {
            return { kind: "job" as const, row: liveJob };
          }
          const frozen = frozenAgent(dock.focus.frozen);
          if (frozen !== null) {
            return { kind: "agent" as const, row: frozen };
          }
          const frozenJ = frozenJob(dock.focus.frozen);
          return frozenJ === null ? null : { kind: "job" as const, row: frozenJ };
        })();
  const drawerRow = drawerSubject?.kind === "agent" ? drawerSubject.row : null;
  const drawerJob = drawerSubject?.kind === "job" ? drawerSubject.row : null;

  /**
   * Rows changed: the dock keeps its selection BY ID, follows it when the row
   * leaves, and returns to the input when the list empties — `reconcile`'s
   * decision, pure (P5 (a): a finished item leaves at once). A departure freezes
   * an open drawer and KEEPS the input's target, so a draft is never silently
   * re-routed to the main agent behind the user.
   *
   * The EFFECT lives in `App` (index 12, unchanged); this holds its memory and
   * builds its trigger.
   */
  const dockSeenRef = useRef<readonly string[]>([]);
  // The trigger, as a VALUE (not read from a ref): a fresh identity only when a
  // report actually changed the ids (`sameIds` gates `setSubagents`), so the
  // App's effect runs on a real change and never on a frame (LOW-4).
  const dockIdKey = [
    ...(subagents ?? []).map((r) => r.id),
    ...(jobRows ?? []).map((r) => r.id),
  ].join(" ");

  /**
   * A job's drawer READS its output: at once on open, then at most once a second
   * (`JOB_REFRESH_MS`), and only while that job's drawer is open — never for a
   * child, the dropdown, or a job nobody opened (docs/feat/shell-jobs-panel.md).
   *
   * The interval is created ONCE per open job target in `App`, keyed by its WIRE
   * id, so a re-render (or a fresh read) cannot re-arm it: its dependency list
   * names only the focus kind, the target id and the test seam — never the
   * output state (AGENTS §9, M4).
   */
  const jobTargetId =
    dock.focus.kind === "open" && dockKindOf(dock.focus.id) === "job" ? dock.focus.id : null;
  const jobEndedWhileOpen = dock.focus.kind === "open" ? dock.focus.ended : null;
  // The real cadence, or a test's shortened one (AGENTS §9, M4: ONE seam).
  const refreshMs = jobRefreshMs ?? JOB_REFRESH_MS;

  /**
   * Stop one child (`session/agent_kill`) — the `ctrl+x` then `ctrl+x` arm's
   * second step (docs/feat/subagent-panel.md, owner P4 (a)). A refusal is a
   * notice, never a throw; the row leaves on the daemon's next list update, and
   * the transcript gets the existing exit notice (`backgroundExitNotice`).
   */
  const killChild = useCallback(
    (id: string): void => {
      const session = sessionRef.current;
      if (!session?.killSubagent) {
        pushNotice("_this session cannot stop background sub-agents: no agent kill here_");
        return;
      }
      void session.killSubagent(id).then(
        (result) => {
          if (!result.killed) {
            pushNotice(`_${id} was not running any more: nothing was stopped_`);
          }
        },
        (error: unknown) =>
          pushNotice(
            `_${id} was not stopped: ${error instanceof Error ? error.message : String(error)}_`,
          ),
      );
    },
    [sessionRef, pushNotice],
  );

  /**
   * Stop one background SHELL job (`session/job_kill`, docs/feat/shell-jobs-panel.md):
   * the same decision the model's `shell_kill` tool makes. A refusal is a typed
   * result, never a throw: the row is still there, and the exit frame (or the
   * notice) says what happened.
   */
  const killJob = useCallback(
    (id: string): void => {
      const session = sessionRef.current;
      if (!session?.killJob) {
        pushNotice("_this session cannot stop background jobs: no job kill here_");
        return;
      }
      void session.killJob(id).then(
        (result) => {
          if (result.killed) {
            // Recorded BEFORE the exit can arrive, so `onExit` reads it: this is
            // the user's own stop (`✗ stopped`, owner B).
            dockStoppedRef.current.add(id);
          } else {
            pushNotice(`_${id} was not running any more: nothing was stopped_`);
          }
        },
        (error: unknown) =>
          pushNotice(
            `_${id} was not stopped: ${error instanceof Error ? error.message : String(error)}_`,
          ),
      );
    },
    [sessionRef, pushNotice],
  );

  /**
   * `/agents` and Ctrl+T (docs/feat/subagent-panel.md, owner Q16 (b)): move the
   * focus into the list from anywhere (a multi-line draft, mid-history), or
   * back. An empty list says so instead of opening an empty box.
   */
  const toggleAgents = useCallback((): void => {
    if (dockRef.current.focus.kind === "list") {
      setDock((prev) => toggleList(prev, dockIds()));
      return;
    }
    if (!dockVisible()) {
      pushNotice("_Nothing is running in the background._");
      return;
    }
    setDock((prev) => toggleList(prev, dockIds()));
  }, [dockIds, dockVisible, pushNotice, setDock]);

  /**
   * Send the dock's draft to whoever owns it (docs/feat/subagent-panel.md): the
   * main agent (as today), one child (`session/subagent_message`), or a refusal
   * with the reason as a notice and the text put back. The decision is pure
   * (`sendTarget`), so an ended child is never silently re-routed to the agent.
   * `true` means the dock handled the text; the caller's own path must not run.
   */
  const submitToTarget = useCallback(
    (value: string): boolean => {
      const target = sendTarget(dockRef.current, value);
      if (target.kind === "main") {
        return false; // the caller's normal path (a task, a command, a blank draft)
      }
      if (target.kind === "refused") {
        field.set(value);
        pushNotice(`_${target.text}_`);
        return true;
      }
      const id = target.id;
      const text = value.trim();
      const session = sessionRef.current;
      if (!session?.messageSubagent) {
        field.set(value);
        // NOT "older daemon": that would be a typed refusal from
        // `messageSubagent` (`RemoteClient`), never a missing member. A missing
        // one means THIS runtime's session has no sub-agent panel at all (e.g.
        // `--in-process`), which is what the notice says.
        pushNotice("_this session's runtime cannot write to sub-agents_");
        return true;
      }
      field.reset();
      // A LATE refusal must never land in the main input (Review H2): by the time
      // it arrives the user may have closed the child, so the placement decision
      // is `refusalPlacement`'s — the field only if they are still on that child
      // and have typed nothing since; otherwise the notice quotes the text.
      const refused = (reason: string): void => {
        const placement = refusalPlacement(dockRef.current, id, fieldValueRef.current);
        if (placement === "field") {
          field.set(value);
          pushNotice(`_not sent to ${id}: ${reason}_`);
          return;
        }
        setDock((prev) => restoreRefused(prev, id, value));
        pushNotice(`_not sent to ${id}: ${reason} — kept as a draft: ${value}_`);
      };
      void session.messageSubagent(id, text).then(
        (result) => {
          if (!result.ok) {
            refused(result.reason ?? "refused");
          }
        },
        (error: unknown) => {
          refused(error instanceof Error ? error.message : String(error));
        },
      );
      return true;
    },
    [field, fieldValueRef, sessionRef, pushNotice, setDock],
  );

  return {
    subagents,
    subagentsRef,
    setAgents,
    dockLastRowsRef,
    jobRows,
    jobRowsRef,
    setJobs,
    dockLastJobRowsRef,
    dockOutcomeRef,
    dockFinishedRef,
    dockStoppedRef,
    jobOutputRef,
    setJobOutputGen,
    jobReadAtRef,
    dock,
    dockRef,
    setDock,
    dockIds,
    dockVisible,
    drawerRow,
    drawerJob,
    dockSeenRef,
    dockIdKey,
    jobTargetId,
    jobEndedWhileOpen,
    refreshMs,
    killChild,
    killJob,
    toggleAgents,
    submitToTarget,
  };
}
