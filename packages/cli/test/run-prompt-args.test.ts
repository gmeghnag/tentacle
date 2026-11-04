import { describe, expect, test } from "bun:test";
import { ARGS, detachFlagProblem, parseArgs, resolveRunPrompt } from "../src/flags.ts";

// docs/feat/run-prompt.md: `run`'s positional is the first prompt; `--name` names the workload.
describe("parseArgs: run's positional is the prompt, --name the workload's name", () => {
  const parse = (args: string[]) => parseArgs(args, ARGS.run);

  test("--name is a value flag; the positional stays a word (the prompt)", () => {
    const r = parse(["--image", "x", "--name", "box", "fix the bug"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.flags.get("name")).toBe("box");
      expect(r.positional).toEqual(["fix the bug"]);
    }
  });

  test("-- ends the options, so a prompt can start with - or /", () => {
    const r = parse(["--image", "x", "--", "-x /clear"]);
    expect(r.ok && r.positional).toEqual(["-x /clear"]);
  });

  test("two positionals are still an error; -n stays --namespace (no short for --name)", () => {
    expect(parse(["--image", "x", "a", "b"]).ok).toBe(false);
    expect(parse(["--image", "x", "-n", "dev"]).ok).toBe(true);
  });
});

describe("resolveRunPrompt", () => {
  test("the positional, or --prompt, is the prompt; neither is none", () => {
    expect(resolveRunPrompt({ positional: "a", promptFlag: undefined, detach: false })).toEqual({
      ok: true,
      prompt: "a",
      stdin: false,
    });
    expect(resolveRunPrompt({ positional: undefined, promptFlag: "b", detach: false })).toEqual({
      ok: true,
      prompt: "b",
      stdin: false,
    });
    expect(
      resolveRunPrompt({ positional: undefined, promptFlag: undefined, detach: true }),
    ).toEqual({
      ok: true,
      prompt: undefined,
      stdin: false,
    });
  });

  test("both → an error; a lone - positional is a plain word", () => {
    const both = resolveRunPrompt({ positional: "a", promptFlag: "b", detach: true });
    expect(both.ok === false && both.error).toContain("once");
    expect(resolveRunPrompt({ positional: "-", promptFlag: undefined, detach: false })).toEqual({
      ok: true,
      prompt: "-",
      stdin: false,
    });
  });

  test("--prompt - is stdin only with --detach", () => {
    expect(resolveRunPrompt({ positional: undefined, promptFlag: "-", detach: true })).toEqual({
      ok: true,
      prompt: undefined,
      stdin: true,
    });
    const r = resolveRunPrompt({ positional: undefined, promptFlag: "-", detach: false });
    expect(r.ok === false && r.error).toContain("--prompt - needs --detach");
  });
});

describe("detachFlagProblem", () => {
  const ok = { detach: false, prompt: undefined, resume: false };

  test("interactive: a prompt alone is fine; blank is empty; resume + prompt is refused", () => {
    expect(detachFlagProblem({ ...ok, prompt: "go" })).toBeNull();
    expect(detachFlagProblem({ ...ok, prompt: "  " })).toContain("the prompt is empty");
    expect(detachFlagProblem({ ...ok, resume: true })).toBeNull();
    expect(detachFlagProblem({ ...ok, resume: true, prompt: "go" })).toContain(
      "cannot be combined with a prompt",
    );
  });

  test("detached: a prompt is needed; resume stays refused", () => {
    expect(detachFlagProblem({ ...ok, detach: true })).toContain("--detach needs a prompt");
    expect(detachFlagProblem({ ...ok, detach: true, prompt: "go" })).toBeNull();
    expect(detachFlagProblem({ ...ok, detach: true, prompt: "go", resume: true })).toContain(
      "--detach cannot resume",
    );
  });
});
