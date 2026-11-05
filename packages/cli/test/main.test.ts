import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord, projectKey } from "@tentacle/agent";
import { DELETE_CONTAINER_SUBCOMMAND } from "@tentacle/docker";
import { DELETE_POD_SUBCOMMAND } from "@tentacle/k8s";
import { type EngineHost, WorkloadNotFoundError } from "../src/engine-host.ts";
import { provisionWorkload } from "../src/engine-runtime.ts";
import { main } from "../src/index.ts";
import { keptDir as keptIndexDir, readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import {
  type OwnerRecord,
  RELAY_SUBCOMMAND,
  type RelaySpec,
  ensureRunDir,
  laptopProc,
  readSpec,
  runDirFor,
  writeOwner,
} from "../src/run-state.ts";

// End-to-end: a fake OpenAI-compatible server scripts a two-turn conversation —
// turn 1 calls the `fs_write` tool, turn 2 replies with text — exercising the
// full stack: CLI → agent loop → provider → tool registry → host execution.

function sse(events: unknown[]): string {
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
}

const TURN1 = sse([
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_write",
              function: {
                name: "fs_write",
                arguments: JSON.stringify({ path: "out.txt", content: "hello from agent" }),
              },
            },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
]);

const TURN2 = sse([
  { choices: [{ delta: { content: "Done. File written." } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
]);

/**
 * STDOUT of the scenarios whose capture reads STDERR (run/attach setup, refusals,
 * errors): none of them produces data, so after each test it must be empty
 * (docs/fix/cli-output-streams.md). Emptied before the check, so one failure
 * does not cascade.
 */
const strayStdout: string[] = [];
afterEach(() => {
  const seen = strayStdout.splice(0);
  expect(seen).toEqual([]);
});

let server: ReturnType<typeof Bun.serve>;
let dir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-cli-"));
  let calls = 0;
  server = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      const body = calls === 1 ? TURN1 : TURN2;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  for (const key of [
    "TENTACLE_CONFIG_DIR",
    "TENTACLE_MODEL_BASE_URL",
    "TENTACLE_MODEL",
    "TENTACLE_MODEL_API_KEY",
  ]) {
    saved[key] = process.env[key];
  }
  // Point the config dir at the temp dir so first-run scaffolding never
  // touches the real ~/.config.
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  process.env.TENTACLE_MODEL_BASE_URL = `http://localhost:${server.port}/v1`;
  process.env.TENTACLE_MODEL = "test";
  process.env.TENTACLE_MODEL_API_KEY = undefined;
});

afterAll(async () => {
  server.stop(true);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(dir, { recursive: true, force: true });
});

describe("cli main (end-to-end)", () => {
  test("runs a tool call and writes the file, then prints the reply", async () => {
    const out: string[] = [];
    const err: string[] = [];
    // The workspace is the launch directory (no TENTACLE_CWD): launch from `dir`.
    const launch = process.cwd();
    process.chdir(dir);
    let code: number;
    try {
      code = await main(["bun", "cli", "create out.txt"], {
        out: (t) => out.push(t),
        err: (t) => err.push(t),
      });
    } finally {
      process.chdir(launch);
    }
    const trace = err.join("");

    expect(code).toBe(0);
    // docs/fix/cli-output-streams.md D5: the answer alone on stdout, the trace on stderr.
    expect(trace).toContain("[tool] fs_write");
    expect(trace).toContain("[diff] out.txt");
    expect(out.join("")).toBe("Done. File written.\n");
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("hello from agent");
  });

  test("prints help and exits non-zero with no prompt", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["bun", "cli"], {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });
    expect(code).toBe(1);
    // An error's help: stderr (D6).
    expect(err.join("")).toContain("Usage:");
    expect(out).toEqual([]);
  });

  test("attach without a pod name prints usage and exits non-zero", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["bun", "cli", "attach"], {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("usage: tentacle attach <name>");
    expect(out).toEqual([]);
  });

  test("--version prints the version and exits 0 without touching config", async () => {
    // Point the config dir at a FRESH, non-existent path: if `--version` ever
    // loaded config it would scaffold this directory (first-run side effect).
    const freshConfigDir = join(dir, "config-never-created");
    const saved = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = freshConfigDir;
    try {
      const out: string[] = [];
      const code = await main(["bun", "cli", "--version"], { out: (t) => out.push(t) });
      expect(code).toBe(0);
      expect(out.join("")).toMatch(/^tentacle \S+\n$/);
      // Config was never loaded: no scaffolding happened.
      let exists = true;
      try {
        await readFile(freshConfigDir, "utf8");
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    } finally {
      process.env.TENTACLE_CONFIG_DIR = saved;
    }
  });
});

describe("cli main: skill diagnostics", () => {
  test("printed once to stderr where this config builds the agent; not for run/attach", async () => {
    const badDir = join(dir, "config", "skills", "bad");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "SKILL.md"), "---\nname: bad\n---\nbody\n");
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
      expect(await main(["bun", "cli"], io)).toBe(1); // help path: config loaded locally
      // stderr also carries that error's help (D6): only the `[skills]` lines are counted.
      const skills = () => err.filter((l) => l.startsWith("[skills]"));
      expect(skills()).toEqual([
        `[skills] skipped skill at ${join(badDir, "SKILL.md")}: no description\n`,
      ]);
      expect(out.join("")).not.toContain("[skills]"); // never on stdout

      err.length = 0;
      expect(await main(["bun", "cli", "run"], io)).toBe(1); // no --image: fails after config
      expect(skills()).toEqual([]); // a pod session uses the pod's skills
    } finally {
      await rm(join(dir, "config", "skills"), { recursive: true, force: true });
    }
  });
});

describe("cli main: agent definition diagnostics (fix/agent-defs-warn)", () => {
  test("a dropped model/contextWindow warns to stderr, never stdout; not for run/attach", async () => {
    const agents = join(dir, "config", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "reviewer.md"),
      "---\nname: reviewer\nmodel: [oops]\ncontextWindow: abc\n---\nYou review.\n",
    );
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
      expect(await main(["bun", "cli"], io)).toBe(1); // help path: config loaded locally
      // stderr also carries that error's help (D6): only the `[agents]` lines are counted.
      const agentLines = () => err.filter((l) => l.startsWith("[agents]"));
      expect(agentLines()).toEqual([
        `[agents] agent "reviewer" (${join(agents, "reviewer.md")}): model [oops] ignored — expected a non-empty string\n`,
        `[agents] agent "reviewer" (${join(agents, "reviewer.md")}): contextWindow "abc" ignored — expected a positive whole number of tokens\n`,
      ]);
      expect(out.join("")).not.toContain("[agents]"); // never on stdout

      err.length = 0;
      expect(await main(["bun", "cli", "run"], io)).toBe(1); // no --image: fails after config
      expect(agentLines()).toEqual([]); // a pod session uses the pod's agent defs
    } finally {
      await rm(agents, { recursive: true, force: true });
    }
  });
});

// The exit net's compiled child re-runs THIS binary with a hidden subcommand
// (B Review finding 1): the dispatch must exist for the SAME constant the
// command builders use, or a rename orphans every workload silently.
describe("cli main: hidden exit-net subcommands (docs/feat/docker-engine-cli.md)", () => {
  for (const sub of [DELETE_POD_SUBCOMMAND, DELETE_CONTAINER_SUBCOMMAND]) {
    test(`${sub}: dispatched before config — exit 0, no output, nothing scaffolded`, async () => {
      // With no delete env the child has nothing to do; an undispatched word
      // would instead become a one-shot prompt (config scaffolded + output).
      const freshConfigDir = join(dir, `config-${sub}`);
      const saved = process.env.TENTACLE_CONFIG_DIR;
      process.env.TENTACLE_CONFIG_DIR = freshConfigDir;
      // Launch from the temp dir: if the dispatch regresses, the prompt's scripted
      // `fs_write` lands there, never in the repo checkout.
      const launch = process.cwd();
      process.chdir(dir);
      try {
        const out: string[] = [];
        const err: string[] = [];
        const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
        expect(await main(["bun", "cli", sub], io)).toBe(0);
        expect({ out, err }).toEqual({ out: [], err: [] });
        expect(await Bun.file(join(freshConfigDir, "config.jsonc")).exists()).toBe(false);
      } finally {
        process.chdir(launch);
        process.env.TENTACLE_CONFIG_DIR = saved;
      }
    });
  }
});

describe("cli main: the relay's hidden subcommand (docs/feat/detached-relay.md R12)", () => {
  test("dispatched before config: no spec → exit 1 on stderr, nothing scaffolded", async () => {
    // Mutation: drop the dispatch → the word becomes a one-shot prompt.
    const freshConfigDir = join(dir, "config-relay");
    const saved = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = freshConfigDir;
    const launch = process.cwd();
    process.chdir(dir);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
      expect(await main(["bun", "cli", RELAY_SUBCOMMAND], io)).toBe(1);
      expect(out).toEqual([]);
      expect(err.join("")).toContain("TENTACLE_RELAY_SPEC");
      expect(await Bun.file(join(freshConfigDir, "config.jsonc")).exists()).toBe(false);
    } finally {
      process.chdir(launch);
      process.env.TENTACLE_CONFIG_DIR = saved;
    }
  });
});

