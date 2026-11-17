/**
 * What a card's tap does (docs/feat/model-artifacts.md D9, T7.3): a viewer, Share,
 * or an honest "no longer available" — and the bytes' own two pure steps (their
 * text decode and their cache plan).
 *
 * The rule under test is that `save` NEVER reaches a viewer: a `.zip` or an
 * unknown extension is shared, never handed to something that might run it.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactCardView } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import { EMPTY_CACHE } from "../src/artifact-cache.ts";
import { cacheStep, openTarget, tooBigNote, viewerText } from "../src/artifact-open.ts";

const MB = 1024 * 1024;

function card(over: Partial<ArtifactCardView> = {}): ArtifactCardView {
  return {
    kind: "image",
    glyph: "▣",
    title: "chart.png",
    line2: "PNG · 240 KB",
    action: "open",
    state: "ready",
    ...over,
  };
}

function meta(over: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    artifactId: "a",
    version: 1,
    sha256: "a".repeat(64),
    size: 1000,
    mimeType: "image/png",
    kind: "image",
    title: "chart.png",
    callId: "c1",
    createdAt: 0,
    ...over,
  };
}

describe("openTarget", () => {
  test("an openable card opens the viewer its own kind names", () => {
    expect(openTarget(card())).toEqual({ kind: "viewer", viewer: "image" });
    expect(openTarget(card({ kind: "html" }))).toEqual({ kind: "viewer", viewer: "webview" });
    expect(openTarget(card({ kind: "pdf" }))).toEqual({ kind: "viewer", viewer: "pdf" });
    expect(openTarget(card({ kind: "markdown" }))).toEqual({ kind: "viewer", viewer: "markdown" });
  });

  test("`save` is Shared, NEVER opened (a .zip would be executed)", () => {
    expect(openTarget(card({ kind: "other", action: "save" }))).toEqual({ kind: "share" });
  });

  test("an unreadable card says so, in the card's own words", () => {
    const target = openTarget(card({ action: "none", state: "unavailable" }));
    expect(target.kind).toBe("unavailable");
    expect(target.kind === "unavailable" ? target.note : "").toBe("no longer available");
  });
});

describe("viewerText", () => {
  test("decodes the text kinds (a pod page's emoji survives)", () => {
    const bytes = new TextEncoder().encode("<h1>hi ✦</h1>");
    expect(viewerText("webview", bytes)).toBe("<h1>hi ✦</h1>");
    expect(viewerText("markdown", new TextEncoder().encode("# t"))).toBe("# t");
    expect(viewerText("text", new TextEncoder().encode("plain"))).toBe("plain");
  });

  test("an image, a PDF or no viewer reads the FILE, never text", () => {
    expect(viewerText("image", new Uint8Array([1, 2]))).toBeNull();
    expect(viewerText("pdf", new Uint8Array([1, 2]))).toBeNull();
    expect(viewerText("none", new Uint8Array([1, 2]))).toBeNull();
  });
});

describe("cacheStep", () => {
  test("a file that fits is written and needs no note", () => {
    const step = cacheStep(EMPTY_CACHE, meta(), null, 1);
    expect(step.wontFit).toBe(false);
    expect(step.note).toBeNull();
    expect(step.state.entries).toHaveLength(1);
  });

  test("the file a viewer HOLDS is never evicted to make room", () => {
    const held = { entries: [{ sha256: "b".repeat(64), size: 3 * MB, usedAt: 1 }] };
    const step = cacheStep(held, meta({ sha256: "c".repeat(64), size: 2 * MB }), "b".repeat(64), 2, 4 * MB);
    expect(step.evict).toEqual([]);
    expect(step.note).toBe(tooBigNote(meta({ sha256: "c".repeat(64), size: 2 * MB })));
  });

  test("a file too big for the whole cache says why, in MB", () => {
    const big = meta({ size: 21 * MB });
    const step = cacheStep(EMPTY_CACHE, big, null, 1, 20 * MB);
    expect(step.wontFit).toBe(true);
    expect(step.note).toBe("Too big to keep on this phone (21 MB)");
    // Nothing is taken: the state holds only what was already there.
    expect(step.state.entries).toEqual([]);
  });
});
