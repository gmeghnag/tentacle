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
import type { WorkflowListResult } from "@tentacle/protocol";
import { NO_WORKFLOW_RUNS } from "./hub-actions.ts";
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
 * The hub's Workflows figure (D4): how many live runs wait on the person, and
 * why there is nothing to open. `undefined` while the list is not known (still
 * loading, or the first read failed): an unknown list never dims the item whose
 * tap is what reads it.
 */
export function workflowsHub(
  state: RunsState,
): { readonly needYou: number; readonly empty: string | null } | undefined {
  if (state.kind === "unsupported") {
    return { needYou: 0, empty: WORKFLOWS_UPDATE_TENTACLE };
  }
  if (state.kind !== "ready") {
    return undefined;
  }
  return {
    needYou: needsUserCount(state.runs),
    empty: state.runs.length === 0 ? NO_WORKFLOW_RUNS : null,
  };
}
