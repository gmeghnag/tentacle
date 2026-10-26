import { describe, expect, test } from "bun:test";
import { Agent, type LoadResult } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequestOptions,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import {
  Connection,
  type DaemonSessionRecord,
  type RecordStore,
  SessionHost,
  SessionPersister,
} from "@tentacle/daemon";
import { JsonRpcErrorCode, Method, Notification, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import {
  DomainErrorCode,
  type DuplexChannel,
  RpcError,
  RpcPeer,
  createChannelPair,
} from "@tentacle/transport";
import { z } from "zod";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import type { RemoteSession, SessionActivity } from "../src/remote-session.ts";
import type { StreamOutput } from "../src/session-reducer.ts";
import { approver, tick, until } from "./support/fakes.ts";

// docs/feat/tui-foreign-turns.md step B: the client is a view of the SESSION.
// A turn another device started reaches this client as a `turn` activity; an
// update goes to the turn the reducer stamped it with, never to "the active
// own turn". Each test names the plan's T-B* case and, where one applies, the
// mutation that must turn it red.

const CWD = "/tmp/foreign-turns";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = {} as ExecutionEnvironment;

/**
 * A model driven by the turn's prompt (the last user message): `slow` streams
 * 20 chunks, `gate` waits for `open()`, `boom` throws, `ask` calls a tool that
 * needs approval, `longtool` streams 30 chunks + a tool round then waits at
 * the gate (the cut moves mid-turn). Every wait gives up on the turn's abort.
 */
class PromptModel implements ModelProvider {
  readonly id = "prompted";
  waiting = 0;
  private gates: (() => void)[] = [];
  open(): void {
    for (const r of this.gates.splice(0)) r();
  }
  private gate(signal?: AbortSignal): Promise<void> {
    this.waiting++;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.waiting--;
        resolve();
      };
      this.gates.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const signal = request.signal;
    const last = request.messages.at(-1);
    const prompt = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const afterTool = last?.role === "tool";
    if (prompt === "slow") {
      for (let i = 0; i < 20; i++) {
        await sleep(3);
        if (signal?.aborted) break;
        yield { type: "text", delta: `s${i} ` };
      }
    } else if (prompt === "gate" || (prompt === "longtool" && afterTool)) {
      await this.gate(signal);
      if (!signal?.aborted) yield { type: "text", delta: "opened" };
    } else if (prompt === "boom") {
      throw new Error("model exploded");
    } else if ((prompt === "ask" || prompt === "longtool") && !afterTool) {
      if (prompt === "longtool") {
        for (let i = 0; i < 30; i++) {
          await sleep(1);
          yield { type: "text", delta: `l${i} ` };
        }
      }
      const name = prompt === "ask" ? "ask" : "noop";
      yield { type: "tool_call", toolCall: { id: `c-${name}`, name, arguments: "{}" } };
    } else {
      yield { type: "text", delta: `ok:${prompt}` };
    }
    yield { type: "done" };
  }
}

const tool = (name: string, permission: Tool["permission"]): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}).passthrough(),
  permission,
  execute: async () => ({ content: `${name} ok` }),
});

class MemStore implements RecordStore {
  readonly durable = new Map<string, DaemonSessionRecord>();
  async save(record: Parameters<RecordStore["save"]>[0]): Promise<void> {
    this.durable.set(record.id, JSON.parse(JSON.stringify(record)) as DaemonSessionRecord);
  }
  async remove(id: string): Promise<void> {
    this.durable.delete(id);
  }
  async drain(): Promise<void> {}
  async load(id: string): Promise<LoadResult> {
    const record = this.durable.get(id);
    return record ? { status: "ok", record } : { status: "absent" };
  }
}

