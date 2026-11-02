import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DELETE_CONTAINER_SUBCOMMAND } from "@tentacle/docker";
import { DELETE_POD_SUBCOMMAND } from "@tentacle/k8s";
import type { EngineHost } from "../src/engine-host.ts";
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
    // The workspace is the launch directory (no TENTACLE_CWD): launch from `dir`.
    const launch = process.cwd();
    process.chdir(dir);
    let code: number;
    try {
      code = await main(["bun", "cli", "create out.txt"], { write: (t) => out.push(t) });
    } finally {
      process.chdir(launch);
    }
    const text = out.join("");

    expect(code).toBe(0);
    expect(text).toContain("[tool] fs_write");
    expect(text).toContain("[diff] out.txt");
    expect(text).toContain("Done. File written.");
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("hello from agent");
  });

  test("prints help and exits non-zero with no prompt", async () => {
    const out: string[] = [];
    const code = await main(["bun", "cli"], { write: (t) => out.push(t) });
    expect(code).toBe(1);
    expect(out.join("")).toContain("Usage:");
  });

  test("attach without a pod name prints usage and exits non-zero", async () => {
    const out: string[] = [];
    const code = await main(["bun", "cli", "attach"], { write: (t) => out.push(t) });
    expect(code).toBe(1);
    expect(out.join("")).toContain("usage: tentacle attach <name>");
  });

  test("--version prints the version and exits 0 without touching config", async () => {
    // Point the config dir at a FRESH, non-existent path: if `--version` ever
    // loaded config it would scaffold this directory (first-run side effect).
    const freshConfigDir = join(dir, "config-never-created");
    const saved = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = freshConfigDir;
    try {
      const out: string[] = [];
      const code = await main(["bun", "cli", "--version"], { write: (t) => out.push(t) });
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
      const io = { write: (t: string) => out.push(t), writeErr: (t: string) => err.push(t) };
      expect(await main(["bun", "cli"], io)).toBe(1); // help path: config loaded locally
      expect(err).toEqual([
        `[skills] skipped skill at ${join(badDir, "SKILL.md")}: no description\n`,
      ]);
      expect(out.join("")).not.toContain("[skills]"); // never on stdout

      err.length = 0;
      expect(await main(["bun", "cli", "run"], io)).toBe(1); // no --image: fails after config
      expect(err).toEqual([]); // a pod session uses the pod's skills
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
      const io = { write: (t: string) => out.push(t), writeErr: (t: string) => err.push(t) };
      expect(await main(["bun", "cli"], io)).toBe(1); // help path: config loaded locally
      expect(err).toEqual([
        `[agents] agent "reviewer" (${join(agents, "reviewer.md")}): model [oops] ignored — expected a non-empty string\n`,
        `[agents] agent "reviewer" (${join(agents, "reviewer.md")}): contextWindow "abc" ignored — expected a positive whole number of tokens\n`,
      ]);
      expect(out.join("")).not.toContain("[agents]"); // never on stdout

      err.length = 0;
      expect(await main(["bun", "cli", "run"], io)).toBe(1); // no --image: fails after config
      expect(err).toEqual([]); // a pod session uses the pod's agent defs
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
        const io = { write: (t: string) => out.push(t), writeErr: (t: string) => err.push(t) };
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
      const io = { write: (t: string) => out.push(t), writeErr: (t: string) => err.push(t) };
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
  const run = async (args: string[]) => {
    const out: string[] = [];
    const code = await main(["bun", "cli", ...args], { write: (t) => out.push(t) });
    return { code, text: out.join("") };
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
        "p1",
      ]);
      expect(flagWins.text).toContain("[pod] creating p1 (image x) in namespace dev");
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
            write: (t) => out.push(t),
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
      const on = await keepHintFor(["--profile", "p", ...base], { keep: false, ...profiles });
      expect(on.hint).toContain("attach");
      const offProfiles = { profiles: { p: { keep: false } } };
      const off = await keepHintFor(["--profile", "p", ...base], { keep: true, ...offProfiles });
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
      } = {},
    ) => {
      const out: string[] = [];
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
        write: (t) => out.push(t),
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
          return { name: "c1", binPath: "/usr/local/bin/tentacle", removeUnlessKept: () => {} };
        },
        spawnRelay: (file, _cwd, runDir) => {
          calls.spawn += 1;
          spec = readSpec(file);
          writeOwner(runDir, owned(spec.sessionId));
          return { exited: () => false };
        },
      });
      await rm(path, { force: true });
      return { code, text: out.join(""), calls, spec, hint, removedAtEnd };
    };
    const refused = { provision: 0, spawn: 0, runtime: 0 };

    for (const [why, args, needle] of [
      ["--prompt with no --detach", [...base, "--prompt", "hi"], "--prompt needs --detach"],
      ["--detach with no prompt", [...base, "--detach"], "--detach needs --prompt"],
      [
        "--auto-accept with no --detach",
        [...base, "--auto-accept"],
        "--auto-accept needs --detach",
      ],
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
          expect(r.text).toContain("removed when the run goes idle");
          expect(r.text).toContain(`tentacle --resume ${r.spec?.sessionId}`);
          expect(r.text).not.toContain("Re-attach once it is done");
          expect(r.text).toContain("Attach any time: "); // D17: at once, no `--resume`
          expect(r.text).not.toContain("undefined");
          expect(r.removedAtEnd).toBe(true);
        }
        const kept = await detached([...base, "--detach", "--prompt", "hi"]);
        expect(kept.spec?.keep).toBe(true);
        expect(kept.removedAtEnd).toBeUndefined();
        expect(kept.text).not.toContain("removed when the run goes idle");
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
          ["bun", "cli", ...base, "--detach", "--prompt", "hi", "--keep=false", "box"],
          {
            write: (t) => out.push(t),
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
        expect(text).toContain("box stays up: the run never started — tentacle attach");
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
          write: () => {},
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
        expect(stdin.text).toContain("--detach needs --prompt");
        expect(stdin.calls).toEqual(refused);
        const blank = await detached([...base, "--detach", "--prompt=   "]);
        expect(blank.code).toBe(1);
        expect(blank.calls).toEqual(refused);
      });
    });

    test("started: no TUI runtime, the spec names the session, the line the way back", async () => {
      await withEnv(unreachable, async () => {
        const r = await detached([...base, "--detach", "--prompt", "hello", "--auto-accept"]);
        expect(r.code).toBe(0);
        expect(r.calls).toEqual({ provision: 1, spawn: 1, runtime: 0 });
        expect(r.spec).toMatchObject({ prompt: "hello", autoAccept: true, mode: "start" });
        // D17 (docs/fix/detach-live.md A7): the launch line, `attach` at once, no `--resume`.
        expect(r.text).toContain("Attach any time: tentacle attach --engine docker c1.");
        expect(r.text).not.toContain(`--resume ${r.spec?.sessionId}`);
        expect(r.text).toContain("auto-accepting pod tool asks");
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
        const code = await main(["bun", "cli", ...base, "--detach", "--prompt", "hi", "box"], {
          write: (t) => out.push(t),
          provisionWorkload: (config, deps) =>
            provisionWorkload(config, { ...deps, host: fake, appVersion: "dev" }),
        });
        const armed = process.listeners("exit").filter((l) => !before.includes(l));
        for (const listener of armed) {
          process.off("exit", listener);
          listener(0);
        }
        expect(code).toBe(1);
        expect(removed).toEqual([]);
        expect(armed).toEqual([]);
        expect(out.join("")).toContain("kept box");
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
          const r = await detached(["--profile", "deep", ...base, "--detach", "--prompt", "hi"], {
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

    test("not in the kept index: fatal, no relay (it needs the entry)", async () => {
      await withEnv(unreachable, async () => {
        const r = await detached([...base, "--detach", "--prompt", "hi"], { record: false });
        expect(r.code).toBe(1);
        expect(r.text).toContain("kept index");
        expect(r.calls).toEqual({ provision: 1, spawn: 0, runtime: 0 });
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
          { write: (t) => out.push(t), tty: true },
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
          { write: (t) => other.push(t), tty: true },
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
        await main(["bun", "cli", "attach", "box"], { write: (t) => out.push(t), tty: true });
        expect(out.join("")).toContain("attaching to box");
        setup(live());
        const other = await run(["attach", "--engine", "podman", "box"]);
        expect(other.text).not.toContain("a detached run owns it");
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
    });

    /** `attach` with the engine runtime and the TUI replaced; records what each got. */
    const attached = async (args: string[], tty = true) => {
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
        config?: { model?: string; baseURL?: string };
        tuiModel?: string;
      } = { quit: 0 };
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
        residentUse: async () => null,
      };
      const code = await main(["bun", "cli", ...args], {
        write: (t) => out.push(t),
        tty,
        attachEngineRuntime: (async (
          config: { model?: string; baseURL?: string },
          deps: { permissions: unknown; sessionId?: string; shared?: true },
        ) => {
          seen.config = config;
          seen.runtimeBroker = deps.permissions;
          seen.sessionId = deps.sessionId;
          seen.shared = deps.shared === true;
          return runtime;
        }) as never,
        startTui: (async (
          _session: unknown,
          options: {
            permissions: unknown;
            runQuit?: unknown;
            createSession?: unknown;
            autoAccept?: unknown;
            model?: string;
          },
        ) => {
          seen.tuiModel = options.model;
          seen.tuiBroker = options.permissions;
          seen.runQuit = options.runQuit;
          seen.createSession = options.createSession;
          seen.autoAccept = options.autoAccept;
        }) as never,
      });
      return { code, text: out.join(""), seen, runtime };
    };

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
          const explicit = await at(["--profile", "other", "attach", "box"]);
          expect(explicit.seen.config).toMatchObject({
            model: "other-model",
            baseURL: "http://other.invalid/v1",
          });
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
          expect(r.text).toContain("resolved box → docker");
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

    test("a run of another folder: refused, naming it, nothing dialled", async () => {
      setup(`${2 ** 30} 1`);
      writeOwner(runDirFor(join(dir, "config"), entry), {
        schemaVersion: 1,
        kind: "relay",
        pid: 1,
        appVersion: "1",
        sessionId: "44444444-4444-4444-8444-444444444444",
        state: "idle",
        lastActivityAt: 1,
        autoAccept: false,
        cwd: "/elsewhere-project",
        created: entry.created,
      });
      await withEnv(unreachable, async () => {
        const r = await attached(["attach", "box"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("this detached run belongs to /elsewhere-project");
        expect(r.seen.runtimeBroker).toBeUndefined();
      });
      rmSync(keptIndexDir(join(dir, "config")), { recursive: true, force: true });
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
        expect(ps).toEqual({ code: 0, text: "No kept containers or pods.\n" });
        const bad = await run(["ps", "--bogus"]);
        expect(bad.code).toBe(1);
        expect(bad.text).toContain("usage: tentacle ps");
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
        expect(ps.text).toMatch(/box +docker +local .* unreachable/);
        expect(ps.text).toContain("docker local: not reachable (skipped)");
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
        const resolved = await run(["attach", "box"]);
        expect(resolved.code).toBe(1);
        expect(resolved.text).toContain("[container] resolved box → docker, local");
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
            write: (t) => out.push(t),
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
      // Only DIR masks (`~/.ssh`): the real home's default FILE masks
      // (`~/.docker/config.json`…) would hit the case check on a
      // case-insensitive disk, which refuses before this prompt.
      const seenAtHome = (args: string[], ask?: (prompt: string) => Promise<string>) =>
        withConfig({ mount: { hide: ["~/.ssh"] } }, () =>
          seenWith(args, { cwd: home(), ...(ask ? { ask } : {}) }),
        );

      test("no TTY → refused with the exact message, nothing started", async () => {
        const r = await seenAtHome(base);
        expect(r.reached).toBe(false);
        expect(r.text).toContain(
          `Refusing to mount ${realpathSync(home())} (your home directory) without confirmation.\nRun from your project directory, or pass --confirm-mount to proceed.`,
        );
      });

      test("TTY: asked once BEFORE the runtime; anything but y → not started", async () => {
        const r = await seenAtHome(base, async () => "\n");
        expect(r.prompts).toHaveLength(1);
        expect(r.prompts[0]).toContain("⚠ You are about to mount");
        expect(r.prompts[0]).toContain("Continue? [y/N] ");
        expect(r.reached).toBe(false);
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
          `Refusing to mount ${real}: its filesystem is case-insensitive`,
        );
        expect(refused.text).toContain(`  ${join(real, "Token")} (.tentacle/hide)`);
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
          expect(r.text).toContain(`${join(real, "Key")} (the API key file)`);
          expect(r.text).not.toContain("Or pass --confirm-mount");
        }
      },
    );
  });

  test("help and usage document --engine and --keep", async () => {
    const help = await run(["--help"]);
    expect(help.text).toContain("--engine kubernetes|docker|podman");
    expect(help.text).toContain("--keep[=true|false]");
    expect(help.text).toContain("TENTACLE_ENGINE");
  });
});
