import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_DEFAULTS } from "@tentacle/tui";
import { connectVoice } from "../src/connect.ts";

/**
 * Fix round 1 (Review HIGH 4): `connect`'s TUI must honour the laptop's
 * `voice.*`. It loads no model config, so — exactly like `tui.theme` — the
 * settings come from the config FILE, and a broken file must never block a
 * connection that needs no local configuration at all.
 */
async function withConfig<T>(text: string | null, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tentacle-connect-voice-"));
  try {
    if (text !== null) await writeFile(join(dir, "config.jsonc"), text, "utf8");
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Fix 4 (HIGH 4): connect reads the laptop's voice settings", () => {
  test("the file's `voice` block reaches the TUI, over the defaults", async () => {
    // Mutation: drop `connectVoice` and pass `VOICE_DEFAULTS` → red.
    await withConfig('{ "voice": { "enabled": false, "key": "ctrl+k" } }', async (configDir) => {
      const voice = await connectVoice({ url: "ws://127.0.0.1:9", configDir });
      expect(voice.config.enabled).toBe(false);
      expect(voice.config.key).toBe("ctrl+k");
      // Everything unset still comes from the ONE defaults object.
      expect(voice.config.engine).toBe(VOICE_DEFAULTS.engine);
      expect(voice.configDir).toBe(configDir);
    });
  });

  test("no file: the defaults, and the config dir is still handed on", async () => {
    await withConfig(null, async (configDir) => {
      const voice = await connectVoice({ url: "ws://127.0.0.1:9", configDir });
      expect(voice.config).toEqual(VOICE_DEFAULTS);
      expect(voice.configDir).toBe(configDir);
    });
  });

  test("a BROKEN file never blocks the connection: the defaults, silently", async () => {
    // The palette read beside this one already warned about the file.
    await withConfig('{ "voice": { "key": "nonsense" } }', async (configDir) => {
      const voice = await connectVoice({ url: "ws://127.0.0.1:9", configDir });
      expect(voice.config).toEqual(VOICE_DEFAULTS);
    });
  });

  test("a `voice` block without `enabled` is OFF (default, not 'present means on')", async () => {
    // feat/voice-off-by-default: the file may tune `key`/`language` and still
    // leave voice off. Mutation: `enabled: file.voice !== undefined` in
    // `connectVoice` → red.
    await withConfig('{ "voice": { "key": "ctrl+k" } }', async (configDir) => {
      const voice = await connectVoice({ url: "ws://127.0.0.1:9", configDir });
      expect(voice.config.enabled).toBe(false);
      expect(voice.config.key).toBe("ctrl+k");
    });
  });

  test("`enabled: true` in the file turns it on (the opt-in survives the merge)", async () => {
    await withConfig('{ "voice": { "enabled": true } }', async (configDir) => {
      const voice = await connectVoice({ url: "ws://127.0.0.1:9", configDir });
      expect(voice.config.enabled).toBe(true);
    });
  });
});
