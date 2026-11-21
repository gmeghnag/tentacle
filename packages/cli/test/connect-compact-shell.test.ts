import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCompactShell } from "../src/connect.ts";

/**
 * `connect` honours `beta.compactShell` (docs/feat/shell-intent-line.md §4)
 * exactly as it does `tui.chartGlyphs`: from the config FILE, OFF when absent,
 * and a broken file never blocks the connection.
 */
async function withConfig<T>(text: string | null, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tentacle-connect-compact-"));
  try {
    if (text !== null) {
      await writeFile(join(dir, "config.jsonc"), text, "utf8");
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const read = (configDir: string, extra: { compactShell?: boolean } = {}) =>
  connectCompactShell({ url: "ws://127.0.0.1:9", configDir, ...extra });

describe("connectCompactShell", () => {
  test("`beta.compactShell: true` is read", async () => {
    await withConfig('{ "beta": { "compactShell": true } }', async (configDir) => {
      expect(await read(configDir)).toBe(true);
    });
  });

  test("absent → off; an explicit option beats the file; a broken file → off", async () => {
    await withConfig(null, async (configDir) => {
      expect(await read(configDir)).toBe(false);
    });
    await withConfig('{ "beta": { "compactShell": true } }', async (configDir) => {
      expect(await read(configDir, { compactShell: false })).toBe(false);
    });
    await withConfig("{ nope", async (configDir) => {
      expect(await read(configDir)).toBe(false);
    });
  });
});
