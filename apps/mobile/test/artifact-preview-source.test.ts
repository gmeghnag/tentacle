import { describe, expect, test } from "bun:test";
import { type ArtifactMeta, DomainErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  type PreviewSourceDeps,
  createArtifactPreviewSource,
  isGoneError,
  parseStoredPreview,
  previewKey,
} from "../src/artifact-preview-source.ts";
import { PREVIEW_TEXT_BYTES } from "../src/artifact-preview.ts";
import type { ArtifactPreview } from "../src/thumbnails.ts";
import { artifactPreviewRef } from "../src/thumbnails.ts";

const SHA = "d".repeat(64);

function meta(over: Partial<ArtifactMeta>): ArtifactMeta {
  return {
    artifactId: "a1",
    version: 1,
    sha256: SHA,
    size: 214_000,
    mimeType: "application/pdf",
    kind: "pdf",
    title: "Report",
    callId: "call-1",
    createdAt: 0,
    ...over,
  };
}

/** A world of fakes: what was read, kept, saved and asked of QuickLook. */
function world(over: Partial<PreviewSourceDeps> = {}) {
  const log: string[] = [];
  const saved = new Map<string, ArtifactPreview>();
  const deps: PreviewSourceDeps = {
    read: async (m) => {
      log.push(`read ${m.kind}`);
      return new Uint8Array([1, 2, 3]);
    },
    cached: () => null,
    put: (m) => {
      log.push(`put ${m.kind}`);
      return `file:///cache/${m.sha256}`;
    },
    store: {
      load: (m, key) => saved.get(`${m.sha256}/${key}`) ?? null,
      save: (m, key, preview) => {
        log.push(`save ${preview.kind}`);
        saved.set(`${m.sha256}/${key}`, preview);
      },
      imageUri: (m, key) => `file:///previews/${m.sha256}-${key}.jpg`,
    },
    native: {
      thumbnail: async (fileUri, outUri, w, h) => {
        log.push(`ql ${fileUri} -> ${outUri} ${w}x${h}`);
        return { width: 1074, height: 1519 };
      },
      pdfPageCount: () => 7,
    },
    readText: (uri, max) => {
      log.push(`text ${uri} ${max}`);
      return "# Plan";
    },
    width: 358,
    ...over,
  };
  return { deps, log, saved, source: createArtifactPreviewSource(deps) };
}

const signal = new AbortController().signal;

