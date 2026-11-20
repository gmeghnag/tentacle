/**
 * A chart artifact's THUMBNAIL in the gallery (docs/feat/mobile-gallery-polish.md):
 * what a tile draws, at what scale, and whether it draws at all — pure and
 * React-free (AGENTS §7); `ui/chart/ChartThumbnail.tsx` only maps it to elements.
 *
 * Why it is its own projection, not the transcript layout at tile size: the
 * transcript layout keeps its chrome however small the box (a donut's fixed
 * 60 pt ring and its legend chips, a bar chart's natural height, the axis
 * gutters that invert a 32 pt plot), so at 40 pt it drew 4× outside the tile
 * (the owner's 2026-11-20 screenshot). Here the chart is laid out ONCE at a
 * reference size, only its marks are kept (no legend, no text, no guides, no
 * tracks), and the tile scales that one drawing into its own box through a view
 * box that is proved to contain every mark — the same drawing at 52 pt in the
 * list and at a grid cell's size.
 */
import type { ArtifactMeta } from "@tentacle/protocol";
import type { LayoutDot, LayoutKind, LayoutPath } from "./chart-layout-kit.ts";
import { DONUT, donutDisc } from "./chart-layout-shapes.ts";
import { type ChartRowOptions, type ChartRowView, chartThumbView } from "./chart-row.ts";

/** The size the thumbnail's chart is laid out at (then scaled into each tile). */
export const THUMB_LAYOUT = { width: 160, height: 120 } as const;

/** Thinner than this (pt, on screen) and a mark is a hairline, not a shape. */
export const MIN_MARK = 1.5;
/** A line's least on-screen width (pt): a 1.5 pt stroke scaled to 0.4 would vanish. */
export const MIN_STROKE = 1.25;
/** A scatter dot's least on-screen radius (pt). */
export const MIN_DOT = 1.5;

/** The roles that are the chart's MARKS; every other role is chrome a tile drops. */
const MARK_ROLES: ReadonlySet<LayoutPath["role"]> = new Set([
  "line",
  "fill",
  "bar",
  "sector",
  "trend",
]);

export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The chart, laid out once: its marks and the box that holds them (layout units). */
export interface ChartThumbGeometry {
  readonly kind: LayoutKind;
  readonly viewBox: ViewBox;
  readonly paths: readonly LayoutPath[];
  readonly dots: readonly LayoutDot[];
  /** The smallest mark's thickness (layout units): a bar's width, a ring's depth. */
  readonly thinnest: number | null;
  readonly view: ChartRowView;
}

/** What one tile draws: the geometry scaled into `width`×`height` pt. */
export interface ChartThumbView {
  readonly width: number;
  readonly height: number;
  readonly viewBox: ViewBox;
  readonly paths: readonly LayoutPath[];
  readonly dots: readonly LayoutDot[];
  readonly view: ChartRowView;
}

/** A tile's box, in pt. */
export interface TileBox {
  readonly width: number;
  readonly height: number;
}

/**
 * A chart artifact's thumbnail geometry, or `null` (not a chart, a spec this
 * build cannot re-validate — `chartThumbView` is the same re-validation the
 * transcript does — or a chart with no mark to draw). The tile then shows its
 * kind's symbol.
 */
export function chartThumbGeometry(
  meta: ArtifactMeta,
  bytes: Uint8Array,
  options: Omit<ChartRowOptions, "width" | "height" | "labels" | "hidden">,
): ChartThumbGeometry | null {
  const view = chartThumbView(meta, bytes, {
    ...options,
    width: THUMB_LAYOUT.width,
    height: THUMB_LAYOUT.height,
  });
  return view === null ? null : thumbGeometryOf(view);
}

/** The marks of a laid-out chart and the box that holds them (exported for tests). */
export function thumbGeometryOf(view: ChartRowView): ChartThumbGeometry | null {
  const { layout } = view;
  // A line chart's fill is the soft gradient under the line: at tile size, drawn
  // flat, it is a solid block (simulator, 2026-11-20) — the line alone is the shape.
  const paths = layout.paths.filter(
    (p) => MARK_ROLES.has(p.role) && !(layout.kind === "line" && p.role === "fill"),
  );
  // A dot on a line or an area is an annotation (the hero point, the line's
  // end), not data at this size; a scatter's dots ARE its data.
  const dots =
    layout.kind === "scatter" ? layout.dots.map(({ halo: _halo, ...dot }) => dot as LayoutDot) : [];
  if (paths.length === 0 && dots.length === 0) return null;
  return {
    kind: layout.kind,
    viewBox: viewBoxOf(view, dots),
    paths,
    dots,
    thinnest: thinnestOf(layout.kind, paths),
    view,
  };
}

