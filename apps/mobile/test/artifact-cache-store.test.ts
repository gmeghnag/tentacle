/**
 * The phone's artifact cache STORE (Review round 3, finding 1; D9): the pure LRU
 * plan (`artifact-cache.ts`) made real over an injected filesystem port, so the
 * 200 MB cap, the "too big to keep" note and the unpair delete actually happen.
 *
 * Two things this pins that the plan alone cannot:
 * - **the plan follows the DISK, not a memory of it.** The cap can only be
 *   enforced over bytes that are really counted: a file the app wrote in an
 *   earlier run is seen, and the state is rebuilt from the directory (a cache
 *   that forgets what it holds can never evict).
 * - **the version a viewer holds survives.** Opening one artifact evicts
 *   others, never the one on screen.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  type CacheFiles,
  EMPTY_CACHE,
  artifactFileExt,
  cacheDir,
  cachePath,
  createArtifactCache,
} from "../src/artifact-cache-store.ts";
import { ARTIFACT_CACHE_BYTES } from "../src/artifact-cache.ts";
import { pdfViewerProps } from "../src/artifact-viewer.ts";

const MB = 1024 * 1024;
/** A real 64-hex content hash (the store only plans over version names). */
const sha = (tag: string): string => {
  let hex = "";
  for (const ch of tag) {
    hex += (ch.codePointAt(0) ?? 0).toString(16).padStart(2, "0");
  }
  return hex.repeat(Math.ceil(64 / hex.length)).slice(0, 64);
};

function meta(over: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    artifactId: "a",
    version: 1,
    sha256: sha("a"),
    size: 1000,
    mimeType: "image/png",
    kind: "image",
    title: "chart.png",
    callId: "c1",
    createdAt: 0,
    ...over,
  };
}

/** An in-memory filesystem: the port's whole surface, and its clock. */
function files() {
  const held = new Map<string, { bytes: Uint8Array; usedAt: number }>();
  const dirs = new Set<string>();
  let clock = 1000;
  const port: CacheFiles = {
    list: (dir) =>
      [...held.entries()]
        .filter(([path]) => path.startsWith(`${dir}/`))
        .map(([path, value]) => ({
          name: path.slice(dir.length + 1),
          size: value.bytes.length,
          usedAt: value.usedAt,
        })),
    write: (path, bytes) => {
      held.set(path, { bytes, usedAt: clock++ });
    },
    remove: (path) => {
      held.delete(path);
    },
    copy: (from, to) => {
      const source = held.get(from);
      if (source !== undefined) {
        held.set(to, { bytes: source.bytes, usedAt: clock++ });
      }
    },
    removeDir: (dir) => {
      dirs.delete(dir);
      for (const path of [...held.keys()]) {
        if (path.startsWith(`${dir}/`)) {
          held.delete(path);
        }
      }
    },
    mkdir: (dir) => {
      dirs.add(dir);
    },
    uriFor: (path) => `file:///cache/${path}`,
  };
  return { held, dirs, port, tick: () => clock++ };
}

