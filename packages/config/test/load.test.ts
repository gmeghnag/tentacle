import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS_FILENAME,
  CONFIG_FILENAME,
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_FILENAME,
} from "../src/defaults.ts";
import { ConfigError, loadConfig } from "../src/load.ts";

let dir: string;
let configDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-config-"));
  configDir = join(dir, "cfg");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const baseEnv = (): Record<string, string | undefined> => ({ HOME: dir });

describe("loadConfig scaffolding", () => {
  test("creates config.jsonc and PROMPT.md on first run", async () => {
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: "/launch" });

    expect(cfg.configDir).toBe(configDir);
    const prompt = await readFile(join(configDir, PROMPT_FILENAME), "utf8");
    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT);
    const raw = await readFile(join(configDir, CONFIG_FILENAME), "utf8");
    expect(raw).toContain("tentacle configuration");
    // With everything commented out, resolved values are the defaults.
    expect(cfg.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(cfg.cwd).toBe("/launch");
    expect(cfg.sources.apiKey).toBe("none");
  });

  test("does not touch the filesystem when scaffold is disabled", async () => {
    const cfg = await loadConfig({ env: baseEnv(), configDir, scaffold: false, cwd: "/launch" });
    expect(cfg.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    await expect(readFile(join(configDir, CONFIG_FILENAME), "utf8")).rejects.toThrow();
  });
});

describe("loadConfig reading", () => {
  test("reads a JSONC file with comments and a custom PROMPT.md", async () => {
    await loadConfig({ env: baseEnv(), configDir, cwd: "/launch" }); // scaffold
    await writeFile(
      join(configDir, CONFIG_FILENAME),
      `{
        // a comment
        "model": { "model": "qwen3", "baseURL": "http://host:8080/v1" },
        "maxIterations": 7,
      }`,
      "utf8",
    );
    await writeFile(join(configDir, PROMPT_FILENAME), "custom prompt", "utf8");

    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: "/launch" });
    expect(cfg.model).toBe("qwen3");
    expect(cfg.baseURL).toBe("http://host:8080/v1");
    expect(cfg.maxIterations).toBe(7);
    expect(cfg.systemPrompt).toBe("custom prompt");
  });

  test("carries the model provider kind through (file and env)", async () => {
    await loadConfig({ env: baseEnv(), configDir, cwd: "/launch" }); // scaffold
    await writeFile(
      join(configDir, CONFIG_FILENAME),
      `{ "model": { "provider": "anthropic", "model": "claude-x" } }`,
      "utf8",
    );
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: "/launch" });
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.sources.provider).toBe("file");

    // env wins over the file.
    const envWins = await loadConfig({
      env: { ...baseEnv(), TENTACLE_PROVIDER: "openai" },
      configDir,
      cwd: "/launch",
    });
    expect(envWins.provider).toBe("openai");
    expect(envWins.sources.provider).toBe("env");
  });

  test("env variables override the file", async () => {
    await loadConfig({ env: baseEnv(), configDir, cwd: "/launch" });
    await writeFile(
      join(configDir, CONFIG_FILENAME),
      `{ "model": { "model": "file-model" } }`,
      "utf8",
    );
    const cfg = await loadConfig({
      env: { ...baseEnv(), TENTACLE_MODEL: "env-model" },
      configDir,
      cwd: "/launch",
    });
    expect(cfg.model).toBe("env-model");
    expect(cfg.sources.model).toBe("env");
  });

  test("rejects an unknown key (strict schema)", async () => {
    await writeFile(join(dir, "bad.jsonc"), "", "utf8");
    const cd = join(dir, "strict");
    await loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" });
    await writeFile(join(cd, CONFIG_FILENAME), `{ "modle": "typo" }`, "utf8");
    await expect(loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" })).rejects.toThrow(
      ConfigError,
    );
  });

  test("rejects the removed `cwd` key with a hint (top level and in a profile)", async () => {
    for (const body of [`{ "cwd": "/x" }`, `{ "profiles": { "p": { "cwd": "/x" } } }`]) {
      const cd = await mkdtemp(join(dir, "cwd-"));
      await loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" });
      await writeFile(join(cd, CONFIG_FILENAME), body, "utf8");
      await expect(loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" })).rejects.toThrow(
        /`cwd` was removed/,
      );
    }
  });

  test("TENTACLE_CWD is ignored: tools run in the launch directory", async () => {
    const cfg = await loadConfig({
      env: { ...baseEnv(), TENTACLE_CWD: join(dir, "elsewhere") },
      configDir: join(dir, "envcwd"),
      cwd: "/launch",
    });
    expect(cfg.cwd).toBe("/launch");
  });

  test("reports a JSONC parse error", async () => {
    const cd = join(dir, "broken");
    await loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" });
    await writeFile(join(cd, CONFIG_FILENAME), `{ "model": { `, "utf8");
    await expect(loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" })).rejects.toThrow(
      /Failed to parse/,
    );
  });
});