describe("createArtifactPreviewSource — one card's preview, made on the phone", () => {
  test("a PDF: read → cache → QuickLook at W × 1.5W → page count → kept", async () => {
    const { source, log } = world();
    const thumb = await source.fetch(artifactPreviewRef(meta({})), signal);
    expect(thumb).toEqual({
      id: SHA,
      uri: `file:///previews/${SHA}-w358.jpg`,
      preview: {
        kind: "picture",
        uri: `file:///previews/${SHA}-w358.jpg`,
        width: 1074,
        height: 1519,
        pages: 7,
      },
    });
    expect(log).toEqual([
      "read pdf",
      "put pdf",
      `ql file:///cache/${SHA} -> file:///previews/${SHA}-w358.jpg 358x537`,
      "save picture",
    ]);
  });

  test("a preview made before is shown with NO read (offline)", async () => {
    let online = true;
    const { source, log } = world({
      read: async () => {
        if (!online) {
          throw new Error("offline");
        }
        log.push("read");
        return new Uint8Array([1]);
      },
    });
    const first = await source.fetch(artifactPreviewRef(meta({})), signal);
    online = false;
    log.length = 0;
    // Same card again, the link down: the kept preview answers, nothing is dialled.
    expect(await source.fetch(artifactPreviewRef(meta({})), signal)).toEqual(first);
    expect(log).toEqual([]);
  });

  test("a cached version is not read again", async () => {
    const { source, log } = world({ cached: () => "file:///cache/kept" });
    await source.fetch(artifactPreviewRef(meta({ kind: "html", mimeType: "text/html" })), signal);
    expect(log[0]).toBe(`ql file:///cache/kept -> file:///previews/${SHA}-w358.jpg 358x537`);
    // HTML has no pages.
    expect(log).not.toContain("read html");
  });

  test("an image IS its cached file (no QuickLook, nothing else kept)", async () => {
    const { source, log } = world();
    const thumb = await source.fetch(
      artifactPreviewRef(meta({ kind: "image", mimeType: "image/png", width: 4, height: 3 })),
      signal,
    );
    expect(thumb).toEqual({
      id: SHA,
      uri: `file:///cache/${SHA}`,
      preview: { kind: "picture", uri: `file:///cache/${SHA}`, width: 4, height: 3 },
    });
    expect(log).toEqual(["read image", "put image"]);
  });

  test("markdown keeps its first bytes (bounded), drawn by the app", async () => {
    const { source, log } = world();
    const thumb = await source.fetch(
      artifactPreviewRef(meta({ kind: "markdown", mimeType: "text/markdown" })),
      signal,
    );
    expect(thumb).toEqual({ id: SHA, uri: "", preview: { kind: "lines", text: "# Plan" } });
    expect(log).toContain(`text file:///cache/${SHA} ${PREVIEW_TEXT_BYTES}`);
    expect(log).toContain("save lines");
  });

  test("the daemon says the bytes are gone → `gone`; its disk failed → a plain failure", async () => {
    const goneErr = new RpcError(DomainErrorCode.ArtifactUnavailable, "x", { reason: "evicted" });
    const diskErr = new RpcError(DomainErrorCode.ArtifactUnavailable, "x", {
      reason: "store_failed",
    });
    const ref = artifactPreviewRef(meta({}));
    expect(
      await world({
        read: async () => {
          throw goneErr;
        },
      }).source.fetch(ref, signal),
    ).toBe("gone");
    expect(
      await world({
        read: async () => {
          throw diskErr;
        },
      }).source.fetch(ref, signal),
    ).toBeNull();
  });

  test("QuickLook refuses (an icon only, a broken file) → null, nothing kept", async () => {
    const { source, saved } = world({
      native: {
        thumbnail: async () => {
          throw new Error("E_PREVIEW_NONE");
        },
        pdfPageCount: () => null,
      },
    });
    expect(await source.fetch(artifactPreviewRef(meta({})), signal)).toBeNull();
    expect(saved.size).toBe(0);
  });

  test("no native module → a page keeps its symbol (null), lines still work", async () => {
    const { source } = world({ native: null });
    expect(await source.fetch(artifactPreviewRef(meta({})), signal)).toBeNull();
    const md = artifactPreviewRef(meta({ kind: "markdown", mimeType: "text/markdown" }));
    expect(await source.fetch(md, signal)).not.toBeNull();
  });

  test("too big for the cache → null; abandoned mid-read → null", async () => {
    expect(
      await world({ put: () => null }).source.fetch(artifactPreviewRef(meta({})), signal),
    ).toBeNull();
    const controller = new AbortController();
    const { source } = world({
      read: async () => {
        controller.abort();
        return new Uint8Array([1]);
      },
    });
    expect(await source.fetch(artifactPreviewRef(meta({})), controller.signal)).toBeNull();
  });

  test("a ref without its meta, or whose id is not the meta's sha, is refused (no read)", async () => {
    const { source, log } = world();
    expect(
      await source.fetch({ id: SHA, mimeType: "application/pdf", size: 1 }, signal),
    ).toBeNull();
    expect(
      await source.fetch({ ...artifactPreviewRef(meta({})), id: "e".repeat(64) }, signal),
    ).toBeNull();
    expect(log).toEqual([]);
  });
});

describe("helpers", () => {
  test("isGoneError: only ArtifactUnavailable with unknown / evicted", () => {
    const code = DomainErrorCode.ArtifactUnavailable;
    expect(isGoneError(new RpcError(code, "x", { reason: "unknown" }))).toBe(true);
    expect(isGoneError(new RpcError(code, "x", { reason: "evicted" }))).toBe(true);
    expect(isGoneError(new RpcError(code, "x"))).toBe(false);
    expect(isGoneError(new RpcError(-32000, "x", { reason: "evicted" }))).toBe(false);
    expect(isGoneError(new Error("x"))).toBe(false);
    expect(isGoneError(null)).toBe(false);
  });

  test("parseStoredPreview keeps only the shapes this build writes", () => {
    expect(parseStoredPreview('{"kind":"lines","text":"a"}')).toEqual({ kind: "lines", text: "a" });
    expect(
      parseStoredPreview('{"kind":"picture","uri":"file:///p.jpg","width":2,"height":3,"pages":1}'),
    ).toEqual({ kind: "picture", uri: "file:///p.jpg", width: 2, height: 3, pages: 1 });
    expect(parseStoredPreview('{"kind":"picture","uri":"https://x/p.jpg"}')).toBeNull();
    expect(parseStoredPreview('{"kind":"picture","uri":"file:///p","pages":1.5}')).toEqual({
      kind: "picture",
      uri: "file:///p",
    });
    expect(parseStoredPreview("not json")).toBeNull();
    expect(parseStoredPreview('"x"')).toBeNull();
  });

  test("previewKey is the rounded band width", () => {
    expect(previewKey(358.4)).toBe("w358");
  });
});
