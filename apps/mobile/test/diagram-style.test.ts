/**
 * The iPhone diagram look, `outline | filled` (docs/feat/model-diagrams.md, owner
 * answer Q1: "a setting to switch the iPhone diagrams to the B look"; built by
 * docs/fix/mobile-qa-1117.md, bug 3), and the full screen following the system
 * appearance while it is open (same bug).
 *
 * - the store: `{v:1, style}` behind `SecureKV`, the activity-settings rules
 *   (absent → outline; a newer build's record is read as the default and never
 *   written over);
 * - the theme: `filled` = soft slot-1 fills, slot-1 edges; `outline` unchanged;
 * - the render key: the style is part of a render's identity (a switch
 *   re-renders), and the outline key keeps its old form (no needless re-render);
 * - the wiring: a Settings band, the row reading the holder, and the full
 *   screens presented over (not instead of) the app.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diagramModel, lintDiagram, seriesColor, summarizeDiagram } from "@tentacle/core";
import type { SecureKV } from "../src/computer-store.ts";
import { diagramCacheKey } from "../src/diagram-cache.ts";
import {
  DIAGRAM_TOOL,
  type DiagramToolRow,
  diagramRowSpec,
  diagramRowView,
} from "../src/diagram-row.ts";
import {
  DIAGRAM_SETTINGS_KEY,
  DiagramSettingsPreserved,
  createDiagramSettingsHolder,
  createDiagramSettingsStore,
} from "../src/diagram-settings-store.ts";
import { diagramTheme, diagramThemeVariables } from "../src/diagram-theme.ts";
import { chartTokensFor, darkPalette, lightPalette } from "../src/theme.ts";

function fake(initial: string | null = null) {
  const items = new Map<string, string>();
  if (initial !== null) items.set(DIAGRAM_SETTINGS_KEY, initial);
  const kv: SecureKV = {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => {
      items.set(key, value);
    },
    delete: async (key) => {
      items.delete(key);
    },
  };
  return { store: createDiagramSettingsStore({ kv, keychainAccessible: 6 }), items };
}

describe("the setting on disk", () => {
  test("absent → outline (the owner's default), writable", async () => {
    expect(await fake().store.read()).toEqual({ settings: { style: "outline" }, writable: true });
  });

  test("filled round-trips as a v1 record", async () => {
    const f = fake();
    await f.store.write({ style: "filled" });
    expect(JSON.parse(f.items.get(DIAGRAM_SETTINGS_KEY) ?? "null")).toEqual({
      v: 1,
      style: "filled",
    });
    expect(await f.store.read()).toEqual({ settings: { style: "filled" }, writable: true });
  });

  test("a newer build's record reads the default and is never written over", async () => {
    const raw = JSON.stringify({ v: 2, style: "hatched" });
    const f = fake(raw);
    expect(await f.store.read()).toEqual({ settings: { style: "outline" }, writable: false });
    await expect(f.store.write({ style: "filled" })).rejects.toBeInstanceOf(
      DiagramSettingsPreserved,
    );
    expect(f.items.get(DIAGRAM_SETTINGS_KEY)).toBe(raw);
  });

  test("an unknown style inside v1 reads outline (never a blank diagram)", async () => {
    const f = fake(JSON.stringify({ v: 1, style: "neon" }));
    expect((await f.store.read()).settings.style).toBe("outline");
  });

  test("the holder publishes a pick to its subscribers", async () => {
    const holder = createDiagramSettingsHolder(fake().store);
    const seen: string[] = [];
    holder.subscribe((s) => seen.push(s.style));
    await holder.set({ style: "filled" });
    expect(holder.current().style).toBe("filled");
    expect(seen).toEqual(["filled"]);
  });
});

describe("the filled look (1B/2B)", () => {
  for (const palette of [lightPalette, darkPalette]) {
    const scheme = palette === darkPalette ? "dark" : "light";
    test(`${scheme}: nodes and participants soft-filled with slot 1, edges in slot 1`, () => {
      const t = chartTokensFor(palette);
      const accent = seriesColor(0, scheme);
      const filled = diagramThemeVariables(palette, "filled");
      expect(filled.mainBkg).toBe(t.seriesSoft);
      expect(filled.primaryColor).toBe(t.seriesSoft);
      expect(filled.actorBkg).toBe(t.seriesSoft);
      expect(filled.nodeBorder).toBe(accent);
      expect(filled.lineColor).toBe(accent);
      expect(filled.signalColor).toBe(accent);
      // An edge label sits on the page, not on a tint mermaid derives from the
      // translucent fill (the first build drew a teal box behind "si"/"no").
      expect(filled.edgeLabelBackground).toBe(palette.page);
    });

    test(`${scheme}: outline is exactly what it was (the default call)`, () => {
      expect(diagramThemeVariables(palette, "outline")).toEqual(diagramThemeVariables(palette));
      expect(diagramThemeVariables(palette).mainBkg).toBe(palette.page);
    });
  }

  test("the theme key carries the style", () => {
    expect(diagramTheme(lightPalette, "filled").key).not.toBe(diagramTheme(lightPalette).key);
  });
});

describe("the style is part of a render's identity", () => {
  const SOURCE = "flowchart TD\n  A --> B";
  test("outline keeps the old key; filled is another render", () => {
    expect(diagramCacheKey(SOURCE, "light", 1)).toBe(
      diagramCacheKey(SOURCE, "light", 1, "outline"),
    );
    expect(diagramCacheKey(SOURCE, "light", 1, "filled")).not.toBe(
      diagramCacheKey(SOURCE, "light", 1),
    );
  });

  test("diagramRowView: the style picks the key", () => {
    const lint = lintDiagram(SOURCE);
    if (!lint.ok) throw new Error("the fixture source must lint");
    const row: DiagramToolRow = {
      name: DIAGRAM_TOOL,
      args: JSON.stringify({ title: "Flusso", mermaid: SOURCE }),
      status: "ok",
      output: summarizeDiagram(diagramModel(lint.canonical, lint.type), lint.type, {
        title: "Flusso",
      }).line,
    };
    const spec = diagramRowSpec(row);
    if (spec === null) throw new Error("the fixture must draw");
    const outline = diagramRowView(row, { palette: lightPalette, fontScale: 1 });
    const filled = diagramRowView(row, { palette: lightPalette, fontScale: 1, style: "filled" });
    expect(outline?.renderKey).toBe(diagramCacheKey(spec.source.canonical, "light", 1));
    expect(filled?.renderKey).toBe(diagramCacheKey(spec.source.canonical, "light", 1, "filled"));
    expect(filled?.style).toBe("filled");
  });
});

const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");

describe("wiring", () => {
  test("Settings has a Diagrams band with both looks", () => {
    const settings = read("src", "screens", "SettingsScreen.tsx");
    expect(settings).toContain('title="Diagrams"');
    expect(settings).toContain("diagram-style-${row.value}");
    const app = read("App.tsx");
    expect(app).toContain("DIAGRAM_SETTINGS.load()");
    expect(app).toMatch(/diagramStyle=\{diagramSettings\.style\}/);
  });

  test("the session screen reads the setting live and hands it to each diagram row", () => {
    const screen = read("src", "screens", "SessionScreen.tsx");
    expect(screen).toContain("DIAGRAM_SETTINGS.subscribe(");
    expect(screen).toContain("diagramStyle={diagramStyle}");
    const row = read("src", "screens", "transcript", "TranscriptRow.tsx");
    expect(row).toContain("style: props.diagramStyle");
    const block = read("src", "ui", "diagram", "DiagramBlock.tsx");
    expect(block).toMatch(/diagramTheme\(palette, view\.style\)/);
  });

  test("the full screens are presented OVER the app, so an appearance flip reaches them", () => {
    // `fullScreen` takes the presenting view out of the window: iOS stops sending
    // it trait changes, so `useColorScheme` (read at the app's root) stays on the
    // old scheme until the modal closes — the QA's 14-diagram-full-switched shot.
    for (const file of [
      ["src", "ui", "diagram", "DiagramFullScreen.tsx"],
      ["src", "ui", "chart", "ChartFullScreen.tsx"],
    ]) {
      const src = read(...file);
      expect(src).not.toContain('presentationStyle="fullScreen"');
      expect(src).toContain("presentationStyle={FULL_SCREEN_PRESENTATION}");
    }
  });
});
