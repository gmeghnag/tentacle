/**
 * The hub's radial fan: where the items go, which one the finger is on, where
 * the label pill sits, and how it moves (docs/feat/mobile-hub.md Design 3–4).
 * Pure, no React: `ui/HubFan.tsx` renders what this returns.
 *
 * Every point is in ONE coordinate space, chosen by the caller (the band's or
 * the page's): the anchor, the bounds and the finger must agree. `bounds` is the
 * measured band (header bottom, composer or keyboard top, screen sides minus the
 * safe area), the same measurement `floating-button.ts` `snap` uses, so nothing
 * here guesses where the header, composer or keyboard are.
 */
import type { Edge } from "./floating-button.ts";
import type { HubBadge, HubItem } from "./hub-actions.ts";

/** An item's diameter (pt): ≥ 44 pt touch target. */
export const ITEM_SIZE = 48;
/** Centre-to-centre distance between adjacent items (pt). */
export const ITEM_PITCH = 56;
/** Kept clear between an item's edge and every bound (pt). */
export const FAN_PAD = 8;
/** One ring: radii tried, smallest first (shortest thumb travel). */
export const ONE_RING = { min: 96, max: 148, step: 4 } as const;
/** Two rings: inner radii tried; the outer ring sits `ITEM_PITCH` further out. */
export const TWO_RINGS = { min: 88, max: 120, step: 4 } as const;
/** Selection is dead inside this fraction of the inner radius (the finger is still on the button). */
export const DEAD_ZONE = 0.45;
/** … and ends this far past the outer ring (pt). */
export const REACH = 56;
/** A neighbour wins only this far past the midpoint (degrees) — no flicker. */
export const HYSTERESIS_DEG = 4;
/** The same, across the boundary between two rings (pt). */
export const RING_HYSTERESIS = 4;
/** Lift-then-tap: a tap hits an item within this distance of its centre (pt). */
export const STICKY_HIT = 30;
/** Label pill: its near edge sits this far from the item's centre (covers the ×1.3 item). */
export const LABEL_GAP = 40;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface FanItem {
  readonly x: number;
  readonly y: number;
  /** Radians, from the anchor (screen y grows down). */
  readonly angle: number;
  readonly R: number;
  /** 0 = inner (or the only) ring, 1 = outer. */
  readonly ring: 0 | 1;
}

export type FanLayout =
  | {
      readonly kind: "fan";
      readonly anchor: Point;
      readonly edge: Edge;
      /** One radius per ring, inner first. */
      readonly radii: readonly number[];
      /** The angle between adjacent items, per ring (radians). */
      readonly steps: readonly number[];
      /** In priority order: item 0 is the end of its ring nearest the composer. */
      readonly items: readonly FanItem[];
    }
  | { readonly kind: "menu" };

const DEG = Math.PI / 180;

/** The angle between adjacent items on a ring of radius `R` (their centres `ITEM_PITCH` apart). */
function stepFor(R: number): number {
  return 2 * Math.asin(ITEM_PITCH / 2 / R);
}

/** |a − b| folded into [0, π]. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/**
 * Where the n items go around the button (Design 3), or `menu` when no fan fits
 * whole — the fan is never clipped:
 * 1. aim at the band's centre (inward from either edge, bending away from the
 *    header and the composer);
 * 2. one ring, the smallest radius in 96…148 whose arc fits, its centre searched
 *    outward from that aim 1° at a time;
 * 3. else two rings (inner ⌈n/2⌉ at 88…120, outer the rest 56 pt further out);
 * 4. else the menu.
 * Each ring is ordered from its lowest end (nearest the composer: the thumb's
 * shortest travel); the inner ring holds the first half.
 */
