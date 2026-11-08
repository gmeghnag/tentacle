/**
 * The providers of a session's sub-agents (docs/feat/models-map.md A8): a
 * `models` entry's provider gets the ENTRY's endpoint and key only, built once;
 * a frontmatter model id rides the main endpoint; the resolver maps the pick.
 */
import { describe, expect, test } from "bun:test";
import type { AgentType } from "@tentacle/agent";
import type { ResolvedModel } from "@tentacle/config";
import type { ModelProvider } from "@tentacle/core";
import type { CreateModelProviderOptions } from "@tentacle/providers";
import { createModelProviders, subagentModelResolver } from "../src/model-provider.ts";

const MAIN_KEY = "s3cret-main";
const ENTRY_KEY = "s3cret-entry";

const entry = (over: Partial<ResolvedModel>): ResolvedModel => ({
  provider: "openai",
  baseURL: "http://main:8080/v1",
  model: "m",
  contextWindow: 1000,
  apiKeySource: "inherited",
  ...over,
});

const config = {
  provider: "openai" as const,
  baseURL: "http://main:8080/v1",
  model: "main-model",
  apiKey: MAIN_KEY,
  maxTokens: 4096,
  configDir: "/nonexistent",
  models: {
    same: entry({ model: "small", apiKey: MAIN_KEY, contextWindow: 32000 }),
    claude: entry({
      provider: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      model: "sonnet",
      apiKeySource: "command",
      apiKey: ENTRY_KEY,
      contextWindow: 200000,
    }),
    keyless: entry({ baseURL: "http://other:9/v1", model: "x", apiKeySource: "none" }),
  },
  subagentModels: { explore: "same" },
  selectableModels: ["claude"],
};

function spyFactory() {
  const made: CreateModelProviderOptions[] = [];
  const create = (options: CreateModelProviderOptions): ModelProvider => {
    made.push(options);
    return { id: `p${made.length}`, stream: async function* () {} } as ModelProvider;
  };
  return { made, create };
}

const strip = (o: CreateModelProviderOptions) => {
  const { onRetry: _r, ...rest } = o;
  return rest;
};

describe("createModelProviders", () => {
  test("an entry's provider gets the entry's endpoint and key, never the main key", () => {
    const s = spyFactory();
    const providers = createModelProviders(config, s.create);
    providers.forEntry("claude");
    providers.forEntry("keyless");
    expect(s.made.map(strip)).toEqual([
      {
        provider: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        model: "sonnet",
        apiKey: ENTRY_KEY,
      },
      { provider: "openai", baseURL: "http://other:9/v1", model: "x" },
    ]);
    expect(JSON.stringify(s.made.map(strip))).not.toContain(MAIN_KEY);
  });

  test("built once per name, and once per frontmatter id on the MAIN endpoint", () => {
    const s = spyFactory();
    const providers = createModelProviders(config, s.create);
    expect(providers.forEntry("same")).toBe(providers.forEntry("same"));
    expect(providers.forId("raw")).toBe(providers.forId("raw"));
    expect(s.made.map(strip)).toEqual([
      { provider: "openai", baseURL: "http://main:8080/v1", model: "small", apiKey: MAIN_KEY },
      {
        provider: "openai",
        baseURL: "http://main:8080/v1",
        model: "raw",
        apiKey: MAIN_KEY,
        maxTokens: 4096,
      },
    ]);
  });

  test("an unknown name throws (validated at load, so a bug if reached)", () => {
    expect(() => createModelProviders(config, spyFactory().create).forEntry("nope")).toThrow(
      'no models entry "nope"',
    );
  });
});

describe("subagentModelResolver", () => {
  const type = (over: Partial<AgentType>): AgentType => ({
    name: "general",
    description: "",
    prompt: "",
    tools: "all",
    ...over,
  });

  test("maps the pick: default → undefined, entry → its provider/window/id, id → main endpoint", () => {
    const s = spyFactory();
    const resolve = subagentModelResolver(config, createModelProviders(config, s.create));
    expect(resolve(type({}), undefined)).toBeUndefined();
    const explore = resolve(type({ name: "explore" }), undefined);
    expect([explore?.contextWindow, explore?.modelId]).toEqual([32000, "small"]);
    const picked = resolve(type({ name: "explore" }), "claude");
    expect([picked?.contextWindow, picked?.modelId]).toEqual([200000, "sonnet"]);
    const raw = resolve(type({ name: "rev", model: "raw-id", contextWindow: 7 }), undefined);
    expect([raw?.contextWindow, raw?.modelId]).toEqual([7, "raw-id"]);
    expect(s.made.map((m) => m.model)).toEqual(["small", "sonnet", "raw-id"]);
  });
});
