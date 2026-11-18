/**
 * The seam between the Session screen and the hub (docs/feat/mobile-hub.md H3):
 * the context the screen hands `hub-actions`, the menu solved at the open, the
 * finger's point in band coordinates, and when a change of the world cancels an
 * open fan. Pure, no React (AGENTS §7): `ui/FloatingActivity.tsx` and
 * `screens/SessionScreen.tsx` only call these.
 *
 * ONE coordinate space: the band's (the list host between the header and the
 * composer, where the button lives — `floating-button.ts`). The fan's anchor,
 * its bounds and the finger all use it.
 */
import type { EndReason } from "@tentacle/client";
import type { ArtifactMeta, ScheduleRow } from "@tentacle/protocol";
import { unseenArtifacts } from "./artifact-gallery.ts";
import type { ArtifactSeen } from "./artifact-seen-store.ts";
import { FLOAT_SIZE, type FloatBounds, type FloatPosition, place } from "./floating-button.ts";
import {
  type HubActionId,
  type HubContext,
  type HubEntries,
  type HubEntryId,
  type HubItem,
  type HubOpen,
  resolveCommit,
} from "./hub-actions.ts";
import { type Point, fanLayout } from "./hub-fan.ts";
import {
  type GestureEffect,
  type GestureEvent,
  type GestureState,
  type HubMenu,
  IDLE,
  LONG_MS,
  reduce,
} from "./hub-gesture.ts";
import { toolsRim } from "./tools-view.ts";
import type { TurnRow } from "./transcript-rows.ts";

/**
 * The session's armed wakes as the hub needs them (cron-tool S6, M7): how many,
 * and how long until the next one fires. Pure: the rows are the daemon's table as
 * the client reported it (`RemoteSession.schedules`), `now` the injected clock.
 *
 * `undefined`/empty is "no table, or an older daemon" — zero wakes, so the
 * Scheduled item is absent (P6/M9), never a dead button. A wake already due (a
 * `nextAt` behind `now`: a pod/host clock skew, or one about to fire) reads 0 ms,
 * never a negative "in −40 s": it is due NOW, which is what the badge says.
 */
export function wakeContext(
  rows: readonly ScheduleRow[] | undefined,
  now: number,
): { readonly schedules: number; readonly nextWakeInMs: number | null } {
  if (rows === undefined || rows.length === 0) {
    return { schedules: 0, nextWakeInMs: null };
  }
  // The SOONEST wake, not the table's first row: the daemon's order is not the
  // firing order (a one-shot can sit ahead of a recurring wake's next turn).
  const next = rows.reduce(
    (soonest, row) => (row.nextAt < soonest ? row.nextAt : soonest),
    Number.POSITIVE_INFINITY,
  );
  return {
    schedules: rows.length,
    nextWakeInMs: Number.isFinite(next) ? Math.max(0, next - now) : null,
  };
}

/**
 * What the screen knows today. Wakes come from the daemon's table (`wakeContext`);
 * the artifacts badge (H4b) is the gallery's OWN rule (`unseenArtifacts`: artifacts
 * with a version this device has not seen, never versions), so the hub, the
 * Session-info row and the gallery can never disagree on "new". No feed (an older
 * daemon, nothing listed yet) is 0: the item, when its entry exists, shows
 * unbadged (P6).
 */
