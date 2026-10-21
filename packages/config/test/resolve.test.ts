import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_AUTO_WAKE,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_SUBAGENT_MAX_ITERATIONS,
  DEFAULT_SYSTEM_PROMPT,
} from "../src/defaults.ts";
import { type ResolveContext, resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

function ctx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    fileConfig: {},
    env: {},
    defaultCwd: "/launch",
    ...overrides,
  };
}

describe("resolveConfig precedence", () => {
  test("falls back to built-in defaults when nothing is set", () => {
    const c = resolveConfig(ctx());
    expect(c.baseURL).toBe(DEFAULT_BASE_URL);
    expect(c.model).toBe(DEFAULT_MODEL);
    expect(c.cwd).toBe("/launch");
    expect(c.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    expect(c.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(c.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(c.sources.baseURL).toBe("default");
    expect(c.apiKeySource).toBe("none");
    // Sub-agents are on by default.
    expect(c.subagentsEnabled).toBe(true);
    expect(c.sources.subagentsEnabled).toBe("default");
    expect(c.subagentMaxIterations).toBe(DEFAULT_SUBAGENT_MAX_ITERATIONS);
    expect(c.sources.subagentMaxIterations).toBe("default");
    // Auto-wake on job-exit is on by default.
    expect(c.autoWake).toBe(DEFAULT_AUTO_WAKE);
    expect(c.autoWake).toBe(true);
    expect(c.sources.autoWake).toBe("default");
    // The provider defaults to OpenAI-compatible (existing behaviour).
    expect(c.provider).toBe(DEFAULT_PROVIDER);
    expect(c.provider).toBe("openai");
    expect(c.sources.provider).toBe("default");
  });

  test("autoWake resolves env > file > default", () => {
    expect(resolveConfig(ctx({ fileConfig: { autoWake: false } })).autoWake).toBe(false);
    const envWins = resolveConfig(
      ctx({ env: { TENTACLE_AUTO_WAKE: "off" }, fileConfig: { autoWake: true } }),
    );
    expect(envWins.autoWake).toBe(false);
    expect(envWins.sources.autoWake).toBe("env");
    // An unrecognised env value falls through to the default.
    const fell = resolveConfig(ctx({ env: { TENTACLE_AUTO_WAKE: "maybe" } }));
    expect(fell.autoWake).toBe(true);
    expect(fell.sources.autoWake).toBe("default");
  });

  test("hooks are file-only and default to []", () => {
    expect(resolveConfig(ctx({})).hooks).toEqual([]);
    const hooks = [{ event: "tool_result" as const, command: "redact" }];
    expect(resolveConfig(ctx({ fileConfig: { hooks } })).hooks).toEqual(hooks);
  });

  test("sub-agent step limit resolves env > file > default, and allows -1 (unlimited)", () => {
    // File value wins over the default.
    expect(
      resolveConfig(ctx({ fileConfig: { subagents: { maxIterations: 80 } } }))
        .subagentMaxIterations,
    ).toBe(80);
    // -1 (unlimited) is accepted from the file...
    expect(
      resolveConfig(ctx({ fileConfig: { subagents: { maxIterations: -1 } } }))
        .subagentMaxIterations,
    ).toBe(-1);
    // ...and from the env, which wins over the file.
    const envWins = resolveConfig(
      ctx({
        env: { TENTACLE_SUBAGENT_MAX_ITERATIONS: "-1" },
        fileConfig: { subagents: { maxIterations: 80 } },
      }),
    );
    expect(envWins.subagentMaxIterations).toBe(-1);
    expect(envWins.sources.subagentMaxIterations).toBe("env");
    // A bad env value (0, non-integer) falls through to the file/default.
    expect(
      resolveConfig(ctx({ env: { TENTACLE_SUBAGENT_MAX_ITERATIONS: "0" } })).subagentMaxIterations,
    ).toBe(DEFAULT_SUBAGENT_MAX_ITERATIONS);
  });

  test("sub-agents toggle resolves env > file > default", () => {
    expect(
      resolveConfig(ctx({ fileConfig: { subagents: { enabled: false } } })).subagentsEnabled,
    ).toBe(false);
    expect(
      resolveConfig(
        ctx({ env: { TENTACLE_SUBAGENTS: "off" }, fileConfig: { subagents: { enabled: true } } }),
      ).subagentsEnabled,
    ).toBe(false);
    expect(resolveConfig(ctx({ env: { TENTACLE_SUBAGENTS: "1" } })).subagentsEnabled).toBe(true);
    const fell = resolveConfig(ctx({ env: { TENTACLE_SUBAGENTS: "maybe" } }));
    expect(fell.subagentsEnabled).toBe(true);
    expect(fell.sources.subagentsEnabled).toBe("default");
  });

  test("file config overrides defaults", () => {
    const c = resolveConfig(
      ctx({
        fileConfig: {
          model: { baseURL: "http://file/v1", model: "file-model", contextWindow: 200000 },
          maxIterations: 4,
        },
        promptFromFile: "from file",
      }),
    );
    expect(c.baseURL).toBe("http://file/v1");
    expect(c.model).toBe("file-model");
    expect(c.maxIterations).toBe(4);
    expect(c.contextWindow).toBe(200000);
    expect(c.systemPrompt).toBe("from file");
    expect(c.sources.baseURL).toBe("file");
    expect(c.sources.systemPrompt).toBe("file");
  });

  test("env overrides both file and defaults", () => {
    const c = resolveConfig(
      ctx({
        fileConfig: { model: { baseURL: "http://file/v1" }, maxIterations: 4 },
        env: {
          TENTACLE_MODEL_BASE_URL: "http://env/v1",
          TENTACLE_MODEL: "env-model",
          TENTACLE_CWD: "/env-cwd",
          TENTACLE_MAX_ITERATIONS: "9",
          TENTACLE_SYSTEM_PROMPT: "env prompt",
        },
        promptFromFile: "from file",
      }),
    );
    expect(c.baseURL).toBe("http://env/v1");
    expect(c.model).toBe("env-model");
    // TENTACLE_CWD is no longer read: the workspace is always the launch dir.
    expect(c.cwd).toBe("/launch");
    expect(c.maxIterations).toBe(9);
    expect(c.systemPrompt).toBe("env prompt");
    expect(c.sources.baseURL).toBe("env");
  });

  test("TENTACLE_MAX_ITERATIONS ignores 0/garbage, accepts -1 (unlimited)", () => {
    // 0 and non-integers fall back to the default...
    expect(resolveConfig(ctx({ env: { TENTACLE_MAX_ITERATIONS: "0" } })).maxIterations).toBe(
      DEFAULT_MAX_ITERATIONS,
    );
    expect(resolveConfig(ctx({ env: { TENTACLE_MAX_ITERATIONS: "abc" } })).maxIterations).toBe(
      DEFAULT_MAX_ITERATIONS,
    );
    // ...but -1 (unlimited) is accepted (red before the parseIterationLimit swap).
    expect(resolveConfig(ctx({ env: { TENTACLE_MAX_ITERATIONS: "-1" } })).maxIterations).toBe(-1);
  });

  test("maxIterations: -1 (unlimited) is accepted from the file and by the schema", () => {
    // The resolver passes a file value through unclamped (guard — holds on both).
    expect(resolveConfig(ctx({ fileConfig: { maxIterations: -1 } })).maxIterations).toBe(-1);
    // The file schema accepts -1 and still rejects 0 (red before the refine).
    expect(FileConfigSchema.safeParse({ maxIterations: -1 }).success).toBe(true);
    expect(FileConfigSchema.safeParse({ maxIterations: 0 }).success).toBe(false);
  });

  test("baseURL defaults per provider: anthropic → the Anthropic API", () => {
    const a = resolveConfig(ctx({ fileConfig: { model: { provider: "anthropic" } } }));
    expect(DEFAULT_ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com/v1");
    expect(a.baseURL).toBe(DEFAULT_ANTHROPIC_BASE_URL);
    expect(a.sources.baseURL).toBe("default");
    // The provider env var drives the default too.
    expect(resolveConfig(ctx({ env: { TENTACLE_PROVIDER: "anthropic" } })).baseURL).toBe(
      DEFAULT_ANTHROPIC_BASE_URL,
    );
    // An explicit baseURL always wins (a gateway, or a local /v1/messages).
    const explicit = resolveConfig(
      ctx({ fileConfig: { model: { provider: "anthropic", baseURL: "http://gw/v1" } } }),
    );
    expect(explicit.baseURL).toBe("http://gw/v1");
    // openai (the default) keeps the local default unchanged.
    expect(resolveConfig(ctx()).baseURL).toBe(DEFAULT_BASE_URL);
  });

  test("maxTokens resolves env > file > unset (no default)", () => {
    const unset = resolveConfig(ctx());
    expect(unset.maxTokens).toBeUndefined();
    expect(unset.sources.maxTokens).toBe("default");
    const file = resolveConfig(ctx({ fileConfig: { model: { maxTokens: 8192 } } }));
    expect(file.maxTokens).toBe(8192);
    expect(file.sources.maxTokens).toBe("file");
    const env = resolveConfig(
      ctx({ env: { TENTACLE_MAX_TOKENS: "32000" }, fileConfig: { model: { maxTokens: 8192 } } }),
    );
    expect(env.maxTokens).toBe(32000);
    expect(env.sources.maxTokens).toBe("env");
    // An invalid env value falls through to the file.
    expect(
      resolveConfig(
        ctx({ env: { TENTACLE_MAX_TOKENS: "lots" }, fileConfig: { model: { maxTokens: 8192 } } }),
      ).maxTokens,
    ).toBe(8192);
    expect(FileConfigSchema.safeParse({ model: { maxTokens: 0 } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ model: { maxTokens: 1.5 } }).success).toBe(false);
  });

  test("provider resolves env > file > default (openai)", () => {
    // File value wins over the default.
    expect(resolveConfig(ctx({ fileConfig: { model: { provider: "anthropic" } } })).provider).toBe(
      "anthropic",
    );
    expect(
      resolveConfig(ctx({ fileConfig: { model: { provider: "anthropic" } } })).sources.provider,
    ).toBe("file");
    // env wins over the file.
    const envWins = resolveConfig(
      ctx({
        env: { TENTACLE_PROVIDER: "openai" },
        fileConfig: { model: { provider: "anthropic" } },
      }),
    );
    expect(envWins.provider).toBe("openai");
    expect(envWins.sources.provider).toBe("env");
    // An unrecognised env value falls through to the file/default (not a silent
    // fallback to an arbitrary kind).
    const fell = resolveConfig(ctx({ env: { TENTACLE_PROVIDER: "gemini" } }));
    expect(fell.provider).toBe(DEFAULT_PROVIDER);
    expect(fell.sources.provider).toBe("default");
    // The schema is the first gate: an unknown provider kind is a loud error.
    expect(FileConfigSchema.safeParse({ model: { provider: "gemini" } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ model: { provider: "anthropic" } }).success).toBe(true);
  });
});

describe("resolveConfig API key precedence", () => {
  test("env key wins over file key and command", () => {
    const c = resolveConfig(
      ctx({
        fileConfig: { model: { apiKey: "file-key", apiKeyCommand: "echo cmd" } },
        env: { TENTACLE_MODEL_API_KEY: "env-key" },
      }),
    );
    expect(c.apiKey).toBe("env-key");
    expect(c.apiKeyCommand).toBeUndefined();
    expect(c.apiKeySource).toBe("env");
  });

  test("file key wins over command", () => {
    const c = resolveConfig(
      ctx({ fileConfig: { model: { apiKey: "file-key", apiKeyCommand: "echo cmd" } } }),
    );
    expect(c.apiKey).toBe("file-key");
    expect(c.apiKeySource).toBe("file");
  });

  test("command is deferred when it is the only source", () => {
    const c = resolveConfig(ctx({ fileConfig: { model: { apiKeyCommand: "echo cmd" } } }));
    expect(c.apiKey).toBeUndefined();
    expect(c.apiKeyCommand).toBe("echo cmd");
    expect(c.apiKeySource).toBe("command");
  });
});

describe("resolveConfig AGENTS.md composition", () => {
  test("appends AGENTS.md after the identity prompt, under a labelled header", () => {
    const c = resolveConfig(ctx({ promptFromFile: "IDENTITY", agentsMd: "RULES" }));
    expect(c.systemPrompt).toBe("IDENTITY\n\n# Project rules (AGENTS.md)\n\nRULES\n");
    expect(c.agentsMdLoaded).toBe(true);
    // The identity still leads; AGENTS.md is strictly appended.
    expect(c.systemPrompt.startsWith("IDENTITY")).toBe(true);
    // Provenance of the base prompt is unchanged (file here).
    expect(c.sources.systemPrompt).toBe("file");
  });

  test("absent AGENTS.md leaves the prompt byte-identical (additive guarantee)", () => {
    const c = resolveConfig(ctx({ promptFromFile: "IDENTITY" }));
    expect(c.systemPrompt).toBe("IDENTITY");
    expect(c.agentsMdLoaded).toBe(false);
  });

  test("an all-whitespace AGENTS.md is treated as absent", () => {
    const c = resolveConfig(ctx({ promptFromFile: "IDENTITY", agentsMd: "   \n\n" }));
    expect(c.systemPrompt).toBe("IDENTITY");
    expect(c.agentsMdLoaded).toBe(false);
  });

  test("env TENTACLE_NO_AGENTS_MD disables the append (and wins over the file)", () => {
    const off = resolveConfig(
      ctx({ env: { TENTACLE_NO_AGENTS_MD: "1" }, promptFromFile: "IDENTITY", agentsMd: "RULES" }),
    );
    expect(off.systemPrompt).toBe("IDENTITY");
    expect(off.agentsMdLoaded).toBe(false);
    // env off beats file loadAgentsMd:true
    const envBeatsFile = resolveConfig(
      ctx({
        env: { TENTACLE_NO_AGENTS_MD: "yes" },
        fileConfig: { loadAgentsMd: true },
        promptFromFile: "IDENTITY",
        agentsMd: "RULES",
      }),
    );
    expect(envBeatsFile.agentsMdLoaded).toBe(false);
  });

  test("file loadAgentsMd:false disables the append", () => {
    const c = resolveConfig(
      ctx({ fileConfig: { loadAgentsMd: false }, promptFromFile: "IDENTITY", agentsMd: "RULES" }),
    );
    expect(c.systemPrompt).toBe("IDENTITY");
    expect(c.agentsMdLoaded).toBe(false);
  });

  test("a full override (TENTACLE_SYSTEM_PROMPT) is still only the identity; AGENTS.md appends", () => {
    const c = resolveConfig(ctx({ env: { TENTACLE_SYSTEM_PROMPT: "ENV_ID" }, agentsMd: "RULES" }));
    expect(c.systemPrompt).toBe("ENV_ID\n\n# Project rules (AGENTS.md)\n\nRULES\n");
    expect(c.sources.systemPrompt).toBe("env");
    expect(c.agentsMdLoaded).toBe(true);
  });
});
