import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, DEFAULT_SYSTEM_PROMPT, PROMPT_FILENAME } from "../src/defaults.ts";
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
    expect(raw).toContain("agent-harness configuration");
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

  test("env variables override the file", async () => {
    await loadConfig({ env: baseEnv(), configDir, cwd: "/launch" });
    await writeFile(
      join(configDir, CONFIG_FILENAME),
      `{ "model": { "model": "file-model" } }`,
      "utf8",
    );
    const cfg = await loadConfig({
      env: { ...baseEnv(), HARNESS_MODEL: "env-model" },
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
      env: { ...baseEnv(), HARNESS_MODEL_API_KEY: "env-key" },
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
