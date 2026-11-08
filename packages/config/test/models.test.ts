/**
 * The `models` map (docs/feat/models-map.md): the schema, the reference check,
 * the profile merge, an entry's resolution over the main model, and the pick of
 * a sub-agent's model. Pure: no I/O.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_BASE_URL } from "../src/defaults.ts";
import {
  type MainModel,
  type ResolvedModel,
  modelRefIssues,
  modelsPodNotice,
  pickSubagentModel,
  resolveModelEntry,
  unknownTypeModelWarnings,
} from "../src/models.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

const main: MainModel = {
  provider: "openai",
  baseURL: "http://main:8080/v1",
  model: "main-model",
  contextWindow: 131072,
  maxTokens: 4096,
  apiKey: "main-key",
};

const firstIssue = (value: unknown): string | undefined => {
  const parsed = FileConfigSchema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
};

describe("schema", () => {
  test("models, subagents.types and subagents.selectableModels are accepted", () => {
    expect(
      FileConfigSchema.safeParse({
        models: { fast: { model: "qwen3-4b", description: "Quick." } },
        subagents: { types: { explore: { model: "fast" } }, selectableModels: ["fast"] },
      }).success,
    ).toBe(true);
  });

  test("an entry has the shape of `model`: autoTitle/titleModel accepted (and ignored)", () => {
    expect(
      FileConfigSchema.safeParse({ models: { a: { autoTitle: true, titleModel: "x" } } }).success,
    ).toBe(true);
  });

  test("an entry is strict, and a description is capped", () => {
    expect(FileConfigSchema.safeParse({ models: { a: { foo: 1 } } }).success).toBe(false);
    expect(
      FileConfigSchema.safeParse({ models: { a: { description: "x".repeat(301) } } }).success,
    ).toBe(false);
    expect(FileConfigSchema.safeParse({ model: { description: "x" } }).success).toBe(false);
  });

  test("a name holds letters, digits, _ and - only, at most 64", () => {
    expect(firstIssue({ models: { "a.b": {} } })).toContain("a name may hold only letters");
    expect(FileConfigSchema.safeParse({ models: { "": {} } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ models: { ["x".repeat(65)]: {} } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ models: { "fast_2-x": {} } }).success).toBe(true);
  });

  test("a type block is strict; its model is a non-empty string", () => {
    expect(
      FileConfigSchema.safeParse({
        models: { a: {} },
        subagents: { types: { x: { model: "a", foo: 1 } } },
      }).success,
    ).toBe(false);
    expect(FileConfigSchema.safeParse({ subagents: { types: { x: { model: "" } } } }).success).toBe(
      false,
    );
    expect(FileConfigSchema.safeParse({ subagents: { types: { x: {} } } }).success).toBe(true);
  });
});

describe("reference check", () => {
  test("an unknown type model is a config error naming the defined entries", () => {
    expect(
      firstIssue({
        models: { fast: {}, claude: {} },
        subagents: { types: { explore: { model: "fsat" } } },
      }),
    ).toBe('subagents.types.explore.model: "fsat" is not a models entry (defined: claude, fast)');
  });

  test("with no models at all, it says so", () => {
    expect(firstIssue({ subagents: { types: { explore: { model: "fast" } } } })).toBe(
      'subagents.types.explore.model: "fast" is not a models entry (no models defined)',
    );
    expect(firstIssue({ subagents: { selectableModels: ["gpt"] } })).toBe(
      'subagents.selectableModels: "gpt" is not a models entry (no models defined)',
    );
  });

  test("a profile's own broken reference is prefixed with the profile", () => {
    const file = {
      models: { fast: {} },
      profiles: { offline: { subagents: { types: { explore: { model: "local" } } } } },
    };
    expect(firstIssue(file)).toBe(
      'profiles.offline: subagents.types.explore.model: "local" is not a models entry (defined: fast)',
    );
    expect(modelRefIssues(file)).toEqual([
      'profiles.offline: subagents.types.explore.model: "local" is not a models entry (defined: fast)',
    ]);
  });

  test("a base issue is reported once, not again per profile", () => {
    const file = {
      subagents: { types: { explore: { model: "x" } } },
      profiles: { a: { maxIterations: 3 }, b: { maxIterations: 4 } },
    };
    expect(FileConfigSchema.safeParse(file).success).toBe(false);
    const issues = modelRefIssues(file as never);
    expect(issues).toEqual([
      'subagents.types.explore.model: "x" is not a models entry (no models defined)',
    ]);
  });

  test("a base reference defined only in a profile is a base error", () => {
    const file = {
      subagents: { types: { explore: { model: "local" } } },
      profiles: { offline: { models: { local: {} } } },
    };
    expect(modelRefIssues(file as never)).toEqual([
      'subagents.types.explore.model: "local" is not a models entry (no models defined)',
    ]);
  });

  test("a type block without model, and valid references, raise nothing", () => {
    expect(
      modelRefIssues({
        models: { fast: {} },
        subagents: {
          types: { general: {}, explore: { model: "fast" } },
          selectableModels: ["fast"],
        },
      }),
    ).toEqual([]);
  });

  test("a name like __proto__ or constructor is never found by accident", () => {
    expect(modelRefIssues({ subagents: { types: { x: { model: "constructor" } } } })).toHaveLength(
      1,
    );
    expect(
      modelRefIssues({ subagents: { types: { x: { model: "__proto__" } } } } as never),
    ).toHaveLength(1);
  });
});

describe("profile merge", () => {
  test("a profile's models entry replaces the base entry whole", () => {
    const file = FileConfigSchema.parse({
      models: {
        claude: { provider: "anthropic", apiKey: "base-key", description: "Strong." },
        fast: { model: "a" },
      },
      profiles: { p: { models: { claude: { baseURL: "http://other/v1" } } } },
    });
    const applied = applyProfile(file, "p");
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.config.models).toEqual({
        claude: { baseURL: "http://other/v1" },
        fast: { model: "a" },
      });
    }
  });

  test("subagents.types merge by type name; selectableModels is replaced", () => {
    const file = FileConfigSchema.parse({
      models: { a: {}, b: {} },
      subagents: {
        maxParallel: 2,
        types: { explore: { model: "a" }, general: { model: "a" } },
        selectableModels: ["a", "b"],
      },
      profiles: {
        p: { subagents: { types: { explore: { model: "b" } }, selectableModels: ["b"] } },
      },
    });
    const applied = applyProfile(file, "p");
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.config.subagents).toEqual({
        maxParallel: 2,
        types: { explore: { model: "b" }, general: { model: "a" } },
        selectableModels: ["b"],
      });
    }
  });
});

describe("resolveModelEntry", () => {
  test("an empty entry is the main model, key inherited", () => {
    expect(resolveModelEntry(main, {})).toEqual({
      provider: "openai",
      baseURL: "http://main:8080/v1",
      model: "main-model",
      contextWindow: 131072,
      maxTokens: 4096,
      apiKeySource: "inherited",
      apiKey: "main-key",
    });
  });

  test("a model id only: same endpoint and key", () => {
    const r = resolveModelEntry(main, { model: "small", contextWindow: 32768 });
    expect([r.baseURL, r.model, r.contextWindow, r.apiKey]).toEqual([
      "http://main:8080/v1",
      "small",
      32768,
      "main-key",
    ]);
  });

  test("its own baseURL inherits NO provider and NO key from the main model", () => {
    const anthropicMain: MainModel = { ...main, provider: "anthropic" };
    const r = resolveModelEntry(anthropicMain, { baseURL: "http://elsewhere/v1" });
    expect(r.provider).toBe("openai");
    expect(r.apiKey).toBeUndefined();
    expect(r.apiKeySource).toBe("none");
    expect(r.apiKeyCommand).toBeUndefined();
  });

  test("its own provider: the provider's default URL, no key", () => {
    const r = resolveModelEntry(main, { provider: "anthropic" });
    expect([r.provider, r.baseURL, r.apiKey]).toEqual([
      "anthropic",
      DEFAULT_ANTHROPIC_BASE_URL,
      undefined,
    ]);
    expect(resolveModelEntry({ ...main, provider: "anthropic" }, { apiKey: "k" }).baseURL).toBe(
      DEFAULT_BASE_URL,
    );
  });

  test("its own key, or its own command", () => {
    const own = resolveModelEntry(main, { apiKey: "entry-key" });
    expect([own.apiKey, own.apiKeySource]).toEqual(["entry-key", "file"]);
    const cmd = resolveModelEntry(main, { apiKeyCommand: "pass show x" });
    expect([cmd.apiKey, cmd.apiKeySource, cmd.apiKeyCommand]).toEqual([
      undefined,
      "command",
      "pass show x",
    ]);
  });

  test("description is the entry's; title keys are ignored", () => {
    const r = resolveModelEntry(main, { description: "Quick.", autoTitle: true, titleModel: "t" });
    expect(r.description).toBe("Quick.");
    expect(Object.keys(r)).not.toContain("autoTitle");
    expect(Object.keys(r)).not.toContain("titleModel");
  });
});

describe("resolveConfig: models over the EFFECTIVE main model", () => {
  const ctx = (fileConfig: unknown, env: Record<string, string | undefined> = {}) =>
    resolveConfig({
      fileConfig: FileConfigSchema.parse(fileConfig),
      env,
      defaultCwd: "/w",
      promptFromFile: undefined,
      agentsMd: undefined,
    });

  test("env overrides of the main model reach inheriting entries only", () => {
    const r = ctx(
      {
        model: { baseURL: "http://file/v1", apiKey: "file-key" },
        models: { same: { model: "x" }, other: { baseURL: "http://other/v1" } },
        subagents: { types: { explore: { model: "same" } }, selectableModels: ["other", "other"] },
      },
      {
        TENTACLE_MODEL_BASE_URL: "http://env/v1",
        TENTACLE_MODEL_API_KEY: "env-key",
        TENTACLE_CONTEXT_WINDOW: "9000",
      },
    );
    expect(r.models.same?.baseURL).toBe("http://env/v1");
    expect(r.models.same?.apiKey).toBe("env-key");
    expect(r.models.same?.contextWindow).toBe(9000);
    expect(r.models.other?.apiKey).toBeUndefined();
    expect(r.subagentModels).toEqual({ explore: "same" });
    expect(r.selectableModels).toEqual(["other"]);
  });

  test("unset → empty maps", () => {
    const r = ctx({});
    expect(r.models).toEqual({});
    expect(r.subagentModels).toEqual({});
    expect(r.selectableModels).toEqual([]);
  });
});

const entry = (over: Partial<ResolvedModel>): ResolvedModel => ({
  provider: "openai",
  baseURL: "http://main:8080/v1",
  model: "m",
  contextWindow: 1000,
  apiKeySource: "inherited",
  ...over,
});

describe("pickSubagentModel", () => {
  const config = {
    models: {
      fast: entry({ model: "fast-id", contextWindow: 32000 }),
      big: entry({ model: "big-id", contextWindow: 200000 }),
    },
    subagentModels: { explore: "fast" },
    selectableModels: ["big"],
  };

  test("the call's model beats the type's", () => {
    expect(pickSubagentModel({ requested: "big", typeName: "explore" }, config)).toEqual({
      kind: "entry",
      name: "big",
      contextWindow: 200000,
    });
  });

  test("a call's model that is not listed is ignored", () => {
    expect(pickSubagentModel({ requested: "fast", typeName: "general" }, config)).toEqual({
      kind: "default",
    });
  });

  test("the type's model beats the frontmatter, and ignores the frontmatter window", () => {
    expect(
      pickSubagentModel(
        { typeName: "explore", frontmatterModel: "big", frontmatterWindow: 5 },
        config,
      ),
    ).toEqual({ kind: "entry", name: "fast", contextWindow: 32000 });
  });

  test("a frontmatter models name; its window wins when given", () => {
    expect(
      pickSubagentModel({ typeName: "rev", frontmatterModel: "big", frontmatterWindow: 7 }, config),
    ).toEqual({ kind: "entry", name: "big", contextWindow: 7 });
    expect(pickSubagentModel({ typeName: "rev", frontmatterModel: "big" }, config)).toEqual({
      kind: "entry",
      name: "big",
      contextWindow: 200000,
    });
  });

  test("a frontmatter that is no models name is a model id (today's meaning)", () => {
    expect(
      pickSubagentModel(
        { typeName: "rev", frontmatterModel: "raw-id", frontmatterWindow: 9 },
        config,
      ),
    ).toEqual({ kind: "id", id: "raw-id", contextWindow: 9 });
    expect(pickSubagentModel({ typeName: "rev", frontmatterModel: "raw-id" }, config)).toEqual({
      kind: "id",
      id: "raw-id",
    });
  });

  test("nothing configured: default", () => {
    expect(pickSubagentModel({ typeName: "general" }, config)).toEqual({ kind: "default" });
    expect(
      pickSubagentModel({ typeName: "constructor", frontmatterModel: undefined }, config),
    ).toEqual({ kind: "default" });
  });
});

describe("notices", () => {
  test("pod notice only when something is configured", () => {
    expect(modelsPodNotice({ subagentModels: {}, selectableModels: [] })).toBeNull();
    expect(modelsPodNotice({ subagentModels: { explore: "fast" }, selectableModels: [] })).toBe(
      "subagents.types / subagents.selectableModels are not applied on run/attach yet (feat/models-map-pod): every sub-agent uses the laptop's main model",
    );
    expect(modelsPodNotice({ subagentModels: {}, selectableModels: ["a"] })).not.toBeNull();
  });

  test("an unknown type is warned about, a known one is not", () => {
    expect(
      unknownTypeModelWarnings({ explore: "fast", reviewr: "big" }, ["general", "explore"]),
    ).toEqual([
      'subagents.types.reviewr: no sub-agent type "reviewr" (known: general, explore) — its model is not used',
    ]);
  });
});
