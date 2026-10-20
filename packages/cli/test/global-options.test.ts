import { describe, expect, test } from "bun:test";
import { extractGlobalOptions } from "../src/flags.ts";

// `--profile <name>` is a LEADING global option, removed from argv before the
// dispatch on args[0] (docs/feat/config-profiles.md). Never silently dropped,
// never left in a one-shot prompt.

describe("extractGlobalOptions", () => {
  test("no global option: argv unchanged", () => {
    expect(extractGlobalOptions(["serve", "--port", "1"])).toEqual({
      ok: true,
      rest: ["serve", "--port", "1"],
    });
    expect(extractGlobalOptions([])).toEqual({ ok: true, rest: [] });
  });

  test("leading `--profile x` and `--profile=x`, before any command or mode", () => {
    // Mutation: leave the pair in `rest` → the one-shot prompt contains it.
    expect(extractGlobalOptions(["--profile", "work", "fix", "it"])).toEqual({
      ok: true,
      profile: "work",
      rest: ["fix", "it"],
    });
    expect(extractGlobalOptions(["--profile=work", "serve", "--port", "1"])).toEqual({
      ok: true,
      profile: "work",
      rest: ["serve", "--port", "1"],
    });
    expect(extractGlobalOptions(["--profile", "w", "--resume"])).toEqual({
      ok: true,
      profile: "w",
      rest: ["--resume"],
    });
    expect(extractGlobalOptions(["--profile", "w"])).toEqual({ ok: true, profile: "w", rest: [] });
  });

  test("a one-shot prompt keeps its own text, even `--profile` inside it", () => {
    expect(extractGlobalOptions(["--profile", "w", "fix", "the", "--profile", "docs"])).toEqual({
      ok: true,
      profile: "w",
      rest: ["fix", "the", "--profile", "docs"],
    });
    expect(extractGlobalOptions(["explain", "--profile"])).toEqual({
      ok: true,
      rest: ["explain", "--profile"],
    });
  });

  test("a missing or flag-like value is an error", () => {
    for (const args of [
      ["--profile"],
      ["--profile", "--resume"],
      ["--profile="],
      ["--profile", ""],
    ]) {
      const result = extractGlobalOptions(args);
      expect(result.ok).toBe(false);
    }
  });

  test("twice is an error (never a silent last-wins)", () => {
    expect(extractGlobalOptions(["--profile", "a", "--profile", "b"]).ok).toBe(false);
  });

  test("after a command or mode it is an error, never a silent ignore", () => {
    // Mutation: drop this check → `tentacle serve --profile x` starts with the base config.
    for (const args of [
      ["serve", "--profile", "x"],
      ["run", "--image", "i", "--profile=x"],
      ["attach", "pod", "--profile", "x"],
      ["--resume", "--profile", "x"],
      ["-i", "--profile", "x"],
      ["--interactive", "--profile", "x"],
      ["--plain", "--profile", "x"],
      ["--profile", "a", "serve", "--profile", "b"],
    ]) {
      const result = extractGlobalOptions(args);
      expect(result).toEqual({ ok: false, error: "--profile must come before the command" });
    }
  });

  test("with connect it is an error (the remote daemon owns its config)", () => {
    expect(extractGlobalOptions(["--profile", "w", "connect", "ws://h:1"])).toEqual({
      ok: false,
      error: "--profile has no effect with connect: the remote daemon uses its own config",
    });
  });
});
