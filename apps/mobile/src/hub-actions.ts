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
  /**
   * Offered but with nothing to show (docs/feat/mobile-hub-tap.md Design 2): it
   * KEEPS its slot, a commit says why in the notice line, and the cue is `light`
   * — never hidden, so the order never shifts under the finger (owner Q-H5).
   */
  readonly dimmed: boolean;
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
  /** `activityView(...).groups.length === 0`: Activity has nothing to open (mobile-hub-tap Design 2). */
  readonly activityEmpty: boolean;
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
/** A commit of an empty Activity says so inline; the modal never opens (mobile-hub-tap Design 2). */
export const NOTHING_RUNNING = "Nothing running";

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

function item(id: HubActionId, badge: HubBadge | null, dimmed = false): HubItem {
  return { id, label: LABELS[id], badge, danger: id === "stop", dimmed };
}

/** Why this entry has nothing to show RIGHT NOW, or null when it does (today: only an empty Activity, owner Q3). */
function dimmedBecause(id: HubEntryId, ctx: HubContext): string | null {
  return id === "activity" && ctx.activityEmpty ? NOTHING_RUNNING : null;
}

export function hubActions(ctx: HubContext, entries: HubEntries): HubActions {
  const pair = TURN_PAIR.filter((id) => present(id, ctx, entries)).map((id) => item(id, null));
  const canonical = CANONICAL.filter((id) => present(id, ctx, entries)).map((id) =>
    item(id, badgeOf(id, ctx), dimmedBecause(id, ctx) !== null),
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
 * The world as it was when the fan OPENED — the layout is a snapshot (Design 5),
 * and so is this. Only the turn's identity is carried: a commit must act on the
 * turn the person saw, never on whatever runs at the release (M7).
 */
export interface HubOpen {
  /** The running turn's `turnId` at the open; null when the fan opened on an idle session. */
  readonly turnId: string | null;
}

/** The snapshot to carry from the open to `resolveCommit` (H3 takes it when `open` fires). */
export function hubOpen(ctx: HubContext): HubOpen {
  return { turnId: ctx.turn?.turnId ?? null };
}

/** Stop/Steer belong to the turn shown at the open; every other entry outlives a turn. */
function sameTurn(id: HubActionId, ctx: HubContext, open: HubOpen): boolean {
  if (id !== "stop" && id !== "steer") {
    return true;
  }
  return (ctx.turn?.turnId ?? null) === open.turnId;
}

/**
 * The layout is a snapshot taken at the open; the world is read again at the
 * release (Design 5, M7/M8). An action runs iff it would still be offered now
 * (the same rule as `hubActions`, no second truth) AND — for the turn pair —
 * iff it is still the SAME turn: turn A ending and turn B starting during the
 * press makes Stop "already finished", never a cancel of B. A turn action that
 * no longer can says why, anything else gone is a silent no-op.
 */
export function resolveCommit(
  id: HubActionId,
  ctx: HubContext,
  entries: HubEntries,
  open: HubOpen,
): HubCommit {
  if (id === "more") {
    return { kind: "run", id };
  }
  const live = present(id, ctx, entries) && sameTurn(id, ctx, open);
  // A dimmed entry has nothing to show: its notice replaces the modal (Design 2).
  const dimmed = live ? dimmedBecause(id, ctx) : null;
  if (dimmed !== null) {
    return { kind: "noop", notice: dimmed };
  }
  if (live) {
    return { kind: "run", id };
  }
  if (id === "stop" || id === "steer") {
    // "Already finished" is about the turn the person saw: gone, ended, or
    // replaced. Only a same-turn failure can be the link's fault.
    const over =
      ctx.turn === null || ctx.ended !== null || (ctx.turn.turnId ?? null) !== open.turnId;
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

/** The button's mark: a running count, or nothing (mobile-hub-badges Q1 C — no dot). */
export type ButtonCount = { readonly kind: "count"; readonly n: number } | null;

/**
 * The button's only mark: the running count (Design 6, kept by owner Q1). News
 * draws NO mark on the button any more — the dot is gone (mobile-hub-badges Q1 C);
 * it is the one-shot glow (`hubPulse`) and the fan items' rims that carry it.
 */
export function buttonBadge(input: ButtonBadgeInput): ButtonCount {
  return input.running > 0 ? { kind: "count", n: input.running } : null;
}

export interface PulseInput {
  readonly unseenArtifacts: number;
  readonly unreadReport: boolean;
}

/**
 * Whether the hub should glow NOW (mobile-hub-badges Design 2, owner Q1 C): true
 * iff there is a previous reading and the news GREW since it — more unseen
 * artifacts, or a report that was not unread and is. `prev === null` is the
 * session's first render (or the moment its link came back), so opening a
 * session that already holds news never pulses (F1), and a resync that relists
 * the same news does not either (F2: 3 → 3 is not an increase).
 */
export function hubPulse(prev: PulseInput | null, next: PulseInput): boolean {
  if (prev === null) {
    return false;
  }
  return next.unseenArtifacts > prev.unseenArtifacts || (!prev.unreadReport && next.unreadReport);
}

/**
 * A fan item's VoiceOver label (mobile-hub-badges Design 10). The count bubble
 * was visual-only and the rim is too, so what it means is SPOKEN here: the
 * number of new artifacts, or that a wake is due. A dimmed item says why it has
 * nothing to show, and that wins — it is what its commit would report.
 */
export function itemA11yLabel(item: HubItem): string {
  if (item.dimmed) {
    return `${item.label}, nothing running`;
  }
  if (item.badge === null) {
    return item.label;
  }
  return item.badge.kind === "count"
    ? `${item.label}, ${item.badge.n} new`
    : `${item.label}, due soon`;
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
