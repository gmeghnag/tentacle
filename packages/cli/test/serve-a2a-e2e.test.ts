/**
 * docs/feat/a2a.md S10: `serve --a2a-token` end to end — a real `startDaemon`
 * (loopback, port 0) driven over HTTP JSON-RPC (the CLI has no SDK dependency:
 * the wire IS the contract). Card → SendMessage → stream → GetTask → ListTasks
 * → CancelTask → caller abort → restart on the same store → archive.
 * Each test names its mutation (AGENTS §9).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { ARGS, parseArgs, resolveA2AToken } from "../src/flags.ts";
import { parseA2AAsks } from "../src/serve-a2a.ts";
import { type ServeOptions, daemonStoreDir, startDaemon } from "../src/serve.ts";

const TOKEN = "a2a-secret";
const dirs: string[] = [];
const handles: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Answers "pong"; with a gate it waits (honouring the turn's abort) before answering. */
class PongModel implements ModelProvider {
  readonly id = "pong";
  gate: Promise<void> | undefined;
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.gate !== undefined) {
      await Promise.race([
        this.gate,
        new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve())),
      ]);
    }
    if (request.signal?.aborted) {
      return;
    }
    yield { type: "text", delta: "pong" };
    yield { type: "done" };
  }
}

interface Rig {
  readonly root: string;
  readonly configDir: string;
  readonly cwd: string;
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "serve-a2a-"));
  dirs.push(root);
  const cwd = join(root, "proj");
  const configDir = join(root, "config");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  return { root, configDir, cwd };
}

async function serve(where: Rig, model: PongModel, over: Partial<ServeOptions> = {}) {
  const config = await loadConfig({
    configDir: where.configDir,
    cwd: where.cwd,
    scaffold: false,
    env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
  });
  const audit: string[] = [];
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    discovery: false,
    relay: { noRelay: true },
    createProvider: () => model,
    onAudit: (line) => audit.push(line),
    a2a: { token: TOKEN },
    ...over,
  });
  handles.push(handle);
  const base = new URL(handle.url.replace(/^ws/, "http")).origin;
  return { handle, base, audit, store: daemonStoreDir(config) };
}

