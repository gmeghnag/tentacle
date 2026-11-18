import { describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
import { artifactCard, formatArtifactSize } from "../src/artifact-card.ts";

const SHA = "a".repeat(64);

function meta(over: Partial<ArtifactMeta>): ArtifactMeta {
  return {
    artifactId: "a1",
    version: 1,
    sha256: SHA,
    size: 1000,
    mimeType: "text/plain",
    kind: "text",
    title: "notes",
    callId: "call-1",
    createdAt: 0,
    ...over,
  };
}

describe("formatArtifactSize — decimal units, like the phone's Files app", () => {
  test("B, KB (whole), MB (one decimal)", () => {
    expect(formatArtifactSize(512)).toBe("512 B");
    expect(formatArtifactSize(14_000)).toBe("14 KB");
    expect(formatArtifactSize(240_400)).toBe("240 KB");
    expect(formatArtifactSize(999_999)).toBe("1.0 MB");
    expect(formatArtifactSize(2_100_000)).toBe("2.1 MB");
  });
});

describe("artifactCard — the one view-model both frontends render (D7)", () => {
  test("line2 per kind, as the mockups show", () => {
    const png = artifactCard(
      meta({ kind: "image", mimeType: "image/png", size: 240_000, width: 1280, height: 720 }),
    );
    expect(png.line2).toBe("PNG · 1280×720 · 240 KB");
    expect(png.kind).toBe("image");
    expect(png.action).toBe("open");
    expect(artifactCard(meta({ kind: "html", mimeType: "text/html", size: 14_000 })).line2).toBe(
      "HTML page · 14 KB",
    );
    expect(
      artifactCard(meta({ kind: "pdf", mimeType: "application/pdf", size: 2_100_000 })).line2,
    ).toBe("PDF · 2.1 MB");
    expect(
      artifactCard(meta({ kind: "other", mimeType: "application/zip", size: 3_400_000 })).line2,
    ).toBe("ZIP · 3.4 MB");
    expect(artifactCard(meta({ kind: "svg", mimeType: "image/svg+xml" })).line2).toBe("SVG · 1 KB");
    expect(artifactCard(meta({ kind: "markdown", mimeType: "text/markdown" })).line2).toBe(
      "Markdown · 1 KB",
    );
  });

  test("other: never 'open'; its label falls back to the source extension, then 'File'", () => {
    const other = artifactCard(
      meta({ kind: "other", mimeType: "application/octet-stream", source: "dist/app.tar.xz" }),
    );
    expect(other.action).toBe("save");
    expect(other.line2).toBe("XZ · 1 KB");
    expect(artifactCard(meta({ kind: "other", mimeType: "application/octet-stream" })).line2).toBe(
      "File · 1 KB",
    );
    // A weird extension is not echoed (display hygiene): too long / not alphanumeric.
    expect(
      artifactCard(
        meta({ kind: "other", mimeType: "application/octet-stream", source: "x.verylongext" }),
      ).line2,
    ).toBe("File · 1 KB");
  });

  test("an unknown kind from a newer daemon is 'other' (never opened)", () => {
    const card = artifactCard(meta({ kind: "hologram", mimeType: "model/x-holo" }));
    expect(card.kind).toBe("other");
    expect(card.action).toBe("save");
  });

  test("version suffix, pod mark, unavailable", () => {
    expect(artifactCard(meta({ version: 2 })).line2).toBe("Text · 1 KB · v2");
    expect(artifactCard(meta({}), { origin: "pod" }).line2).toBe("Text · 1 KB · from the pod");
    const gone = artifactCard(meta({ version: 3 }), { state: "unavailable" });
    expect(gone.line2).toBe("Text · 1 KB · v3 · no longer available");
    expect(gone.action).toBe("none");
    expect(gone.state).toBe("unavailable");
  });

  test("title passes through; glyph is one per kind", () => {
    const card = artifactCard(meta({ title: "Q3 report" }));
    expect(card.title).toBe("Q3 report");
    const glyphs = new Set(
      ["image", "svg", "html", "pdf", "markdown", "text", "chart", "other"].map(
        (kind) => artifactCard(meta({ kind })).glyph,
      ),
    );
    expect(glyphs.size).toBeGreaterThan(1);
    for (const g of glyphs) {
      expect([...g].length).toBe(1);
    }
  });

  test("a chart card: its own glyph, `Chart · N KB`, and it OPENS (T8.1/C8)", () => {
    const chart = artifactCard(
      meta({ kind: "chart", mimeType: "application/vnd.tentacle.chart+json", size: 12_000 }),
    );
    expect(chart.kind).toBe("chart");
    expect(chart.line2).toBe("Chart · 12 KB");
    // `open`, never `save`: a spec is a viewer's input (the full-screen chart).
    expect(chart.action).toBe("open");
    expect(chart.glyph).toBe("◱");
    // Glyphs must stay TEXT: an Emoji-property glyph renders two cells wide on
    // some terminals and breaks the line grid (AGENTS §6's Ink gotcha family).
    expect(/\p{Emoji}/u.test(chart.glyph)).toBe(false);
    // One glyph per kind, so a chart is never mistaken for a `text` artifact.
    expect(chart.glyph).not.toBe(artifactCard(meta({ kind: "text" })).glyph);
    expect(chart.glyph).not.toBe(artifactCard(meta({ kind: "markdown" })).glyph);
  });
});
