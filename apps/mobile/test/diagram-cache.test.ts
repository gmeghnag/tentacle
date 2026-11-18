/**
 * T5.4, the cache (docs/feat/model-diagrams.md D5/D6): `(sha256(canonical),
 * scheme, fontScale)` → `{svg, w, h}`, an in-memory LRU of 32, so a scroll back
 * or a theme flip never re-renders.
 *
 * Two decisions, not rendering: WHICH inputs identify a render (a scheme left out
 * shows light-mode colours on a dark page; a font scale left out clips labels),
 * and what gets dropped. Both are pure here; the file half
 * (`FileSystem.cacheDirectory/diagrams/`) is a port D6 injects — this module only
 * names the path, so the naming (content-addressed, never a model's title) is
 * pinned by a test.
 */
import { describe, expect, test } from "bun:test";
import {
  DIAGRAM_CACHE_MAX,
  type DiagramRender,
  createDiagramCache,
  diagramCacheKey,
  diagramCachePath,
} from "../src/diagram-cache.ts";

const RENDER: DiagramRender = { svg: "<svg/>", width: 200, height: 100 };
const SOURCE = "flowchart TD\n  A --> B";
const OTHER = "flowchart TD\n  A --> C";

describe("diagramCacheKey — what identifies a render", () => {
  test("the key is the content hash, the scheme and the font scale", () => {
    const key = diagramCacheKey(SOURCE, "dark", 1.25);
    expect(key.startsWith("base|dark|1.25|")).toBe(true);
    // The hash, not the source: two spellings that canonicalise the same differ
    // before the lint, but the caller passes the CANONICAL form — so the same
    // source yields the same key twice.
    expect(diagramCacheKey(SOURCE, "dark", 1.25)).toBe(key);
  });

  test("a different source, scheme or font scale is a different key", () => {
    const base = diagramCacheKey(SOURCE, "light", 1);
    expect(diagramCacheKey(OTHER, "light", 1)).not.toBe(base);
    expect(diagramCacheKey(SOURCE, "dark", 1)).not.toBe(base);
    expect(diagramCacheKey(SOURCE, "light", 1.5)).not.toBe(base);
  });

  test("the hash is the sha-256 of the canonical bytes (so a colliding prefix cannot lie)", () => {
    // 64 lowercase hex chars, the same form the artifact cache uses.
    expect(/^base\|light\|1\|[0-9a-f]{64}$/.test(diagramCacheKey(SOURCE, "light", 1))).toBe(true);
    // The split inputs must not collide by concatenation: `A` + `B` vs `AB` + ``.
    expect(diagramCacheKey("AB", "light", 1)).not.toBe(diagramCacheKey("A", "light", 1));
  });
});

describe("createDiagramCache — the LRU", () => {
  test("a put is a get, and the value came back unchanged", () => {
    const cache = createDiagramCache();
    cache.put("k1", RENDER);
    expect(cache.get("k1")).toEqual(RENDER);
    expect(cache.get("nope")).toBeUndefined();
  });

  test("it holds at most DIAGRAM_CACHE_MAX entries and drops the least recently used", () => {
    const cache = createDiagramCache();
    expect(DIAGRAM_CACHE_MAX).toBe(32);
    for (let i = 0; i < DIAGRAM_CACHE_MAX; i += 1) cache.put(`k${i}`, RENDER);
    // Touch the oldest, so k1 (not k0) is the one that must go.
    expect(cache.get("k0")).toEqual(RENDER);
    cache.put("new", RENDER);
    expect(cache.size).toBe(DIAGRAM_CACHE_MAX);
    expect(cache.get("k0")).toEqual(RENDER);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("new")).toEqual(RENDER);
  });

  test("re-putting a key is a touch, not a second entry", () => {
    const cache = createDiagramCache();
    cache.put("k", RENDER);
    cache.put("k", RENDER);
    expect(cache.size).toBe(1);
  });

  test("the bound is a parameter, so a caller (a test) can hold it small", () => {
    const cache = createDiagramCache(2);
    cache.put("a", RENDER);
    cache.put("b", RENDER);
    cache.put("c", RENDER);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("diagramCachePath — the file half's naming (D6 writes it)", () => {
  test("content-addressed under the cache directory, never the model's title", () => {
    const key = diagramCacheKey(SOURCE, "dark", 1);
    const path = diagramCachePath(key);
    expect(path.startsWith("diagrams/")).toBe(true);
    expect(path).toBe(`diagrams/${key.replace(/\|/g, "-")}.svg`);
    expect(path.includes(" ")).toBe(false);
  });

  test("a key with a separator or a dot cannot escape the directory", () => {
    // The key's only free parts are the scheme and the scale; both are sanitised.
    const path = diagramCachePath("base|../../etc|1");
    expect(path.startsWith("diagrams/")).toBe(true);
    expect(path.includes("..")).toBe(false);
    expect(path.includes("/etc")).toBe(false);
  });
});
