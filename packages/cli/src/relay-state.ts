/**
 * The relay's state, pure (docs/feat/detached-relay.md): events in, what to
 * record and when to exit out. Idle = the turn is over, no ask pending, no job
 * running; 60 s of it exits (DR-4). A stopped link exits at once. A stop waits
 * for the turn to settle, bounded. A background job's exit wakes the agent, as
 * in a TUI (docs/fix/detached-autowake.md).
 */
import type { LinkStatus } from "@tentacle/client";
import { type WakeModel, initialWake, wakeDue, wakeStep } from "@tentacle/core";
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
  /** The session's running background sub-agents (they need the laptop's model). */
  | { readonly type: "agents"; readonly n: number }
  | { readonly type: "link"; readonly status: LinkStatus }
  | { readonly type: "stop" }
  /** A due exit was held back (`exitPlan`): the grace starts over. */
  | { readonly type: "busy" }
  /** Why the workload stays: `detail` of the state left behind. */
  | { readonly type: "note"; readonly detail: string }
  | { readonly type: "tick"; readonly now: number }
  /** A TUI prepared a hand-over (docs/feat/detached-handover.md): no idle exit. */
  | { readonly type: "handover_prepared" }
  /** It aborted (its socket closed, the lease ran out, a stop): the relay owns it again. */
  | { readonly type: "handover_aborted" }
  /** Committed: the TUIs own the session; the relay drains and leaves, removing nothing. */
  | { readonly type: "handed_over" }
  /** The model calls the relay served are over (or past their bound): leave. */
  | { readonly type: "drained" }
  /** A background job of the session exited. */
  | { readonly type: "job_exit" }
  /** The wake was refused before it ran (another client's turn): tried again at a tick. */
  | { readonly type: "wake_refused" };

export interface RelayModel {
  readonly turn: "none" | "running" | "over";
  readonly asks: number;
  /** The tool of the last ask raised. */
  readonly tool?: string;
  readonly jobs: number;
  /** The background sub-agents running now: they need the laptop for their model. */
  readonly agents: number;
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
  /** The hand-over to a TUI: `prepared` holds any idle exit, `done` leaves through the drain. */
  readonly handover: "none" | "prepared" | "done";
  /** A job exit no turn has flushed yet. */
  readonly wake: WakeModel;
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
  agents: 0,
  stopping: false,
  linkStopped: false,
  rest: "idle",
  exitNow: false,
  handover: "none",
  wake: initialWake,
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
      // The deadline goes now, not at the next tick: the loop looks at it first,
      // so a wake started at its last moment would be left behind.
      return without(
        {
          ...model,
          turn: "running",
          wake: wakeStep(model.wake, { type: "turn_started" }),
        },
        "exitAt",
      );
    case "job_exit":
      return { ...model, wake: wakeStep(model.wake, { type: "exit" }) };
    case "wake_refused":
      return {
        ...model,
        turn: "over",
        wake: wakeStep(model.wake, { type: "refused" }),
      };
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
    case "agents":
      return { ...model, agents: event.n };
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
    case "handover_prepared":
      return without({ ...model, handover: "prepared" }, "exitAt");
    case "handover_aborted":
      return model.handover === "prepared" ? { ...model, handover: "none" } : model;
    case "handed_over":
      return without({ ...model, handover: "done" }, "exitAt");
    case "drained":
      return { ...model, exitNow: true };
    case "tick": {
      if (model.stopping) {
        return { ...model, exitAt: model.exitAt ?? event.now + RELAY_STOP_BOUND_MS };
      }
      if (model.handover !== "none") {
        // Prepared: the attacher decides; done: only the drain ends it.
        return without(model, "exitAt");
      }
      const idle =
        model.turn === "over" && model.asks === 0 && model.jobs === 0 && model.agents === 0;
      return idle
        ? { ...model, exitAt: model.exitAt ?? event.now + RELAY_IDLE_GRACE_MS }
        : without(model, "exitAt");
    }
  }
}

export function relayExits(model: RelayModel, now: number): boolean {
  return model.exitNow || (model.exitAt !== undefined && now >= model.exitAt);
}

/**
 * May the wake start now? No limit, as in a TUI: a poll loop must go on, and
 * `tentacle stop` / `attach` is how the user ends a runaway. `enabled` is the
 * relay's subscription (`autoWake`). A failed or cut run stays that: a wake
 * would overwrite its reason, and with `--rm` turn the workload a failed
 * run keeps into one it removes. `exiting`: the exit plan is being read, or is final.
 */
