/**
 * docs/feat/a2a-client.md a2c-8: tentacle → tentacle on loopback. The laptop
 * half (`buildAgent` + the `a2a:` type + the ONE broker) drives a REAL
 * `startDaemon` (A2A token, real bind on port 0, real `fetch`, no fake
 * remote). Each test names its mutation (AGENTS §9).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig as loadDaemonConfig } from "@tentacle/config";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type StreamEvent,
  type ToolContext,
} from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { startDaemon } from "../src/serve.ts";
import { buildAgent } from "../src/wiring.ts";

const TOKEN = "a2a-e2e-secret";
const dirs: string[] = [];
const stops: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const h of stops.splice(0)) await h.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Round = readonly StreamEvent[] | "hang";

/** The serve's model: one scripted round per request; records what it was sent. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly seen: string[] = [];
  constructor(private readonly rounds: Round[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const last = request.messages.at(-1);
    this.seen.push(JSON.stringify(last?.content ?? ""));
    const round = this.rounds.shift() ?? [{ type: "text", delta: "pong" }];
    if (round === "hang") {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve());
      });
    } else {
      yield* round;
    }
    yield { type: "done" };
  }
}

const text = (delta: string): StreamEvent => ({ type: "text", delta });
const shellCall: StreamEvent = {
  type: "tool_call",
  toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "true" }) },
};

async function serve(model: Scripted, asks: "owner" | "both" = "owner") {
  const root = mkdtempSync(join(tmpdir(), "a2a-client-e2e-"));
  dirs.push(root);
  const cwd = join(root, "proj");
  const configDir = join(root, "config");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const config = await loadDaemonConfig({
    configDir,
    cwd,
    scaffold: false,
    env: { HOME: root, TENTACLE_MODEL_API_KEY: "k" },
  });
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    discovery: false,
    relay: { noRelay: true },
    createProvider: () => model,
    a2a: { token: TOKEN, asks },
  });
  stops.push(handle);
  return new URL(handle.url.replace(/^ws/, "http")).origin;
}

let dir: string;
let base: TentacleConfig;
let saved: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "a2a-client-e2e-cfg-"));
  saved = process.env.TENTACLE_CONFIG_DIR;
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  base = { ...(await loadConfig({ cwd: dir })), subagentsEnabled: true };
});

afterAll(async () => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  else process.env.TENTACLE_CONFIG_DIR = saved;
  await rm(dir, { recursive: true, force: true });
});

function laptop(origin: string, tokenCommand = `printf ${TOKEN}`) {
  const config = {
    ...base,
    harnesses: {
      ...base.harnesses,
      peer: {
        adapter: "a2a",
        enabled: true,
        card: `${origin}/.well-known/agent-card.json`,
        description: "Another tentacle",
        inputFrom: "user",
        idleMinutes: 30,
        tokenCommand,
        configured: true,
      },
    },
  } as TentacleConfig;
  const asks: PermissionRequest[] = [];
  const broker = new PermissionBroker(async (req) => {
    asks.push(req);
    // a human's words are the answer to a question; everything else is a yes
    if (req.kind === "question") return { allowed: true, message: "use note instead" };
    return { allowed: true };
  });
  const wired = buildAgent(config, { permissions: broker, harnesses: { which: () => null } });
  const run = (signal: AbortSignal = new AbortController().signal) =>
    wired.tools.execute(
      "agent_task",
      JSON.stringify({ description: "d", prompt: "ping", subagent_type: "a2a:peer" }),
      { sessionId: "s", toolCallId: "c1", signal } as unknown as ToolContext,
    );
  return { asks, run };
}

const headers = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  "a2a-version": "1.0",
};

async function listTasks(origin: string): Promise<string> {
  const res = await fetch(`${origin}/a2a`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} }),
  });
  return JSON.stringify(((await res.json()) as { result?: unknown }).result ?? {});
}

async function untilTasks(origin: string, want: string) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if ((await listTasks(origin)).includes(want)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out: ${want}`);
}

describe("a2a client → serve (loopback e2e)", () => {
  test("agent_task → the serve answers; framed report + footer `task <id>`; consent asked first", async () => {
    // mutation: drop the frame in the runner → the first-line assertion fails
    const model = new Scripted([[text("pong")]]);
    const origin = await serve(model);
    const { asks, run } = laptop(origin);
    const result = await run();
    expect(result.isError).toBeFalsy();
    expect(result.content.split("\n")[0]).toStartWith("Report from remote agent `peer`");
    expect(result.content).toContain("pong");
    expect(result.content).toMatch(/task [0-9a-f-]{8,}/);
    expect(asks.map((a) => a.tool)).toEqual(["a2a:peer"]);
    expect(model.seen.length).toBe(1);
  });

  test("a wrong token: the call fails, and neither token is ever in the text", async () => {
    // mutation: echo the token into the failure text → a not-contain assertion fails
    const origin = await serve(new Scripted([]));
    const { run } = laptop(origin, "printf wrong-token");
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("wrong-token");
    expect(result.content).not.toContain(TOKEN);
  });

  test("the remote's question reaches the broker as a `question`; the answer goes back on the same task", async () => {
    // mutation: raise the question as kind "tool" → the kinds assertion fails
    // mutation: drop the answer → the serve's model never sees «use note instead»
    const model = new Scripted([[shellCall], [text("done")]]);
    const origin = await serve(model, "both");
    const { asks, run } = laptop(origin);
    const result = await run();
    expect(result.isError).toBeFalsy();
    // consent to send, the question, consent for the reply (C3)
    expect(asks.map((a) => a.kind ?? "tool")).toEqual(["tool", "question", "tool"]);
    expect(model.seen.at(-1)).toContain("use note instead");
    expect(result.content).toContain("done");
    expect(result.content).toMatch(/task [0-9a-f-]{8,}/);
  });

  test("our abort sends CancelTask: the serve's task ends CANCELED, the call ends cancelled", async () => {
    // mutation: no CancelTask on abort → the serve task stays WORKING
    const origin = await serve(new Scripted(["hang"]));
    const { run } = laptop(origin);
    const ctl = new AbortController();
    const pending = run(ctl.signal);
    await untilTasks(origin, "TASK_STATE_WORKING");
    ctl.abort();
    const result = await pending;
    expect(result.content.toLowerCase()).toContain("cancel");
    await untilTasks(origin, "TASK_STATE_CANCELED");
  });
});
