/**
 * docs/feat/model-artifacts.md S6a — the `/artifacts` panel, PURE (T6a's second
 * half): the rows (newest artifact first, versions folded under it), the cursor
 * walk, the width fit, and the two decisions the panel owns — `enter` opens the
 * meta under the cursor, `esc` closes.
 *
 * Every assertion is on the projection or on the router's `LayerStep`, never on
 * a component: the panel is a descriptor (`panels/artifacts.ts`) whose
 * projection `ListPanel` only paints.
 */
import { describe, expect, test } from "bun:test";
import type { ChartSpec } from "@tentacle/core";
import { canonicalChartJson, validateChartSpec } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import type { Key } from "ink";
import {
  ARTIFACTS_HINT,
  artifactGroups,
  artifactsListError,
  chartPreviewView,
} from "../src/artifacts-panel.ts";
import { NOTHING } from "../src/keys/contract.ts";
import type { KeySnapshot } from "../src/keys/snapshot.ts";
import {
  type ArtifactsPanel,
  type OpenPanel,
  applyPanel,
  artifactsPanel,
  panelClick,
  panelView,
} from "../src/panel.ts";
import { artifactsKind } from "../src/panels/artifacts.ts";
import { type PanelAt, kindOf, panelStep } from "../src/panels/registry.ts";

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function snap(over: Partial<KeySnapshot> = {}, char = "", key: Partial<Key> = {}): KeySnapshot {
  return {
    char,
    key: { ...NO_KEY, ...key },
    quitConfirm: () => null,
    artifactConfirm: () => null,
    dock: () => ({ focus: { kind: "input" }, drafts: {}, sent: {} }) as never,
    chord: () => ({ armedAt: null }),
    running: () => false,
    compacting: () => false,
    pasteBuffer: () => null,
    replyMaxChars: 0,
    dockIds: () => [],
    othersOnSession: () => 0,
    sessionId: () => "s1",
    switching: () => false,
    panelGen: () => 0,
    abortable: () => false,
    uploadInFlight: () => false,
    exitPending: () => false,
    subagents: () => [],
    jobRows: () => [],
    panel: null,
    paletteOpen: false,
    paletteNames: [],
    commandSel: 0,
    fieldValue: "",
    permission: {
      pending: null,
      choices: [],
      selected: 0,
      mode: () => ({ mode: "menu" }),
      shownAt: () => 0,
    },
    sessions: undefined,
    detachOnQuit: false,
    voice: () => "idle",
    voiceKey: () => "ctrl+r",
    ...over,
  } as KeySnapshot;
}

/** One artifact version; `n` orders them in time (the daemon appends). */
function meta(
  over: Partial<ArtifactMeta> & { readonly artifactId: string; readonly version: number },
): ArtifactMeta {
  return {
    sha256: `sha-${over.artifactId}-${over.version}`,
    size: 14_000,
    mimeType: "text/html",
    kind: "html",
    title: `Artifact ${over.artifactId}`,
    callId: `call-${over.artifactId}-${over.version}`,
    createdAt: over.version * 1000,
    ...over,
  };
}

/** Oldest first, as the wire orders them: `dashboard` v1, `chart` v1, `dashboard` v2. */
const LIST: readonly ArtifactMeta[] = [
  meta({ artifactId: "dashboard", version: 1, title: "Q3 revenue dashboard", createdAt: 1_000 }),
  meta({
    artifactId: "chart",
    version: 1,
    title: "latency-p99.png",
    kind: "image",
    mimeType: "image/png",
    size: 240_000,
    width: 1280,
    height: 720,
    createdAt: 2_000,
  }),
  meta({ artifactId: "dashboard", version: 2, title: "Q3 revenue dashboard", createdAt: 3_000 }),
];

const panel = (data: readonly ArtifactMeta[] | null = LIST): OpenPanel =>
  artifactsPanel(data === null ? null : { artifacts: data }, 4_000);

const AT: PanelAt = { width: 120, maxBody: 12, current: "s1" };

