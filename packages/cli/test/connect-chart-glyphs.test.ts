import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChartGlyphs } from "@tentacle/tui";
import { connectChartGlyphs } from "../src/connect.ts";

/**
 * `connect` honours `tui.chartGlyphs` (docs/feat/model-charts.md D5), exactly as
 * it does `tui.theme`: `connect` loads no model config, so the setting comes
 * from the config FILE, and a broken file must never block a connection — the
 * palette's own reader, called beside this one, already warned about it, so
 * `braille` is the silent fallback here.
 */
async function withConfig<T>(text: string | null, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tentacle-connect-glyphs-"));
  try {
    if (text !== null) {
      await writeFile(join(dir, "config.jsonc"), text, "utf8");
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const read = (configDir: string, extra: { chartGlyphs?: ChartGlyphs } = {}) =>
  connectChartGlyphs({ url: "ws://127.0.0.1:9", configDir, ...extra });

describe("connectChartGlyphs", () => {
  test("`tui.chartGlyphs: blocks` is read", async () => {
    // Mutation: return a constant `braille` (never read the file) → red.
    await withConfig('{ "tui": { "chartGlyphs": "blocks" } }', async (configDir) => {
      expect(await read(configDir)).toBe("blocks");
    });
  });

  test("absent → `braille`", async () => {
    await withConfig('{ "tui": { "theme": "light" } }', async (configDir) => {
      expect(await read(configDir)).toBe("braille");
    });
    await withConfig(null, async (configDir) => {
      expect(await read(configDir)).toBe("braille");
    });
  });

  test("an explicit option beats the file", async () => {
    await withConfig('{ "tui": { "chartGlyphs": "blocks" } }', async (configDir) => {
      expect(await read(configDir, { chartGlyphs: "braille" })).toBe("braille");
    });
  });

  test("a broken config never blocks the connection", async () => {
    await withConfig("{ nope", async (configDir) => {
      expect(await read(configDir)).toBe("braille");
    });
  });
});
