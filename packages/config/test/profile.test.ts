import { describe, expect, test } from "bun:test";
import { applyProfile } from "../src/profile.ts";
import { FileConfigSchema } from "../src/schema.ts";

// Named profiles in the user's config (docs/feat/config-profiles.md). Each rule
// names the mutation that must turn it red (AGENTS §9).

const base = FileConfigSchema.parse({
  model: {
    baseURL: "http://localhost:8080/v1",
    model: "qwen",
    apiKey: "local-key",
    contextWindow: 32000,
  },
  maxIterations: 10,
  tools: { redactSecrets: true, dedupOutput: true },
  mcpServers: {
    filesystem: { command: "mcp-fs" },
    github: { command: "mcp-github", env: { GH_TOKEN: "t" } },
  },
  profiles: {
    long: { maxIterations: -1, model: { contextWindow: 200000 }, tools: { dedupOutput: false } },
    work: {
      model: { provider: "anthropic", model: "claude", apiKeyCommand: "pass anthropic" },
      mcpServers: {
        jira: { command: "mcp-jira" },
        github: { command: "mcp-ghe" },
        filesystem: null,
      },
    },
    empty: {},
  },
});

function apply(name: string | undefined) {
  const result = applyProfile(base, name);
  if (!result.ok) throw new Error(result.reason);
  return result.config;
}

describe("applyProfile", () => {
  test("no profile: the file as is, without `profiles`", () => {
    const config = apply(undefined);
    expect(config.profiles).toBeUndefined();
    expect({ model: config.model, mcpServers: config.mcpServers }).toEqual({
      model: base.model,
      mcpServers: base.mcpServers,
    });
  });

  test("an empty profile changes nothing but drops `profiles`", () => {
    const config = apply("empty");
    expect(config).toEqual(apply(undefined));
  });

  test("scalars: the profile wins; `model`/`tools` merge per key", () => {
    // Mutation: replace `model` wholesale → baseURL/apiKey/model are lost.
    const config = apply("long");
    expect(config.maxIterations).toBe(-1);
    expect(config.model).toEqual({
      baseURL: "http://localhost:8080/v1",
      model: "qwen",
      apiKey: "local-key",
      contextWindow: 200000,
    });
    expect(config.tools).toEqual({ redactSecrets: true, dedupOutput: false });
  });

  test("the connection group moves as a unit: the base key never reaches the profile's endpoint", () => {
    // Mutation: merge provider/baseURL/apiKey/apiKeyCommand per key → the base
    // `apiKey` (which beats a command) is sent to the profile's provider.
    const config = apply("work");
    expect(config.model).toEqual({
      provider: "anthropic",
      model: "claude",
      apiKeyCommand: "pass anthropic",
      contextWindow: 32000,
    });
  });

  test("any one connection key in a profile drops the whole base group", () => {
    const only = FileConfigSchema.parse({
      model: { provider: "openai", baseURL: "http://a/v1", apiKeyCommand: "cmd-a", model: "m" },
      profiles: { b: { model: { baseURL: "http://b/v1" } } },
    });
    const result = applyProfile(only, "b");
    expect(result.ok && result.config.model).toEqual({ baseURL: "http://b/v1", model: "m" });
  });

  test("mcpServers merge by name: add, replace whole (no field merge), null removes", () => {
    // Mutation: field-merge a replaced server → `GH_TOKEN` leaks onto `mcp-ghe`.
    const config = apply("work");
    expect(config.mcpServers).toEqual({
      github: { type: "stdio", command: "mcp-ghe" },
      jira: { type: "stdio", command: "mcp-jira" },
    });
  });

  test("an unknown name is an error naming the defined profiles", () => {
    const result = applyProfile(base, "nope");
    expect(result).toEqual({
      ok: false,
      reason: 'unknown profile "nope" (defined: long, work, empty)',
    });
    const none = applyProfile(FileConfigSchema.parse({}), "x");
    expect(none).toEqual({ ok: false, reason: 'unknown profile "x" (no profiles defined)' });
  });

  test("a profile's hooks replace the base list (top-level setting, no merge)", () => {
    const base = FileConfigSchema.parse({
      hooks: [{ event: "tool_call", command: "a" }],
      profiles: { p: { hooks: [{ event: "tool_result", command: "b" }] } },
    });
    const r = applyProfile(base, "p");
    expect(r.ok && r.config.hooks).toEqual([{ event: "tool_result", command: "b" }]);
    const none = applyProfile(base, undefined);
    expect(none.ok && none.config.hooks).toEqual([{ event: "tool_call", command: "a" }]);
  });

  test("the base is never mutated", () => {
    const before = JSON.stringify(base);
    apply("work");
    apply("long");
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("profile schema", () => {
  test("null removes a server only inside a profile; never in the base", () => {
    expect(FileConfigSchema.safeParse({ mcpServers: { a: null } }).success).toBe(false);
    expect(
      FileConfigSchema.safeParse({ profiles: { p: { mcpServers: { a: null } } } }).success,
    ).toBe(true);
  });

  test("contextReset merges per key, like subagents (mutation: drop the merge → the base `enabled` is lost)", () => {
    const file = FileConfigSchema.parse({
      contextReset: { enabled: false, maxPerMessage: 3 },
      profiles: { p: { contextReset: { maxPerMessage: -1 } } },
    });
    const applied = applyProfile(file, "p");
    expect(applied.ok && applied.config.contextReset).toEqual({
      enabled: false,
      maxPerMessage: -1,
    });
  });

  test("no nested profiles, no unknown keys in a profile", () => {
    expect(FileConfigSchema.safeParse({ profiles: { p: { profiles: {} } } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ profiles: { p: { modle: "x" } } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ profiles: { p: { $schema: "x" } } }).success).toBe(false);
  });
});
