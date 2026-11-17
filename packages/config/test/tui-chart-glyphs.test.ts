import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { readFileConfig } from "../src/load.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `tui.chartGlyphs` (docs/feat/model-charts.md D5): a chart's plot glyphs —
// `braille` (default) or `blocks` for a font without the braille patterns,
// which a terminal cannot report. LAPTOP-ONLY, exactly like `tui.theme`: a
// display setting of this machine, never carried to a pod, and defaulted where
// the TUI is launched rather than in `resolveConfig`.
describe("tui.chartGlyphs", () => {
  test("the two values are accepted in the file and in a profile; anything else is an error", () => {
    // Mutation: drop the key from the schema → every `success` below is false
    // (`strict()` refuses it), which is the pre-C4 state.
    for (const chartGlyphs of ["braille", "blocks"]) {
      expect(FileConfigSchema.safeParse({ tui: { chartGlyphs } }).success).toBe(true);
      expect(
        FileConfigSchema.safeParse({ profiles: { p: { tui: { chartGlyphs } } } }).success,
      ).toBe(true);
    }
    expect(FileConfigSchema.safeParse({ tui: { chartGlyphs: "emoji" } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tui: { chartGlyphs: 1 } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tui: { chartGlyphs: "Blocks" } }).success).toBe(false);
  });

  test("it sits beside `tui.theme` rather than replacing it", () => {
    const both = FileConfigSchema.safeParse({ tui: { theme: "light", chartGlyphs: "blocks" } });
    expect(both.success).toBe(true);
    if (!both.success) {
      return;
    }
    expect(resolveConfig({ fileConfig: both.data, env: {}, defaultCwd: "/w" }).tui).toEqual({
      theme: "light",
      chartGlyphs: "blocks",
    });
  });

  test("absent when unset: the TUI applies `braille`, not `resolveConfig`", () => {
    const file = FileConfigSchema.parse({ tui: { theme: "dark" } });
    expect(resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }).tui).toEqual({
      theme: "dark",
    });
  });

  test("a profile's value applies, and the scaffold shows the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tentacle-chart-glyphs-"));
    try {
      await writeFile(
        join(dir, "config.jsonc"),
        '{ "tui": { "chartGlyphs": "braille" }, "profiles": { "p": { "tui": { "chartGlyphs": "blocks" } } } }',
        "utf8",
      );
      // The file as `readFileConfig` sees it (no profile applied), then the
      // profile merge on top — the layer order the CLI uses.
      const file = await readFileConfig({
        configDir: dir,
        env: { ...process.env, TENTACLE_CONFIG_DIR: dir, TENTACLE_PROFILE: "" },
      });
      const withProfile = FileConfigSchema.parse({
        ...file,
        profiles: { p: { tui: { chartGlyphs: "blocks" } } },
      });
      const merged = applyProfile(withProfile, "p");
      expect(merged.ok).toBe(true);
      if (!merged.ok) {
        return;
      }
      expect(merged.config.tui).toEqual({ chartGlyphs: "blocks" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // The commented scaffold names it, so `tentacle config` teaches the key.
    expect(DEFAULT_CONFIG_JSONC).toContain('"tui": { "chartGlyphs": "braille" }');
  });
});
