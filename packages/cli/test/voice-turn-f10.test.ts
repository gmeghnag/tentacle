/**
 * C3, T6·F10 (docs/feat/voice-conversation.md §4, AGENTS §7 Persistence): the
 * transient spoken-style line NEVER reaches disk.
 *
 * The line is a fact about ONE outgoing request ("the user is listening"), not
 * about the conversation. If it were appended to `messages` before the request
 * it would be written to the laptop's `<uid>.jsonl`, to `session/log`, and to a
 * `serve` daemon's own store — a pod-supplied/system string persisted as if the
 * person had said it, and re-served to every later client.
 *
 * Asserted here over REAL files:
 *  - a `serve` daemon's store (`<configDir>/daemon/<projectKey>/<uid>.jsonl`),
 *    driven through a real turn that carries a voice prompt;
 *  - the daemon-side `session/log` the laptop's writer would consume.
 *
 * Mutations that must turn this red: append the line to `messages` in the
 * agent loop instead of to the request → both tests red.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { VOICE_SPOKEN_LINE } from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer } from "@tentacle/transport";
import { daemonStoreDir, startDaemon } from "../src/serve.ts";

const dirs: string[] = [];
const handles: { stop(): Promise<void> }[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const stop of cleanups.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Records the requests it is given and answers with a sentence. */
class Recording implements ModelProvider {
  readonly id = "recording";
  readonly calls: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...request, messages: [...request.messages] });
    yield { type: "text", delta: "spoken answer" };
    yield { type: "done" };
  }
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}

function rig() {
  const root = mkdtempSync(join(tmpdir(), "voice-f10-"));
  dirs.push(root);
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return { root, cwd, configDir };
}

/** A raw JSON-RPC client over the daemon's WebSocket (the `serve-persistence` rig). */
async function client(url: string) {
  const ws = new WebSocket(url);
  const replies = new Map<number, { result?: unknown; error?: { code: number } }>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (typeof msg.id === "number") replies.set(msg.id, msg);
  };
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  cleanups.push(() => ws.close());
  let id = 0;
  const request = async (method: string, params: unknown) => {
    const n = ++id;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    await until(() => replies.has(n));
    return replies.get(n);
  };
  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  return { request };
}

describe("F10 the transient voice line is never persisted", () => {
  test("a serve daemon's store carries no transient line after a voice turn", async () => {
    const where = rig();
    const model = new Recording();
    const config = await loadConfig({
      configDir: where.configDir,
      cwd: where.cwd,
      scaffold: false,
      env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
    });
    const handle = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      discovery: false,
      createProvider: () => model,
    });
    handles.push(handle);

    const a = await client(handle.url);
    await a.request("session/open", { sessionId: "s-voice", create: true });
    await a.request("session/prompt", {
      sessionId: "s-voice",
      turnId: "t1",
      content: [{ type: "text", text: "ciao" }],
      voice: { reasoning: "off" },
    });
    // The turn really carried the line to the model...
    await until(() => model.calls.length >= 1);
    expect(
      model.calls[0]?.messages.some((m) => m.role === "system" && m.content === VOICE_SPOKEN_LINE),
    ).toBe(true);

    // ...and the store on disk does not.
    const store = daemonStoreDir(config);
    await until(() => readdirSync(store).some((f) => f.endsWith(".jsonl")));
    const files = readdirSync(store).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    // Wait on the STORE's own commit, not on the model call above: the prompt is
    // committed to the log a save later than the request is made, and under a
    // loaded gate that save had not landed when this read it (`turn_start` on
    // disk, the user's message not yet). Bounded, and only for the read: what is
    // asserted below is unchanged.
    const committed = (): boolean =>
      files.some((file) => readFileSync(join(store, file), "utf8").includes("ciao"));
    const deadline = Date.now() + 10_000;
    while (!committed() && Date.now() < deadline) {
      await tick(10);
    }
    for (const file of files) {
      const text = readFileSync(join(store, file), "utf8");
      expect(text).not.toContain(VOICE_SPOKEN_LINE);
      // The user's own words ARE there: the turn was recorded, only the
      // transient fact was not.
      expect(text).toContain("ciao");
    }
  }, 20_000);

  test("the daemon-side session/log never carries it either", async () => {
    // The laptop persists what it reads from `session/log`, so a leaked line
    // here would end up in `<uid>.jsonl` even if the store above were clean.
    const where = rig();
    const model = new Recording();
    const config = await loadConfig({
      configDir: where.configDir,
      cwd: where.cwd,
      scaffold: false,
      env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
    });
    const handle = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      discovery: false,
      createProvider: () => model,
    });
    handles.push(handle);

    const a = await client(handle.url);
    await a.request("session/open", { sessionId: "s-log", create: true });
    await a.request("session/prompt", {
      sessionId: "s-log",
      turnId: "t1",
      content: [{ type: "text", text: "ciao" }],
      voice: { reasoning: "off" },
    });
    await until(() => model.calls.length >= 1);
    await tick(50); // let the turn's commits land

    const log = (await a.request("session/log", { sessionId: "s-log" }))?.result;
    expect(log).toBeDefined();
    expect(JSON.stringify(log)).not.toContain(VOICE_SPOKEN_LINE);
    expect(JSON.stringify(log)).toContain("ciao");
  }, 20_000);
});