describe("S6a: the `/artifacts` panel projects newest-first, versions folded", () => {
  test("one head row per artifact, newest first, with its newest version's card", () => {
    const view = panelView(panel(), 120, 12);
    expect(view.title).toContain("artifacts");
    const heads = view.rows.filter((r) => r.kind === "head").map((r) => r.text);
    expect(heads).toHaveLength(2);
    // `dashboard` v2 was presented LAST, so its group is on top.
    expect(heads[0]).toContain("Q3 revenue dashboard");
    expect(heads[0]).toContain("HTML page");
    expect(heads[0]).toContain("v2");
    expect(heads[1]).toContain("latency-p99.png");
    expect(heads[1]).toContain("PNG · 1280×720");
  });

  test("the older versions are folded under their artifact until → expands it", () => {
    const collapsed = panelView(panel(), 120, 12);
    expect(collapsed.rows.some((r) => r.kind === "child")).toBe(false);
    const expanded = panelView(applyPanel(panel(), "expand", 120), 120, 12);
    const children = expanded.rows.filter((r) => r.kind === "child").map((r) => r.text);
    expect(children).toHaveLength(1);
    expect(children[0]).toContain("v1");
  });

  test("a row never exceeds the panel's width (80 and 120)", () => {
    for (const width of [80, 120]) {
      const view = panelView(applyPanel(panel(), "expand", width), width, 12);
      for (const row of view.rows) {
        expect(row.text.length).toBeLessThanOrEqual(width);
      }
      expect(view.hint.length).toBeLessThanOrEqual(width);
    }
  });

  test("loading and empty each say so, in their own words", () => {
    expect(panelView(artifactsPanel(), 80, 10).title).toContain("loading");
    expect(panelView(panel([]), 80, 10).rows.map((r) => r.text)).toEqual([
      "  No artifacts in this session.",
    ]);
  });

  test("a daemon that cut the list says so on the title (never silently)", () => {
    const view = panelView(artifactsPanel({ artifacts: LIST, truncated: true }, 4_000), 120, 12);
    expect(view.title).toContain("+");
  });
});

describe("C8: a chart artifact opens as an EXPANDED chart in the panel", () => {
  const step = (p: OpenPanel, over: Partial<KeySnapshot> = {}, char = "", key: Partial<Key> = {}) =>
    panelStep(snap({ panel: p, ...over }, char, key), "tree");
  const specOf = (raw: unknown): ChartSpec => {
    const result = validateChartSpec(raw);
    if (!result.ok) throw new Error(result.errors.join("; "));
    return result.spec;
  };
  const BYTES = canonicalChartJson(
    specOf({
      type: "line",
      title: "Ricavi",
      labels: ["gen", "feb", "mar"],
      datasets: [{ label: "Ricavi", data: [11800, 14000, 20800] }],
      y: { unit: "€", format: "compact" },
    }),
  );
  const chartMeta = meta({
    artifactId: "chart",
    version: 1,
    title: "Ricavi",
    kind: "chart",
    mimeType: "application/vnd.tentacle.chart+json",
    size: 400,
    createdAt: 5_000,
  });
  const ONE = (): ArtifactsPanel => artifactsPanel({ artifacts: [chartMeta] }, 4_000);
  const previewing = (bytes: string | null, error?: string): ArtifactsPanel =>
    error === undefined
      ? { ...ONE(), preview: bytes === null ? null : { bytes } }
      : { ...ONE(), preview: { error } };

  test("`chartPreviewView` draws the canonical bytes EXPANDED, never the tree", () => {
    const view = chartPreviewView({ bytes: BYTES }, 100, 20);
    // Expanded = the caption + the stats + the table (C3's own `expanded`), so
    // the preview is MORE than the row the transcript shows.
    const text = view.rows.map((r) => r.text).join("\n");
    // The chart's own caption is the first row (the tool chrome is gone, D5).
    expect(view.rows[0]?.text).toContain("Ricavi");
    expect(text).toContain("gen");
    for (const row of view.rows) expect(row.text.length).toBeLessThanOrEqual(100);
    // And it offers the way BACK — a preview is not a trap.
    expect(view.hint).toContain("esc");
  });

  test("bytes that do not re-validate say so, and never draw a half chart", () => {
    const forged = JSON.stringify({
      type: "line",
      title: "Ricavi",
      labels: ["gen"],
      datasets: [{ label: "x", data: ["12.5"] }],
    });
    for (const bytes of [forged, "{not json", ""]) {
      const view = chartPreviewView({ bytes }, 100, 20);
      const text = view.rows.map((r) => r.text).join("\n");
      expect(text).toContain("can't draw");
      expect(text).not.toContain("⣀");
      expect(view.hint).toContain("esc");
    }
  });

  test("enter on a chart artifact asks for its PREVIEW; on any other kind it opens it", () => {
    expect(step(ONE(), {}, "", { return: true }).effects).toEqual([
      { kind: "previewArtifact", artifact: chartMeta },
    ]);
    // A non-chart artifact keeps S6b's open (the OS viewer, save, network).
    expect(step(panel(), {}, "", { return: true }).effects).toEqual([
      { kind: "openArtifact", artifact: LIST[2] as ArtifactMeta },
    ]);
  });

  test("with a preview OPEN, esc/q goes back to the tree and nothing else is claimed", () => {
    expect(step(previewing(BYTES), {}, "", { escape: true }).effects).toEqual([
      { kind: "previewArtifact", artifact: null },
    ]);
    expect(step(previewing(BYTES), {}, "q").effects).toEqual([
      { kind: "previewArtifact", artifact: null },
    ]);
    // `enter` changes nothing (there is nothing to open inside a preview) and a
    // cursor key does not walk a tree that is not on screen.
    expect(step(previewing(BYTES), {}, "", { return: true }).effects).toEqual([]);
    expect(step(previewing(BYTES), {}, "", { downArrow: true }).effects).toEqual([]);
    // A FAILED read is still a preview: the same esc gets out of it.
    expect(step(previewing(null, "artifact evicted"), {}, "", { escape: true }).effects).toEqual([
      { kind: "previewArtifact", artifact: null },
    ]);
  });

  test("the previewed panel's VIEW is the chart, not the rows", () => {
    const previewView = panelView(previewing(BYTES), 100, 20);
    // The chart's caption, not an artifact row (`❯ ◱ Ricavi  Chart · 400 B`).
    expect(previewView.rows[0]?.text).toContain("Ricavi");
    expect(previewView.rows.some((r) => r.kind === "head")).toBe(false);
    // With no preview the tree is back, rows and all.
    expect(panelView(previewing(null), 100, 20).rows.some((r) => r.kind === "head")).toBe(true);
  });

  test("a read still IN FLIGHT says so — never that the spec did not validate", () => {
    // `bytes === undefined` is "asking the daemon", not "0 bytes of a spec":
    // the empty preview is what `enter` writes before the answer arrives.
    const view = panelView({ ...ONE(), preview: {} }, 100, 20);
    const text = view.rows.map((r) => r.text).join("\n");
    expect(text.toLowerCase()).toContain("reading");
    expect(text).not.toContain("can't draw");
    expect(view.hint).toContain("esc");
    // An EMPTY answer (a 0-byte artifact) is a resolved read, and still says
    // its spec did not validate — the two states are not the same thing.
    expect(
      chartPreviewView({ bytes: "" }, 100, 20)
        .rows.map((r) => r.text)
        .join("\n"),
    ).toContain("can't draw");
  });

  test("a preview read that FAILED has its own words (never a silent tree)", () => {
    const view = panelView(previewing(null, "artifact evicted"), 100, 20);
    expect(view.rows.map((r) => r.text).join("\n")).toContain("artifact evicted");
    // Never a trap: the way back is on screen, and it is the preview's esc.
    expect(view.hint).toContain("esc");
  });

  test("a row for a chart artifact says so in the tree (`Chart · N KB`)", () => {
    const heads = panelView(ONE(), 120, 12).rows.filter((r) => r.kind === "head");
    expect(heads[0]?.text).toContain("Chart · 400 B");
  });
});