describe("put: the bytes land, and the LRU is what decided", () => {
  test("a small file is written, and `uri` is the content-addressed path (mutation: no plan → red)", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    const put = cache.put("c1", meta(), new Uint8Array(10));
    expect(put.written).toBe(true);
    expect(put.note).toBeNull();
    expect(put.uri).toBe(`file:///cache/${cachePath("c1", sha("a"), "png")}`);
    expect(disk.held.size).toBe(1);
    expect(disk.dirs.has(cacheDir("c1"))).toBe(true);
  });

  test("over the cap the least recently used is DELETED from the disk (mutation: plan but never remove → red)", () => {
    const disk = files();
    const cap = 3 * MB;
    let now = 1;
    const cache = createArtifactCache({ files: disk.port, now: () => now++, cap });
    cache.put("c1", meta({ sha256: sha("1"), size: MB }), new Uint8Array(MB));
    cache.put("c1", meta({ sha256: sha("2"), size: MB }), new Uint8Array(MB));
    cache.put("c1", meta({ sha256: sha("3"), size: MB }), new Uint8Array(MB));
    expect(disk.held.size).toBe(3);
    cache.put("c1", meta({ sha256: sha("4"), size: MB }), new Uint8Array(MB));
    // Still three files, and the FIRST one is the one that went.
    expect(disk.held.size).toBe(3);
    expect(disk.held.has(cachePath("c1", sha("1"), "png"))).toBe(false);
    expect(disk.held.has(cachePath("c1", sha("4"), "png"))).toBe(true);
  });

  test("the version a viewer HOLDS is never the one evicted (mutation: drop `keep` → red)", () => {
    const disk = files();
    const cap = 2 * MB;
    let now = 1;
    const cache = createArtifactCache({ files: disk.port, now: () => now++, cap });
    cache.put("c1", meta({ sha256: sha("open"), size: 2 * MB }), new Uint8Array(2 * MB));
    // The viewer opened it: it is what a later arrival must not drop.
    cache.hold("c1", sha("open"));
    cache.put("c1", meta({ sha256: sha("next"), size: MB }), new Uint8Array(MB));
    // Over the cap, but the open file is untouchable: the arrival is refused.
    expect(disk.held.has(cachePath("c1", sha("open"), "png"))).toBe(true);
    expect(disk.held.has(cachePath("c1", sha("next"), "png"))).toBe(false);
    // Closing the viewer releases it: the same arrival now fits.
    cache.hold("c1", null);
    cache.put("c1", meta({ sha256: sha("after"), size: MB }), new Uint8Array(MB));
    expect(disk.held.has(cachePath("c1", sha("after"), "png"))).toBe(true);
  });

  test("a file too big for the whole cache is NOT written, and the note says so", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick(), cap: MB });
    const put = cache.put("c1", meta({ size: 5 * MB }), new Uint8Array(5 * MB));
    expect(put.written).toBe(false);
    expect(put.uri).toBeNull();
    expect(put.note).toBe("Too big to keep on this phone (5 MB)");
    expect(disk.held.size).toBe(0);
  });

  test("a re-arrival of bytes already held writes nothing (content-addressed)", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    cache.put("c1", meta(), new Uint8Array(10));
    const before = disk.held.get(cachePath("c1", sha("a"), "png"))?.usedAt;
    const again = cache.put("c1", meta(), new Uint8Array(10));
    expect(again.written).toBe(false);
    expect(again.uri).toBe(`file:///cache/${cachePath("c1", sha("a"), "png")}`);
    expect(disk.held.get(cachePath("c1", sha("a"), "png"))?.usedAt).toBe(before ?? -1);
  });

  test("another computer's files are never counted, nor evicted", () => {
    const disk = files();
    let now = 1;
    const cache = createArtifactCache({ files: disk.port, now: () => now++, cap: MB });
    cache.put("c1", meta({ sha256: sha("x"), size: MB }), new Uint8Array(MB));
    cache.put("c2", meta({ sha256: sha("y"), size: MB }), new Uint8Array(MB));
    expect(disk.held.has(cachePath("c1", sha("x"), "png"))).toBe(true);
    expect(disk.held.has(cachePath("c2", sha("y"), "png"))).toBe(true);
  });
});

describe("the kept file carries its TYPE's extension", () => {
  test("a PDF is written as `<sha>.pdf`, so WKWebView renders it (mutation: bare hash → red)", () => {
    // WKWebView picks a PDF's renderer from the file's extension: a `file:` uri
    // named only by its hash is a PDF that may render blank (finding 2).
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    const pdf = meta({ kind: "pdf", mimeType: "application/pdf", title: "report" });
    const put = cache.put("c1", pdf, new Uint8Array(4));
    expect(put.uri).toBe(`file:///cache/${cachePath("c1", sha("a"), "pdf")}`);
    expect(put.uri?.endsWith(".pdf")).toBe(true);
    // The viewer that loads it by uri is the PDF one, on THIS file.
    expect(pdfViewerProps(put.uri ?? "").uri).toBe(put.uri ?? "");
  });

  test("cachePath takes the extension without changing the identity (the hash)", () => {
    expect(cachePath("c1", sha("a"))).toBe(`artifacts/c1/${sha("a")}`);
    expect(cachePath("c1", sha("a"), "pdf")).toBe(`artifacts/c1/${sha("a")}.pdf`);
  });
});