interface Rpc {
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

async function call(base: string, method: string, params: unknown): Promise<Rpc> {
  const res = await fetch(`${base}/a2a`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "a2a-version": "1.0",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as Rpc;
}

const send = (base: string, text: string, contextId: string) =>
  call(base, "SendMessage", {
    message: { messageId: crypto.randomUUID(), role: "ROLE_USER", contextId, parts: [{ text }] },
  });

interface TaskJson {
  readonly id: string;
  readonly contextId: string;
  readonly status: { state: string };
}
const taskOf = (r: Rpc): TaskJson => {
  const t = (r.result?.task ?? r.result) as TaskJson | undefined;
  if (t === undefined) throw new Error(`no task in ${JSON.stringify(r)}`);
  return t;
};

async function until(read: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${what}`);
}

describe("serve flags", () => {
  test("the four A2A flags are accepted by `serve`; a2a-workflows is a bool", () => {
    // mutation: drop one from ARGS.serve → parseArgs refuses it as unknown
    const parsed = parseArgs(
      ["--a2a-token", "t", "--a2a-token-command", "x", "--a2a-asks", "both", "--a2a-workflows"],
      ARGS.serve,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.flags.get("a2a-asks")).toBe("both");
      expect(parsed.bools.has("a2a-workflows")).toBe(true);
    }
  });

  test("token resolution: none = off; empty and both-given refused; never the WS token", async () => {
    // mutation: fall back to --token → the first assertion fails
    expect(await resolveA2AToken(new Map([["token", "ws"]]))).toBeUndefined();
    expect(await resolveA2AToken(new Map([["a2a-token", "t"]]))).toBe("t");
    expect(await resolveA2AToken(new Map([["a2a-token-command", "printf cmdtok"]]))).toBe("cmdtok");
    await expect(resolveA2AToken(new Map([["a2a-token", ""]]))).rejects.toThrow(/empty/);
    await expect(
      resolveA2AToken(
        new Map([
          ["a2a-token", "a"],
          ["a2a-token-command", "b"],
        ]),
      ),
    ).rejects.toThrow(/not both/);
  });

  test("--a2a-asks: owner|both only (fail closed)", () => {
    // mutation: default an unknown word to "both" → the throw assertion fails
    expect(parseA2AAsks(undefined)).toBe("owner");
    expect(parseA2AAsks("both")).toBe("both");
    expect(() => parseA2AAsks("caller")).toThrow(/owner.*both/);
  });
});

describe("serve --a2a-token (e2e)", () => {
  test("A2A off without a token: /a2a is not served, the card is absent", async () => {
    // mutation: always mount the route → the card answers 200
    const { base } = await serve(rig(), new PongModel(), { a2a: undefined });
    const card = await fetch(`${base}/.well-known/agent-card.json`);
    expect(card.status).not.toBe(200);
    const post = await fetch(`${base}/a2a`, { method: "POST", body: "{}" });
    expect(post.status).not.toBe(200);
  });

  test("card is public with the daemon's own URL; calls need the A2A token", async () => {
    // mutation: build the card with a fixed URL → the interface url assertion fails
    const { base, audit } = await serve(rig(), new PongModel());
    const card = (await (await fetch(`${base}/.well-known/agent-card.json`)).json()) as {
      supportedInterfaces: { url: string }[];
    };
    expect(card.supportedInterfaces[0]?.url).toBe(`${base}/a2a`);
    const none = await fetch(`${base}/a2a`, { method: "POST", body: "{}" });
    expect(none.status).toBe(401);
    expect(audit).toContain("a2a-auth-failure");
  });

  test("SendMessage → COMPLETED with the answer; GetTask and ListTasks see it; WS route unaffected", async () => {
    // mutation: wire the executor with a different SessionHost → no task found / not completed
    const { base, handle } = await serve(rig(), new PongModel());
    const sent = taskOf(await send(base, "ping", "ctx1"));
    expect(sent.status.state).toBe("TASK_STATE_COMPLETED");
    const got = taskOf(await call(base, "GetTask", { id: sent.id }));
    expect(got.status.state).toBe("TASK_STATE_COMPLETED");
    expect(JSON.stringify(got)).toContain("pong");
    const listed = await call(base, "ListTasks", {});
    expect(JSON.stringify(listed.result)).toContain(sent.id);
    const ws = new WebSocket(handle.url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws failed")));
    });
    ws.close();
  });

  test("streaming: SSE carries the answer and ends terminal", async () => {
    // mutation: route SendStreamingMessage to the blocking path → the response is not an event stream
    const { base } = await serve(rig(), new PongModel());
    const res = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "a2a-version": "1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendStreamingMessage",
        params: {
          message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER",
            contextId: "ctx-s",
            parts: [{ text: "ping" }],
          },
        },
      }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("pong");
    expect(body).toContain("TASK_STATE_COMPLETED");
  });

  test("CancelTask ends a running task as CANCELED; a dropped caller does not stop the unit", async () => {
    // mutation: cancel does not reach the session → the task stays WORKING
    // mutation: abort the unit when the HTTP caller drops → the second task ends CANCELED
    const model = new PongModel();
    let open: () => void = () => {};
    model.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { base } = await serve(rig(), model);
    const abort = new AbortController();
    const first = fetch(`${base}/a2a`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "a2a-version": "1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendStreamingMessage",
        params: {
          message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER",
            contextId: "ctx-drop",
            parts: [{ text: "slow" }],
          },
        },
      }),
    }).catch(() => undefined);
    const listWorking = async () =>
      JSON.stringify((await call(base, "ListTasks", {})).result ?? {});
    await until(async () => (await listWorking()).includes("TASK_STATE_WORKING"), "task working");
    abort.abort();
    await first;
    // the unit continues: still WORKING after the caller left, then completes
    expect(await listWorking()).toContain("TASK_STATE_WORKING");
    open();
    await until(async () => (await listWorking()).includes("TASK_STATE_COMPLETED"), "completed");

    // a second, cancelled one
    model.gate = new Promise<void>(() => {});
    const started = call(base, "SendMessage", {
      message: {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        contextId: "ctx-cancel",
        parts: [{ text: "slow" }],
      },
      configuration: { returnImmediately: true },
    });
    const tasks = async () =>
      ((await call(base, "ListTasks", { contextId: "ctx-cancel" })).result?.tasks ??
        []) as TaskJson[];
    await until(async () => (await tasks()).length > 0, "second task listed");
    const id = (await tasks())[0]?.id ?? "";
    const canceled = taskOf(await call(base, "CancelTask", { id }));
    expect(["TASK_STATE_CANCELED", "TASK_STATE_WORKING"]).toContain(canceled.status.state);
    await until(async () => (await tasks())[0]?.status.state === "TASK_STATE_CANCELED", "canceled");
    await started.catch(() => undefined);
  });

  test("restart on the same store: GetTask still answers a finished turn", async () => {
    // mutation: drop the unit_end carry/derivation on reload → TaskNotFound after the restart
    const where = rig();
    const a = await serve(where, new PongModel());
    const sent = taskOf(await send(a.base, "ping", "ctx-r"));
    expect(sent.status.state).toBe("TASK_STATE_COMPLETED");
    await a.handle.stop();
    const b = await serve(where, new PongModel());
    const got = await call(b.base, "GetTask", { id: sent.id });
    expect(got.error).toBeUndefined();
    expect(taskOf(got).status.state).toBe("TASK_STATE_COMPLETED");
  });

  test("archived context: GetTask answers, the session stays archived, no file is written", async () => {
    // mutation: reopen the session to read its task → archivedAt cleared / files change
    const where = rig();
    const { base, audit, store } = await serve(where, new PongModel(), {
      sessionTtlMs: 200,
      sweepIntervalMs: 20,
    });
    const sent = taskOf(await send(base, "ping", "ctx-a"));
    await until(() => audit.some((l) => l.startsWith("session-archived")), "archived");
    // the archive write lands after its audit line: wait for the writer's lock to go
    const locks = () => readdirSync(store).filter((f) => f.endsWith(".lock") && f !== ".lock");
    await until(() => locks().length === 0, "archive write settled");
    const snapshot = () =>
      readdirSync(store)
        .filter((f) => !f.endsWith(".lock"))
        .sort()
        .map((f) => {
          try {
            return `${f}:${readFileSync(join(store, f), "utf8")}`;
          } catch {
            return f;
          }
        });
    const before = snapshot();
    const got = await call(base, "GetTask", { id: sent.id });
    expect(got.error).toBeUndefined();
    expect(taskOf(got).status.state).toBe("TASK_STATE_COMPLETED");
    expect(snapshot()).toEqual(before);
    expect(audit.filter((l) => l.includes("reopen"))).toEqual([]);
  });
});
