import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/load.ts";
import {
  type PackageInfo,
  longToolNameWarnings,
  mergePackageContributions,
  parsePackageManifest,
  scanPackages,
} from "../src/packages.ts";

function tree(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "packages-")));
}

function write(path: string, body: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;

/** A full package `<configDir>/packages/<name>` contributing all four kinds. */
function fullPackage(configDir: string, name: string): string {
  const dir = join(configDir, "packages", name);
  write(join(dir, "tentacle-package.json"), { name, version: "1.0.0", description: "demo" });
  write(join(dir, "skills", "review", "SKILL.md"), skill("review", "from package"));
  write(join(dir, "agents", "scout.md"), "---\ndescription: pkg scout\n---\nscout");
  write(join(dir, "mcp.json"), { docs: { command: "docs-server" } });
  write(join(dir, "hooks.json"), { hooks: [{ event: "turn_end", command: "./notify.sh" }] });
  return dir;
}

describe("parsePackageManifest", () => {
  test("accepts a valid manifest", () => {
    expect(parsePackageManifest('{"name":"kube-tools","version":"1.2.0"}')).toEqual({
      name: "kube-tools",
      version: "1.2.0",
    });
  });

  test.each([
    ["../evil", "path traversal"],
    ["a/b", "a slash"],
    ["Upper", "upper case"],
    ["-lead", "a leading dash"],
    ["x".repeat(33), "too long"],
  ])("rejects name %p (%s)", (name) => {
    expect(parsePackageManifest(JSON.stringify({ name }))).toHaveProperty("error");
  });

  test("rejects an unknown key and bad JSON", () => {
    expect(parsePackageManifest('{"name":"a","main":"x.js"}')).toHaveProperty("error");
    expect(parsePackageManifest("{nope")).toHaveProperty("error");
  });
});

describe("scanPackages", () => {
  test("a full package loads all four kinds, hooks tagged with their source", async () => {
    const cfg = tree();
    const dir = fullPackage(cfg, "demo");
    const { packages, diagnostics } = await scanPackages(cfg);
    expect(diagnostics).toEqual([]);
    expect(packages).toEqual([
      {
        name: "demo",
        version: "1.0.0",
        description: "demo",
        dir,
        skillsDir: join(dir, "skills"),
        agentsDir: join(dir, "agents"),
        mcpServers: { docs: { type: "stdio", command: "docs-server" } },
        hooks: [{ event: "turn_end", command: "./notify.sh", source: "demo" }],
      },
    ]);
  });

  test("a disabled package is skipped; dot-dirs (.tmp-*) are ignored", async () => {
    const cfg = tree();
    fullPackage(cfg, "a");
    fullPackage(cfg, "b");
    mkdirSync(join(cfg, "packages", ".tmp-123", "pkg"), { recursive: true });
    const { packages, diagnostics } = await scanPackages(cfg, { a: false });
    expect(packages.map((p) => p.name)).toEqual(["b"]);
    expect(diagnostics).toEqual([]);
  });

  test("a malformed package is a diagnostic and the others still load", async () => {
    const cfg = tree();
    write(join(cfg, "packages", "bad", "tentacle-package.json"), "{nope");
    write(join(cfg, "packages", "nomani", "skills", "x", "SKILL.md"), skill("x", "y"));
    fullPackage(cfg, "good");
    const badMcp = fullPackage(cfg, "badmcp");
    write(join(badMcp, "mcp.json"), { "Bad/Name": { command: "x" } });
    const badHooks = fullPackage(cfg, "badhooks");
    write(join(badHooks, "hooks.json"), { hooks: [{ event: "nope", command: "x" }] });
    const { packages, diagnostics } = await scanPackages(cfg);
    expect(packages.map((p) => p.name)).toEqual(["good"]);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.join("\n")).toContain(
      "package bad: skipped (tentacle-package.json: not valid JSON",
    );
    expect(diagnostics.join("\n")).toContain("package nomani: skipped (no tentacle-package.json)");
    expect(diagnostics.join("\n")).toContain("package badmcp: skipped (mcp.json: Bad/Name:");
    expect(diagnostics.join("\n")).toContain("package badhooks: skipped (hooks.json:");
  });

  test("a manifest name that differs from its directory is rejected", async () => {
    const cfg = tree();
    write(join(cfg, "packages", "alpha", "tentacle-package.json"), { name: "beta" });
    const { packages, diagnostics } = await scanPackages(cfg);
    expect(packages).toEqual([]);
    expect(diagnostics[0]).toContain('name "beta" ≠ directory "alpha"');
  });

  test("no packages dir → nothing, no diagnostic", async () => {
    expect(await scanPackages(tree())).toEqual({ packages: [], diagnostics: [] });
  });
});

const pkg = (name: string, extra: Partial<PackageInfo> = {}): PackageInfo => ({
  name,
  dir: `/p/${name}`,
  mcpServers: {},
  hooks: [],
  ...extra,
});

