/**
 * The computer's workflow runs, as the Workflows screen and the hub read them
 * (docs/feat/workflows-ui.md D4, slice 3). Pure and injected (AGENTS §7): the
 * client's `workflowList()` and its `onSessionWorkflows` notices come in as
 * functions, the timer too, so every rule below is tested with fakes.
 *
 * The rules:
 * - **When it is read:** on focus, on a pull, and on any session's `workflows`
 *   notice — debounced (`RUNS_DEBOUNCE_MS`), because a running step reports often
 *   and the list is a whole-computer read. One read at a time: a trigger during a
 *   read is ONE more read after it.
 * - **An older daemon** (`MethodNotFound` → `{unsupported:true}`) is its own
 *   state: "Update tentacle on this computer", never an empty list.
 * - **A dropped link** keeps the last list and says it is offline; it does not
 *   retry in a loop (the next focus / pull / notice reads again).
 * - Nothing is read while the screen is away (`blur`), and nothing lands after
 *   `dispose`.
 */
import type { WorkflowCatalogueResult, WorkflowListResult } from "@tentacle/protocol";
import { type ElencoRun, fromListRow, needsUserCount } from "./workflow-list.ts";

/** A burst of `workflows` frames is one read, this long after the last. */
export const RUNS_DEBOUNCE_MS = 500;
/** The line under a kept list when the last read could not reach the computer. */
export const WORKFLOWS_OFFLINE = "Offline — showing the last list";
/** What an older daemon (no `workflow/list`) gets instead of a list. */
export const WORKFLOWS_UPDATE_TENTACLE = "Update tentacle on this computer";

export interface RunsState {
  /** `loading` until the first answer; `error` only when no list was ever read. */
  readonly kind: "loading" | "ready" | "unsupported" | "error";
  /** The runs, in the daemon's order (`elencoSections` splits them). */
  readonly runs: readonly ElencoRun[];
  /** Set while a kept list is shown because the last read failed. */
  readonly offline: string | null;
  /** The first read's failure, when `kind` is `error`. */
  readonly error?: string;
}

export interface WorkflowRunsDeps {
  /** `RemoteClient.workflowList()`. */
  readonly load: () => Promise<WorkflowListResult | { unsupported: true }>;
  /** `RemoteClient.onSessionWorkflows`, any session (returns the unsubscribe). */
  readonly onNotice: (listener: () => void) => () => void;
  /** The debounce's timer (`setTimeout` in the app). */
  readonly schedule: (fn: () => void, ms: number) => { cancel(): void };
  /** Told on every state change: the screen re-renders. */
  readonly onChange?: (state: RunsState) => void;
}

