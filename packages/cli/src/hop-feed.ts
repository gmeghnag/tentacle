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
import { workloadText } from "@tentacle/tui";
import type { SessionController } from "@tentacle/tui";
import type { SessionEvent } from "@tentacle/tui";
import type { HopProposalView } from "@tentacle/tui";
import type { KubeNamespace } from "./engine-select.ts";
import type { HopPlace } from "./hop-plan.ts";
import type { HopNamespacePin, HopPromptFacts } from "./hop-proposal.ts";
import type { HopRuntime } from "./hop-runtime.ts";
import {
  type HopProposalOutcome,
  type HopTurnWatch,
  type HopWakeFact,
  MOVE_DECLINED_LINE,
  NO_HOP_TURN,
  hopAskAtTurnEnd,
  hopTurnEnd,
  hopTurnStep,
  hopWakeLine,
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
  /**
   * OD1/OD2: resolve a PROPOSAL's k8s namespace at the turn's end, BEFORE the
   * owner is asked, and write it into the spec — so the prompt shows the place
   * that will really be dialled, and a kubeconfig change between the prompt and
   * the build can no longer move the target. Absent → the spec is asked for as
   * the model wrote it (a host with no k8s at all, or a test).
   */
  readonly pinNamespace?: (spec: HopSpec) => HopNamespacePin;
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
   * thing the next prompt must carry — a typed FACT since
   * docs/feat/session-hop-ux OD6 (`HopWakeFact`), rendered by `hopWakeLine` at the
   * moment it is taken, so the auto-accept mode it states is the TUI's LIVE one.
   * Both are state of the SESSION the feed follows, not of a run.
   */
  let turnWatch: HopTurnWatch = NO_HOP_TURN;
  let pending: HopWakeFact | null = null;
  /**
   * The fact the LAST `takeLine` handed out, kept so a prompt that never ran can
   * put it back (`restoreLine`): otherwise a send failure (a link down, a lost
   * slot) would destroy the only record that the session moved, and the model
   * would go on assuming it had not (docs/feat/session-hop-ux, failure mode
   * "Wake prompt fails to send").
   */
  let taken: HopWakeFact | null = null;
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
      // OD1/OD2: the PROPOSAL's namespace is resolved HERE, before the owner is
      // asked, and written into the spec — so the prompt shows the place that will
      // really be dialled, and a kubeconfig that changes before the build cannot
      // move the target. A resolution that fails asks NOTHING and builds nothing.
      const pin = pinAtTurnEnd(ended, deps.pinNamespace);
      if (!pin.ok) {
        // The namespace could not be resolved at all (no kubeconfig, no context):
        // nothing is asked and nothing is built, and the model is TOLD and woken —
        // silence would read as "the move happened" (failure mode 1, OD6).
        pending = { kind: "failed", reason: pin.line };
        return { kind: "failed" };
      }
      const outcome: HopProposalOutcome = pin.ok
        ? await hopAskAtTurnEnd(
            pin.pending,
            (spec) => {
              const facts = deps.promptFacts?.(spec) ?? {};
              // OD3: the provenance rides the prompt beside the place it belongs
              // to, so a live test answers "why that namespace" from the prompt.
              return pin.namespace === undefined ? facts : { ...facts, namespace: pin.namespace };
            },
            (request) => broker.request(request),
            // OD4: where the proposal comes from is a LAPTOP fact (this feed's own
            // `place()`), and it is the input to `hopAutoAcceptable` — never the
            // model's arguments, which a pod chooses.
            deps.place(),
          ).catch(() => ({ kind: "declined", line: MOVE_DECLINED_LINE }) as HopProposalOutcome)
        : { kind: "none" };
      if (outcome.kind === "approved") {
        return {
          kind: "approved",
          spec: outcome.spec,
          ...(outcome.gateAnswered ? { gateAnswered: true as const } : {}),
          ...(outcome.autoAccepted ? { autoAccepted: true as const } : {}),
          // OD3: the pin's provenance, resolved ONCE at the turn's end, rides the
          // approval to the build (else the build re-resolves the value the pin
          // wrote and reports `explicit` — fix round 2, finding 1).
          ...(pin.namespace === undefined ? {} : { namespace: pin.namespace }),
        };
      }
      if (outcome.kind === "declined") {
        // The model is told in the NEXT prompt, as part of the user message (M7).
        pending = { kind: "declined" };
        return { kind: "declined" };
      }
      return { kind: "none" };
    },
    takeLine: (ctx) => {
      // CONSUMED: it belongs to exactly one prompt, so it cannot repeat. Rendered
      // HERE, not when the fact was recorded: OD6's `auto-accept on|off` is the
      // TUI's live value, so the line can never state a stale mode.
      const fact = pending;
      pending = null;
      taken = fact;
      return fact === null ? null : hopWakeLine(fact, ctx);
    },
    restoreLine: () => {
      // That prompt never ran (its send failed): the fact goes back, so the NEXT
      // real prompt carries it. A fact recorded since is the newer truth (it
      // describes where the session is NOW) and wins — the old one is dropped
      // rather than delivered as a stale place.
      if (taken !== null && pending === null) {
        pending = taken;
      }
      taken = null;
    },
    clearPending: () => {
      // A `/clear` swaps the session: a fact about the OLD one (its place, its
      // cwd) would be a lie in the new one's first prompt.
      pending = null;
      taken = null;
    },
    start: (spec, sessionId, opts) => {
      const mine = listeners;
      const before = deps.place();
      const done = (async (): Promise<Awaited<HopRun["done"]>> => {
        try {
          const outcome = await deps.facade.hop(spec, sessionId, {
            ...(opts?.gateAnswered === true ? { gateAnswered: true as const } : {}),
            ...(opts?.namespace === undefined ? {} : { namespace: opts.namespace }),
          });
          if (outcome.kind === "failed") {
            // OD6: the model never has to guess — a move it proposed that could
            // not be built is said in the next prompt, exactly like a refusal.
            pending = { kind: "failed", reason: outcome.notice };
            return { failed: outcome.notice };
          }
          // The target's seeded controller, exactly as the hop opened it — never
          // a `createSession`, whose one-shot a racing caller could have taken
          // (docs/fix/session-hop-live.md F2).
          const moved: SessionController = outcome.controller;
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
          // M7/OD6: the model is told, at the start of its next prompt, that the
          // session moved, where to, and what was reset. The place is the facade's
          // own label for where it now is, never an engine's; `folder` is the
          // build's own answer, and the cwd the target daemon reported (absent →
          // the line claims none).
          const view = deps.facade.target();
          pending = {
            kind: "moved",
            place: hopPlaceLabel(view),
            folder: outcome.built.folder,
            ...(view.cwd === undefined ? {} : { cwd: view.cwd }),
          };
          // D2 (docs/fix/session-hop-live.md): the outcome's suffixes ride the
          // TUI's own moved line — the facade no longer notifies the outcome.
          return {
            moved,
            view: deps.facade.target(),
            ...(outcome.note === undefined ? {} : { note: outcome.note }),
          };
        } finally {
          if (listeners === mine) {
            listeners = new Set();
          }
        }
      })().catch((error: unknown): Awaited<HopRun["done"]> => {
        const line = `not moved: ${error instanceof Error ? error.message : String(error)}`;
        // A hop that THREW moved nothing: the model is told that too (OD6), for
        // the same reason a refusal is — silence reads as success.
        pending = { kind: "failed", reason: line };
        return { failed: line };
      });
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
    // ONE label (OD1), so the row and the prompt cannot say it differently.
    return workloadText(spec.workload);
  }
  return spec.image === undefined ? "a container" : `a container (${spec.image})`;
}