export function relayWakeDue(model: RelayModel, exiting: boolean): boolean {
  return wakeDue(model.wake, {
    enabled: true,
    idle: model.turn === "over" && model.asks === 0,
    blocked:
      model.rest !== "idle" ||
      model.handover !== "none" ||
      model.stopping ||
      model.linkStopped ||
      exiting,
  });
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
  if (model.agents > 0) {
    return { state: "running", detail: `${model.agents} background sub-agent(s) running` };
  }
  return { state: model.rest, ...detail };
}

/** Caffeinate (DR-9): a held ask, or a stop, lets the Mac sleep. */
export function wantsAwake(model: RelayModel): boolean {
  // Handed over: keep-awake is the relay's only (DR-9), and it is leaving.
  // A child in a pod needs the laptop for its MODEL (the reverse tunnel,
  // docs/feat/subagent-background-ui.md): with the Mac asleep its next call has
  // nowhere to go, so a running child keeps it awake even with the turn over.
  return (
    (model.turn === "running" || model.agents > 0) &&
    model.asks === 0 &&
    !model.stopping &&
    model.handover !== "done"
  );
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
 * `ownMayBeAbsent` (a TUI's quit, docs/fix/detach-live.md A5): its session
 * may not be open (a `/clear`ed one not used yet, one already closed), so a
 * missing own row is no use of it; the relay never sets it.
 */
export function residentUseOf(
  list: Pick<SessionListResult, "sessions" | "cursor">,
  id: string,
  opts: { readonly ownMayBeAbsent?: boolean } = {},
): ResidentUse | null {
  const own = list.sessions.find((session) => session.sessionId === id);
  if ((!own && opts.ownMayBeAbsent !== true) || list.cursor !== undefined) {
    return null;
  }
  return {
    jobs: own?.jobs ?? 0,
    running: own?.running ?? false,
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
export function needsUse(model: RelayModel, rm: boolean): boolean {
  return rm && !model.linkStopped && !model.stopping && model.rest === "idle";
}

/**
 * What the relay does with the workload on its way out: the ONLY place removal
 * is decided (docs/feat/detached-relay-lifecycle.md). A stop removes (DR-5);
 * otherwise a workload is removed only when a run ended cleanly and one fresh
 * read says nobody uses it. Keeping it is the safe side of every unknown: a
 * leftover is one `rm` away, deleted files are gone. Pod-supplied `use` steers
 * only the removal of that same workload. A `remove` is still vetoed by the
 * relay when the laptop's last save did not land (docs/fix/detach-live.md, fix
 * round 3).
 */
export function exitPlan(model: RelayModel, rm: boolean, use: ResidentUse | null): ExitPlan {
  // Handed over (docs/feat/detached-handover.md): the TUIs own the workload now.
  if (model.handover === "done") {
    return { kind: "leave" };
  }
  // A hand-over in flight never meets a removal; a stop or a stopped link still exits.
  if (model.handover === "prepared" && !model.stopping && !model.linkStopped) {
    return { kind: "hold" };
  }
  if (model.wake.pending && model.rest === "idle" && !model.stopping && !model.linkStopped) {
    // A job's exit landed during the read: back to the ticks, where the wake fires.
    return { kind: "hold" };
  }
  if (!rm || model.linkStopped) {
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

/**
 * Does a child's message to the agent (`subagent_notify`) ask this relay for a
 * continuation? (docs/feat/agent-message-two-way.md, Design 7.) ONE pure rule,
 * so the gate is testable and the relay holds no policy of its own: a note is
 * a wake only when the child says one is allowed (`wake`: the session's wake
 * budget) and this LAPTOP allows two-way at all — `autoWake` and
 * `subagents.twoWay`, both read here, never from the pod (AGENTS §7).
 */
export function notifyWakes(
  notify: { readonly wake: boolean },
  settings: { readonly autoWake: boolean; readonly subagentsTwoWay: boolean },
): boolean {
  return notify.wake && settings.autoWake && settings.subagentsTwoWay;
}

/** The state left behind at exit: nothing runs any more. A `note` stays. */
export function finalView(model: RelayModel): RelayView {
  const view = relayView(model);
  if (
    view.state !== "starting" &&
    view.state !== "running" &&
    view.state !== "waiting-permission"
  ) {
    return view;
  }
  const cut = "the relay was stopped before the turn ended";
  return {
    state: "interrupted",
    detail: model.detail !== undefined ? `${cut}; ${model.detail}` : cut,
  };
}