export function fanLayout(input: {
  readonly anchor: Point;
  readonly edge: Edge;
  readonly bounds: Rect;
  readonly n: number;
}): FanLayout {
  const { anchor, edge, bounds } = input;
  const n = Math.max(0, Math.floor(input.n));
  if (n === 0) {
    return { kind: "fan", anchor, edge, radii: [], steps: [], items: [] };
  }
  const keep = ITEM_SIZE / 2 + FAN_PAD;
  const inside = (x: number, y: number) =>
    x >= bounds.left + keep &&
    x <= bounds.right - keep &&
    y >= bounds.top + keep &&
    y <= bounds.bottom - keep;
  const aim = Math.atan2(
    (bounds.top + bounds.bottom) / 2 - anchor.y,
    (bounds.left + bounds.right) / 2 - anchor.x,
  );
  const ring = (R: number, k: number, centre: number, index: 0 | 1): FanItem[] | null => {
    const step = stepFor(R);
    const items: FanItem[] = [];
    for (let i = 0; i < k; i++) {
      const angle = centre - ((k - 1) * step) / 2 + i * step;
      const x = anchor.x + R * Math.cos(angle);
      const y = anchor.y + R * Math.sin(angle);
      if (!inside(x, y)) {
        return null;
      }
      items.push({ x, y, angle, R, ring: index });
    }
    const first = items[0];
    const last = items[items.length - 1];
    return first !== undefined && last !== undefined && first.y < last.y ? items.reverse() : items;
  };
  const search = (fits: (centre: number) => FanItem[] | null): FanItem[] | null => {
    for (let k = 0; k <= 180; k++) {
      for (const sign of [1, -1]) {
        const found = fits(aim + sign * k * DEG);
        if (found !== null) {
          return found;
        }
      }
    }
    return null;
  };
  for (let R = ONE_RING.min; R <= ONE_RING.max; R += ONE_RING.step) {
    const items = search((centre) => ring(R, n, centre, 0));
    if (items !== null) {
      return { kind: "fan", anchor, edge, radii: [R], steps: [stepFor(R)], items };
    }
  }
  const inner = Math.ceil(n / 2);
  const outer = n - inner;
  for (let R = TWO_RINGS.min; R <= TWO_RINGS.max; R += TWO_RINGS.step) {
    const R2 = R + ITEM_PITCH;
    const items = search((centre) => {
      const a = ring(R, inner, centre, 0);
      const b = a === null || outer === 0 ? [] : ring(R2, outer, centre, 1);
      return a === null || b === null ? null : [...a, ...b];
    });
    if (items !== null) {
      return outer === 0
        ? { kind: "fan", anchor, edge, radii: [R], steps: [stepFor(R)], items }
        : { kind: "fan", anchor, edge, radii: [R, R2], steps: [stepFor(R), stepFor(R2)], items };
    }
  }
  return { kind: "menu" };
}

/**
 * The item under the finger (Design 3 "Selection"), or null.
 * - Sliding: the angular sector of each item around the anchor, live between
 *   `DEAD_ZONE`·R and the outer ring + `REACH`; with two rings the radius picks
 *   the ring (4 pt of hysteresis at the boundary). The previous item holds until
 *   the finger is `HYSTERESIS_DEG` past the midpoint (or past its own outer
 *   sector edge), so the highlight — and its haptic tick — never flickers.
 * - Sticky (lift-then-tap): the nearest item within `STICKY_HIT` of its centre.
 */
export function pickItem(
  layout: FanLayout,
  point: Point,
  prev: number | null,
  options?: { readonly sticky?: boolean },
): number | null {
  if (layout.kind !== "fan" || layout.items.length === 0) {
    return null;
  }
  const { anchor, items, radii, steps } = layout;
  if (options?.sticky === true) {
    let best: number | null = null;
    let bestDist = STICKY_HIT;
    items.forEach((it, i) => {
      const d = Math.hypot(point.x - it.x, point.y - it.y);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
    });
    return best;
  }
  const inner = radii[0] ?? 0;
  const outerR = radii[radii.length - 1] ?? 0;
  const d = Math.hypot(point.x - anchor.x, point.y - anchor.y);
  if (d < DEAD_ZONE * inner || d > outerR + REACH) {
    return null;
  }
  const held = prev === null ? undefined : items[prev];
  let ring: 0 | 1 = 0;
  const second = radii[1];
  if (second !== undefined) {
    const boundary = (inner + second) / 2;
    const bias = held === undefined ? 0 : held.ring === 0 ? RING_HYSTERESIS : -RING_HYSTERESIS;
    ring = d >= boundary + bias ? 1 : 0;
  }
  const angle = Math.atan2(point.y - anchor.y, point.x - anchor.x);
  const half = (steps[ring] ?? 0) / 2;
  let best: number | null = null;
  let bestOff = Number.POSITIVE_INFINITY;
  items.forEach((it, i) => {
    const off = angleBetween(angle, it.angle);
    if (it.ring === ring && off < bestOff) {
      best = i;
      bestOff = off;
    }
  });
  const hyst = HYSTERESIS_DEG * DEG;
  if (held !== undefined && held.ring === ring) {
    const heldOff = angleBetween(angle, held.angle);
    if (heldOff <= half + hyst && heldOff - bestOff < 2 * hyst) {
      return prev;
    }
  }
  return bestOff <= half ? best : null;
}

/**
 * Where the highlighted item's label pill goes (its top-left): on the inner side
 * (left of the item for a right-edge button), vertically centred on it; if it
 * does not fit there, centred above the item. Always clamped inside `screen`
 * minus `FAN_PAD`, starting at the left padding when wider than the screen.
 * `size` is the measured pill (Dynamic Type grows it, never the items).
 */