export interface WorkflowRunsController {
  state(): RunsState;
  /** The screen is shown: listen to notices and read. */
  focus(): void;
  /** Pull to refresh. */
  pull(): void;
  /** The screen went away: stop listening (a kept list stays). */
  blur(): void;
  dispose(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkflowRunsController(deps: WorkflowRunsDeps): WorkflowRunsController {
  let state: RunsState = { kind: "loading", runs: [], offline: null };
  let reading = false;
  let again = false;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  let timer: { cancel(): void } | null = null;

  function commit(next: RunsState): void {
    state = next;
    deps.onChange?.(next);
  }

  function landed(answer: WorkflowListResult | { unsupported: true }): void {
    if ("unsupported" in answer) {
      commit({ kind: "unsupported", runs: [], offline: null });
      return;
    }
    commit({ kind: "ready", runs: answer.runs.map(fromListRow), offline: null });
  }

  function failed(error: unknown): void {
    if (state.kind === "ready") {
      commit({ ...state, offline: WORKFLOWS_OFFLINE });
      return;
    }
    commit({ kind: "error", runs: [], offline: null, error: errorText(error) });
  }

  function read(): void {
    if (disposed) {
      return;
    }
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    again = false;
    let answer: Promise<WorkflowListResult | { unsupported: true }>;
    try {
      answer = deps.load();
    } catch (error) {
      answer = Promise.reject(error);
    }
    void answer.then(
      (result) => {
        reading = false;
        if (!disposed) {
          landed(result);
          if (again) {
            read();
          }
        }
      },
      (error: unknown) => {
        reading = false;
        if (!disposed) {
          failed(error);
          if (again) {
            read();
          }
        }
      },
    );
  }

  function onNotice(): void {
    timer?.cancel();
    timer = deps.schedule(() => {
      timer = null;
      read();
    }, RUNS_DEBOUNCE_MS);
  }

  function stopListening(): void {
    unlisten?.();
    unlisten = null;
    timer?.cancel();
    timer = null;
  }

  return {
    state: () => state,
    focus() {
      if (disposed) {
        return;
      }
      if (unlisten === null) {
        unlisten = deps.onNotice(onNotice);
      }
      read();
    },
    pull: read,
    blur: stopListening,
    dispose() {
      disposed = true;
      stopListening();
    },
  };
}

/**
 * The project's workflow files, as the hub's dim rule needs them
 * (docs/fix/workflows-ux.md D6): how many it can start, and the reason the
 * session cannot run workflows at all. `known:false` — not read yet, an older
 * daemon, a failed read — is UNKNOWN, which never dims the item whose tap is
 * what reads the list (the Tools D3 rule).
 */
export interface CatalogueFigure {
  readonly known: boolean;
  /**
   * Every listed file, broken ones included (plan D6: "the catalogue lists ≥ 1
   * workflow"): a broken YAML is still a workflow in this project, and the start
   * screen is where its errors are read — "No workflows in this project" would lie.
   */
  readonly count: number;
  /** `unavailable`'s own text (a pod's daemon), else null. */
  readonly unavailable: string | null;
}

/** The catalogue answer as the hub's fact, folded once so the rule never re-derives it. */
export function catalogueFigure(
  answer: WorkflowCatalogueResult | { unsupported: true } | null,
): CatalogueFigure {
  // An older daemon is UNKNOWN, not empty: `Update tentacle` is the run list's
  // own line (`workflowsHub`), and a project it cannot read must not be called
  // empty because of a version.
  if (answer === null || "unsupported" in answer) {
    return { known: false, count: 0, unavailable: null };
  }
  if (answer.unavailable !== undefined) {
    return { known: true, count: 0, unavailable: answer.unavailable };
  }
  return { known: true, count: answer.workflows.length, unavailable: null };
}

/**
 * The hub's Workflows figure (D4, D6): how many live runs wait on the person, and
 * why there is nothing to open. `undefined` while the run list is not known (still
 * loading, or the first read failed): an unknown list never dims the item whose
 * tap is what reads it.
 *
 * An EMPTY list is NOT a reason to dim (docs/feat/workflow-editor.md D8
 * "Entries" + E1, which supersede docs/feat/workflows-ui.md D4's "dimmed when
 * `workflow/list` returned none"): the runs screen's empty state is the "New
 * workflow" button, and this item is the ONLY door to that screen. Dimming an
 * empty list would make the first workflow unreachable from the phone — the
 * dead end flow 44 hit on device. Only an older daemon still dims: there is no
 * usable screen behind it.
 *
 * The catalogue adds one dim: `unavailable` (a pod's daemon can run no workflow).
 * A known-EMPTY catalogue never dims (the runs screen's "New workflow" is how the
 * first file is made).
 */
export function workflowsHub(
  state: RunsState,
  catalogue: CatalogueFigure | null = null,
): { readonly needYou: number; readonly empty: string | null } | undefined {
  if (state.kind === "unsupported") {
    return { needYou: 0, empty: WORKFLOWS_UPDATE_TENTACLE };
  }
  if (state.kind !== "ready") {
    return undefined;
  }
  const needYou = needsUserCount(state.runs);
  if (state.runs.length === 0 && catalogue?.unavailable != null) {
    return { needYou, empty: catalogue.unavailable };
  }
  return { needYou, empty: null };
}
