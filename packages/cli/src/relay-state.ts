/**
 * The relay's state, pure (docs/feat/detached-relay.md): events in, what to
 * record and when to exit out. Idle = the turn is over, no ask pending, no job
 * running; 60 s of it exits (DR-4). A stopped link exits at once. A stop waits
 * for the turn to settle, bounded.
 */
import type { LinkStatus } from "@tentacle/client";
import type { SessionListResult } from "@tentacle/protocol";
import type { OwnerState } from "./run-state.ts";
import { untrustedText } from "./untrusted-text.ts";

/** How long an idle relay stays (DR-4). */
export const RELAY_IDLE_GRACE_MS = 60_000;
/** How long a stop waits for the turn to settle. */
export const RELAY_STOP_BOUND_MS = 5_000;

export type RelayEvent =
  | { readonly type: "turn_started" }
  | { readonly type: "turn_ended"; readonly reason: string }
  | { readonly type: "turn_failed"; readonly message: string }
  | { readonly type: "ask_raised"; readonly tool: string }
  | { readonly type: "ask_gone" }
  | { readonly type: "jobs"; readonly n: number }
  | { readonly type: "link"; readonly status: LinkStatus }
  | { readonly type: "stop" }
  /** A due exit was held back (`exitPlan`): the grace starts over. */
  | { readonly type: "busy" }
  /** Why the workload stays: `detail` of the state left behind. */
  | { readonly type: "note"; readonly detail: string }
  | { readonly type: "tick"; readonly now: number };

export interface RelayModel {
  readonly turn: "none" | "running" | "over";
  readonly asks: number;
  /** The tool of the last ask raised. */
  readonly tool?: string;
  readonly jobs: number;
  readonly stopping: boolean;
  /** The link gave up: the name may no longer be ours. */
  readonly linkStopped: boolean;
  /** The state once nothing is running. */
  readonly rest: "idle" | "interrupted" | "failed";
  readonly detail?: string;
  /** Exit regardless of `exitAt`. */
  readonly exitNow: boolean;
  /** When the exit is due; absent while something holds it back. */
  readonly exitAt?: number;
}

export interface RelayView {
  readonly state: OwnerState;
  readonly tool?: string;
  readonly detail?: string;
}

export const initialRelay: RelayModel = {
  turn: "none",
  asks: 0,
  jobs: 0,
  stopping: false,
  linkStopped: false,
  rest: "idle",
  exitNow: false,
};

/** `model` with an optional field gone. */
function without(model: RelayModel, key: "tool" | "exitAt"): RelayModel {
  const { [key]: _dropped, ...rest } = model;
  return rest;
}

export function relayStep(model: RelayModel, event: RelayEvent): RelayModel {
  // The link stopped: what the turn does afterwards is only that, said already.
  const linkLost = model.linkStopped;
  switch (event.type) {
    case "turn_started":
      return { ...model, turn: "running" };
    case "turn_ended": {
      if (linkLost) {
        return { ...model, turn: "over" };
      }
      const cut = event.reason === "cancelled" && !model.stopping;
      return {
        ...model,
        turn: "over",
        rest: cut ? "interrupted" : "idle",
        ...(cut ? { detail: "the turn was cancelled: the link to the workload dropped" } : {}),
        exitNow: model.exitNow || model.stopping,
      };
    }
    case "turn_failed":
      if (linkLost) {
        return { ...model, turn: "over" };
      }
      return {
        ...model,
        turn: "over",
        rest: "failed",
        detail: event.message,
        exitNow: model.exitNow || model.stopping,
      };
    case "ask_raised":
      return { ...model, asks: model.asks + 1, tool: event.tool };
    case "ask_gone": {
      const asks = Math.max(0, model.asks - 1);
      return asks === 0 ? without({ ...model, asks }, "tool") : { ...model, asks };
    }
    case "jobs":
      return { ...model, jobs: event.n };
    case "link":
      return event.status.state === "stopped"
        ? {
            ...model,
            linkStopped: true,
            rest: "failed",
            detail: untrustedText(event.status.reason),
            exitNow: true,
          }
        : model;
    case "stop":
      return {
        ...model,
        stopping: true,
        exitNow: model.exitNow || model.turn !== "running",
      };
    case "busy":
      return without(model, "exitAt");
    case "note":
      return { ...model, detail: untrustedText(event.detail) };
    case "tick": {
      if (model.stopping) {
        return { ...model, exitAt: model.exitAt ?? event.now + RELAY_STOP_BOUND_MS };
      }
      const idle = model.turn === "over" && model.asks === 0 && model.jobs === 0;
      return idle
        ? { ...model, exitAt: model.exitAt ?? event.now + RELAY_IDLE_GRACE_MS }
        : without(model, "exitAt");
    }
  }
}

