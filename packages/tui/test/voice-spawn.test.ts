import { describe, expect, test } from "bun:test";
import { defaultSpawner as hookDefaultSpawner } from "../src/useVoice.ts";
import { VOICE_DEFAULTS } from "../src/voice-session.ts";
import {
  LOG_ROTATE_BYTES,
  type LogFs,
  type VoiceSpawnSpec,
  type VoiceSpawner,
  bunSpawnOptions,
  helperPathCandidates,
  makeDefaultSpawner,
  openVoiceLog,
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
 * Fix round 2 (M5, re-checked): round 1's test pinned `bunSpawnOptions`, but the
 * production spawn passed HARDCODED streams to `Bun.spawn`, so mutating the
 * options stayed GREEN. The spawner now takes the `Bun.spawn` call as a seam;
 * these drive the REAL spawner and assert what it hands that call.
 */
describe("Fix round 2 (M5): the real spawner consumes the spec into Bun.spawn", () => {
  const fakeProc = () => ({
    stdin: { write: () => {}, end: () => {} },
    stdout: new ReadableStream<Uint8Array>(),
    // A log fd took stderr, so Bun hands the child no stream for it.
    stderr: undefined,
    exited: Promise.resolve(0),
    kill: () => {},
  });

  test("stdin/stdout/stderr come from the spec, never `inherit`", () => {
    // Mutation: hardcode `stderr: "inherit"` in the spawn call → red.
    const seen: unknown[] = [];
    const spawn = (cmd: readonly string[], options: unknown) => {
      seen.push({ cmd, options });
      return fakeProc() as never;
    };
    const spawner = makeDefaultSpawner(spawn, fakeLogFs());
    const child = spawner(
      voiceSpawnSpec({ helperPath: "/x/tentacle-voice", logPath: "/c/voice/helper.log" }),
    );
    expect(seen).toHaveLength(1);
    const first = seen[0] as {
      cmd: readonly string[];
      options: { stdin: unknown; stdout: unknown; stderr: unknown };
    };
    expect(first.cmd).toEqual(["/x/tentacle-voice"]);
    expect(first.options.stdin).toBe("pipe");
    expect(first.options.stdout).toBe("pipe");
    // The stderr disposition is the log fd `openVoiceLog` returned…
    expect(typeof first.options.stderr).toBe("number");
    expect(first.options.stderr).not.toBe("inherit");
    // …and the child's own handle carries no raw stream back to the caller.
    expect(child.stderr).toBeNull();
  });

  test("the log's directory is created BEFORE it is opened, and a big log is rotated", () => {
    // Review round 2, NEW-2: no `mkdir` meant ENOENT on a fresh config dir, which
    // was then reported as "helper not found". Mutation: drop the `mkdir` call →
    // red on the order; drop the rotation → red on the rename.
    const order: string[] = [];
    const fs: LogFs = {
      mkdir: (dir) => {
        order.push(`mkdir ${dir}`);
      },
      size: () => {
        order.push("size");
        return LOG_ROTATE_BYTES;
      },
      rotate: (path) => {
        order.push(`rotate ${path}`);
      },
      open: (path) => {
        order.push(`open ${path}`);
        return 7;
      },
    };
    expect(openVoiceLog("/c/voice/helper.log", fs)).toBe(7);
    expect(order).toEqual([
      "mkdir /c/voice",
      "size",
      "rotate /c/voice/helper.log",
      "open /c/voice/helper.log",
    ]);
  });

  test("no config dir means no file at all (no fd, no mkdir)", () => {
    const calls: string[] = [];
    const fs: LogFs = {
      mkdir: () => {
        calls.push("mkdir");
      },
      size: () => {
        calls.push("size");
        return null;
      },
      rotate: () => {
        calls.push("rotate");
      },
      open: () => {
        calls.push("open");
        return 1;
      },
    };
    expect(openVoiceLog("", fs)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a small log is not rotated", () => {
    const calls: string[] = [];
    const fs: LogFs = {
      mkdir: () => {},
      size: () => 12,
      rotate: () => {
        calls.push("rotate");
      },
      open: () => 3,
    };
    expect(openVoiceLog("/c/voice/helper.log", fs)).toBe(3);
    expect(calls).toEqual([]);
  });

  test("the PRODUCTION spawner hands Bun.spawn the spec's streams (not `inherit`)", () => {
    // The real `defaultSpawner` object, driven with `Bun.spawn` replaced. This is
    // the pin round 1 lacked: its `bunSpawnProc` hardcoded the streams, so the
    // spec's mutation stayed green.
    // Mutation: hardcode `stderr: "inherit"` (or any stream) inside the
    // production spawn → red here, on the options this call actually received.
    const realSpawn = Bun.spawn;
    const seen: { stdin: unknown; stdout: unknown; stderr: unknown }[] = [];
    Bun.spawn = ((_cmd: unknown, options: { stdin: unknown; stdout: unknown; stderr: unknown }) => {
      seen.push(options);
      return {
        stdin: { write: () => {}, end: () => {} },
        stdout: new ReadableStream<Uint8Array>(),
        // No stream: the log fd took stderr, so Bun gives the child nothing.
        stderr: undefined,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as never;
    try {
      const child = hookDefaultSpawner(
        voiceSpawnSpec({ helperPath: "/x/tentacle-voice", logPath: "" }),
      );
      expect(seen).toHaveLength(1);
      const options = seen[0] ?? { stdin: null, stdout: null, stderr: null };
      expect(options.stdin).toBe("pipe");
      expect(options.stdout).toBe("pipe");
      // No config dir → no fd → still a PIPE, drained by the spawner. Never a
      // terminal: `"inherit"` in either place would paint over Ink's frame.
      expect(options.stderr).toBe("pipe");
      // The caller never receives a raw stderr stream to leak.
      expect(child.stderr).toBeNull();
    } finally {
      Bun.spawn = realSpawn;
    }
  });
});

/** The log fs a spawn test asserts against: records nothing, opens fd 9. */
function fakeLogFs(): LogFs {
  return {
    mkdir: () => {},
    size: () => null,
    rotate: () => {},
    open: () => 9,
  };
}

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
