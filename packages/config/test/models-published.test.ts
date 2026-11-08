/**
 * What a laptop publishes to a pod (docs/feat/models-map-pod.md): the allowlist
 * and what travels. Names and numbers only.
 */
import { describe, expect, test } from "bun:test";
import {
  type ResolvedModel,
  pickSubagentModel,
  publishedModelNames,
  publishedModels,
} from "../src/models.ts";

const SECRET_KEY = "s3cret-entry";
const SECRET_URL = "http://only-laptop.example/v1";
const SECRET_ID = "secret-model-id";

const entry = (contextWindow: number, description?: string): ResolvedModel => ({
  provider: "openai",
  baseURL: SECRET_URL,
  model: SECRET_ID,
  contextWindow,
  apiKeySource: "file",
  apiKey: SECRET_KEY,
  ...(description !== undefined ? { description } : {}),
});

const models = {
  fast: entry(32768, "Quick."),
  claude: entry(200000, "Strong."),
  unused: entry(1000, "Never referenced."),
};

describe("publishedModelNames: the allowlist", () => {
  test("the union of the types' models and the selectable ones, sorted, de-duplicated", () => {
    expect(
      publishedModelNames({
        models,
        subagentModels: { explore: "fast", general: "fast" },
        selectableModels: ["claude", "fast"],
      }),
    ).toEqual(["claude", "fast"]);
  });

  test("an entry nothing references is NOT published", () => {
    expect(
      publishedModelNames({ models, subagentModels: { explore: "fast" }, selectableModels: [] }),
    ).toEqual(["fast"]);
  });

  test("a reference to no entry publishes nothing", () => {
    expect(
      publishedModelNames({
        models,
        subagentModels: { explore: "ghost" },
        selectableModels: ["__proto__", "constructor"],
      }),
    ).toEqual([]);
  });

  test("nothing referenced → empty", () => {
    expect(publishedModelNames({ models, subagentModels: {}, selectableModels: [] })).toEqual([]);
  });
});

describe("publishedModels: what travels", () => {
  test("names, windows, types, selectable: exactly", () => {
    expect(
      publishedModels({
        models,
        subagentModels: { general: "claude", explore: "fast" },
        selectableModels: ["fast"],
      }),
    ).toEqual({
      models: [
        { name: "claude", contextWindow: 200000 },
        { name: "fast", contextWindow: 32768, description: "Quick." },
      ],
      types: [
        { type: "explore", model: "fast" },
        { type: "general", model: "claude" },
      ],
      selectable: ["fast"],
    });
  });

  test("a description travels only for a selectable name", () => {
    const out = publishedModels({
      models,
      subagentModels: { explore: "claude" },
      selectableModels: [],
    });
    expect(out?.models).toEqual([{ name: "claude", contextWindow: 200000 }]);
  });

  test("no key, URL, model id or unpublished name: whatever the entry holds", () => {
    const text = JSON.stringify(
      publishedModels({
        models,
        subagentModels: { explore: "fast" },
        selectableModels: ["claude"],
      }),
    );
    expect(text).toContain("fast");
    for (const absent of [SECRET_KEY, SECRET_URL, SECRET_ID, "unused", "apiKey", "baseURL"]) {
      expect(text).not.toContain(absent);
    }
  });

  test("a type naming no entry does not travel", () => {
    expect(
      publishedModels({
        models,
        subagentModels: { explore: "ghost", general: "fast" },
        selectableModels: ["ghost"],
      }),
    ).toEqual({
      models: [{ name: "fast", contextWindow: 32768 }],
      types: [{ type: "general", model: "fast" }],
      selectable: [],
    });
  });

  test("the insertion order of the config does not change the JSON (a drift check compares it)", () => {
    const a = publishedModels({
      models,
      subagentModels: { explore: "fast", general: "claude" },
      selectableModels: [],
    });
    const b = publishedModels({
      models: { claude: models.claude, fast: models.fast },
      subagentModels: { general: "claude", explore: "fast" },
      selectableModels: [],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("nothing published → undefined: the key is left out", () => {
    expect(publishedModels({ models, subagentModels: {}, selectableModels: [] })).toBeUndefined();
  });
});

describe("the pick runs on published data too", () => {
  test("only `contextWindow` is needed of an entry", () => {
    expect(
      pickSubagentModel(
        { typeName: "explore" },
        {
          models: { fast: { contextWindow: 32768 } },
          subagentModels: { explore: "fast" },
          selectableModels: [],
        },
      ),
    ).toEqual({ kind: "entry", name: "fast", contextWindow: 32768 });
  });
});
