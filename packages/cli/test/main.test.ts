import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(out.join("")).toContain("usage: tentacle attach <pod>");
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
