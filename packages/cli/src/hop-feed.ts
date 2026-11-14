import type { PermissionBroker } from "@tentacle/core";
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
import type { HopFeed, HopRun, HopSpec, HopTargetView } from "@tentacle/tui";
import type { SessionController } from "@tentacle/tui";
import type { SessionEvent } from "@tentacle/tui";
import type { HopProposalView } from "@tentacle/tui";
import type { HopPlace } from "./hop-plan.ts";
import type { HopPromptFacts } from "./hop-proposal.ts";
import type { HopRuntime } from "./hop-runtime.ts";
import {
  type HopProposalOutcome,
  type HopTurnWatch,
  MOVE_DECLINED_LINE,
  NO_HOP_TURN,
  hopAskAtTurnEnd,
  hopTurnEnd,
  hopTurnStep,
  moveGuideLine,
} from "./hop-turn.ts";

export interface HopFeedDeps {
  readonly facade: HopRuntime;
  /** The place the session is at now, as the PLAN's `HopPlace` (`local` = no badge). */
  readonly place: () => HopPlace;
  /** One notice for a line the hop itself must report (a delete's fate). */
  readonly notify?: (text: string) => void;
  /** The D5 decision for the place we LEAVE, after the commit; `null` = nothing to say. */
  readonly leave?: (before: HopPlace, keep: boolean) => Promise<string | null>;
  /**
   * The ONE broker every ask goes through (AGENTS §7, P2): a proposed move's
   * `session_hop` prompt is raised on it, exactly as the mount gate's is. Absent
   * (a host with no broker) → a proposal can never be approved, which is honest:
   * nothing moves without the owner.
   */
  readonly permissions?: PermissionBroker;
  /**
   * The facts a proposed move's prompt shows (D9/M6): the mount the plan would
   * use, the workload being left. Absent → the prompt shows only what the spec
   * itself says (still one complete prompt).
   */
  readonly promptFacts?: (spec: HopSpec) => HopPromptFacts;
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
  /**
   * The turn being watched (docs/feat/session-hop.md D9, slice H5), and the ONE
   * line the next prompt must carry (`[move declined]` / `[session moved to …]`,
   * review M7). Both are state of the SESSION the feed follows, not of a run.
   */
  let turnWatch: HopTurnWatch = NO_HOP_TURN;
  let pendingLine: string | null = null;
  const hop: HopFeed = {
    label: (spec) => hopLabel(spec),
    // --- H5: the model's proposal, and the ONE prompt it becomes -----------
    turn: (event: SessionEvent, own: boolean) => {
      turnWatch = hopTurnStep(turnWatch, event, own);
    },
    turnEnd: async (own: boolean): Promise<HopProposalView> => {
      const ended = hopTurnEnd(turnWatch);
      turnWatch = NO_HOP_TURN; // a turn is watched once
      const broker = deps.permissions;
      if (!own || broker === undefined) {
        return { kind: "none" };
      }
      const outcome: HopProposalOutcome = await hopAskAtTurnEnd(
        ended,
        (spec) => deps.promptFacts?.(spec) ?? {},
        (request) => broker.request(request),
      ).catch(() => ({ kind: "declined", line: MOVE_DECLINED_LINE }) as HopProposalOutcome);
      if (outcome.kind === "approved") {
        return {
          kind: "approved",
          spec: outcome.spec,
          ...(outcome.gateAnswered ? { gateAnswered: true as const } : {}),
        };
      }
      if (outcome.kind === "declined") {
        // The model is told in the NEXT prompt, as part of the user message (M7).
        pendingLine = outcome.line;
        return { kind: "declined" };
      }
      return { kind: "none" };
    },
    takeLine: () => {
      // CONSUMED: it belongs to exactly one prompt, so it cannot repeat.
      const line = pendingLine;
      pendingLine = null;
      return line;
    },
    start: (spec, sessionId, opts) => {
      const mine = listeners;
      const before = deps.place();
      const done = (async (): Promise<Awaited<HopRun["done"]>> => {
        try {
          const outcome = await deps.facade.hop(spec, sessionId, {
            ...(opts?.gateAnswered === true ? { gateAnswered: true as const } : {}),
          });
          if (outcome.kind === "failed") {
            return { failed: outcome.notice };
          }
          // The target's controller, as the facade hands it out: its
          // `createSession` delegates to the runtime the commit swapped (D2).
          const moved: SessionController = deps.facade.createSession();
          // D5: the workload we left, once the session is safely on the target.
          // `spec.keep` IS the decision (`/move` resolves the default to `true`,
          // `hop-command.ts:124`): for a hop BACK to local the target is `local`,
          // so any expression over `spec.target` would turn a plain `/move local`
          // into `keep: false` and delete the container the hop created.
          if (deps.leave && before.kind !== "local") {
            const notice = await deps.leave(before, spec.keep);
            if (notice !== null) {
              deps.notify?.(notice);
            }
          }
          // M7: the model is told, at the start of its next prompt, that the
          // session moved and what was reset. The place is the facade's own text
          // for where it now is (`local`, `docker:box`), never an engine's.
          pendingLine = moveGuideLine(hopPlaceLabel(deps.facade.target()));
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

/** The place the session is now, as ONE line (`local`, `docker:box`): the model's notice. */
export function hopPlaceLabel(view: HopTargetView): string {
  const place = view.place;
  if (place.kind === "local") {
    return "local";
  }
  const container = place.container === undefined ? "" : `/${place.container}`;
  return `${place.engine}:${place.name}${container}`;
}
