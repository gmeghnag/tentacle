/** `tools.outputRetentionDays` / `cacheDirFromEnv` (docs/fix/tool-output-location.md). */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { cacheDirFromEnv } from "../src/load.ts";
import { type ResolveContext, resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  fileConfig: {},
  env: {},
  defaultCwd: "/launch",
  ...over,
});

describe("tools.outputRetentionDays", () => {
  test("default 30, source default", () => {
    const c = resolveConfig(ctx());
    expect(c.toolOutputRetentionDays).toBe(30);
    expect(c.sources.toolOutputRetentionDays).toBe("default");
  });

  test("file value, then env beats file, source reported", () => {
    const fileConfig = FileConfigSchema.parse({ tools: { outputRetentionDays: 7 } });
    const f = resolveConfig(ctx({ fileConfig }));
    expect(f.toolOutputRetentionDays).toBe(7);
    expect(f.sources.toolOutputRetentionDays).toBe("file");
    const e = resolveConfig(ctx({ fileConfig, env: { TENTACLE_TOOL_OUTPUT_RETENTION_DAYS: "2" } }));
    expect(e.toolOutputRetentionDays).toBe(2);
    expect(e.sources.toolOutputRetentionDays).toBe("env");
  });

  test("0 and negative are accepted (owner 2026-11-05: never sweep), in file and env", () => {
    expect(FileConfigSchema.safeParse({ tools: { outputRetentionDays: -1 } }).success).toBe(true);
    expect(FileConfigSchema.safeParse({ tools: { outputRetentionDays: 0 } }).success).toBe(true);
    const neg = resolveConfig(ctx({ env: { TENTACLE_TOOL_OUTPUT_RETENTION_DAYS: "-1" } }));
    expect(neg.toolOutputRetentionDays).toBe(-1);
    const zero = resolveConfig(ctx({ env: { TENTACLE_TOOL_OUTPUT_RETENTION_DAYS: "0" } }));
    expect(zero.toolOutputRetentionDays).toBe(0);
  });

  test("a non-integer is refused in the file and ignored in the env", () => {
    expect(FileConfigSchema.safeParse({ tools: { outputRetentionDays: 1.5 } }).success).toBe(false);
    for (const bad of ["abc", "1.5", ""]) {
      const c = resolveConfig(ctx({ env: { TENTACLE_TOOL_OUTPUT_RETENTION_DAYS: bad } }));
      expect(c.toolOutputRetentionDays).toBe(30);
    }
  });

  test("the scaffolded template names the option", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('"outputRetentionDays": 30');
    expect(DEFAULT_CONFIG_JSONC).not.toContain(".tentacle/tool-output");
  });
});

describe("cacheDirFromEnv", () => {
  test("XDG_CACHE_HOME, else ~/.cache", () => {
    expect(cacheDirFromEnv({ XDG_CACHE_HOME: "/x/cache" }, "/home/u")).toBe("/x/cache/tentacle");
    expect(cacheDirFromEnv({}, "/home/u")).toBe(join("/home/u", ".cache", "tentacle"));
    expect(cacheDirFromEnv({ HOME: "/h" })).toBe(join("/h", ".cache", "tentacle"));
  });
});
