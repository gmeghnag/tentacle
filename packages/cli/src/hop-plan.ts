/**
 * The hop's decisions (docs/feat/session-hop.md, slice H1), pure: may this
 * `/move` run now (D1 step 1), may this workload be joined (D7), and what
 * happens to a hop-created container on the way back (D5). No IO, no React, no
 * engine: the orchestrator (`session-hop.ts`) only executes what is decided here.
 */
import type { HopSpec, HopWorkload } from "@tentacle/tui";
import type { ResidentUse } from "./relay-state.ts";
import { untrustedText } from "./untrusted-text.ts";

/** Where the session is now (the badge has no "local" word: this is the plan's). */
export type HopPlace =
  | { readonly kind: "local" }
  | {
      readonly kind: "workload";
      readonly engine: HopWorkload["engine"];
      readonly name: string;
      readonly container?: string;
    };

export interface HopPlanInput {
  readonly spec: HopSpec;
  readonly current: HopPlace;
  /** The origin is hop-capable (D8). */
  readonly capable: boolean;
  /** A hop is already running (`/move cancel` aborts it, nothing else starts). */
  readonly hopping: boolean;
  /** The link is up (a hop is refused while it is not). */
  readonly linkUp: boolean;
  /** A session switch is in flight. */
  readonly switching: boolean;
  /** A compaction holds the session. */
  readonly compacting: boolean;
  /** Background sub-agents still running (Q2: refused, never killed). */
  readonly subagents: number;
  /** The session's running background shell jobs (Q2). */
  readonly jobs: number;
  /** Our own turn runs. */
  readonly running: boolean;
  /** Messages queued daemon-side (D4: they run first). */
  readonly queued: number;
}

export type HopPlan =
  | { readonly kind: "hop" }
  /** D4: the hop takes the first true idle; nothing is built yet. */
  | { readonly kind: "queue" }
  /** One line, and nothing happens. */
  | { readonly kind: "notice"; readonly text: string };

/**
 * `docker:box`, `kubernetes:web-0/app` — the workload as the badge and every
 * notice say it. Names go through `untrustedText` by default: a proposed
 * `move_session` supplies them, and a notice is a terminal (AGENTS §7).
 */
export function workloadText(workload: HopWorkload): string {
  const name = untrustedText(workload.name);
  const container = workload.container === undefined ? "" : `/${untrustedText(workload.container)}`;
  return `${workload.engine}:${name}${container}`;
}

/** Purely structural: is this the same workload, byte for byte? */
function workloadKey(workload: HopWorkload): string {
  return workload.container === undefined
    ? `${workload.engine}:${workload.name}`
    : `${workload.engine}:${workload.name}/${workload.container}`;
}

/** The same, for the place the session is at now (`local` has no badge). */
export function placeText(place: HopPlace): string {
  return place.kind === "local" ? "local" : workloadText(place);
}

/** Is `spec` asking for the place we are already at? (An exact place: a k8s container is part of it.) */
function samePlace(spec: HopSpec, current: HopPlace): boolean {
  if (spec.target === "local") {
    return current.kind === "local";
  }
  if (spec.target !== "attach" || current.kind !== "workload") {
    return false;
  }
  return workloadKey(spec.workload) === workloadKey(current);
}

/**
 * D1 step 1: may this `/move` run now, be queued, or be refused with one line?
 * The refusals come first and are about FACTS the caller measured (never about
 * the target, which fails later, in step 2); a running turn and a daemon queue
 * only ever defer, and nothing is built before the first true idle (D4).
 */
export function hopPlan(input: HopPlanInput): HopPlan {
  const notice = (text: string): HopPlan => ({ kind: "notice", text });
  if (!input.capable) {
    return notice("not available here");
  }
  if (input.hopping) {
    return notice("a move is already running");
  }
  if (!input.linkUp) {
    return notice("can't move: the link is down");
  }
  if (input.switching) {
    return notice("can't move: switching sessions");
  }
  if (input.compacting) {
    return notice("can't move: a compaction is running");
  }
  if (samePlace(input.spec, input.current)) {
    return notice(
      input.current.kind === "local" ? "already local" : `already in ${placeText(input.current)}`,
    );
  }
  // Q2: closing the old daemon would kill this work silently, so it is refused
  // — never killed, and never quietly deferred behind a turn that may run it again.
  if (input.jobs > 0) {
    return notice("can't move: a background job is still running");
  }
  if (input.subagents > 0) {
    return notice("can't move: a background sub-agent is still running");
  }
  // D4: the turn in flight ends, and the messages the daemon already queued run
  // first; the hop takes the first idle nobody is using.
  if (input.running || input.queued > 0) {
    return { kind: "queue" };
  }
  return { kind: "hop" };
}

/** `/move cancel`: abort the hop in flight, or say there is none. Its own union:
 * a cancel is not a hop, and reusing `hopPlan`'s `hop` for it would mislead. */
export type HopCancelPlan =
  | { readonly kind: "cancel" }
  | { readonly kind: "notice"; readonly text: string };

export function hopCancelPlan(input: { readonly hopping: boolean }): HopCancelPlan {
  return input.hopping ? { kind: "cancel" } : { kind: "notice", text: "no move is running" };
}

export type AttachVerdict =
  | { readonly kind: "allowed" }
  | { readonly kind: "refuse"; readonly text: string };

export interface AttachVerdictInput {
  readonly workload: HopWorkload;
  /** A laptop detached run owns this workload (`detachedRunOf` ≠ null). */
  readonly detachedRun: boolean;
  /** `residentUse` after the handshake, BEFORE any open; `null`: not the whole truth. */
  readonly use: ResidentUse | null;
}

/**
 * D7: may this hop JOIN an existing workload? A resident pod daemon is ONE per
 * workload, so a workload with another live client is not ours to share (that
 * client can already answer its pod-side asks). Check (b) reads pod-supplied
 * data, so it is UX, never security — the model key, the approvals and the
 * history all stay laptop-gated (P2, D9). A doubt is a refusal: joining a busy
 * resident is the one mistake this cannot undo.
 */
export function attachVerdict(input: AttachVerdictInput): AttachVerdict {
  const shown = workloadText(input.workload);
  if (input.detachedRun) {
    return { kind: "refuse", text: `${shown} is in use by another session` };
  }
  if (input.use === null) {
    return { kind: "refuse", text: `can't tell whether ${shown} is in use — not joining it` };
  }
  if (input.use.others > 0) {
    return { kind: "refuse", text: `${shown} is in use by another session` };
  }
  return { kind: "allowed" };
}

export type HopDelete =
  | { readonly kind: "keep"; readonly notice?: string }
  | { readonly kind: "delete" };

export interface HopDeleteInput {
  readonly workload: HopWorkload;
  /** `keep` as asked (default true). */
  readonly keep: boolean;
  /** This hop created the workload itself (D5's laptop index entry). */
  readonly createdByHop: boolean;
}

/**
 * D5: what the hop does with the workload it LEAVES. Deletion is explicit
 * (decision 5), never of a user-owned workload (`attach`ed: `keep` is ignored
 * with a notice), and only ever through the verified delete — the caller
 * runs `removeVerifiedKept`, nothing here dials.
 */
export function hopDelete(input: HopDeleteInput): HopDelete {
  if (input.keep) {
    return { kind: "keep" };
  }
  if (!input.createdByHop) {
    return {
      kind: "keep",
      notice: `${untrustedText(input.workload.name)} is not ours: left alone`,
    };
  }
  return { kind: "delete" };
}
