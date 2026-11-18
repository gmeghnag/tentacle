import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_DEFAULTS } from "@tentacle/tui";
import { main } from "../src/index.ts";

/**
 * docs/fix/tui-voice-off-despite-config: the OWNER's path, end to end.
 *
 * A plain `tentacle` in a folder (no `run`, no `attach`, no `connect`) starts the
 * local TUI through the worker runtime. The config file said
 * `"voice": { "enabled": true }` and `tentacle config list` showed it, yet Ctrl+R
 * answered "voice is off". Cause: `loadConfig` dropped the `voice` block on the
 * floor (`TentacleConfig.voice` declared, never assigned), so every `main` call
 * site read `config.voice === undefined` and `App` fell back to `VOICE_DEFAULTS`
 * (`enabled: false`).
 *
 * This drives the REAL `main` and captures the options it hands to its
 * `startTui` seam — the exact object the TUI reads `voice` from. No worker, no
 * Ink, no microphone.
 */

const savedEnv: Record<string, string | undefined> = {};

async function withConfig<T>(
  text: string | null,
  run: (env: { configDir: string; home: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tentacle-voice-tui-"));
  const configDir = join(dir, "cfg");
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  try {
    if (text !== null) {
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.jsonc"), text, "utf8");
    }
    for (const key of ["TENTACLE_CONFIG_DIR", "HOME"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.TENTACLE_CONFIG_DIR = configDir;
    process.env.HOME = home;
    return await run({ configDir, home });
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const unsubscribe = (): void => {};

/** Just enough `LocalRuntime` for the TUI's mount and teardown. */
const stubRuntime = {
  createSession: () => ({ sessionId: null }),
  jobs: { onStart: () => unsubscribe, onExit: () => unsubscribe, onUpdate: () => unsubscribe },
  link: { onLinkStatus: unsubscribe },
  mcpStatus: async () => [],
  dispose: async () => {},
  release: async () => {},
  attachTo: async () => false,
  unflushedExits: () => 0,
  announce: () => {},
};

afterEach(() => {
  // `main`'s data stream is stdout: nothing may reach it outside Ink (AGENTS §7).
  expect(strayStdout.splice(0)).toEqual([]);
});
const strayStdout: string[] = [];

/** A bare `tentacle` on a terminal: the local TUI path, with both seams faked. */
async function localTuiOptions(args: string[] = []): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  const err: string[] = [];
  const code = await main(["bun", "cli", ...args], {
    out: (t) => strayStdout.push(t),
    err: (t) => err.push(t),
    terminal: { stdin: true, stdout: true },
    startTui: (async (_agent: unknown, options: Record<string, unknown>) => {
      seen.push(options);
    }) as never,
    startWorkerRuntime: (async () => stubRuntime as never) as never,
  });
  if (code !== 0) {
    throw new Error(`main exited ${code}: ${err.join("")}`);
  }
  return seen;
}

describe("tui-voice-off-despite-config: the local TUI gets the file's `voice` block", () => {
  test("`voice.enabled: true` in the file reaches `startTui` — Ctrl+R is not 'off'", async () => {
    // Mutation: drop the `voice` projection in `loadConfig` (or `config.voice`
    // from the `startTui` options) → `enabled` is false → red.
    await withConfig('{ "voice": { "enabled": true } }', async () => {
      const options = await localTuiOptions();
      expect(options).toHaveLength(1);
      const voice = options[0]?.voice as typeof VOICE_DEFAULTS | undefined;
      expect(voice?.enabled).toBe(true);
    });
  });

  test("the settings beside `enabled` survive too (key/language/engine)", async () => {
    await withConfig(
      '{ "voice": { "enabled": true, "key": "ctrl+k", "language": "it", "engine": "parakeet" } }',
      async () => {
        const options = await localTuiOptions();
        const voice = options[0]?.voice as typeof VOICE_DEFAULTS | undefined;
        expect(voice?.key).toBe("ctrl+k");
        expect(voice?.language).toBe("it");
        expect(voice?.engine).toBe("parakeet");
        // Everything the file leaves out still comes from `VOICE_DEFAULTS`.
        expect(voice?.maxSeconds).toBe(VOICE_DEFAULTS.maxSeconds);
      },
    );
  });

  test("no config file at all: the defaults, and voice stays OFF (the opt-in is unchanged)", async () => {
    await withConfig(null, async () => {
      const options = await localTuiOptions();
      expect(options[0]?.voice).toEqual(VOICE_DEFAULTS);
      expect((options[0]?.voice as typeof VOICE_DEFAULTS).enabled).toBe(false);
    });
  });

  test("the config dir reaches the TUI (the helper's log/bin live under it)", async () => {
    await withConfig('{ "voice": { "enabled": true } }', async ({ configDir }) => {
      const options = await localTuiOptions();
      expect(options[0]?.voiceConfigDir).toBe(configDir);
    });
  });
});

/**
 * The SAME dropped projection had a second, louder symptom: `tentacle voice
 * status` — the command a user runs exactly when dictation does not work — read
 * `config.voice` too (main.ts:961) and so reported "voice: disabled" for a file
 * that said `"enabled": true`. Pinned here because it is the same plumbing, and
 * because `voice-cmd.test.ts` injects the config and cannot see it.
 */
describe("tui-voice-off-despite-config: `voice status` agrees with the file", () => {
  test("a file with `enabled: true` reports enabled, not 'set it in the config'", async () => {
    // Mutation: drop the `voice` projection in `loadConfig` → the line becomes
    // `voice: disabled — set "voice": { "enabled": true } …` → red.
    await withConfig('{ "voice": { "enabled": true } }', async () => {
      const out: string[] = [];
      await main(["bun", "cli", "voice", "status"], {
        out: (t) => out.push(t),
        err: () => {},
        terminal: { stdin: false, stdout: false },
      });
      const said = out.join("");
      expect(said).toContain("voice: enabled");
      // The helper binary is absent in a test: that error is expected and is not
      // what this asserts.
      expect(said).not.toContain("voice: disabled");
    });
  });
});
