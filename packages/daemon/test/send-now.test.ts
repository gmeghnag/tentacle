import { describe, expect, test } from "bun:test";
import { Agent, HookRunner } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type HookSpec,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import {
  DomainErrorCode,
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type SendNowMessage,
  type SendNowTarget,
  type SessionUpdate,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import type { Attachment, HostedSession } from "../src/hosted-session.ts";
import { type DaemonSessionRecord, parseDaemonRecord } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { type RecordStore, SessionPersister } from "../src/session-persister.ts";

// `session/send_now` (docs/feat/send-now-a.md): cancel what runs and start the
// queued texts as a new turn in ONE daemon step. Each test names the plan's
// T-A* case and, where one applies, the mutation (M*) that must turn it red.

const CWD = "/tmp/send-now";
const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));
const env = {} as ExecutionEnvironment;
const go = [{ type: "text" as const, text: "go" }];

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}

const call = (id: string, name: string): StreamEvent[] => [
  { type: "tool_call", toolCall: { id, name, arguments: "{}" } },
  { type: "done" },
];
const say = (delta: string): StreamEvent[] => [{ type: "text", delta }, { type: "done" }];
/** A model call that waits for `release()` (a slow summary), then answers. */
const PARK = "park";

/** One scripted round per model call (then plain text); `PARK` waits for `release()`. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly calls: ChatRequest[] = [];
  private parked: Array<() => void> = [];
  constructor(private readonly script: readonly (readonly StreamEvent[] | typeof PARK)[]) {}
  get waiting(): number {
    return this.parked.length;
  }
  release(): void {
    for (const r of this.parked.splice(0)) r();
  }
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...request, messages: [...request.messages] });
    const round = this.script[this.calls.length - 1] ?? say("ok");
    if (round === PARK) {
      await new Promise<void>((r) => this.parked.push(r));
      yield* say("SUMMARY");
      return;
    }
    yield* round;
  }
}

/** A tool that blocks until `release()` and IGNORES its abort signal (a slow cancel). */
class Gate {
  entered = 0;
  private waiters: Array<() => void> = [];
  get waiting(): number {
    return this.waiters.length;
  }
  release(): void {
    for (const r of this.waiters.splice(0)) r();
  }
  tool(name: string, permission: Tool["permission"]): Tool {
    return {
      name,
      description: name,
      inputSchema: z.object({}).passthrough(),
      permission,
      execute: async () => {
        this.entered++;
        await new Promise<void>((r) => this.waiters.push(r));
        return { content: `${name} ok` };
      },
    };
  }
}

/** Records what landed on the "disk" (a copy per save, like bytes). */
class SpyStore implements RecordStore {
  readonly saves: DaemonSessionRecord[] = [];
  async save(record: Parameters<RecordStore["save"]>[0]): Promise<void> {
    this.saves.push(JSON.parse(JSON.stringify(record)) as DaemonSessionRecord);
  }
  async remove(): Promise<void> {}
  async drain(): Promise<void> {}
  async load(): Promise<{ status: "absent" }> {
    return { status: "absent" };
  }
}

interface RigOptions {
  readonly now?: () => number;
  readonly store?: SpyStore;
  readonly maxIterations?: number;
  readonly systemPrompt?: string;
  /** Hooks over a fake env (its `exec` answers each hook run). */
  readonly hooks?: { readonly specs: HookSpec[]; readonly exec: ExecutionEnvironment["exec"] };
}

function rig(script: readonly (readonly StreamEvent[] | typeof PARK)[], opts: RigOptions = {}) {
  const model = new Scripted(script);
  const gate = new Gate();
  const host = new SessionHost({
    defaultCwd: CWD,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.store
      ? {
          persister: new SessionPersister({
            store: opts.store,
            cwd: CWD,
            model: "m",
            onError: () => {},
          }),
        }
      : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const tools = new ToolRegistry()
        .register(gate.tool("block", "none"))
        .register(gate.tool("ask", "ask"));
      const hookEnv = opts.hooks ? { ...env, id: "hooks", exec: opts.hooks.exec } : env;
      const agent = new Agent({
        model,
        tools,
        env: hookEnv,
        requestPermission: (req) => permissions.request(req),
        ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
        ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
        ...(opts.hooks
          ? { hooks: new HookRunner({ specs: opts.hooks.specs, env: hookEnv, cwd: "/" }) }
          : {}),
      });
      return { agent, permissions };
    },
  });
  return { host, model, gate };
}

/** A client attached to a session: its updates, and an optional hook per update. */
function client(onUpdate?: (u: SessionUpdate) => void) {
  const updates: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = {
    send: (p) => {
      updates.push(p);
      onUpdate?.(p.update);
    },
  };
  const stream = (): SessionUpdate[] => updates.map((u) => u.update);
  const has = (type: string, turnId: string) =>
    stream().some((u) => u.type === type && "turnId" in u && u.turnId === turnId);
  const ended = (turnId: string) => has("turn_end", turnId);
  const started = (turnId: string) => has("turn_start", turnId);
  const end = (turnId: string) =>
    stream().find((u) => u.type === "turn_end" && u.turnId === turnId);
  const start = (turnId: string) =>
    stream().find((u) => u.type === "turn_start" && u.turnId === turnId);
  return { updates, attachment, stream, ended, started, end, start };
}

const msg = (id: string, text: string): SendNowMessage => ({ id, text });
const turn = (turnId: string): SendNowTarget => ({ kind: "turn", turnId });
const userTexts = (messages: readonly ChatMessage[]): string[] =>
  messages.filter((m) => m.role === "user").map((m) => m.content);

/** Open a session, start turn T1 and wait until it is blocked in the gated tool. */
async function blockedT1(
  script: readonly (readonly StreamEvent[] | typeof PARK)[] = [call("c1", "block")],
  opts: RigOptions = {},
  onUpdate?: (u: SessionUpdate) => void,
) {
  const r = rig(script, opts);
  const c = client(onUpdate);
  const { hosted } = r.host.open({ create: true }, c.attachment);
  expect(hosted.prompt("T1", go)).toEqual({ turnId: "T1" });
  await until(() => r.gate.waiting === 1);
  return { ...r, c, hosted };
}

