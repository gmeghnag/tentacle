/**
 * The gallery's view-model (docs/feat/model-artifacts.md D9, T7.1): artifacts
 * newest first with their versions FOLDED, grouped by day, plus the "unseen"
 * count the Session info row and the hub badge show.
 *
 * `unseen` is the whole reason this module exists: it is a decision about two
 * clocks (the daemon's `createdAt`, this device's `lastGalleryAt`) and one set
 * (`opened` shas), so it is decided HERE and asserted, never in the sheet.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  CHART_FILTER_LABEL,
  galleryKindCount,
  gallerySummary,
  galleryView,
  unseenArtifacts,
} from "../src/artifact-gallery.ts";
import { markArtifactOpened, markGalleryOpened, sessionKey } from "../src/artifact-seen-store.ts";

const NOW = Date.UTC(2026, 10, 16, 15, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function meta(
  over: Partial<ArtifactMeta> & { readonly artifactId: string; readonly version: number },
): ArtifactMeta {
  return {
    sha256: `${over.version}`.padEnd(64, "a"),
    size: 240_000,
    mimeType: "image/png",
    kind: "image",
    title: over.artifactId,
    callId: `c-${over.artifactId}-${over.version}`,
    createdAt: NOW - HOUR,
    width: 1280,
    height: 720,
    ...over,
  };
}

const NOTHING_SEEN = { lastGalleryAt: 0, opened: [] } as const;

describe("folding and order", () => {
  test("one row per artifact, newest presented first, versions folded into a count", () => {
    const list = [
      meta({ artifactId: "older", version: 1, createdAt: NOW - 2 * HOUR }),
      meta({ artifactId: "report", version: 1, createdAt: NOW - HOUR }),
      meta({ artifactId: "report", version: 2, createdAt: NOW - MINUTE }),
    ];
    const view = galleryView(list, NOTHING_SEEN, NOW, "");
    expect(view.sections.flatMap((s) => s.items.map((i) => i.key))).toEqual(["report", "older"]);
    const report = view.sections[0]?.items[0];
    expect(report?.versions).toBe(2);
    expect(report?.card.line2).toContain("v2");
    expect(view.empty).toBe(false);
  });

  test("a row's card is its NEWEST version's, and its time is that version's", () => {
    const list = [
      meta({ artifactId: "report", version: 1, createdAt: NOW - HOUR, title: "draft" }),
      meta({ artifactId: "report", version: 2, createdAt: NOW - 5 * MINUTE, title: "final" }),
    ];
    const item = galleryView(list, NOTHING_SEEN, NOW, "").sections[0]?.items[0];
    expect(item?.card.title).toBe("final");
    expect(item?.time).toBe("14:55");
  });

  test("a second version of a LOWER id still lifts its artifact above an older one", () => {
    const list = [
      meta({ artifactId: "alpha", version: 1, createdAt: NOW - 3 * HOUR }),
      meta({ artifactId: "zulu", version: 1, createdAt: NOW - 2 * HOUR }),
      meta({ artifactId: "alpha", version: 2, createdAt: NOW - MINUTE }),
    ];
    expect(
      galleryView(list, NOTHING_SEEN, NOW, "").sections.flatMap((s) => s.items.map((i) => i.key)),
    ).toEqual(["alpha", "zulu"]);
  });

  test("no artifacts → no sections and empty", () => {
    const view = galleryView([], NOTHING_SEEN, NOW, "");
    expect(view).toEqual({ sections: [], unseen: 0, empty: true });
  });
});

describe("day sections", () => {
  test("Today, Yesterday, then the older day's date — newest section first", () => {
    const list = [
      meta({ artifactId: "today", version: 1, createdAt: NOW - MINUTE }),
      meta({ artifactId: "yesterday", version: 1, createdAt: NOW - DAY }),
      meta({ artifactId: "old", version: 1, createdAt: NOW - 4 * DAY }),
    ];
    const view = galleryView(list, NOTHING_SEEN, NOW, "");
    expect(view.sections.map((s) => s.day)).toEqual(["Today", "Yesterday", "2026-11-12"]);
    expect(view.sections.map((s) => s.items.map((i) => i.key))).toEqual([
      ["today"],
      ["yesterday"],
      ["old"],
    ]);
  });

  test("a daemon clock ahead of this phone reads Today, never a future day", () => {
    const list = [meta({ artifactId: "ahead", version: 1, createdAt: NOW + 2 * DAY })];
    expect(galleryView(list, NOTHING_SEEN, NOW, "").sections.map((s) => s.day)).toEqual(["Today"]);
  });
});

describe("unseen", () => {
  const list = [meta({ artifactId: "report", version: 1, createdAt: NOW - HOUR })];

  test("a version presented after the last gallery open is unseen, and is counted", () => {
    const seen = { lastGalleryAt: NOW - 2 * HOUR, opened: [] };
    const view = galleryView(list, seen, NOW, "");
    expect(view.sections[0]?.items[0]?.unseen).toBe(true);
    expect(view.unseen).toBe(1);
  });

  test("one already listed in `opened` is seen, whatever its clock", () => {
    const seen = { lastGalleryAt: 0, opened: [list[0]?.sha256 ?? ""] };
    expect(galleryView(list, seen, NOW, "").unseen).toBe(0);
  });

  test("opening the gallery clears the count; a NEW version of the same artifact makes it 1", () => {
    let seen = { lastGalleryAt: 0, opened: [] as readonly string[] };
    expect(unseenArtifacts(list, seen)).toBe(1);
    seen = markGalleryOpened(seen, NOW);
    expect(unseenArtifacts(list, seen)).toBe(0);
    const withV2 = [...list, meta({ artifactId: "report", version: 2, createdAt: NOW + MINUTE })];
    expect(unseenArtifacts(withV2, seen)).toBe(1);
  });

  test("a new version of a SEEN artifact is unseen even though its id was opened", () => {
    const listed = [...list, meta({ artifactId: "report", version: 2, createdAt: NOW + MINUTE })];
    let seen = markGalleryOpened(
      markArtifactOpened(NOTHING_SEEN, list[0]?.sha256 ?? ""),
      NOW - HOUR,
    );
    // The v2 arrives after the last open: the id is "seen", its v2 is not.
    seen = markGalleryOpened(seen, NOW - HOUR);
    expect(unseenArtifacts(listed, seen)).toBe(1);
  });

  test("the count is ARTIFACTS with something new, not versions (the badge's unit)", () => {
    const many = [
      meta({ artifactId: "a", version: 1, createdAt: NOW - HOUR }),
      meta({ artifactId: "a", version: 2, createdAt: NOW - HOUR }),
      meta({ artifactId: "a", version: 3, createdAt: NOW - HOUR }),
      meta({ artifactId: "b", version: 1, createdAt: NOW - HOUR }),
    ];
    expect(unseenArtifacts(many, NOTHING_SEEN)).toBe(2);
    expect(galleryView(many, NOTHING_SEEN, NOW, "").unseen).toBe(2);
  });

  test("a version presented in the SAME instant the gallery opened is still new", () => {
    // The fail-safe direction: the open's own `artifact/list` may have missed it,
    // so a false "new" (a badge) is chosen over a false "seen" (a hidden artifact).
    const same = [meta({ artifactId: "race", version: 1, createdAt: NOW })];
    const opened = markGalleryOpened(NOTHING_SEEN, NOW);
    expect(unseenArtifacts(same, opened)).toBe(1);
    // ...and it clears at the NEXT open, or when the version itself is opened.
    expect(unseenArtifacts(same, markGalleryOpened(opened, NOW + 1))).toBe(0);
    expect(unseenArtifacts(same, markArtifactOpened(opened, same[0]?.sha256 ?? ""))).toBe(0);
  });
});

describe("filter", () => {
  const list = [
    meta({ artifactId: "latency", version: 1, title: "latency-p99.png" }),
    meta({ artifactId: "dashboard", version: 1, title: "Q3 revenue dashboard", kind: "html" }),
  ];

  test("case- and space-insensitive on the title; sections follow the hits", () => {
    const view = galleryView(list, NOTHING_SEEN, NOW, "  Q3 ");
    expect(view.sections.flatMap((s) => s.items.map((i) => i.key))).toEqual(["dashboard"]);
    expect(view.empty).toBe(false);
  });

  test("a filter that hits nothing is empty (the screen has its own 'no match' words)", () => {
    expect(galleryView(list, NOTHING_SEEN, NOW, "zzz").empty).toBe(true);
  });
});

describe("the `only` kind filter (C8: the `Grafici` chip)", () => {
  const list = [
    meta({ artifactId: "revenue", version: 1, title: "Ricavi 2026", kind: "chart" }),
    meta({ artifactId: "latency", version: 1, title: "latency-p99.png" }),
    meta({ artifactId: "charts2", version: 1, title: "Copertura", kind: "chart" }),
  ];

  test('`only: "chart"` keeps the charts and drops everything else', () => {
    const all = galleryView(list, NOTHING_SEEN, NOW, "");
    // One `createdAt`, so the id is the tie-break (`groupArtifacts`): charts2,
    // latency, revenue — the order is preserved through every filter.
    expect(all.sections.flatMap((s) => s.items.map((i) => i.key))).toEqual([
      "charts2",
      "latency",
      "revenue",
    ]);
    const charts = galleryView(list, NOTHING_SEEN, NOW, "", "chart");
    expect(charts.sections.flatMap((s) => s.items.map((i) => i.key))).toEqual([
      "charts2",
      "revenue",
    ]);
    expect(charts.empty).toBe(false);
    // Absent = every kind (the screen's default state).
    expect(galleryView(list, NOTHING_SEEN, NOW, "", undefined).sections.length).toBe(
      all.sections.length,
    );
  });

  test("it COMPOSES with the title needle: both must match", () => {
    expect(
      galleryView(list, NOTHING_SEEN, NOW, "cop", "chart")
        .sections.flatMap((s) => s.items.map((i) => i.key))
        .join(),
    ).toBe("charts2");
    // A title hit of another kind is not a hit for the chart chip.
    expect(galleryView(list, NOTHING_SEEN, NOW, "latency", "chart").empty).toBe(true);
  });

  test("the chip narrows the ROWS; the unseen badge stays the session's count (D9)", () => {
    const charts = galleryView(list, NOTHING_SEEN, NOW, "", "chart");
    expect(gallerySummary(charts)).toBe("2 artifacts · 3 new");
    expect(gallerySummary(galleryView(list, NOTHING_SEEN, NOW, ""))).toBe("3 artifacts · 3 new");
  });

  test("`galleryKindCount` is the chip's number, over ARTIFACTS (versions folded)", () => {
    const versioned = [
      ...list,
      meta({ artifactId: "revenue", version: 2, title: "Ricavi 2026", kind: "chart" }),
    ];
    expect(galleryKindCount(versioned, "chart")).toBe(2);
    expect(galleryKindCount(versioned, "image")).toBe(1);
    expect(galleryKindCount(versioned, "pdf")).toBe(0);
    expect(galleryKindCount([], "chart")).toBe(0);
  });

  test("the chip's label is the Italian the rest of the gallery uses", () => {
    expect(CHART_FILTER_LABEL).toBe("Grafici");
  });

  test("an artifact filed as `other` (an old build's view) is not a chart", () => {
    const forged = [meta({ artifactId: "hologram", version: 1, kind: "hologram" })];
    expect(galleryView(forged, NOTHING_SEEN, NOW, "", "chart").empty).toBe(true);
    expect(galleryKindCount(forged, "other")).toBe(1);
  });
});

describe("gallerySummary", () => {
  test("counts artifacts, and only mentions new ones when there are some", () => {
    const list = [meta({ artifactId: "a", version: 1 }), meta({ artifactId: "b", version: 1 })];
    expect(gallerySummary(galleryView(list, NOTHING_SEEN, NOW, ""))).toBe("2 artifacts · 2 new");
    expect(
      gallerySummary(
        galleryView(list, { lastGalleryAt: 0, opened: list.map((m) => m.sha256) }, NOW, ""),
      ),
    ).toBe("2 artifacts");
    expect(gallerySummary(galleryView(list.slice(0, 1), NOTHING_SEEN, NOW, ""))).toBe(
      "1 artifact · 1 new",
    );
    expect(gallerySummary(galleryView([], NOTHING_SEEN, NOW, ""))).toBe("No artifacts");
  });
});

describe("sessionKey", () => {
  test("one key per computer+session, so two computers never share a seen record", () => {
    expect(sessionKey("mbp", "s1")).toBe("mbp/s1");
    expect(sessionKey("mbp", "s1")).not.toBe(sessionKey("studio", "s1"));
  });
});
