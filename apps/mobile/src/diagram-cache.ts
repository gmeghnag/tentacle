/**
 * The phone's diagram render cache (docs/feat/model-diagrams.md D5/D6): an
 * in-memory LRU of 32 renders, keyed `(sha256(canonical), scheme, fontScale)`,
 * plus the file naming the persistent half (D6) writes.
 *
 * Why the cache key carries the scheme and the font scale: mermaid bakes colours
 * and text metrics into the SVG it returns, so a light-mode render on a dark page
 * shows the wrong colours and a 1.0-scale render at 1.3 clips its labels. The
 * source is content-addressed (its canonical sha-256) rather than held whole:
 * two rows that show the same diagram share one entry, and a re-lint that
 * normalises differently is a different render, as it should be.
 *
 * Pure: no React, no FileSystem. D6 injects the file port and calls
 * {@link diagramCachePath} for the name.
 */
import { sha256Hex } from "./hash.ts";

/** How many renders are held in memory. Each SVG is ≤ 512 KiB (the bridge's cap). */
export const DIAGRAM_CACHE_MAX = 32;

/** One accepted render: the SVG and the size the renderer measured. */
export interface DiagramRender {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

/** The in-memory LRU: `put` accepts, `get` touches, the oldest goes first. */
export interface DiagramCache {
  get(key: string): DiagramRender | undefined;
  put(key: string, render: DiagramRender): void;
  readonly size: number;
}

/**
 * A render's identity: `base|<scheme>|<fontScale>|<sha256 of the canonical
 * source>`. The theme name leads so a future theme cannot collide with a scheme.
 */
export function diagramCacheKey(
  canonical: string,
  scheme: "light" | "dark",
  fontScale: number,
): string {
  return `base|${scheme}|${fontScale}|${sha256Hex(new TextEncoder().encode(canonical))}`;
}

/** A bounded LRU over `Map`'s insertion order (re-inserting a key moves it last). */
export function createDiagramCache(max: number = DIAGRAM_CACHE_MAX): DiagramCache {
  const held = new Map<string, DiagramRender>();
  return {
    get(key: string): DiagramRender | undefined {
      const value = held.get(key);
      if (value === undefined) return undefined;
      // A hit is a use: move it to the young end so the LRU order is honest.
      held.delete(key);
      held.set(key, value);
      return value;
    },
    put(key: string, render: DiagramRender): void {
      held.delete(key);
      held.set(key, render);
      while (held.size > max) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
    },
    get size(): number {
      return held.size;
    },
  };
}

/** The cache key's own parts, made safe for a filename: `|` becomes `-`. */
function filePart(value: string): string {
  const safe = value.replace(/\|/g, "-").replace(/[^A-Za-z0-9._-]/g, "_");
  // A run of dots anywhere is a climb (`diagrams/..` is the cache root's parent),
  // so every dot of such a run becomes `_` — the artifact cache's rule, widened
  // from a dot-ONLY segment to any run, because a key's parts are not segments.
  return safe === "" ? "_" : safe.replace(/\.{2,}/g, (dots) => "_".repeat(dots.length));
}

/**
 * Where the persistent copy of `key` lives, relative to
 * `FileSystem.cacheDirectory`: `diagrams/<key, | → ->.svg`. Content-addressed, so
 * the model's own title never names a file, and no run of dots can climb out.
 */
export function diagramCachePath(key: string): string {
  return `diagrams/${filePart(key)}.svg`;
}