const expectRpc = (fn: () => unknown, code: number): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown instanceof RpcError ? thrown.code : thrown).toBe(code);
};

describe("session/send_now — atomic hand-off", () => {
  test("T-A1 over the wire: another client's prompt is refused before AND at the hand-off; turn_end{T1} is followed by turn_start{T2}", async () => {
    // Mutation M1 (settle via setTimeout(0)) → red: the racer armed at
    // turn_end{T1} (a transport message is a macrotask) finds the slot free.
    // T2 blocks too, so the racer meets it running (not already over).
    const r = rig([call("c1", "block"), call("c2", "block")]);
    const racer: unknown[] = [];
    const connect = async () => {
      const [d, cl] = createChannelPair();
      new Connection(d, r.host);
      const updates: KnownSessionUpdateParams[] = [];
      const peer = new RpcPeer(cl, {
        onNotification: (method, params) => {
          if (method !== "session/update") return;
          const p = params as KnownSessionUpdateParams;
          updates.push(p);
        },
      });
      await peer.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      return { peer, updates };
    };
    const a = await connect();
    const b = await connect();
    const { sessionId } = (await a.peer.request("session/open", { create: true })) as {
      sessionId: string;
    };
    await b.peer.request("session/open", { sessionId });
    const h = r.host.get(sessionId);
    if (!h) throw new Error("no session");
    h.attach({
      send: (p) => {
        if (p.update.type === "turn_end" && p.update.turnId === "T1") {
          setTimeout(() => {
            try {
              racer.push(h.prompt("T3", go));
            } catch (error) {
              racer.push(error instanceof RpcError ? error.code : error);
            }
          }, 0);
        }
      },
    });
    await a.peer.request("session/prompt", { sessionId, turnId: "T1", content: go });
    await until(() => r.gate.waiting === 1);
    const ack = await a.peer.request("session/send_now", {
      sessionId,
      turnId: "T2",
      interrupt: { kind: "turn", turnId: "T1" },
      messages: [{ id: "a", text: "A" }],
    });
    expect(ack).toEqual({ turnId: "T2" });
    // The cancel is still unwinding (the tool ignores its signal): B is refused.
    await expect(
      b.peer.request("session/prompt", { sessionId, turnId: "T3", content: go }),
    ).rejects.toMatchObject({ code: DomainErrorCode.TurnInProgress });
    r.gate.release();
    await until(() => r.gate.entered === 2 && r.gate.waiting === 1 && racer.length === 1);
    expect(racer).toEqual([DomainErrorCode.TurnInProgress]);
    r.gate.release();
    await until(() =>
      b.updates.some((u) => u.update.type === "turn_end" && u.update.turnId === "T2"),
    );
    for (const seen of [a.updates, b.updates]) {
      const kinds = seen.map((u) => u.update);
      const i = kinds.findIndex((u) => u.type === "turn_end" && u.turnId === "T1");
      expect(kinds[i]).toMatchObject({ type: "turn_end", turnId: "T1", stopReason: "cancelled" });
      expect(kinds[i + 1]).toEqual({ type: "turn_start", turnId: "T2", prompt: "A" });
      expect(kinds.some((u) => u.type === "turn_start" && u.turnId === "T3")).toBe(false);
    }
  });

  test("T-A1b no microtask between turn_end{T1} and the successor holding the slot", async () => {
    // Mutation M2 (settle via queueMicrotask) → red; T-A1 may not see it.
    const seen: boolean[] = [];
    const ref: { hosted?: HostedSession } = {};
    const t = await blockedT1([call("c1", "block")], {}, (u) => {
      if (u.type === "turn_end" && u.turnId === "T1") {
        queueMicrotask(() => seen.push(ref.hosted?.running === true));
      }
    });
    ref.hosted = t.hosted;
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(seen).toEqual([true]);
  });

  test("lastChangeAt: the successor's start is stamped like a turn start (after T1's end)", async () => {
    // Mutation: drop the stamp in `startSuccessor` → the start keeps T1's end stamp.
    let clock = 0;
    const stamps: Record<string, number> = {};
    const ref: { hosted?: HostedSession } = {};
    const t = await blockedT1([call("c1", "block")], { now: () => ++clock }, (u) => {
      if ((u.type === "turn_end" || u.type === "turn_start") && ref.hosted) {
        stamps[`${u.type}:${u.turnId}`] = ref.hosted.summary(CWD).lastChangeAt;
      }
    });
    ref.hosted = t.hosted;
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    const endT1 = stamps["turn_end:T1"] ?? Number.NaN;
    const startT2 = stamps["turn_start:T2"] ?? Number.NaN;
    expect(startT2).toBeGreaterThan(endT1);
    expect(stamps["turn_end:T2"] ?? Number.NaN).toBeGreaterThan(startT2);
  });

  test("lastChangeAt: a send-now that starts on a free slot is stamped at its start", async () => {
    let clock = 100;
    const r = rig([say("first")], { now: () => clock });
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    expect(hosted.summary(CWD).lastChangeAt).toBe(100);
    clock = 200;
    expect(hosted.sendNow("T2", turn("T1"), [msg("b", "B")])).toEqual({ turnId: "T2" });
    expect(hosted.summary(CWD).lastChangeAt).toBe(200);
    await until(() => c.ended("T2"));
  });
});

