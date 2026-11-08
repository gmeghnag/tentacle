import { describe, expect, test } from "bun:test";
import { ARGS, cliMode, extractSessionFlags, parseArgs } from "../src/flags.ts";

// `--model <id>` and `--profile <name>` are flags of the SESSION commands, written
// AFTER the command (docs/fix/detach-live-followups.md, owner decision A of
// 2026-11-03): `run`, `attach`, `serve`, and the bare local session (`tentacle
// --model X`, `-i`, `--resume`, `--plain`, a one-shot prompt). Never global
// options before a subcommand, never on `ps`/`rm`/`update`/`hooks`/`package`
// (each kept entry carries its own engine and location: a profile must not
// filter them), and `connect` refuses both (the remote daemon owns its model).

const ok = (args: readonly string[], spec: Parameters<typeof parseArgs>[1]) => {
  const result = parseArgs(args, spec);
  return result.ok
    ? { model: result.flags.get("model"), profile: result.flags.get("profile") }
    : result;
};

describe("session commands take --model and --profile after the command", () => {
  test("run, attach, serve", () => {
    // Mutation: drop `model`/`profile` from a spec → `unknown option --model`.
    expect(
      ok(
        ["--image", "i", "--model", "X", "--profile=Y", "--detach", "--prompt", "p", "box"],
        ARGS.run,
      ),
    ).toEqual({ model: "X", profile: "Y" });
    expect(ok(["box", "--model", "X"], ARGS.attach)).toEqual({ model: "X", profile: undefined });
    expect(ok(["--port", "1", "--model", "X", "--profile", "Y"], ARGS.serve)).toEqual({
      model: "X",
      profile: "Y",
    });
  });

  test("serve's own `--model-proxy` is a different flag and still works", () => {
    expect(ok(["--stdio", "--model-proxy", "--model", "X"], ARGS.serve)).toEqual({
      model: "X",
      profile: undefined,
    });
  });

  test("the bare local session: tui and plain, in any order with its own flags", () => {
    expect(ok(["--model", "X"], ARGS.tui)).toEqual({ model: "X", profile: undefined });
    expect(ok(["-i", "--profile", "Y"], ARGS.tui)).toEqual({ model: undefined, profile: "Y" });
    expect(ok(["--resume", "--model", "X", "--profile", "Y"], ARGS.tui)).toEqual({
      model: "X",
      profile: "Y",
    });
    expect(ok(["--plain", "--model", "X"], ARGS.plain)).toEqual({ model: "X", profile: undefined });
  });

  test("a missing value or a repeat is the normal parse error", () => {
    expect(ok(["--model"], ARGS.tui)).toEqual({ ok: false, error: "--model needs a value" });
    expect(ok(["--model", "--resume"], ARGS.tui)).toEqual({
      ok: false,
      error: "--model needs a value",
    });
    expect(ok(["--profile", "a", "--profile=b"], ARGS.tui)).toEqual({
      ok: false,
      error: "--profile given more than once",
    });
  });

  test("the bare forms reach their spec through cliMode (no command word)", () => {
    for (const args of [
      ["--model", "X"],
      ["-i", "--profile", "Y"],
      ["--resume", "--model", "X"],
    ]) {
      expect(cliMode(args)).toBe("tui");
    }
    expect(cliMode(["--plain", "--model", "X"])).toBe("plain");
    // Mutation: `--plain` only as the first word → `--model X --plain` is the TUI's, and fails.
    expect(cliMode(["--model", "X", "--plain"])).toBe("plain");
    expect(cliMode(["fix", "--plain"])).toBe("prompt"); // prompt text stays prompt text
  });
});

describe("commands that take no model: the normal unknown-option error", () => {
  test("ps, rm, update, hooks, package", () => {
    // Mutation: add `profile` to `ps` → a profile could filter `ps` (owner: ps shows ALL).
    for (const flag of ["--model", "--profile"]) {
      expect(parseArgs([flag, "X"], ARGS.ps)).toEqual({
        ok: false,
        error: `unknown option ${flag}`,
      });
      expect(parseArgs(["a", `${flag}=X`], ARGS.rm)).toEqual({
        ok: false,
        error: `unknown option ${flag}`,
      });
      expect(parseArgs([flag, "X"], ARGS.update)).toEqual({
        ok: false,
        error: `unknown option ${flag}`,
      });
      expect(parseArgs(["trust", "--list", flag, "X"], ARGS.hooks)).toEqual({
        ok: false,
        error: `unknown option ${flag}`,
      });
      expect(parseArgs(["install", "/x", flag, "X"], ARGS.package)).toEqual({
        ok: false,
        error: `unknown option ${flag}`,
      });
    }
  });
});

