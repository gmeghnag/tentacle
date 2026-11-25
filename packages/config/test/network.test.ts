import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { keyDoc } from "../src/key-docs.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema, networkValueProblem } from "../src/schema.ts";

// `network` (feat/run-network): the network `run` puts its container on. The
// SHAPE is one shared truth here (`networkValueProblem`, asked by the file schema
// AND by the CLI flag); whether a network EXISTS is the engine's, never ours.
describe("networkValueProblem (D3)", () => {
  test("a name, `none`, an engine mode and docker's container form pass", () => {
    for (const value of ["none", "bridge", "host", "my-net", "my_net.1", "container:abc123"]) {
      expect(networkValueProblem(value)).toBeNull();
    }
  });

  test("empty, a slash, a space and a 129-char value are refused, naming the value", () => {
    for (const value of ["", "a/b", "a b", "x".repeat(129)]) {
      const problem = networkValueProblem(value);
      expect(problem).not.toBeNull();
      expect(problem ?? "").toContain(JSON.stringify(value));
    }
    // 128 is the last accepted length (the boundary, not a weaker correlate).
    expect(networkValueProblem("x".repeat(128))).toBeNull();
  });
});

describe("network: the config key", () => {
  test("accepted in the file and in a profile; a malformed value is a loud error", () => {
    expect(FileConfigSchema.safeParse({ network: "none" }).success).toBe(true);
    expect(FileConfigSchema.safeParse({ profiles: { p: { network: "my-net" } } }).success).toBe(
      true,
    );
    expect(FileConfigSchema.safeParse({ network: "a/b" }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ profiles: { p: { network: "" } } }).success).toBe(false);
  });

  test("resolved from the file; absent when unset (the CLI layers flag/env)", () => {
    const file = FileConfigSchema.parse({ network: "my-net" });
    expect(resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }).network).toBe("my-net");
    const plain = resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" });
    expect("network" in plain).toBe(false);
  });

  test("a profile's network beats the file's", () => {
    const file = FileConfigSchema.parse({
      network: "bridge",
      profiles: { k: { network: "none" } },
    });
    const applied = applyProfile(file, "k");
    expect(applied.ok && applied.config.network).toBe("none");
    const base = applyProfile(file, undefined);
    expect(base.ok && base.config.network).toBe("bridge");
  });

  test("the registry documents it, with the env the CLI reads and no resolved default", () => {
    const doc = keyDoc("network");
    expect(doc?.env).toBe("TENTACLE_NETWORK");
    expect(doc?.sample).toBe("none");
    expect(doc?.flag).toBe("--network");
    expect(doc?.scope).toBe("both");
    expect(doc?.carried).toBe("no");
    // Unset means "the engine's default", not a value we could print.
    expect(doc?.default).toBeUndefined();
    expect(keyDoc("profiles.*.network")?.summary).toBe(doc?.summary ?? "");
  });

  test("the commented example is in the shipped config.jsonc", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('"network":');
  });
});