interface Frame {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/** One in-process daemon; `dial` connects a client to it (several clients: several devices). */
function daemon(opts: { readonly ringBytes?: number; readonly persist?: boolean } = {}) {
  const model = new PromptModel();
  const host = new SessionHost({
    defaultCwd: CWD,
    ...(opts.ringBytes !== undefined ? { ringBytes: opts.ringBytes } : {}),
    ...(opts.persist
      ? {
          persister: new SessionPersister({
            store: new MemStore(),
            cwd: CWD,
            model: "m",
            onError: () => {},
          }),
        }
      : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(tool("ask", "ask")).register(tool("noop", "none")),
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
  /**
   * A client. `frames`: every frame it sends (a spy). `drop()` closes its
   * current link; with `reconnect` it dials again (`hold()` / `release()`
   * delay the next dial, so the daemon runs on while it is away).
   */
  const dial = (
    broker: PermissionBroker = new PermissionBroker(),
    o: {
      readonly reconnect?: boolean;
      readonly onSend?: (f: Frame, link: DuplexChannel) => void;
      /** Rewrites each inbound frame before the client reads it. */
      readonly rewrite?: (data: string) => string;
    } = {},
  ) => {
    const frames: Frame[] = [];
    let link: DuplexChannel | null = null;
    let held: Promise<void> | null = null;
    let release = (): void => {};
    const connect = (): DuplexChannel => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      const wrapped: DuplexChannel = {
        send: (data) => {
          const frame = JSON.parse(data) as Frame;
          frames.push(frame);
          c.send(data);
          o.onSend?.(frame, wrapped);
        },
        close: () => c.close(),
        setOnMessage: (h) => {
          const rewrite = o.rewrite;
          c.setOnMessage(rewrite ? (data) => h(rewrite(data)) : h);
        },
        setOnClose: (h) => c.setOnClose(h),
      };
      link = wrapped;
      return wrapped;
    };
    const client = new RemoteClient(connect(), broker, undefined, {
      ...(o.reconnect
        ? {
            channelFactory: async () => {
              if (held) await held;
              return connect();
            },
            random: () => 0,
          }
        : {}),
    });
    return {
      client,
      frames,
      drop: () => link?.close(),
      hold: () => {
        held = new Promise<void>((r) => {
          release = r;
        });
      },
      release: () => {
        held = null;
        release();
      },
    };
  };
  return { host, model, dial };
}

/** Drain `events`; resolves "ended", the error it threw, or "hung". */
function drain(
  events: AsyncIterable<SessionEvent>,
  into: SessionEvent[],
  ms = 3000,
): Promise<unknown> {
  return Promise.race([
    (async () => {
      for await (const e of events) into.push(e);
      return "ended";
    })().catch((e: unknown) => e),
    new Promise((r) => setTimeout(() => r("hung"), ms)),
  ]);
}

const texts = (events: readonly SessionEvent[]): string =>
  events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");

/** Every activity a session raises (`watch` is optional so the RED run reads "none"). */
function watched(session: RemoteSession) {
  const activities: SessionActivity[] = [];
  (session as Partial<Pick<RemoteSession, "watch">>).watch?.((a) => activities.push(a));
  const turns = () => activities.filter((a) => a.kind === "turn");
  return { activities, turns };
}

/** Two devices on one session; B attached by a warm turn of its own. */
async function twoDevices(o: { readonly ringBytes?: number; readonly bReconnect?: boolean } = {}) {
  const d = daemon(o);
  const a = d.dial();
  const b = d.dial(new PermissionBroker(), { reconnect: o.bReconnect === true });
  await a.client.initialize();
  await b.client.initialize();
  const sid = crypto.randomUUID();
  const sa = a.client.newSession(undefined, sid);
  const sb = b.client.newSession(undefined, sid);
  expect(await drain(sa.send("warm"), [])).toBe("ended");
  expect(await drain(sb.send("b-warm"), [])).toBe("ended");
  // B's first open attached to a live session: its history is an activity
  // (buffered until a watch). Taken here, so each test sees only its own.
  const initial: SessionActivity[] = [];
  sb.watch((x) => initial.push(x));
  expect(initial.map((x) => x.kind)).toEqual(["history"]);
  // A saw B's warm turn as a foreign one: taken too (T-B1 asserts the property).
  sa.watch(() => {});
  return { ...d, a, b, sid, sa, sb };
}

const turnIdOf = (frames: readonly Frame[], method: string): string | undefined =>
  frames.findLast((f) => f.method === method)?.params?.turnId as string | undefined;

describe("foreign turns over the real daemon", () => {
  test("T-B1 RED: A's turn reaches B as a turn activity: its prompt, its output, its end", async () => {
    const r = await twoDevices();
    const w = watched(r.sb);
    expect(await drain(r.sa.send("hi"), [])).toBe("ended");
    await until(() => w.turns().length === 1);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    expect(activity.turnId).toBe(turnIdOf(r.a.frames, Method.Prompt) ?? "");
    const events: SessionEvent[] = [];
    expect(await drain(activity.events, events)).toBe("ended");
    expect(events).toEqual([
      { type: "user_message", text: "hi" },
      { type: "text", delta: "ok:hi" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(r.sb.ownsTurn(activity.turnId)).toBe(false);
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B1b: A's turn errors → B's stream rejects with the same RpcError class as an own failure", async () => {
    const r = await twoDevices();
    const w = watched(r.sb);
    const own = await drain(r.sa.send("boom"), []);
    expect(own).toBeInstanceOf(RpcError);
    await until(() => w.turns().length === 1);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const foreign = await drain(activity.events, []);
    expect(foreign).toBeInstanceOf(RpcError);
    expect((foreign as RpcError).code).toBe((own as RpcError).code);
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B3: attaching mid-turn (eager open, the cut names the turn) → a foreign turn whose stream starts with the history, no prompt bubble, then live", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    // Round 1 (a tool) commits: the cut moves into the turn, so the snapshot names it.
    const running = drain(sa.send("longtool"), []);
    await until(() => d.model.waiting === 1);
    const b = d.dial();
    await b.client.initialize();
    const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
    await sb.open();
    const w = watched(sb); // after open: the buffered activities are handed over
    expect(w.activities.map((x) => x.kind)).toEqual(["turn"]);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    d.model.open();
    const events: SessionEvent[] = [];
    expect(await drain(activity.events, events)).toBe("ended");
    expect(events[0]).toMatchObject({ type: "history_reset" });
    expect(events.some((e) => e.type === "user_message")).toBe(false);
    expect(texts(events)).toBe("opened");
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(await running).toBe("ended");
    a.client.close();
    b.client.close();
  });

  test("T-B3b: attaching before the turn's first commit (the cut predates its start) → the idle history, then the turn WITH its prompt (not in the snapshot: never lost, never twice)", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    expect(await drain(sa.send("first"), [])).toBe("ended");
    const running = drain(sa.send("gate"), []);
    await until(() => d.model.waiting === 1);
    const b = d.dial();
    await b.client.initialize();
    const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
    await sb.open();
    const w = watched(sb);
    expect(w.activities.map((x) => x.kind)).toEqual(["history", "turn"]);
    const [history, activity] = w.activities;
    expect(history?.kind === "history" && history.messages.map((m) => m.content)).toEqual([
      "first",
      "ok:first",
    ]);
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    d.model.open();
    const events: SessionEvent[] = [];
    expect(await drain(activity.events, events)).toBe("ended");
    expect(events).toEqual([
      { type: "user_message", text: "gate" },
      { type: "text", delta: "opened" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(await running).toBe("ended");
    a.client.close();
    b.client.close();
  });

  test("T-B4 + T-B6: a drop mid-foreign-turn (since covered) → each chunk once, one end; the foreign id is never sent as a prompt", async () => {
    // Mutation (T-B6): add `this.foreign` to `recovered`'s list → a
    // `session/prompt` carrying A's turn id leaves B (it was never acked).
    const r = await twoDevices({ bReconnect: true });
    const w = watched(r.sb);
    const running = drain(r.sa.send("slow"), []);
    await until(() => w.turns().length === 1);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const events: SessionEvent[] = [];
    const draining = drain(activity.events, events);
    await until(() => texts(events).length > 6);
    const before = r.b.frames.length;
    r.b.drop();
    expect(await draining).toBe("ended");
    expect(await running).toBe("ended");
    expect(texts(events)).toBe(Array.from({ length: 20 }, (_, i) => `s${i} `).join(""));
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    const after = r.b.frames.slice(before);
    expect(after.some((f) => f.method === Method.Open)).toBe(true); // it did re-attach
    for (const f of after) {
      if (f.method === Method.Prompt || f.method === Method.SendNow) {
        expect(f.params?.turnId).not.toBe(activity.turnId);
      }
    }
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B5: resync with the foreign turn still running → the reset is in its stream, then the rest", async () => {
    const r = await twoDevices({ ringBytes: 1000, bReconnect: true });
    const w = watched(r.sb);
    const running = drain(r.sa.send("longtool"), []);
    await until(() => w.turns().length === 1);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const events: SessionEvent[] = [];
    const draining = drain(activity.events, events);
    r.b.hold();
    r.b.drop();
    await until(() => r.model.waiting === 1); // round 1 committed: the cut moved, the ring overflowed
    r.b.release();
    await until(() => events.some((e) => e.type === "history_reset"));
    r.model.open();
    expect(await draining).toBe("ended");
    expect(await running).toBe("ended");
    expect(events.filter((e) => e.type === "history_reset")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(texts(events.slice(events.findIndex((e) => e.type === "history_reset")))).toBe("opened");
    expect(w.turns()).toHaveLength(1);
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B5b + T-B14b: the foreign turn ended behind the cut → its stream closes with no turn_end (never guessed), once; then an idle history (compacted: false)", async () => {
    const r = await twoDevices({ ringBytes: 1000, bReconnect: true });
    const w = watched(r.sb);
    const running = drain(r.sa.send("slow"), []);
    await until(() => w.turns().length === 1);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const events: SessionEvent[] = [];
    const draining = drain(activity.events, events);
    await until(() => texts(events).length > 0);
    r.b.hold();
    r.b.drop();
    expect(await running).toBe("ended"); // ends while B is away
    expect(await drain(r.sa.send("slow"), [])).toBe("ended"); // overflow the ring past the cut
    r.b.release();
    expect(await draining).toBe("ended");
    expect(events.some((e) => e.type === "turn_end")).toBe(false);
    await until(() => w.activities.some((a) => a.kind === "history"));
    expect(w.activities.map((a) => a.kind)).toEqual(["turn", "history"]);
    expect(w.activities[1]).toMatchObject({ kind: "history", compacted: false });
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B7: another device's send-now that never started (turn_end, no turn_start) → no activity", async () => {
    const r = await twoDevices();
    const c = r.dial();
    await c.client.initialize();
    await c.client.openSession(undefined, undefined, r.sid);
    const w = watched(r.sb);
    const running = drain(r.sa.send("gate"), []);
    await until(() => r.model.waiting === 1 && w.turns().length === 1);
    const aTurn = turnIdOf(r.a.frames, Method.Prompt) ?? "";
    const sent = c.client.sendNow(r.sid, "never", { kind: "turn", turnId: aTurn }, [
      { id: "m1", text: "never" },
    ]);
    c.client.cancel(r.sid, "never");
    await sent.catch(() => {});
    expect(await running).toBe("ended");
    await sleep(20);
    expect(w.activities.map((a) => (a.kind === "turn" ? a.turnId : a.kind))).toEqual([aTurn]);
    r.a.client.close();
    r.b.client.close();
    c.client.close();
  });

  test("T-B8: B's send-now during A's turn interrupts A's turn by id; B's successor is own, promoted at A's end", async () => {
    const r = await twoDevices();
    const w = watched(r.sb);
    const running = drain(r.sa.send("gate"), []);
    await until(() => r.model.waiting === 1 && w.turns().length === 1);
    const aTurn = turnIdOf(r.a.frames, Method.Prompt) ?? "";
    const events = await r.sb.sendNow([{ id: "b1", text: "b-now" }], "turn");
    const frame = r.b.frames.findLast((f) => f.method === Method.SendNow);
    expect(frame?.params?.interrupt).toEqual({ kind: "turn", turnId: aTurn });
    const successor = frame?.params?.turnId as string;
    expect(r.sb.ownsTurn(successor)).toBe(true);
    const own: SessionEvent[] = [];
    expect(await drain(events, own)).toBe("ended");
    expect(own).toEqual([
      { type: "user_message", text: "b-now" },
      { type: "text", delta: "ok:b-now" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const foreign: SessionEvent[] = [];
    expect(await drain(activity.events, foreign)).toBe("ended");
    expect(foreign.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(await running).toBe("ended");
    expect(w.turns()).toHaveLength(1); // the successor is never a foreign activity
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B9: A's send-now on B's own turn → B's stream ends cancelled, then a foreign activity with the daemon's prompt", async () => {
    const r = await twoDevices();
    const wa = watched(r.sa);
    const w = watched(r.sb);
    const mine: SessionEvent[] = [];
    const running = drain(r.sb.send("gate"), mine);
    await until(() => r.model.waiting === 1 && wa.turns().length === 1);
    const events = await r.sa.sendNow([{ id: "a1", text: "a-now" }], "turn");
    expect(await drain(events, [])).toBe("ended");
    expect(await running).toBe("ended");
    expect(mine.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    await until(() => w.turns().length === 1);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const foreign: SessionEvent[] = [];
    expect(await drain(activity.events, foreign)).toBe("ended");
    expect(foreign[0]).toEqual({ type: "user_message", text: "a-now" });
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B10: the link gone for good fails a foreign stream (no hang)", async () => {
    const r = await twoDevices();
    const w = watched(r.sb);
    const running = drain(r.sa.send("gate"), []);
    await until(() => w.turns().length === 1);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const events = drain(activity.events, []);
    r.b.client.close();
    expect(await events).toBeInstanceOf(Error);
    r.model.open();
    expect(await running).toBe("ended");
    r.a.client.close();
  });

  test("T-B11: session_closed — idle → closed{closed}; mid-foreign-turn → the stream ends, then closed; a later send is refused clearly", async () => {
    const r = await twoDevices();
    const w = watched(r.sb);
    const running = drain(r.sa.send("gate"), []);
    await until(() => r.model.waiting === 1 && w.turns().length === 1);
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const events: SessionEvent[] = [];
    const draining = drain(activity.events, events);
    await r.a.client.closeSession(r.sid);
    // The close streams `turn_end{cancelled}` first: the stream ends with it.
    expect(await draining).toBe("ended");
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    await until(() => w.activities.length === 2);
    expect(w.activities[1]).toEqual({ kind: "closed", reason: "closed" });
    await running;
    const refused = await drain(r.sb.send("again"), []);
    expect(refused).toMatchObject({ code: DomainErrorCode.UnknownSession });
    expect(String((refused as Error).message)).toContain("closed on another device");
    // Idle, and deleted: the reason says so.
    const s2 = crypto.randomUUID();
    const a2 = r.a.client.newSession(undefined, s2);
    expect(await drain(a2.send("x"), [])).toBe("ended");
    const b2 = r.b.client.newSession(undefined, s2, undefined, { attach: {} });
    await b2.open();
    const w2 = watched(b2);
    await r.a.client.deleteSession(s2);
    await until(() => w2.activities.some((a) => a.kind === "closed"));
    expect(w2.activities.at(-1)).toEqual({ kind: "closed", reason: "deleted" });
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B11b: my own close (/clear) raises no 'closed on another device'", async () => {
    const r = await twoDevices();
    const w = watched(r.sb);
    r.sb.close();
    await sleep(30);
    expect(w.activities.filter((a) => a.kind === "closed")).toEqual([]);
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B14: an idle compaction → history{compacted: true}", async () => {
    const r = await twoDevices();
    const w = watched(r.sb);
    await r.sa.compact();
    await until(() => w.activities.some((a) => a.kind === "history"));
    expect(w.activities.map((a) => a.kind)).toEqual(["history"]);
    expect(w.activities[0]).toMatchObject({ kind: "history", compacted: true });
    r.a.client.close();
    r.b.client.close();
  });

  test("T-B15: a foreign turn's permission reaches B's ONE broker with its turnId; an own one with B's", async () => {
    const d = daemon();
    const held = approver(); // A never answers: B's answer decides
    const seen: (string | undefined)[] = [];
    const spy = new PermissionBroker(async (_req, options?: PermissionRequestOptions) => {
      seen.push(options?.turnId);
      return { allowed: true, scope: "once" };
    });
    const a = d.dial(held.broker);
    const b = d.dial(spy);
    await a.client.initialize();
    await b.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    const sb = b.client.newSession(undefined, sid);
    expect(await drain(sa.send("warm"), [])).toBe("ended");
    expect(await drain(sb.send("b-warm"), [])).toBe("ended");
    expect(await drain(sa.send("ask"), [])).toBe("ended");
    const aTurn = turnIdOf(a.frames, Method.Prompt);
    expect(seen).toEqual([aTurn]);
    expect(sb.ownsTurn(aTurn ?? "")).toBe(false);
    expect(await drain(sb.send("ask"), [])).toBe("ended");
    const bTurn = turnIdOf(b.frames, Method.Prompt);
    expect(seen).toEqual([aTurn, bTurn]);
    expect(sb.ownsTurn(bTurn ?? "")).toBe(true);
    a.client.close();
    b.client.close();
  });

  test("T-B16: an enqueue during a foreign turn is bound to it; the steer (my id) shows in A's stream too", async () => {
    const r = await twoDevices();
    const w = watched(r.sb);
    const aEvents: SessionEvent[] = [];
    const running = drain(r.sa.send("gate"), aEvents);
    await until(() => r.model.waiting === 1 && w.turns().length === 1);
    const aTurn = turnIdOf(r.a.frames, Method.Prompt);
    await r.sb.enqueue("more", "k1");
    expect(r.b.frames.findLast((f) => f.method === Method.Enqueue)?.params).toMatchObject({
      id: "k1",
      turnId: aTurn,
      text: "more",
    });
    r.model.open();
    expect(await running).toBe("ended");
    expect(aEvents).toContainEqual({ type: "steer", text: "more", id: "k1" });
    r.a.client.close();
    r.b.client.close();
  });
});

describe("routing by the reducer's turn stamp (scripted frames)", () => {
  test("T-B2 RED: an own prompt that loses the slot never shows the other turn's chunks; they go to that turn's activity", async () => {
    // Mutation: route turn-scoped updates to `this.active` again → red.
    const [daemonCh, clientCh] = createChannelPair();
    let seq = 0;
    const notify = (update: unknown): void =>
      daemon.notify(Notification.SessionUpdate, {
        sessionId: "s1",
        seq: ++seq,
        mandatory: true,
        update,
      });
    const daemon: RpcPeer = new RpcPeer(daemonCh, {
      onRequest: async (method) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        if (method === Method.Prompt) {
          // Another device's turn took the slot first; its frames precede the refusal.
          notify({ type: "turn_start", turnId: "Y", prompt: "theirs" });
          notify({ type: "agent_message_chunk", content: { type: "text", text: "Y-chunk" } });
          await tick();
          throw new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession(undefined, "s1");
    const w = watched(session);
    const own: SessionEvent[] = [];
    const outcome = await drain(session.send("mine"), own);
    expect(texts(own)).toBe("");
    expect(outcome).toMatchObject({ code: DomainErrorCode.TurnInProgress });
    const [activity] = w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    expect(activity.turnId).toBe("Y");
    notify({ type: "turn_end", turnId: "Y", stopReason: "end_turn" });
    const foreign: SessionEvent[] = [];
    expect(await drain(activity.events, foreign)).toBe("ended");
    expect(foreign).toEqual([
      { type: "user_message", text: "theirs" },
      { type: "text", delta: "Y-chunk" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    client.close();
  });
});

describe("the bracket property, pinned (T-B0)", () => {
  const scoped = new Set([
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "agent_usage",
    "steer",
    "context_note",
    "permission_request",
    "permission_resolved",
  ]);

  test("every turn-scoped output carries its bracket's turn; session-level ones occur on both sides", async () => {
    const r = await twoDevices();
    const obs = r.dial();
    await obs.client.initialize();
    const outs: StreamOutput[] = [];
    await obs.client.openSession(undefined, undefined, r.sid, {
      output: (out) => outs.push(out),
      recovered() {},
      linkClosed() {},
    });
    const b = r.b.client;
    const running = () => turnIdOf(r.a.frames, Method.Prompt) ?? "";
    // 1) A runs; B steers, renames mid-turn, cancels; the steer is returned,
    //    B reclaims it idle and renames idle.
    const t1 = drain(r.sa.send("gate"), []);
    await until(() => r.model.waiting === 1);
    await b.enqueue(r.sid, "st1", running(), "b-steer");
    await b.rename(r.sid, "mid-turn title");
    b.cancel(r.sid);
    await t1;
    await sleep(5);
    await b.reclaim(r.sid, ["st1"]).catch(() => {});
    await b.rename(r.sid, "idle title");
    // 2) a hand-off: B send_now's A's turn.
    const t2 = drain(r.sa.send("gate"), []);
    await until(() => r.model.waiting === 1);
    await b.sendNow(r.sid, crypto.randomUUID(), { kind: "turn", turnId: running() }, [
      { id: "n1", text: "b-now" },
    ]);
    await t2;
    await sleep(50);
    // 3) a send-now cancelled at once: its turn_end has no turn_start.
    const t3 = drain(r.sa.send("gate"), []);
    await until(() => r.model.waiting === 1);
    const p = b.sendNow(r.sid, "unstarted", { kind: "turn", turnId: running() }, [
      { id: "n2", text: "never" },
    ]);
    b.cancel(r.sid);
    await p.catch(() => {});
    await t3;
    await sleep(20);
    // 4) an idle compaction.
    await b.compact(r.sid);
    await sleep(50);

    let open: string | null = null;
    let violations = 0;
    let unstarted = 0;
    let turns = 0;
    const where: Record<string, { inside: number; outside: number }> = {};
    for (const out of outs) {
      if (out.kind === "reset") {
        open = out.turn;
        continue;
      }
      if (out.kind !== "update") continue;
      const u = out.update;
      if (u.type === "turn_start") {
        if (open !== null || out.turn !== u.turnId) violations++;
        open = u.turnId;
        turns++;
      } else if (u.type === "turn_end") {
        if (open === u.turnId) {
          if (out.turn !== u.turnId) violations++;
          open = null;
        } else {
          unstarted++;
          if (out.turn !== null) violations++;
        }
      } else if (scoped.has(u.type)) {
        if (open === null || out.turn !== open) violations++;
      } else {
        where[u.type] ??= { inside: 0, outside: 0 };
        const side = where[u.type] as { inside: number; outside: number };
        side[open === null ? "outside" : "inside"]++;
      }
    }
    expect(violations).toBe(0);
    expect(turns).toBeGreaterThanOrEqual(4); // a1, the successor, a2, a3
    expect(unstarted).toBe(1);
    // Non-vacuous: turn-scoped updates were checked, and resets (the attach, the compaction).
    const scopedSeen = outs.filter((o) => o.kind === "update" && scoped.has(o.update.type));
    expect(scopedSeen.length).toBeGreaterThan(0);
    expect(outs.filter((o) => o.kind === "reset").length).toBe(2);
    // Why they are never routed by the bracket: they occur on both sides.
    expect(where.queued?.inside).toBeGreaterThan(0);
    expect(where.queued?.outside).toBeGreaterThan(0);
    expect(where.session_title?.inside).toBeGreaterThan(0);
    expect(where.session_title?.outside).toBeGreaterThan(0);
    expect(where.history_replaced).toEqual({ inside: 0, outside: 1 });
    r.a.client.close();
    r.b.client.close();
    obs.client.close();
  });
});

describe("eager open (attach only, never create) — T-B13", () => {
  const seed = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));

  test("(a) a 450-message session (3 pages) → ONE history activity with all 450, delivered on a later watch; a fresh session's open sends nothing", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const sid = crypto.randomUUID();
    await a.client.openSession(undefined, seed(450), sid);
    const b = d.dial();
    await b.client.initialize();
    const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
    await sb.open();
    const w = watched(sb);
    expect(w.activities.map((x) => x.kind)).toEqual(["history"]);
    expect(w.activities[0]).toMatchObject({ kind: "history", compacted: false });
    const [history] = w.activities;
    expect(history?.kind === "history" && history.messages.length).toBe(450);
    expect(b.frames.filter((f) => f.method === Method.Snapshot)).toHaveLength(3);
    const open = b.frames.find((f) => f.method === Method.Open);
    expect(open?.params).toEqual({ sessionId: sid });
    const fresh = b.client.newSession();
    const opens = b.frames.filter((f) => f.method === Method.Open).length;
    await fresh.open();
    expect(b.frames.filter((f) => f.method === Method.Open)).toHaveLength(opens);
    a.client.close();
    b.client.close();
  });

  test("(b) an archived and an unknown id → open() rejects, and no open frame carries create or messages", async () => {
    // Mutation: let `openOn` recreate a never-live attach entry → the unknown
    // id resolves (an empty session is created under it) → red.
    const d = daemon({ persist: true });
    const a = d.dial();
    await a.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    expect(await drain(sa.send("x"), [])).toBe("ended");
    await a.client.closeSession(sid);
    const b = d.dial();
    await b.client.initialize();
    const archived = b.client.newSession(undefined, sid, undefined, { attach: {} });
    await expect(archived.open()).rejects.toMatchObject({ code: DomainErrorCode.SessionArchived });
    const unknown = b.client.newSession(undefined, crypto.randomUUID(), undefined, { attach: {} });
    await expect(unknown.open()).rejects.toMatchObject({ code: DomainErrorCode.UnknownSession });
    const opens = b.frames.filter((f) => f.method === Method.Open);
    expect(opens.length).toBeGreaterThanOrEqual(2);
    for (const f of opens) {
      expect(f.params?.create).toBeUndefined();
      expect(f.params?.messages).toBeUndefined();
    }
    // With `reopen`, the archived one attaches (its history arrives).
    const reopened = b.client.newSession(undefined, sid, undefined, { attach: { reopen: true } });
    await reopened.open();
    const w = watched(reopened);
    expect(w.activities.map((x) => x.kind)).toEqual(["history"]);
    a.client.close();
    b.client.close();
  });

  test("(c) a deleted id → open() rejects SessionDeleted and onSessionDeleted fires", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    expect(await drain(sa.send("x"), [])).toBe("ended");
    await a.client.deleteSession(sid);
    const b = d.dial();
    await b.client.initialize();
    const deleted: string[] = [];
    b.client.onSessionDeleted((n) => deleted.push(n.sessionId));
    const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
    await expect(sb.open()).rejects.toMatchObject({ code: DomainErrorCode.SessionDeleted });
    expect(deleted).toEqual([sid]);
    expect(d.host.get(sid)).toBeUndefined();
    a.client.close();
    b.client.close();
  });

  test("(d) the link cut before the attach's response → the re-sent open has no create", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    expect(await drain(sa.send("x"), [])).toBe("ended");
    let cut = false;
    const b = d.dial(new PermissionBroker(), {
      reconnect: true,
      onSend: (f, link) => {
        if (f.method === Method.Open && !cut) {
          cut = true;
          link.close(); // the open left; its response is lost
        }
      },
    });
    await b.client.initialize();
    const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
    await sb.open();
    const opens = b.frames.filter((f) => f.method === Method.Open);
    expect(opens.length).toBe(2);
    for (const f of opens) expect(f.params).toEqual({ sessionId: sid });
    expect(watched(sb).activities.map((x) => x.kind)).toEqual(["history"]);
    a.client.close();
    b.client.close();
  });
});

// docs/feat/connect-sessions.md — F1 (task 6 Review carry-over) and `session/detach`.

/** An inbound rewrite: once armed, the next `agent_message_chunk` arrives malformed (known type, no text). */
function corrupter() {
  let armed = false;
  return {
    arm: (): void => {
      armed = true;
    },
    rewrite: (data: string): string => {
      const f = JSON.parse(data) as { method?: string; params?: { update?: { type?: string } } };
      if (
        !armed ||
        f.method !== Notification.SessionUpdate ||
        f.params?.update?.type !== "agent_message_chunk"
      ) {
        return data;
      }
      armed = false;
      return JSON.stringify({
        ...f,
        params: { ...f.params, update: { type: "agent_message_chunk" } },
      });
    },
  };
}

const cancels = (frames: readonly Frame[]) =>
  frames.filter((f) => f.method === Notification.Cancel).map((f) => f.params);

/** A phone (A) made the session; the TUI (B, inbound frames rewritten by `rewrite`) attached it eagerly. */
async function phoneAndTui(o: { readonly rewrite?: (data: string) => string } = {}) {
  const d = daemon();
  const a = d.dial();
  const b = d.dial(new PermissionBroker(), o.rewrite ? { rewrite: o.rewrite } : {});
  await a.client.initialize();
  await b.client.initialize();
  const sid = crypto.randomUUID();
  const sa = a.client.newSession(undefined, sid);
  expect(await drain(sa.send("warm"), [])).toBe("ended");
  const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
  const w = watched(sb);
  await sb.open();
  return { ...d, a, b, sid, sa, sb, w };
}

describe("F1 — an unreadable frame cancels only my own turn", () => {
  test("RED: during ANOTHER device's turn it fails the stream here only — no cancel; the phone's turn ends end_turn", async () => {
    // Mutation: restore the blind `cancel(this.id)` → one cancel frame, the phone's turn cancelled.
    const bad = corrupter();
    const r = await phoneAndTui({ rewrite: bad.rewrite });
    const phone: SessionEvent[] = [];
    const running = drain(r.sa.send("gate"), phone);
    await until(() => r.model.waiting === 1 && r.w.turns().length === 1);
    const [activity] = r.w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const here = drain(activity.events, []);
    bad.arm();
    r.model.open();
    expect(await here).toBeInstanceOf(Error);
    expect(await running).toBe("ended");
    expect(phone.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(cancels(r.b.frames)).toEqual([]);
    r.a.client.close();
    r.b.client.close();
  });

  test("RED: during my own turn the cancel names it", async () => {
    const bad = corrupter();
    const r = await phoneAndTui({ rewrite: bad.rewrite });
    const mine = drain(r.sb.send("gate"), []);
    await until(() => r.model.waiting === 1);
    bad.arm();
    r.model.open();
    expect(await mine).toBeInstanceOf(Error);
    const own = turnIdOf(r.b.frames, Method.Prompt);
    expect(own).toBeDefined();
    expect(cancels(r.b.frames)).toEqual([{ sessionId: r.sid, turnId: own }]);
    r.a.client.close();
    r.b.client.close();
  });
});

describe("session/detach — the client side", () => {
  test("detachSession withdraws that session's open prompt, not another session's; the asks wait daemon-side", async () => {
    const d = daemon();
    const held = approver(); // A never answers
    const spy = approver(); // B never answers either: it only sees prompts come and go
    const a = d.dial(held.broker);
    const b = d.dial(spy.broker);
    await a.client.initialize();
    await b.client.initialize();
    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    for (const sid of [s1, s2]) {
      const sa = a.client.newSession(undefined, sid);
      expect(await drain(sa.send("warm"), [])).toBe("ended");
      await b.client.newSession(undefined, sid, undefined, { attach: {} }).open();
      void drain(sa.send("ask"), [], 10_000);
    }
    // The broker shows one dialog at a time: S1's is up, S2's queued behind it.
    await until(() => spy.prompts() === 1);
    await sleep(30);
    expect(d.host.get(s2)?.running).toBe(true);
    await b.client.detachSession(s1);
    expect(spy.aborts()).toBe(1); // S1's prompt withdrawn…
    await until(() => spy.prompts() === 2); // …S2's comes up, and stays
    await sleep(20);
    expect(spy.aborts()).toBe(1);
    expect(spy.pending()).toBe(1);
    expect(b.client.liveSessionIds()).toEqual([s2]);
    expect(d.host.get(s1)?.running).toBe(true); // A's ask still waits for an answer
    expect(d.host.get(s1)?.attachedCount).toBe(1);
    a.client.close();
    b.client.close();
  });

  test("an older daemon (MethodNotFound): rejects, the session stays followed, a later closeSessions closes it", async () => {
    let detachId: unknown;
    const d = daemon();
    const b = d.dial(new PermissionBroker(), {
      onSend: (f) => {
        if (f.method === Method.Detach) detachId = (f as { id?: unknown }).id;
      },
      rewrite: (data) => {
        const f = JSON.parse(data) as { id?: unknown; result?: unknown };
        return detachId !== undefined && f.id === detachId && "result" in f
          ? JSON.stringify({
              jsonrpc: "2.0",
              id: f.id,
              error: { code: JsonRpcErrorCode.MethodNotFound, message: "Method not found" },
            })
          : data;
      },
    });
    await b.client.initialize();
    const sid = crypto.randomUUID();
    const sb = b.client.newSession(undefined, sid);
    expect(await drain(sb.send("x"), [])).toBe("ended");
    await expect(b.client.detachSession(sid)).rejects.toMatchObject({
      code: JsonRpcErrorCode.MethodNotFound,
    });
    expect(b.client.liveSessionIds()).toEqual([sid]);
    await b.client.closeSessions();
    expect(b.frames.filter((f) => f.method === Method.Close).map((f) => f.params)).toEqual([
      { sessionId: sid },
    ]);
    b.client.close();
  });

  test("the link drops after the detach frame left: forgotten, and the reconnect never re-opens it", async () => {
    // Mutation: leave `closing` unset → the reconnect's `recover` re-opens S1.
    const d = daemon();
    let cut = false;
    const b = d.dial(new PermissionBroker(), {
      reconnect: true,
      onSend: (f, link) => {
        if (f.method === Method.Detach && !cut) {
          cut = true;
          link.close(); // the detach left; its answer is lost
        }
      },
    });
    await b.client.initialize();
    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    expect(await drain(b.client.newSession(undefined, s1).send("x"), [])).toBe("ended");
    expect(await drain(b.client.newSession(undefined, s2).send("x"), [])).toBe("ended");
    const before = b.frames.length;
    await b.client.detachSession(s1);
    // The reconnect re-opens S2 (still followed), never S1.
    await until(() =>
      b.frames.slice(before).some((f) => f.method === Method.Open && f.params?.sessionId === s2),
    );
    await sleep(20);
    const reopened = b.frames
      .slice(before)
      .filter((f) => f.method === Method.Open)
      .map((f) => f.params?.sessionId);
    expect(reopened).toEqual([s2]);
    expect(b.client.liveSessionIds()).toEqual([s2]);
    b.client.close();
  });

  test("drain awaits a fire-and-forget close issued just before the exit (a slow uplink)", async () => {
    // Mutation: `drain` returns at once → the close never reaches the daemon.
    const d = daemon();
    const [daemonEnd, clientEnd] = createChannelPair();
    new Connection(daemonEnd, d.host);
    // A slow uplink: each frame leaves 10 ms after it is written (a real socket's latency).
    const slow: DuplexChannel = {
      send: (data) => {
        setTimeout(() => clientEnd.send(data), 10);
      },
      close: () => clientEnd.close(),
      setOnMessage: (h) => clientEnd.setOnMessage(h),
      setOnClose: (h) => clientEnd.setOnClose(h),
    };
    const client = new RemoteClient(slow, new PermissionBroker());
    await client.initialize();
    const sid = crypto.randomUUID();
    const sb = client.newSession(undefined, sid);
    expect(await drain(sb.send("x"), [])).toBe("ended");
    sb.close(); // `/clear` / `/close`: fire-and-forget
    await client.drain();
    client.close();
    await sleep(30);
    expect(d.host.get(sid)).toBeUndefined();
    expect(client.liveSessionIds()).toEqual([]);
  });

  test("RemoteSession.detach: a foreign stream ends with no turn_end; a later send is refused locally (no frame)", async () => {
    const r = await phoneAndTui();
    const running = drain(r.sa.send("gate"), []);
    await until(() => r.model.waiting === 1 && r.w.turns().length === 1);
    const [activity] = r.w.turns();
    if (activity?.kind !== "turn") throw new Error("no turn activity");
    const events: SessionEvent[] = [];
    const here = drain(activity.events, events);
    await r.sb.detach();
    expect(await here).toBe("ended");
    expect(events.some((e) => e.type === "turn_end")).toBe(false);
    expect(r.host.get(r.sid)?.running).toBe(true);
    const sent = r.b.frames.length;
    expect(await drain(r.sb.send("again"), [])).toBeInstanceOf(Error);
    expect(r.b.frames.length).toBe(sent);
    expect(r.b.frames.filter((f) => f.method === Method.Detach).length).toBe(1);
    r.model.open();
    expect(await running).toBe("ended");
    r.a.client.close();
    r.b.client.close();
  });
});
