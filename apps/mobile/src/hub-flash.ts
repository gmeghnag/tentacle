/**
 * The dimmed hub item's in-place label (docs/feat/mobile-hub-commands.md C1
 * Design 6, owner Q3 A): a tap on an item with nothing to show flashes the
 * item's OWN pill with the reason for a moment, then swaps it back. Pure and
 * React-free (AGENTS §7) — `ui/HubFan.tsx` asks which text and whether the pill
 * is drawn, and owns only the one timer that re-renders it.
 */
import type { HubItem } from "./hub-actions.ts";

/**
 * How long the reason stays in place: ~1.6 s (owner Q3 A). The window is
 * HALF-OPEN — `now - at < FLASH_MS` — so it ends exactly on the millisecond
 * (tests pin both sides).
 */
export const FLASH_MS = 1600;

/** A flash in progress: which fan index, and when the machine reported it. */
export interface Flash {
  readonly index: number;
  /** The machine's clock at the tap (`GestureEffect` `flash` is index-only). */
  readonly at: number;
}

/** The index whose reason is showing at `now`, or null when no flash is live. */
function flashing(flash: Flash | null | undefined, now: number): number | null {
  if (flash === null || flash === undefined) {
    return null;
  }
  const elapsed = now - flash.at;
  // A clock that went backwards is not a live flash: `elapsed < 0` fails the
  // window, so the item falls back to its own label.
  return elapsed >= 0 && elapsed < FLASH_MS ? flash.index : null;
}

/**
 * What the pill at `index` says: that item's empty reason while ITS flash lasts,
 * else its label. An item with nothing to show always HAS a reason
 * (`emptyLabel`), so a flash of a live item falls back to the label rather than
 * inventing a sentence.
 */
export function pillText(
  item: HubItem,
  index: number,
  flash: Flash | null | undefined,
  now: number,
): string {
  return item.emptyLabel !== null && flashing(flash, now) === index ? item.emptyLabel : item.label;
}

/**
 * Whether the pill at `index` is drawn at all: the finger's highlight shows it,
 * and so does a live flash (the reason must be readable with the fan open and
 * the finger off the item — and it goes away with the flash).
 */
export function pillVisible(
  index: number,
  highlighted: number | null,
  flash: Flash | null | undefined,
  now: number,
): boolean {
  return index === highlighted || flashing(flash, now) === index;
}

/**
 * WHICH item's pill the fan draws: there is one pill, so the finger's highlight
 * wins and a live flash keeps its own in place after the finger leaves.
 */
export function pillIndex(
  highlighted: number | null,
  flash: Flash | null | undefined,
  now: number,
): number | null {
  return highlighted ?? flashing(flash, now);
}
