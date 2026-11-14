/**
 * `HopRuntime` — the ONE thing `startTui` gets when the session may move
 * (docs/feat/session-hop.md D2). Every member `startTui` asks for (`createSession`,
 * `jobs`, `link`, `mcpStatus`) has ONE stable identity and delegates to the
 * runtime of the place the session is at NOW; a hop swaps what they delegate to
 * without the TUI re-mounting. `current()` + `onTarget` is the other half: the
 * badge, `/mcp` and spilled output read the place live.
 *
 * It is also the only holder of the broker and the saver: every target factory
 * is handed the SAME instances (AGENTS §7, single broker — a second
 * `PermissionBroker` would silently auto-approve every ask daemon-side).
 */
import type { LoadResult } from "@tentacle/agent";
import type { JobController, PermissionBroker } from "@tentacle/core";
import type { McpServerStatus } from "@tentacle/protocol";
import type { HopSpec, LinkStatusView, SessionController, TargetBadge } from "@tentacle/tui";
import { type HopPlace, placeText } from "./hop-plan.ts";
import type { LocalRuntime } from "./local-runtime.ts";
import { type HopBuild, type HopBuilt, type HopOutcome, hopSession } from "./session-hop.ts";
import type { SessionSaver } from "./session-saver.ts";

/** The two instances every runtime of this session is built on (never copies). */
export interface HopShared {
  readonly permissions: PermissionBroker;
  readonly saver: SessionSaver;
}

/** Where the session is, as the TUI paints it (`local`: no badge, D3). */
export interface HopTargetView {
  readonly place: HopPlace;
  readonly badge?: TargetBadge;
  readonly daemonInPod: boolean;
  /** The daemon session's own cwd after a hop (D4 of docs/fix/session-hop-live.md). */
  readonly cwd?: string;
}

export interface HopRuntimeDeps {
  /** The runtime the TUI started on (a worker, a container, an attach). */
  readonly initial: LocalRuntime;
  readonly startup: HopTargetView;
  /** The ONE broker, and the ONE saver: handed to every factory below. */
  readonly shared: HopShared;
  /**
   * Build the target (H4's factories — never a copy of an existing builder):
   * given the shared broker and saver, it provisions, attaches or spawns, and
   * returns the runtime plus how to undo it (D1 step 2, D5). `sessionId` is the
   * uid the target must take (D1 step 3: `resume: null` plus the minted uid).
   */
  readonly build: (
    spec: HopSpec,
    shared: HopShared,
    sessionId: string,
    opts: { readonly gateAnswered?: true },
  ) => Promise<HopBuild>;
  /** The laptop's record of a uid (`LogSessionStore.load`): the seed (D1 step 3/4b). */
  readonly load: (uid: string) => Promise<LoadResult>;
  /** A phase line while a hop runs; `null` clears it (the TUI's status row). */
  readonly status?: (line: string | null) => void;
  /**
   * The TUI's half of the commit: swap to `built`'s controller with
   * `keepTranscript`, turn auto-accept off (D3, D9). Awaited, and its throw is
   * one notice — the hop is never rolled back after this point (review M3).
   */
  readonly onSwap?: (built: HopBuilt) => void | Promise<void>;
  /** The D5 decision for the place we left (delete/keep + its notice). */
  readonly afterLeave?: (spec: HopSpec) => Promise<string | null>;
}

export interface HopRuntime {
  readonly createSession: () => SessionController;
  readonly jobs: JobController;
  readonly link: LocalRuntime["link"];
  readonly mcpStatus: () => Promise<readonly McpServerStatus[]>;
  /** The runtime of the place the session is at now. */
  current(): LocalRuntime;
  /** Where the session is now (`targetFeed.current()`). */
  target(): HopTargetView;
  /** Told of every move (the badge, `daemonInPod`): `() => unsubscribe`. */
  onTarget(listener: (view: HopTargetView) => void): () => void;
  /**
   * Move this session to `spec`'s target (D1). One at a time: the caller holds
   * the `hopping` latch (`hopPlan`), so a second call would be a second build.
   */
  hop(
    spec: HopSpec,
    sessionId: string | null,
    opts?: { readonly gateAnswered?: true },
  ): Promise<HopOutcome>;
  /** Dispose the current runtime: after the TUI has unmounted. */
  dispose(): Promise<void>;
}

