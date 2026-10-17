import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
