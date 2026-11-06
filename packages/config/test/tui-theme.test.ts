import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { readFileConfig } from "../src/load.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `tui.theme` (docs/feat/tui-light-theme.md): which palette the TUI paints —
// absent = `auto` (probe the terminal), applied by the TUI itself. LAPTOP-ONLY:
// a display setting, never carried to a pod (`carried-settings.ts` is keyed by
// `keyof SessionSettings`, so a key absent from the protocol cannot be added).
// Absent here means "the TUI decides", exactly as `rm` absent means "the CLI
// decides" — so `resolveConfig` leaves it out rather than inventing a default.
describe("tui.theme", () => {
  test("the three values are accepted in the file and in a profile; anything else is an error", () => {
    for (const theme of ["auto", "dark", "light"]) {
      expect(FileConfigSchema.safeParse({ tui: { theme } }).success).toBe(true);
      expect(FileConfigSchema.safeParse({ profiles: { p: { tui: { theme } } } }).success).toBe(
        true,
      );
    }
    expect(FileConfigSchema.safeParse({ tui: { theme: "sepia" } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tui: { theme: 1 } }).success).toBe(false);
    expect(
      FileConfigSchema.safeParse({ profiles: { p: { tui: { theme: "Dark" } } } }).success,
    ).toBe(false);
  });

  test("an unknown key under `tui` is refused, never silently ignored", () => {
    // A typo (`tui.colour`) that parsed would leave the user believing it applied.
    expect(FileConfigSchema.safeParse({ tui: { colour: "light" } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tui: "light" }).success).toBe(false);
  });

  test("resolved from the file; absent when unset (the TUI then probes)", () => {
    const file = FileConfigSchema.parse({ tui: { theme: "light" } });
    expect(resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }).tui).toEqual({
      theme: "light",
    });
    const plain = resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" });
    expect("tui" in plain).toBe(false);
  });

  test("a profile's theme beats the file's; the file's stands when the profile has none", () => {
    const file = FileConfigSchema.parse({
      tui: { theme: "dark" },
      profiles: { p: { tui: { theme: "light" } }, q: {}, r: { tui: {} } },
    });
    const p = applyProfile(file, "p");
    expect(p.ok && p.config.tui).toEqual({ theme: "light" });
    const q = applyProfile(file, "q");
    expect(q.ok && q.config.tui).toEqual({ theme: "dark" });
    // An empty `tui` block in a profile keeps the file's: the merge is per key.
    // Mutation: `config.tui = { ...tui }` (spread whole) → this is `{}`.
    const r = applyProfile(file, "r");
    expect(r.ok && r.config.tui).toEqual({ theme: "dark" });
    const base = applyProfile(file, undefined);
    expect(base.ok && base.config.tui).toEqual({ theme: "dark" });
  });

  test("the config template documents the key", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('// "tui": { "theme": "auto" },');
  });
});

// `readFileConfig` (docs/feat/tui-light-theme.md Q6): the `connect` path needs
// `tui.theme` and nothing else from the config, and must not scaffold, prompt or
// run a key command. One parser stays the source of truth (`loadConfig` calls it).
describe("readFileConfig", () => {
  const withDir = async (
    text: string | null,
    run: (dir: string) => Promise<void>,
  ): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "tentacle-readfileconfig-"));
    try {
      if (text !== null) {
        await writeFile(join(dir, "config.jsonc"), text, "utf8");
      }
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("reads the theme, with the profile applied", async () => {
    await withDir(
      '{ "tui": { "theme": "light" }, "profiles": { "p": { "tui": { "theme": "dark" } } } }',
      async (configDir) => {
        const plain = await readFileConfig({ configDir, env: {} });
        expect(plain.tui).toEqual({ theme: "light" });
        const profiled = await readFileConfig({ configDir, env: {}, profile: "p" });
        expect(profiled.tui).toEqual({ theme: "dark" });
      },
    );
  });

  test("a missing file is empty config, never scaffolded", async () => {
    const { existsSync } = await import("node:fs");
    await withDir(null, async (configDir) => {
      const config = await readFileConfig({ configDir, env: {} });
      expect(config.tui).toBeUndefined();
      // Mutation: reuse `loadConfig` → it writes config.jsonc and PROMPT.md here,
      // which would also make `connect` create a config the user never asked for.
      expect(existsSync(join(configDir, "config.jsonc"))).toBe(false);
      expect(existsSync(join(configDir, "PROMPT.md"))).toBe(false);
    });
  });

  test("a bad value is a ConfigError naming the file, not a silent default", async () => {
    await withDir('{ "tui": { "theme": "sepia" } }', async (configDir) => {
      await expect(readFileConfig({ configDir, env: {} })).rejects.toThrow(
        /Invalid .*config\.jsonc/,
      );
    });
  });

  test("malformed JSON is a ConfigError too", async () => {
    await withDir('{ "tui": { ', async (configDir) => {
      await expect(readFileConfig({ configDir, env: {} })).rejects.toThrow(/Failed to parse/);
    });
  });

  test("an unknown profile is refused, as `loadConfig` refuses it", async () => {
    await withDir('{ "tui": { "theme": "light" } }', async (configDir) => {
      await expect(readFileConfig({ configDir, env: {}, profile: "nope" })).rejects.toThrow(
        /unknown profile/,
      );
    });
  });
});
