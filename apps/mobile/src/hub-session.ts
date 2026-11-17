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
import type { ScheduleRow } from "@tentacle/protocol";
import { FLOAT_SIZE, type FloatBounds, type FloatPosition, place } from "./floating-button.ts";
import type { HubContext, HubItem } from "./hub-actions.ts";
import { type Point, fanLayout } from "./hub-fan.ts";
import type { HubMenu } from "./hub-gesture.ts";
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
 * What the screen knows today. Artifacts are H4b's (feat/model-artifacts is not on
 * `main`): zero here, so that item stays absent (P6). Wakes come from the daemon's
 * table (`wakeContext`).
 */
export function hubContextOf(input: {
  readonly link: "up" | "down";
  readonly turn: TurnRow | null;
  readonly ended: EndReason | null;
  readonly editable: boolean;
  readonly dictation: boolean;
  /** The session's wake feed and the clock to measure it against (H4a). */
  readonly schedules?: {
    readonly rows: readonly ScheduleRow[] | undefined;
    readonly now: number;
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
    unseenArtifacts: 0,
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
  const at = input.bounds === null ? null : place(input.position, input.bounds);
  if (input.bounds === null || at === null) {
    return { layout: { kind: "menu" }, ids };
  }
  const layout = fanLayout({
    anchor: { x: at.x + FLOAT_SIZE / 2, y: at.y + FLOAT_SIZE / 2 },
    edge: input.position?.edge ?? "right",
    bounds: { left: 0, top: 0, right: input.bounds.width, bottom: input.bounds.height },
    n: ids.length,
  });
  return { layout, ids };
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