function viewBoxOf(view: ChartRowView, dots: readonly LayoutDot[]): ViewBox {
  const { layout } = view;
  if (layout.kind === "donut") {
    // The disc alone: the legend beside it is chrome.
    const { cx, cy, r } = donutDisc(layout.height);
    return { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
  }
  if (layout.kind === "scatter" && dots.length > 0) return scatterBox(dots);
  // Every other kind draws inside its plot; a dot (and its ring) and a stroke
  // may reach past the plot's edge by their own size, so the box grows by that.
  const reach = Math.max(
    1,
    ...dots.map((d) => d.r + (d.ring ?? 0)),
    ...layout.paths.filter((p) => MARK_ROLES.has(p.role)).map((p) => (p.strokeWidth ?? 0) / 2 + 1),
  );
  const { left, right, top, bottom } = layout.plot;
  return {
    x: left - reach,
    y: top - reach,
    w: right - left + 2 * reach,
    h: bottom - top + 2 * reach,
  };
}

/**
 * A scatter's box is its POINTS, not its plot: the plot's axes may start at 0,
 * leaving the cloud a thin streak in a corner (simulator, 2026-11-20). The box
 * holds every dot with its ring, and is never thinner than `SCATTER_ASPECT` of
 * its long side, so a near-straight cloud is not stretched into a smear.
 */
export const SCATTER_ASPECT = 0.6;

function scatterBox(dots: readonly LayoutDot[]): ViewBox {
  const reach = Math.max(...dots.map((d) => d.r + (d.ring ?? 0)));
  const x0 = Math.min(...dots.map((d) => d.x)) - reach;
  const x1 = Math.max(...dots.map((d) => d.x)) + reach;
  const y0 = Math.min(...dots.map((d) => d.y)) - reach;
  const y1 = Math.max(...dots.map((d) => d.y)) + reach;
  const side = Math.max(x1 - x0, y1 - y0);
  const w = Math.max(x1 - x0, side * SCATTER_ASPECT);
  const h = Math.max(y1 - y0, side * SCATTER_ASPECT);
  return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
}

function thinnestOf(kind: LayoutKind, paths: readonly LayoutPath[]): number | null {
  if (kind === "donut") return DONUT.ro - DONUT.ri;
  if (kind !== "bars" && kind !== "columns" && kind !== "stacked") return null;
  const across = paths
    .filter((p) => p.role === "bar" && p.box !== undefined)
    .map((p) => (kind === "bars" ? p.box?.h : p.box?.w) ?? 0);
  return across.length === 0 ? null : Math.min(...across);
}

/** The scale a view box is drawn at in a box (`meet`: the whole box fits, centred). */
export function thumbScale(viewBox: ViewBox, box: TileBox): number {
  return Math.min(box.width / viewBox.w, box.height / viewBox.h);
}

/**
 * The tile's drawing at `box`, or `null` when the chart is not LEGIBLE there —
 * its thinnest mark would be under `MIN_MARK` pt (forty bars in a 52 pt tile are
 * a grey smear) — and the tile shows its kind's symbol instead. Strokes and
 * scatter dots are widened (in layout units) so they keep a visible size.
 */
export function chartThumbAt(geometry: ChartThumbGeometry, box: TileBox): ChartThumbView | null {
  if (!(box.width > 0 && box.height > 0)) return null;
  const s = thumbScale(geometry.viewBox, box);
  if (geometry.thinnest !== null && geometry.thinnest * s < MIN_MARK) return null;
  return {
    width: box.width,
    height: box.height,
    viewBox: geometry.viewBox,
    paths: geometry.paths.map((p) =>
      p.strokeWidth === undefined
        ? p
        : { ...p, strokeWidth: Math.max(p.strokeWidth, MIN_STROKE / s) },
    ),
    dots: geometry.dots.map((d) => ({ ...d, r: Math.max(d.r, MIN_DOT / s) })),
    view: geometry.view,
  };
}

/** The SVG `viewBox` attribute. */
export function viewBoxAttr(v: ViewBox): string {
  return `${v.x} ${v.y} ${v.w} ${v.h}`;
}
