import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_FILENAME, CONFIG_FILENAME, DEFAULT_SYSTEM_PROMPT } from "../src/defaults.ts";
import {
  ConfigError,
  type TentacleConfig,
  discoverSkills,
  loadConfig,
  refreshSessionContext,
} from "../src/load.ts";

let dir: string;
let configDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-refresh-"));
  configDir = join(dir, "cfg");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const env = (): Record<string, string | undefined> => ({ HOME: dir });

const writeSkill = async (root: string, name: string, description: string) => {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  );
};

const load = (): Promise<TentacleConfig> => loadConfig({ env: env(), configDir, cwd: dir });

describe("refreshSessionContext (docs/feat/context-reset-refresh.md)", () => {
  test("on an unchanged disk it returns exactly what loadConfig built", async () => {
    // The property a reset hinges on: start and reset compose the same prompt.
    await loadConfig({ env: env(), configDir, cwd: dir }); // scaffold
    await writeFile(join(configDir, "PROMPT.md"), "IDENTITY\n");
    await writeFile(join(dir, AGENTS_FILENAME), "RULES\n");
    await writeSkill(join(dir, ".agents", "skills"), "alpha", "first");
    await writeSkill(join(configDir, "skills"), "beta", "second");
    const cfg = await load();
    expect(cfg.systemPrompt).toContain("# Project rules (AGENTS.md)");
    expect(cfg.systemPrompt).toContain("<name>alpha</name>");

    const fresh = await refreshSessionContext(cfg, env());
    expect(fresh.systemPrompt).toBe(cfg.systemPrompt);
    expect(fresh.skills).toEqual(cfg.skills);
    expect(fresh.skillDiagnostics).toEqual(cfg.skillDiagnostics);
  });

  test("sees an edited PROMPT.md, an edited AGENTS.md and a new skill — in skills AND the catalog", async () => {
    await loadConfig({ env: env(), configDir, cwd: dir }); // scaffold
    await writeFile(join(configDir, "PROMPT.md"), "OLD IDENTITY\n");
    await writeFile(join(dir, AGENTS_FILENAME), "OLD RULES\n");
    await writeSkill(join(dir, ".agents", "skills"), "alpha", "first");
    const cfg = await load();

    await writeFile(join(configDir, "PROMPT.md"), "NEW IDENTITY\n");
    await writeFile(join(dir, AGENTS_FILENAME), "NEW RULES\n");
    await writeSkill(join(dir, ".agents", "skills"), "added-mid-session", "late");
    const fresh = await refreshSessionContext(cfg, env());

    expect(fresh.systemPrompt).toStartWith(
      "NEW IDENTITY\n\n# Project rules (AGENTS.md)\n\nNEW RULES\n",
    );
    expect(fresh.systemPrompt).not.toContain("OLD");
    expect(fresh.skills.map((s) => s.name).sort()).toEqual(["added-mid-session", "alpha"]);
    expect(fresh.systemPrompt).toContain("<name>added-mid-session</name>");
    // The loaded config is untouched (a refresh returns, it does not mutate).
    expect(cfg.skills.map((s) => s.name)).toEqual(["alpha"]);
  });

  test("a removed skill leaves the skills and the catalog", async () => {
    await writeSkill(join(dir, ".agents", "skills"), "gone", "soon");
    const cfg = await load();
    expect(cfg.skills.map((s) => s.name)).toEqual(["gone"]);
    await rm(join(dir, ".agents", "skills", "gone"), { recursive: true });
    const fresh = await refreshSessionContext(cfg, env());
    expect(fresh.skills).toEqual([]);
    expect(fresh.systemPrompt).not.toContain("# Skills");
  });

  test("finds a package skills/ dir created after the start", async () => {
    const pkg = join(configDir, "packages", "demo");
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "tentacle-package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", description: "demo" }),
    );
    const cfg = await load();
    expect(cfg.packages.map((p) => p.name)).toEqual(["demo"]);
    expect(cfg.skills).toEqual([]);

    await writeSkill(join(pkg, "skills"), "from-pkg", "packaged");
    const fresh = await refreshSessionContext(cfg, env());
    expect(fresh.skills.map((s) => [s.name, s.scope])).toEqual([["from-pkg", "user"]]);
    expect(fresh.systemPrompt).toContain("<name>from-pkg</name>");
  });

  test("settings stay as at the start: disabled AGENTS.md / skills stay off", async () => {
    await writeFile(join(dir, AGENTS_FILENAME), "RULES\n");
    await writeSkill(join(dir, ".agents", "skills"), "alpha", "first");
    const off = await loadConfig({
      env: { ...env(), TENTACLE_NO_AGENTS_MD: "1", TENTACLE_NO_SKILLS: "1" },
      configDir,
      cwd: dir,
    });
    expect(off.agentsMdEnabled).toBe(false);
    expect(off.skillsEnabled).toBe(false);
    // The refresh env does not carry the opt-outs: the kept decision rules.
    const fresh = await refreshSessionContext(off, env());
    expect(fresh.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(fresh.skills).toEqual([]);
    expect(fresh.skillDiagnostics).toEqual([]);
  });

  test("env TENTACLE_SYSTEM_PROMPT beats the prompt file, as at the start", async () => {
    await loadConfig({ env: env(), configDir, cwd: dir }); // scaffold
    await writeFile(join(configDir, "PROMPT.md"), "FILE\n");
    const e = { ...env(), TENTACLE_SYSTEM_PROMPT: "FROM ENV" };
    const cfg = await loadConfig({ env: e, configDir, cwd: dir });
    expect(cfg.systemPrompt).toBe("FROM ENV");
    expect((await refreshSessionContext(cfg, e)).systemPrompt).toBe("FROM ENV");
    expect((await refreshSessionContext(cfg, env())).systemPrompt).toBe("FILE\n");
  });

  test("a required systemPromptFile that is now missing throws; a defaulted one falls back", async () => {
    await loadConfig({ env: env(), configDir, cwd: dir }); // scaffold
    await writeFile(join(configDir, "WORK.md"), "work prompt");
    await writeFile(join(configDir, CONFIG_FILENAME), `{ "systemPromptFile": "WORK.md" }`);
    const required = await load();
    expect(required.promptFileRequired).toBe(true);
    await rm(join(configDir, "WORK.md"));
    await expect(refreshSessionContext(required, env())).rejects.toBeInstanceOf(ConfigError);

    await writeFile(join(configDir, CONFIG_FILENAME), "{}");
    const implicit = await load();
    expect(implicit.promptFileRequired).toBe(false);
    await rm(join(configDir, "PROMPT.md"));
    expect((await refreshSessionContext(implicit, env())).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe("discoverSkills", () => {
  test("disabled → nothing, no I/O (a missing cwd is not an error)", async () => {
    const found = await discoverSkills({
      launchCwd: join(dir, "does-not-exist"),
      home: dir,
      configDir,
      packageSkillRoots: [],
      enabled: false,
    });
    expect(found).toEqual({ skills: [], diagnostics: [] });
  });

  test("scans the roots in precedence order and reports shadowing", async () => {
    await writeSkill(join(dir, ".agents", "skills"), "dup", "home copy");
    await writeSkill(join(configDir, "skills"), "dup", "config copy");
    const found = await discoverSkills({
      launchCwd: dir,
      home: dir,
      configDir,
      packageSkillRoots: [],
      enabled: true,
    });
    expect(found.skills.map((s) => [s.name, s.description])).toEqual([["dup", "config copy"]]);
    expect(found.diagnostics.join("\n")).toContain('skill "dup"');
  });
});
