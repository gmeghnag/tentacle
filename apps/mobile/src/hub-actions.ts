/**
 * WHAT the hub offers (docs/feat/mobile-hub.md Design 5–6): the fan's items in
 * their order, the "More" overflow, the re-validation of a commit at release,
 * and the button's one badge + its VoiceOver label. Pure and React-free
 * (AGENTS §7): the Session screen passes the world in and renders the result.
 */
import type { EndReason } from "@tentacle/client";
import { composerAction } from "./composer.ts";
import type { TurnRow } from "./transcript-rows.ts";

/** An action the screen can wire (an entry); "more" is the hub's own overflow. */
export type HubEntryId =
  | "stop"
  | "steer"
  | "attach"
  | "activity"
  | "artifacts"
  | "sessions"
  | "info"
  | "scheduled"
  | "dictate"
  | "new";

export type HubActionId = HubEntryId | "more";

/** The callbacks the screen has. A missing one is a missing action (P6), never a dead button. */
export type HubEntries = Partial<Record<HubEntryId, () => void>>;

export type HubBadge = { readonly kind: "count"; readonly n: number } | { readonly kind: "dot" };

export interface HubItem {
  readonly id: HubActionId;
  readonly label: string;
  readonly badge: HubBadge | null;
  /** Stop is the only red item (Design 8). */
  readonly danger: boolean;
}

export interface HubContext {
  readonly link: "up" | "down";
  /** The running turn (own or another device's), null when idle. */
  readonly turn: TurnRow | null;
  readonly ended: EndReason | null;
  /** `state.view.editable`: Attach only where a prompt can carry photos. */
  readonly editable: boolean;
  /** `settings.dictation` (feat/mobile-voice-hidden). */
  readonly dictation: boolean;
  /** How many scheduled wakes the daemon reported (0 when it never sends `schedules`). */
  readonly schedules: number;
  /** Time until the next wake, null when none. */
  readonly nextWakeInMs: number | null;
  /** Artifacts the person has not opened yet. */
  readonly unseenArtifacts: number;
}

export interface HubActions {
  /** What the fan shows: ≤ 6, the last one "More" when there are more. */
  readonly fan: readonly HubItem[];
  /** What "More" opens, in the same order. */
  readonly more: readonly HubItem[];
  /** Everything, no cap (VoiceOver's actions, the menu fallback). */
  readonly all: readonly HubItem[];
}

export const FAN_MAX = 6;
/** A wake this close is "due" and badges its item. */
export const DUE_SOON_MS = 10 * 60 * 1000;
export const ALREADY_FINISHED = "Already finished";
export const NO_CONNECTION = "Not connected — the turn keeps running";

const LABELS: Readonly<Record<HubActionId, string>> = {
  stop: "Stop",
  steer: "Steer",
  attach: "Attach",
  activity: "Activity",
  artifacts: "Artifacts",
  sessions: "Sessions",
  info: "Session info",
  scheduled: "Scheduled",
  dictate: "Dictate (Beta)",
  new: "New session",
  more: "More",
};

/** Prepended while a turn runs; never passed by a badge. */
const TURN_PAIR: readonly HubEntryId[] = ["stop", "steer"];
/** The stable order (owner Q-H5): identities keep their relative order in every context. */
const CANONICAL: readonly HubEntryId[] = [
  "attach",
  "activity",
  "artifacts",
  "sessions",
  "info",
  "scheduled",
  "dictate",
  "new",
];

/**
 * Stop resolves through the composer's OWN truth table with nothing to send
 * (P2): a turn runs, the link is up, the session lives. Steer rides the same
 * gate — on a dead link typing becomes Send later, not a steer.
 */
function turnStoppable(ctx: HubContext): boolean {
  const input = { link: ctx.link, text: "", photos: 0, turn: ctx.turn, ended: ctx.ended };
  return composerAction(input).kind === "stop";
}