/** The place the session is now, as ONE line (`local`, `docker:box`): the model's notice. */
export function hopPlaceLabel(view: HopTargetView): string {
  const place = view.place;
  if (place.kind === "local") {
    return "local";
  }
  return workloadText(place);
}

/**
 * OD1/OD2's pin, as a decision the feed can act on: the spec with its k8s
 * namespace resolved (and the provenance to show), `null` when nothing was
 * proposed, or `{ ok: false }` when the resolution failed — nothing to ask and
 * nothing to build.
 */
function pinAtTurnEnd(
  state: HopTurnWatch,
  pin: HopFeedDeps["pinNamespace"],
):
  | { readonly ok: true; readonly pending: HopTurnWatch; readonly namespace?: KubeNamespace }
  | { readonly ok: false; readonly line: string } {
  const proposed = state.proposal;
  if (!state.ended || proposed === undefined || pin === undefined) {
    return { ok: true, pending: state };
  }
  const pinned = pin(proposed.spec);
  if (pinned.kind === "failed") {
    return { ok: false, line: pinned.line };
  }
  return {
    ok: true,
    ...(pinned.namespace === undefined ? {} : { namespace: pinned.namespace }),
    pending: {
      ...state,
      proposal: {
        spec: pinned.spec,
        ...(proposed.reason === undefined ? {} : { reason: proposed.reason }),
      },
    },
  };
}