describe("extractSessionFlags", () => {
  test("nothing to extract: argv unchanged", () => {
    expect(extractSessionFlags(["serve", "--port", "1"])).toEqual({
      ok: true,
      rest: ["serve", "--port", "1"],
    });
    expect(extractSessionFlags([])).toEqual({ ok: true, rest: [] });
    expect(extractSessionFlags(["run", "--image", "i", "--model", "X"])).toEqual({
      ok: true,
      rest: ["run", "--image", "i", "--model", "X"],
    });
  });

  test("a one-shot prompt after the options: `tentacle --model X <prompt>`", () => {
    // Mutation: leave the pair in `rest` → the prompt (and the model) is wrong.
    expect(extractSessionFlags(["--model", "m1", "fix", "it"])).toEqual({
      ok: true,
      model: "m1",
      rest: ["fix", "it"],
    });
    expect(extractSessionFlags(["--profile=w", "--model", "m1", "fix"])).toEqual({
      ok: true,
      profile: "w",
      model: "m1",
      rest: ["fix"],
    });
    expect(extractSessionFlags(["--profile", "w", "--", "-x", "y"])).toEqual({
      ok: true,
      profile: "w",
      rest: ["--", "-x", "y"],
    });
  });

  test("the prompt keeps its own text, even `--model` inside it", () => {
    expect(extractSessionFlags(["--profile", "w", "fix", "the", "--profile", "docs"])).toEqual({
      ok: true,
      profile: "w",
      rest: ["fix", "the", "--profile", "docs"],
    });
    expect(extractSessionFlags(["explain", "--model", "x"])).toEqual({
      ok: true,
      rest: ["explain", "--model", "x"],
    });
  });

  test("options followed by the TUI's own flags, or by nothing, are left for parseArgs", () => {
    for (const args of [
      ["--model", "X"],
      ["--profile", "w", "--resume"],
      ["--model", "X", "-i"],
    ]) {
      expect(extractSessionFlags(args)).toEqual({ ok: true, rest: args });
    }
  });

  test("a repeat before a prompt is an error", () => {
    expect(extractSessionFlags(["--model", "a", "--model", "b", "fix"])).toEqual({
      ok: false,
      error: "--model given more than once",
    });
  });

  test("before a session command: an error naming the right form", () => {
    // Mutation: drop this check → `tentacle --model X run` loses the model silently.
    expect(extractSessionFlags(["--model", "X", "run", "--image", "i"])).toEqual({
      ok: false,
      error: "--model goes after the command: tentacle run --model X",
    });
    expect(extractSessionFlags(["--profile=Y", "attach", "box"])).toEqual({
      ok: false,
      error: "--profile goes after the command: tentacle attach --profile Y",
    });
    expect(extractSessionFlags(["--model", "X", "serve"])).toEqual({
      ok: false,
      error: "--model goes after the command: tentacle serve --model X",
    });
    // Both given: the first is named.
    expect(extractSessionFlags(["--profile", "Y", "--model", "X", "run"])).toEqual({
      ok: false,
      error: "--profile goes after the command: tentacle run --profile Y",
    });
  });

  test("before a command that takes no model: the unknown-option error", () => {
    for (const rest of [
      ["ps"],
      ["rm", "a"],
      ["update"],
      ["hooks", "trust", "--list"],
      ["install", "/x"],
    ]) {
      expect(extractSessionFlags(["--model", "X", ...rest])).toEqual({
        ok: false,
        error: "unknown option --model",
      });
    }
    expect(extractSessionFlags(["--profile", "P", "package", "list"])).toEqual({
      ok: false,
      error: "unknown option --profile",
    });
  });

  test("`install` is still the alias of `package install`", () => {
    expect(extractSessionFlags(["install", "/x#v1"])).toEqual({
      ok: true,
      rest: ["package", "install", "/x#v1"],
    });
    // Only the leading word: `install` later in a one-shot prompt stays prompt text.
    expect(extractSessionFlags(["please", "install", "deps"])).toEqual({
      ok: true,
      rest: ["please", "install", "deps"],
    });
  });

  test("connect refuses both, wherever they are, and names `serve --model`", () => {
    // Mutation: drop the refusal → `connect --model X` is a silent no-op.
    const model =
      "--model has no effect with connect: it uses the model its `tentacle serve` daemon serves — start that daemon with `tentacle serve --model <id>`";
    const profile = "--profile has no effect with connect: the remote daemon uses its own config";
    for (const args of [
      ["connect", "ws://h:1", "--model", "m1"],
      ["connect", "--model=m1", "ws://h:1"],
      ["--model", "m1", "connect", "ws://h:1"],
    ]) {
      expect(extractSessionFlags(args)).toEqual({ ok: false, error: model });
    }
    for (const args of [
      ["connect", "ws://h:1", "--profile", "w"],
      ["--profile", "w", "connect", "ws://h:1"],
    ]) {
      expect(extractSessionFlags(args)).toEqual({ ok: false, error: profile });
    }
    expect(extractSessionFlags(["connect", "ws://h:1", "--resume"])).toEqual({
      ok: true,
      rest: ["connect", "ws://h:1", "--resume"],
    });
  });
});