describe("the state is read back from the disk", () => {
  test("files an earlier run wrote are counted (mutation: keep an in-memory state → red)", () => {
    const disk = files();
    disk.port.write(cachePath("c1", sha("old"), "png"), new Uint8Array(MB));
    disk.port.write(cachePath("c1", sha("older"), "png"), new Uint8Array(MB));
    const cache = createArtifactCache({ files: disk.port, now: () => 99, cap: 2 * MB });
    // The cap is full of bytes this process never wrote: the arrival evicts.
    const put = cache.put("c1", meta({ sha256: sha("new"), size: MB }), new Uint8Array(MB));
    expect(put.written).toBe(true);
    expect(disk.held.size).toBe(2);
    expect(disk.held.has(cachePath("c1", sha("new"), "png"))).toBe(true);
  });

  test("a path that is not a sha is not a cached version (never evicted as one)", () => {
    const disk = files();
    disk.port.write(`${cacheDir("c1")}/share-report.zip`, new Uint8Array(MB));
    const cache = createArtifactCache({ files: disk.port, now: () => 1, cap: 2 * MB });
    const put = cache.put("c1", meta({ sha256: sha("new"), size: 2 * MB }), new Uint8Array(2 * MB));
    // The share copy is not ours to plan over: it neither makes room nor goes.
    expect(put.written).toBe(true);
    expect(disk.held.has(`${cacheDir("c1")}/share-report.zip`)).toBe(true);
  });

  test("the default cap is the owner's 200 MB", () => {
    expect(ARTIFACT_CACHE_BYTES).toBe(200 * MB);
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    expect(cache.cap).toBe(ARTIFACT_CACHE_BYTES);
  });
});

describe("uriOf: the kept copy, for a preview made offline", () => {
  test("a cached version answers its uri; one never kept (or evicted) answers null", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    expect(cache.uriOf("c1", meta())).toBeNull();
    const put = cache.put("c1", meta(), new Uint8Array(10));
    expect(cache.uriOf("c1", meta())).toBe(put.uri);
    // Another computer's cache is another directory.
    expect(cache.uriOf("c2", meta())).toBeNull();
    disk.port.remove(cachePath("c1", sha("a"), "png"));
    expect(cache.uriOf("c1", meta())).toBeNull();
  });
});

describe("shareCopy: a named copy for the share sheet", () => {
  test("the copy is `<sanitized title>.<ext>`, beside (never instead of) the cached file", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    cache.put(
      "c1",
      meta({ title: "Q3 dashboard", kind: "other", mimeType: "application/zip" }),
      new Uint8Array(4),
    );
    const copy = cache.shareCopy(
      "c1",
      meta({ title: "Q3 dashboard", kind: "other", mimeType: "application/zip" }),
    );
    expect(copy).not.toBeNull();
    expect(copy?.name).toBe("Q3 dashboard.zip");
    // The content-addressed file the viewers load is still there (and it is the
    // zip's, so its extension is the zip's too).
    expect(disk.held.has(cachePath("c1", sha("a"), "zip"))).toBe(true);
    expect(copy?.uri).toContain("/Q3 dashboard.zip");
    // A share copy is NOT a cached version (it never enters the LRU).
    expect(disk.held.has(`${cacheDir("c1")}/Q3 dashboard.zip`)).toBe(true);
  });

  test("a file that is not cached has no copy to share (never a dangling uri)", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    expect(cache.shareCopy("c1", meta())).toBeNull();
  });

  test("the extension comes from the type: PDF, PNG, ZIP, and a safe fallback", () => {
    expect(artifactFileExt(meta({ kind: "pdf", mimeType: "application/pdf" }))).toBe("pdf");
    expect(artifactFileExt(meta({ kind: "image", mimeType: "image/jpeg" }))).toBe("jpg");
    expect(artifactFileExt(meta({ kind: "other", mimeType: "application/gzip" }))).toBe("gz");
    expect(artifactFileExt(meta({ kind: "html", mimeType: "text/html" }))).toBe("html");
    expect(artifactFileExt(meta({ kind: "other", mimeType: "application/octet-stream" }))).toBe(
      "bin",
    );
  });

  test("the name keeps the title's own real extension when it has one", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    const m = meta({ title: "report.pdf", kind: "pdf", mimeType: "application/pdf" });
    cache.put("c1", m, new Uint8Array(4));
    expect(cache.shareCopy("c1", m)?.name).toBe("report.pdf");
  });
});

describe("the cache is dropped with the pairing and the session", () => {
  test("forgetComputer removes this computer's directory and nothing else", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    cache.put("c1", meta(), new Uint8Array(4));
    cache.put("c2", meta(), new Uint8Array(4));
    cache.forgetComputer("c1");
    expect(disk.held.has(cachePath("c1", sha("a"), "png"))).toBe(false);
    expect(disk.held.has(cachePath("c2", sha("a"), "png"))).toBe(true);
  });

  test("forgetting a computer with nothing cached is not an error", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => disk.tick() });
    expect(() => cache.forgetComputer("c9")).not.toThrow();
  });
});

describe("the empty state", () => {
  test("a fresh directory plans exactly like `EMPTY_CACHE`", () => {
    const disk = files();
    const cache = createArtifactCache({ files: disk.port, now: () => 1 });
    expect(cache.state("c1")).toEqual(EMPTY_CACHE);
    expect(cache.state("c1").entries).toEqual([]);
  });
});
