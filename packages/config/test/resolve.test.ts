import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AUTO_WAKE,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODEL,
  DEFAULT_SUBAGENT_MAX_ITERATIONS,
  DEFAULT_SYSTEM_PROMPT,
} from "../src/defaults.ts";
import { type ResolveContext, resolveConfig } from "../src/resolve.ts";

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
  });

  test("autoWake resolves env > file > default", () => {
    expect(resolveConfig(ctx({ fileConfig: { autoWake: false } })).autoWake).toBe(false);
    const envWins = resolveConfig(
      ctx({ env: { HARNESS_AUTO_WAKE: "off" }, fileConfig: { autoWake: true } }),
    );
    expect(envWins.autoWake).toBe(false);
    expect(envWins.sources.autoWake).toBe("env");
    // An unrecognised env value falls through to the default.
    const fell = resolveConfig(ctx({ env: { HARNESS_AUTO_WAKE: "maybe" } }));
    expect(fell.autoWake).toBe(true);
    expect(fell.sources.autoWake).toBe("default");
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
        env: { HARNESS_SUBAGENT_MAX_ITERATIONS: "-1" },
        fileConfig: { subagents: { maxIterations: 80 } },
      }),
    );
    expect(envWins.subagentMaxIterations).toBe(-1);
    expect(envWins.sources.subagentMaxIterations).toBe("env");
    // A bad env value (0, non-integer) falls through to the file/default.
    expect(
      resolveConfig(ctx({ env: { HARNESS_SUBAGENT_MAX_ITERATIONS: "0" } })).subagentMaxIterations,
    ).toBe(DEFAULT_SUBAGENT_MAX_ITERATIONS);
  });

  test("sub-agents toggle resolves env > file > default", () => {
    expect(
      resolveConfig(ctx({ fileConfig: { subagents: { enabled: false } } })).subagentsEnabled,
    ).toBe(false);
    expect(
      resolveConfig(
        ctx({ env: { HARNESS_SUBAGENTS: "off" }, fileConfig: { subagents: { enabled: true } } }),
      ).subagentsEnabled,
    ).toBe(false);
    expect(resolveConfig(ctx({ env: { HARNESS_SUBAGENTS: "1" } })).subagentsEnabled).toBe(true);
    const fell = resolveConfig(ctx({ env: { HARNESS_SUBAGENTS: "maybe" } }));
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
        fileConfig: { model: { baseURL: "http://file/v1" }, cwd: "/file-cwd", maxIterations: 4 },
        env: {
          HARNESS_MODEL_BASE_URL: "http://env/v1",
          HARNESS_MODEL: "env-model",
          HARNESS_CWD: "/env-cwd",
          HARNESS_MAX_ITERATIONS: "9",
          HARNESS_SYSTEM_PROMPT: "env prompt",
        },
        promptFromFile: "from file",
      }),
    );
    expect(c.baseURL).toBe("http://env/v1");
    expect(c.model).toBe("env-model");
    expect(c.cwd).toBe("/env-cwd");
    expect(c.maxIterations).toBe(9);
    expect(c.systemPrompt).toBe("env prompt");
    expect(c.sources.baseURL).toBe("env");
  });

  test("ignores a non-positive HARNESS_MAX_ITERATIONS", () => {
    expect(resolveConfig(ctx({ env: { HARNESS_MAX_ITERATIONS: "0" } })).maxIterations).toBe(
      DEFAULT_MAX_ITERATIONS,
    );
    expect(resolveConfig(ctx({ env: { HARNESS_MAX_ITERATIONS: "abc" } })).maxIterations).toBe(
      DEFAULT_MAX_ITERATIONS,
    );
  });
});

describe("resolveConfig API key precedence", () => {
  test("env key wins over file key and command", () => {
    const c = resolveConfig(
      ctx({
        fileConfig: { model: { apiKey: "file-key", apiKeyCommand: "echo cmd" } },
        env: { HARNESS_MODEL_API_KEY: "env-key" },
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
