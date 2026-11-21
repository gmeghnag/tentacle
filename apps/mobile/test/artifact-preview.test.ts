import { describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  BAND_HEIGHT,
  IMAGE_BAND_MAX,
  IMAGE_BAND_MIN,
  PREVIEW_LINES,
  PREVIEW_MAX_BYTES,
  bandHeight,
  previewCardView,
  previewLines,
  previewSource,
  previewStatus,
  previewSymbol,
  wantsPreview,
} from "../src/artifact-preview.ts";
import { kindSymbol } from "../src/gallery-layout.ts";
import { aborted, failed, gone, initialThumbnails, loaded } from "../src/thumbnails.ts";

const SHA = "c".repeat(64);
const W = 358;

function meta(over: Partial<ArtifactMeta>): ArtifactMeta {
  return {
    artifactId: "a1",
    version: 1,
    sha256: SHA,
    size: 214_000,
    mimeType: "application/pdf",
    kind: "pdf",
    title: "Q3 Infrastructure Report",
    callId: "call-1",
    createdAt: 0,
    ...over,
  };
}

const PDF = meta({});
const PNG = meta({ kind: "image", mimeType: "image/png", width: 1280, height: 720, size: 240_000 });
const MD = meta({
  kind: "markdown",
  mimeType: "text/markdown",
  size: 3000,
  title: "Migration plan",
});
const HTML = meta({ kind: "html", mimeType: "text/html", size: 14_000, title: "Deploy dashboard" });
const ZIP = meta({ kind: "other", mimeType: "application/zip", size: 5000, title: "logs" });

describe("which preview a card gets", () => {
  test("image → its pixels; pdf/html/svg → a QuickLook page; markdown/text → lines; else none", () => {
    expect(previewSource(PNG)).toBe("image");
    expect(previewSource(PDF)).toBe("page");
    expect(previewSource(HTML)).toBe("page");
    expect(previewSource(meta({ kind: "svg", mimeType: "image/svg+xml" }))).toBe("page");
    expect(previewSource(MD)).toBe("lines");
    expect(previewSource(meta({ kind: "text", mimeType: "text/plain" }))).toBe("lines");
    expect(previewSource(ZIP)).toBe("none");
    expect(previewSource(meta({ kind: "chart", mimeType: "application/json" }))).toBe("none");
    // An unknown wire kind narrows to `other`: never previewed.
    expect(previewSource(meta({ kind: "hologram" as ArtifactMeta["kind"] }))).toBe("none");
  });

  test("bytes are fetched only for a previewable kind at or under the cap", () => {
    expect(wantsPreview(meta({ size: PREVIEW_MAX_BYTES }))).toBe(true);
    expect(wantsPreview(meta({ size: PREVIEW_MAX_BYTES + 1 }))).toBe(false);
    expect(wantsPreview(ZIP)).toBe(false);
  });

  test("one symbol per kind — the gallery's, so a file looks the same in both", () => {
    const kinds = ["pdf", "image", "markdown", "text", "html", "svg", "chart", "other"] as const;
    for (const kind of kinds) {
      expect(previewSymbol(kind)).toBe(kindSymbol(kind));
    }
    // Distinct per kind: the shape is the cue (the kind is also written).
    expect(new Set(kinds.map(previewSymbol)).size).toBe(kinds.length);
  });
});

describe("the band's height is known BEFORE the bytes (no jump)", () => {
  test("a page or lines band is the fixed height", () => {
    expect(bandHeight(PDF, W)).toBe(BAND_HEIGHT);
    expect(bandHeight(MD, W)).toBe(BAND_HEIGHT);
  });

  test("an image follows its meta's proportions, clamped", () => {
    expect(bandHeight(PNG, W)).toBe(Math.round((W * 720) / 1280)); // 201
    expect(bandHeight(meta({ kind: "image", width: 100, height: 1000 }), W)).toBe(IMAGE_BAND_MAX);
    expect(bandHeight(meta({ kind: "image", width: 1000, height: 100 }), W)).toBe(IMAGE_BAND_MIN);
    // No dimensions in the meta: the fixed height (cover, centred).
    expect(bandHeight(meta({ kind: "image", mimeType: "image/png" }), W)).toBe(BAND_HEIGHT);
  });
});

describe("previewStatus — the driver's state for one card", () => {
  test("nothing yet → loading; in flight → loading; loaded → ready", () => {
    expect(previewStatus(initialThumbnails, PDF).kind).toBe("loading");
    const flying = { ...initialThumbnails, inFlight: [SHA] };
    expect(previewStatus(flying, PDF).kind).toBe("loading");
    const ready = loaded(flying, {
      id: SHA,
      uri: "file:///p.jpg",
      preview: { kind: "picture", uri: "file:///p.jpg", width: 1074, height: 1611, pages: 7 },
    });
    expect(previewStatus(ready, PDF)).toEqual({
      kind: "ready",
      preview: { kind: "picture", uri: "file:///p.jpg", width: 1074, height: 1611, pages: 7 },
    });
  });

  test("an image thumb with no preview (the sent-photo source) is its own picture", () => {
    const state = loaded(initialThumbnails, { id: SHA, uri: "file:///img.png" });
    expect(previewStatus(state, PNG)).toEqual({
      kind: "ready",
      preview: { kind: "picture", uri: "file:///img.png", width: 1280, height: 720 },
    });
  });

  test("failed → failed (the symbol stays); the daemon said gone → gone", () => {
    expect(previewStatus(failed(initialThumbnails, SHA), PDF).kind).toBe("failed");
    expect(previewStatus(gone(initialThumbnails, SHA), PDF).kind).toBe("gone");
  });

  test("an abandoned request is NOT a failure: it is loading again", () => {
    const back = aborted({ ...initialThumbnails, inFlight: [SHA] }, SHA);
    expect(previewStatus(back, PDF).kind).toBe("loading");
  });

  test("too big to fetch: decided up front, the symbol (never a forever-loading band)", () => {
    expect(previewStatus(initialThumbnails, meta({ size: PREVIEW_MAX_BYTES + 1 })).kind).toBe(
      "failed",
    );
  });
});

