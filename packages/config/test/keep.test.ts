import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `rm` (fix/run-rm-flag; was `keep`, docs/feat/docker-engine-cli.md): whether
// `run` removes the workload when the run ends. Default false (absent here; the
// CLI applies it); the `--rm[=bool]` flag is layered on top by the CLI (`engine-select.ts`).
describe("rm", () => {
  test("a boolean is accepted in the file and in a profile; anything else is an error", () => {
    expect(FileConfigSchema.safeParse({ rm: true }).success).toBe(true);
    expect(FileConfigSchema.safeParse({ profiles: { p: { rm: false } } }).success).toBe(true);
    expect(FileConfigSchema.safeParse({ rm: "yes" }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ profiles: { p: { rm: 1 } } }).success).toBe(false);
  });

  test("the old `keep` key is REJECTED, never silently ignored", () => {
    // Ignoring it would turn a user's `keep: false` (delete on exit) into "kept forever".
    expect(FileConfigSchema.safeParse({ keep: true }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ keep: false }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ profiles: { p: { keep: false } } }).success).toBe(false);
  });

  test("resolved from the file; absent when unset (the CLI then defaults to false)", () => {
    const file = FileConfigSchema.parse({ rm: true });
    expect(resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }).rm).toBe(true);
    const plain = resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" });
    expect("rm" in plain).toBe(false);
  });

  test("a profile's rm beats the file's", () => {
    const file = FileConfigSchema.parse({ rm: true, profiles: { p: { rm: false } } });
    const applied = applyProfile(file, "p");
    expect(applied.ok && applied.config.rm).toBe(false);
    const base = applyProfile(file, undefined);
    expect(base.ok && base.config.rm).toBe(true);
  });

  test("the config template documents the key, not the old one", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('// "rm": false,');
    expect(DEFAULT_CONFIG_JSONC).not.toContain('"keep"');
    expect(DEFAULT_CONFIG_JSONC).not.toContain("--keep");
  });
});

// `detach.keepAwake` (docs/feat/detached-relay-lifecycle.md DR-9): read by the
// relay itself, so it needs no spec field. Default on (absent here; the relay applies it).
describe("L26 detach.keepAwake", () => {
  test("a boolean in the file and in a profile; anything else is an error", () => {
    expect(FileConfigSchema.safeParse({ detach: { keepAwake: false } }).success).toBe(true);
    expect(
      FileConfigSchema.safeParse({ profiles: { p: { detach: { keepAwake: true } } } }).success,
    ).toBe(true);
    expect(FileConfigSchema.safeParse({ detach: { keepAwake: "no" } }).success).toBe(false);
  });

  test("resolved from the file; absent when unset; a profile's wins", () => {
    const file = FileConfigSchema.parse({
      detach: { keepAwake: true },
      profiles: { p: { detach: { keepAwake: false } } },
    });
    expect(resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }).detach).toEqual({
      keepAwake: true,
    });
    const plain = resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" });
    expect("detach" in plain).toBe(false);
    const applied = applyProfile(file, "p");
    expect(applied.ok && applied.config.detach).toEqual({ keepAwake: false });
  });

  test("the config template documents the key", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('// "detach": { "keepAwake": true },');
  });
});