describe("S6a: the panel's keys are its own decision", () => {
  const step = (p: OpenPanel, over: Partial<KeySnapshot> = {}, char = "", key: Partial<Key> = {}) =>
    panelStep(snap({ panel: p, ...over }, char, key), "tree");
  test("esc closes, ↑↓ walk, → expands, ← collapses", () => {
    expect(step(panel(), {}, "", { escape: true })).toEqual({
      effects: [{ kind: "closePanel" }],
      verdict: "consumed",
      carry: "",
    });
    expect(step(panel(), {}, "", { downArrow: true }).effects).toEqual([
      { kind: "applyPanel", action: "down" },
    ]);
    expect(step(panel(), {}, "", { upArrow: true }).effects).toEqual([
      { kind: "applyPanel", action: "up" },
    ]);
    expect(step(panel(), {}, "", { rightArrow: true }).effects).toEqual([
      { kind: "applyPanel", action: "expand" },
    ]);
    expect(step(panel(), {}, "", { leftArrow: true }).effects).toEqual([
      { kind: "applyPanel", action: "collapse" },
    ]);
  });

  test("enter opens the meta under the cursor: the newest version, then a folded one", () => {
    // The cursor starts on the first head = `dashboard` v2 (its newest version).
    expect(step(panel(), {}, "", { return: true }).effects).toEqual([
      { kind: "openArtifact", artifact: LIST[2] as ArtifactMeta },
    ]);
    // On a folded child: THAT version, not its artifact's newest.
    const onChild: OpenPanel = {
      ...applyPanel(panel(), "expand", 120),
      ...{ tree: { expanded: [0], cursor: 1 } },
    };
    expect(step(onChild, {}, "", { return: true }).effects).toEqual([
      { kind: "openArtifact", artifact: LIST[0] as ArtifactMeta },
    ]);
  });

  test("`s` saves and `n` opens with the network — the meta under the cursor (S6b)", () => {
    expect(step(panel(), {}, "s").effects).toEqual([
      { kind: "openArtifact", artifact: LIST[2] as ArtifactMeta, intent: "save" },
    ]);
    expect(step(panel(), {}, "n").effects).toEqual([
      { kind: "openArtifact", artifact: LIST[2] as ArtifactMeta, intent: "network" },
    ]);
    // A modified `s` is not the save key.
    expect(step(panel(), {}, "s", { ctrl: true })).toEqual(NOTHING);
    // Nothing under the cursor: spent, nothing saved.
    expect(step(panel([]), {}, "s").effects).toEqual([]);
  });

  test("the panel's hint names the save and network keys", () => {
    expect(ARTIFACTS_HINT).toContain("s save");
    expect(ARTIFACTS_HINT).toContain("n network");
  });

  test("enter on an empty panel opens nothing, and a key it does not claim passes", () => {
    // Consumed with no effect, exactly as an empty `/mcp` list answers its
    // `toggle` (the tree panels' rule): behind a panel nothing else edits, so
    // passing would only invite a lower layer to act on a list that is empty.
    expect(step(panel([]), {}, "", { return: true })).toEqual({
      effects: [],
      verdict: "consumed",
      carry: "",
    });
    expect(step(panel(), {}, "x")).toEqual(NOTHING);
    // Space has no meaning on an artifact: it is NOT this panel's key.
    expect(step(panel(), {}, " ")).toEqual(NOTHING);
  });

  test("a click moves the cursor and a head also folds/unfolds (the tree mechanic)", () => {
    const view = panelView(panel(), 120, 12);
    const clicked = panelClick(panel(), view, 1, 120);
    expect((clicked as { tree: { cursor: number } }).tree.cursor).toBe(1);
  });
});