describe("loadConfig API key", () => {
  test("runs apiKeyCommand and trims the result", async () => {
    const cd = join(dir, "key");
    await loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" });
    await writeFile(
      join(cd, CONFIG_FILENAME),
      `{ "model": { "apiKeyCommand": "print-key" } }`,
      "utf8",
    );
    const calls: string[] = [];
    const cfg = await loadConfig({
      env: baseEnv(),
      configDir: cd,
      cwd: "/launch",
      runCommand: async (command) => {
        calls.push(command);
        return "secret-123\n";
      },
    });
    expect(calls).toEqual(["print-key"]);
    expect(cfg.apiKey).toBe("secret-123");
    expect(cfg.sources.apiKey).toBe("command");
  });

  test("env key wins and the command is never run", async () => {
    const cd = join(dir, "key2");
    await loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" });
    await writeFile(
      join(cd, CONFIG_FILENAME),
      `{ "model": { "apiKeyCommand": "print-key" } }`,
      "utf8",
    );
    let ran = false;
    const cfg = await loadConfig({
      env: { ...baseEnv(), TENTACLE_MODEL_API_KEY: "env-key" },
      configDir: cd,
      cwd: "/launch",
      runCommand: async () => {
        ran = true;
        return "should-not-run";
      },
    });
    expect(cfg.apiKey).toBe("env-key");
    expect(ran).toBe(false);
  });

  test("throws when apiKeyCommand yields an empty key", async () => {
    const cd = join(dir, "key3");
    await loadConfig({ env: baseEnv(), configDir: cd, cwd: "/launch" });
    await writeFile(
      join(cd, CONFIG_FILENAME),
      `{ "model": { "apiKeyCommand": "print-key" } }`,
      "utf8",
    );
    await expect(
      loadConfig({
        env: baseEnv(),
        configDir: cd,
        cwd: "/launch",
        runCommand: async () => "   \n",
      }),
    ).rejects.toThrow(/empty key/);
  });
});

describe("loadConfig AGENTS.md auto-load", () => {
  // A fake repo under the temp HOME: `.git` at the root bounds the walk, the
  // workspace is a nested subdir, AGENTS.md (when present) sits at the root.
  async function makeRepo(opts: { agents?: string }): Promise<string> {
    const repo = join(dir, "repo");
    const work = join(repo, "a", "b");
    await mkdir(work, { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    if (opts.agents !== undefined) {
      await writeFile(join(repo, AGENTS_FILENAME), opts.agents, "utf8");
    }
    return work;
  }

  test("appends a repo AGENTS.md found by walking up from the workspace", async () => {
    const work = await makeRepo({ agents: "REPO RULES" });
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: work });
    expect(cfg.systemPrompt).toBe(
      `${DEFAULT_SYSTEM_PROMPT.trimEnd()}\n\n# Project rules (AGENTS.md)\n\nREPO RULES\n`,
    );
    expect(cfg.agentsPath).toBe(join(dir, "repo", AGENTS_FILENAME));
  });

  test("no AGENTS.md in the tree → prompt unchanged, no agentsPath", async () => {
    const work = await makeRepo({});
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: work });
    expect(cfg.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(cfg.agentsPath).toBeUndefined();
  });

  test("TENTACLE_NO_AGENTS_MD disables the auto-load", async () => {
    const work = await makeRepo({ agents: "REPO RULES" });
    const cfg = await loadConfig({
      env: { ...baseEnv(), TENTACLE_NO_AGENTS_MD: "1" },
      configDir,
      cwd: work,
    });
    expect(cfg.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(cfg.agentsPath).toBeUndefined();
  });

  test("the walk stops at the repo root (.git) — a parent AGENTS.md is NOT read", async () => {
    await writeFile(join(dir, AGENTS_FILENAME), "OUTSIDE THE REPO", "utf8");
    const work = await makeRepo({}); // repo has .git but no AGENTS.md of its own
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: work });
    expect(cfg.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(cfg.agentsPath).toBeUndefined();
  });

  test("a present-but-unreadable AGENTS.md degrades to the base prompt — never crashes", async () => {
    const repo = join(dir, "repo");
    const work = join(repo, "a", "b");
    await mkdir(work, { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    // AGENTS.md exists (so the walk finds it) but is a directory → readFile
    // throws EISDIR → the best-effort read must swallow it and fall back.
    await mkdir(join(repo, AGENTS_FILENAME), { recursive: true });
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: work });
    expect(cfg.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(cfg.agentsPath).toBeUndefined();
  });
});