describe("session/send_now — what the new turn sends", () => {
  test("T-A2 the texts are joined with a blank line, in order: one user message = turn_start.prompt", async () => {
    const t = await blockedT1();
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A"), msg("b", "B")]);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(t.c.start("T2")).toEqual({ type: "turn_start", turnId: "T2", prompt: "A\n\nB" });
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A\n\nB"]);
    expect(t.model.calls.at(-1)?.messages.at(-1)?.content).toBe("A\n\nB");
  });

  test("T-A3 a message already drained as a steer is left out of the prompt; the history has it once", async () => {
    // Mutation M3 (prompt from every message, no `isDelivered` filter) → red.
    const t = await blockedT1([call("c1", "block"), call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A");
    t.gate.release(); // round 2 drains "A", then blocks again
    await until(() => t.gate.waiting === 1 && t.gate.entered === 2);
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A"), msg("b", "B")]);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(t.c.start("T2")).toEqual({ type: "turn_start", turnId: "T2", prompt: "B" });
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A", "B"]);
  });

  test('T-A3 all drained: a continuation turn (prompt ""), no new user message', async () => {
    const t = await blockedT1([call("c1", "block"), call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A");
    t.gate.release();
    await until(() => t.gate.waiting === 1 && t.gate.entered === 2);
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(t.c.start("T2")).toEqual({ type: "turn_start", turnId: "T2", prompt: "" });
    expect(t.c.end("T2")).toMatchObject({ stopReason: "end_turn" });
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A"]);
  });

  test("T-A4 a foreign steer queued in the cancelled turn is drained at the successor's first boundary", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("x", "T1", "X");
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    const stream = t.c.stream();
    const start = stream.findIndex((u) => u.type === "turn_start" && u.turnId === "T2");
    const steer = stream.findIndex((u) => u.type === "steer");
    expect(stream[steer]).toEqual({ type: "steer", text: "X" });
    expect(steer).toBeGreaterThan(start);
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A", "X"]);
    expect(
      t.model.calls
        .at(-1)
        ?.messages.slice(-2)
        .map((m) => m.content),
    ).toEqual(["A", "X"]);
  });

  test("T-A5 our enqueue landing in the window is delivered once (in the prompt); a later retry is a no-op", async () => {
    const t = await blockedT1();
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    // In flight before the key: it lands in the cancelled turn's queue.
    t.hosted.enqueue("a", "T1", "A");
    // Typed after the key: bound to the new turn.
    t.hosted.enqueue("y", "T2", "Y");
    t.hosted.enqueue("y", "T2", "Y"); // a retry while reserved
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(t.c.start("T2")).toMatchObject({ prompt: "A" });
    expect(t.c.stream().filter((u) => u.type === "steer")).toEqual([{ type: "steer", text: "Y" }]);
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A", "Y"]);
    // After the hand-off: an accepted id, never "not queued", never twice.
    t.hosted.enqueue("a", "T2", "A");
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.enqueue("y", "T2", "Y");
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A", "Y"]);
  });

  test("T-A6 a pending permission settles cancelled, the call reads cancelled, then T2 runs", async () => {
    const r = rig([call("c1", "ask")]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.stream().some((u) => u.type === "permission_request"));
    hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    await until(() => c.ended("T2"));
    const resolved = c.stream().find((u) => u.type === "permission_resolved");
    expect(resolved).toMatchObject({ outcome: { outcome: "cancelled" } });
    expect(r.gate.entered).toBe(0);
    const tool = hosted.snapshotPage().messages.find((m) => m.role === "tool");
    expect(tool?.content).toContain("ancel");
    expect(c.end("T1")).toMatchObject({ stopReason: "cancelled" });
    expect(c.end("T2")).toMatchObject({ stopReason: "end_turn" });
    expect(userTexts(hosted.snapshotPage().messages)).toEqual(["go", "A"]);
  });

  test("T-A7 a compaction is cancelled (history untouched, Cancelled to its requester), then T2 runs", async () => {
    const r = rig([say("first"), PARK]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    const before = hosted.snapshotPage().messages;
    const compacting = hosted.compact();
    const outcome = compacting.then(
      () => "resolved",
      (error: unknown) => (error instanceof RpcError ? error.code : error),
    );
    await until(() => r.model.waiting === 1);
    // A stale turn target while a compaction runs: refused, nothing cancelled.
    expectRpc(
      () => hosted.sendNow("T2", turn("T1"), [msg("a", "A")]),
      DomainErrorCode.CompactInProgress,
    );
    expect(hosted.sendNow("T2", { kind: "compaction" }, [msg("a", "A")])).toEqual({ turnId: "T2" });
    r.model.release();
    expect(await outcome).toBe(DomainErrorCode.Cancelled);
    await until(() => c.ended("T2"));
    const after = hosted.snapshotPage().messages;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(c.start("T2")).toMatchObject({ prompt: "A" });
    expect(c.stream().some((u) => u.type === "history_replaced")).toBe(false);
  });
});

describe("session/send_now — cancel, close, retries, stale targets", () => {
  test("T-A8 a cancel in the window: T2 ends with no turn_start, and its own steers are never injected", async () => {
    const t = await blockedT1();
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    t.hosted.enqueue("y", "T2", "Y");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T2"));
    await tick(10);
    expect(t.c.started("T2")).toBe(false);
    expect(t.c.end("T1")).toMatchObject({ stopReason: "cancelled" });
    // The end says it delivered nothing (follow-up 1): the stream and the retry.
    expect(t.c.end("T2")).toEqual({
      type: "turn_end",
      turnId: "T2",
      stopReason: "cancelled",
      delivered: false,
    });
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go"]);
    expect(t.hosted.running).toBe(false);
    // The retry reads the outcome; the slot is free for anyone.
    expect(t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({
      turnId: "T2",
      ended: { stopReason: "cancelled", delivered: false },
    });
    // Its steer was not accepted: a retry of it is honest (nothing runs).
    expectRpc(() => t.hosted.enqueue("y", "T2", "Y"), DomainErrorCode.NoTurnRunning);
  });

  test("T-A8 a close in the window: T1's end, T2's end, then session_closed — never a started T2", async () => {
    const t = await blockedT1();
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    t.hosted.close();
    expect(t.c.stream().slice(-3)).toEqual([
      { type: "turn_end", turnId: "T1", stopReason: "cancelled" },
      { type: "turn_end", turnId: "T2", stopReason: "cancelled", delivered: false },
      { type: "session_closed", reason: "closed" },
    ]);
    t.gate.release();
    await tick(10);
    expect(t.c.started("T2")).toBe(false);
    expect(t.hosted.running).toBe(false);
  });

  test("T-A8 a close while a compaction unwinds: T2's end before session_closed; nothing after", async () => {
    const r = rig([PARK]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    const compacting = hosted.compact().catch(() => undefined);
    await until(() => r.model.waiting === 1);
    hosted.sendNow("T2", { kind: "compaction" }, [msg("a", "A")]);
    hosted.close();
    expect(c.stream().slice(-2)).toEqual([
      { type: "turn_end", turnId: "T2", stopReason: "cancelled", delivered: false },
      { type: "session_closed", reason: "closed" },
    ]);
    const count = c.updates.length;
    r.model.release();
    await compacting;
    await tick(10);
    expect(c.updates.length).toBe(count);
    expect(hosted.running).toBe(false);
  });

  test("T-A9 retries: acked while reserved, cached with its end after; a second send-now is refused", async () => {
    const t = await blockedT1();
    expect(t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T2" });
    expect(t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T2" });
    expectRpc(
      () => t.hosted.sendNow("T9", turn("T1"), [msg("z", "Z")]),
      DomainErrorCode.TurnInProgress,
    );
    t.gate.release();
    await until(() => t.c.ended("T2"));
    // A started send-now turn's end says it delivered; T1 (a prompt turn) carries no field.
    expect(t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({
      turnId: "T2",
      ended: { stopReason: "end_turn", delivered: true },
    });
    expect(t.c.end("T2")).toMatchObject({ delivered: true });
    expect(t.c.end("T1")).not.toHaveProperty("delivered");
    expect(t.c.stream().filter((u) => u.type === "turn_start" && u.turnId === "T2")).toHaveLength(
      1,
    );
  });

  test("T-A9 a stale target never cancels the turn that runs now (TurnInProgress)", async () => {
    const t = await blockedT1();
    expectRpc(
      () => t.hosted.sendNow("T2", turn("T0"), [msg("a", "A")]),
      DomainErrorCode.TurnInProgress,
    );
    expectRpc(
      () => t.hosted.sendNow("T2", { kind: "compaction" }, [msg("a", "A")]),
      DomainErrorCode.TurnInProgress,
    );
    t.gate.release();
    await until(() => t.c.ended("T1"));
    expect(t.c.end("T1")).toMatchObject({ stopReason: "end_turn" });
    expect(t.c.started("T2")).toBe(false);
  });

  test("T-A9 the target ended on its own: all delivered → NoTurnRunning; else only the rest starts", async () => {
    const t = await blockedT1([call("c1", "block")]);
    t.hosted.enqueue("a", "T1", "A");
    t.gate.release(); // round 2 drains "A" and the turn ends
    await until(() => t.c.ended("T1"));
    expectRpc(
      () => t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]),
      DomainErrorCode.NoTurnRunning,
    );
    expect(t.c.started("T2")).toBe(false);
    expect(t.hosted.sendNow("T2", turn("T1"), [msg("a", "A"), msg("b", "B")])).toEqual({
      turnId: "T2",
    });
    expect(t.hosted.running).toBe(true);
    await until(() => t.c.ended("T2"));
    expect(t.c.start("T2")).toMatchObject({ prompt: "B" });
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A", "B"]);
  });

  test("over the wire: an unknown session is UnknownSession, an empty send-now is InvalidParams", async () => {
    const r = rig([]);
    const [d, cl] = createChannelPair();
    new Connection(d, r.host);
    const peer = new RpcPeer(cl, {});
    await peer.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const params = {
      sessionId: "nope",
      turnId: "T2",
      interrupt: { kind: "compaction" },
      messages: [{ id: "a", text: "A" }],
    };
    await expect(peer.request("session/send_now", params)).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    await expect(
      peer.request("session/send_now", { ...params, messages: [] }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("session/send_now — persistence", () => {
  test("T-A10 the window's record holds no T2; a restart there + the resent send-now starts T2 once, no duplicate", async () => {
    // Mutation M4 (`turns.set(T2)` at the reservation) → red.
    const store = new SpyStore();
    const t = await blockedT1([call("c1", "block"), call("c2", "block")], { store });
    t.hosted.enqueue("a", "T1", "A");
    t.gate.release();
    await until(() => t.gate.waiting === 1 && t.gate.entered === 2);
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A"), msg("b", "B")]);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    await t.hosted.persisted();
    // The write `finishTurn` made inside the window: T1 over, slot free.
    const windowRecord = store.saves.find(
      (s) => s.turn === undefined && s.turns.some((k) => k.turnId === "T1" && k.end),
    );
    if (!windowRecord) throw new Error("no window record");
    expect(windowRecord.turns.map((k) => k.turnId)).toEqual(["T1"]);
    for (const save of store.saves) {
      // Never a T2 key without its turn running (or ended) in the same record.
      const t2 = save.turns.find((k) => k.turnId === "T2");
      if (t2 && !t2.end) expect(save.turn?.turnId).toBe("T2");
    }

    const parsed = parseDaemonRecord(
      JSON.parse(JSON.stringify(windowRecord)),
      (cwd) => cwd === CWD,
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    // A persister, as on `serve`: only then does `restore` carry the keys over.
    const r2 = rig([], { store: new SpyStore() });
    const restored = r2.host.restore(parsed.record);
    const c2 = client();
    restored.attach(c2.attachment);
    expect(restored.sendNow("T2", turn("T1"), [msg("a", "A"), msg("b", "B")])).toEqual({
      turnId: "T2",
    });
    await until(() => c2.ended("T2"));
    expect(c2.stream().filter((u) => u.type === "turn_start")).toEqual([
      { type: "turn_start", turnId: "T2", prompt: "B" },
    ]);
    expect(userTexts(restored.snapshotPage().messages)).toEqual(["go", "A", "B"]);
  });

  test("follow-up 1: `delivered` survives a restart (the retried ack reads it); a bad one is refused", async () => {
    const store = new SpyStore();
    const t = await blockedT1([call("c1", "block")], { store });
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T2"));
    await t.hosted.persisted();
    const last = store.saves.at(-1);
    if (!last) throw new Error("no record");
    const raw = JSON.parse(JSON.stringify(last));
    const parsed = parseDaemonRecord(raw, (cwd) => cwd === CWD);
    if (!parsed.ok) throw new Error(parsed.reason);
    const restored = rig([], { store: new SpyStore() }).host.restore(parsed.record);
    expect(restored.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({
      turnId: "T2",
      ended: { stopReason: "cancelled", delivered: false },
    });
    for (const key of raw.turns) {
      if (key.turnId === "T2") key.end.delivered = "no";
    }
    expect(parseDaemonRecord(raw, (cwd) => cwd === CWD)).toMatchObject({ ok: false });
  });
});

// Review F1 (owner decision 2026-10-23): every text already in the history but
// UNANSWERED — no assistant message after the caller's last delivered text —
// gets a continuation turn, as on the hand-off path. One test per path that
// injects a text with no model round after it.
describe("session/send_now — delivered but unanswered (review F1)", () => {
  /** The model's last request ends with `text` (the continuation answered it). */
  const answered = (model: Scripted, text: string): void =>
    expect(model.calls.at(-1)?.messages.at(-1)?.content).toBe(text);

  test("F1a a crash before the hand-off: the reload appends the steer; the resent send-now answers it", async () => {
    const store = new SpyStore();
    const t = await blockedT1([call("c1", "block")], { store });
    t.hosted.enqueue("a", "T1", "A");
    await t.hosted.persisted();
    // The last record before the crash: T1 running, its steer queued.
    const record = store.saves.at(-1);
    expect(record?.turn).toMatchObject({ turnId: "T1", steering: ["A"] });
    const parsed = parseDaemonRecord(JSON.parse(JSON.stringify(record)), (cwd) => cwd === CWD);
    if (!parsed.ok) throw new Error(parsed.reason);
    t.gate.release();

    let clock = 500;
    const r2 = rig([say("answer")], { store: new SpyStore(), now: () => clock });
    const restored = r2.host.restore(parsed.record);
    const c2 = client();
    restored.attach(c2.attachment);
    expect(userTexts(restored.snapshotPage().messages)).toEqual(["go", "A"]);
    clock = 600;
    expect(restored.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T2" });
    // Stamped like any turn start.
    expect(restored.summary(CWD).lastChangeAt).toBe(600);
    await until(() => c2.ended("T2"));
    expect(c2.start("T2")).toEqual({ type: "turn_start", turnId: "T2", prompt: "" });
    expect(c2.end("T2")).toMatchObject({ stopReason: "end_turn" });
    expect(userTexts(restored.snapshotPage().messages)).toEqual(["go", "A"]);
    answered(r2.model, "A");
  });

  test("F1b the max_iterations end-of-turn drain: the resent send-now answers it", async () => {
    const t = await blockedT1([call("c1", "block"), PARK, say("answer")], { maxIterations: 1 });
    t.gate.release();
    // The final report (no tools) is running: a steer now is drained after it.
    await until(() => t.model.waiting === 1);
    t.hosted.enqueue("a", "T1", "A");
    t.model.release();
    await until(() => t.c.ended("T1"));
    expect(t.c.end("T1")).toMatchObject({ stopReason: "max_iterations" });
    expect(t.hosted.snapshotPage().messages.at(-1)).toEqual({ role: "user", content: "A" });
    expect(t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T2" });
    await until(() => t.c.ended("T2"));
    expect(t.c.start("T2")).toMatchObject({ prompt: "" });
    expect(t.c.end("T2")).toMatchObject({ stopReason: "end_turn" });
    answered(t.model, "A");
  });

  test("F1c the turn_start-hook stop drain: the resent send-now answers it", async () => {
    let runs = 0;
    const hookGate: Array<() => void> = [];
    const exec: ExecutionEnvironment["exec"] = async () => {
      runs++;
      if (runs === 1) {
        await new Promise<void>((r) => hookGate.push(r));
        return { stdout: "", stderr: "frozen", exitCode: 2 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const r = rig([say("answer")], {
      hooks: { specs: [{ event: "turn_start", command: "ts" }], exec },
    });
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => hookGate.length === 1);
    hosted.enqueue("a", "T1", "A");
    for (const release of hookGate.splice(0)) release();
    await until(() => c.ended("T1"));
    expect(r.model.calls).toHaveLength(0);
    expect(hosted.snapshotPage().messages.at(-1)).toEqual({ role: "user", content: "A" });
    expect(hosted.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T2" });
    await until(() => c.ended("T2"));
    expect(c.start("T2")).toMatchObject({ prompt: "" });
    expect(r.model.calls).toHaveLength(1);
    answered(r.model, "A");
  });
});

// Owner decision 2026-10-23 (follow-up 2): "awaits an answer" is STRUCTURAL —
// the history's last message is a user turn (whoever wrote it), not the lone
// compaction summary. No text comparison.
describe("session/send_now — the structural unanswered rule", () => {
  /** Hooks whose `turn_start` run `stopOn` waits for the test, then exits 2 (a stop). */
  function stoppingHooks(stopOn: number) {
    let runs = 0;
    const held: Array<() => void> = [];
    const exec: ExecutionEnvironment["exec"] = async () => {
      runs++;
      if (runs === stopOn) {
        await new Promise<void>((r) => held.push(r));
        return { stdout: "", stderr: "frozen", exitCode: 2 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    return {
      hooks: { specs: [{ event: "turn_start" as const, command: "ts" }], exec },
      get waiting() {
        return held.length;
      },
      release: () => {
        for (const r of held.splice(0)) r();
      },
    };
  }

  /**
   * T1 drains our `a` at a boundary and answers it; T2 (another client) is
   * stopped by its `turn_start` hook with its own steer `text` drained last.
   */
  async function answeredThenForeignTail(text: string) {
    const h = stoppingHooks(2);
    const r = rig([call("c1", "block"), say("answered A"), say("answer")], { hooks: h.hooks });
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => r.gate.waiting === 1);
    hosted.enqueue("a", "T1", "A");
    r.gate.release();
    await until(() => c.ended("T1"));
    expect(hosted.snapshotPage().messages.at(-1)?.role).toBe("assistant");
    hosted.prompt("T2", [{ type: "text", text: "theirs" }]);
    await until(() => h.waiting === 1);
    hosted.enqueue("x", "T2", text);
    h.release();
    await until(() => c.ended("T2"));
    expect(hosted.snapshotPage().messages.at(-1)).toEqual({ role: "user", content: text });
    return { r, c, hosted };
  }

  test("S1 our text answered, another client's different text unanswered at the tail → continuation", async () => {
    // The OLD text rule refused (`NoTurnRunning`: none of OUR texts after the
    // last reply). Mutations W1 (wrong message), W3 (always false) → red.
    const { r, c, hosted } = await answeredThenForeignTail("X");
    expect(hosted.sendNow("T3", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T3" });
    await until(() => c.ended("T3"));
    expect(c.start("T3")).toMatchObject({ prompt: "" });
    expect(r.model.calls.at(-1)?.messages.at(-1)?.content).toBe("X");
  });

  test("S2 the same text: answered earlier, then delivered again unanswered → continuation; once answered → NoTurnRunning", async () => {
    // Mutation W2 (always true) → red on the second half.
    const { r, c, hosted } = await answeredThenForeignTail("A");
    expect(hosted.sendNow("T3", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T3" });
    await until(() => c.ended("T3"));
    expect(r.model.calls.at(-1)?.messages.at(-1)?.content).toBe("A");
    expect(hosted.snapshotPage().messages.at(-1)?.role).toBe("assistant");
    expectRpc(
      () => hosted.sendNow("T4", turn("T3"), [msg("a", "A")]),
      DomainErrorCode.NoTurnRunning,
    );
    expect(c.started("T4")).toBe(false);
  });

  test("S3 right after a compaction (the summary is a user message) → NoTurnRunning, no spurious turn", async () => {
    // Mutation W4 (no summary exception) → red.
    const r = rig([call("c1", "block"), say("answered A"), say("SUMMARY")]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => r.gate.waiting === 1);
    hosted.enqueue("a", "T1", "A");
    r.gate.release();
    await until(() => c.ended("T1"));
    await hosted.compact();
    const history = hosted.snapshotPage().messages;
    expect(history.at(-1)?.role).toBe("user");
    expect(history.filter((m) => m.role !== "system")).toHaveLength(1);
    expectRpc(
      () => hosted.sendNow("T2", turn("T1"), [msg("a", "A")]),
      DomainErrorCode.NoTurnRunning,
    );
    expect(c.started("T2")).toBe(false);
    expect(hosted.running).toBe(false);
  });

  test("S4 a turn cancelled mid-tool (the history ends with a tool result) → NoTurnRunning", async () => {
    // Mutation W5 (`role !== "assistant"`: a tool tail counts) → red.
    const t = await blockedT1([call("c1", "block"), call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A");
    t.gate.release(); // round 2 drains "A" (the model saw it), then blocks again
    await until(() => t.gate.waiting === 1 && t.gate.entered === 2);
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    expect(t.hosted.snapshotPage().messages.at(-1)?.role).toBe("tool");
    expectRpc(
      () => t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]),
      DomainErrorCode.NoTurnRunning,
    );
    expect(t.c.started("T2")).toBe(false);
  });

  // Follow-up 3: the summary is recognised by what the session KNOWS it
  // installed (identity), never by shape — `[system?, user]` is also a first
  // turn. These first turns are send-nows (prompt "A" = our message `a`).

  test('U1 a first turn stopped by its turn_start hook → the resent send-now is a continuation, not a second "A"', async () => {
    // Red before the fix: the prompt's ids were never "delivered" in memory,
    // so a new send-now re-sent "A" as a prompt (a duplicate).
    const h = stoppingHooks(1);
    const r = rig([say("answer")], { hooks: h.hooks });
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    expect(hosted.sendNow("T1", turn("T0"), [msg("a", "A")])).toEqual({ turnId: "T1" });
    await until(() => h.waiting === 1);
    h.release();
    await until(() => c.ended("T1"));
    expect(userTexts(hosted.snapshotPage().messages)).toEqual([
      "A",
      "[hook turn_start] turn stopped: frozen",
    ]);
    expect(hosted.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T2" });
    await until(() => c.ended("T2"));
    expect(c.start("T2")).toMatchObject({ prompt: "" });
    expect(userTexts(hosted.snapshotPage().messages).filter((t) => t === "A")).toHaveLength(1);
    expect(r.model.calls).toHaveLength(1);
  });

  test("U2 a first turn cancelled before any reply ([user] alone) → continuation", async () => {
    // Mutation X1 (drop the marker: the position rule) → red.
    const r = rig([PARK, say("answer")]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.sendNow("T1", turn("T0"), [msg("a", "A")]);
    await until(() => r.model.waiting === 1);
    hosted.cancel();
    r.model.release();
    await until(() => c.ended("T1"));
    expect(hosted.snapshotPage().messages).toEqual([{ role: "user", content: "A" }]);
    expect(hosted.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T2" });
    await until(() => c.ended("T2"));
    expect(c.start("T2")).toMatchObject({ prompt: "" });
    expect(r.model.calls.at(-1)?.messages.at(-1)?.content).toBe("A");
  });

  test("U3 a crash before the first reply, then a reload ([system, user]) → continuation", async () => {
    // Mutation X1 → red; mutation X3 (the reload marker ignores the cut-short turn) → red.
    const store = new SpyStore();
    const r = rig([PARK], { store, systemPrompt: "sys" });
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.sendNow("T1", turn("T0"), [msg("a", "A")]);
    await until(() => r.model.waiting === 1);
    await hosted.persisted();
    const record = store.saves.at(-1);
    expect(record?.turn?.turnId).toBe("T1");
    const parsed = parseDaemonRecord(JSON.parse(JSON.stringify(record)), (cwd) => cwd === CWD);
    if (!parsed.ok) throw new Error(parsed.reason);
    r.model.release();

    const r2 = rig([say("answer")], { store: new SpyStore(), systemPrompt: "sys" });
    const restored = r2.host.restore(parsed.record);
    const c2 = client();
    restored.attach(c2.attachment);
    expect(restored.snapshotPage().messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(restored.sendNow("T2", turn("T1"), [msg("a", "A")])).toEqual({ turnId: "T2" });
    await until(() => c2.ended("T2"));
    expect(c2.start("T2")).toMatchObject({ prompt: "" });
    expect(r2.model.calls.at(-1)?.messages.at(-1)?.content).toBe("A");
  });

  test("U4 after a compaction, a later unanswered user tail → continuation (the marker is the summary only)", async () => {
    // Mutation X2 (marker never cleared: any tail after a compaction reads as
    // the summary) → red.
    const h = stoppingHooks(2); // T1 is run 1; compaction runs no turn_start hook
    const r = rig([call("c1", "block"), say("answered A"), say("SUMMARY"), say("answer")], {
      hooks: h.hooks,
    });
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => r.gate.waiting === 1);
    hosted.enqueue("a", "T1", "A");
    r.gate.release();
    await until(() => c.ended("T1"));
    await hosted.compact();
    hosted.prompt("T2", [{ type: "text", text: "after" }]);
    await until(() => h.waiting === 1);
    hosted.enqueue("x", "T2", "X");
    h.release();
    await until(() => c.ended("T2"));
    expect(hosted.snapshotPage().messages.at(-1)).toEqual({ role: "user", content: "X" });
    expect(hosted.sendNow("T3", turn("T2"), [msg("a", "A")])).toEqual({ turnId: "T3" });
    await until(() => c.ended("T3"));
    expect(c.start("T3")).toMatchObject({ prompt: "" });
    expect(r.model.calls.at(-1)?.messages.at(-1)?.content).toBe("X");
  });

  test("U5 a reload of a just-compacted record → NoTurnRunning (decided: no spurious turn)", async () => {
    // Mutation X3' (no marker on reload) → red.
    const store = new SpyStore();
    const r = rig([call("c1", "block"), say("answered A"), say("SUMMARY")], {
      store,
      systemPrompt: "sys",
    });
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => r.gate.waiting === 1);
    hosted.enqueue("a", "T1", "A");
    r.gate.release();
    await until(() => c.ended("T1"));
    await hosted.compact();
    await hosted.persisted();
    const record = store.saves.at(-1);
    expect(record?.turn).toBeUndefined();
    const parsed = parseDaemonRecord(JSON.parse(JSON.stringify(record)), (cwd) => cwd === CWD);
    if (!parsed.ok) throw new Error(parsed.reason);

    const r2 = rig([say("spurious")], { store: new SpyStore(), systemPrompt: "sys" });
    const restored = r2.host.restore(parsed.record);
    expect(restored.snapshotPage().messages.map((m) => m.role)).toEqual(["system", "user"]);
    expectRpc(
      () => restored.sendNow("T2", turn("T1"), [msg("a", "A")]),
      DomainErrorCode.NoTurnRunning,
    );
    expect(restored.running).toBe(false);
    expect(r2.model.calls).toHaveLength(0);
  });
});

describe("session/send_now — the queued-id mirror (review F2)", () => {
  test("F2 a drained steer, then a foreign and one of ours pending: ours once in the prompt, the foreign seeded", async () => {
    // Mutation R7 (`drive` reads `steeringIds[0]`, never shifts) → red: the
    // stale head `a` is zipped against the pending entries and "B" is re-seeded.
    const t = await blockedT1([call("c1", "block"), call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A");
    t.gate.release(); // round 2 drains "A", then blocks again
    await until(() => t.gate.waiting === 1 && t.gate.entered === 2);
    t.hosted.enqueue("x", "T1", "X");
    t.hosted.enqueue("b", "T1", "B");
    t.hosted.sendNow("T2", turn("T1"), [msg("b", "B")]);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(t.c.start("T2")).toEqual({ type: "turn_start", turnId: "T2", prompt: "B" });
    const stream = t.c.stream();
    const start = stream.findIndex((u) => u.type === "turn_start" && u.turnId === "T2");
    expect(stream.slice(start).filter((u) => u.type === "steer")).toEqual([
      { type: "steer", text: "X" },
    ]);
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A", "B", "X"]);
  });
});

// send-now-c follow-up 2 (owner principle: the client never guesses what the
// daemon knows). A refused send-now (`TurnInProgress`, `CompactInProgress`)
// reports in `error.data.held` which of the caller's texts the daemon holds —
// in the history, or queued in the live turn / the reserved send-now that
// carries them — so the client restores exactly the others. Each case also
// checks the FATE the report claims.
describe("session/send_now — a refusal reports what the daemon holds", () => {
  /** The refusal `fn` throws: its code and data. */
  const refusal = (fn: () => unknown): { code: unknown; data: unknown } => {
    try {
      fn();
    } catch (error) {
      if (error instanceof RpcError) return { code: error.code, data: error.data };
      throw error;
    }
    throw new Error("not refused");
  };
  /** T1 drains "A" (id a) at its round-2 boundary and ends; then T2 blocks in its tool. */
  async function t1DoneT2Blocked() {
    const t = await blockedT1([call("c1", "block"), say("t1 done"), call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A");
    t.gate.release();
    await until(() => t.c.ended("T1"));
    t.hosted.prompt("T2", go);
    await until(() => t.gate.waiting === 1);
    return t;
  }

  test("F-1 (`:841`) another client's send-now waits on MY running turn: my queued steer is held (carried), an unsent text is not", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("a", "T1", "A");
    expect(t.hosted.sendNow("S", turn("T1"), [msg("x", "X")])).toEqual({ turnId: "S" });
    const r = refusal(() => t.hosted.sendNow("M", turn("T1"), [msg("a", "A"), msg("b", "B")]));
    expect(r).toEqual({ code: DomainErrorCode.TurnInProgress, data: { held: ["a"] } });
    t.gate.release();
    await until(() => t.c.ended("S"));
    // The fate: "A" carried into S (once), "B" never reached the daemon.
    const users = userTexts(t.hosted.snapshotPage().messages);
    expect(users.filter((u) => u === "A")).toHaveLength(1);
    expect(users).not.toContain("B");
  });

  test("F-2 (`:841`) my target already ended, a send-now waits on another turn: a drained text is held", async () => {
    const t = await t1DoneT2Blocked();
    expect(t.hosted.sendNow("S", turn("T2"), [msg("x", "X")])).toEqual({ turnId: "S" });
    const r = refusal(() => t.hosted.sendNow("M", turn("T1"), [msg("a", "A"), msg("b", "B")]));
    expect(r).toEqual({ code: DomainErrorCode.TurnInProgress, data: { held: ["a"] } });
    t.gate.release();
    await until(() => t.c.ended("S"));
    const users = userTexts(t.hosted.snapshotPage().messages);
    expect(users.filter((u) => u === "A")).toHaveLength(1);
    expect(users).not.toContain("B");
  });

  test("F-3 (`assertIdle`) my target ended, another client's turn runs: a drained text is held", async () => {
    const t = await t1DoneT2Blocked();
    const r = refusal(() => t.hosted.sendNow("M", turn("T1"), [msg("a", "A"), msg("b", "B")]));
    expect(r).toEqual({ code: DomainErrorCode.TurnInProgress, data: { held: ["a"] } });
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A", "go"]);
  });

  test("F-4 (`assertIdle`) my turn was cancelled with a steer pending, then another client's PROMPT started: nothing is held (the prompt dropped it)", async () => {
    const t = await blockedT1([call("c1", "block"), call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    t.hosted.prompt("T2", go);
    await until(() => t.gate.waiting === 1);
    const r = refusal(() => t.hosted.sendNow("M", turn("T1"), [msg("a", "A")]));
    expect(r).toEqual({ code: DomainErrorCode.TurnInProgress, data: { held: [] } });
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(userTexts(t.hosted.snapshotPage().messages)).not.toContain("A");
  });

  test("F-5 (`assertIdle`) a compaction runs: CompactInProgress carries the same report", async () => {
    const t = await blockedT1([call("c1", "block"), say("t1 done"), PARK]);
    t.hosted.enqueue("a", "T1", "A");
    t.gate.release();
    await until(() => t.c.ended("T1"));
    const compacting = t.hosted.compact().catch(() => undefined);
    await until(() => t.model.waiting === 1);
    const r = refusal(() => t.hosted.sendNow("M", turn("T1"), [msg("a", "A"), msg("b", "B")]));
    expect(r).toEqual({ code: DomainErrorCode.CompactInProgress, data: { held: ["a"] } });
    t.model.release();
    await compacting;
  });

  test("F-7 (`:843`, review R2-1) another client's send-now on my turn is cancelled before it starts: my queued steer is NOT held (it is dropped)", async () => {
    // Ported from the reviewer's repro (.tentacle/tmp/send-now-c/endunstarted.test.ts,
    // REVIEW-R2). Mutation M-R4 (no successor term in `live`) is killed by F-1.
    const t = await blockedT1([call("c1", "block"), call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A"); // my steer, accepted for T1
    expect(t.hosted.sendNow("S", turn("T1"), [msg("x", "X")])).toEqual({ turnId: "S" }); // client B
    t.hosted.cancel(); // B's Esc in the window: S is cancelled while reserved
    const r = refusal(() => t.hosted.sendNow("M", turn("T1"), [msg("a", "A")]));
    expect(r).toEqual({ code: DomainErrorCode.TurnInProgress, data: { held: [] } });
    t.gate.release();
    await until(() => t.c.ended("S"));
    expect(t.c.end("S")).toMatchObject({ stopReason: "cancelled", delivered: false });
    t.hosted.prompt("T2", go);
    await until(() => t.gate.waiting === 1);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    // The fate the report must not hide: "A" never reached the history (the
    // `endUnstarted` gap, debt) — so the client restores it.
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "go"]);
  });

  test("F-6 (`assertIdle`) my turn was cancelled with a steer pending, then a compaction runs: not held (no turn will drain it)", async () => {
    const t = await blockedT1([call("c1", "block"), PARK, call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    const compacting = t.hosted.compact().catch(() => undefined);
    await until(() => t.model.waiting === 1);
    const r = refusal(() => t.hosted.sendNow("M", turn("T1"), [msg("a", "A")]));
    expect(r).toEqual({ code: DomainErrorCode.CompactInProgress, data: { held: [] } });
    t.model.release();
    await compacting;
    // The fate it reports: the next prompt drops the leftover queue.
    t.hosted.prompt("T2", go);
    await until(() => t.gate.waiting === 1);
    t.gate.release();
    await until(() => t.c.ended("T2"));
    expect(userTexts(t.hosted.snapshotPage().messages)).not.toContain("A");
  });
});