describe("S6a: an old daemon's refusal is the user's words, not a stack", () => {
  test("MethodNotFound says the daemon needs a newer tentacle", () => {
    expect(artifactsListError({ code: -32601 })).toContain("newer tentacle");
  });

  test("anything else keeps its message, flattened onto one line", () => {
    const text = artifactsListError(new Error("link down\nretrying"));
    expect(text).toContain("Couldn't list artifacts: link down retrying");
    expect(text.startsWith("_")).toBe(true);
  });
});

describe("S6a: `artifactGroups` — the order the panel is built on", () => {
  test("groups by artifact, newest PRESENTED first, versions newest-first", () => {
    // Deliberately shuffled on the wire: the order must not be trusted.
    const groups = artifactGroups({
      artifacts: [LIST[0] as ArtifactMeta, LIST[2] as ArtifactMeta, LIST[1] as ArtifactMeta],
    });
    expect(groups.map((g) => g.artifactId)).toEqual(["dashboard", "chart"]);
    expect(groups[0]?.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  test("an empty list is no groups (never a phantom row)", () => {
    expect(artifactGroups({ artifacts: [] })).toEqual([]);
  });

  test("two artifacts presented in the same millisecond still order stably", () => {
    const same = (artifactId: string): ArtifactMeta =>
      meta({ artifactId, version: 1, createdAt: 7 });
    const first = artifactGroups({ artifacts: [same("b"), same("a")] }).map((g) => g.artifactId);
    const second = artifactGroups({ artifacts: [same("a"), same("b")] }).map((g) => g.artifactId);
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(first);
  });
});

describe("S6a: the kind is the registry's, described once", () => {
  test("`artifacts` is found by lookup and claims the tree layer", () => {
    expect(kindOf({ kind: "artifacts" } as OpenPanel).kind).toBe("artifacts");
    expect(artifactsKind.layer).toBe("tree");
    // Nothing to switch on/off: Space is not this panel's key.
    expect(artifactsKind.switchOp).toBeUndefined();
  });

  test("`artifactsPanel` starts empty (loading) and keeps a daemon's `truncated`", () => {
    expect(artifactsPanel().data).toBeNull();
    expect(artifactsPanel({ artifacts: LIST, truncated: true }).data?.truncated).toBe(true);
    expect(artifactsPanel({ artifacts: LIST }).data?.artifacts).toHaveLength(3);
    expect(artifactsPanel({ artifacts: LIST }).data?.truncated).toBeUndefined();
  });
});
