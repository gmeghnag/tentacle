import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { startWorkerRuntime } from "../src/local-runtime.ts";

// End-to-end over the REAL worker boundary: spawn the worker daemon, handshake,
// open a session, and drive one scripted turn through a fake OpenAI-compatible
// server. This is the path `tentacle -i` now uses by default, so it must
// actually boot (a silent fallback to in-process would hide a broken worker).

function sse(events: unknown[]): string {
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
}

const TURN = sse([
  { choices: [{ delta: { content: "hi from the worker" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
]);

let server: ReturnType<typeof Bun.serve>;
let dir: string;
let config: TentacleConfig;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-worker-"));
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(TURN, { headers: { "content-type": "text/event-stream" } }),
  });
  for (const key of [
    "TENTACLE_CONFIG_DIR",
    "TENTACLE_MODEL_BASE_URL",
    "TENTACLE_MODEL",
    "TENTACLE_CWD",
  ]) {
    saved[key] = process.env[key];
  }
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  process.env.TENTACLE_MODEL_BASE_URL = `http://localhost:${server.port}/v1`;
  process.env.TENTACLE_MODEL = "test";
  process.env.TENTACLE_CWD = dir;
  config = await loadConfig({ cwd: dir });
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

describe("startWorkerRuntime (real worker spawn)", () => {
  test("boots, handshakes, and runs a scripted turn over the worker boundary", async () => {
    const runtime = await startWorkerRuntime(
      config,
      {
        permissions: new PermissionBroker(),
        store: new JsonSessionStore(join(dir, "sessions")),
        resume: null,
      },
      () => {},
    );
    expect(runtime).not.toBeNull();
    if (!runtime) {
      return;
    }
    try {
      let text = "";
      for await (const event of runtime.createSession().send("hello")) {
        if (event.type === "text") {
          text += event.delta;
        }
      }
      expect(text).toContain("hi from the worker");
    } finally {
      runtime.dispose();
    }
  });
});
