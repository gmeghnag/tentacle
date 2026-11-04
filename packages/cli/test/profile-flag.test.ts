import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";

// End-to-end through `main` (docs/feat/config-profiles.md): a fake
// OpenAI-compatible server captures each chat request. Before this feature a
// leading `--profile p` fell through to the one-shot path and was SENT TO THE
// MODEL as part of the prompt, with the base config's model.

const DONE = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

let server: ReturnType<typeof Bun.serve>;
let dir: string;
const requests: Array<{ model: string; last: unknown }> = [];
const KEYS = [
  "TENTACLE_CONFIG_DIR",
  "TENTACLE_MODEL_BASE_URL",
  "TENTACLE_MODEL",
  "TENTACLE_MODEL_API_KEY",
  "TENTACLE_PROFILE",
  "TENTACLE_NO_AGENTS_MD",
];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tentacle-profile-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; messages: Array<{ content: unknown }> };
      // The context line (docs/feat/context-awareness.md) is the only addition.
      const last = String(body.messages.at(-1)?.content).replace(/\n\n\[context: [^\]]+\]$/, "");
      requests.push({ model: body.model, last });
      return new Response(DONE, { headers: { "content-type": "text/event-stream" } });
    },
  });
  for (const key of KEYS) saved[key] = process.env[key];
  for (const key of KEYS) delete process.env[key];
  const configDir = join(dir, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.jsonc"),
    JSON.stringify({
      model: { baseURL: `http://localhost:${server.port}/v1`, model: "base-model" },
      profiles: { p: { model: { model: "profile-model" } } },
    }),
    "utf8",
  );
  process.env.TENTACLE_CONFIG_DIR = configDir;
  process.env.TENTACLE_NO_AGENTS_MD = "1";
});

afterAll(async () => {
  server.stop(true);
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(dir, { recursive: true, force: true });
});

describe("tentacle --profile (end-to-end)", () => {
  test("the profile's model is used and the prompt is exactly the prompt", async () => {
    requests.length = 0;
    const out: string[] = [];
    const code = await main(["bun", "cli", "--profile", "p", "say", "hi"], {
      write: (t) => out.push(t),
    });
    expect(code).toBe(0);
    expect(requests).toEqual([{ model: "profile-model", last: "say hi" }]);
  });

  test("an unknown profile exits 1 with the reason; no request is made", async () => {
    requests.length = 0;
    const out: string[] = [];
    const code = await main(["bun", "cli", "--profile", "nope", "say", "hi"], {
      write: (t) => out.push(t),
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain('unknown profile "nope" (defined: p)');
    expect(requests).toEqual([]);
  });

  test("`--profile p serve` (before the command) is refused before anything starts, naming the right form", async () => {
    // Owner 2026-11-03: they are flags of the session commands, written after.
    // Mutation (round 4): drop the before-a-subcommand check → `serve` reaches the
    // daemon seam, which throws at once: red in milliseconds, no real daemon.
    const out: string[] = [];
    const started: string[] = [];
    const code = await main(["bun", "cli", "--profile", "p", "serve"], {
      write: (t) => out.push(t),
      startDaemon: async (config) => {
        started.push(config.model);
        throw new Error("a misplaced --profile must not start a daemon");
      },
    });
    expect(started).toEqual([]);
    expect(code).toBe(1);
    expect(out.join("")).toContain("--profile goes after the command: tentacle serve --profile p");
  });

  test("`serve --model x --profile p` (after the command) reaches the daemon with that model", async () => {
    // Owner OQ3: `serve --model` is the model its `connect` clients use.
    const out: string[] = [];
    const started: string[] = [];
    const code = await main(["bun", "cli", "serve", "--model", "x", "--profile", "p"], {
      write: (t) => out.push(t),
      startDaemon: async (config) => {
        started.push(config.model);
        throw new Error("stub: no real daemon");
      },
    });
    expect(started).toEqual(["x"]);
    expect(code).toBe(1); // the stub ended it
    expect(out.join("")).toContain("stub: no real daemon");
  });

  test("`ps --profile p` is the normal unknown-option error (ps shows every entry)", async () => {
    const out: string[] = [];
    const code = await main(["bun", "cli", "ps", "--profile", "p"], { write: (t) => out.push(t) });
    expect(code).toBe(1);
    expect(out.join("")).toContain("unknown option --profile");
  });
});

describe("tentacle --model (end-to-end)", () => {
  test("a one-shot prompt: the id beats the file's, the prompt is exactly the prompt", async () => {
    requests.length = 0;
    const code = await main(["bun", "cli", "--model", "cli-model", "say", "hi"], {
      write: () => {},
    });
    expect(code).toBe(0);
    expect(requests).toEqual([{ model: "cli-model", last: "say hi" }]);
  });

  test("with --profile: that id, on the profile's endpoint; and it beats TENTACLE_MODEL", async () => {
    requests.length = 0;
    process.env.TENTACLE_MODEL = "env-model";
    try {
      const code = await main(["bun", "cli", "--profile", "p", "--model=cli-model", "say", "hi"], {
        write: () => {},
      });
      expect(code).toBe(0);
    } finally {
      Reflect.deleteProperty(process.env, "TENTACLE_MODEL");
    }
    expect(requests).toEqual([{ model: "cli-model", last: "say hi" }]);
  });

  test("--help and --version still work after --model / --profile (owner Q-R7)", async () => {
    // Mutation: drop the info-flag handling → `unknown option --version/--help`, exit 1.
    requests.length = 0;
    for (const [argv, expected] of [
      [["--model", "foo", "--version"], /^tentacle \S+\n$/],
      [["--profile", "p", "--version"], /^tentacle \S+\n$/],
      [["--profile", "p", "--model=foo", "-h"], /Usage:/],
      [["run", "--profile", "p", "--help"], /Usage:/],
      [["attach", "box", "--model", "foo", "--help"], /Usage:/],
      [["serve", "--model", "foo", "--help"], /Usage:/],
    ] as const) {
      const out: string[] = [];
      const code = await main(["bun", "cli", ...argv], {
        write: (t) => out.push(t),
        startDaemon: async () => {
          throw new Error("--help must not start a daemon");
        },
      });
      expect([argv.join(" "), code]).toEqual([argv.join(" "), 0]);
      expect(out.join("")).toMatch(expected);
    }
    // A one-shot prompt keeps its own `--help` text, and a real unknown option still errors.
    const out: string[] = [];
    expect(await main(["bun", "cli", "--model", "m", "say", "--help"], { write: () => {} })).toBe(
      0,
    );
    expect(requests).toEqual([{ model: "m", last: "say --help" }]);
    expect(
      await main(["bun", "cli", "run", "--bogus", "--help"], { write: (t) => out.push(t) }),
    ).toBe(1);
    expect(out.join("")).toContain("unknown option --bogus");
  });

  test("before a session command, or on `connect`: refused with the right form", async () => {
    requests.length = 0;
    const out: string[] = [];
    const io = { write: (t: string) => void out.push(t) };
    expect(await main(["bun", "cli", "--model", "x", "run", "--image", "i"], io)).toBe(1);
    expect(out.join("")).toContain("--model goes after the command: tentacle run --model x");
    out.length = 0;
    expect(await main(["bun", "cli", "connect", "ws://h:1", "--model", "x"], io)).toBe(1);
    expect(out.join("")).toContain("start that daemon with `tentacle serve --model <id>`");
    expect(requests).toEqual([]);
  });
});
