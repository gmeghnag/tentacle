import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { loadConfig } from "../src/load.ts";
import { applyProfile } from "../src/profile.ts";
import { type ResolveContext, resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `tools.writableDirs` (docs/feat/write-tmpdir.md): where `fs_write`/`fs_edit`
// may write besides the project. The list REPLACES the default temp dirs;
// `[]` = project only. Env `TENTACLE_WRITABLE_DIRS` (`:`-separated, "" = []).
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  fileConfig: {},
  env: {},
  defaultCwd: "/launch",
  ...over,
});

describe("tools.writableDirs", () => {
  test("default: the system temp dir (TMPDIR, trailing slash trimmed) and /tmp, de-duplicated", () => {
    const c = resolveConfig(ctx({ env: { TMPDIR: "/var/folders/xy/T/" } }));
    expect(c.writableDirs).toEqual(["/var/folders/xy/T", "/tmp"]);
    expect(c.sources.writableDirs).toBe("default");
    expect(resolveConfig(ctx()).writableDirs).toEqual(["/tmp"]);
    expect(resolveConfig(ctx({ env: { TMPDIR: "/tmp/" } })).writableDirs).toEqual(["/tmp"]);
  });

  test("[] in the file = project only (the default does NOT come back)", () => {
    const fileConfig = FileConfigSchema.parse({ tools: { writableDirs: [] } });
    const c = resolveConfig(ctx({ fileConfig, env: { TMPDIR: "/t" } }));
    expect(c.writableDirs).toEqual([]);
    expect(c.sources.writableDirs).toBe("file");
  });

  test("a list REPLACES the default (temp dirs only if listed)", () => {
    const fileConfig = FileConfigSchema.parse({ tools: { writableDirs: ["~/scratch", "/data"] } });
    expect(resolveConfig(ctx({ fileConfig, env: { TMPDIR: "/t" } })).writableDirs).toEqual([
      "~/scratch",
      "/data",
    ]);
  });

  test("env wins: ':'-separated; empty = []; a relative entry is dropped", () => {
    const fileConfig = FileConfigSchema.parse({ tools: { writableDirs: ["/data"] } });
    const env = { TENTACLE_WRITABLE_DIRS: "/a:~/b" };
    const c = resolveConfig(ctx({ fileConfig, env }));
    expect(c.writableDirs).toEqual(["/a", "~/b"]);
    expect(c.sources.writableDirs).toBe("env");
    expect(
      resolveConfig(ctx({ fileConfig, env: { TENTACLE_WRITABLE_DIRS: "" } })).writableDirs,
    ).toEqual([]);
    expect(
      resolveConfig(ctx({ env: { TENTACLE_WRITABLE_DIRS: "rel:/ok::" } })).writableDirs,
    ).toEqual(["/ok"]);
  });

  test("the schema takes ~, ~/… and absolute entries; a relative or empty one is an error", () => {
    expect(
      FileConfigSchema.safeParse({ tools: { writableDirs: ["~", "~/x", "/tmp"] } }).success,
    ).toBe(true);
    expect(FileConfigSchema.safeParse({ tools: { writableDirs: ["tmp"] } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tools: { writableDirs: ["./x"] } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tools: { writableDirs: [""] } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tools: { writableDirs: "/tmp" } }).success).toBe(false);
  });

  test("a profile's list replaces the base list", () => {
    const file = FileConfigSchema.parse({
      tools: { writableDirs: ["/base"] },
      profiles: { p: { tools: { writableDirs: [] } } },
    });
    const applied = applyProfile(file, "p");
    expect(applied.ok && applied.config.tools?.writableDirs).toEqual([]);
  });

  test("loadConfig expands ~ with the injected HOME and exposes the list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writable-cfg-"));
    try {
      await writeFile(
        join(dir, "config.jsonc"),
        JSON.stringify({ tools: { writableDirs: ["~", "~/scratch", "/data"] } }),
      );
      const cfg = await loadConfig({ env: { HOME: dir }, configDir: dir, cwd: "/launch" });
      expect(cfg.writableDirs).toEqual([dir, join(dir, "scratch"), "/data"]);
      const viaEnv = await loadConfig({
        env: { HOME: dir, TENTACLE_WRITABLE_DIRS: "~/e" },
        configDir: dir,
        cwd: "/launch",
      });
      expect(viaEnv.writableDirs).toEqual([join(dir, "e")]);
      const dflt = await loadConfig({
        env: { HOME: dir, TMPDIR: "/some/tmp" },
        configDir: join(dir, "none"),
        cwd: "/launch",
      });
      expect(dflt.writableDirs).toEqual(["/some/tmp", "/tmp"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the config template documents the key", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('"writableDirs"');
    expect(DEFAULT_CONFIG_JSONC).toContain("TENTACLE_WRITABLE_DIRS");
  });
});
