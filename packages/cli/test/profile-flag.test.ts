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
  "TENTACLE_CWD",
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
      requests.push({ model: body.model, last: body.messages.at(-1)?.content });
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
  process.env.TENTACLE_CWD = dir;
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

  test("`serve --profile` is refused before anything starts", async () => {
    const out: string[] = [];
    const code = await main(["bun", "cli", "serve", "--profile", "p"], {
      write: (t) => out.push(t),
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("--profile must come before the command");
  });
});