export function labelPlacement(
  layout: FanLayout,
  index: number,
  size: { readonly width: number; readonly height: number },
  screen: Rect,
): Point | null {
  const it = layout.kind === "fan" ? layout.items[index] : undefined;
  if (layout.kind !== "fan" || it === undefined) {
    return null;
  }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const minX = screen.left + FAN_PAD;
  const maxX = screen.right - FAN_PAD - size.width;
  const minY = screen.top + FAN_PAD;
  const maxY = screen.bottom - FAN_PAD - size.height;
  const side = layout.edge === "right" ? it.x - LABEL_GAP - size.width : it.x + LABEL_GAP;
  if (side >= minX && side <= maxX) {
    return { x: side, y: clamp(it.y - size.height / 2, minY, maxY) };
  }
  return {
    x: clamp(it.x - size.width / 2, minX, maxX),
    y: clamp(it.y - LABEL_GAP - size.height, minY, maxY),
  };
}

/** A count this large already draws the whole rim (owner Q2 C: 36° per item, 360/36 = 10). */
export const RIM_FULL = 10;

/**
 * How much of an item's rim the badge fills, 0–1, or null for no rim
 * (mobile-hub-badges Design 6, owner Q2 C). A count is one 36° step per item
 * (1 → 0.1, clamped at 10), and a `dot` — a scheduled wake that is due — is the
 * whole rim: the dot's meaning expressed as a shape. A count ≤ 0 is no news at
 * all (F7: never a backwards arc, never NaN).
 */
export function rimFraction(badge: HubBadge | null): number | null {
  if (badge === null) {
    return null;
  }
  if (badge.kind === "dot") {
    return 1;
  }
  if (!Number.isFinite(badge.n) || badge.n <= 0) {
    return null;
  }
  return Math.min(badge.n, RIM_FULL) / RIM_FULL;
}

/**
 * How one fan item is drawn (mobile-hub-badges Design 7, owner Q3 B): SOLID
 * discs, so the transcript can never bleed through — `glass` is never returned.
 * Colours are palette KEYS, not hex values: the choice is a rule (and is tested),
 * the colour itself is `theme.ts`'s.
 *
 * Not lit: a `card` disc with an accent glyph (`red` for Stop), or, dimmed, a
 * `fill` disc with a `sec` glyph — the dimmed item's faintness is a COLOUR now,
 * no longer an opacity, so the item's opacity stays purely its own motion.
 * Lit: an `accentFill` (`red` for Stop) disc, everything `onAccent`, so its rim
 * never disappears into its own disc (F9).
 */
export interface FanItemLook {
  readonly bg: "card" | "fill" | "accentFill" | "red";
  readonly fg: "accent" | "red" | "onAccent" | "sec";
  /**
   * 0–1, or null → draw no rim. `item.rim` is an item's OWN figure (the Tools
   * item's share switched off); every other item's rim is its badge's.
   */
  readonly rim: number | null;
  readonly rimTone: "accent" | "onAccent";
}

/** The figure an item's rim draws: its own (`item.rim`), else its badge's. */
function itemRim(item: HubItem): number | null {
  return item.rim === undefined ? rimFraction(item.badge) : item.rim;
}

/** The look of one item; `lit` is the finger's highlight (the only state that grows). */
export function fanItemLook(item: HubItem, lit: boolean): FanItemLook {
  if (lit) {
    return {
      bg: item.danger ? "red" : "accentFill",
      fg: "onAccent",
      rim: itemRim(item),
      rimTone: "onAccent",
    };
  }
  if (item.dimmed) {
    return { bg: "fill", fg: "sec", rim: null, rimTone: "accent" };
  }
  return {
    bg: "card",
    fg: item.danger ? "red" : "accent",
    rim: itemRim(item),
    rimTone: "accent",
  };
}

export interface FanMotion {
  readonly spring: boolean;
  readonly staggerMs: number;
  readonly damping: number;
  readonly stiffness: number;
  readonly fromScale: number;
  readonly highlightScale: number;
  readonly dimOpacity: number;
  readonly fadeMs: number;
  readonly collapseMs: number;
}

/**
 * How the fan moves (Design 4). Default: items spring out from the button,
 * staggered 18 ms (≈ 200 ms for six), the highlighted one grows ×1.3 and the
 * rest dim. Reduce Motion (read per open, M11): one 120 ms fade, no spring, no
 * stagger, no growth — the highlight is the accent fill alone.
 */
export function fanMotion(reduceMotion: boolean): FanMotion {
  const shared = { damping: 18, stiffness: 260, dimOpacity: 0.55, fadeMs: 120, collapseMs: 120 };
  return reduceMotion
    ? { ...shared, spring: false, staggerMs: 0, fromScale: 1, highlightScale: 1 }
    : { ...shared, spring: true, staggerMs: 18, fromScale: 0.4, highlightScale: 1.3 };
}
