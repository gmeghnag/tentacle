import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThemeSetting } from "@tentacle/tui";
import { connectTheme } from "../src/connect.ts";

/**
 * `connect` honours `tui.theme` (docs/feat/tui-light-theme.md S5).
 *
 * `connect` loads no model config — it reaches a daemon that has one — so the
 * palette comes from the config FILE alone, through the same parser `loadConfig`
 * uses. An invalid file must WARN and connect anyway: a typo must never block a
 * command whose whole point is needing no local configuration. That warning goes
 * through `write` (stderr), which is the pre-mount path — never a raw write while
 * Ink owns the terminal (AGENTS §7).
 */
async function withConfig<T>(text: string | null, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tentacle-connect-theme-"));
  try {
    if (text !== null) {
      await writeFile(join(dir, "config.jsonc"), text, "utf8");
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const read = (configDir: string, extra: { theme?: ThemeSetting } = {}) => {
  const written: string[] = [];
  return connectTheme({ url: "ws://127.0.0.1:9", configDir, ...extra }, (line) =>
    written.push(line),
  ).then((theme) => ({ theme, written }));
};

describe("the setting comes from the file", () => {
  test("`tui.theme: light` is read", async () => {
    // Mutation: never read the config → `auto`, and the TUI probes needlessly.
    await withConfig('{ "tui": { "theme": "light" } }', async (configDir) => {
      expect(await read(configDir)).toEqual({ theme: "light", written: [] });
    });
  });

  test("each of the three values round-trips", async () => {
    for (const theme of ["auto", "dark", "light"] as const) {
      await withConfig(`{ "tui": { "theme": "${theme}" } }`, async (configDir) => {
        expect((await read(configDir)).theme).toBe(theme);
      });
    }
  });

  test("a profile's theme applies, as `loadConfig` would apply it", async () => {
    await withConfig(
      '{ "tui": { "theme": "light" }, "profiles": { "p": { "tui": { "theme": "dark" } } } }',
      async (configDir) => {
        const prev = process.env.TENTACLE_PROFILE;
        process.env.TENTACLE_PROFILE = "p";
        try {
          expect((await read(configDir)).theme).toBe("dark");
        } finally {
          const key = "TENTACLE_PROFILE";
          if (prev === undefined) {
            delete (process.env as Record<string, string | undefined>)[key];
          } else {
            process.env.TENTACLE_PROFILE = prev;
          }
        }
      },
    );
  });

  test("no file at all: `auto`, nothing written, nothing scaffolded", async () => {
    await withConfig(null, async (configDir) => {
      expect(await read(configDir)).toEqual({ theme: "auto", written: [] });
      const { existsSync } = await import("node:fs");
      // Mutation: reuse `loadConfig` → it writes config.jsonc and PROMPT.md.
      expect(existsSync(join(configDir, "config.jsonc"))).toBe(false);
      expect(existsSync(join(configDir, "PROMPT.md"))).toBe(false);
    });
  });

  test("an explicit setting beats the file", async () => {
    await withConfig('{ "tui": { "theme": "light" } }', async (configDir) => {
      const result = await read(configDir, { theme: "dark" });
      expect(result).toEqual({ theme: "dark", written: [] });
    });
  });
});

describe("an invalid config warns and connects anyway", () => {
  test("one line naming the key, then `auto`", async () => {
    // Mutation: throw instead → connect refuses to start over a palette typo.
    await withConfig('{ "tui": { "theme": "sepia" } }', async (configDir) => {
      const { theme, written } = await read(configDir);
      expect(theme).toBe("auto");
      expect(written).toHaveLength(1);
      expect(written[0]).toContain("[config]");
      expect(written[0]).toContain("config.jsonc");
      expect(written[0]).toContain("tui.theme auto");
    });
  });

  test("broken JSON is named too, and still connects", async () => {
    await withConfig('{ "tui": ', async (configDir) => {
      const { theme, written } = await read(configDir);
      expect(theme).toBe("auto");
      expect(written.join("")).toContain("config.jsonc");
    });
  });
});
