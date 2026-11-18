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
  | "tools"
  // The session's own commands (docs/feat/mobile-hub-commands.md C1): Compact,
  // Clear, Rename, Retry, Auto-accept — one sheet, not five fan discs.
  | "commands"
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
   * KEEPS its slot and the cue is `light` — never hidden, so the order never
   * shifts under the finger (owner Q-H5). Since mobile-hub-commands C1 a FAN tap
   * on it flashes its own `emptyLabel` in place (`hub-flash.ts`) instead of
   * committing; the notice line is the menu / VoiceOver path's answer
   * (`resolveCommit`).
   */
  readonly dimmed: boolean;
  /**
   * WHY it is dimmed, in the words the pill and VoiceOver say (mobile-hub-commands
   * C1 Design 4): the fan's in-place label swaps to it for a moment. `dimmed` is
   * exactly `emptyLabel !== null`, so the two can never disagree.
   */
  readonly emptyLabel: string | null;
  /**
   * The rim arc, when the item's own figure is not a badge count
   * (docs/feat/mobile-hub-tools.md: the Tools item's share switched off). Absent:
   * the rim comes from the badge, as every other item's does (`rimFraction`).
   */
  readonly rim?: number | null;
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
  /**
   * `state.artifacts.list` is KNOWN and empty: Artifacts has nothing to open
   * (mobile-hub-commands C1 Design 3). UNKNOWN is never empty — the Tools rule
   * D3: an item whose tap is what fetches a list must not be dimmed for not
   * having fetched it yet.
   */
  readonly artifactsEmpty: boolean;
  /**
   * `toolsSummary(...).known && total === 0`: there is nothing to switch, so the
   * Tools item is dimmed. UNKNOWN is never empty: a count not seen yet must not
   * dim an item whose tap is what fetches it (docs/feat/mobile-hub-tools.md D3).
   */
  readonly toolsEmpty: boolean;
  /** The Tools item's rim: the share switched OFF, or null for no arc (all on). */
  readonly toolsRim: number | null;
  /**
   * THIS phone's own compaction is in flight (mobile-hub-commands C2 item 14):
   * Stop is offered with no turn and cancels it. Absent = false.
   */
  readonly compacting?: boolean;
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
/** The same rule for Artifacts: an empty gallery never opens its sheet (mobile-hub-commands Q3). */
export const NO_ARTIFACTS = "No artifacts yet";
/** The same rule for Tools: nothing to switch, so the sheet would be two empty lists. */
export const NO_TOOLS = "No MCP servers or skills in this session";

const LABELS: Readonly<Record<HubActionId, string>> = {
  stop: "Stop",
  steer: "Steer",
  attach: "Attach",
  activity: "Activity",
  artifacts: "Artifacts",
  sessions: "Sessions",
  info: "Session info",
  tools: "Tools",
  commands: "Commands",
  scheduled: "Scheduled",
  dictate: "Dictate (Beta)",
  new: "New session",
  more: "More",
};

/** Prepended while a turn runs; never passed by a badge. */
const TURN_PAIR: readonly HubEntryId[] = ["stop", "steer"];
/**
 * The stable order (owner Q-H5): identities keep their relative order in every
 * context. O1 (mobile-hub-commands Q1): Commands takes the sixth candidate slot,
 * so the idle fan is exactly O1 and Session info falls into More, next to
 * Sessions.
 */
