import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `keep` (docs/feat/docker-engine-cli.md, owner 2026-10-27): whether `run`
// leaves the workload up on exit. Default true (absent here; the CLI applies it); the `--keep[=bool]` flag is
// layered on top by the CLI (`engine-select.ts`).
describe("keep", () => {
  test("a boolean is accepted in the file and in a profile; anything else is an error", () => {
    expect(FileConfigSchema.safeParse({ keep: true }).success).toBe(true);
    expect(FileConfigSchema.safeParse({ profiles: { p: { keep: false } } }).success).toBe(true);
    expect(FileConfigSchema.safeParse({ keep: "yes" }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ profiles: { p: { keep: 1 } } }).success).toBe(false);
  });

  test("resolved from the file; absent when unset (the CLI then defaults to false)", () => {
    const file = FileConfigSchema.parse({ keep: true });
    expect(resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }).keep).toBe(true);
    const plain = resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" });
    expect("keep" in plain).toBe(false);
  });

  test("a profile's keep beats the file's", () => {
    const file = FileConfigSchema.parse({ keep: true, profiles: { p: { keep: false } } });
    const applied = applyProfile(file, "p");
    expect(applied.ok && applied.config.keep).toBe(false);
    const base = applyProfile(file, undefined);
    expect(base.ok && base.config.keep).toBe(true);
  });

  test("the config template documents the key", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('// "keep": true,');
  });
});
