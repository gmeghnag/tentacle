import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { loadConfig } from "../src/load.ts";
import { applyProfile } from "../src/profile.ts";
import { type ResolveContext, resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `contextAwareness` (docs/feat/context-awareness.md): a top-level, file-only
// setting — on by default, a 1% step.

const ctx = (fileConfig: ResolveContext["fileConfig"] = {}): ResolveContext => ({
  fileConfig,
  env: {},
  defaultCwd: "/launch",
});

describe("contextAwareness config", () => {
  test("defaults: enabled, a 1% step", () => {
    expect(resolveConfig(ctx()).contextAwareness).toEqual({ enabled: true, stepPercent: 1 });
  });

  test("file values, per key (an unset key keeps its default)", () => {
    expect(resolveConfig(ctx({ contextAwareness: { enabled: false } })).contextAwareness).toEqual({
      enabled: false,
      stepPercent: 1,
    });
    expect(resolveConfig(ctx({ contextAwareness: { stepPercent: 5 } })).contextAwareness).toEqual({
      enabled: true,
      stepPercent: 5,
    });
  });

  test("strict: a step outside 1..100, a fraction, or an unknown key is a schema error", () => {
    for (const bad of [
      { stepPercent: 0 },
      { stepPercent: 101 },
      { stepPercent: 1.5 },
      { enabled: "yes" },
      { step: 1 },
    ]) {
      expect({ bad, ok: FileConfigSchema.safeParse({ contextAwareness: bad }).success }).toEqual({
        bad,
        ok: false,
      });
    }
    expect(FileConfigSchema.safeParse({ contextAwareness: { stepPercent: 100 } }).success).toBe(
      true,
    );
  });

  test("a profile merges it per key, like subagents", () => {
    const file = FileConfigSchema.parse({
      contextAwareness: { enabled: false, stepPercent: 5 },
      profiles: { p: { contextAwareness: { stepPercent: 10 } } },
    });
    const applied = applyProfile(file, "p");
    expect(applied.ok ? applied.config.contextAwareness : applied.reason).toEqual({
      enabled: false,
      stepPercent: 10,
    });
  });

  test("the generated template documents it, commented out", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain(
      '// "contextAwareness": { "enabled": true, "stepPercent": 1 },',
    );
  });
});

describe("contextAwareness through loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reaches the loaded config", async () => {
    const configDir = join(dir, "cfg");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, CONFIG_FILENAME),
      JSON.stringify({ contextAwareness: { stepPercent: 2 } }),
    );
    const cfg = await loadConfig({ env: { HOME: dir }, configDir, cwd: "/launch" });
    expect(cfg.contextAwareness).toEqual({ enabled: true, stepPercent: 2 });
  });
});