export function relayExits(model: RelayModel, now: number): boolean {
  return model.exitNow || (model.exitAt !== undefined && now >= model.exitAt);
}

export function relayView(model: RelayModel): RelayView {
  const detail = model.detail !== undefined ? { detail: model.detail } : {};
  if (model.rest === "failed" && model.exitNow) {
    return { state: "failed", ...detail };
  }
  if (model.asks > 0) {
    return { state: "waiting-permission", ...(model.tool ? { tool: model.tool } : {}) };
  }
  if (model.turn === "none") {
    return { state: "starting" };
  }
  if (model.turn === "running") {
    return { state: "running" };
  }
  if (model.jobs > 0) {
    return { state: "running", detail: `${model.jobs} background job(s) running` };
  }
  return { state: model.rest, ...detail };
}

/** Caffeinate (DR-9): a held ask, a background job or a stop lets the Mac sleep. */
export function wantsAwake(model: RelayModel): boolean {
  return model.turn === "running" && model.asks === 0 && !model.stopping;
}

/** Who uses the resident, read fresh right before a removal. `others`: sessions in use. */
export interface ResidentUse {
  readonly jobs: number;
  readonly running: boolean;
  readonly others: number;
}

/**
 * `session/list` read for `exitPlan`; `null` when it is not the whole truth (a
 * further page, or its own session missing). A session whose client left is
 * listed with `attached: 0`: it uses nothing, so it does not count.
 */
export function residentUseOf(
  list: Pick<SessionListResult, "sessions" | "cursor">,
  id: string,
): ResidentUse | null {
  const own = list.sessions.find((session) => session.sessionId === id);
  if (!own || list.cursor !== undefined) {
    return null;
  }
  return {
    jobs: own.jobs ?? 0,
    running: own.running,
    others: list.sessions.filter(
      (session) =>
        session.sessionId !== id &&
        (session.attached > 0 || session.running || (session.jobs ?? 0) > 0),
    ).length,
  };
}

export type ExitPlan =
  | { readonly kind: "leave"; readonly why?: string }
  /** In use after all: back to the grace. */
  | { readonly kind: "hold" }
  | { readonly kind: "remove" };

/** The rows of `exitPlan` a fresh read can change: only then is one made. */
export function needsUse(model: RelayModel, keep: boolean): boolean {
  return !keep && !model.linkStopped && !model.stopping && model.rest === "idle";
}

/**
 * What the relay does with the workload on its way out: the ONLY place removal
 * is decided (docs/feat/detached-relay-lifecycle.md). A stop removes (DR-5);
 * otherwise a workload is removed only when a run ended cleanly and one fresh
 * read says nobody uses it. Keeping it is the safe side of every unknown: a
 * leftover is one `rm` away, deleted files are gone. Pod-supplied `use` steers
 * only the removal of that same workload.
 */
export function exitPlan(model: RelayModel, keep: boolean, use: ResidentUse | null): ExitPlan {
  if (keep || model.linkStopped) {
    return { kind: "leave" };
  }
  if (model.stopping) {
    return { kind: "remove" };
  }
  if (model.rest !== "idle") {
    return { kind: "leave" };
  }
  if (use === null) {
    return { kind: "leave", why: "could not tell whether it is in use" };
  }
  if (use.jobs > 0 || use.running) {
    return { kind: "hold" };
  }
  return use.others > 0 ? { kind: "leave", why: "another client is using it" } : { kind: "remove" };
}

/** The state left behind at exit: nothing runs any more. */
export function finalView(model: RelayModel): RelayView {
  const view = relayView(model);
  return view.state === "starting" ||
    view.state === "running" ||
    view.state === "waiting-permission"
    ? { state: "interrupted", detail: "the relay was stopped before the turn ended" }
    : view;
}
