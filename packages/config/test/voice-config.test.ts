import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/load.ts";
import { FileConfigSchema } from "../src/schema.ts";

/**
 * T9 — the `voice` config block (docs/feat/voice-dictation.md T9).
 *
 * The one rule worth a test beyond "it parses": **`autoStopSilenceMs` below 300 is
 * refused**. A shorter floor sits inside the comma pauses measured in this task's
 * S1 (96–224 ms), so accepting it would silently reintroduce the V0 truncation
 * the whole comma finding is about. The refusal is the schema's job, because the
 * config is the only way a user can set it.
 */

const ok = (voice: unknown): boolean => FileConfigSchema.safeParse({ voice }).success;

describe("T9: the voice block is accepted", () => {
  test("an empty object is valid (every key is optional)", () => {
    expect(ok({})).toBe(true);
  });

  test("every documented key parses with its own type", () => {
    expect(
      ok({
        enabled: true,
        key: "ctrl+r",
        language: "it",
        engine: "apple",
        autoStop: false,
        autoStopSilenceMs: 500,
        maxSeconds: 300,
        input: "builtin",
        voiceProcessing: true,
        modelsDir: "/models",
        helperPath: "/bin/tentacle-voice",
      }),
    ).toBe(true);
  });

  test("the whole block may be absent", () => {
    expect(FileConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe("T9: the block is `.strict()`", () => {
  test("an unknown key is refused, not ignored", () => {
    // A typo must not look like it worked: `voice.autoStopp` would otherwise be
    // dropped and the user would believe the setting was in force.
    expect(ok({ autoStopp: true })).toBe(false);
  });
});

describe("T9: the comma-safe floor is enforced by the schema", () => {
  test("300 ms is accepted (the minimum the design allows)", () => {
    expect(ok({ autoStopSilenceMs: 300 })).toBe(true);
  });

  test("299 ms is refused: inside the measured comma-pause range", () => {
    expect(ok({ autoStopSilenceMs: 299 })).toBe(false);
  });

  test("V0's 200 ms is refused", () => {
    expect(ok({ autoStopSilenceMs: 200 })).toBe(false);
  });

  test("a fractional value is refused (milliseconds are an integer count)", () => {
    expect(ok({ autoStopSilenceMs: 500.5 })).toBe(false);
  });
});

describe("T9: the other bounds", () => {
  test("the key must be a `ctrl+<letter>`", () => {
    expect(ok({ key: "ctrl+r" })).toBe(true);
    expect(ok({ key: "ctrl+rr" })).toBe(false);
    expect(ok({ key: "r" })).toBe(false);
    expect(ok({ key: "alt+r" })).toBe(false);
  });

  test("only the three languages and the two engines exist (no dead settings)", () => {
    expect(ok({ language: "auto" })).toBe(true);
    expect(ok({ language: "fr" })).toBe(false);
    expect(ok({ engine: "parakeet" })).toBe(true);
    expect(ok({ engine: "whisper" })).toBe(false);
  });

  test("maxSeconds has a floor of 10 (a shorter cap is a slip, not a setting)", () => {
    expect(ok({ maxSeconds: 10 })).toBe(true);
    expect(ok({ maxSeconds: 9 })).toBe(false);
  });
});

describe("T9: the block resolves through the config as a whole", () => {
  test("a profile may carry its own voice block", () => {
    const parsed = FileConfigSchema.safeParse({
      profiles: { dictation: { voice: { language: "en" } } },
    });
    expect(parsed.success).toBe(true);
  });
});

// docs/fix/tui-voice-off-despite-config: `TentacleConfig.voice` was DECLARED and
// `resolveConfig` did produce it, but `loadConfig` never projected it into the
// object it returns — so EVERY consumer (`main`'s three `startTui` sites, all
// reading `config.voice`) saw `undefined` and fell back to `VOICE_DEFAULTS`
// (`enabled: false`). Ctrl+R then said "voice is off" although the file said
// `"voice": { "enabled": true }`. The projection is the fixed property here; the
// TUI-level behaviour is pinned in `packages/cli/test/voice-tui-config.test.ts`.
describe("loadConfig PROJECTS the voice block (tui-voice-off-despite-config)", () => {
  const withConfig = async (
    text: string | null,
    run: (configDir: string) => Promise<void>,
  ): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "tentacle-voice-load-"));
    const configDir = join(dir, "cfg");
    try {
      if (text !== null) {
        await mkdir(configDir, { recursive: true });
        await writeFile(join(configDir, "config.jsonc"), text, "utf8");
      }
      await run(configDir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("the file's `voice` reaches `TentacleConfig.voice` — `enabled: true` included", async () => {
    // Mutation: drop the `...(resolved.voice !== undefined ? { voice: resolved.voice } : {})`
    // line from `loadConfig` → `cfg.voice` is undefined → red.
    await withConfig('{ "voice": { "enabled": true, "key": "ctrl+k" } }', async (configDir) => {
      const cfg = await loadConfig({ env: { HOME: tmpdir() }, configDir, scaffold: false });
      expect(cfg.voice).toEqual({ enabled: true, key: "ctrl+k" });
    });
  });

  test("a `voice` block without `enabled` keeps meaning OFF: the projection adds no default", async () => {
    // The defaults stay the TUI's job (`VOICE_DEFAULTS`): the config layer only
    // carries what the FILE said, exactly as it does for `tui`/`sessions`.
    await withConfig('{ "voice": { "key": "ctrl+k" } }', async (configDir) => {
      const cfg = await loadConfig({ env: { HOME: tmpdir() }, configDir, scaffold: false });
      expect(cfg.voice).toEqual({ key: "ctrl+k" });
    });
  });

  test("absent `voice` stays absent (the TUI's own defaults apply)", async () => {
    await withConfig(null, async (configDir) => {
      const cfg = await loadConfig({ env: { HOME: tmpdir() }, configDir, scaffold: false });
      expect("voice" in cfg).toBe(false);
    });
  });
});
