import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
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
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import type { Attachment } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";

// Every attached client sees the session's queue, and every row left at a
// turn's end goes back to its writer (docs/feat/queued-broadcast.md). Each test
// names the plan's Q* case and, where one applies, the mutation (M*) that must
// turn it red.

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

class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly calls: ChatRequest[] = [];
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...request, messages: [...request.messages] });
    yield* this.script[this.calls.length - 1] ?? say("ok");
  }
}

/** A tool that blocks until `release()` and ignores its abort signal (a slow cancel). */
class Gate {
  private waiters: Array<() => void> = [];
  get waiting(): number {
    return this.waiters.length;
  }
  release(): void {
    for (const r of this.waiters.splice(0)) r();
  }
  tool(name: string): Tool {
    return {
      name,
      description: name,
      inputSchema: z.object({}).passthrough(),
      permission: "none",
      execute: async () => {
        await new Promise<void>((r) => this.waiters.push(r));
        return { content: `${name} ok` };
      },
    };
  }
}

function rig(script: readonly (readonly StreamEvent[])[]) {
  const model = new Scripted(script);
  const gate = new Gate();
  const host = new SessionHost({
    defaultCwd: "/tmp/queued",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const tools = new ToolRegistry().register(gate.tool("block"));
      const agent = new Agent({
        model,
        tools,
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
  return { host, model, gate };
}

function client() {
  const updates: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = { send: (p) => updates.push(p) };
  const stream = (): SessionUpdate[] => updates.map((u) => u.update);
  const queued = () =>
    stream().flatMap((u) =>
      u.type === "queued" ? [{ entries: u.entries, returned: u.returned }] : [],
    );
  const ended = (turnId: string) =>
    stream().some((u) => u.type === "turn_end" && u.turnId === turnId);
  return { updates, attachment, stream, queued, ended };
}

const msg = (id: string, text: string): SendNowMessage => ({ id, text });
const turn = (turnId: string): SendNowTarget => ({ kind: "turn", turnId });
const userTexts = (messages: readonly ChatMessage[]): string[] =>
  messages.filter((m) => m.role === "user").map((m) => m.content);
/** The update after the first one matching `pred`. */
const nextAfter = (stream: SessionUpdate[], pred: (u: SessionUpdate) => boolean) =>
  stream[stream.findIndex(pred) + 1];

async function blockedT1(script: readonly (readonly StreamEvent[])[] = [call("c1", "block")]) {
  const r = rig(script);
  const c = client();
  const { hosted } = r.host.open({ create: true }, c.attachment);
  expect(hosted.prompt("T1", go)).toEqual({ turnId: "T1" });
  await until(() => r.gate.waiting === 1);
  return { ...r, c, hosted };
}

describe("the queue is broadcast (docs/feat/queued-broadcast.md)", () => {
  test("Q1 two clients see every row, with its writer's id, in order", async () => {
    const t = await blockedT1();
    const other = client();
    t.host.open({ sessionId: t.hosted.id }, other.attachment);
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.enqueue("b", "T1", "B");
    for (const c of [t.c, other]) {
      expect(c.queued()).toEqual([
        { entries: [{ id: "a", text: "A" }], returned: [] },
        {
          entries: [
            { id: "a", text: "A" },
            { id: "b", text: "B" },
          ],
          returned: [],
        },
      ]);
    }
    t.gate.release();
  });

  test("Q2 a drained row leaves in the queued right after its steer (M1)", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.enqueue("b", "T1", "B");
    t.gate.release();
    await until(() => t.c.ended("T1"));
    const stream = t.c.stream();
    expect(nextAfter(stream, (u) => u.type === "steer" && u.text === "A")).toEqual({
      type: "queued",
      entries: [{ id: "b", text: "B" }],
      returned: [],
    });
    expect(nextAfter(stream, (u) => u.type === "steer" && u.text === "B")).toEqual({
      type: "queued",
      entries: [],
      returned: [],
    });
    expect(t.hosted.snapshotPage().queued).toEqual({ entries: [], returned: [] });
  });

  test("Q2b each steer names the row it drained (its writer's id): no client guesses FIFO", async () => {
    // Review F1's root. Mutation: the steer without its id → red.
    const t = await blockedT1();
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.enqueue("b", "T1", "B");
    t.gate.release();
    await until(() => t.c.ended("T1"));
    expect(t.c.stream().filter((u) => u.type === "steer")).toEqual([
      { type: "steer", text: "A", id: "a" },
      { type: "steer", text: "B", id: "b" },
    ]);
  });

  test("Q3 Esc with a row left: turn_end, then the row is returned to its writer (M3)", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("b", "T1", "B");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    expect(nextAfter(t.c.stream(), (u) => u.type === "turn_end" && u.turnId === "T1")).toEqual({
      type: "queued",
      entries: [],
      returned: [{ id: "b", text: "B", cause: "cancelled" }],
    });
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go"]);
  });

  test("Q3b a failed turn returns its rows with cause failed", async () => {
    // The model call waits, then fails: a row queued meanwhile meets no boundary.
    let fail: () => void = () => {};
    let waiting = false;
    const failing: ModelProvider = {
      id: "failing",
      async *stream(): AsyncIterable<StreamEvent> {
        waiting = true;
        await new Promise<void>((r) => {
          fail = r;
        });
        throw new Error("boom");
      },
    };
    const host = new SessionHost({
      defaultCwd: "/tmp/queued",
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model: failing,
          tools: new ToolRegistry(),
          env,
          requestPermission: (req) => permissions.request(req),
        });
        return { agent, permissions };
      },
    });
    const c = client();
    const { hosted } = host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => waiting);
    hosted.enqueue("b", "T1", "B");
    fail();
    await until(() => c.ended("T1"));
    expect(c.stream().find((u) => u.type === "turn_end")).toMatchObject({ stopReason: "error" });
    expect(c.queued().at(-1)).toEqual({
      entries: [],
      returned: [{ id: "b", text: "B", cause: "failed" }],
    });
  });

  test("Q4 hand-off: the send-now carries the foreign row with its id, nothing is returned (M4)", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("x", "T1", "X"); // another client's row
    t.hosted.enqueue("a", "T1", "A"); // mine
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    expect(t.c.queued().at(-1)).toEqual({
      entries: [
        { id: "a", text: "A" },
        { id: "x", text: "X" },
      ],
      returned: [],
    });
    t.gate.release();
    await until(() => t.c.ended("T2"));
    const stream = t.c.stream();
    const end = stream.findIndex((u) => u.type === "turn_end" && u.turnId === "T1");
    expect(stream.slice(end, end + 3)).toEqual([
      { type: "turn_end", turnId: "T1", stopReason: "cancelled" },
      { type: "turn_start", turnId: "T2", prompt: "A" },
      { type: "queued", entries: [{ id: "x", text: "X" }], returned: [] },
    ]);
    expect(nextAfter(stream, (u) => u.type === "steer" && u.text === "X")).toEqual({
      type: "queued",
      entries: [],
      returned: [],
    });
    expect(stream.some((u) => u.type === "queued" && u.returned.length > 0)).toBe(false);
  });

  test("Q4b the 4a gap: another client's send-now cancelled before it starts returns MY row only (M5)", async () => {
    const t = await blockedT1([call("c1", "block"), call("c2", "block")]);
    t.hosted.enqueue("a", "T1", "A"); // mine
    t.hosted.enqueue("b", "T1", "B"); // client B's, which its send-now then cites
    t.hosted.sendNow("S", turn("T1"), [msg("b", "B")]);
    t.hosted.cancel(); // B's Esc in the window
    t.gate.release();
    await until(() => t.c.ended("S"));
    expect(t.c.stream().find((u) => u.type === "turn_end" && u.turnId === "S")).toMatchObject({
      delivered: false,
    });
    expect(t.c.queued().at(-1)).toEqual({
      entries: [],
      returned: [{ id: "a", text: "A", cause: "cancelled" }],
    });
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go"]);
  });

  test("Q5 a cancel in the window: the reserved turn's rows leave the queue at once", async () => {
    const t = await blockedT1();
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    expect(t.c.queued().at(-1)?.entries).toEqual([{ id: "a", text: "A" }]);
    t.hosted.cancel();
    expect(t.c.queued().at(-1)).toEqual({ entries: [], returned: [] });
    t.gate.release();
    await until(() => t.c.ended("T2"));
    // Its sender restores it (`delivered: false`): never ALSO returned.
    expect(t.hosted.snapshotPage().queued).toEqual({ entries: [], returned: [] });
  });

  test("Q6 a late attacher whose cut is past the last queued gets the state from the snapshot (M2)", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("b", "T1", "B");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    const queuedSeq = t.c.updates.filter((u) => u.update.type === "queued").at(-1)?.seq ?? -1;
    // A second turn moves the cut past that update.
    t.hosted.prompt("T2", go);
    await until(() => t.c.ended("T2"));
    expect(t.hosted.historyCut.seq).toBeGreaterThan(queuedSeq);
    const late = client();
    t.host.open({ sessionId: t.hosted.id }, late.attachment);
    expect(late.queued()).toEqual([]);
    expect(t.hosted.snapshotPage().queued).toEqual({
      entries: [],
      returned: [{ id: "b", text: "B", cause: "cancelled" }],
    });
    // A later page carries no queue (first page only, like `since`).
    const cursor = t.hosted.snapshotPage(undefined, 1).cursor;
    expect(cursor).toBeDefined();
    if (cursor !== undefined) expect(t.hosted.snapshotPage(cursor).queued).toBeUndefined();
  });

  test("Q8 no resurrection: a send-now on a free slot never seeds a cancelled turn's row", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("x", "T1", "X"); // another client's row
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    await until(() => t.c.ended("T2"));
    expect(t.c.stream().some((u) => u.type === "steer")).toBe(false);
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A"]);
    expect(t.hosted.snapshotPage().queued?.returned).toEqual([
      { id: "x", text: "X", cause: "cancelled" },
    ]);
  });

  test("Q10 a retried enqueue streams no second queued", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.enqueue("a", "T1", "A");
    expect(t.c.queued()).toHaveLength(1);
    t.gate.release();
  });

  test("Q11 a send-now citing a returned row: it leaves returned with its turn_start", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    t.hosted.sendNow("T2", turn("T1"), [msg("a", "A")]);
    expect(nextAfter(t.c.stream(), (u) => u.type === "turn_start" && u.turnId === "T2")).toEqual({
      type: "queued",
      entries: [],
      returned: [],
    });
    await until(() => t.c.ended("T2"));
    expect(userTexts(t.hosted.snapshotPage().messages)).toEqual(["go", "A"]);
  });

  test("Q12 a compaction keeps the returned rows: the post-barrier snapshot carries them", async () => {
    const t = await blockedT1([call("c1", "block"), say("SUMMARY")]);
    t.hosted.enqueue("b", "T1", "B");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    const epoch = t.hosted.historyCut.epoch;
    await t.hosted.compact();
    expect(t.hosted.historyCut.epoch).not.toBe(epoch);
    expect(t.hosted.snapshotPage().queued).toEqual({
      entries: [],
      returned: [{ id: "b", text: "B", cause: "cancelled" }],
    });
  });

  for (const reason of ["closed", "deleted"] as const) {
    test(`Q13 close(${reason}) with a row pending: returned{ended} precedes session_closed`, async () => {
      const t = await blockedT1();
      t.hosted.enqueue("a", "T1", "A");
      t.hosted.close(reason);
      const stream = t.c.stream();
      expect(stream.slice(-2)).toEqual([
        {
          type: "queued",
          entries: [],
          returned: [{ id: "a", text: "A", cause: "ended" }],
        },
        { type: "session_closed", reason },
      ]);
      t.gate.release();
    });
  }

  test("Q14 reclaim: known ids leave returned (unknown ignored); a second reclaim streams nothing", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.enqueue("b", "T1", "B");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    t.hosted.reclaim(["a", "unknown"]);
    expect(t.c.queued().at(-1)).toEqual({
      entries: [],
      returned: [{ id: "b", text: "B", cause: "cancelled" }],
    });
    const count = t.c.updates.length;
    t.hosted.reclaim(["a"]);
    expect(t.c.updates.length).toBe(count);
  });

  test("Q14b session/reclaim over the wire: acked, idempotent, every client sees it", async () => {
    const t = await blockedT1();
    t.hosted.enqueue("a", "T1", "A");
    t.hosted.cancel();
    t.gate.release();
    await until(() => t.c.ended("T1"));
    const [d, cl] = createChannelPair();
    new Connection(d, t.host);
    const peer = new RpcPeer(cl, {});
    await peer.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await peer.request("session/open", { sessionId: t.hosted.id });
    const params = { sessionId: t.hosted.id, ids: ["a"] };
    expect(await peer.request("session/reclaim", params)).toEqual({});
    expect(await peer.request("session/reclaim", params)).toEqual({});
    expect(t.c.queued().at(-1)).toEqual({ entries: [], returned: [] });
    await expect(peer.request("session/reclaim", { ...params, ids: [] })).rejects.toMatchObject({
      code: -32602,
    });
  });

  test("Q14c session/reclaim of a deleted id → SessionDeleted; of an id never seen → UnknownSession", async () => {
    // Owner F2: an archived session accepts a reclaim; a tombstone never does.
    const t = await blockedT1();
    const [d, cl] = createChannelPair();
    new Connection(d, t.host);
    const peer = new RpcPeer(cl, {});
    await peer.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await peer.request("session/open", { sessionId: t.hosted.id });
    t.host.delete(t.hosted.id);
    t.gate.release();
    await expect(
      peer.request("session/reclaim", { sessionId: t.hosted.id, ids: ["a"] }),
    ).rejects.toMatchObject({ code: DomainErrorCode.SessionDeleted });
    await expect(
      peer.request("session/reclaim", { sessionId: "nope", ids: ["a"] }),
    ).rejects.toMatchObject({ code: DomainErrorCode.UnknownSession });
  });
});
