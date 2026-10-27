import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELETE_CONTAINER_SUBCOMMAND } from "@tentacle/docker";
import { DELETE_POD_SUBCOMMAND } from "@tentacle/k8s";
import { main } from "../src/index.ts";

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
      let seen: { keepHint?: (name: string) => string } | undefined;
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
      return { reached: seen !== undefined, hint: seen?.keepHint?.("c1"), text: out.join("") };
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
  });

  test("help and usage document --engine and --keep", async () => {
    const help = await run(["--help"]);
    expect(help.text).toContain("--engine kubernetes|docker|podman");
    expect(help.text).toContain("--keep[=true|false]");
    expect(help.text).toContain("TENTACLE_ENGINE");
  });
});
