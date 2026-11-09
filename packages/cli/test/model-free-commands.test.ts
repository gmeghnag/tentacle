import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliMode, modeUsesModel } from "../src/flags.ts";
import { main } from "../src/index.ts";

// A key command runs only for the commands that call a model
// (docs/fix/key-commands-only-for-model-commands.md). `ps`/`rm`/`hooks`/`package`
// reach no provider, so one entry whose `apiKeyCommand` fails (`exit 7`, or one
// that wants a terminal) must not stop them. Mutation: drop the `podDaemon`
// spread for a model-free mode in `main` → the first describe goes red.

const NO_TERMINAL = { stdin: false, stdout: false };

/** A literal main key; the `models.bad` entry's command fails if it ever runs. */
const BAD_ENTRY = {
  model: {
    provider: "openai",
    baseURL: "http://127.0.0.1:1",
    model: "fake-model",
    apiKey: "sk-fake-main",
  },
  models: { bad: { model: "x", apiKeyCommand: "exit 7" } },
};

/** A main key that fails if it ever runs: only a model command may be stopped by it. */
const MAIN_FAILS = {
  model: {
    provider: "openai",
    baseURL: "http://127.0.0.1:1",
    model: "fake-model",
    apiKeyCommand: "exit 7",
  },
};

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-free-cmds-"));
  for (const key of [
    "TENTACLE_CONFIG_DIR",
    "TENTACLE_MODEL_API_KEY",
    "TENTACLE_MODEL_BASE_URL",
    "TENTACLE_MODEL",
    "TENTACLE_PROFILE",
  ]) {
    saved[key] = process.env[key];
  }
  // A scratch config dir (never the real ~/.config) and nothing off the env.
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  Reflect.deleteProperty(process.env, "TENTACLE_MODEL_API_KEY");
  Reflect.deleteProperty(process.env, "TENTACLE_MODEL_BASE_URL");
  Reflect.deleteProperty(process.env, "TENTACLE_MODEL");
  Reflect.deleteProperty(process.env, "TENTACLE_PROFILE");
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(config: unknown): Promise<void> {
  // Inside `TENTACLE_CONFIG_DIR` itself: a file beside it would never be read,
  // and the load would scaffold a default one — a vacuous test.
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(join(dir, "config", "config.jsonc"), JSON.stringify(config));
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["bun", "cli", ...args], {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    terminal: NO_TERMINAL,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("a model-free command never runs an apiKeyCommand", () => {
  test("ps lists (a failing models.<n> command does not stop it)", async () => {
    await writeConfig(BAD_ENTRY);
    const result = await run(["ps"]);
    expect(result.err).not.toContain("config error");
    expect(result.code).toBe(0);
    expect(result.out).toContain("NAME");
  });

  test("rm reaches its own logic (the name is what it complains about)", async () => {
    await writeConfig(BAD_ENTRY);
    const result = await run(["rm", "nosuch"]);
    expect(result.err).not.toContain("config error");
    expect(result.code).toBe(1);
    expect(result.err).toContain('no kept container or pod named "nosuch"');
  });

  test("hooks trust --list and package list work too", async () => {
    await writeConfig(BAD_ENTRY);
    const hooks = await run(["hooks", "trust", "--list"]);
    expect(hooks.err).not.toContain("config error");
    expect(hooks.code).toBe(0);
    const packages = await run(["package", "list"]);
    expect(packages.err).not.toContain("config error");
    expect(packages.code).toBe(0);
  });

  test("the MAIN apiKeyCommand does not stop ps either (the same skip)", async () => {
    await writeConfig(MAIN_FAILS);
    const result = await run(["ps"]);
    expect(result.err).not.toContain("config error");
    expect(result.code).toBe(0);
  });
});

describe("a command that calls a model keeps the strict load", () => {
  test("a one-shot prompt still refuses a failing models.<n> command", async () => {
    await writeConfig(BAD_ENTRY);
    const result = await run(["hello"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("models.bad.apiKeyCommand exited with code 7");
  });

  test("--plain still refuses a failing main command", async () => {
    await writeConfig(MAIN_FAILS);
    const plain = await run(["--plain"]);
    expect(plain.code).toBe(1);
    expect(plain.err).toContain("apiKeyCommand exited with code 7");
  });

  test("the TUI's own load is strict too (a failing models.<n> command)", async () => {
    await writeConfig(BAD_ENTRY);
    const tui = await run(["-i"]);
    expect(tui.err).toContain("models.bad.apiKeyCommand exited with code 7");
  });
});

describe("modeUsesModel classifies every mode", () => {
  // The table itself is exhaustive by TYPE (`Readonly<Record<CliMode, boolean>>`
  // in `flags.ts`): a new mode does not compile until it is classified. This
  // pins the answers, so changing one is a visible decision.
  const EXPECTED: Readonly<Record<string, boolean>> = {
    connect: false,
    update: false,
    explain: false,
    config: false,
    ps: false,
    rm: false,
    hooks: false,
    package: false,
    serve: true,
    run: true,
    attach: true,
    plain: true,
    tui: true,
    prompt: true,
    empty: true,
  };

  test("every mode, as decided", () => {
    for (const [mode, usesModel] of Object.entries(EXPECTED)) {
      expect({
        mode,
        usesModel: modeUsesModel(mode as Parameters<typeof modeUsesModel>[0]),
      }).toEqual({
        mode,
        usesModel,
      });
    }
  });

  test("the argv forms map to those modes", () => {
    expect(cliMode(["ps"])).toBe("ps");
    expect(cliMode(["rm", "x"])).toBe("rm");
    expect(cliMode(["hooks", "trust", "--list"])).toBe("hooks");
    expect(cliMode(["package", "list"])).toBe("package");
    expect(cliMode(["hello"])).toBe("prompt");
    expect(cliMode(["--plain"])).toBe("plain");
    expect(cliMode([])).toBe("empty");
    expect(modeUsesModel(cliMode(["hello"]))).toBe(true);
    expect(modeUsesModel(cliMode(["ps"]))).toBe(false);
  });
});
