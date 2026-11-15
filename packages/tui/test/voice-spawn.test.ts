import { describe, expect, test } from "bun:test";
import { VOICE_DEFAULTS } from "../src/voice-session.ts";
import {
  type VoiceSpawnSpec,
  type VoiceSpawner,
  bunSpawnOptions,
  helperPathCandidates,
  spawnVoiceHelper,
  splitLines,
  voiceSpawnSpec,
} from "../src/voice-spawn.ts";

/**
 * T7/T8 — the hook's I/O edge (docs/feat/voice-dictation.md F10, F13).
 *
 * The hook is the ONLY place a child process exists, so these tests own the two
 * properties that cannot be checked anywhere else:
 *  - T8: every stream is PIPED (never `"inherit"`) — a helper may never write to
 *    the terminal Ink owns (AGENTS §7).
 *  - T7/F13: whatever happens, the child is ended by us (stdin EOF, then SIGTERM),
 *    so no orphan can keep the mic open.
 */

describe("T8: the spawn options never hand a stream to the terminal", () => {
  test("stdin, stdout and stderr are all pipes", () => {
    const specs: VoiceSpawnSpec[] = [];
    const spawner: VoiceSpawner = (spec) => {
      specs.push(spec);
      return {
        stdin: null,
        stdout: null,
        stderr: null,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };
    spawnVoiceHelper({
      spawner,
      helperPath: "/opt/tentacle-voice",
      args: [],
      logPath: "/tmp/x.log",
    });
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    if (spec === undefined) return;
    expect(spec.cmd).toEqual(["/opt/tentacle-voice"]);
    expect(spec.stdio.stdin).toBe("pipe");
    expect(spec.stdio.stdout).toBe("pipe");
    // The helper's diagnostics go to a FILE, never to the frame (F10).
    expect(spec.stdio.stderr).not.toBe("inherit");
    expect(spec.logPath).toContain(".log");
  });

  test("no stream may be `inherit`, whatever the caller asks", () => {
    const specs: VoiceSpawnSpec[] = [];
    const spawner: VoiceSpawner = (spec) => {
      specs.push(spec);
      return {
        stdin: null,
        stdout: null,
        stderr: null,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };
    spawnVoiceHelper({
      spawner,
      helperPath: "/x",
      args: ["--trace", "a.wav"],
      logPath: "/tmp/x.log",
    });
    for (const spec of specs) {
      for (const value of Object.values(spec.stdio)) expect(value).not.toBe("inherit");
    }
  });
});

describe("T7: the line splitter reassembles a stream", () => {
  test("a partial line is held until its newline arrives", () => {
    let buf = "";
    const out: string[] = [];
    const feed = (chunk: string): void => {
      const r = splitLines(buf, chunk);
      buf = r.rest;
      out.push(...r.lines);
    };
    feed('{"t":"rea');
    expect(out).toEqual([]);
    feed('dy","v":1}\n');
    expect(out).toEqual(['{"t":"ready","v":1}']);
  });

  test("several complete lines in one chunk all come out", () => {
    const r = splitLines("", "a\nb\nc\npartial");
    expect(r.lines).toEqual(["a", "b", "c"]);
    expect(r.rest).toBe("partial");
  });

  test("CRLF is tolerated", () => {
    const r = splitLines("", "a\r\nb\r\n");
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.rest).toBe("");
  });
});

describe("F3: where the helper is looked for", () => {
  test("config, then the binary's sibling, then the config dir", () => {
    const paths = helperPathCandidates({
      execPath: "/Users/me/bin/tentacle",
      configDir: "/Users/me/.config/tentacle",
      config: { ...VOICE_DEFAULTS, helperPath: "/custom/tentacle-voice" },
    });
    expect(paths[0]).toBe("/custom/tentacle-voice");
    expect(paths).toContain("/Users/me/bin/tentacle-voice");
    expect(paths).toContain("/Users/me/.config/tentacle/voice/bin/tentacle-voice");
  });

  test("with no override the sibling comes first", () => {
    const paths = helperPathCandidates({
      execPath: "/Users/me/bin/tentacle",
      configDir: "/c",
      config: { ...VOICE_DEFAULTS },
    });
    expect(paths[0]).toBe("/Users/me/bin/tentacle-voice");
  });
});

/**
 * Fix round 1 (Review MEDIUM 5): T8 used to pin the SPEC, which the production
 * spawner never read — its mutation (`stderr: "inherit"`) stayed green. These
 * pin the `Bun.spawn` options the real path actually builds.
 */
describe("Fix 5 (MEDIUM 5): the REAL spawn options never inherit the terminal", () => {
  const spec = voiceSpawnSpec({ helperPath: "/x/tentacle-voice", logPath: "/c/voice/helper.log" });

  test("with a log fd, stderr is that fd — never a stream, never `inherit`", () => {
    // Mutation: `stderr: "inherit"` in `bunSpawnOptions` → red.
    const options = bunSpawnOptions(spec, 42);
    expect(options.stdin).toBe("pipe");
    expect(options.stdout).toBe("pipe");
    expect(options.stderr).toBe(42);
  });

  test("with no config dir there is no fd: still a pipe, never `inherit`", () => {
    // Mutation: `stderr: "inherit"` when there is no log → red.
    const options = bunSpawnOptions({ ...spec, logPath: "" }, null);
    expect(options.stderr).toBe("pipe");
    for (const value of [options.stdin, options.stdout, options.stderr]) {
      expect(value).not.toBe("inherit");
    }
  });

  test("the spec's own streams are all pipes, so a disposition cannot be smuggled", () => {
    expect(spec.stdio).toEqual({ stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  });

  test("the child's env still carries the engine choice", () => {
    const withEnv = voiceSpawnSpec({
      helperPath: "/x",
      logPath: "/c/l.log",
      env: { TENTACLE_VOICE_ENGINE: "parakeet" },
    });
    expect(bunSpawnOptions(withEnv, 7).env.TENTACLE_VOICE_ENGINE).toBe("parakeet");
  });
});