const CANONICAL: readonly HubEntryId[] = [
  "attach",
  "activity",
  "artifacts",
  "tools",
  "commands",
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
    // Stop also ends this phone's own compaction (harness-notices Q7): no turn
    // runs then, but the link must be up or the cancel is lost.
    case "stop":
      return turnStoppable(ctx) || (ctx.compacting === true && ctx.link === "up");
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
    // Tools is offered wherever Session info is: its own content decides.
    case "tools":
    case "new":
      return true;
    // The commands sheet reuses what the screen already has (rename, auto-accept
    // from Session info), but an ended session has nothing to run — and Rename
    // stays reachable from the title (C1 Design 2).
    case "commands":
      return ctx.ended === null;
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

function item(
  id: HubActionId,
  badge: HubBadge | null,
  emptyLabel: string | null = null,
  rim?: number | null,
): HubItem {
  return {
    id,
    label: LABELS[id],
    badge,
    danger: id === "stop",
    dimmed: emptyLabel !== null,
    emptyLabel,
    ...(rim === undefined ? {} : { rim }),
  };
}

/**
 * Why this entry has nothing to show RIGHT NOW, or null when it does: an empty
 * Activity (owner Q3), Artifacts with nothing listed yet (mobile-hub-commands
 * Q3), and Tools with nothing to switch (hub-tools D3).
 */
function dimmedBecause(id: HubEntryId, ctx: HubContext): string | null {
  if (id === "activity") {
    return ctx.activityEmpty ? NOTHING_RUNNING : null;
  }
  if (id === "artifacts") {
    return ctx.artifactsEmpty ? NO_ARTIFACTS : null;
  }
  if (id === "tools") {
    return ctx.toolsEmpty ? NO_TOOLS : null;
  }
  return null;
}

/**
 * The figure an item's rim draws. Tools carries its own (the share switched off);
 * every other item's rim is its badge's (`rimFraction`).
 */
function rimOf(id: HubEntryId, ctx: HubContext): number | null | undefined {
  return id === "tools" ? ctx.toolsRim : undefined;
}

export function hubActions(ctx: HubContext, entries: HubEntries): HubActions {
  const pair = TURN_PAIR.filter((id) => present(id, ctx, entries)).map((id) => item(id, null));
  const canonical = CANONICAL.filter((id) => present(id, ctx, entries)).map((id) =>
    item(id, badgeOf(id, ctx), dimmedBecause(id, ctx), rimOf(id, ctx)),
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
 * session's first render, so opening a session that already holds news never
 * pulses (F1), and a resync that relists the same news does not either (F2: 3 → 3
 * is not an increase).
 */
export function hubPulse(prev: PulseInput | null, next: PulseInput): boolean {
  if (prev === null) {
    return false;
  }
  return next.unseenArtifacts > prev.unseenArtifacts || (!prev.unreadReport && next.unreadReport);
}

/**
 * The pulse effect's retained state (Design 4): the baseline, and WHICH session's
 * baseline it is. The session key is part of the state, not of a second effect,
 * so a switch and the comparison it invalidates happen in the SAME step — a
 * separate reset effect runs before the comparison in one commit and lets the
 * comparison re-advance the baseline (it did: F1/F2 were both dead that way).
 */
export interface PulseState {
  readonly sessionKey: string | undefined;
  readonly prev: PulseInput | null;
}

/** No baseline yet: the screen's first render (F1 — opening a session with news never pulses). */
export const PULSE_START: PulseState = { sessionKey: undefined, prev: null };

export interface PulseStep {
  /** What the screen must retain for the next render. */
  readonly state: PulseState;
  /** Whether news arrived live in this step — the glow's and the light haptic's verdict. */
  readonly pulse: boolean;
}

/**
 * One render's whole pulse decision (Design 4), pure — the ONE place F1, F2 and
 * F3's "the baseline still advances" are decided:
 *
 * - a different session key (or no baseline at all) RESETS the baseline to this
 *   reading and never pulses: opening a session that already holds news is not
 *   news (F1), and because the new baseline is taken in the same step, the next
 *   real increase still pulses (a reset to `null` alone swallowed it).
 * - a link that is down also resets to `null` and never pulses, so the refill a
 *   reconnect delivers is a fresh baseline (F2): a list that emptied during the
 *   outage and came back is not news.
 * - otherwise the news is compared with the live baseline: only an increase
 *   pulses, so a resync relisting the same count is silent (F2).
 *
 * The verdict does not depend on the button being shown: a hidden button draws no
 * glow and plays no haptic, but the baseline advances, so the news is not
 * replayed when the button returns (F3).
 */
export function pulseStep(
  state: PulseState,
  input: {
    readonly sessionKey: string | undefined;
    readonly link: "up" | "down";
    readonly news: PulseInput;
  },
): PulseStep {
  const fresh = input.link !== "up" || state.sessionKey !== input.sessionKey || state.prev === null;
  if (fresh) {
    return {
      state: { sessionKey: input.sessionKey, prev: input.link === "up" ? input.news : null },
      pulse: false,
    };
  }
  return {
    state: { sessionKey: input.sessionKey, prev: input.news },
    pulse: hubPulse(state.prev, input.news),
  };
}

/**
 * A fan item's VoiceOver label (mobile-hub-badges Design 10). The count bubble
 * was visual-only and the rim is too, so what it means is SPOKEN here: the
 * number of new artifacts, or that a wake is due. A dimmed item says why it has
 * nothing to show, and that wins — it is what its commit would report.
 */
export function itemA11yLabel(item: HubItem): string {
  if (item.emptyLabel !== null) {
    return `${item.label}, ${item.emptyLabel}`;
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
