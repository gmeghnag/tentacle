import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `engine` (docs/feat/docker-engine-cli.md, owner C-Q1): the default engine of
// `run`/`attach` from the user config or a profile. The flag and
// `TENTACLE_ENGINE` are layered on top by the CLI (`engine-select.ts`).
describe("engine", () => {
  test("each engine is accepted in the file and in a profile", () => {
    for (const engine of ["kubernetes", "docker", "podman"]) {
      expect(FileConfigSchema.safeParse({ engine }).success).toBe(true);
      expect(FileConfigSchema.safeParse({ profiles: { p: { engine } } }).success).toBe(true);
    }
  });

  test("an unknown engine is a loud validation error", () => {
    expect(FileConfigSchema.safeParse({ engine: "lxc" }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ profiles: { p: { engine: "dokcer" } } }).success).toBe(
      false,
    );
  });

  test("resolved from the file; absent when unset (the CLI then defaults to kubernetes)", () => {
    const file = FileConfigSchema.parse({ engine: "podman" });
    expect(resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }).engine).toBe("podman");
    const plain = resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" });
    expect("engine" in plain).toBe(false);
  });

  test("a profile's engine beats the file's", () => {
    const file = FileConfigSchema.parse({
      engine: "docker",
      profiles: { k: { engine: "kubernetes" } },
    });
    const applied = applyProfile(file, "k");
    expect(applied.ok && applied.config.engine).toBe("kubernetes");
    const base = applyProfile(file, undefined);
    expect(base.ok && base.config.engine).toBe("docker");
  });

  test("the config template documents the key", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('// "engine": "kubernetes",');
  });
});
