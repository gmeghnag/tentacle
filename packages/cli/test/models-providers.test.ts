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
import type { TentacleConfig } from "../src/config.ts";
import { laptopModels } from "../src/engine-runtime.ts";
import {
  createModelProviders,
  subagentModelResolver,
  tunnelSubagentResolver,
} from "../src/model-provider.ts";

describe("tunnelSubagentResolver: only a published name is ever asked for", () => {
  const published = {
    models: [
      { name: "claude", contextWindow: 200000 },
      { name: "fast", contextWindow: 32768 },
    ],
    types: [{ type: "explore", model: "fast" }],
    selectable: ["claude"],
  };
  const type = (over: Partial<AgentType>): AgentType =>
    ({ name: "general", description: "d", prompt: "p", tools: "all", ...over }) as AgentType;
  const tunnel = (name: string): ModelProvider =>
    ({ id: `tunnel:${name}`, stream: async function* () {} }) as ModelProvider;
  const resolve = tunnelSubagentResolver(published, tunnel);

  test("the type's name, with the published window; the hook gets the NAME, not a model id", () => {
    const chosen = resolve(type({ name: "explore" }), undefined);
    expect(chosen?.provider.id).toBe("tunnel:fast");
    expect(chosen?.contextWindow).toBe(32768);
    expect(chosen?.modelId).toBe("fast");
  });

  test("the call's selectable name beats the type's", () => {
    expect(resolve(type({ name: "explore" }), "claude")?.provider.id).toBe("tunnel:claude");
  });

  test("a call's name that is not selectable falls through to the type", () => {
    expect(resolve(type({ name: "explore" }), "fast")?.provider.id).toBe("tunnel:fast");
    expect(resolve(type({ name: "general" }), "fast")).toBeUndefined();
  });

  test("the pod's agents/*.md `model` never picks a published entry (owner Q3 b)", () => {
    expect(resolve(type({ model: "claude" }), undefined)).toBeUndefined();
    expect(resolve(type({ model: "fast", contextWindow: 5000 }), undefined)).toBeUndefined();
    // The laptop's own routes still win for the same type.
    expect(resolve(type({ name: "explore", model: "claude" }), undefined)?.provider.id).toBe(
      "tunnel:fast",
    );
  });

  test("a frontmatter model id is NEVER sent: the main tunnel, as before", () => {
    expect(resolve(type({ model: "gpt-evil" }), undefined)).toBeUndefined();
    expect(resolve(type({ model: "http://evil/v1" }), undefined)).toBeUndefined();
  });

  test("a type named like a prototype member matches nothing", () => {
    expect(resolve(type({ name: "constructor" }), undefined)).toBeUndefined();
    expect(resolve(type({ name: "__proto__" }), undefined)).toBeUndefined();
    expect(resolve(type({ model: "constructor" }), undefined)).toBeUndefined();
  });
});

describe("laptopModels: the allowlist a pod is served from", () => {
  const laptop = (over: Partial<TentacleConfig> = {}) =>
    ({ ...config, autoTitle: false, subagentMaxParallel: 3, ...over }) as unknown as TentacleConfig;
  const published = { subagentModels: { explore: "same" }, selectableModels: ["claude"] };

  test("nothing published: no namedModels at all", () => {
    const { namedModels } = laptopModels(
      laptop({ subagentModels: {}, selectableModels: [] }),
      spyFactory().create,
    );
    expect(namedModels).toBeUndefined();
  });

  test("a published entry resolves to ITS OWN provider, with its own key", () => {
    const f = spyFactory();
    const { namedModels } = laptopModels(laptop(published), f.create);
    const before = f.made.length;
    expect(typeof namedModels?.resolve("claude")).toBe("object");
    const built = f.made.slice(before);
    expect(built.map((m) => [m.baseURL, m.model, m.apiKey])).toEqual([
      ["https://api.anthropic.com/v1", "sonnet", ENTRY_KEY],
    ]);
  });

  test("an entry that exists but is not published is refused, and no provider is built for it", () => {
    const f = spyFactory();
    const { namedModels } = laptopModels(laptop(published), f.create);
    const before = f.made.length;
    expect(namedModels?.resolve("keyless")).toBeUndefined();
    expect(namedModels?.resolve("__proto__")).toBeUndefined();
    expect(namedModels?.resolve("constructor")).toBeUndefined();
    expect(namedModels?.resolve("main-model")).toBeUndefined();
    expect(f.made.length).toBe(before);
  });

  test("a published command-keyed entry with no key is unavailable: never an unauthenticated call", () => {
    const f = spyFactory();
    const noKey = {
      claude: entry({ apiKeySource: "command", apiKeyCommand: "x", baseURL: "http://c/v1" }),
      same: config.models.same,
    };
    const { namedModels } = laptopModels(laptop({ ...published, models: noKey }), f.create);
    const before = f.made.length;
    expect(namedModels?.resolve("claude")).toBe("unavailable");
    expect(f.made.length).toBe(before);
  });

  test("a published entry that legitimately has no key is served (a local server)", () => {
    const f = spyFactory();
    const { namedModels } = laptopModels(
      laptop({ subagentModels: {}, selectableModels: ["keyless"] }),
      f.create,
    );
    expect(typeof namedModels?.resolve("keyless")).toBe("object");
  });
});

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

  test("the child's NAME is carried only when it really runs a DIFFERENT model than the main agent", () => {
    // The owner's rule (docs/feat/subagent-panel.md, UI revision): the panel shows
    // a sub-agent's model only when it differs from the main agent's, so the wire
    // gets a name only then — and a name is a `models` NAME, never a model id.
    const resolve = subagentModelResolver(
      config,
      createModelProviders(config, spyFactory().create),
    );
    // `explore` is `same`, whose entry runs `small`; the main model is not it.
    expect(resolve(type({ name: "explore" }), undefined)?.name).toBe("same");
    expect(resolve(type({ name: "explore" }), "claude")?.name).toBe("claude");
    // An entry that resolves to the MAIN model's own id is the same model: no name.
    const sameConfig = {
      ...config,
      models: { ...config.models, same: entry({ model: "main-model", apiKey: MAIN_KEY }) },
    };
    const sameResolve = subagentModelResolver(
      sameConfig,
      createModelProviders(sameConfig, spyFactory().create),
    );
    const same = sameResolve(type({ name: "explore" }), undefined);
    expect(same).toBeDefined();
    expect(same?.name).toBeUndefined();
    // A frontmatter model id is not a `models` name (AGENTS §7): never carried.
    expect(resolve(type({ model: "raw-id" }), undefined)?.name).toBeUndefined();
    // No pick at all is the main model: nothing to name.
    expect(resolve(type({}), undefined)).toBeUndefined();
  });

  test("a `/model` switch re-decides it: the same child gains/loses its name", () => {
    // The daemon recomputes every `subagents` update, so "differs from the main
    // agent's CURRENT model" must be a function of the config it is given NOW —
    // not of something cached at launch. The `models` entry is `small`; the main
    // model is `main-model`, so the child differs…
    const before = subagentModelResolver(config, createModelProviders(config, spyFactory().create));
    expect(before(type({ name: "explore" }), undefined)?.name).toBe("same");
    // …and after the run's model BECOMES that entry's model, they are the same:
    const switched = { ...config, model: "small" };
    const after = subagentModelResolver(
      switched,
      createModelProviders(switched, spyFactory().create),
    );
    expect(after(type({ name: "explore" }), undefined)?.name).toBeUndefined();
  });
});
