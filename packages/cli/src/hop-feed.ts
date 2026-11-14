/**
 * The bridge between the cli's `HopRuntime` facade (D2) and the TUI's two props
 * (`hop` / `targetFeed`, D3 — slice H4's "`main.ts` worker path uses
 * `HopRuntime`"). The machinery stays the facade's; this module adds only what the
 * TUI needs and the facade's fixed sinks cannot give it:
 *
 *   - a PER-RUN status feed: `HopRun.onStatus` is subscribed per start, while the
 *     facade's `status` sink is fixed when the facade is built. `status()` is that
 *     sink: it forwards to the run in flight, and to nobody once it ended.
 *   - `done` never rejects (the App's contract): a facade `hop` that throws is
 *     still `{failed: "not moved: …"}`.
 *
 * Nothing here decides anything: the plan (`hop-plan.ts`), the sequence
 * (`session-hop.ts`) and the effects (`hop-targets.ts`) are all elsewhere.
 */
import type { HopFeed, HopRun, HopSpec, HopTargetView, SessionController } from "@tentacle/tui";
import type { HopPlace } from "./hop-plan.ts";
import type { HopRuntime } from "./hop-runtime.ts";

export interface HopFeedDeps {
  readonly facade: HopRuntime;
  /** The place the session is at now, as the PLAN's `HopPlace` (`local` = no badge). */
  readonly place: () => HopPlace;
  /** One notice for a line the hop itself must report (a delete's fate). */
  readonly notify?: (text: string) => void;
  /** The D5 decision for the place we LEAVE, after the commit; `null` = nothing to say. */
  readonly leave?: (before: HopPlace, keep: boolean) => Promise<string | null>;
}

export interface HopFeedView {
  readonly hop: HopFeed;
  readonly targetFeed: {
    current(): HopTargetView;
    onTarget(l: (v: HopTargetView) => void): () => void;
  };
  /** The facade's `status` sink: the phase line of the run in flight, if any. */
  readonly status: (line: string | null) => void;
}

/** The TUI's props over the facade, and the sink the facade reports phases on. */
export function createHopFeed(deps: HopFeedDeps): HopFeedView {
  let listeners = new Set<(line: string | null) => void>();
  const status = (line: string | null): void => {
    for (const listener of [...listeners]) {
      listener(line);
    }
  };
  const hop: HopFeed = {
    label: (spec) => hopLabel(spec),
    start: (spec, sessionId) => {
      const mine = listeners;
      const before = deps.place();
      const done = (async (): Promise<Awaited<HopRun["done"]>> => {
        try {
          const outcome = await deps.facade.hop(spec, sessionId);
          if (outcome.kind === "failed") {
            return { failed: outcome.notice };
          }
          // The target's controller, as the facade hands it out: its
          // `createSession` delegates to the runtime the commit swapped (D2).
          const moved: SessionController = deps.facade.createSession();
          // D5: the workload we left, once the session is safely on the target.
          if (deps.leave && before.kind !== "local") {
            const notice = await deps.leave(before, spec.target !== "local" && spec.keep !== false);
            if (notice !== null) {
              deps.notify?.(notice);
            }
          }
          return { moved, view: deps.facade.target() };
        } finally {
          if (listeners === mine) {
            listeners = new Set();
          }
        }
      })().catch(
        (error: unknown): Awaited<HopRun["done"]> => ({
          failed: `not moved: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
      return {
        onStatus(listener) {
          // A listener that arrives after this run settled lands in the next
          // run's set: the App subscribes BEFORE it starts watching `done`.
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        done,
      };
    },
    // The facade has no abort of its own: a build is bounded by its target's own
    // failure path (D1 step 2 rolls back), so cancelling is the App's notice.
    cancel: () => {},
  };
  return {
    hop,
    targetFeed: {
      current: () => deps.facade.target(),
      onTarget: (listener) => deps.facade.onTarget(listener),
    },
    status,
  };
}

/** `/move container` before it has a name: the status row's own words (D3). */
export function hopLabel(spec: HopSpec): string {
  if (spec.target === "local") {
    return "local";
  }
  if (spec.target === "attach") {
    const container = spec.workload.container === undefined ? "" : `/${spec.workload.container}`;
    return `${spec.workload.engine}:${spec.workload.name}${container}`;
  }
  return spec.image === undefined ? "a container" : `a container (${spec.image})`;
}