describe("loadConfig profiles (docs/feat/config-profiles.md)", () => {
  const writeProfiles = async (): Promise<void> => {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, CONFIG_FILENAME),
      `{
        // the base
        "model": { "baseURL": "http://localhost:8080/v1", "model": "base-model", "apiKeyCommand": "base-cmd" },
        "profiles": {
          "work": { "model": { "provider": "anthropic", "model": "work-model", "apiKeyCommand": "work-cmd" } },
          "fast": { "model": { "model": "fast-model" } }
        }
      }`,
      "utf8",
    );
  };

  test("--profile (option) applies the profile; only the profile's key command runs", async () => {
    // Mutation: ignore `options.profile` → base-model, base-cmd.
    await writeProfiles();
    const ran: string[] = [];
    const cfg = await loadConfig({
      env: baseEnv(),
      configDir,
      cwd: dir,
      profile: "work",
      runCommand: async (command) => {
        ran.push(command);
        return "k";
      },
    });
    expect(cfg.model).toBe("work-model");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.baseURL).toBe("https://api.anthropic.com/v1");
    expect(cfg.profile).toBe("work");
    expect(ran).toEqual(["work-cmd"]);
  });

  test("TENTACLE_PROFILE selects it; the option beats the env; an empty env is unset", async () => {
    await writeProfiles();
    const run = async (): Promise<string> => "k";
    const viaEnv = await loadConfig({
      env: { ...baseEnv(), TENTACLE_PROFILE: "fast" },
      configDir,
      cwd: dir,
      runCommand: run,
    });
    expect(viaEnv.model).toBe("fast-model");
    expect(viaEnv.profile).toBe("fast");
    const both = await loadConfig({
      env: { ...baseEnv(), TENTACLE_PROFILE: "fast" },
      configDir,
      cwd: dir,
      profile: "work",
      runCommand: run,
    });
    expect(both.model).toBe("work-model");
    const empty = await loadConfig({
      env: { ...baseEnv(), TENTACLE_PROFILE: "" },
      configDir,
      cwd: dir,
      runCommand: run,
    });
    expect(empty.model).toBe("base-model");
    expect(empty.profile).toBeUndefined();
  });

  test("env still beats the profile", async () => {
    await writeProfiles();
    const cfg = await loadConfig({
      env: { ...baseEnv(), TENTACLE_MODEL: "env-model" },
      configDir,
      cwd: dir,
      profile: "fast",
      runCommand: async () => "k",
    });
    expect(cfg.model).toBe("env-model");
  });

  test("an unknown profile is a ConfigError naming the file and the defined profiles; nothing runs", async () => {
    await writeProfiles();
    const ran: string[] = [];
    const attempt = loadConfig({
      env: baseEnv(),
      configDir,
      cwd: dir,
      profile: "nope",
      runCommand: async (command) => {
        ran.push(command);
        return "k";
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toThrow('unknown profile "nope" (defined: work, fast)');
    await expect(attempt).rejects.toThrow(join(configDir, CONFIG_FILENAME));
    expect(ran).toEqual([]);
  });

  test("a profile's systemPromptFile resolves against the config dir", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "WORK.md"), "work prompt", "utf8");
    await writeFile(
      join(configDir, CONFIG_FILENAME),
      `{ "profiles": { "w": { "systemPromptFile": "WORK.md" } } }`,
      "utf8",
    );
    const cfg = await loadConfig({
      env: { ...baseEnv(), TENTACLE_NO_AGENTS_MD: "1" },
      configDir,
      cwd: dir,
      profile: "w",
    });
    expect(cfg.systemPrompt).toBe("work prompt");
    expect(cfg.promptPath).toBe(join(configDir, "WORK.md"));
  });
});

