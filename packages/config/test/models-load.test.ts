/**
 * `loadConfig` and the `models` entries' keys (docs/feat/models-map.md A5):
 * every distinct key command runs once, at load, never for a pod daemon; a
 * failure names the entry and never carries a key. Scratch config dirs only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME } from "../src/defaults.ts";
import { ConfigError, loadConfig } from "../src/load.ts";

let dir: string;
let configDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "models-load-"));
  configDir = join(dir, "cfg");
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (config: unknown) =>
  writeFile(join(configDir, CONFIG_FILENAME), JSON.stringify(config), "utf8");

const ENTRY_KEY = "s3cret-entry";
const MAIN_KEY = "s3cret-main";

function spyRunner(outputs: Record<string, string | Error>) {
  const calls: string[] = [];
  const run = async (command: string): Promise<string> => {
    calls.push(command);
    const out = outputs[command];
    if (out instanceof Error) {
      throw out;
    }
    return out ?? "";
  };
  return { calls, run };
}

const load = (run: (c: string) => Promise<string>, extra: { podDaemon?: boolean } = {}) =>
  loadConfig({ env: { HOME: dir }, configDir, cwd: dir, runCommand: run, ...extra });

describe("models: keys at load", () => {
  test("each distinct command runs once; inherited entries get the main command's key", async () => {
    await write({
      model: { apiKeyCommand: "main-cmd" },
      models: {
        same: { model: "small" },
        a: { baseURL: "http://a/v1", apiKeyCommand: "entry-cmd" },
        b: { baseURL: "http://b/v1", apiKeyCommand: "entry-cmd" },
        c: { baseURL: "http://c/v1", apiKeyCommand: "main-cmd" },
      },
    });
    const spy = spyRunner({ "main-cmd": `${MAIN_KEY}\n`, "entry-cmd": ` ${ENTRY_KEY} ` });
    const cfg = await load(spy.run);
    expect(spy.calls.sort()).toEqual(["entry-cmd", "main-cmd"]);
    expect(cfg.models.same?.apiKey).toBe(MAIN_KEY);
    expect(cfg.models.a?.apiKey).toBe(ENTRY_KEY);
    expect(cfg.models.b?.apiKey).toBe(ENTRY_KEY);
    expect(cfg.models.c?.apiKey).toBe(MAIN_KEY);
    expect(cfg.models.a?.apiKeyCommand).toBe("entry-cmd");
  });

  test("a pod daemon load runs no entry command", async () => {
    await write({ models: { a: { baseURL: "http://a/v1", apiKeyCommand: "entry-cmd" } } });
    const spy = spyRunner({ "entry-cmd": ENTRY_KEY });
    const cfg = await load(spy.run, { podDaemon: true });
    expect(spy.calls).toEqual([]);
    expect(cfg.models.a?.apiKey).toBeUndefined();
  });

  test("a failing command names the entry, never a key", async () => {
    await write({
      model: { apiKey: MAIN_KEY },
      models: { zeta: { apiKeyCommand: "bad" }, alpha: { apiKeyCommand: "bad" } },
    });
    const spy = spyRunner({ bad: new ConfigError("apiKeyCommand exited with code 1: denied") });
    const error = await load(spy.run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe("models.alpha.apiKeyCommand exited with code 1: denied");
    expect((error as Error).message).not.toContain(MAIN_KEY);
    expect(spy.calls).toEqual(["bad"]);
  });

  test("an empty key is an error naming the entry", async () => {
    await write({ models: { a: { apiKeyCommand: "empty" } } });
    const error = await load(spyRunner({ empty: "  \n" }).run).catch((e: unknown) => e);
    expect((error as Error).message).toBe("models.a.apiKeyCommand produced an empty key");
  });

  test("selectableModels and types reach the loaded config", async () => {
    await write({
      models: { fast: { model: "f" } },
      subagents: { types: { explore: { model: "fast" } }, selectableModels: ["fast"] },
    });
    const cfg = await load(spyRunner({}).run);
    expect(cfg.subagentModels).toEqual({ explore: "fast" });
    expect(cfg.selectableModels).toEqual(["fast"]);
    expect(cfg.models.fast?.model).toBe("f");
  });

  test("an unknown name refuses the config, naming the file and the key", async () => {
    await write({ subagents: { types: { explore: { model: "nope" } } } });
    const error = await load(spyRunner({}).run).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `Invalid ${join(configDir, CONFIG_FILENAME)}: subagents.types.explore.model: "nope" is not a models entry (no models defined)`,
    );
  });
});