describe("mergePackageContributions", () => {
  test("MCP keys are namespaced <pkg>-<server>", () => {
    const merged = mergePackageContributions(
      {},
      [],
      [pkg("kube", { mcpServers: { docs: { type: "stdio" as const, command: "d" } } })],
    );
    expect(merged.mcpServers).toEqual({ "kube-docs": { type: "stdio" as const, command: "d" } });
    expect(merged.diagnostics).toEqual([]);
  });

  test("a user server with the same key wins, with a diagnostic", () => {
    const merged = mergePackageContributions(
      { "kube-docs": { type: "stdio" as const, command: "mine" } },
      [],
      [pkg("kube", { mcpServers: { docs: { type: "stdio" as const, command: "theirs" } } })],
    );
    expect(merged.mcpServers).toEqual({ "kube-docs": { type: "stdio" as const, command: "mine" } });
    expect(merged.diagnostics).toEqual([
      'package kube: MCP server "kube-docs" ignored (already defined by your config)',
    ]);
  });

  test("two packages producing the same key: the first (by name) wins, with a diagnostic", () => {
    const merged = mergePackageContributions(
      {},
      [],
      [
        pkg("a-b", { mcpServers: { c: { type: "stdio" as const, command: "first" } } }),
        pkg("a", { mcpServers: { "b-c": { type: "stdio" as const, command: "second" } } }),
      ],
    );
    expect(merged.mcpServers).toEqual({ "a-b-c": { type: "stdio" as const, command: "first" } });
    expect(merged.diagnostics).toEqual([
      'package a: MCP server "a-b-c" ignored (already defined by package a-b)',
    ]);
  });

  test("package hooks come after the user's, in package order", () => {
    const user = { event: "turn_end" as const, command: "mine" };
    const h = (source: string) => ({ event: "turn_end" as const, command: source, source });
    const merged = mergePackageContributions(
      {},
      [user],
      [pkg("a", { hooks: [h("a")] }), pkg("b", { hooks: [h("b")] })],
    );
    expect(merged.hooks).toEqual([user, h("a"), h("b")]);
  });
});

describe("loadConfig with packages", () => {
  test("wires skills, MCP, hooks and agent dirs; the `packages` key disables one", async () => {
    const home = tree();
    const cfg = join(home, "cfg");
    const dir = fullPackage(cfg, "demo");
    fullPackage(cfg, "off");
    write(join(cfg, "config.jsonc"), {
      hooks: [{ event: "turn_start", command: "mine" }],
      packages: { off: false },
    });
    const config = await loadConfig({ env: { HOME: home }, configDir: cfg, cwd: home });
    expect(Object.keys(config.mcpServers)).toEqual(["demo-docs"]);
    expect(config.hooks.map((h) => h.command)).toEqual(["mine", "./notify.sh"]);
    expect(config.packageAgentDirs).toEqual([join(dir, "agents")]);
    expect(config.packages.map((p) => p.name)).toEqual(["demo"]);
    expect(config.skills.map((s) => [s.name, s.scope, s.dir])).toEqual([
      ["review", "user", join(dir, "skills", "review")],
    ]);
    expect(config.packageDiagnostics).toEqual([]);
  });

  test("skill precedence: the user's own skill beats a package's (diagnostic names both)", async () => {
    const home = tree();
    const cfg = join(home, "cfg");
    fullPackage(cfg, "demo");
    write(join(home, ".agents", "skills", "review", "SKILL.md"), skill("review", "mine"));
    const config = await loadConfig({ env: { HOME: home }, configDir: cfg, cwd: home });
    expect(config.skills.map((s) => [s.name, s.description])).toEqual([["review", "mine"]]);
    expect(config.skillDiagnostics.join("\n")).toContain(join(cfg, "packages", "demo"));
  });

  test("a profile can switch packages off", async () => {
    const home = tree();
    const cfg = join(home, "cfg");
    fullPackage(cfg, "demo");
    write(join(cfg, "config.jsonc"), { profiles: { lean: { packages: { demo: false } } } });
    const config = await loadConfig({
      env: { HOME: home },
      configDir: cfg,
      cwd: home,
      profile: "lean",
    });
    expect(config.packages).toEqual([]);
    expect(config.mcpServers).toEqual({});
  });
});

describe("longToolNameWarnings", () => {
  test("warns only for names over 64 characters", () => {
    const ok = `mcp__${"a".repeat(59)}`; // 64
    const long = `mcp__${"a".repeat(60)}`; // 65
    expect(longToolNameWarnings([ok, long])).toEqual([
      `tool "${long}" is 65 characters; some providers reject names over 64`,
    ]);
  });
});

describe("loadPackage symlinks (post-review)", () => {
  test("a symlink escaping the package skips it; an internal one is fine", async () => {
    const home = tree();
    const cfg = join(home, "cfg");
    write(join(home, "outside", "h.json"), { hooks: [] });
    const evil = fullPackage(cfg, "evil");
    symlinkSync(join(home, "outside", "h.json"), join(evil, "hooks.json.x"));
    const dangling = fullPackage(cfg, "dangling");
    symlinkSync("../../nowhere", join(dangling, "skills", "gone"));
    const ok = fullPackage(cfg, "ok");
    symlinkSync("review", join(ok, "skills", "alias"));
    const { packages, diagnostics } = await scanPackages(cfg);
    expect(packages.map((p) => p.name)).toEqual(["ok"]);
    expect(diagnostics).toEqual([
      "package dangling: skipped (skills/gone points outside the package)",
      "package evil: skipped (hooks.json.x points outside the package)",
    ]);
  });
});