export function hubContextOf(input: {
  readonly link: "up" | "down";
  readonly turn: TurnRow | null;
  readonly ended: EndReason | null;
  readonly editable: boolean;
  readonly dictation: boolean;
  /** `activityView(...).groups.length === 0`: nothing for Activity to show (mobile-hub-tap). */
  readonly activityEmpty?: boolean;
  /**
   * The session's servers and skills, as the Tools sheet's own summary reads them
   * (`toolsSummary`, docs/feat/mobile-hub-tools.md D3). Absent: nothing is known
   * yet, which reads as unknown — never as empty (an unknown count must not dim).
   */
  readonly tools?: {
    readonly known: boolean;
    readonly total: number;
    readonly on: number;
  };
  /** The session's wake feed and the clock to measure it against (H4a). */
  readonly schedules?: {
    readonly rows: readonly ScheduleRow[] | undefined;
    readonly now: number;
  };
  /** The session's artifacts and this device's seen record for it (H4b). */
  readonly artifacts?: {
    readonly list: readonly ArtifactMeta[] | undefined;
    readonly seen: ArtifactSeen;
  };
}): HubContext {
  const wakes = wakeContext(input.schedules?.rows, input.schedules?.now ?? 0);
  return {
    link: input.link,
    turn: input.turn,
    ended: input.ended,
    editable: input.editable,
    dictation: input.dictation,
    schedules: wakes.schedules,
    nextWakeInMs: wakes.nextWakeInMs,
    unseenArtifacts:
      input.artifacts?.list === undefined
        ? 0
        : unseenArtifacts(input.artifacts.list, input.artifacts.seen),
    activityEmpty: input.activityEmpty ?? false,
    // Unknown counts are NOT empty: a dimmed Tools item never opens the sheet
    // that would learn them, so its own tap is the one that can (D4).
    toolsEmpty: input.tools?.known === true && input.tools.total === 0,
    toolsRim: input.tools === undefined ? null : toolsRim(input.tools),
  };
}

/**
 * The fan for the CURRENT band and button spot (called once, at the open: the
 * snapshot). No band, or one too short for the button, is the plain menu.
 */
export function solveHub(input: {
  readonly bounds: FloatBounds | null;
  readonly position: FloatPosition | undefined;
  readonly items: readonly HubItem[];
}): HubMenu {
  const ids = input.items.map((item) => item.id);
  const dimmed = input.items.filter((item) => item.dimmed).map((item) => item.id);
  const at = input.bounds === null ? null : place(input.position, input.bounds);
  if (input.bounds === null || at === null) {
    return { layout: { kind: "menu" }, ids, dimmed };
  }
  const layout = fanLayout({
    anchor: { x: at.x + FLOAT_SIZE / 2, y: at.y + FLOAT_SIZE / 2 },
    edge: input.position?.edge ?? "right",
    bounds: { left: 0, top: 0, right: input.bounds.width, bottom: input.bounds.height },
    n: ids.length,
  });
  return { layout, ids, dimmed };
}

/**
 * The finger in band coordinates: where the touch landed on the button (its
 * local point at the grant — the touch starts ON the button) plus how far the
 * finger has moved on the page since. No window measurement needed.
 */
export function bandPoint(
  grant: { readonly buttonAt: Point; readonly local: Point },
  pageDelta: Point,
): Point {
  return {
    x: grant.buttonAt.x + grant.local.x + pageDelta.x,
    y: grant.buttonAt.y + grant.local.y + pageDelta.y,
  };
}

/** What an open fan depends on: if any of it changes, the fan's snapshot is stale. */
export interface HubWorld {
  /** `floating-button.ts` `visible`: false while a sheet or the drawer covers it. */
  readonly shown: boolean;
  readonly voiceOver: boolean;
  readonly width: number;
  readonly height: number;
}

/**
 * A sheet/drawer arriving (M6), VoiceOver turning on (M10), or the band moving
 * (keyboard, rotation, a Dynamic Type relayout — M15) cancels an open fan: no
 * commit, no haptic; the next open re-solves.
 */
export function mustCancel(prev: HubWorld, next: HubWorld): boolean {
  return (
    (prev.shown && !next.shown) ||
    (!prev.voiceOver && next.voiceOver) ||
    prev.width !== next.width ||
    prev.height !== next.height
  );
}

/** What a released item (or a VoiceOver action) does, re-read against the world NOW. */
export type HubCommitPlan =
  | { readonly kind: "run"; readonly id: HubEntryId }
  | { readonly kind: "more" }
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "none" };

/**
 * `resolveCommit` turned into what the screen does (Design 5): run the entry,
 * open the overflow menu (M14), show why nothing happened (M7/M8), or nothing.
 */
export function commitPlan(
  id: HubActionId,
  ctx: HubContext,
  entries: HubEntries,
  open: HubOpen,
): HubCommitPlan {
  const verdict = resolveCommit(id, ctx, entries, open);
  if (verdict.kind === "noop") {
    return verdict.notice === null ? { kind: "none" } : { kind: "notice", text: verdict.notice };
  }
  return verdict.id === "more" ? { kind: "more" } : { kind: "run", id: verdict.id };
}