// `--engine` end to end through `main` (docs/feat/docker-engine-cli.md): no
// engine is needed — an unreachable docker socket proves the flag reaches the
// docker host (a kubernetes path would fail on cluster auth instead).
describe("cli main: --engine", () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const prev: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      prev[key] = process.env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
  const run = async (args: string[], colour?: boolean) => {
    const out: string[] = [];
    const errs: string[] = [];
    const code = await main(["bun", "cli", ...args], {
      out: (t) => out.push(t),
      err: (t) => errs.push(t),
      ...(colour !== undefined ? { colour } : {}),
    });
    // docs/fix/cli-output-streams.md: `run`/`attach` (no `--detach`) produce no
    // data: every line they write is stderr's, whatever the outcome.
    if ((args[0] === "run" || args[0] === "attach") && !args.includes("--detach")) {
      expect(out).toEqual([]);
    }
    // `text`: stderr (every non-data line); `stdout`: the data (`ps`, `--help`).
    return { code, text: errs.join(""), stdout: out.join(""), err: errs.join("") };
  };
  // BOTH engines point nowhere: a kubernetes path must never reach the
  // developer's real kubeconfig cluster from a test (port 9 = discard, closed).
  const unreachable = {
    DOCKER_HOST: "unix:///nonexistent/tentacle-test.sock",
    TENTACLE_K8S_SERVER: "http://127.0.0.1:9",
    TENTACLE_K8S_TOKEN: undefined,
    TENTACLE_ENGINE: undefined,
  };

  test("run --engine docker → the docker host is dialled (unreachable socket → actionable failure)", async () => {
    await withEnv(unreachable, async () => {
      const { code, text } = await run([
        "run",
        "--engine",
        "docker",
        "--image",
        "debian:stable-slim",
      ]);
      expect(code).toBe(1);
      expect(text).toContain(
        "[container] failed: Docker engine socket not found at /nonexistent/tentacle-test.sock",
      );
    });
  });

  test("attach --engine docker → the same host, never a create (inspect fails first)", async () => {
    await withEnv(unreachable, async () => {
      const { code, text } = await run(["attach", "--engine", "docker", "box"]);
      expect(code).toBe(1);
      expect(text).toContain(
        "[container] attaching to box in unix:///nonexistent/tentacle-test.sock",
      );
      expect(text).toContain("[container] failed: Docker engine socket not found");
    });
  });

  test("TENTACLE_ENGINE selects the engine; the flag beats it", async () => {
    await withEnv({ ...unreachable, TENTACLE_ENGINE: "docker" }, async () => {
      const viaEnv = await run(["run", "--image", "x"]);
      expect(viaEnv.text).toContain("[container] failed: Docker engine socket not found");
      const flagWins = await run([
        "run",
        "--engine",
        "kubernetes",
        "-n",
        "dev",
        "--image",
        "x",
        "--name",
        "p1",
      ]);
      expect(flagWins.text).toContain("[pod] creating p1 (image x)");
      expect(flagWins.text).not.toContain("[container]");
    });
  });

  test("an unknown engine (flag or env) is a usage error, nothing dialled", async () => {
    await withEnv(unreachable, async () => {
      const bad = await run(["run", "--engine", "dokcer", "--image", "x"]);
      expect(bad.code).toBe(1);
      expect(bad.text).toContain(
        '[error] unknown engine "dokcer" (--engine): use kubernetes, docker or podman',
      );
      expect(bad.text).not.toContain("failed");
    });
    await withEnv({ ...unreachable, TENTACLE_ENGINE: "lxc" }, async () => {
      const bad = await run(["run", "--image", "x"]);
      expect(bad.code).toBe(1);
      expect(bad.text).toContain(
        '[error] unknown engine "lxc" (TENTACLE_ENGINE): use kubernetes, docker or podman',
      );
    });
  });

  test("an engine-specific flag on the wrong engine is a usage error", async () => {
    await withEnv(unreachable, async () => {
      const ns = await run(["run", "--engine", "docker", "-n", "dev", "--image", "x"]);
      expect(ns.code).toBe(1);
      expect(ns.text).toContain("[error] --namespace is for --engine kubernetes");
      const ctx = await run(["attach", "--engine", "kubernetes", "--context", "c", "p"]);
      expect(ctx.code).toBe(1);
      expect(ctx.text).toContain("[error] --context is for --engine docker or podman");
      const c = await run(["attach", "--engine", "podman", "-c", "side", "p"]);
      expect(c.code).toBe(1);
      expect(c.text).toContain("[error] --container is for --engine kubernetes");
    });
  });

  // `run --keep[=bool]` → `keepHint` (owner 2026-10-27): the `startEngineRuntime`
  // seam captures the deps `main` built; present `keepHint` = the workload is kept.
  describe("--keep wiring (flag > profile > user config > true)", () => {
    const keepHintFor = async (
      args: string[],
      config?: Record<string, unknown>,
      env: Record<string, string | undefined> = unreachable,
    ) => {
      const path = join(dir, "config", "config.jsonc");
      const before = (await Bun.file(path).exists()) ? await readFile(path, "utf8") : undefined;
      await mkdir(join(dir, "config"), { recursive: true });
      await writeFile(path, JSON.stringify(config ?? {}));
      let seen:
        | {
            keepHint?: (name: string) => string;
            labels?: Readonly<Record<string, string>>;
            annotations?: Readonly<Record<string, string>>;
            recordKept?: (name: string) => () => void;
          }
        | undefined;
      const out: string[] = [];
      try {
        await withEnv(env, async () => {
          await main(["bun", "cli", ...args], {
            err: (t) => out.push(t),
            out: (t) => out.push(t),
            startEngineRuntime: async (_config, deps) => {
              seen = deps;
              throw new Error("stop");
            },
          });
        });
      } finally {
        if (before === undefined) await rm(path, { force: true });
        else await writeFile(path, before);
      }
      return {
        reached: seen !== undefined,
        hint: seen?.keepHint?.("c1"),
        deps: seen,
        text: out.join(""),
      };
    };
    const base = ["run", "--engine", "docker", "--image", "x"];

    test("default is keep: a hint is built, naming the engine and the workload", async () => {
      const r = await keepHintFor(base);
      expect(r.hint).toBe("tentacle attach --engine docker c1");
    });

    test("--keep and --keep=true keep; --keep=false deletes (no hint)", async () => {
      expect((await keepHintFor([...base, "--keep"], { keep: false })).hint).toContain("attach");
      expect((await keepHintFor([...base, "--keep=true"], { keep: false })).hint).toContain(
        "attach",
      );
      const off = await keepHintFor([...base, "--keep=false"]);
      expect(off.reached).toBe(true);
      expect(off.hint).toBeUndefined();
    });

    test("--keep before the name leaves the name positional", async () => {
      const r = await keepHintFor(["run", "--engine", "docker", "--image", "x", "--keep", "box"]);
      expect(r.hint).toContain("attach");
    });

    test("user config keep:false turns it off; the flag beats it", async () => {
      expect((await keepHintFor(base, { keep: false })).hint).toBeUndefined();
      expect((await keepHintFor([...base, "--keep"], { keep: false })).hint).toContain("attach");
      expect((await keepHintFor([...base, "--keep=false"], { keep: true })).hint).toBeUndefined();
    });

    test("a profile's keep beats the user config", async () => {
      const profiles = { profiles: { p: { keep: true } } };
      const on = await keepHintFor([...base, "--profile", "p"], { keep: false, ...profiles });
      expect(on.hint).toContain("attach");
      const offProfiles = { profiles: { p: { keep: false } } };
      const off = await keepHintFor([...base, "--profile", "p"], { keep: true, ...offProfiles });
      expect(off.hint).toBeUndefined();
    });

    test("any other --keep value is a usage error, nothing started", async () => {
      const r = await keepHintFor([...base, "--keep=maybe"]);
      expect(r.reached).toBe(false);
      expect(r.text).toContain('--keep takes true or false, got "maybe"');
    });

    test("the hint repeats --insecure-docker-tcp so the re-attach is accepted", async () => {
      const r = await keepHintFor([...base, "--insecure-docker-tcp"], undefined, {
        ...unreachable,
        DOCKER_HOST: "tcp://127.0.0.1:9",
      });
      expect(r.hint).toBe("tentacle attach --engine docker --insecure-docker-tcp c1");
    });

    test("the hint repeats --bin-dir so a read-only rootfs re-attach finds the binary", async () => {
      const r = await keepHintFor([...base, "--bin-dir", "/tmp"]);
      expect(r.hint).toBe("tentacle attach --engine docker --bin-dir /tmp c1");
    });

    // Slice E (docs/feat/engine-ps-rm.md): a kept run is labelled and indexed;
    // a not-kept one is byte-identical to before (no label, no record).
    test("kept → kept label + metadata + an index record at the REAL endpoint; --keep=false → none", async () => {
      const kept = await keepHintFor([...base, "--bin-dir", "/tmp"]);
      expect(kept.deps?.labels).toEqual({ "tentacle.kept": "true" });
      expect(kept.deps?.annotations).toMatchObject({
        "tentacle.engine": "docker",
        "tentacle.model": "test",
      });
      const forget = kept.deps?.recordKept?.("c1");
      const keptDir = join(dir, "config", "kept");
      const files = readdirSync(keptDir);
      expect(files).toHaveLength(1);
      const record = JSON.parse(await readFile(join(keptDir, files[0] ?? ""), "utf8"));
      expect(record).toMatchObject({
        schemaVersion: 1,
        name: "c1",
        engine: "docker",
        endpoint: "unix:///nonexistent/tentacle-test.sock",
        binDir: "/tmp",
        model: "test",
      });
      expect(record.created).toBe(kept.deps?.annotations?.["tentacle.created"]);
      forget?.();
      expect(readdirSync(keptDir)).toEqual([]);

      const off = await keepHintFor([...base, "--keep=false"]);
      expect(off.reached).toBe(true);
      expect(off.deps?.labels).toBeUndefined();
      expect(off.deps?.annotations).toBeUndefined();
      expect(off.deps?.recordKept).toBeUndefined();
    });
  });

  describe("run --detach (docs/feat/detached-relay.md R12)", () => {
    const base = ["run", "--engine", "docker", "--no-mount", "--image", "x"];
    const owned = (sessionId: string): OwnerRecord => ({
      schemaVersion: 1,
      kind: "relay",
      pid: 9,
      appVersion: "1",
      sessionId,
      state: "running",
      lastActivityAt: 1,
      autoAccept: false,
    });
    /** `main` with the workload's creation and the relay's spawn as seams. */
    const detached = async (
      args: string[],
      over: {
        stdin?: string;
        record?: boolean;
        keep?: boolean;
        config?: Record<string, unknown>;
        colour?: boolean;
      } = {},
    ) => {
      const out: string[] = [];
      const err: string[] = [];
      const calls = { provision: 0, spawn: 0, runtime: 0 };
      let spec: RelaySpec | undefined;
      let hint: string | undefined;
      let removedAtEnd: boolean | undefined;
      const path = join(dir, "config", "config.jsonc");
      await mkdir(join(dir, "config"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ ...over.config, ...(over.keep === undefined ? {} : { keep: over.keep }) }),
      );
      const code = await main(["bun", "cli", ...args], {
        out: (t) => out.push(t),
        err: (t) => err.push(t),
        ...(over.colour !== undefined ? { colour: over.colour } : {}),
        ...(over.stdin !== undefined ? { readStdin: async () => over.stdin ?? "" } : {}),
        startEngineRuntime: async () => {
          calls.runtime += 1;
          throw new Error("no runtime for a detached run");
        },
        provisionWorkload: async (_config, deps) => {
          calls.provision += 1;
          hint = deps.keepHint?.("c1");
          removedAtEnd = deps.removedAtEnd;
          // The real gate: no `keepHint`, no index entry (and the exit net armed).
          if (over.record !== false && deps.keepHint) {
            deps.recordKept?.("c1");
          }
          return {
            name: "c1",
            binPath: "/usr/local/bin/tentacle",
            removeUnlessKept: () => {},
            announce: () => {},
          };
        },
        spawnRelay: (file, _cwd, runDir) => {
          calls.spawn += 1;
          spec = readSpec(file);
          writeOwner(runDir, owned(spec.sessionId));
          return { exited: () => false };
        },
      });
      await rm(path, { force: true });
      // `text`: stderr, where every line but the D1 name goes; `stdout`: the
      // data (an injected `out` is not a terminal: the name of a launched run).
      return { code, text: err.join(""), stdout: out.join(""), calls, spec, hint, removedAtEnd };
    };
    const refused = { provision: 0, spawn: 0, runtime: 0 };

    for (const [why, args, needle] of [
      ["--detach with no prompt", [...base, "--detach"], "--detach needs a prompt"],
      [
        "--detach --resume",
        [...base, "--detach", "--prompt", "hi", "--resume"],
        "--detach cannot resume",
      ],
      [
        "--detach --continue",
        [...base, "--detach", "--prompt", "hi", "--continue"],
        "--detach cannot resume",
      ],
    ] as const) {
      test(`${why}: a usage error, nothing created`, async () => {
        await withEnv(unreachable, async () => {
          const r = await detached([...args]);
          expect(r.code).toBe(1);
          expect(r.text).toContain(needle);
          expect(r.text).toContain("usage: tentacle run");
          expect(r.calls).toEqual(refused);
        });
      });
    }

    test("L12 --keep=false, or `keep: false` in the config: the spec says so, and the launch line", async () => {
      await withEnv(unreachable, async () => {
        for (const r of [
          await detached([...base, "--detach", "--prompt", "hi", "--keep=false"]),
          await detached([...base, "--detach", "--prompt", "hi"], { keep: false }),
        ]) {
          expect(r.code).toBe(0);
          expect(r.calls).toEqual({ provision: 1, spawn: 1, runtime: 0 });
          expect(r.spec?.keep).toBe(false);
          // Round 6: a successful `run --detach` prints no launch line of its own.
          expect(r.text).not.toContain("detached run started");
          expect(r.text).not.toContain("Attach any time");
          expect(r.text).not.toContain("undefined");
          expect(r.removedAtEnd).toBe(true);
        }
        const kept = await detached([...base, "--detach", "--prompt", "hi"]);
        expect(kept.spec?.keep).toBe(true);
        expect(kept.removedAtEnd).toBeUndefined();
        expect(kept.text).not.toContain("detached run started");
      });
      rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
    });

    test("L12 --keep=false through the REAL provisionWorkload: labelled, recorded, no net, the line", async () => {
      // Mutation: drop `kept.keep || detach` → no labels, no entry, the F8 `undefined --resume`.
      // Mutation: no hint for this run → the REAL `provisionWorkload` arms the exit net.
      await withEnv(unreachable, async () => {
        const fake = {
          noun: "container",
          where: "docker",
          defaultContainer: undefined,
          create: async (
            _name: string,
            _image: string,
            options: { labels?: Record<string, string> },
          ) => {
            labels.push(options.labels ?? {});
          },
          waitForReady: async () => {
            throw new Error("not ready");
          },
          remove: async (name: string) => void removed.push(`remove:${name}`),
          removeBestEffort: (name: string) => void removed.push(`besteffort:${name}`),
        } as unknown as EngineHost;
        const labels: Record<string, string>[] = [];
        const removed: string[] = [];
        const before = process.listeners("exit");
        const out: string[] = [];
        const code = await main(
          ["bun", "cli", ...base, "--detach", "--prompt", "hi", "--keep=false", "--name", "box"],
          {
            err: (t) => out.push(t),
            out: (t) => strayStdout.push(t),
            provisionWorkload: (config, deps) =>
              provisionWorkload(config, { ...deps, host: fake, appVersion: "dev" }),
          },
        );
        const armed = process.listeners("exit").filter((l) => !before.includes(l));
        for (const listener of armed) {
          process.off("exit", listener);
        }
        expect(code).toBe(1);
        expect(armed).toEqual([]);
        expect(removed).toEqual([]);
        expect(labels[0]).toMatchObject({ "tentacle.kept": "true" });
        const text = out.join("");
        expect(text).toContain("box stays up: the run never started · tentacle attach");
        expect(text).not.toContain("kept box");
        expect(text).not.toContain("undefined");
        expect(readKept(join(dir, "config", "kept")).entries.map((e) => e.entry.name)).toEqual([
          "box",
        ]);
      });
      rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
    });

    test("--keep=false with no --detach is unchanged: no labels, no index, the net", async () => {
      await withEnv(unreachable, async () => {
        const hints: (string | undefined)[] = [];
        await main(["bun", "cli", ...base, "--keep=false"], {
          out: (t) => strayStdout.push(t),
          err: () => {},
          startEngineRuntime: async (_config, deps) => {
            hints.push(deps.keepHint?.("c1"), deps.labels?.["tentacle.kept"]);
            throw new Error("stop here");
          },
        });
        expect(hints).toEqual([undefined, undefined]);
      });
    });

    test("an empty prompt on stdin, or a blank --prompt: a usage error, nothing created", async () => {
      await withEnv(unreachable, async () => {
        const stdin = await detached([...base, "--detach", "--prompt", "-"], { stdin: "  \n" });
        expect(stdin.code).toBe(1);
        expect(stdin.text).toContain("the prompt is empty");
        expect(stdin.calls).toEqual(refused);
        const blank = await detached([...base, "--detach", "--prompt=   "]);
        expect(blank.code).toBe(1);
        expect(blank.calls).toEqual(refused);
      });
    });

    test("a successful `run --detach` prints no launch line at all; a refused one stays plain", async () => {
      // Mutation: print the `detached run started` line again → `grey.text` is not empty.
      await withEnv(unreachable, async () => {
        const grey = await detached([...base, "--detach", "--prompt", "hi"], { colour: true });
        expect(grey.text).toBe("");
        const refusedRun = await detached([...base, "--detach"], { colour: true });
        expect(refusedRun.text).not.toContain("\x1b[");
      });
    });

    test("started: no TUI runtime, the spec names the session, the line the way back", async () => {
      await withEnv(unreachable, async () => {
        const r = await detached([...base, "--detach", "--prompt", "hello", "--auto-accept"]);
        expect(r.code).toBe(0);
        expect(r.calls).toEqual({ provision: 1, spawn: 1, runtime: 0 });
        expect(r.spec).toMatchObject({ prompt: "hello", autoAccept: true, mode: "start" });
        // Round 6: no launch line (the provisioner's dim `still running` is the only output).
        expect(r.text).toBe("");
        // The hint reaches only the line of a run that never started: nothing to resume.
        expect(r.hint).toBe("tentacle attach --engine docker c1");
      });
      rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
    });

    test("the launcher never arms the exit net: its own exit must not delete the workload", async () => {
      // Mutation: `keepHint: undefined` in the detach call → the REAL
      // `provisionWorkload` arms `armExitNet` and removes on failure.
      await withEnv(unreachable, async () => {
        const removed: string[] = [];
        const fake = {
          noun: "container",
          where: "docker",
          create: async () => {},
          waitForReady: async () => {
            throw new Error("not ready");
          },
          remove: async (name: string) => void removed.push(`remove:${name}`),
          removeBestEffort: (name: string) => void removed.push(`besteffort:${name}`),
        } as unknown as EngineHost;
        const before = process.listeners("exit");
        const out: string[] = [];
        const code = await main(
          ["bun", "cli", ...base, "--detach", "--prompt", "hi", "--name", "box"],
          {
            err: (t) => out.push(t),
            out: (t) => strayStdout.push(t),
            provisionWorkload: (config, deps) =>
              provisionWorkload(config, { ...deps, host: fake, appVersion: "dev" }),
          },
        );
        const armed = process.listeners("exit").filter((l) => !before.includes(l));
        for (const listener of armed) {
          process.off("exit", listener);
          listener(0);
        }
        expect(code).toBe(1);
        expect(removed).toEqual([]);
        expect(armed).toEqual([]);
        // Round 4: no `still running` before a failure — one `failed:` line.
        expect(out.join("")).not.toContain("still running");
        expect(out.join("")).toContain("[container] failed: not ready");
      });
      rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
    });

    test("--prompt - reads stdin; --auto-accept=false stays off", async () => {
      await withEnv(unreachable, async () => {
        const r = await detached([...base, "--detach", "--prompt", "-", "--auto-accept=false"], {
          stdin: "from a pipe\n",
        });
        expect(r.code).toBe(0);
        expect(r.spec).toMatchObject({ prompt: "from a pipe\n", autoAccept: false });
      });
      rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
    });

    test("round 10 / owner A: the kept entry records the run's profile and model (what `attach` reuses)", async () => {
      // Mutation: drop `profile` from `keptEntryFor` → the attach cannot find the run's model.
      await withEnv(
        { ...unreachable, TENTACLE_PROFILE: undefined, TENTACLE_MODEL: undefined },
        async () => {
          const r = await detached([...base, "--detach", "--prompt", "hi", "--profile", "deep"], {
            config: { profiles: { deep: { model: { model: "deep-chat" } } } },
          });
          expect(r.code).toBe(0);
          expect(r.spec?.profile).toBe("deep");
          const entries = readKept(join(dir, "config", "kept")).entries.map((e) => e.entry);
          expect(entries).toEqual([
            expect.objectContaining({ profile: "deep", model: "deep-chat" }),
          ]);
        },
      );
      rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
    });

    test("F5: `--model` reaches the kept entry (what the relay serves and `ps` shows)", async () => {
      // Mutation: drop `model` from the `loadConfig` call → the profile's deep-chat.
      await withEnv(
        { ...unreachable, TENTACLE_PROFILE: undefined, TENTACLE_MODEL: undefined },
        async () => {
          const r = await detached(
            [...base, "--detach", "--prompt", "hi", "--profile", "deep", "--model", "cli-x"],
            { config: { profiles: { deep: { model: { model: "deep-chat" } } } } },
          );
          expect(r.code).toBe(0);
          const entries = readKept(join(dir, "config", "kept")).entries.map((e) => e.entry);
          expect(entries).toEqual([expect.objectContaining({ profile: "deep", model: "cli-x" })]);
        },
      );
      rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
    });

    test("not in the kept index: fatal, no relay (it needs the entry)", async () => {
      await withEnv(unreachable, async () => {
        const r = await detached([...base, "--detach", "--prompt", "hi"], { record: false });
        expect(r.code).toBe(1);
        expect(r.text).toContain("kept index");
        expect(r.calls).toEqual({ provision: 1, spawn: 0, runtime: 0 });
      });
    });

    // docs/feat/run-prompt.md: the positional of `run` is the FIRST PROMPT; the
    // workload's name is `--name`.
    describe("run <prompt>", () => {
      /** `run` with the engine runtime and the TUI replaced; records what each got. */
      const interactive = async (
        args: string[],
        over: {
          stdin?: string;
          colour?: boolean;
          log?: string[];
          info?: string[];
          tuiThrows?: boolean;
          /** `startEngineRuntime` rejects with this (an own `logPath` models a recorded failure). */
          startFails?: Error;
          /** Session uids the run's saver saves, in order (after the index record). */
          saves?: string[];
        } = {},
      ) => {
        const out: string[] = [];
        const order: string[] = [];
        const seen: {
          name?: string;
          initialPrompt?: string;
          autoAccept?: { current(): boolean; set(on: boolean): void };
          logPath?: string | undefined;
          earlyLogPath?: string | undefined;
          faulted?: boolean;
          target?: unknown;
          thrown?: string;
          tui: number;
          runtime: number;
          kept?: KeptEntry[];
        } = {
          tui: 0,
          runtime: 0,
        };
        const calls = { provision: 0 };
        const path = join(dir, "config", "config.jsonc");
        await mkdir(join(dir, "config"), { recursive: true });
        await writeFile(path, JSON.stringify({}));
        const runtime = {
          createSession: () => ({}),
          jobs: {},
          link: { onLinkStatus: () => () => {} },
          mcpStatus: async () => [],
          dispose: async () => {},
          markFault: () => {
            seen.faulted = true;
          },
          announce: () => {
            order.push("announce");
          },
          // What `startEngineRuntime` returns for the status bar (laptop-side facts).
          target: { engine: "docker", name: "box" },
        };
        const code = await main(["bun", "cli", ...args], {
          err: (t) => out.push(t),
          out: (t) => strayStdout.push(t),
          ...(over.colour !== undefined ? { colour: over.colour } : {}),
          ...(over.stdin !== undefined ? { readStdin: async () => over.stdin ?? "" } : {}),
          provisionWorkload: (async () => {
            calls.provision += 1;
            throw new Error("no detached provision");
          }) as never,
          startEngineRuntime: (async (
            _config: unknown,
            deps: {
              name?: string;
              log: (text: string) => void;
              info?: (text: string) => void;
              daemonLogPath?: (name: string) => string | undefined;
            },
          ) => {
            seen.runtime += 1;
            seen.name = deps.name;
            // Before the index record there is no run dir: the fallback path.
            seen.earlyLogPath = deps.daemonLogPath?.("box");
            (deps as { recordKept?: (n: string) => unknown }).recordKept?.("box");
            seen.logPath = deps.daemonLogPath?.("box");
            for (const id of over.saves ?? []) {
              (deps as unknown as { saver: { save: (r: unknown) => void } }).saver.save({
                id,
                cwd: process.cwd(),
                model: "m",
                createdAt: 1,
                updatedAt: 1,
                title: id,
                messages: [{ role: "user", content: "hi" }],
              });
            }
            for (const line of over.info ?? []) {
              (deps.info ?? deps.log)(line);
            }
            for (const line of over.log ?? []) {
              deps.log(line);
            }
            if (over.startFails) {
              throw over.startFails;
            }
            return runtime;
          }) as never,
          startTui: (async (
            _session: unknown,
            options: { initialPrompt?: string; autoAccept?: never; target?: unknown },
          ) => {
            order.push("tui");
            seen.tui += 1;
            seen.target = options.target;
            seen.initialPrompt = options.initialPrompt;
            seen.autoAccept = options.autoAccept;
            if (over.tuiThrows) {
              throw new Error("ink exploded");
            }
          }) as never,
        }).catch((error: unknown) => {
          seen.thrown = String(error);
          return 1;
        });
        await rm(path, { force: true });
        seen.kept = readKept(join(dir, "config", "kept")).entries.map((e) => e.entry);
        rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
        // The fake run's saves (`over.saves`) went to the real store: drain, then drop them.
        await new Promise((resolve) => setTimeout(resolve, 20));
        rmSync(join(dir, "config", "sessions"), { recursive: true, force: true });
        return { code, text: out.join(""), seen, calls, order };
      };

      test("tui-target-badge: the runtime's badge is handed to the TUI (laptop-side facts)", async () => {
        // Mutation: drop `target` from the `startTui` options in `runEngineTui` → undefined.
        await withEnv(unreachable, async () => {
          const ok = await interactive([...base]);
          expect(ok.seen.target).toEqual({ engine: "docker", name: "box" });
        });
      });

      test("the `still running` line is announced just before the TUI opens, never when setup failed", async () => {
        // Mutation: never call `announce` → order lacks it; call it before the
        // runtime exists → the failure case would print it.
        await withEnv(unreachable, async () => {
          const ok = await interactive([...base]);
          expect(ok.order).toEqual(["announce", "tui"]);
          const failed = await interactive([...base], { startFails: new Error("boom") });
          expect(failed.code).toBe(1);
          expect(failed.order).toEqual([]);
        });
      });

      test("a setup failure is ONE short line: first line only, cut near 120 chars, with the log path when there is one", async () => {
        // Mutation: print the whole message → the second line / the long tail shows.
        await withEnv(unreachable, async () => {
          const home = homedir();
          const err = Object.assign(new Error("tentacle crashed (exit 134)\nsecond line\nthird"), {
            logPath: `${home}/.config/tentacle/logs/box/daemon.log`,
          });
          const r = await interactive([...base], { startFails: err });
          expect(r.text).toBe(
            "[container] failed: tentacle crashed (exit 134) · log: ~/.config/tentacle/logs/box/daemon.log\n",
          );
          const long = await interactive([...base], { startFails: new Error("x".repeat(500)) });
          expect(long.text).toBe(`[container] failed: ${"x".repeat(119)}…\n`);
        });
      });

      test("interactive: the positional is the first prompt, the name stays automatic", async () => {
        await withEnv(unreachable, async () => {
          const r = await interactive([...base, "fix the bug"]);
          expect(r.code).toBe(0);
          expect(r.seen.initialPrompt).toBe("fix the bug");
          expect(r.seen.name).toBeUndefined();
        });
      });

      test("--name is the workload's name; with no prompt the TUI gets none", async () => {
        await withEnv(unreachable, async () => {
          const r = await interactive([...base, "--name", "box"]);
          expect(r.seen.name).toBe("box");
          expect(r.seen.tui).toBe(1);
          expect(r.seen.initialPrompt).toBeUndefined();
          const both = await interactive([...base, "--name", "box", "go"]);
          expect(both.seen).toMatchObject({ name: "box", initialPrompt: "go" });
        });
      });

      test("--prompt <text> works without --detach, like the positional", async () => {
        await withEnv(unreachable, async () => {
          const r = await interactive([...base, "--prompt", "hello"]);
          expect(r.seen.initialPrompt).toBe("hello");
        });
      });

      test("a prompt starting with / is raw text, kept verbatim (never a command)", async () => {
        await withEnv(unreachable, async () => {
          const r = await interactive([...base, "--", "/clear"]);
          expect(r.seen.initialPrompt).toBe("/clear");
        });
      });

      for (const [why, args, needle] of [
        ["positional and --prompt", [...base, "a", "--prompt", "b"], "once"],
        ["an empty positional", [...base, ""], "the prompt is empty"],
        ["a blank --prompt", [...base, "--prompt=   "], "the prompt is empty"],
        ["--prompt - without --detach", [...base, "--prompt", "-"], "--prompt - needs --detach"],
        ["--resume with a prompt", [...base, "--resume", "go"], "cannot be combined with a prompt"],
        [
          "--continue with a prompt",
          [...base, "--continue", "go"],
          "cannot be combined with a prompt",
        ],
        [
          "--continue with --prompt",
          [...base, "--continue", "--prompt", "go"],
          "cannot be combined with a prompt",
        ],
      ] as const) {
        test(`${why}: a usage error, nothing started`, async () => {
          await withEnv(unreachable, async () => {
            const r = await interactive([...args], { stdin: "from a pipe" });
            expect(r.code).toBe(1);
            expect(r.text).toContain(needle);
            expect(r.seen.runtime).toBe(0);
            expect(r.seen.tui).toBe(0);
            expect(r.calls.provision).toBe(0);
          });
        });
      }

      test("--auto-accept[=true] without --detach starts the TUI with auto-accept ON; =false / absent: off", async () => {
        await withEnv(unreachable, async () => {
          for (const flag of ["--auto-accept", "--auto-accept=true"]) {
            const r = await interactive([...base, flag, "go"]);
            expect(r.code).toBe(0);
            expect(r.seen.autoAccept?.current()).toBe(true);
            expect(r.seen.initialPrompt).toBe("go");
            // Shift+Tab turns it off: the same state the TUI toggles.
            r.seen.autoAccept?.set(false);
            expect(r.seen.autoAccept?.current()).toBe(false);
          }
          for (const args of [[...base, "--auto-accept=false"], [...base]]) {
            const r = await interactive(args);
            expect(r.code).toBe(0);
            expect(r.seen.autoAccept?.current() ?? false).toBe(false);
          }
        });
      });

      test("grey is by explicit marking: `info` lines are grey on a coloured terminal; every `log` line (errors, refusals, warnings) is written unchanged; plain without colour", async () => {
        // Mutation: grey every `write` → the `log` lines below turn grey.
        await withEnv(unreachable, async () => {
          const info = ["[container] box still running · tentacle attach box\n"];
          // The lines the wording classifier used to grey by mistake (review of round 2).
          const plain = [
            "[container] box: the detached run did not start\n",
            "[container] box: the relay has not started yet, see /x/relay.log\n",
            "[container] box: container not found\n",
            "[container] box: the container was removed — nothing was removed\n",
            "[container] failed: boom\n",
            "[container] warning: no mount\n",
          ];
          const on = await interactive([...base], { colour: true, info, log: plain });
          expect(on.text).toContain("\x1b[90m[container] box still running");
          for (const line of plain) {
            expect(on.text).toContain(line);
          }
          expect(on.text.split("\x1b[90m")).toHaveLength(2); // exactly the one info line
          const off = await interactive([...base], { colour: false, info, log: plain });
          expect(off.text).not.toContain("\x1b[");
          expect(off.text).toContain(info[0] ?? "?");
        });
      });

      test("the daemon's stderr goes to <run dir>/daemon.log of a listed (kept) run; else <configDir>/logs/<name>/daemon.log", async () => {
        // Mutation: always the fallback dir → the kept run's path is wrong.
        await withEnv(unreachable, async () => {
          const kept = await interactive([...base]);
          expect(kept.seen.logPath).toMatch(/\/kept\/runs\/[^/]+\/daemon\.log$/);
          // A setup that fails before the index record leaves no run dir behind.
          // Mutation: use the run dir before the record → this fails.
          expect(kept.seen.earlyLogPath).toBe(join(dir, "config", "logs", "box", "daemon.log"));
          const unkept = await interactive([...base, "--keep=false"]);
          expect(unkept.seen.logPath).toBe(join(dir, "config", "logs", "box", "daemon.log"));
        });
      });

      test("the TUI itself failing is reported to the runtime (its teardown prints the one failure line)", async () => {
        // Mutation: drop the `markFault` call → the failure is silent.
        await withEnv(unreachable, async () => {
          const ok = await interactive([...base]);
          expect(ok.seen.faulted).toBeUndefined();
          const failed = await interactive([...base], { tuiThrows: true });
          expect(failed.seen.thrown).toContain("ink exploded");
          expect(failed.seen.faulted).toBe(true);
        });
      });

      test("attach-plain-resume: the run's saved session lands in its kept index entry, and follows /clear", async () => {
        // Mutation: drop trackKeptSession from the run -> no sessionId in the entry.
        const A = "11111111-1111-4111-8111-111111111111";
        const B = "22222222-2222-4222-8222-222222222222";
        await withEnv(unreachable, async () => {
          const one = await interactive([...base, "--name", "box"], { saves: [A] });
          expect(one.seen.kept?.map((e) => e.sessionId)).toEqual([A]);
          // Every engine records the folder `run` was launched from (the attach's folder
          // when nothing is mounted). Mutation: drop `cwd` from keptEntryFor -> undefined.
          expect(one.seen.kept?.map((e) => e.cwd)).toEqual([process.cwd()]);
          // /clear: a later turn saves another uid -> the latest.
          const two = await interactive([...base, "--name", "box"], { saves: [A, B] });
          expect(two.seen.kept?.map((e) => e.sessionId)).toEqual([B]);
          // No save (quit before a turn): no id, today's entry.
          const none = await interactive([...base, "--name", "box"]);
          expect(none.seen.kept?.map((e) => e.sessionId)).toEqual([undefined]);
          // keep=false is in no index: nothing to write, nothing thrown.
          const gone = await interactive([...base, "--name", "box", "--keep=false"], {
            saves: [A],
          });
          expect(gone.code).toBe(0);
          expect(gone.seen.kept).toEqual([]);
        });
      });

      test("--continue alone (no prompt) is not refused", async () => {
        await withEnv(unreachable, async () => {
          const r = await interactive([...base, "--continue"]);
          expect(r.text).not.toContain("cannot be combined");
        });
      });

      test("--detach with the positional: that is the detached prompt; with both: an error", async () => {
        await withEnv(unreachable, async () => {
          const ok = await detached([...base, "--detach", "go on", "--name", "box"]);
          expect(ok.spec).toMatchObject({ prompt: "go on", mode: "start" });
          rmSync(join(dir, "config", "kept"), { recursive: true, force: true });
          const both = await detached([...base, "--detach", "a", "--prompt", "b"]);
          expect(both.code).toBe(1);
          expect(both.calls).toEqual(refused);
        });
      });
    });
  });

  describe("attach while a relay owns the workload (docs/feat/detached-relay.md R13)", () => {
    const entry: KeptEntry = {
      schemaVersion: 1,
      name: "box",
      engine: "docker",
      endpoint: "unix:///nonexistent/kept.sock",
      model: "m",
      created: "2026-10-27T10:00:00.000Z",
    };
    const setup = (holder: string): void => {
      const config = join(dir, "config");
      rmSync(keptIndexDir(config), { recursive: true, force: true });
      recordKept(keptIndexDir(config), entry);
      const runDir = ensureRunDir(runDirFor(config, entry));
      writeFileSync(join(runDir, ".lock.1"), holder);
      writeOwner(runDir, {
        schemaVersion: 1,
        kind: "relay",
        pid: process.pid,
        appVersion: "1",
        sessionId: "44444444-4444-4444-8444-444444444444",
        state: "waiting-permission",
        lastActivityAt: 1,
        autoAccept: false,
        created: entry.created,
      });
    };
    const live = () => `${process.pid} ${laptopProc(process.pid)?.start}`;

    test("a live holder with no hand-over possible: exit 1, nothing dialled, the way out said", async () => {
      // Mutation: drop the guard → `attaching to box`. Since detached-handover a
      // live relay is handed over (below); S2's refusal stays for another session
      // of it, and no terminal is refused before anything.
      setup(live());
      await withEnv(unreachable, async () => {
        // No location flag: the same place, so `kill` is the honest way out.
        const out: string[] = [];
        const code = await main(
          ["bun", "cli", "attach", "box", "--resume", "99999999-9999-4999-8999-999999999999"],
          { err: (t) => out.push(t), out: (t) => strayStdout.push(t), tty: true },
        );
        const r = { code, text: out.join("") };
        expect(r.code).toBe(1);
        expect(r.text).toContain("a detached run owns it");
        expect(r.text).toContain(`kill ${process.pid}`);
        expect(r.text).toContain("--resume 44444444-4444-4444-8444-444444444444");
        expect(r.text).not.toContain("attaching to");
        // An explicit engine flag names ANOTHER place (DOCKER_HOST, not the
        // entry's socket): R1's refusal, which never offers that `kill`.
        const other: string[] = [];
        const code2 = await main(
          [
            "bun",
            "cli",
            "attach",
            "--engine",
            "docker",
            "box",
            "--resume",
            "99999999-9999-4999-8999-999999999999",
          ],
          { err: (t) => other.push(t), out: (t) => strayStdout.push(t), tty: true },
        );
        expect(code2).toBe(1);
        expect(other.join("")).toContain("unix:///nonexistent/kept.sock");
        expect(other.join("")).toContain("unix:///nonexistent/tentacle-test.sock");
        expect(other.join("")).not.toContain("kill");
        expect(other.join("")).not.toContain("attaching to");
        const piped = await run(["attach", "box"]);
        expect(piped.code).toBe(1);
        expect(piped.text).toContain("needs a terminal");
        expect(piped.text).not.toContain("attaching to box in");
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    test("a stale holder, or another engine's workload of that name, proceeds", async () => {
      // A terminal: a detached run's attach needs one (detached-handover H19).
      setup(`${2 ** 30} 1`);
      await withEnv(unreachable, async () => {
        const out: string[] = [];
        await main(["bun", "cli", "attach", "box"], {
          err: (t) => out.push(t),
          out: (t) => strayStdout.push(t),
          tty: true,
        });
        expect(out.join("")).toContain("attaching to box");
        setup(live());
        const other = await run(["attach", "--engine", "podman", "box"]);
        expect(other.text).not.toContain("a detached run owns it");
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    /** `attach` with the engine runtime and the TUI replaced; records what each got. */
    const attached = async (args: string[], tty = true, plainSeam = false) => {
      const out: string[] = [];
      const seen: {
        runtimeBroker?: unknown;
        tuiBroker?: unknown;
        sessionId?: string;
        shared?: boolean;
        attachTo?: string;
        quit: number;
        runQuit?: unknown;
        createSession?: unknown;
        autoAccept?: unknown;
        confirmed?: boolean;
        config?: { model?: string; baseURL?: string; cwd?: string };
        tuiModel?: string;
        resume?: { id: string; messages: unknown[] } | null;
        saver?: { save: (record: unknown) => void };
        notices: string[];
      } = { quit: 0, notices: [] };
      const runtime = {
        saveConfirmed: () => seen.confirmed === true,
        createSession: () => ({}),
        jobs: {},
        link: { onLinkStatus: () => () => {} },
        mcpStatus: async () => [],
        attachTo: async (id: string) => {
          seen.attachTo = id;
          return true;
        },
        quit: async () => {
          seen.quit += 1;
          return { sessionsKept: 0, saved: true };
        },
        release: async () => {},
        dispose: async () => {},
        residentUse: async () => null,
      };
      const fakeAttach = (async (
        config: { model?: string; baseURL?: string; cwd?: string },
        deps: {
          permissions: unknown;
          sessionId?: string;
          shared?: true;
          resume?: { id: string; messages: unknown[] } | null;
          saver?: { save: (record: unknown) => void };
        },
      ) => {
        seen.config = config;
        seen.resume = deps.resume;
        seen.saver = deps.saver;
        seen.runtimeBroker = deps.permissions;
        seen.sessionId = deps.sessionId;
        seen.shared = deps.shared === true;
        return runtime;
      }) as never;
      const code = await main(["bun", "cli", ...args], {
        err: (t) => out.push(t),
        out: (t) => strayStdout.push(t),
        tty,
        ...(plainSeam ? { attachPlainRuntime: fakeAttach } : {}),
        attachEngineRuntime: fakeAttach,
        startTui: (async (
          _session: unknown,
          options: {
            permissions: unknown;
            runQuit?: unknown;
            createSession?: unknown;
            autoAccept?: unknown;
            model?: string;
            notices?: { onNotice: (listener: (text: string) => void) => unknown };
          },
        ) => {
          options.notices?.onNotice((text) => seen.notices.push(text));
          seen.tuiModel = options.model;
          seen.tuiBroker = options.permissions;
          seen.runQuit = options.runQuit;
          seen.createSession = options.createSession;
          seen.autoAccept = options.autoAccept;
        }) as never,
      });
      return { code, text: out.join(""), seen, runtime };
    };

    test("attach of a name not in `ps`: ONE `[error]` line, no `failed:`, no log path", async () => {
      // Mutation: print `failedLine` for a not-found → `[pod] failed: pod "x" not found … · log:`.
      setup(`${2 ** 30} 1`);
      await withEnv(unreachable, async () => {
        const out: string[] = [];
        const code = await main(
          ["bun", "cli", "attach", "nome-che-non-esiste", "--namespace", "openshift-dns"],
          {
            err: (t) => out.push(t),
            out: (t) => strayStdout.push(t),
            tty: true,
            attachPlainRuntime: (async () => {
              throw new WorkloadNotFoundError("pod gone", "pod", "in openshift-dns");
            }) as never,
          },
        );
        expect(code).toBe(1);
        expect(
          out
            .join("")
            .split("\n")
            .filter((l) => l.startsWith("[error]")),
        ).toEqual([
          "[error] nome-che-non-esiste: not in tentacle ps, and no pod with that name in openshift-dns",
        ]);
        expect(out.join("")).not.toContain("failed:");
        expect(out.join("")).not.toContain("log:");
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    test("D1 a detached run's attach: the TUI gets `runQuit` and the presence-moving `createSession`", async () => {
      // Mutation: drop `runQuit` from `runEngineTui` → `/quit` never asks, never closes for all.
      setup(`${2 ** 30} 1`);
      await withEnv(unreachable, async () => {
        const r = await attached(["attach", "box"]);
        expect(r.code).toBe(0);
        const runQuit = r.seen.runQuit as { othersOnSession?: unknown } | undefined;
        expect(typeof runQuit?.othersOnSession).toBe("function");
        expect(typeof r.seen.createSession).toBe("function");
        expect(r.seen.createSession === r.runtime.createSession).toBe(false);
        // B3. Mutation: drop `autoAccept` → every TUI's toggle stays local, OFF.
        const feed = r.seen.autoAccept as { current?: unknown } | undefined;
        expect(typeof feed?.current).toBe("function");
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    test("round 10 / owner A: `attach` uses the run's model (its profile + `ps`'s model), unless --profile is explicit", async () => {
      // Live item 12: `attach lv-h3` (no --profile) talked to the laptop default.
      // Mutation: ignore the entry's profile → the default config's model.
      const config = join(dir, "config");
      const path = join(config, "config.jsonc");
      await mkdir(config, { recursive: true });
      const before = (await Bun.file(path).exists()) ? await readFile(path, "utf8") : undefined;
      await writeFile(
        path,
        JSON.stringify({
          model: { model: "laptop-default", baseURL: "http://default.invalid/v1" },
          profiles: {
            deep: { model: { model: "deep-chat", baseURL: "http://deep.invalid/v1" } },
            other: { model: { model: "other-model", baseURL: "http://other.invalid/v1" } },
          },
        }),
      );
      try {
        const env = {
          ...unreachable,
          TENTACLE_PROFILE: undefined,
          TENTACLE_MODEL: undefined,
          TENTACLE_MODEL_BASE_URL: undefined,
        };
        await withEnv(env, async () => {
          const runEntry: KeptEntry = { ...entry, model: "deep-chat", profile: "deep" };
          const at = (args: string[]) => {
            setup(`${2 ** 30} 1`);
            recordKept(keptIndexDir(config), runEntry); // same file: the entry gains its profile
            return attached(args);
          };
          const r = await at(["attach", "box"]);
          expect(r.code).toBe(0);
          expect(r.seen.config).toMatchObject({
            model: "deep-chat",
            baseURL: "http://deep.invalid/v1",
          });
          expect(r.seen.tuiModel).toBe("deep-chat"); // and SHOWN in the status bar
          const explicit = await at(["attach", "box", "--profile", "other"]);
          expect(explicit.seen.config).toMatchObject({
            model: "other-model",
            baseURL: "http://other.invalid/v1",
          });
          // F5 / OQ4: `--model` is explicit too — that id, on this command's
          // endpoint, for this TUI only; the kept entry (what `ps` shows) keeps
          // the run's. Mutation: `useRunModel` without `modelFlag` → deep-chat.
          const cli = await at(["attach", "box", "--model", "cli-x"]);
          expect(cli.code).toBe(0);
          expect(cli.seen.config).toMatchObject({
            model: "cli-x",
            baseURL: "http://default.invalid/v1",
          });
          expect(cli.seen.tuiModel).toBe("cli-x");
          expect(readKept(keptIndexDir(config)).entries.map((e) => e.entry.model)).toEqual([
            "deep-chat",
          ]);
        });
      } finally {
        if (before === undefined) await rm(path, { force: true });
        else await writeFile(path, before);
        rmSync(keptIndexDir(config), { recursive: true, force: true });
      }
    });

    test("H17 a detached run's attach: the broker the runtime gets IS the TUI's (single broker)", async () => {
      // Mutation: a second broker for the TUI → the runtime's asks never reach the prompt.
      setup(`${2 ** 30} 1`);
      await withEnv(unreachable, async () => {
        const r = await attached(["attach", "box"]);
        expect(r.code).toBe(0);
        expect(r.seen.runtimeBroker).toBeDefined();
        expect(r.seen.runtimeBroker === r.seen.tuiBroker).toBe(true);
        expect(r.seen.shared).toBe(true);
        expect(r.seen.quit).toBe(1); // the quit is `finish`, not `dispose`
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    test("H19 a dead relay: `attach box` opens the run's session; bare --resume and --continue too, no picker; no terminal: refused", async () => {
      // Mutation: ignore `owner.sessionId` → a fresh id.
      const uid = "44444444-4444-4444-8444-444444444444";
      await withEnv(unreachable, async () => {
        for (const args of [
          ["attach", "box"],
          ["attach", "box", "--resume"],
          ["attach", "box", "--continue"],
          ["attach", "box", "--resume", uid],
        ]) {
          setup(`${2 ** 30} 1`);
          const r = await attached(args);
          expect(r.code).toBe(0);
          expect(r.seen.sessionId).toBe(uid);
          expect(r.seen.attachTo).toBe(uid);
        }
        setup(`${2 ** 30} 1`);
        const piped = await attached(["attach", "box"], false);
        expect(piped.code).toBe(1);
        expect(piped.text).toContain("box: attaching to a detached run needs a terminal");
        expect(piped.seen.runtimeBroker).toBeUndefined();
        // Another session of the same resident: today's attach, not a client of the run.
        setup(`${2 ** 30} 1`);
        const other = await attached([
          "attach",
          "box",
          "--resume",
          "99999999-9999-4999-8999-999999999999",
        ]);
        expect(other.seen.runtimeBroker).toBeUndefined();
        expect(other.text).toContain("attaching to box");
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    test("a live relay on a terminal goes to the hand-over: no socket within its wait → S2's refusal, the TUI never mounted", async () => {
      // Mutation: refuse `plan.handover` up front (Phase A) → no runtime is built.
      setup(live());
      await withEnv(unreachable, async () => {
        const r = await attached(["attach", "box"]);
        expect(r.code).toBe(1);
        expect(r.seen.runtimeBroker).toBeDefined();
        expect(r.seen.tuiBroker).toBeUndefined();
        expect(r.text).toContain("a detached run owns it");
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    }, 15_000);

    /** A dead run of `at`, keep=false: the delete a redirect would inherit. */
    const deadRun = (at: KeptEntry, sessionId: string): void => {
      const config = join(dir, "config");
      recordKept(keptIndexDir(config), at);
      writeOwner(ensureRunDir(runDirFor(config, at)), {
        schemaVersion: 1,
        kind: "relay",
        pid: 2 ** 30,
        appVersion: "1",
        sessionId,
        state: "failed",
        lastActivityAt: 1,
        autoAccept: false,
        keep: false,
        created: at.created,
      });
    };
    const clean = () => rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });

    test("H35 explicit flags are compared: --namespace B never lands on namespace A's run; A's own flags still reach it", async () => {
      // Mutation: skip the comparison → `resolved box → kubernetes`, and a quit that deletes A's pod.
      clean();
      const uid = "55555555-5555-4555-8555-555555555555";
      deadRun(
        {
          schemaVersion: 1,
          name: "box",
          engine: "kubernetes",
          namespace: "team-a",
          server: unreachable.TENTACLE_K8S_SERVER,
          model: "m",
          created: entry.created,
        },
        uid,
      );
      await withEnv(unreachable, async () => {
        const base = ["attach", "--engine", "kubernetes", "box"];
        const other = await attached([...base, "--namespace", "team-b"]);
        expect(other.seen.runtimeBroker).toBeUndefined();
        expect(other.text).not.toContain("resolved box");
        const same = await attached([...base, "--namespace", "team-a"]);
        expect(same.seen.sessionId).toBe(uid);
      });
      clean();
    });

    test("R1 flags naming ANOTHER place than a LIVE run's: both places named, never a `kill` (it would stop another place's workload)", async () => {
      // Mutation: reuse S2's refusal → "…or `kill <pid>`", which deletes team-a's pod.
      clean();
      const at: KeptEntry = {
        schemaVersion: 1,
        name: "box",
        engine: "kubernetes",
        namespace: "team-a",
        server: unreachable.TENTACLE_K8S_SERVER,
        model: "m",
        created: entry.created,
      };
      recordKept(keptIndexDir(join(dir, "config")), at);
      const runDir = ensureRunDir(runDirFor(join(dir, "config"), at));
      writeFileSync(join(runDir, ".lock.1"), live());
      writeOwner(runDir, {
        schemaVersion: 1,
        kind: "relay",
        pid: process.pid,
        appVersion: "1",
        sessionId: "55555555-5555-4555-8555-555555555556",
        state: "waiting-permission",
        lastActivityAt: 1,
        autoAccept: false,
        keep: false,
        created: at.created,
      });
      await withEnv(unreachable, async () => {
        const r = await attached([
          "attach",
          "--engine",
          "kubernetes",
          "box",
          "--namespace",
          "team-b",
        ]);
        expect(r.code).toBe(1);
        expect(r.seen.runtimeBroker).toBeUndefined();
        // Where the run IS (the entry), and the place the flags name.
        expect(r.text).toContain("127.0.0.1/team-a");
        expect(r.text).toContain("127.0.0.1/team-b");
        // A `kill` here would stop and remove team-a's pod: never suggested.
        expect(r.text).not.toContain("kill");
        expect(r.text).not.toContain("stopping it removes");
        // The safe next step: the index resolves the run where it is.
        expect(r.text).toContain("tentacle attach box");
      });
      clean();
    });

    test("H35 two entries of one name: an explicit engine reaches the run of ITS endpoint only; an endpoint with no run, its own attach; no flag: `ambiguous`", async () => {
      // Mutation: the first entry with a record wins.
      clean();
      const uids = [
        "55555555-5555-4555-8555-555555555551",
        "55555555-5555-4555-8555-555555555552",
      ] as const;
      const socks = ["unix:///nonexistent/one.sock", "unix:///nonexistent/two.sock"] as const;
      socks.forEach((endpoint, i) => deadRun({ ...entry, endpoint }, uids[i] ?? ""));
      const explicit = ["attach", "--engine", "docker", "box"];
      for (const [i, endpoint] of socks.entries()) {
        await withEnv({ ...unreachable, DOCKER_HOST: endpoint }, async () => {
          const r = await attached(explicit);
          expect(r.seen.sessionId).toBe(uids[i] ?? "");
          expect(r.text).not.toContain("resolved box");
        });
      }
      await withEnv({ ...unreachable, DOCKER_HOST: "unix:///nonexistent/three.sock" }, async () => {
        const r = await attached(explicit);
        expect(r.seen.runtimeBroker).toBeUndefined();
        expect(r.text).toContain("attaching to box in unix:///nonexistent/three.sock");
        const bare = await attached(["attach", "box"]);
        expect(bare.code).toBe(1);
        expect(bare.seen.runtimeBroker).toBeUndefined();
        expect(bare.text).not.toContain("attaching to box");
      });
      clean();
    });

    test("H35 a record of an earlier workload of that name: today's attach, not the run", async () => {
      // Mutation: `main` does not pass the entry's `created` → the old uid and keep=false.
      clean();
      deadRun(
        { ...entry, created: "2026-10-30T10:00:00.000Z" },
        "55555555-5555-4555-8555-555555555553",
      );
      recordKept(keptIndexDir(join(dir, "config")), entry); // the name reused: a new `created`
      await withEnv(unreachable, async () => {
        const r = await attached(["attach", "box"]);
        expect(r.seen.runtimeBroker).toBeUndefined();
        expect(r.text).toContain("attaching to box");
      });
      clean();
    });

    test("R6/N1 a keep=false run's TUI exit net asks THE RUNTIME's `saveConfirmed`: unconfirmed keeps the workload, confirmed deletes", async () => {
      // Mutation: `armNet` in main.ts wiring `() => saved() || true` (or `() => true`) →
      // the net deletes with the save unconfirmed.
      clean();
      deadRun(entry, "55555555-5555-4555-8555-555555555554");
      const exits: Array<() => void> = [];
      const realOnce = process.once;
      const realSpawn = Bun.spawn;
      const spawned: unknown[] = [];
      process.once = ((event: string, listener: () => void) => {
        if (event === "exit") {
          exits.push(listener); // not registered: the test's own exit must not fire it
          return process;
        }
        return realOnce.call(process, event, listener);
      }) as never;
      // `removeBestEffort` → `spawnContainerDelete` → `Bun.spawn`: recorded, never run.
      Bun.spawn = ((cmd: unknown) => {
        spawned.push(cmd);
        return { unref: () => {} };
      }) as never;
      try {
        await withEnv(unreachable, async () => {
          const r = await attached(["attach", "box"]);
          expect(r.code).toBe(0);
          expect(exits.length).toBe(1);
          r.seen.confirmed = false;
          for (const fire of exits) {
            fire();
          }
          expect(spawned.length).toBe(0); // unconfirmed: kept
          r.seen.confirmed = true;
          for (const fire of exits) {
            fire();
          }
          expect(spawned.length).toBe(1); // confirmed: deleted
        });
      } finally {
        process.once = realOnce;
        Bun.spawn = realSpawn;
      }
      clean();
    });

    const ownerIn = (cwd: string) =>
      writeOwner(runDirFor(join(dir, "config"), entry), {
        schemaVersion: 1,
        kind: "relay",
        pid: 1,
        appVersion: "1",
        sessionId: "44444444-4444-4444-8444-444444444444",
        state: "idle",
        lastActivityAt: 1,
        autoAccept: false,
        cwd,
        created: entry.created,
      });

    test("attach-any-folder: a run of another folder attaches from ANY folder, as if launched from its own", async () => {
      // Mutation: keep the launch folder -> the laptop copy lands in the wrong project.
      setup(`${2 ** 30} 1`);
      const folder = join(dir, "run-folder");
      await mkdir(folder, { recursive: true });
      ownerIn(folder);
      await withEnv(unreachable, async () => {
        const r = await attached(["attach", "box"]);
        expect(r.code).toBe(0);
        expect(r.text).not.toContain("belongs to");
        expect(r.seen.sessionId).toBe("44444444-4444-4444-8444-444444444444");
        expect(r.seen.config?.cwd).toBe(folder);
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    test("the run's folder is gone: the attach still works, filed under the ORIGINAL path (attach-plain-resume round 3)", async () => {
      // Mutation: put the existence refusal back -> exit 1 `no longer exists`.
      setup(`${2 ** 30} 1`);
      const gone = join(dir, "no-such-folder");
      ownerIn(gone);
      await withEnv(unreachable, async () => {
        const r = await attached(["attach", "box"]);
        expect(r.code).toBe(0);
        expect(r.text).not.toContain("no longer exists");
        expect(r.seen.config?.cwd).toBe(gone);
        expect(r.seen.sessionId).toBe("44444444-4444-4444-8444-444444444444");
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    test("attach-any-folder: a plain kept container attaches from the folder it mounts (the laptop's index)", async () => {
      // Mutation: ignore `entry.mount` -> the launch folder.
      const config = join(dir, "config");
      const folder = join(dir, "mounted-folder");
      await mkdir(folder, { recursive: true });
      rmSync(keptIndexDir(config), { recursive: true, force: true });
      recordKept(keptIndexDir(config), { ...entry, mount: folder });
      await withEnv(unreachable, async () => {
        // `--continue` looks in the sessions filed under the folder it names.
        const r = await run(["attach", "box", "--continue"]);
        expect(r.text).toContain(`no saved sessions for ${folder} yet`);
        // No recorded folder (no mount): today's, the launch folder.
        rmSync(keptIndexDir(config), { recursive: true, force: true });
        recordKept(keptIndexDir(config), entry);
        const none = await run(["attach", "box", "--continue"]);
        expect(none.text).toContain(`no saved sessions for ${process.cwd()} yet`);
        // A mount that is gone: the folder only keys the session store, so the
        // attach goes on and looks under the ORIGINAL path.
        const missing = join(dir, "gone-mount");
        rmSync(keptIndexDir(config), { recursive: true, force: true });
        recordKept(keptIndexDir(config), { ...entry, mount: missing });
        const gone = await run(["attach", "box", "--continue"]);
        expect(gone.text).toContain(`no saved sessions for ${missing} yet`);
        expect(gone.text).not.toContain("no longer exists");
      });
      rmSync(keptIndexDir(config), { recursive: true, force: true });
    });

    describe("attach-plain-resume: a plain kept container reopens the run's conversation", () => {
      const A = "11111111-1111-4111-8111-111111111111";
      const B = "22222222-2222-4222-8222-222222222222";
      let folder = "";
      beforeAll(() => {
        folder = join(dir, "resume-folder");
      });
      const record = (id: string, cwd: string, updatedAt = 10): SessionRecord => ({
        id,
        cwd,
        model: "m",
        createdAt: 1,
        updatedAt,
        title: `conv ${id.slice(0, 4)}`,
        messages: [
          { role: "user", content: "ciao" },
          { role: "assistant", content: "salve" },
        ],
      });
      const store = (cwd: string) =>
        new JsonSessionStore(join(dir, "config", "sessions", projectKey(cwd)));
      const index = async (over: Partial<KeptEntry>, records: SessionRecord[] = []) => {
        const config = join(dir, "config");
        await mkdir(folder, { recursive: true });
        rmSync(join(config, "sessions"), { recursive: true, force: true });
        rmSync(keptIndexDir(config), { recursive: true, force: true });
        recordKept(keptIndexDir(config), { ...entry, mount: folder, ...over });
        for (const r of records) {
          await store(r.cwd).save(r);
        }
      };
      const cleanup = () => {
        rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
        rmSync(join(dir, "config", "sessions"), { recursive: true, force: true });
      };

      test("the entry's session is reopened from the laptop record, in the run's folder", async () => {
        // Mutation: plainResumeUid returns undefined -> resume null, an empty session.
        await index({ sessionId: A }, [record(A, folder)]);
        await withEnv(unreachable, async () => {
          const r = await attached(["attach", "box"], true, true);
          expect(r.code).toBe(0);
          expect(r.seen.config?.cwd).toBe(folder);
          expect(r.seen.resume?.id).toBe(A);
          expect(r.seen.resume?.messages).toHaveLength(2);
          expect(r.seen.notices).toEqual([]);
        });
        cleanup();
      });

      test("the record is gone, unreadable or of another folder: a fresh session and ONE note", async () => {
        // Mutation: let openSessions take the id unchecked -> `unreadable` / `another folder` are fatal.
        await withEnv(unreachable, async () => {
          const note = (r: Awaited<ReturnType<typeof attached>>) => {
            expect(r.code).toBe(0);
            expect(r.seen.resume ?? null).toBeNull();
            expect(r.seen.notices).toHaveLength(1);
            expect(r.seen.notices[0]).toContain(A.slice(0, 8));
          };
          await index({ sessionId: A });
          note(await attached(["attach", "box"], true, true));
          // Another folder's record of that uid (never resumed here).
          const other = join(dir, "other-folder");
          await mkdir(other, { recursive: true });
          await index({ sessionId: A }, [record(A, other)]);
          note(await attached(["attach", "box"], true, true));
          // The file is there but unusable.
          await index({ sessionId: A });
          await store(folder).save(record(A, folder));
          await writeFile(
            join(dir, "config", "sessions", projectKey(folder), `${A}.json`),
            "{nope",
          );
          note(await attached(["attach", "box"], true, true));
        });
        cleanup();
      });

      test("an entry without an id (an older run) is today's fresh session, no note", async () => {
        await index({}, [record(A, folder)]);
        await withEnv(unreachable, async () => {
          const r = await attached(["attach", "box"], true, true);
          expect(r.code).toBe(0);
          expect(r.seen.resume ?? null).toBeNull();
          expect(r.seen.notices).toEqual([]);
        });
        cleanup();
      });

      test("a bare --resume (no uid, no terminal) takes the newest session, not the entry's", async () => {
        // Mutation: ignore `resume` in plainResumeUid's flags (the M2 family) -> A is forced.
        await index({ sessionId: A }, [record(A, folder, 10), record(B, folder, 20)]);
        await withEnv(unreachable, async () => {
          const r = await attached(["attach", "box", "--resume"], true, true);
          expect(r.seen.resume?.id).toBe(B);
        });
        cleanup();
      });

      test("every engine records the run's folder: a no-mount entry (k8s) reopens from it, from ANY folder", async () => {
        // Mutation: moveTo(keptEntry.mount) without `?? cwd` -> the launch folder, no record, a note.
        const config = join(dir, "config");
        await index({ sessionId: A }, [record(A, folder)]);
        const { mount: _mount, ...noMount } = { ...entry, mount: folder };
        recordKept(keptIndexDir(config), { ...noMount, sessionId: A, cwd: folder });
        await withEnv(unreachable, async () => {
          const r = await attached(["attach", "box"], true, true);
          expect(r.code).toBe(0);
          expect(r.seen.config?.cwd).toBe(folder);
          expect(r.seen.resume?.id).toBe(A);
          expect(r.seen.notices).toEqual([]);
          // Its folder is gone (renamed, deleted): never a refusal — the conversation is
          // reopened from the record filed under the ORIGINAL path.
          const missing = join(dir, "gone-run-folder");
          await store(missing).save(record(B, missing));
          recordKept(keptIndexDir(config), { ...noMount, cwd: missing, sessionId: B });
          const gone = await attached(["attach", "box"], true, true);
          expect(gone.code).toBe(0);
          expect(gone.text).not.toContain("no longer exists");
          expect(gone.seen.config?.cwd).toBe(missing);
          expect(gone.seen.resume?.id).toBe(B);
          expect(gone.seen.notices).toEqual([]);
        });
        cleanup();
      });

      test("the mount wins over a differing cwd; an entry with neither keeps the launch folder", async () => {
        // Mutation: prefer `cwd` over `mount` -> the cwd folder is used.
        const config = join(dir, "config");
        await index({ sessionId: A }, [record(A, folder)]);
        recordKept(keptIndexDir(config), {
          ...entry,
          mount: folder,
          cwd: join(dir, "elsewhere-never-created"),
          sessionId: A,
        });
        await withEnv(unreachable, async () => {
          const r = await attached(["attach", "box"], true, true);
          expect(r.code).toBe(0);
          expect(r.seen.config?.cwd).toBe(folder);
          expect(r.seen.resume?.id).toBe(A);
          // Neither field (an older entry): the launch folder, nothing moved.
          recordKept(keptIndexDir(config), entry);
          const older = await attached(["attach", "box"], true, true);
          expect(older.code).toBe(0);
          expect(older.seen.config?.cwd).toBe(process.cwd());
          expect(older.seen.resume ?? null).toBeNull();
        });
        cleanup();
      });

      test("--resume <uid> and --continue still win over the entry's session", async () => {
        // Mutation: ignore the flags in plainResumeUid -> the entry's session is forced.
        await index({ sessionId: A }, [record(A, folder, 10), record(B, folder, 20)]);
        await withEnv(unreachable, async () => {
          const explicit = await attached(["attach", "box", "--resume", B], true, true);
          expect(explicit.seen.resume?.id).toBe(B);
          const latest = await attached(["attach", "box", "--continue"], true, true);
          expect(latest.seen.resume?.id).toBe(B); // the newest, not the entry's A
        });
        cleanup();
      });

      test("an attach follows the session too: /clear in it, then the next attach reopens THAT one", async () => {
        // Mutation: drop trackKeptSession from the attach -> the entry keeps A.
        await index({ sessionId: A }, [record(A, folder)]);
        await withEnv(unreachable, async () => {
          const r = await attached(["attach", "box"], true, true);
          r.seen.saver?.save(record(B, folder));
          const entries = readKept(keptIndexDir(join(dir, "config"))).entries;
          expect(entries.map((e) => e.entry.sessionId)).toEqual([B]);
        });
        cleanup();
      });

      test("a reused name (the entry re-recorded by a newer run) carries no old session", async () => {
        await index({ sessionId: A, created: "2026-11-01T00:00:00.000Z" }, [record(A, folder)]);
        recordKept(keptIndexDir(join(dir, "config")), {
          ...entry,
          mount: folder,
          created: "2026-11-02T00:00:00.000Z",
        });
        await withEnv(unreachable, async () => {
          const r = await attached(["attach", "box"], true, true);
          expect(r.seen.resume ?? null).toBeNull();
          expect(r.seen.notices).toEqual([]);
        });
        cleanup();
      });
    });

    test("attach of a name that IS in `ps` but whose workload is gone: the not-found stays a failure line (not `not in tentacle ps`)", async () => {
      // Mutation: drop `!keptEntry` in main's attach catch → the false "not in tentacle ps" line.
      const config = join(dir, "config");
      rmSync(keptIndexDir(config), { recursive: true, force: true });
      recordKept(keptIndexDir(config), entry);
      await withEnv(unreachable, async () => {
        const out: string[] = [];
        const code = await main(["bun", "cli", "attach", "box"], {
          err: (t) => out.push(t),
          out: (t) => strayStdout.push(t),
          tty: true,
          attachPlainRuntime: (async () => {
            throw new WorkloadNotFoundError("container box gone", "container", "on docker");
          }) as never,
        });
        expect(code).toBe(1);
        const text = out.join("");
        expect(text).toContain("[container] failed: container box gone");
        expect(text).not.toContain("not in tentacle ps");
        expect(text).not.toContain("log:");
      });
      rmSync(keptIndexDir(config), { recursive: true, force: true });
    });

    test("attach-any-folder: the plain fallthrough of a mounted run keeps the run's model after the move", async () => {
      // Mutation: `moveTo` without resetting the run-model memo -> the profile's default model.
      const config = join(dir, "config");
      const path = join(config, "config.jsonc");
      await mkdir(config, { recursive: true });
      const before = (await Bun.file(path).exists()) ? await readFile(path, "utf8") : undefined;
      await writeFile(
        path,
        JSON.stringify({
          model: { model: "laptop-default", baseURL: "http://default.invalid/v1" },
          // The profile's model changed since the run started: the run's wins.
          profiles: { deep: { model: { model: "deep-newer", baseURL: "http://deep.invalid/v1" } } },
        }),
      );
      const folder = join(dir, "mounted-folder-2");
      await mkdir(folder, { recursive: true });
      try {
        await withEnv(
          {
            ...unreachable,
            TENTACLE_PROFILE: undefined,
            TENTACLE_MODEL: undefined,
            TENTACLE_MODEL_BASE_URL: undefined,
          },
          async () => {
            clean();
            deadRun(
              { ...entry, mount: folder, model: "deep-chat", profile: "deep" },
              "44444444-4444-4444-8444-444444444444",
            );
            // `--resume <another session>`, nobody holds the run -> `plain`.
            const r = await attached(
              ["attach", "box", "--resume", "55555555-5555-4555-8555-555555555555"],
              true,
              true,
            );
            expect(r.seen.config?.cwd).toBe(folder);
            expect(r.seen.config?.model).toBe("deep-chat");
          },
        );
      } finally {
        if (before === undefined) await rm(path, { force: true });
        else await writeFile(path, before);
        rmSync(keptIndexDir(config), { recursive: true, force: true });
      }
    });

    test("an [error] line starts at column 0: no blank line before it", async () => {
      // Mutation: put the newline back in front of `[error]`.
      const out: string[] = [];
      const code = await main(["bun", "cli", "attach"], {
        err: (t) => out.push(t),
        out: (t) => strayStdout.push(t),
      });
      expect(code).toBe(1);
      expect(out.join("").startsWith("[error]")).toBe(true);
    });
  });

  describe("ps / rm / attach <name> (slice E)", () => {
    const keptDir = () => join(dir, "config", "kept");
    const record = async (entry: Record<string, unknown>) => {
      await mkdir(keptDir(), { recursive: true });
      await writeFile(join(keptDir(), `${String(entry.name)}.json`), JSON.stringify(entry));
    };
    const clear = () => rmSync(keptDir(), { recursive: true, force: true });

    test("ps / rm are commands, never a prompt; strict args", async () => {
      clear();
      await withEnv(unreachable, async () => {
        const ps = await run(["ps"]);
        expect(ps).toEqual({
          code: 0,
          text: "",
          stdout: "NAME   ENGINE   WHERE   MOUNT   MODEL   AGE   STATUS\n",
          err: "",
        });
        const bad = await run(["ps", "--bogus"]);
        expect(bad.code).toBe(1);
        expect(bad.text).toContain("usage: tentacle ps");
        expect(bad.stdout).toBe(""); // D6: the error and its usage are stderr's
        const noName = await run(["rm"]);
        expect(noName.code).toBe(1);
        expect(noName.text).toContain("usage: tentacle rm");
        const badEngine = await run(["ps", "--engine", "lxc"]);
        expect(badEngine.code).toBe(1);
        expect(badEngine.text).toContain('unknown engine "lxc"');
        const none = await run(["rm", "nope"]);
        expect(none.code).toBe(1);
        expect(none.text).toContain('[error] no kept container or pod named "nope"');
      });
    });

    test("the stderr note's colour follows the injected err, even with a real TTY stderr", async () => {
      clear();
      await record({
        schemaVersion: 1,
        name: "box",
        engine: "docker",
        endpoint: "unix:///nonexistent/kept.sock",
        model: "m",
        created: new Date().toISOString(),
      });
      const real = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
      const noColor = process.env.NO_COLOR;
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      Reflect.deleteProperty(process.env, "NO_COLOR");
      try {
        await withEnv(unreachable, async () => {
          const ps = await run(["ps"]);
          expect(ps.err).toContain("not reachable");
          expect(ps.err).not.toContain("\x1b");
        });
      } finally {
        if (real) {
          Object.defineProperty(process.stderr, "isTTY", real);
        } else {
          Reflect.deleteProperty(process.stderr, "isTTY");
        }
        if (noColor !== undefined) {
          process.env.NO_COLOR = noColor;
        }
        clear();
      }
    });

    test("ps lists an indexed entry; its unreachable engine is a dim skip, exit 0", async () => {
      clear();
      await record({
        schemaVersion: 1,
        name: "box",
        engine: "docker",
        endpoint: "unix:///nonexistent/kept.sock",
        model: "m",
        created: new Date().toISOString(),
      });
      await withEnv(unreachable, async () => {
        const ps = await run(["ps"]);
        expect(ps.code).toBe(0);
        expect(ps.stdout).toMatch(/box +docker +local .* unreachable/);
        // the note is on STDERR, short, and names no socket path
        expect(ps.stdout).not.toContain("not reachable");
        expect(ps.err).toBe(
          "docker local: not reachable (skipped) — no docker socket · is Docker Desktop running?\n",
        );
      });
      clear();
    });

    test("attach <name> resolves engine + location from the index; an explicit --engine does not", async () => {
      clear();
      await record({
        schemaVersion: 1,
        name: "box",
        engine: "docker",
        endpoint: "unix:///nonexistent/kept.sock",
        model: "m",
        created: new Date().toISOString(),
      });
      await withEnv(unreachable, async () => {
        // On a coloured terminal: the info lines are grey, the failure is not.
        const grey = await run(["attach", "box"], true);
        expect(grey.text).not.toContain("resolved"); // round 6: the line is gone
        expect(grey.text).toContain("\x1b[90m[container] attaching to box in");
        expect(grey.text).toContain("[container] failed: Docker engine socket not found");
        expect(grey.text).not.toContain("\x1b[90m[container] failed");
        const plainText = (await run(["attach", "box"], false)).text;
        expect(plainText).not.toContain("\x1b[");
        const resolved = await run(["attach", "box"]);
        expect(resolved.code).toBe(1);
        expect(resolved.text).not.toContain("resolved");
        expect(resolved.text).toContain(
          "[container] attaching to box in unix:///nonexistent/kept.sock",
        );
        const explicit = await run(["attach", "--engine", "docker", "box"]);
        expect(explicit.text).not.toContain("resolved");
        expect(explicit.text).toContain(
          "[container] attaching to box in unix:///nonexistent/tentacle-test.sock",
        );
      });
      clear();
    });
  });

  // Slice D (docs/feat/docker-workspace-mount.md): main plans the mount and
  // gates a dangerous source BEFORE the runtime (and Ink) starts.
  describe("workspace mount wiring", () => {
    const seenWith = async (
      args: string[],
      options: { cwd?: string; ask?: (prompt: string) => Promise<string> } = {},
      env: Record<string, string | undefined> = unreachable,
    ) => {
      let seen:
        | { workspace?: { source: string; target: string; masks: readonly unknown[] } }
        | undefined;
      const out: string[] = [];
      const prompts: string[] = [];
      const before = process.cwd();
      if (options.cwd) {
        process.chdir(options.cwd);
      }
      try {
        await withEnv(env, async () => {
          await main(["bun", "cli", ...args], {
            err: (t) => out.push(t),
            out: (t) => strayStdout.push(t),
            ...(options.ask
              ? {
                  ask: (p: string) => {
                    prompts.push(p);
                    return (options.ask as (p: string) => Promise<string>)(p);
                  },
                }
              : {}),
            startEngineRuntime: async (_config, deps) => {
              seen = deps;
              throw new Error("stop");
            },
          });
        });
      } finally {
        process.chdir(before);
      }
      return {
        reached: seen !== undefined,
        workspace: seen?.workspace,
        text: out.join(""),
        prompts,
      };
    };
    const base = ["run", "--engine", "docker", "--image", "x"];

    /** No env key: the config's `apiKeyCommand` is the key source. */
    const keyFromConfig = { ...unreachable, TENTACLE_MODEL_API_KEY: undefined };

    /** Run with `config` as the user config (restored after). */
    const withConfig = async <T>(config: Record<string, unknown>, body: () => Promise<T>) => {
      const path = join(dir, "config", "config.jsonc");
      const before = (await Bun.file(path).exists()) ? await readFile(path, "utf8") : undefined;
      await writeFile(path, JSON.stringify(config));
      try {
        return await body();
      } finally {
        if (before === undefined) await rm(path, { force: true });
        else await writeFile(path, before);
      }
    };

    test("a local engine mounts the cwd: source = its realpath, target = the cwd", async () => {
      const r = await seenWith(base);
      expect(r.workspace?.target).toBe(process.cwd());
      expect(r.workspace?.source).toBe(realpathSync(process.cwd()));
    });

    test("--no-mount → no workspace", async () => {
      const r = await seenWith([...base, "--no-mount"]);
      expect(r.reached).toBe(true);
      expect(r.workspace).toBeUndefined();
    });

    test("a remote engine → no workspace + the warning, before the runtime", async () => {
      const r = await seenWith(
        [...base, "--insecure-docker-tcp"],
        {},
        {
          ...unreachable,
          DOCKER_HOST: "tcp://127.0.0.1:9",
        },
      );
      expect(r.reached).toBe(true);
      expect(r.workspace).toBeUndefined();
      expect(r.text).toContain("[container] warning: remote engine tcp://127.0.0.1:9");
    });

    test("--no-mount / --confirm-mount on kubernetes, or on attach, are usage errors", async () => {
      for (const flag of ["--no-mount", "--confirm-mount"]) {
        const k = await seenWith(["run", "--engine", "kubernetes", "--image", "x", flag]);
        expect(k.reached).toBe(false);
        expect(k.text).toContain(`[error] ${flag} is for --engine docker or podman`);
        const a = await seenWith(["attach", "--engine", "docker", flag, "box"]);
        expect(a.text).toContain("[error]");
        expect(a.text).toContain(flag);
      }
    });

    test("the config dir as the cwd is REFUSED (D-1): never asked, --confirm-mount does not override", async () => {
      const cfg = join(dir, "config");
      for (const extra of [[], ["--confirm-mount"]]) {
        const r = await seenWith([...base, ...extra], { cwd: cfg, ask: async () => "y" });
        expect(r.reached).toBe(false);
        expect(r.prompts).toEqual([]);
        expect(r.text).toContain(
          `Refusing to mount ${realpathSync(cfg)}: it is tentacle's config directory`,
        );
      }
    });

    describe("a dangerous source ($HOME) — M5", () => {
      const home = () => homedir();
      // Only DIR masks (`~/.ssh`): `~/.netrc`, a default FILE mask, would hit the
      // case check on a case-insensitive disk, which refuses before this prompt.
      const seenAtHome = (args: string[], ask?: (prompt: string) => Promise<string>) =>
        withConfig({ mount: { hide: ["~/.ssh"] } }, () =>
          seenWith(args, { cwd: home(), ...(ask ? { ask } : {}) }),
        );

      test("no TTY → refused with the exact message, nothing started", async () => {
        const r = await seenAtHome(base);
        expect(r.reached).toBe(false);
        // ONE line, `~` for $HOME (round 4).
        expect(r.text).toContain(
          "[container] won't mount ~ (your home) without confirmation · run from a project folder, or pass --confirm-mount\n",
        );
      });

      test("TTY: asked once BEFORE the runtime; anything but y → not started", async () => {
        const r = await seenAtHome(base, async () => "\n");
        expect(r.prompts).toHaveLength(1);
        expect(r.prompts[0]).toMatch(
          /^⚠ mount ~ \(your home\) into the container\?( hidden: [^\n]+)?\nContinue\? \[y\/N\] $/,
        );
        expect(r.prompts[0]).not.toContain("You are about");
        expect(r.reached).toBe(false);
      });

      test("D4: stdout redirected, stdin+stderr TTYs → the y/N is asked, on STDERR", async () => {
        // Mutation: gate `canAsk` on stdout (or write the prompt to stdout) → red.
        const real = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
        const realErrWrite = process.stderr.write.bind(process.stderr);
        const realOutWrite = process.stdout.write.bind(process.stdout);
        const onErr: string[] = [];
        const onOut: string[] = [];
        process.stdin.isTTY = true;
        process.stderr.isTTY = true;
        process.stderr.write = ((t: string | Uint8Array) => {
          onErr.push(String(t));
          return true;
        }) as typeof process.stderr.write;
        process.stdout.write = ((t: string | Uint8Array) => {
          onOut.push(String(t));
          return true;
        }) as typeof process.stdout.write;
        const before = process.cwd();
        let reached = false;
        try {
          process.chdir(home());
          await withConfig({ mount: { hide: ["~/.ssh"] } }, () =>
            withEnv(unreachable, async () => {
              await main(["bun", "cli", ...base], {
                out: (t) => strayStdout.push(t), // stdout redirected: a sink, not a terminal
                startEngineRuntime: async () => {
                  reached = true;
                  throw new Error("stop");
                },
              });
            }),
          );
        } finally {
          process.chdir(before);
          process.stderr.write = realErrWrite;
          process.stdout.write = realOutWrite;
          process.stdin.isTTY = real.stdin;
          process.stderr.isTTY = real.stderr;
        }
        expect(onErr.join("")).toContain("Continue? [y/N] ");
        expect(onOut.join("")).not.toContain("[y/N]");
        expect(reached).toBe(false);
      });

      test("TTY: y → started with the mount", async () => {
        const r = await seenAtHome(base, async () => "y");
        expect(r.reached).toBe(true);
        expect(r.workspace?.source).toBe(realpathSync(home()));
      });

      test("--confirm-mount → started without asking", async () => {
        const r = await seenAtHome([...base, "--confirm-mount"], async () => "n");
        expect(r.prompts).toEqual([]);
        expect(r.reached).toBe(true);
      });
    });

    test(".tentacle/hide: patterns add masks; an escaping pattern warns; over 200 refuses", async () => {
      const proj = join(dir, "hide-proj");
      await mkdir(join(proj, ".tentacle"), { recursive: true });
      await writeFile(join(proj, "k.pem"), "s");
      await writeFile(join(proj, ".tentacle", "hide"), "*.pem\n../escape\n");
      // --confirm-mount: on a case-insensitive disk a FILE mask needs it (R2-3, tested below).
      const ok = await seenWith([...base, "--confirm-mount"], { cwd: proj });
      const real = realpathSync(proj);
      expect(ok.reached).toBe(true);
      expect(ok.workspace?.masks).toEqual([
        { path: join(real, "k.pem"), file: true, label: ".tentacle/hide", fromFile: true },
      ]);
      expect(ok.text).toContain('[container] warning: ".tentacle/hide": "../escape" ignored');

      await writeFile(join(proj, ".tentacle", "hide"), "*.pem\n");
      for (let i = 0; i < 201; i++) {
        await writeFile(join(proj, `n${i}.pem`), "s");
      }
      const over = await seenWith(base, { cwd: proj });
      expect(over.reached).toBe(false);
      expect(over.text).toContain("more than 200 paths");
      expect(over.text).toContain("narrow the patterns");
    });

    test("the config dir and a `mount.hideExtra` FILE inside the cwd are masked", async () => {
      const path = join(dir, "config", "config.jsonc");
      const before = (await Bun.file(path).exists()) ? await readFile(path, "utf8") : undefined;
      const secret = join(dir, "secret.txt");
      await writeFile(secret, "s");
      await writeFile(path, JSON.stringify({ mount: { hide: [], hideExtra: [secret] } }));
      try {
        const r = await seenWith([...base, "--confirm-mount"], { cwd: dir }); // (see R2-3 below)
        // (`process.cwd()` after a chdir is already physical, so target = realpath here.)
        const real = realpathSync(dir);
        expect(r.workspace?.masks).toEqual([
          { path: join(real, "secret.txt"), file: true, label: secret },
          { path: join(real, "config"), file: false, label: "tentacle's config" },
        ]);
      } finally {
        if (before === undefined) await rm(path, { force: true });
        else await writeFile(path, before);
        await rm(secret, { force: true });
      }
    });

    test("an apiKeyCommand whose key file cannot be named → a warning BEFORE the runtime (R2-1)", async () => {
      const r = await withConfig({ model: { apiKeyCommand: "echo sk-test | tr -d x" } }, () =>
        seenWith(base, {}, keyFromConfig),
      );
      expect(r.reached).toBe(true);
      expect(r.text).toContain(
        "[container] warning: apiKeyCommand: the API key file could not be determined from the command, so it is NOT hidden",
      );
    });

    // R2-3 (owner 2026-10-27): only meaningful where the temp dir IS case-insensitive (macOS APFS).
    const caseInsensitive = (() => {
      const probe = join(tmpdir(), `tentacle-CaseProbe-${process.pid}`);
      writeFileSync(probe, "");
      try {
        return existsSync(probe.toLowerCase());
      } finally {
        rmSync(probe, { force: true });
      }
    })();

    test.if(caseInsensitive)(
      "case-insensitive fs: a user-hidden FILE refuses; --confirm-mount starts and warns",
      async () => {
        const proj = join(dir, "case-proj");
        await mkdir(join(proj, ".tentacle"), { recursive: true });
        await writeFile(join(proj, "Token"), "s");
        await writeFile(join(proj, ".tentacle", "hide"), "Token\n");
        const real = realpathSync(proj);
        const refused = await seenWith(base, { cwd: proj, ask: async () => "y" });
        expect(refused.reached).toBe(false);
        expect(refused.prompts).toEqual([]);
        expect(refused.text).toContain(
          `[container] won't mount ${real}: Token would be readable inside the container\n  fix: move Token out of the folder, or pass --confirm-mount to start anyway\n`,
        );
        const confirmed = await seenWith([...base, "--confirm-mount"], { cwd: proj });
        expect(confirmed.reached).toBe(true);
        expect(confirmed.text).toContain(
          `[container] warning: --confirm-mount: these hidden files stay READABLE in the container under another spelling of their name (case-insensitive filesystem): ${join(real, "Token")} (.tentacle/hide)`,
        );
      },
    );

    test.if(caseInsensitive)(
      "case-insensitive fs: the apiKeyCommand key file inside the cwd refuses — even with --confirm-mount",
      async () => {
        const proj = join(dir, "case-key");
        await mkdir(proj, { recursive: true });
        await writeFile(join(proj, "Key"), "sk-test");
        const real = realpathSync(proj);
        for (const extra of [[], ["--confirm-mount"]]) {
          const r = await withConfig({ model: { apiKeyCommand: `cat ${join(real, "Key")}` } }, () =>
            seenWith([...base, ...extra], { cwd: proj }, keyFromConfig),
          );
          expect(r.reached).toBe(false);
          expect(r.text).toContain(
            `[container] won't mount ${real}: Key would be readable inside the container\n  fix: move Key out of the folder\n`,
          );
          expect(r.text).not.toContain("--confirm-mount to start anyway");
        }
      },
    );
  });

  test("help and usage document --engine and --keep", async () => {
    const help = await run(["--help"]);
    // An explicit --help is data: stdout.
    expect(help.stdout).toContain("--engine kubernetes|docker|podman");
    expect(help.stdout).toContain("--keep[=true|false]");
    expect(help.stdout).toContain("TENTACLE_ENGINE");
    expect(help.text).toBe("");
  });
});
