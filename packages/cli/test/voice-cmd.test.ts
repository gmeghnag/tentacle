import { describe, expect, test } from "bun:test";
import { VOICE_DEFAULTS } from "@tentacle/tui";
import { ARGS, parseArgs } from "../src/flags.ts";
import { VOICE_USAGE, voiceCommand } from "../src/voice-cmd.ts";

/**
 * T10 — `tentacle voice setup|status` (docs/feat/voice-dictation.md T10).
 *
 * The dispatch only: which verb reaches what, and that a bad verb is a usage
 * ERROR rather than a silent success. The helper itself is a Swift binary, so it
 * is injected — no child process runs in `bun test`.
 */

function deps(over: Partial<Parameters<typeof voiceCommand>[1]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const runs: { path: string; args: readonly string[] }[] = [];
  return {
    out,
    err,
    runs,
    base: {
      configDir: "/Users/me/.config/tentacle",
      execPath: "/Users/me/bin/tentacle",
      config: { ...VOICE_DEFAULTS, helperPath: "/Users/me/bin/tentacle-voice" },
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
      runHelper: async (path: string, args: readonly string[]) => {
        runs.push({ path, args });
        return 0;
      },
      exists: () => true,
      platform: "darwin",
      ...over,
    },
  };
}

describe("T10: the verbs reach the helper", () => {
  test("`setup` runs the helper's setup mode", async () => {
    const d = deps();
    expect(await voiceCommand(["setup"], d.base)).toBe(0);
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0]?.args[0]).toBe("setup");
    expect(d.runs[0]?.path).toBe("/Users/me/bin/tentacle-voice");
  });

  test("`setup --yes` passes the confirmation through, so it never prompts inside a script", async () => {
    const d = deps();
    await voiceCommand(["setup", "--yes"], d.base);
    expect(d.runs[0]?.args).toContain("--yes");
  });

  test("`status` runs the helper's status mode with the configured engine", async () => {
    const d = deps();
    await voiceCommand(["status"], d.base);
    expect(d.runs[0]?.args[0]).toBe("status");
    expect(d.runs[0]?.args).toContain("--engine");
    expect(d.runs[0]?.args).toContain("apple");
  });

  test("a configured modelsDir travels to both verbs", async () => {
    const d = deps();
    await voiceCommand(["setup"], {
      ...d.base,
      config: { ...VOICE_DEFAULTS, helperPath: "/h", modelsDir: "/m" },
    });
    expect(d.runs[0]?.args).toContain("--models-dir");
    expect(d.runs[0]?.args).toContain("/m");
  });

  test("the helper's own exit code is the command's", async () => {
    const d = deps({ runHelper: async () => 7 });
    expect(await voiceCommand(["status"], d.base)).toBe(7);
  });
});

describe("T10: a bad verb is a usage error", () => {
  test("no verb at all", async () => {
    const d = deps();
    expect(await voiceCommand([], d.base)).toBe(1);
    expect(d.err.join("")).toContain("missing argument");
    expect(d.err.join("")).toContain(VOICE_USAGE);
    expect(d.runs).toEqual([]);
  });

  test("an unknown verb", async () => {
    const d = deps();
    expect(await voiceCommand(["download"], d.base)).toBe(1);
    expect(d.err.join("")).toContain("unknown argument");
    expect(d.runs).toEqual([]);
  });

  test("a stray word after `status`", async () => {
    const d = deps();
    expect(await voiceCommand(["status", "extra"], d.base)).toBe(1);
    expect(d.err.join("")).toContain("unexpected argument");
    expect(d.runs).toEqual([]);
  });
});

describe("T10 (F3): a missing helper says how to build it", () => {
  test("nothing found: an error naming the build command, and no spawn", async () => {
    const d = deps({ exists: () => false });
    expect(await voiceCommand(["status"], d.base)).toBe(1);
    expect(d.err.join("")).toContain("tentacle-voice");
    expect(d.err.join("")).toContain("bun run voice:build");
    // A user who installed the binary has no repo to build in: the installer ships it.
    expect(d.err.join("")).toContain("curl -fsSL tentacle.so/install | sh");
    expect(d.runs).toEqual([]);
  });

  test("the search order is reported, so the user can see where to put it", async () => {
    const d = deps({ exists: () => false });
    await voiceCommand(["setup"], d.base);
    expect(d.err.join("")).toContain("/Users/me/.config/tentacle/voice/bin/tentacle-voice");
  });
});

