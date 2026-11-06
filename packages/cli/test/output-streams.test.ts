// docs/fix/cli-output-streams.md: STDOUT carries only the data a command
// produces; everything else outside Ink goes to STDERR. Each test pins, per
// command, which stream every line uses — through `main`'s `out`/`err` seams.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHost } from "../src/engine-host.ts";
import { provisionWorkload } from "../src/engine-runtime.ts";
import { main } from "../src/index.ts";
import { type OwnerRecord, RUN_STATE_VERSION, readSpec, writeOwner } from "../src/run-state.ts";
import { simulateSilentTerminal } from "./silent-terminal.ts";

/** A docker host whose workload never gets ready: setup fails after its first phase. */
const neverReady = (): EngineHost =>
  ({
    noun: "container",
    where: "docker",
    create: async () => {},
    waitForReady: async () => {
      throw new Error("not ready");
    },
    remove: async () => {},
    removeBestEffort: () => {},
  }) as unknown as EngineHost;

function sse(events: unknown[]): string {
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** Turn 1: a tool call (the trace); turn 2: the answer, in two deltas. */
const TOOL_TURN = sse([
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: {
                name: "fs_write",
                arguments: JSON.stringify({ path: "a.txt", content: "x" }),
              },
            },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
]);
const ANSWER_TURN = sse([
  { choices: [{ delta: { content: "The answer " } }] },
  { choices: [{ delta: { content: "is 42." } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
]);

let server: ReturnType<typeof Bun.serve>;
let dir: string;
let calls = 0;
const saved: Record<string, string | undefined> = {};
let restoreTerminal: () => void = () => {};

beforeAll(async () => {
  restoreTerminal = simulateSilentTerminal();
  dir = await mkdtemp(join(tmpdir(), "tentacle-streams-"));
  server = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      return new Response(calls % 2 === 1 ? TOOL_TURN : ANSWER_TURN, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  for (const key of ["TENTACLE_CONFIG_DIR", "TENTACLE_MODEL_BASE_URL", "TENTACLE_MODEL"]) {
    saved[key] = process.env[key];
  }
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  process.env.TENTACLE_MODEL_BASE_URL = `http://localhost:${server.port}/v1`;
  process.env.TENTACLE_MODEL = "test";
});

afterAll(async () => {
  restoreTerminal();
  server.stop(true);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  await rm(dir, { recursive: true, force: true });
});

/** `main` with both streams captured apart. */
async function capture(
  args: readonly string[],
  over: Parameters<typeof main>[1] = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["bun", "cli", ...args], {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    terminal: { stdin: false, stdout: false },
    ...over,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("one-shot (D5): the answer alone on stdout, the trace on stderr", () => {
  test("stdout is exactly the answer; [tool]/[diff] go to stderr", async () => {
    // Mutation: route every event to `out` → stdout carries `[tool] fs_write`.
    const launch = process.cwd();
    process.chdir(dir);
    let r: Awaited<ReturnType<typeof capture>>;
    try {
      calls = 0;
      r = await capture(["write", "a.txt"]);
    } finally {
      process.chdir(launch);
    }
    expect(r.code).toBe(0);
    expect(r.out).toBe("The answer is 42.\n");
    expect(r.err).toContain("[tool] fs_write");
    expect(r.err).toContain("[diff] a.txt");
    expect(r.err).not.toContain("The answer");
  });
});

describe("errors and usage (D6): stderr for every command; stdout empty", () => {
  for (const args of [
    ["ps", "--engine", "bad"],
    ["ps", "-q", "--engine", "bad"],
    ["ps", "--nope"],
    ["rm"],
    ["hooks", "trust"],
    ["package", "bogus"],
    ["attach"],
    ["run", "--engine", "docker"],
    ["serve", "--nope"],
  ]) {
    test(`tentacle ${args.join(" ")}`, async () => {
      const r = await capture(args);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/\[error\]|usage:|--image <ref> is required/);
    });
  }

  test("no prompt and no terminal: the help is the error's, on stderr (exit 1)", async () => {
    const r = await capture([]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("Usage:");
  });

  test("an explicit --help / --version is data: stdout, exit 0, nothing on stderr", async () => {
    for (const args of [
      ["--help"],
      ["-h"],
      ["--version"],
      ["ps", "--help"],
      ["--model", "m", "--version"],
    ]) {
      const r = await capture(args);
      expect([args.join(" "), r.code, r.err]).toEqual([args.join(" "), 0, ""]);
      expect(r.out).toMatch(/Usage:|^tentacle \S+\n$/);
    }
  });
});

describe("ps (data on stdout only)", () => {
  test("an unreadable kept-index file is said on stderr; the table alone on stdout", async () => {
    // Mutation: report index problems on `out` in non-quiet `ps` → stdout's first line is the note.
    const kept = join(dir, "config", "kept");
    await mkdir(kept, { recursive: true });
    await writeFile(join(kept, "broken.json"), "{not json");
    try {
      for (const args of [["ps"], ["ps", "-q"]]) {
        const r = await capture(args);
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("kept index");
        expect(r.err).toContain("kept index:");
      }
      const table = await capture(["ps"]);
      expect(table.out.split("\n")[0]).toMatch(/^NAME/);
    } finally {
      await rm(kept, { recursive: true, force: true });
    }
  });
});

describe("serve (D2): every line is a log, on stderr", () => {
  test("listening, audit, notice and error lines: stdout empty", async () => {
    let stop = (): void => {};
    const done = capture(["serve"], {
      startDaemon: async (_config, options) => {
        options.onAudit?.("audit line");
        options.onNotice?.("notice line");
        options.onError?.(new Error("boom"));
        queueMicrotask(() => {
          stop = () => void process.emit("SIGINT");
        });
        return { url: "ws://127.0.0.1:1", stop: async () => {} } as unknown as Awaited<
          ReturnType<NonNullable<Parameters<typeof main>[1]>["startDaemon"] & {}>
        >;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("daemon listening on ws://127.0.0.1:1");
    expect(r.err).toContain("[daemon] audit line");
    expect(r.err).toContain("[daemon] error: boom");
  });
});

describe("run --detach (D1): the name on stdout only when stdout is not a terminal", () => {
  const base = ["run", "--engine", "docker", "--no-mount", "--image", "x"];
  const owned = (sessionId: string): OwnerRecord => ({
    schemaVersion: RUN_STATE_VERSION,
    kind: "relay",
    pid: 9,
    appVersion: "1",
    sessionId,
    state: "running",
    lastActivityAt: 1,
    autoAccept: false,
  });
  const detached = (outTty: boolean | undefined, fail = false) =>
    capture([...base, "--detach", "--prompt", "hi", "--name", "box"], {
      ...(outTty !== undefined ? { outTty } : {}),
      colour: false,
      provisionWorkload: async (_config, deps) => {
        deps.recordKept?.("box");
        deps.info?.("[container] box still running · tentacle attach box\n");
        return {
          name: "box",
          binPath: "/usr/local/bin/tentacle",
          removeUnlessKept: () => {},
          announce: () => {},
        };
      },
      spawnRelay: (file, _cwd, runDir) => {
        const spec = readSpec(file);
        if (!fail) {
          writeOwner(runDir, owned(spec.sessionId));
        }
        return { exited: () => fail };
      },
    });

  test("piped: stdout === the name; the `still running` line on stderr", async () => {
    // Mutation: print the name whatever stdout is → the TTY case below fails;
    // print it on `err` → this one fails.
    try {
      const r = await detached(undefined);
      expect(r.code).toBe(0);
      expect(r.out).toBe("box\n");
      expect(r.err).toContain("still running");
    } finally {
      await rm(join(dir, "config", "kept"), { recursive: true, force: true });
      await rm(join(dir, "config", "runs"), { recursive: true, force: true });
    }
  });

  test("on a terminal: nothing on stdout; a failed launch: no name either", async () => {
    try {
      const tty = await detached(true);
      expect(tty.code).toBe(0);
      expect(tty.out).toBe("");
      expect(tty.err).toContain("still running");
    } finally {
      await rm(join(dir, "config", "kept"), { recursive: true, force: true });
      await rm(join(dir, "config", "runs"), { recursive: true, force: true });
    }
    try {
      const failed = await detached(false, true);
      expect(failed.code).toBe(1);
      expect(failed.out).toBe("");
      expect(failed.err).toContain("the detached run did not start");
    } finally {
      await rm(join(dir, "config", "kept"), { recursive: true, force: true });
      await rm(join(dir, "config", "runs"), { recursive: true, force: true });
    }
  });
});

describe("colour follows stderr (the stream the styled lines are written to)", () => {
  test("`info` lines are grey on stderr when `colour` is on; stdout never carries escapes", async () => {
    // Mutation: style `info` by the stdout's facts → `colour:false` still grey, or out grey.
    const run = (colour: boolean) =>
      capture([...["run", "--engine", "docker", "--no-mount", "--image", "x"], "--name", "box"], {
        colour,
        startEngineRuntime: async (_config, deps) => {
          deps.info?.("[container] creating box\n");
          throw new Error("stop here");
        },
      });
    const on = await run(true);
    expect(on.err).toContain("\x1b[90m[container] creating box\x1b[39m\n");
    expect(on.out).toBe("");
    const off = await run(false);
    expect(off.err).toContain("[container] creating box\n");
    expect(off.err).not.toContain("\x1b[");
  });
});

describe("the startup spinner follows the terminal `log` writes to (stderr)", () => {
  const HIDE_CURSOR = "\x1b[?25l";
  /** `run --detach` through the REAL provisioner on a host that never gets ready. */
  const provision = (logTerm?: { tty: boolean; columns: () => number | undefined }) =>
    capture(
      ["run", "--engine", "docker", "--no-mount", "--image", "x", "--detach", "--prompt", "hi"],
      {
        colour: false,
        provisionWorkload: (config, deps) =>
          provisionWorkload(config, {
            ...deps,
            host: neverReady(),
            appVersion: "dev",
            ...(logTerm ? { logTerm } : {}),
          }),
      },
    );

  test("a terminal `log`: one repainted line (cursor hidden), never on stdout", async () => {
    // Mutation: gate the StatusLine on `process.stdout.isTTY` again → no spinner here.
    try {
      const r = await provision({ tty: true, columns: () => 80 });
      expect(r.code).toBe(1);
      expect(r.err).toContain(HIDE_CURSOR);
      expect(r.out).toBe("");
    } finally {
      await rm(join(dir, "config", "kept"), { recursive: true, force: true });
    }
  });

  test("an injected `err` is never a terminal, even with a real TTY stderr: one line per phase", async () => {
    // Mutation: `main` stops handing `logTerm: errTerm` → the runtime reads the
    // (faked) TTY stderr and paints a spinner into the captured `err`.
    const real = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    try {
      const r = await provision();
      expect(r.code).toBe(1);
      expect(r.err).not.toContain(HIDE_CURSOR);
      expect(r.err).toMatch(/\[container\] creating \S+ \(image x\)/);
      expect(r.out).toBe("");
    } finally {
      if (real) {
        Object.defineProperty(process.stderr, "isTTY", real);
      } else {
        Reflect.deleteProperty(process.stderr, "isTTY");
      }
      await rm(join(dir, "config", "kept"), { recursive: true, force: true });
    }
  });
});
