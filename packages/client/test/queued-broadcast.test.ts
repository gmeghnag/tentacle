import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  Method,
  Notification,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { type DuplexChannel, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import type { ReturnedRow } from "../src/hand-back.ts";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";

// The queue on the client (docs/feat/queued-broadcast.md): every client sees
// it; a writer gets ITS rows back once, with its own text, then reclaims them.

/** "go" calls a tool (the gated shell); every other round answers "ok". */
const model: ModelProvider = {
  id: "m",
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (request.messages.at(-1)?.content === "go") {
      yield {
        type: "tool_call",
        toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
      };
    } else {
      yield { type: "text", delta: "ok" };
    }
    yield { type: "done" };
  },
};

/** An env whose exec holds until `release()`. */
function gatedEnv() {
  let release = (): void => {};
  let running = 0;
  let gate = new Promise<void>((r) => {
    release = r;
  });
  const env: ExecutionEnvironment = {
    id: "gated",
    async exec() {
      running++;
      await gate;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
  };
  return {
    env,
    release: () => {
      release();
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
    running: () => running,
  };
}

function daemon(env: ExecutionEnvironment, ringBytes?: number) {
  return new SessionHost({
    defaultCwd: "/tmp/queued-client",
    ...(ringBytes !== undefined ? { ringBytes } : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
}

/**
 * A client of `host` that can drop its link (`drop()`) and redial — held
 * offline while `offline.on` — and whose daemon→client frames pass `filter`
 * (null drops one).
 */
function connect(host: SessionHost, filter?: (frame: Record<string, unknown>) => unknown) {
  const offline = { on: false };
  let last: DuplexChannel | null = null;
  const dial = (): DuplexChannel => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    if (filter) {
      const send = d.send.bind(d);
      d.send = (data: string) => {
        const out = filter(JSON.parse(data) as Record<string, unknown>);
        if (out !== null) send(JSON.stringify(out));
      };
    }
    last = c;
    return c;
  };
  const client = new RemoteClient(dial(), new PermissionBroker(), undefined, {
    channelFactory: async () => {
      while (offline.on) await new Promise((r) => setTimeout(r, 5));
      return dial();
    },
    random: () => 0,
  });
  return { client, offline, drop: () => (last as DuplexChannel | null)?.close() };
}

async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${String(pred)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function drain(iter: AsyncIterable<SessionEvent>): Promise<unknown> {
  return (async () => {
    for await (const _ of iter) {
    }
    return "ended";
  })().catch((e: unknown) => e);
}

/** The writer A with a running (gated) turn, its id, and B attached to the same session. */
async function twoClients(ringBytes?: number) {
  const gated = gatedEnv();
  const host = daemon(gated.env, ringBytes);
  const a = connect(host);
  await a.client.initialize();
  const session = a.client.newSession();
  const turnDone = drain(session.send("go"));
  await until(() => gated.running() === 1);
  const sid = [...(host as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0] ?? "";
  const b = connect(host);
  await b.client.initialize();
  await b.client.openSession(undefined, undefined, sid);
  const returned: (readonly ReturnedRow[])[] = [];
  session.onReturned((rows) => returned.push(rows));
  return { gated, host, a, b, session, sid, turnDone, returned };
}

describe("RemoteSession / RemoteClient: the queue (docs/feat/queued-broadcast.md)", () => {
  test("C1 B sees A's rows; A's session reports the same state", async () => {
    const t = await twoClients();
    await t.session.enqueue("X", "x");
    await until(() => (t.b.client.queuedOf(t.sid)?.entries.length ?? 0) === 1);
    expect(t.b.client.queuedOf(t.sid)).toEqual({ entries: [{ id: "x", text: "X" }], returned: [] });
    expect(t.session.queued).toEqual({ entries: [{ id: "x", text: "X" }], returned: [] });
    t.gated.release();
    await t.turnDone;
    // Drained: the queue empties for everyone.
    await until(() => t.b.client.queuedOf(t.sid)?.entries.length === 0);
    expect(t.returned).toEqual([]);
    t.a.client.close();
    t.b.client.close();
  });

  test("C2 another client's Esc: A gets ITS row back once, then it is reclaimed for everyone", async () => {
    const t = await twoClients();
    await t.session.enqueue("fix x", "x");
    t.b.client.cancel(t.sid);
    t.gated.release();
    await t.turnDone;
    await until(() => t.returned.length === 1);
    expect(t.returned).toEqual([[{ id: "x", text: "fix x", cause: "cancelled" }]]);
    await until(() => t.b.client.queuedOf(t.sid)?.returned.length === 0);
    expect(t.returned).toHaveLength(1);
    t.a.client.close();
    t.b.client.close();
  });

  test("C5 the writer is offline when its turn ends: on reconnect (resync) it gets the row once", async () => {
    // Mutation: the resync does not feed the snapshot's queue → A never gets its row.
    const t = await twoClients(1000);
    await t.session.enqueue("fix x", "x");
    t.a.offline.on = true;
    t.a.drop();
    t.b.client.cancel(t.sid);
    t.gated.release();
    await until(() => (t.b.client.queuedOf(t.sid)?.returned.length ?? 0) === 1);
    // Push the cut and the ring past the returned update while A is away.
    for (let i = 0; i < 3; i++) {
      await t.b.client.prompt(t.sid, `T${i}`, "hello ".repeat(80));
      await until(() => t.host.get(t.sid)?.running === false);
    }
    expect(t.returned).toEqual([]);
    t.a.offline.on = false;
    await until(() => t.returned.length === 1, 4000);
    expect(t.returned).toEqual([[{ id: "x", text: "fix x", cause: "cancelled" }]]);
    await until(() => t.b.client.queuedOf(t.sid)?.returned.length === 0);
    expect(t.returned).toHaveLength(1);
    t.a.client.close();
    t.b.client.close();
  });

  test("C6 a failed reclaim is re-sent at the next state; the row is never given twice", async () => {
    const t = await twoClients();
    const hosted = t.host.get(t.sid);
    if (!hosted) throw new Error("no session");
    const original = hosted.reclaim.bind(hosted);
    let calls = 0;
    hosted.reclaim = (ids) => {
      calls++;
      if (calls === 1) throw new RpcError(JsonRpcErrorCode.InternalError, "disk");
      original(ids);
    };
    await t.session.enqueue("fix x", "x");
    t.b.client.cancel(t.sid);
    t.gated.release();
    await t.turnDone;
    await until(() => calls === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.b.client.queuedOf(t.sid)?.returned).toHaveLength(1);
    // Any later state that still lists it re-sends the reclaim.
    const next = drain(t.session.send("go"));
    await until(() => t.gated.running() === 2);
    await t.session.enqueue("more", "y");
    await until(() => calls === 2);
    await until(() => t.b.client.queuedOf(t.sid)?.returned.length === 0);
    expect(t.returned).toEqual([[{ id: "x", text: "fix x", cause: "cancelled" }]]);
    t.gated.release();
    await next;
    t.a.client.close();
    t.b.client.close();
  });

  test("C7 my refused send-now restored my row (held: []): when its turn returns it, it is only reclaimed", async () => {
    const t = await twoClients();
    const hosted = t.host.get(t.sid);
    if (!hosted) throw new Error("no session");
    const t1 = hosted.snapshotPage().turn?.turnId ?? "";
    expect(t1).not.toBe("");
    await t.session.enqueue("A", "a");
    // B's send-now on my turn, then B's Esc: the reserved turn is cancelled.
    await t.b.client.sendNow(t.sid, "S", { kind: "turn", turnId: t1 }, [{ id: "b", text: "B" }]);
    t.b.client.cancel(t.sid);
    await until(() => (t.b.client.queuedOf(t.sid)?.entries.length ?? 0) === 1);
    // My chord now: refused, my row is not held → my TUI restores it.
    const refused = await t.session.sendNow([{ id: "a", text: "A" }], "turn").catch((e) => e);
    expect(refused instanceof RpcError ? refused.data : refused).toEqual({ held: [] });
    t.gated.release();
    await t.turnDone;
    await until(() => t.b.client.queuedOf(t.sid)?.returned.length === 0);
    expect(t.returned).toEqual([]);
    t.a.client.close();
    t.b.client.close();
  });

  test("C4 a daemon that does not report the queue: queued undefined, onReturned never fires", async () => {
    const gated = gatedEnv();
    const host = daemon(gated.env);
    // An "older daemon": no queued update, no snapshot queue.
    const strip = (frame: Record<string, unknown>): unknown => {
      const params = frame.params as { update?: { type?: string } } | undefined;
      if (frame.method === Notification.SessionUpdate && params?.update?.type === "queued") {
        return null;
      }
      const result = frame.result as Record<string, unknown> | undefined;
      if (result && "queued" in result) {
        const { queued: _q, ...rest } = result;
        return { ...frame, result: rest };
      }
      return frame;
    };
    const a = connect(host, strip);
    await a.client.initialize();
    const session = a.client.newSession();
    const returned: unknown[] = [];
    session.onReturned((rows) => returned.push(rows));
    const esc = new AbortController();
    const done = drain(session.send("go", esc.signal));
    await until(() => gated.running() === 1);
    await session.enqueue("X", "x");
    esc.abort();
    gated.release();
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(session.queued).toBeUndefined();
    expect(returned).toEqual([]);
    a.client.close();
  });

  test("C8 a hostile daemon forges returned rows: only my ids, with MY text; nothing is sent", async () => {
    const [d, c] = createChannelPair();
    const requests: { method: string; params: unknown }[] = [];
    let seq = 0;
    let turnId = "";
    const peer: RpcPeer = new RpcPeer(d, {
      onRequest: async (method, params) => {
        requests.push({ method, params });
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open)
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        if (method === Method.Prompt) {
          turnId = (params as { turnId: string }).turnId;
          return { turnId };
        }
        if (method === Method.Enqueue || method === Method.Reclaim) return {};
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const returned: (readonly ReturnedRow[])[] = [];
    session.onReturned((rows) => returned.push(rows));
    void drain(session.send("go"));
    await until(() => turnId !== "");
    await session.enqueue("fix the test", "a");
    peer.notify(Notification.SessionUpdate, {
      sessionId: "s1",
      seq: ++seq,
      update: {
        type: "queued",
        entries: [],
        returned: [
          { id: "zzz", text: "forged", cause: "ended" },
          { id: "a", text: "rm -rf ~", cause: "ended" },
        ],
      },
    });
    await until(() => returned.length === 1);
    expect(returned).toEqual([[{ id: "a", text: "fix the test", cause: "ended" }]]);
    await until(() => requests.some((r) => r.method === Method.Reclaim));
    expect(requests.filter((r) => r.method === Method.Reclaim).map((r) => r.params)).toEqual([
      { sessionId: "s1", ids: ["a"] },
    ]);
    // Nothing was sent on the user's behalf.
    expect(requests.filter((r) => r.method === Method.Prompt)).toHaveLength(1);
    client.close();
  });

  test("C9 my send-now cancelled before it started: what the daemon returns comes back, its own texts do not", async () => {
    // Review F1. `a` is in T1 but my chord does not cite it (my list lost
    // it); `y` is typed after the chord. Mutation: mark every row of mine
    // bound to the cut turn as given back → `a` and `y` are silently lost.
    const t = await twoClients();
    await t.session.enqueue("A-text", "a");
    const p = t.session.sendNow([{ id: "x", text: "X" }], "turn").catch((e: unknown) => e);
    await until(() => (t.b.client.queuedOf(t.sid)?.entries.length ?? 0) === 2);
    await t.session.enqueue("Y-text", "y");
    t.b.client.cancel(t.sid);
    t.gated.release();
    await t.turnDone;
    const events = await p;
    if (events instanceof Error || typeof events !== "object" || events === null) {
      throw new Error(`sendNow: ${String(events)}`);
    }
    const end = await drain(events as AsyncIterable<SessionEvent>);
    expect(end instanceof RpcError ? end.code : end).toBe(DomainErrorCode.Cancelled);
    await until(() => t.returned.length === 1);
    expect(t.returned).toEqual([
      [
        { id: "a", text: "A-text", cause: "cancelled" },
        { id: "y", text: "Y-text", cause: "cancelled" },
      ],
    ]);
    await until(() => t.b.client.queuedOf(t.sid)?.returned.length === 0);
    expect(t.returned).toHaveLength(1);
    t.a.client.close();
    t.b.client.close();
  });
});