describe("feat/voice-off-by-default: `status` reports the switch, and how to flip it", () => {
  test("off: the status output names the opt-in (default: no voice block at all)", async () => {
    // Mutation: drop the status line from `voiceCommand` → red. A user runs
    // `status` precisely when voice is NOT working, so it is the place that must
    // say the switch exists.
    const d = deps();
    expect(
      await voiceCommand(["status"], {
        ...d.base,
        config: { ...VOICE_DEFAULTS, helperPath: "/h" },
      }),
    ).toBe(0);
    const printed = d.out.join("");
    expect(printed).toContain("disabled");
    expect(printed).toContain('"enabled": true');
  });

  test("on: it says enabled, and still runs the helper's own status", async () => {
    const d = deps();
    await voiceCommand(["status"], {
      ...d.base,
      config: { ...VOICE_DEFAULTS, enabled: true, helperPath: "/h" },
    });
    expect(d.out.join("")).toContain("enabled");
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0]?.args[0]).toBe("status");
  });

  test("`setup` prints no voice-status line (it is not a status command)", async () => {
    const d = deps();
    await voiceCommand(["setup"], d.base);
    expect(d.out.join("")).not.toContain('"enabled": true');
  });
});

describe("T10: another platform is refused honestly", () => {
  test("linux: a plain message, not a crash and not a silent success", async () => {
    const d = deps({ platform: "linux" });
    expect(await voiceCommand(["setup"], d.base)).toBe(1);
    expect(d.err.join("")).toContain("macOS");
    expect(d.runs).toEqual([]);
  });
});

/**
 * Fix round 1 (Review MEDIUM 7): `ARGS.voice` declares `--yes` a BOOL, so the
 * parser takes it out of `positional` — reading only positionals silently
 * dropped it and `setup` prompted anyway.
 */
describe("Fix 2 (MEDIUM 7): `setup --yes` is not lost in the parser", () => {
  test("the parser's bool arrives as `yes` and reaches the helper", async () => {
    // Mutation: revert to reading `rest.includes("--yes")` only → red.
    const parsed = parseArgs(["setup", "--yes"], ARGS.voice);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.positional).toEqual(["setup"]);
    expect(parsed.bools.has("yes")).toBe(true);
    const d = deps();
    await voiceCommand(parsed.positional, {
      ...d.base,
      ...(parsed.bools.has("yes") ? { yes: true } : {}),
    });
    expect(d.runs[0]?.args).toContain("--yes");
  });

  test("without `--yes` the helper is NOT told to skip the confirmation", async () => {
    const parsed = parseArgs(["setup"], ARGS.voice);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const d = deps();
    await voiceCommand(parsed.positional, d.base);
    expect(d.runs[0]?.args).not.toContain("--yes");
  });
});

/**
 * Fix round 1 (MEDIUM 7), the LAST link: `main` is the only place that can turn
 * the parser's `bools` into the dependency, and `voiceCommand` is reached with
 * `parsed.positional` alone — so a hand-driven call cannot see it. Pinned as
 * text, like `wiring.test.ts`'s single-broker guard (there is no seam that sees
 * the deps object from `main`, and adding one for a bool is ceremony).
 */
describe("Fix 2 (MEDIUM 7), pinned at the call site", () => {
  test("`main` hands the parser's `--yes` to `voiceCommand`", async () => {
    // Mutation: delete this line → `tentacle voice setup --yes` prompts anyway.
    const main = await Bun.file(`${import.meta.dir}/../src/main.ts`).text();
    const block = main.slice(main.indexOf('if (mode === "voice") {'));
    const call = block.slice(0, block.indexOf("});") + 3);
    expect(call).toContain("runHelper: runHelperInherited,");
    expect(call).toMatch(/\.\.\.\(parsed\.bools\.has\("yes"\) \? \{ yes: true \} : \{\}\),/);
  });
});