describe("loadConfig skills discovery", () => {
  const writeSkill = async (root: string, dirName: string, frontmatter: string, body = "body") => {
    await mkdir(join(root, dirName), { recursive: true });
    await writeFile(join(root, dirName, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
  };

  test("project (every level up to the .git root) > config dir > ~/.agents; shadowing reported", async () => {
    const repo = join(dir, "work", "repo");
    const sub = join(repo, "pkg");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(sub, { recursive: true });
    // Above the repo root: must NOT be scanned (the walk stops at .git).
    await writeSkill(join(dir, "work", ".agents", "skills"), "outside", "description: o");
    await writeSkill(join(sub, ".agents", "skills"), "dup", "name: dup\ndescription: nearest");
    await writeSkill(join(repo, ".agents", "skills"), "dup", "name: dup\ndescription: repo root");
    await writeSkill(
      join(repo, ".agents", "skills"),
      "root-only",
      "name: root-only\ndescription: r",
    );
    await writeSkill(join(configDir, "skills"), "cfg", "name: cfg\ndescription: c");
    await writeSkill(join(dir, ".agents", "skills"), "cfg", "name: cfg\ndescription: home copy");
    await writeSkill(join(dir, ".agents", "skills"), "home", "name: home\ndescription: h");

    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: sub });
    expect(cfg.skills.map((s) => [s.name, s.description, s.scope])).toEqual([
      ["dup", "nearest", "project"],
      ["root-only", "r", "project"],
      ["cfg", "c", "user"],
      ["home", "h", "user"],
    ]);
    expect(cfg.skillDiagnostics).toEqual([
      `skill "dup" at ${join(repo, ".agents/skills/dup/SKILL.md")} is shadowed by ${join(sub, ".agents/skills/dup/SKILL.md")}`,
      `skill "cfg" at ${join(dir, ".agents/skills/cfg/SKILL.md")} is shadowed by ${join(configDir, "skills/cfg/SKILL.md")}`,
    ]);
    // Catalog after the identity, in precedence order.
    expect(cfg.systemPrompt.startsWith(DEFAULT_SYSTEM_PROMPT.trimEnd())).toBe(true);
    expect(cfg.systemPrompt).toContain("<name>dup</name>\n<description>nearest</description>");
    expect(cfg.systemPrompt).not.toContain("outside");
  });

  test("no .git: the walk stops BEFORE home, so ~/.agents/skills is user scope, not project", async () => {
    const work = join(dir, "notes");
    await mkdir(work, { recursive: true });
    await writeSkill(join(dir, ".agents", "skills"), "home", "name: home\ndescription: h");
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: work });
    expect(cfg.skills.map((s) => [s.name, s.scope])).toEqual([["home", "user"]]);
    expect(cfg.skillDiagnostics).toEqual([]);
  });

  test("the catalog goes after AGENTS.md", async () => {
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, AGENTS_FILENAME), "repo rules");
    await writeSkill(join(repo, ".agents", "skills"), "a", "name: a\ndescription: d");
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: repo });
    const rules = cfg.systemPrompt.indexOf("repo rules");
    const skills = cfg.systemPrompt.indexOf("# Skills");
    expect(rules).toBeGreaterThan(0);
    expect(skills).toBeGreaterThan(rules);
  });

  test("no skills → prompt byte-identical to the no-skills prompt", async () => {
    await writeFile(join(dir, "p.md"), "identity");
    const env = { ...baseEnv(), TENTACLE_SYSTEM_PROMPT: "identity\n" };
    const cfg = await loadConfig({ env, configDir, cwd: dir });
    expect(cfg.systemPrompt).toBe("identity\n");
    expect(cfg.skills).toEqual([]);
  });

  test("off switch: file `loadSkills: false`, env TENTACLE_NO_SKILLS (env wins both ways)", async () => {
    await writeSkill(join(dir, ".agents", "skills"), "home", "name: home\ndescription: h");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, CONFIG_FILENAME), `{ "loadSkills": false }`);
    const off = await loadConfig({ env: baseEnv(), configDir, cwd: dir });
    expect(off.skills).toEqual([]);
    expect(off.systemPrompt).not.toContain("# Skills");
    const forcedOn = await loadConfig({
      env: { ...baseEnv(), TENTACLE_NO_SKILLS: "0" },
      configDir,
      cwd: dir,
    });
    expect(forcedOn.skills.map((s) => s.name)).toEqual(["home"]);
    await writeFile(join(configDir, CONFIG_FILENAME), "{}");
    const envOff = await loadConfig({
      env: { ...baseEnv(), TENTACLE_NO_SKILLS: "1" },
      configDir,
      cwd: dir,
    });
    expect(envOff.skills).toEqual([]);
  });

  test("broken skills are skipped with a diagnostic; hidden ones load but are not cataloged", async () => {
    const root = join(dir, ".agents", "skills");
    await writeSkill(root, "bad-yaml", "name: [x\ndescription: d");
    await writeSkill(root, "no-desc", "name: no-desc");
    await writeSkill(
      root,
      "hidden",
      "name: hidden\ndescription: h\ndisable-model-invocation: true",
    );
    await mkdir(join(root, "not-a-skill"), { recursive: true }); // no SKILL.md: silent
    await writeFile(join(root, "stray.txt"), "x"); // a file, not a dir: silent
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: dir });
    expect(cfg.skills.map((s) => [s.name, s.modelInvocable])).toEqual([["hidden", false]]);
    expect(cfg.systemPrompt).not.toContain("# Skills");
    expect(cfg.skillDiagnostics.length).toBe(2);
    expect(cfg.skillDiagnostics[0]).toContain("bad-yaml/SKILL.md: unparseable frontmatter");
    expect(cfg.skillDiagnostics[1]).toContain("no-desc/SKILL.md: no description");
  });

  test("bundled files: relative, sorted, no dot-entries / node_modules / SKILL.md, bounded", async () => {
    const root = join(dir, ".agents", "skills");
    await writeSkill(root, "tool", "name: tool\ndescription: d");
    const sd = join(root, "tool");
    await mkdir(join(sd, "scripts"), { recursive: true });
    await mkdir(join(sd, "node_modules", "x"), { recursive: true });
    await writeFile(join(sd, "scripts", "run.sh"), "x");
    await writeFile(join(sd, "references.md"), "x");
    await writeFile(join(sd, ".manifest.json"), "x");
    await writeFile(join(sd, "node_modules", "x", "i.js"), "x");
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: dir });
    expect(cfg.skills[0]?.files).toEqual(["references.md", "scripts/run.sh"]);
    expect(cfg.skills[0]?.filesTruncated).toBe(false);
    expect(cfg.skills[0]?.dir).toBe(sd);

    const big = join(root, "big");
    await writeSkill(root, "big", "name: big\ndescription: d");
    await mkdir(join(big, "a", "b", "c", "d", "e"), { recursive: true });
    await writeFile(join(big, "a", "b", "c", "d", "e", "deep.txt"), "x");
    for (let i = 0; i < 60; i++) {
      await writeFile(join(big, `f${String(i).padStart(2, "0")}.txt`), "x");
    }
    const cfg2 = await loadConfig({ env: baseEnv(), configDir, cwd: dir });
    const b = cfg2.skills.find((s) => s.name === "big");
    expect(b?.files.length).toBe(50);
    expect(b?.filesTruncated).toBe(true);
    expect(b?.files.some((f) => f.endsWith("deep.txt"))).toBe(false);
  });

  test("a symlinked skill directory is followed", async () => {
    const real = join(dir, "elsewhere", "linked");
    await writeSkill(join(dir, "elsewhere"), "linked", "name: linked\ndescription: d");
    await mkdir(join(dir, ".agents", "skills"), { recursive: true });
    await symlink(real, join(dir, ".agents", "skills", "linked"));
    const cfg = await loadConfig({ env: baseEnv(), configDir, cwd: dir });
    expect(cfg.skills.map((s) => s.name)).toEqual(["linked"]);
  });
});