export function createHopRuntime(deps: HopRuntimeDeps): HopRuntime {
  let current = deps.initial;
  let view = deps.startup;
  const listeners = new Set<(view: HopTargetView) => void>();
  /**
   * A listener of the CURRENT runtime's link. Re-subscribed on every swap (the
   * old runtime is being disposed: its statuses are no longer the session's),
   * through this one indirection, so the TUI's subscription never changes.
   */
  const linkListeners = new Set<(status: LinkStatusView) => void>();
  let detachLink: (() => void) | null = null;
  const relink = (): void => {
    detachLink?.();
    detachLink = current.link.onLinkStatus((status) => {
      for (const listener of linkListeners) {
        listener(status);
      }
    });
  };
  relink();
  /**
   * The same indirection for the job feeds (D2: "listeners are re-subscribed on
   * swap"). `onStart`/`onExit` bind to the runtime that was current when the
   * TUI subscribed, so without this a hop silences every later job exit
   * (review H2 round 2, MEDIUM).
   */
  type JobStartListener = Parameters<JobController["onStart"]>[0];
  type JobExitListener = Parameters<JobController["onExit"]>[0];
  const startListeners = new Set<JobStartListener>();
  const exitListeners = new Set<JobExitListener>();
  let detachJobs: Array<() => void> = [];
  const rejobs = (): void => {
    for (const off of detachJobs) {
      off();
    }
    detachJobs = [
      current.jobs.onStart((job) => {
        for (const listener of startListeners) {
          listener(job);
        }
      }),
      current.jobs.onExit((job) => {
        for (const listener of exitListeners) {
          listener(job);
        }
      }),
    ];
  };
  rejobs();

  const announce = (next: HopTargetView): void => {
    view = next;
    for (const listener of listeners) {
      listener(view);
    }
  };

  return {
    createSession: () => current.createSession(),
    jobs: {
      // A `JobController` view whose capability is the CURRENT runtime's
      // (only `onExit` is live, exactly as `remoteJobsView` gives it).
      start: (...args) => current.jobs.start(...args),
      read: (id) => current.jobs.read(id),
      kill: (id) => current.jobs.kill(id),
      list: () => current.jobs.list(),
      dispose: () => current.jobs.dispose(),
      onStart: (listener) => {
        startListeners.add(listener);
        return () => {
          startListeners.delete(listener);
        };
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
    },
    link: {
      onLinkStatus: (listener) => {
        linkListeners.add(listener);
        return () => {
          linkListeners.delete(listener);
        };
      },
    },
    mcpStatus: () => current.mcpStatus(),
    current: () => current,
    target: () => view,
    onTarget: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hop: async (spec, sessionId, opts) => {
      // ONE at a time: the caller holds the `hopping` latch (`hopPlan`), so a
      // second `/move` while this runs is refused before it reaches here.
      const old = current;
      const outcome = await hopSession(
        old,
        { spec, sessionId, ...(opts?.gateAnswered ? { gateAnswered: true as const } : {}) },
        {
          build: (target, id, buildOpts) => deps.build(target, deps.shared, id, buildOpts),
          load: deps.load,
          ...(deps.status ? { status: deps.status } : {}),
          onCommit: async (built, facts) => {
            // The facade moves FIRST: a listener swapped after the runtime would
            // paint a status from a runtime nobody is on any more.
            current = built.runtime;
            relink();
            rejobs();
            const badge = badgeOf(built.place);
            announce({
              place: built.place,
              ...(badge ? { badge } : {}),
              daemonInPod: built.daemonInPod,
              // D4: the session's own cwd on the target (absent → the laptop's).
              ...(facts.cwd === undefined ? {} : { cwd: facts.cwd }),
            });
            await deps.onSwap?.(built);
          },
          // `afterLeave` is passed through as it is: `hopSession` is the ONE
          // place that turns its throw into a notice (step 5 never rejects).
          ...(deps.afterLeave ? { afterLeave: deps.afterLeave } : {}),
        },
      );
      deps.status?.(null);
      // The outcome is NOT notified here: the TUI owns its one line, moved or
      // failed (`hopMovedNotice` + the feed's `note`; docs/fix/session-hop-live.md D2).
      // A failed hop leaves the old runtime where it was: the badge does not move.
      return outcome;
    },
    dispose: async () => {
      detachLink?.();
      for (const off of detachJobs) {
        off();
      }
      detachJobs = [];
      listeners.clear();
      startListeners.clear();
      exitListeners.clear();
      await current.dispose();
    },
  };
}

/** The badge a place paints (D3: `local` has none, as today). */
function badgeOf(place: HopPlace): TargetBadge | null {
  return place.kind === "local"
    ? null
    : {
        engine: place.engine,
        name: place.name,
        ...(place.container === undefined ? {} : { container: place.container }),
      };
}

/** The badge's own text, for a notice or a test (`docker:box/app`). */
export function hopTargetText(view: HopTargetView): string {
  return placeText(view.place);
}
