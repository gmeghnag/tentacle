import { describe, expect, test } from "bun:test";
import { VOICE_DEFAULTS } from "@tentacle/tui";
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
    expect(d.runs).toEqual([]);
  });

  test("the search order is reported, so the user can see where to put it", async () => {
    const d = deps({ exists: () => false });
    await voiceCommand(["setup"], d.base);
    expect(d.err.join("")).toContain("/Users/me/.config/tentacle/voice/bin/tentacle-voice");
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
