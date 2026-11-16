/**
 * `artifact-cache.ts` (docs/feat/model-artifacts.md D9, T7.4): the LRU plan the
 * phone's 200 MB cache follows. The trap it exists for: the file a viewer is
 * HOLDING is never the one evicted, even when it is the least recently used —
 * dropping it mid-view would break the open artifact to make room for another.
 */
import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_CACHE_BYTES,
  type CacheState,
  EMPTY_CACHE,
  cacheBytes,
  cacheDir,
  cachePath,
  forget,
  missingFrom,
  planCache,
  shareName,
  touch,
} from "../src/artifact-cache.ts";

const MB = 1024 * 1024;
const entry = (sha256: string, size: number, usedAt: number) => ({ sha256, size, usedAt });
const state = (...entries: ReturnType<typeof entry>[]): CacheState => ({ entries });
const incoming = (sha256: string, size = MB) => ({ sha256, size });

describe("planCache", () => {
  test("under the cap: the version is kept, nothing is evicted", () => {
    const plan = planCache(state(entry("a", MB, 1)), incoming("b"), null, 2, 3 * MB);
    expect(plan.evict).toEqual([]);
    expect(plan.wontFit).toBe(false);
    expect(plan.state.entries.map((e) => e.sha256)).toEqual(["a", "b"]);
  });

  test("over the cap: the least recently used goes first, and only as many as needed", () => {
    const before = state(entry("old", MB, 1), entry("mid", MB, 2), entry("new", MB, 3));
    const plan = planCache(before, incoming("in", MB), null, 4, 3 * MB);
    expect(plan.evict).toEqual(["old"]);
    expect(plan.state.entries.map((e) => e.sha256)).toEqual(["mid", "new", "in"]);
    expect(cacheBytes(plan.state)).toBeLessThanOrEqual(3 * MB);
  });

  test("the version a viewer HOLDS is never evicted, even as the least recently used", () => {
    const before = state(entry("open", 2 * MB, 1), entry("newer", MB, 5));
    const plan = planCache(before, incoming("in", MB), "open", 6, 3 * MB);
    expect(plan.evict).toEqual(["newer"]);
    expect(plan.state.entries.map((e) => e.sha256)).toEqual(["open", "in"]);
  });

  test("the held version's presence can make the arrival `wontFit` (it is NOT dropped)", () => {
    const before = state(entry("open", 2 * MB, 1));
    const plan = planCache(before, incoming("in", 2 * MB), "open", 2, 3 * MB);
    expect(plan.evict).toEqual([]);
    expect(plan.wontFit).toBe(true);
    expect(plan.state.entries.map((e) => e.sha256)).toEqual(["open"]);
  });

  test("a version bigger than the whole cap cannot fit at all", () => {
    const plan = planCache(EMPTY_CACHE, incoming("big", 5 * MB), null, 1, 4 * MB);
    expect(plan.wontFit).toBe(true);
    expect(plan.evict).toEqual([]);
    expect(plan.state.entries).toEqual([]);
  });

  test("the default cap is the owner's 200 MB", () => {
    expect(ARTIFACT_CACHE_BYTES).toBe(200 * MB);
  });

  test("a sha already held is a TOUCH: no eviction, no duplicate entry", () => {
    const before = state(entry("a", MB, 1), entry("b", MB, 2));
    const plan = planCache(before, incoming("a"), null, 9, 2 * MB);
    expect(plan.evict).toEqual([]);
    expect(plan.state.entries.length).toBe(2);
    expect(plan.state.entries.find((e) => e.sha256 === "a")?.usedAt).toBe(9);
  });

  test("a tie on `usedAt` breaks on the sha, so the eviction order is deterministic", () => {
    const before = state(entry("zzz", MB, 1), entry("aaa", MB, 1), entry("mmm", MB, 1));
    const plan = planCache(before, incoming("in", MB), null, 2, MB);
    expect(plan.evict).toEqual(["aaa", "mmm", "zzz"]);
    expect(plan.state.entries.map((e) => e.sha256)).toEqual(["in"]);
  });
});

describe("touch / forget / missingFrom", () => {
  test("touch marks an entry most recent; an unknown sha changes nothing (same object)", () => {
    const before = state(entry("a", MB, 1));
    expect(touch(before, "a", 5).entries[0]?.usedAt).toBe(5);
    expect(touch(before, "nope", 5)).toBe(before);
  });

  test("forget removes one entry, and is a no-op (same object) for an unknown sha", () => {
    const before = state(entry("a", MB, 1), entry("b", MB, 2));
    expect(forget(before, "a").entries.map((e) => e.sha256)).toEqual(["b"]);
    expect(forget(before, "zz")).toBe(before);
  });

  test("missingFrom names exactly the shas not held (the delete step's check)", () => {
    const held = state(entry("a", MB, 1));
    expect(missingFrom(held, [{ sha256: "a" }, { sha256: "b" }])).toEqual(["b"]);
    expect(missingFrom(held, [])).toEqual([]);
  });
});

describe("paths and names", () => {
  test("the cache path is content-addressed under the computer", () => {
    expect(cachePath("mbp-1", "a".repeat(64))).toBe(`artifacts/mbp-1/${"a".repeat(64)}`);
    expect(cacheDir("mbp-1")).toBe("artifacts/mbp-1");
  });

  test("a computer id cannot escape its directory", () => {
    expect(cacheDir("../../etc")).toBe("artifacts/.._.._etc");
    expect(cachePath("a/b", "x")).toBe("artifacts/a_b/x");
    expect(cacheDir("a/b")).not.toContain("/b/");
  });

  test("a share name keeps a real extension, adds the kind's when missing, and sanitizes", () => {
    expect(shareName("report.pdf", "pdf")).toBe("report.pdf");
    expect(shareName("Q3 dashboard", "html")).toBe("Q3 dashboard.html");
    expect(shareName("../a/b:c", "png")).toBe(".._a_b_c.png");
    expect(shareName("", "bin")).toBe("artifact.bin");
    expect(shareName("weird.notanextension", "bin")).toBe("weird.notanextension.bin");
  });
});