/** Whether the context lets this entry show (its callback is checked apart, P6). */
function holds(id: HubEntryId, ctx: HubContext): boolean {
  switch (id) {
    case "stop":
    case "steer":
      return turnStoppable(ctx);
    case "attach":
      return ctx.editable && ctx.ended === null;
    case "scheduled":
      return ctx.schedules > 0;
    case "dictate":
      return ctx.dictation;
    case "activity":
    case "artifacts":
    case "sessions":
    case "info":
    case "new":
      return true;
  }
}

function badgeOf(id: HubEntryId, ctx: HubContext): HubBadge | null {
  if (id === "artifacts" && ctx.unseenArtifacts > 0) {
    return { kind: "count", n: ctx.unseenArtifacts };
  }
  if (id === "scheduled" && ctx.nextWakeInMs !== null && ctx.nextWakeInMs <= DUE_SOON_MS) {
    return { kind: "dot" };
  }
  return null;
}

function present(id: HubEntryId, ctx: HubContext, entries: HubEntries): boolean {
  return entries[id] !== undefined && holds(id, ctx);
}

function item(id: HubActionId, badge: HubBadge | null): HubItem {
  return { id, label: LABELS[id], badge, danger: id === "stop" };
}

export function hubActions(ctx: HubContext, entries: HubEntries): HubActions {
  const pair = TURN_PAIR.filter((id) => present(id, ctx, entries)).map((id) => item(id, null));
  const canonical = CANONICAL.filter((id) => present(id, ctx, entries)).map((id) =>
    item(id, badgeOf(id, ctx)),
  );
  // Badge promotion: a badged item moves up to the first unbadged canonical
  // slot (a stable partition), so new things are reachable — after the pair.
  const promoted = [
    ...canonical.filter((i) => i.badge !== null),
    ...canonical.filter((i) => i.badge === null),
  ];
  const all = [...pair, ...promoted];
  if (all.length <= FAN_MAX) {
    return { fan: all, more: [], all };
  }
  const head = all.slice(0, FAN_MAX - 1);
  return { fan: [...head, item("more", null)], more: all.slice(FAN_MAX - 1), all };
}

export type HubCommit =
  | { readonly kind: "run"; readonly id: HubActionId }
  | { readonly kind: "noop"; readonly notice: string | null };

/**
 * The layout is a snapshot taken at the open; the world is read again at the
 * release (Design 5, M7/M8). An action runs iff it would still be offered now
 * (the same rule as `hubActions`, no second truth); a turn action that no
 * longer can says why, anything else gone is a silent no-op.
 */
export function resolveCommit(id: HubActionId, ctx: HubContext, entries: HubEntries): HubCommit {
  if (id === "more" || present(id, ctx, entries)) {
    return { kind: "run", id };
  }
  if (id === "stop" || id === "steer") {
    const over = ctx.turn === null || ctx.ended !== null;
    return { kind: "noop", notice: over ? ALREADY_FINISHED : NO_CONNECTION };
  }
  return { kind: "noop", notice: null };
}

export interface ButtonBadgeInput {
  /** Background activity running (`activity.ts`'s count). */
  readonly running: number;
  readonly unseenArtifacts: number;
  readonly unreadReport: boolean;
}

/** One badge at most (Design 6): a number for running work, else a dot for something new. */
export function buttonBadge(input: ButtonBadgeInput): HubBadge | null {
  if (input.running > 0) {
    return { kind: "count", n: input.running };
  }
  if (input.unseenArtifacts > 0 || input.unreadReport) {
    return { kind: "dot" };
  }
  return null;
}

/** VoiceOver says everything the badge stands for: "Tentacle hub, 2 running, 3 new artifacts". */
export function hubA11yLabel(input: ButtonBadgeInput): string {
  const parts = ["Tentacle hub"];
  if (input.running > 0) {
    parts.push(`${input.running} running`);
  }
  if (input.unseenArtifacts > 0) {
    const noun = input.unseenArtifacts === 1 ? "artifact" : "artifacts";
    parts.push(`${input.unseenArtifacts} new ${noun}`);
  }
  if (input.unreadReport) {
    parts.push("unread report");
  }
  return parts.join(", ");
}
