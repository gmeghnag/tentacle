import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { loadConfig } from "../src/load.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `mount.hide` / `mount.hideExtra` (docs/feat/docker-workspace-mount.md, owner
// D-2): what a docker/podman workspace mount hides. `hide` REPLACES the CLI's
// default list, `hideExtra` ADDS to it; the CLI applies the list.
describe("mount.hide / mount.hideExtra", () => {
  test("lists of ~/ or absolute paths, in the file and in a profile; anything else is an error", () => {
    expect(
      FileConfigSchema.safeParse({ mount: { hide: ["~/.ssh"], hideExtra: ["/secrets/x"] } })
        .success,
    ).toBe(true);
    expect(
      FileConfigSchema.safeParse({ profiles: { p: { mount: { hideExtra: ["~/.pgpass"] } } } })
        .success,
    ).toBe(true);
    expect(FileConfigSchema.safeParse({ mount: { hide: "~/.ssh" } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ mount: { hide: ["relative/x"] } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ mount: { hide: [""] } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ mount: { hidden: [] } }).success).toBe(false);
  });

  test("resolved from the file; absent when unset", () => {
    const file = FileConfigSchema.parse({ mount: { hide: [], hideExtra: ["~/.pgpass"] } });
    expect(resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }).mount).toEqual({
      hide: [],
      hideExtra: ["~/.pgpass"],
    });
    expect("mount" in resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" })).toBe(false);
  });

  test("a profile merges per key: its hideExtra keeps the base hide", () => {
    const file = FileConfigSchema.parse({
      mount: { hide: ["~/.ssh"] },
      profiles: { p: { mount: { hideExtra: ["~/.pgpass"] } } },
    });
    const applied = applyProfile(file, "p");
    expect(applied.ok && applied.config.mount).toEqual({
      hide: ["~/.ssh"],
      hideExtra: ["~/.pgpass"],
    });
  });

  test("loadConfig exposes mount and the apiKeyCommand (not a secret: the CLI masks its file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mount-cfg-"));
    try {
      await writeFile(
        join(dir, "config.jsonc"),
        JSON.stringify({
          model: { apiKeyCommand: "echo k" },
          mount: { hideExtra: ["~/.pgpass"] },
        }),
      );
      const cfg = await loadConfig({ env: { HOME: dir }, configDir: dir, cwd: "/launch" });
      expect(cfg.mount).toEqual({ hideExtra: ["~/.pgpass"] });
      expect(cfg.apiKeyCommand).toBe("echo k");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the config template documents the keys", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('"hideExtra"');
  });
});