describe("previewCardView — what the row draws", () => {
  test("loading: a band of the final height, the kind's symbol dimmed, no pages yet", () => {
    const view = previewCardView(PDF, { kind: "loading" }, W);
    expect(view.band).toEqual({ height: BAND_HEIGHT, fill: { kind: "loading" } });
    expect(view.symbol).toBe(kindSymbol("pdf"));
    expect(view.card.line2).toBe("PDF · 214 KB");
    expect(view.trailing).toBe("chevron");
    expect(view.disabled).toBe(false);
    expect(view.dim).toBe(false);
  });

  test("ready PDF: the page top-aligned, and its page count in line 2", () => {
    const view = previewCardView(
      PDF,
      {
        kind: "ready",
        preview: { kind: "picture", uri: "file:///p.jpg", width: 1074, height: 1611, pages: 7 },
      },
      W,
    );
    expect(view.band).toEqual({
      height: BAND_HEIGHT,
      fill: { kind: "picture", uri: "file:///p.jpg", align: "top", drawnHeight: 537 },
    });
    expect(view.card.line2).toBe("PDF · 7 pages · 214 KB");
    expect(view.a11yLabel).toBe("Q3 Infrastructure Report, PDF · 7 pages · 214 KB");
  });

  test("ready image: cover, centred, at its meta height", () => {
    const view = previewCardView(
      PNG,
      {
        kind: "ready",
        preview: { kind: "picture", uri: "file:///i.png", width: 1280, height: 720 },
      },
      W,
    );
    expect(view.band?.height).toBe(201);
    expect(view.band?.fill).toEqual({ kind: "picture", uri: "file:///i.png", align: "cover" });
    expect(view.symbol).toBe(kindSymbol("image"));
  });

  test("ready markdown: its lines; plain text: mono lines", () => {
    const view = previewCardView(
      MD,
      { kind: "ready", preview: { kind: "lines", text: "# Migration plan\n\nMove logs." } },
      W,
    );
    expect(view.band?.fill).toEqual({
      kind: "lines",
      lines: [
        { style: "heading", text: "Migration plan" },
        { style: "body", text: "Move logs." },
      ],
    });
  });

  test("failed: the band STAYS, with the symbol at full strength — never a collapse", () => {
    const view = previewCardView(HTML, { kind: "failed" }, W);
    expect(view.band).toEqual({ height: BAND_HEIGHT, fill: { kind: "symbol" } });
    expect(view.trailing).toBe("chevron");
    expect(view.disabled).toBe(false);
  });

  test("gone: no band, dimmed, no chevron, not tappable — the WORDS say why", () => {
    const view = previewCardView(PDF, { kind: "gone" }, W);
    expect(view.band).toBeNull();
    expect(view.dim).toBe(true);
    expect(view.trailing).toBeNull();
    expect(view.disabled).toBe(true);
    expect(view.card.line2).toBe("PDF · 214 KB · no longer available");
    expect(view.card.action).toBe("none");
  });

  test("a kind with no preview (zip): no band, Share instead of the chevron", () => {
    const view = previewCardView(ZIP, { kind: "failed" }, W);
    expect(view.band).toBeNull();
    expect(view.trailing).toBe("share");
    expect(view.symbol).toBe(kindSymbol("other"));
  });

  test("the pod mark still reaches line 2", () => {
    const view = previewCardView(HTML, { kind: "loading" }, W, { origin: "pod" });
    expect(view.card.line2).toBe("HTML page · 14 KB · from the pod");
  });
});

describe("previewLines — the first lines the app draws itself", () => {
  test("markdown: headings, paragraphs, bullets, code as mono; inline marks dropped", () => {
    const lines = previewLines(
      "markdown",
      "# Plan\n\nMove **logs** to `v3`.\n\n## Steps\n\n- Freeze\n- [Rewrite](x)\n\n```\nbun test\n```",
    );
    expect(lines).toEqual([
      { style: "heading", text: "Plan" },
      { style: "body", text: "Move logs to v3." },
      { style: "heading", text: "Steps" },
      { style: "bullet", text: "Freeze" },
      { style: "bullet", text: "Rewrite" },
      { style: "mono", text: "bun test" },
    ]);
  });

  test(`at most ${PREVIEW_LINES} lines; blank lines are not lines`, () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n\n");
    expect(previewLines("text", text)).toHaveLength(PREVIEW_LINES);
    expect(previewLines("text", "a\n\n\nb")).toEqual([
      { style: "mono", text: "a" },
      { style: "mono", text: "b" },
    ]);
  });

  test("an empty file still says something (never an empty box)", () => {
    expect(previewLines("markdown", "")).toEqual([{ style: "body", text: "(empty)" }]);
    expect(previewLines("text", "  \n ")).toEqual([{ style: "body", text: "(empty)" }]);
  });
});
