/**
 * T8.1's pure half (docs/feat/model-charts.md, slice C8): the gallery's chart
 * thumbnail — WHICH artifacts get one, and the layout it is drawn from.
 *
 * Both are decisions, not rendering (AGENTS §7): the size cap and the kind test
 * say whether a tile may spend a fetch on the bytes at all, and the layout is
 * computed from those bytes through the SAME `chartRowView` the transcript uses,
 * so a forged or newer-than-this-build spec draws nothing rather than a
 * half-chart. `ui/chart/ChartThumbnail.tsx` only maps `paths`/`dots` to elements.
 */
import { describe, expect, test } from "bun:test";
import { CHART_CAPS, canonicalChartJson } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import { chartThumbView, wantsChartThumbnail } from "../src/chart-row.ts";
import { lightPalette } from "../src/theme.ts";
import { REVENUE } from "./chart-fixtures.ts";

const SHA = "a".repeat(64);

function meta(over: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    artifactId: "revenue",
    version: 1,
    sha256: SHA,
    size: 900,
    mimeType: "application/vnd.tentacle.chart+json",
    kind: "chart",
    title: "Ricavi",
    callId: "c1",
    createdAt: 0,
    ...over,
  };
}

const BYTES = new TextEncoder().encode(canonicalChartJson(REVENUE));

const TILE = { width: 44, height: 32, fontScale: 1, locale: "it", palette: lightPalette } as const;

describe("wantsChartThumbnail — may the tile spend a fetch on these bytes?", () => {
  test("a chart artifact within the spec cap: yes", () => {
    expect(wantsChartThumbnail(meta())).toBe(true);
    expect(wantsChartThumbnail(meta({ size: CHART_CAPS.bytes }))).toBe(true);
  });

  test("over the cap: no — the spec could not validate anyway (the cap is its own)", () => {
    expect(wantsChartThumbnail(meta({ size: CHART_CAPS.bytes + 1 }))).toBe(false);
  });

  test("every other kind: no (an image tile is its own path, a text one has none)", () => {
    for (const kind of ["image", "svg", "html", "pdf", "markdown", "text", "other"]) {
      expect({ kind, wants: wantsChartThumbnail(meta({ kind })) }).toEqual({ kind, wants: false });
    }
  });

  test("an UNKNOWN wire kind is `other` — a newer daemon's kind is never guessed at", () => {
    expect(wantsChartThumbnail(meta({ kind: "hologram" }))).toBe(false);
  });
});

describe("chartThumbView — the tile's layout, re-validated from the artifact's bytes", () => {
  test("it lays out the canonical spec at the tile's size", () => {
    const view = chartThumbView(meta(), BYTES, TILE);
    expect(view).not.toBeNull();
    expect(view?.title).toBe("Ricavi");
    expect(view?.layout.paths.length).toBeGreaterThan(0);
    // A tile draws the PLOT, never the chrome: no text, so no caption can
    // overflow a 44 pt tile (the title is the row's own line, above it).
    expect(view?.layout.texts.length).toBeGreaterThan(0);
    expect(view?.layout.width).toBe(TILE.width);
    expect(view?.layout.height).toBe(TILE.height);
  });

  test("a spec that does not re-validate (a pod's forgery) lays out NOTHING", () => {
    const forged = new TextEncoder().encode(
      JSON.stringify({ ...REVENUE, datasets: [{ label: "x", data: ["12.5"] }] }),
    );
    expect(chartThumbView(meta(), forged, TILE)).toBeNull();
    expect(chartThumbView(meta(), new TextEncoder().encode("{not json"), TILE)).toBeNull();
    expect(chartThumbView(meta(), new Uint8Array(), TILE)).toBeNull();
  });

  test("an artifact whose KIND is not `chart` is never drawn as one", () => {
    expect(chartThumbView(meta({ kind: "text" }), BYTES, TILE)).toBeNull();
  });

  test("bytes that decode to invalid UTF-8 in the middle still fail CLOSED", () => {
    expect(chartThumbView(meta(), new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), TILE)).toBeNull();
  });
});
