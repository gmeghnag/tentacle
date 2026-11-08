import { describe, expect, test } from "bun:test";
import { type ConfigArgs, parseConfigArgs } from "../src/config-args.ts";

/** Parse a `tentacle config …` argv (flags already split by `parseArgs`). */
function parse(
  args: readonly string[],
  opts: { profile?: string; unset?: string; json?: boolean; yes?: boolean } = {},
): ConfigArgs {
  const bools = new Set<string>();
  if (opts.json === true) bools.add("json");
  if (opts.yes === true) bools.add("yes");
  const flags = new Map<string, string>();
  if (opts.profile !== undefined) flags.set("profile", opts.profile);
  if (opts.unset !== undefined) flags.set("unset", opts.unset);
  return parseConfigArgs(args, flags, bools);
}

/** The parse must succeed; returns it (no `!` assertion). */
function ok(
  args: readonly string[],
  opts: Parameters<typeof parse>[1] = {},
): Extract<ConfigArgs, { ok: true }> {
  const result = parse(args, opts);
  if (!result.ok) {
    throw new Error(`expected a parse, got: ${result.error}`);
  }
  return result;
}

function failed(args: readonly string[], opts: Parameters<typeof parse>[1] = {}): string {
  const result = parse(args, opts);
  if (result.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result.op)}`);
  }
  return result.error;
}

describe("the two forms of a set (owner Q5/Q7)", () => {
  test("`set key value`", () => {
    expect(ok(["set", "model.model", "qwen3"]).op).toEqual({
      kind: "set",
      key: "model.model",
      value: { from: "argv", text: "qwen3" },
    });
  });

  test("the shorthand `key=value`, split at the FIRST `=`", () => {
    // Mutation: split on the last `=` (or `split("=")` and take [1]) → a URL's
    // own `:`/`=` are lost.
    expect(ok(["model.baseURL=http://localhost:8080/v1?x=1"]).op).toEqual({
      kind: "set",
      key: "model.baseURL",
      value: { from: "argv", text: "http://localhost:8080/v1?x=1" },
    });
    expect(ok(["tools.execution=parallel"]).op).toEqual({
      kind: "set",
      key: "tools.execution",
      value: { from: "argv", text: "parallel" },
    });
  });

  test("`key=` is an empty value, not an unset (owner Q4)", () => {
    expect(ok(["model.model="]).op).toEqual({
      kind: "set",
      key: "model.model",
      value: { from: "argv", text: "" },
    });
  });

  test("`set key=value` is the same shorthand (a key holds no `=`)", () => {
    expect(ok(["set", "autoWake=false"]).op).toEqual({
      kind: "set",
      key: "autoWake",
      value: { from: "argv", text: "false" },
    });
  });

  test("a value that looks like a flag needs `--`", () => {
    // `parseArgs` ends the options at `--` and pushes the rest as positionals,
    // so `tentacle config set maxIterations -- -1` arrives exactly like this.
    expect(ok(["set", "maxIterations", "-1"]).op).toEqual({
      kind: "set",
      key: "maxIterations",
      value: { from: "argv", text: "-1" },
    });
  });

  test("`set key -` is stdin, and a missing value is the prompt/stdin question", () => {
    expect(ok(["set", "model.apiKey", "-"]).op).toEqual({
      kind: "set",
      key: "model.apiKey",
      value: { from: "stdin" },
    });
    expect(ok(["set", "model.model"]).op).toEqual({
      kind: "set",
      key: "model.model",
      value: { from: "prompt" },
    });
    expect(ok(["model.model"]).op).toEqual({
      kind: "set",
      key: "model.model",
      value: { from: "prompt" },
    });
  });

  test("a JSON value comes through as one text, unchanged", () => {
    expect(ok(["tools.writableDirs", '["/tmp","~/x"]']).op).toEqual({
      kind: "set",
      key: "tools.writableDirs",
      value: { from: "argv", text: '["/tmp","~/x"]' },
    });
  });
});

describe("unset, get, list, path (owner Q4/Q7)", () => {
  test("`unset key` and `--unset key` are the same op", () => {
    expect(ok(["unset", "autoWake"]).op).toEqual({ kind: "unset", key: "autoWake" });
    expect(ok([], { unset: "autoWake" }).op).toEqual({ kind: "unset", key: "autoWake" });
  });

  test("`--unset` together with a command word is ambiguous", () => {
    expect(failed([], { unset: "" })).toContain("--unset needs a key");
    expect(failed(["unset", "a"], { unset: "b" })).toContain("--unset");
    expect(failed(["get", "a"], { unset: "b" })).toContain("--unset");
  });

  test("`get key`, with --json and --profile", () => {
    expect(ok(["get", "subagents.maxParallel"]).op).toEqual({
      kind: "get",
      key: "subagents.maxParallel",
    });
    const withFlags = ok(["get", "model.model"], { json: true, profile: "work" });
    expect(withFlags).toEqual({
      ok: true,
      op: { kind: "get", key: "model.model" },
      json: true,
      yes: false,
      profile: "work",
    });
  });

  test("`list` and `path` take no key", () => {
    expect(ok(["list"]).op).toEqual({ kind: "list" });
    expect(ok(["path"]).op).toEqual({ kind: "path" });
    expect(failed(["list", "model.model"])).toContain("unexpected argument");
    expect(failed(["path", "x"])).toContain("unexpected argument");
  });
});

describe("the refusals", () => {
  test("no words at all lists nothing: it is an error naming the forms", () => {
    const error = failed([]);
    expect(error).toContain("tentacle config set");
    expect(error).toContain("unset");
  });

  test("a bare key asks for the value (a hidden prompt / stdin, eval A4)", () => {
    // `tentacle config model.apiKey` is the documented safe form: no value on
    // argv, so the runner prompts. An unknown bare word is refused later, by key
    // resolution (`config modle` → nearest suggestions), not here.
    expect(ok(["modle"]).op).toEqual({ kind: "set", key: "modle", value: { from: "prompt" } });
  });

  test("a key=value with an empty key is refused", () => {
    expect(failed(["=x"])).toContain("no key");
  });

  test("too many words", () => {
    expect(failed(["set", "a", "b", "c"])).toContain("unexpected argument");
    expect(failed(["get", "a", "b"])).toContain("unexpected argument");
  });

  test("--profile with a key that already names a profile is ambiguous (eval A5)", () => {
    // Mutation: drop this check → `--profile work config profiles.work.x=y`
    // writes a profile inside a profile, which the schema then rejects with a
    // confusing message.
    const error = failed(["set", "profiles.work.model.model", "x"], { profile: "work" });
    expect(error).toContain("profile");
    expect(failed(["profiles.home.model.model=x"], { profile: "work" })).toContain("profile");
  });

  test("a key outside a profile cannot be put in one ($schema, profiles)", () => {
    expect(failed(["set", "$schema", "x"], { profile: "work" })).toContain("profile");
    expect(failed(["set", "profiles", "{}"], { profile: "work" })).toContain("profile");
  });
});