/** "Show all actions": VoiceOver's way to the plain menu (Design 7). */
export const SHOW_ALL = "show-all";
const ITEM_ACTION = "hub-";

/**
 * The button's accessibility actions (Design 7): the two standard ones (so
 * `onAccessibilityAction` receives them), every hub action with no six cap, and
 * "Show all actions". The fan never opens under VoiceOver.
 */
export function hubA11yActions(
  all: readonly HubItem[],
): readonly { readonly name: string; readonly label?: string }[] {
  return [
    { name: "activate" },
    { name: "longpress" },
    ...all.map((item) => ({ name: `${ITEM_ACTION}${item.id}`, label: item.label })),
    { name: SHOW_ALL, label: "Show all actions" },
  ];
}

const ENTRY_IDS: readonly string[] = [
  "stop",
  "steer",
  "attach",
  "activity",
  "artifacts",
  "sessions",
  "info",
  "tools",
  "scheduled",
  "dictate",
  "new",
] satisfies readonly HubEntryId[];

/** An accessibility action's name → what it does: activate and long-press both open the plain menu. */
export function hubA11yRoute(
  name: string,
):
  | { readonly kind: "menu" }
  | { readonly kind: "commit"; readonly id: HubEntryId }
  | { readonly kind: "none" } {
  // A VoiceOver double-tap does what a sighted tap does: it opens the hub. The
  // fan never opens under VoiceOver, so that is the actions menu (owner Q2 = B
  // of docs/feat/mobile-hub-tap.md). The rotor still reaches Activity directly.
  if (name === "activate" || name === "longpress" || name === SHOW_ALL) {
    return { kind: "menu" };
  }
  const id = name.startsWith(ITEM_ACTION) ? name.slice(ITEM_ACTION.length) : "";
  return ENTRY_IDS.includes(id) ? { kind: "commit", id: id as HubEntryId } : { kind: "none" };
}

/** The fan is up (finger down on it, or lifted in place): the back-swipe is off (M2). */
export function isFanOpen(state: GestureState): boolean {
  return state.kind === "fanTracking" || state.kind === "fanSticky";
}

export interface HubDriver {
  down(p: Point, t: number): void;
  move(p: Point, t: number): void;
  up(p: Point, t: number): void;
  /** The system took the touch (call, background, terminate) or the world changed (M6/M10/M15). */
  cancel(): void;
  tapOverlay(p: Point): void;
  /** Unmount: the timer is cleared and an open fan is closed (its `close` still applies). */
  dispose(): void;
  state(): GestureState;
}

/**
 * The machine (`hub-gesture.reduce`) with its ONE timer: armed on the down that
 * starts a press, cleared on every way out of `pressing` (up, drag, cancel,
 * dispose — M12/M13). A second finger's down is the reducer's to ignore (M16);
 * it arms nothing. Clock and timers are injected, so this is tested with fakes.
 */
export function createHubDriver(deps: {
  readonly solve: () => HubMenu;
  readonly now: () => number;
  readonly arm: (fire: () => void, ms: number) => unknown;
  readonly disarm: (handle: unknown) => void;
  readonly apply: (effects: readonly GestureEffect[]) => void;
}): HubDriver {
  let state: GestureState = IDLE;
  let timer: { readonly handle: unknown } | null = null;
  const clear = () => {
    if (timer !== null) {
      deps.disarm(timer.handle);
      timer = null;
    }
  };
  const feed = (event: GestureEvent) => {
    const was = state.kind;
    const step = reduce(state, event, deps.solve);
    state = step.state;
    if (state.kind !== "pressing") {
      clear();
    } else if (was === "idle") {
      timer = {
        handle: deps.arm(() => {
          timer = null;
          feed({ type: "timer", t: deps.now() });
        }, LONG_MS),
      };
    }
    if (step.effects.length > 0) {
      deps.apply(step.effects);
    }
  };
  return {
    down: (p, t) => feed({ type: "down", p, t }),
    move: (p, t) => feed({ type: "move", p, t }),
    up: (p, t) => feed({ type: "up", p, t }),
    cancel: () => feed({ type: "cancel" }),
    tapOverlay: (p) => feed({ type: "tapOverlay", p }),
    dispose: () => {
      clear();
      if (state.kind !== "idle") {
        feed({ type: "cancel" });
      }
    },
    state: () => state,
  };
}
