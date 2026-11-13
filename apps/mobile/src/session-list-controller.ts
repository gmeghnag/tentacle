/**
 * The session list's network side, kept out of the component
 * (docs/feat/mobile-app-shell.md "Session list"; AGENTS §7 — a component only
 * renders). `createSessionListController` owns the request lifecycle around the
 * pure reducer in `session-list.ts`: which request is in flight, which page it
 * asks for, and dropping answers for a screen that is gone.
 *
 * Everything async is injected (`load`, `now`), so the rules below are tested
 * without React or a daemon:
 * - one request at a time; a refresh supersedes an in-flight page;
 * - an answer that arrives after `dispose()` changes nothing (a screen gone);
 * - the reducer's generation counter is what actually drops a superseded page.
 */
import {
  type PendingPage,
  type SessionListAction,
  type SessionListState,
  type SessionPage,
  type SessionSections,
  describeError,
  initialSessionList,
  reduce,
  rows as rowsOf,
} from "./session-list.ts";

/** What the screen needs from `session/list`, injected (the client's own call). */
export type SessionPageLoader = (params: { readonly cursor?: string }) => Promise<SessionPage>;

export interface SessionListController {
  /** The current state; the screen re-renders on change. */
  state(): SessionListState;
  subscribe(listener: (state: SessionListState) => void): () => void;
  /** Ask for page one (screen focus, pull-to-refresh, link up, foreground). */
  refresh(): Promise<void>;
  /** Ask for the next page (the list end). */
  more(): Promise<void>;
  /** The link went down/up (from the client's `onLinkStatus`). */
  link(up: boolean): void;
  /** Stop delivering: the screen unmounted. In-flight answers are dropped. */
  dispose(): void;
}

export interface SessionListDeps {
  readonly load: SessionPageLoader;
  /** The clock for the row subtitles (injected: no `Date.now` in a test). */
  readonly now: () => number;
}

export function createSessionListController(deps: SessionListDeps): SessionListController {
  let state = initialSessionList;
  let disposed = false;
  const listeners = new Set<(state: SessionListState) => void>();

  function emit(): void {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  }

  function dispatch(action: SessionListAction): SessionListState {
    state = reduce(state, action);
    emit();
    return state;
  }

  /** The page a request of `pending` asks for, from the CURRENT state. */
  function params(pending: PendingPage): { readonly cursor?: string } {
    if (pending === "next" && state.cursor !== undefined) {
      return { cursor: state.cursor };
    }
    return {};
  }

  async function run(action: "refresh" | "more"): Promise<void> {
    if (disposed) {
      return;
    }
    const next = dispatch({ type: action });
    if (next.pending === null) {
      return; // nothing to ask (e.g. `more` at the end of the list)
    }
    const pending = next.pending;
    const generation = next.generation;
    try {
      const page = await deps.load(params(pending));
      if (disposed) {
        return;
      }
      dispatch({ type: "page", page, generation });
    } catch (error) {
      if (disposed) {
        return;
      }
      dispatch({ type: "fail", error: describeError(error).message, generation });
    }
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => run("refresh"),
    more: () => run("more"),
    link(up: boolean) {
      if (disposed) {
        return;
      }
      const before = state;
      dispatch({ type: "link", up });
      // Coming back up with rows to re-read: refresh, so a list read before the
      // drop converges instead of staying stale forever.
      if (up && before.stale && state.entries.length > 0) {
        void run("refresh");
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

/** The rows the screen renders, from a state and a clock. */
export function viewModel(
  state: SessionListState,
  now: number,
): {
  readonly status: SessionListState["status"];
  readonly stale: boolean;
  readonly error?: string;
  readonly empty: boolean;
  readonly sections: SessionSections;
  readonly canLoadMore: boolean;
} {
  const sections = rowsOf(state.entries, now);
  return {
    status: state.status,
    stale: state.stale,
    ...(state.error === undefined ? {} : { error: state.error }),
    empty: state.entries.length === 0 && state.status === "loaded",
    sections,
    canLoadMore: state.cursor !== undefined && state.pending === null,
  };
}
