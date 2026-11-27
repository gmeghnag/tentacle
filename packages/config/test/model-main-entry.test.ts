/**
 * `--model <entry>` and the `/model` catalogue (docs/feat/model-switch.md T1):
 * an entry becomes the run's main model with ITS connection and key only — the
 * main key never reaches another endpoint. Scratch config dirs only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME } from "../src/defaults.ts";
import { loadConfig } from "../src/load.ts";
import { modelCatalogue, withMainEntry } from "../src/models.ts";

let dir: string;
let configDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-main-entry-"));
  configDir = join(dir, "cfg");
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MAIN_KEY = "s3cret-main";

const FILE = {
  model: {
    baseURL: "http://main/v1",
    model: "main-model",
    titleModel: "main-title",
    apiKey: MAIN_KEY,
    contextWindow: 100_000,
    maxTokens: 4000,
    images: true,
    maxImageBytes: 1000,
  },
  models: {
    haiku: {
      provider: "anthropic",
      baseURL: "http://haiku",
      model: "haiku-id",
      apiKey: "haiku-key",
      contextWindow: 20_000,
      maxTokens: 900,
      images: false,
      maxImageBytes: 500,
    },
    keyless: { baseURL: "http://local/v1", model: "qwen" },
    sibling: { model: "small-id" },
    windowed: { contextWindow: 5000 },
  },
};

const load = async (extra: { model?: string; modelEntry?: true } = {}) => {
  await writeFile(join(configDir, CONFIG_FILENAME), JSON.stringify(FILE), "utf8");
  return loadConfig({ env: { HOME: dir }, configDir, cwd: dir, ...extra });
};

describe("withMainEntry", () => {
  test("an entry with its own connection replaces the whole main model", async () => {
    const cfg = withMainEntry(await load(), "haiku");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.baseURL).toBe("http://haiku");
    expect(cfg.model).toBe("haiku-id");
    expect(cfg.apiKey).toBe("haiku-key");
    expect(cfg.contextWindow).toBe(20_000);
    expect(cfg.maxTokens).toBe(900);
    expect(cfg.images).toBe(false);
    expect(cfg.maxImageBytes).toBe(500);
    expect(cfg.mainEntry).toBe("haiku");
    expect("titleModel" in cfg).toBe(false);
  });

  test("the main key is REMOVED when the own-connection entry has none", async () => {
    const base = await load();
    expect(base.apiKey).toBe(MAIN_KEY);
    const cfg = withMainEntry(base, "keyless");
    expect(cfg.baseURL).toBe("http://local/v1");
    expect("apiKey" in cfg).toBe(false);
    expect("titleModel" in cfg).toBe(false);
  });

  test("an inherited entry keeps the main connection, key and title model", async () => {
    const cfg = withMainEntry(await load(), "sibling");
    expect(cfg.baseURL).toBe("http://main/v1");
    expect(cfg.apiKey).toBe(MAIN_KEY);
    expect(cfg.model).toBe("small-id");
    expect(cfg.titleModel).toBe("main-title");
    expect(cfg.contextWindow).toBe(100_000);
    expect(cfg.maxTokens).toBe(4000);
  });

  test("an unknown name throws", async () => {
    const base = await load();
    expect(() => withMainEntry(base, "nope")).toThrow(/nope/);
  });
});

describe("modelCatalogue", () => {
  test("names, ids and windows, sorted; never a URL or a key", async () => {
    const catalogue = modelCatalogue(await load());
    expect(catalogue).toEqual({
      start: { model: "main-model", contextWindow: 100_000 },
      entries: [
        { name: "haiku", model: "haiku-id", contextWindow: 20_000 },
        { name: "keyless", model: "qwen", contextWindow: 100_000 },
        { name: "sibling", model: "small-id", contextWindow: 100_000 },
        { name: "windowed", model: "main-model", contextWindow: 5000 },
      ],
    });
    expect(JSON.stringify(catalogue)).not.toMatch(/http|s3cret|haiku-key/);
  });

  test("a run started on an entry says so", async () => {
    const catalogue = modelCatalogue(withMainEntry(await load(), "haiku"));
    expect(catalogue.start).toEqual({ model: "haiku-id", contextWindow: 20_000, entry: "haiku" });
  });
});

describe("loadConfig modelEntry", () => {
  test("an entry name becomes the main model; inheriting entries are not re-pointed", async () => {
    const cfg = await load({ model: "haiku", modelEntry: true });
    expect(cfg.model).toBe("haiku-id");
    expect(cfg.baseURL).toBe("http://haiku");
    expect(cfg.apiKey).toBe("haiku-key");
    expect(cfg.mainEntry).toBe("haiku");
    expect(cfg.models.windowed?.model).toBe("main-model");
    expect(cfg.models.windowed?.apiKey).toBe(MAIN_KEY);
  });

  test("a non-entry --model keeps the id semantics", async () => {
    const cfg = await load({ model: "other-id", modelEntry: true });
    expect(cfg.model).toBe("other-id");
    expect(cfg.baseURL).toBe("http://main/v1");
    expect(cfg.mainEntry).toBeUndefined();
    expect(cfg.models.windowed?.model).toBe("other-id");
  });

  test("an Object.prototype name is an id, not an entry", async () => {
    const cfg = await load({ model: "toString", modelEntry: true });
    expect(cfg.model).toBe("toString");
    expect(cfg.mainEntry).toBeUndefined();
  });

  test("without modelEntry an entry name stays an id", async () => {
    const cfg = await load({ model: "haiku" });
    expect(cfg.model).toBe("haiku");
    expect(cfg.baseURL).toBe("http://main/v1");
    expect(cfg.mainEntry).toBeUndefined();
  });
});
