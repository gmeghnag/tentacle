import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
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
  type PermissionRequestUpdate,
} from "@tentacle/protocol";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import { type Attachment, HostedSession } from "../src/hosted-session.ts";
import {
  type DaemonSessionRecord,
  INTERRUPTED_NOTE,
  NOT_RUN_NOTE,
  RESTART_TURN_END,
  SUBAGENT_INTERRUPTED_NOTE,
  classifyPending,
  parseDaemonRecord,
  reconcileOnReload,
  restoredActivity,
} from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { type RecordStore, SessionPersister } from "../src/session-persister.ts";

// `serve` persists each session (docs/feat/daemon-side-persistence.md). A
// restart is simulated as: the durable record (what reached the "disk") →
// JSON round-trip → a NEW `SessionHost` → `restore`. Each test names the
// mutation that must turn it red (AGENTS §9).

const CWD = "/tmp/persist-work";
const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An in-memory store: `hold` parks saves until `release()`; `durable` = what landed. */
class SpyStore implements RecordStore {
  readonly durable = new Map<string, DaemonSessionRecord>();
  readonly saves: DaemonSessionRecord[] = [];
  readonly removed: string[] = [];
  hold = false;
  fail: Error | null = null;
  private held: Array<() => void> = [];
  save(record: Parameters<RecordStore["save"]>[0]): Promise<void> {
    // A copy at save time, like bytes on a disk.
    const copy = JSON.parse(JSON.stringify(record)) as DaemonSessionRecord;
    this.saves.push(copy);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const land = (): void => {
      if (this.fail) {
        reject(this.fail);
        return;
      }
      this.durable.set(copy.id, copy);
      resolve();
    };
    if (this.hold) {
      this.held.push(land);
    } else {
      queueMicrotask(land);
    }
    return promise;
  }
  release(): void {
    for (const land of this.held.splice(0)) land();
  }
  async remove(id: string): Promise<void> {
    this.removed.push(id);
    this.durable.delete(id);
  }
  async drain(): Promise<void> {}
}

/** Plays one scripted round per model call; counts the calls. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly calls: ChatRequest[] = [];
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push(request);
    for (const event of this.script[this.calls.length - 1] ?? [{ type: "done" }]) yield event;
  }
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});
const text = (delta: string): StreamEvent[] => [{ type: "text", delta }, { type: "done" }];

const env = {} as ExecutionEnvironment;
const anyInput = z.object({}).passthrough();

/** A tool that records each run; `during` runs inside it (to observe the disk mid-run). */
function tool(
  name: string,
  permission: Tool["permission"],
  runs: string[],
  during?: () => Promise<void> | void,
): Tool {
  return {
    name,
    description: name,
    inputSchema: anyInput,
    permission,
    async execute(input) {
      runs.push(`${name}:${JSON.stringify(input)}`);
      await during?.();
      return { content: `${name} ok` };
    },
  };
}

interface Rig {
  host: SessionHost;
  store: SpyStore;
  model: Scripted;
  errors: Error[];
  brokers: PermissionBroker[];
}

function rig(
  script: readonly (readonly StreamEvent[])[],
  tools: (broker: PermissionBroker) => Tool[],
  store: SpyStore = new SpyStore(),
  now: () => number = Date.now,
): Rig {
  const errors: Error[] = [];
  const brokers: PermissionBroker[] = [];
  const model = new Scripted(script);
  const persister = new SessionPersister({
    store,
    cwd: CWD,
    model: "m",
    onError: (e) => errors.push(e),
    now,
  });
  const host = new SessionHost({
    defaultCwd: CWD,
    persister,
    now,
    createAgent: () => {
      const permissions = new PermissionBroker();
      brokers.push(permissions);
      const registry = new ToolRegistry();
      for (const t of tools(permissions)) registry.register(t);
      const agent = new Agent({
        model,
        tools: registry,
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
  return { host, store, model, errors, brokers };
}

/** A client that collects updates and answers permissions on demand. */
function client() {
  const updates: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = { send: (u) => updates.push(u) };
  /** The streamed requests nobody has resolved yet, oldest first. */
  const pending = (): PermissionRequestUpdate[] => {
    const resolved = new Set(
      updates.flatMap((u) => (u.update.type === "permission_resolved" ? [u.update.requestId] : [])),
    );
    return updates.flatMap((u) =>
      u.update.type === "permission_request" && !resolved.has(u.update.requestId) ? [u.update] : [],
    );
  };
  const allow = (hosted: HostedSession): void => {
    const first = pending()[0];
    if (first) hosted.resolvePermission(first.requestId, "allow_once");
  };
  const ended = (turnId: string) =>
    updates.some((u) => u.update.type === "turn_end" && u.update.turnId === turnId);
  return {
    attachment,
    updates,
    get asks() {
      return pending();
    },
    allow,
    ended,
  };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}

const go = [{ type: "text" as const, text: "go" }];

/** What a restarted daemon reads back: the disk bytes, parsed and validated. */
function reread(record: DaemonSessionRecord | undefined): DaemonSessionRecord {
  if (!record) throw new Error("nothing durable");
  const parsed = parseDaemonRecord(JSON.parse(JSON.stringify(record)), (c) => c === CWD);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.record;
}

const shape = (messages: readonly ChatMessage[]): string[] =>
  messages.map((m) =>
    m.role === "assistant" && m.toolCalls
      ? `assistant[${m.toolCalls.map((c) => c.id).join(",")}]`
      : m.role === "tool"
        ? `tool(${m.toolCallId}):${m.content}`
        : `${m.role}:${m.content}`,
  );

describe("daemon persistence: what is written, when", () => {
  test("A1 the turn-start record already holds the prompt and the turn key", async () => {
    // Mutation: persist before `void this.drive(...)` → the prompt is missing.
    const r = rig([text("hi")], () => []);
    r.store.hold = true;
    const { hosted } = r.host.open({ create: true }, client().attachment);
    const before = r.store.saves.length;
    hosted.prompt("T1", go);
    const atStart = r.store.saves[before];
    expect(atStart?.turn?.turnId).toBe("T1");
    expect(atStart?.turns).toEqual([{ turnId: "T1" }]);
    expect(atStart?.messages.at(-1)).toEqual({ role: "user", content: "go" });
    r.store.release();
  });

  test("A2 a restart after turn_end restores the exact history, detached and idle", async () => {
    // Mutation: skip the `finishTurn` write → the final assistant message is missing.
    const r = rig([text("all done")], () => []);
    const c = client();
    const { hosted, created } = r.host.open({ create: true }, c.attachment);
    expect(created).toBe(true);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    await hosted.persisted();
    const before = hosted.snapshotPage().messages;
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.turn).toBeUndefined();

    const r2 = rig([], () => []);
    const restored = r2.host.restore(record);
    expect(restored.snapshotPage().messages).toEqual(before);
    expect(restored.attachedCount).toBe(0);
    expect(restored.running).toBe(false);
    expect(r2.host.get(hosted.id)).toBe(restored);
  });

  test("A3 a restart mid-suspension answers 'Not run' — nothing is denied, nothing runs", async () => {
    // Mutation: label every unanswered call INTERRUPTED → the pending call reads "may have run".
    const runs: string[] = [];
    const tools = () => [tool("look", "none", runs), tool("run", "ask", runs)];
    const r = rig(
      [
        [
          call("c1", "look"),
          call("c2", "run", { n: 2 }),
          call("c3", "run", { n: 3 }),
          { type: "done" },
        ],
      ],
      tools,
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    hosted.enqueue("e1", "T1", "steer-1");
    await hosted.persisted();
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.turn?.pending).toMatchObject({ toolCallId: "c2", tool: "run", resumable: true });
    expect(record.turn?.steering).toEqual(["steer-1"]);
    expect(runs).toEqual(["look:{}"]);

    const r2 = rig([], tools);
    const restored = r2.host.restore(record);
    expect(shape(restored.snapshotPage().messages)).toEqual([
      "user:go",
      "assistant[c1,c2,c3]",
      "tool(c1):look ok",
      `tool(c2):${NOT_RUN_NOTE}`,
      `tool(c3):${NOT_RUN_NOTE}`,
      "user:steer-1",
    ]);
    expect(runs).toEqual(["look:{}"]);
    expect(r2.model.calls).toHaveLength(0);
    expect(restored.running).toBe(false);
  });

  test("A4 a crash mid-tool (no pending) → 'Interrupted' for it, 'Not run' after; nothing re-runs", async () => {
    // Mutation: treat a missing pending as "not run" → a call that ran reads as never started.
    const runs: string[] = [];
    let unpark: () => void = () => {};
    const parked = new Promise<void>((r) => {
      unpark = r;
    });
    let durableMidRun: DaemonSessionRecord | undefined;
    const store = new SpyStore();
    const tools = () => [
      tool("slow", "none", runs, async () => {
        durableMidRun = store.durable.get([...store.durable.keys()][0] ?? "");
        await parked;
      }),
      tool("look", "none", runs),
    ];
    const r = rig([[call("c1", "slow"), call("c2", "look"), { type: "done" }]], tools, store);
    const { hosted } = r.host.open({ create: true }, client().attachment);
    hosted.prompt("T1", go);
    await until(() => durableMidRun !== undefined);
    const record = reread(durableMidRun);
    expect(record.turn?.pending).toBeUndefined();
    const restored = rig([], tools).host.restore(record);
    expect(shape(restored.snapshotPage().messages).slice(1)).toEqual([
      "assistant[c1,c2]",
      `tool(c1):${INTERRUPTED_NOTE}`,
      `tool(c2):${NOT_RUN_NOTE}`,
    ]);
    expect(runs).toEqual(["slow:{}"]);
    unpark();
  });

  test("A5 a sub-agent's pending request reloads as 'sub-agent interrupted' (D4)", async () => {
    // Mutation: drop the tool-name check in classifyPending → the agent_task reads "Not run".
    const runs: string[] = [];
    const tools = (broker: PermissionBroker) => [
      {
        ...tool("agent_task", "none", runs),
        async execute() {
          // A sub-agent shares the parent's broker: its request goes through the same requester.
          await broker.request({ tool: "run", level: "ask", title: "run", input: {} });
          return { content: "report" };
        },
      } satisfies Tool,
    ];
    const r = rig([[call("t1", "agent_task"), { type: "done" }]], tools);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await hosted.persisted();
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.turn?.pending).toMatchObject({ toolCallId: "t1", tool: "run", resumable: false });
    const restored = rig([], tools).host.restore(record);
    expect(shape(restored.snapshotPage().messages).at(-1)).toBe(
      `tool(t1):${SUBAGENT_INTERRUPTED_NOTE}`,
    );
  });

  test("A6 an approved tool never starts while the disk still says 'pending' (D-a)", async () => {
    // Mutation: drop `await this.persisted()` in the requester → the tool sees pending on disk.
    const store = new SpyStore();
    const seen: Array<unknown> = [];
    const runs: string[] = [];
    const r = rig(
      [[call("c1", "run"), { type: "done" }], text("done")],
      () => [
        tool("run", "ask", runs, () => {
          seen.push(store.durable.get([...store.durable.keys()][0] ?? "")?.turn?.pending);
        }),
      ],
      store,
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await hosted.persisted();
    expect(store.durable.get(hosted.id)?.turn?.pending?.toolCallId).toBe("c1");
    // The disk is slow from here: the approval must wait for it.
    store.hold = true;
    c.allow(hosted);
    await tick(5);
    expect(runs).toEqual([]);
    store.hold = false;
    store.release();
    await until(() => c.ended("T1"));
    expect(runs).toEqual(["run:{}"]);
    expect(seen).toEqual([undefined]);
  });

  test("A7 a session/enqueue is acked only once its steer is on disk (D-b)", async () => {
    // Mutation: drop `await hosted.persisted()` in Connection.enqueue → acked before the disk.
    // Mutation: drop the `persist()` in HostedSession.enqueue → the steer never reaches the disk.
    const runs: string[] = [];
    const r = rig([[call("c1", "run"), { type: "done" }]], () => [tool("run", "ask", runs)]);
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, r.host);
    let asked = 0;
    // Nobody answers the `permission_request`: the turn stays suspended.
    const peer = new RpcPeer(clientCh, {
      onNotification: (_method, params) => {
        if ((params as KnownSessionUpdateParams).update.type === "permission_request") asked++;
      },
    });
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    const { sessionId } = (await peer.request("session/open", { create: true })) as {
      sessionId: string;
    };
    await peer.request("session/prompt", { sessionId, turnId: "T1", content: go });
    await until(() => asked === 1);
    await tick(5);
    r.store.hold = true;
    let acked = false;
    void peer
      .request("session/enqueue", { sessionId, id: "e1", turnId: "T1", text: "steer me" })
      .then(() => {
        acked = true;
      });
    await tick(10);
    expect(acked).toBe(false);
    expect(r.store.durable.get(sessionId)?.turn?.steering).toEqual([]);
    r.store.release();
    await until(() => acked);
    expect(r.store.durable.get(sessionId)?.turn?.steering).toEqual(["steer me"]);
    expect(r.store.durable.get(sessionId)?.enqueueIds).toEqual(["e1"]);
  });

  test("P4 a never-landing store adds no macrotask between the last steering drain and the turn's end", async () => {
    // Mutation: make `drive` `await this.persisted()` before `finishTurn` → running at the next macrotask.
    const store = new SpyStore();
    store.hold = true; // nothing ever lands
    const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
    const agent = new Agent({ model: new Scripted([text("hi")]), tools: new ToolRegistry(), env });
    const runMessages = agent.runMessages.bind(agent);
    const atNextMacrotask: { running: boolean; ended: boolean }[] = [];
    const streamed: KnownSessionUpdateParams[] = [];
    const hosted = new HostedSession(
      "s1",
      new Session(agent),
      new PermissionBroker(),
      undefined,
      {},
      undefined,
      Date.now,
      { persister },
    );
    hosted.attach({
      send: (p) => streamed.push(p),
    });
    const ended = () => streamed.some((p) => p.update.type === "turn_end");
    agent.runMessages = (messages, sessionId, signal, drain) =>
      runMessages(messages, sessionId, signal, () => {
        setTimeout(() => atNextMacrotask.push({ running: hosted.running, ended: ended() }), 0);
        return drain?.() ?? [];
      });
    hosted.prompt("t1", go);
    await tick(5);
    expect(atNextMacrotask.length).toBeGreaterThan(0);
    expect(atNextMacrotask.at(-1)).toEqual({ running: false, ended: true });
    // And the turn-end write WAS scheduled (it just never lands).
    expect(store.saves.at(-1)?.turn).toBeUndefined();
    expect(store.saves.at(-1)?.turns).toEqual([{ turnId: "t1", end: { stopReason: "end_turn" } }]);
  });
});

describe("daemon persistence: after a restart", () => {
  test("A8 a retried prompt{turnId} gets the cached restart end and never runs again", async () => {
    // Mutation: do not persist `turns` → the retry starts a second turn (model called).
    const runs: string[] = [];
    const tools = () => [tool("run", "ask", runs)];
    const r = rig([[call("c1", "run"), { type: "done" }]], tools);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await hosted.persisted();
    const r2 = rig([text("should not run")], tools);
    const restored = r2.host.restore(reread(r.store.durable.get(hosted.id)));
    expect(restored.prompt("T1", go)).toEqual({ turnId: "T1", ended: RESTART_TURN_END });
    expect(RESTART_TURN_END.error?.code).toBe(DomainErrorCode.DaemonRestarted);
    expect(r2.model.calls).toHaveLength(0);
    // An enqueue id seen before the restart stays a no-op success (never NoTurnRunning).
    hosted.enqueue("e1", "T1", "x");
    await hosted.persisted();
    const r3 = rig([], tools);
    const again = r3.host.restore(reread(r.store.durable.get(hosted.id)));
    expect(() => again.enqueue("e1", "T1", "x")).not.toThrow();
  });

  test("P8 a pre-restart `since` against the restored session → resync (new epoch)", async () => {
    // Mutation: reuse the persisted epoch → the old token would replay across the restart.
    const r = rig([text("hi")], () => []);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    await hosted.persisted();
    const since = hosted.historyCut;
    const restored = rig([], () => []).host.restore(reread(r.store.durable.get(hosted.id)));
    const outcome = restored.attach(client().attachment, since);
    expect(outcome.resync).toBe(true);
    expect(outcome.epoch).not.toBe(since.epoch);
  });

  test("A9 close (and the reaper's close) deletes the record; nothing is written after", async () => {
    // Mutation: drop `persister.remove` in SessionHost.close → the file outlives the session.
    let now = 1_000_000;
    const r = rig(
      [text("hi")],
      () => [],
      new SpyStore(),
      () => now,
    );
    const c = client();
    const a = r.host.open({ create: true }, c.attachment).hosted;
    a.prompt("T1", go);
    await until(() => c.ended("T1"));
    await a.persisted();
    const saves = r.store.saves.length;
    r.host.close(a.id);
    await tick();
    expect(r.store.removed).toEqual([a.id]);
    expect(r.store.durable.has(a.id)).toBe(false);
    expect(r.store.saves.length).toBe(saves);

    const d = client();
    const b = r.host.open({ create: true }, d.attachment).hosted;
    b.detach(d.attachment);
    now += 10_000;
    expect(r.host.reapExpired({ idleTtlMs: 5_000 }).map((e) => e.id)).toEqual([b.id]);
    await tick();
    expect(r.store.removed).toEqual([a.id, b.id]);
  });

  test("A10 a failing store is reported, never thrown or unhandled; the turn completes", async () => {
    // Mutation: drop the `.catch` on the save in `schedule` → an unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const r = rig([text("hi")], () => []);
      r.store.fail = new Error("couldn't write x.json: no space left on device (ENOSPC)");
      const c = client();
      const { hosted } = r.host.open({ create: true }, c.attachment);
      hosted.prompt("T1", go);
      await until(() => c.ended("T1"));
      await hosted.persisted();
      await tick(5);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]?.message).toContain("ENOSPC");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a blocked id (its file could not be loaded) is never written or removed", async () => {
    // Mutation: ignore `blocked` in `schedule` → the unreadable file is overwritten.
    const store = new SpyStore();
    const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
    persister.block("bad");
    persister.schedule("bad", () => ({
      id: "bad",
      createdAt: 1,
      lastActiveAt: 1,
      messages: [],
      turns: [],
      enqueueIds: [],
    }));
    persister.remove("bad");
    await tick();
    expect(store.saves).toEqual([]);
    expect(store.removed).toEqual([]);
  });

  test("a host without a persister (pod daemon, worker) writes nothing", async () => {
    const host = new SessionHost({
      defaultCwd: CWD,
      createAgent: () => {
        const permissions = new PermissionBroker();
        return {
          agent: new Agent({ model: new Scripted([text("hi")]), tools: new ToolRegistry(), env }),
          permissions,
        };
      },
    });
    const c = client();
    const { hosted } = host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    await expect(hosted.persisted()).resolves.toBeUndefined();
  });
});

describe("daemon persistence: review fixes (the TTL clock, compaction, shutdown)", () => {
  test("R1 a detach is written: the restored TTL clock is the detach, not the last turn", async () => {
    // Mutation: drop the `persist()` in removeAttachment → the restored session is reaped at once.
    let now = 1_000;
    const r = rig(
      [text("hi")],
      () => [],
      new SpyStore(),
      () => now,
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    now = 50_000;
    hosted.detach(c.attachment);
    await hosted.persisted();
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.lastActiveAt).toBe(50_000);
    // The live daemon and the restarted one agree: not idle for 10 s yet at 55 s.
    now = 55_000;
    const r2 = rig(
      [],
      () => [],
      new SpyStore(),
      () => now,
    );
    r2.host.restore(record);
    expect(r2.host.reapExpired({ idleTtlMs: 10_000 })).toEqual([]);
    expect(r.host.reapExpired({ idleTtlMs: 10_000 })).toEqual([]);
  });

  test("R2 a compaction is written: the record holds the compacted history and the clock after it", async () => {
    // Mutation: drop the `persist()` in historyReplaced (or after compaction's finally) → stale record.
    let now = 1_000;
    const r = rig(
      [text("hi"), text("SUMMARY")],
      () => [],
      new SpyStore(),
      () => now,
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    now = 9_000;
    await hosted.compact();
    await hosted.persisted();
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.messages).toEqual(hosted.snapshotPage().messages);
    expect(JSON.stringify(record.messages)).toContain("SUMMARY");
    expect(record.lastActiveAt).toBe(9_000);
  });

  test("R3 restore takes the TTL clock from restoredActivity (mid-turn record → now)", () => {
    // Mutation: restore with `record.lastActiveAt` → a long-suspended session is reaped on reload.
    const r = rig([], () => []);
    const restored = r.host.restore(
      reread({
        id: "mid",
        cwd: CWD,
        model: "m",
        createdAt: 1,
        updatedAt: 2,
        title: "t",
        messages: [{ role: "user", content: "go" }],
        kind: "tentacle.daemon-session",
        schemaVersion: 1,
        lastActiveAt: 5,
        turns: [{ turnId: "T" }],
        enqueueIds: [],
        turn: { turnId: "T", steering: [] },
      }),
    );
    expect(restored.liveness().lastActiveAt).toBeGreaterThan(1_000_000);
  });

  test("R4 after stop() nothing more is written (shutdown)", async () => {
    // Mutation: ignore `stopped` in `schedule` → a write after the drain.
    const store = new SpyStore();
    const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
    await persister.stop();
    persister.schedule("s", () => ({
      id: "s",
      createdAt: 1,
      lastActiveAt: 1,
      messages: [],
      turns: [],
      enqueueIds: [],
    }));
    expect(store.saves).toEqual([]);
  });

  test("R5 a session the daemon cannot persist says so ONCE (blocked file, unsafe id)", () => {
    // Mutation: report on every schedule → one line per committed boundary.
    const errors: Error[] = [];
    const persister = new SessionPersister({
      store: new SpyStore(),
      cwd: CWD,
      model: "m",
      onError: (e) => errors.push(e),
    });
    const state = (id: string) => () => ({
      id,
      createdAt: 1,
      lastActiveAt: 1,
      messages: [],
      turns: [],
      enqueueIds: [],
    });
    persister.block("bad");
    for (let i = 0; i < 3; i++) {
      persister.schedule("bad", state("bad"));
      persister.schedule("../evil", state("../evil"));
    }
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/session bad is not persisted: its file could not be loaded/),
      expect.stringMatching(/session "\.\.\/evil" is not persisted: not a valid file name/),
    ]);
  });
});

describe("persisted-session (pure)", () => {
  const base = (over: Partial<DaemonSessionRecord> = {}): DaemonSessionRecord => ({
    id: "s",
    cwd: CWD,
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    messages: [],
    kind: "tentacle.daemon-session",
    schemaVersion: 1,
    lastActiveAt: 2,
    turns: [],
    enqueueIds: [],
    ...over,
  });

  test("parseDaemonRecord rejects another kind, another version, another project", () => {
    expect(parseDaemonRecord(base(), (c) => c === CWD).ok).toBe(true);
    const reason = (r: unknown, cwd = CWD) => {
      const p = parseDaemonRecord(r as DaemonSessionRecord, (c) => c === cwd);
      return p.ok ? "ok" : p.reason;
    };
    expect(reason({ ...base(), kind: undefined })).toMatch(/not a daemon session record/);
    expect(reason({ ...base(), schemaVersion: 2 })).toMatch(/unsupported record version 2/);
    expect(reason(base(), "/elsewhere")).toMatch(/another project/);
    expect(reason({ ...base(), turns: [{ turnId: "x", end: { stopReason: "nope" } }] })).toMatch(
      /invalid end/,
    );
    expect(reason({ ...base(), turn: { turnId: "x", steering: [1] } })).toMatch(/"turn"/);
  });

  test("classifyPending: true only for the current call's own, next-in-line request (A14)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "look", arguments: "{}" },
          { id: "c2", name: "run", arguments: "{}" },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ];
    expect(classifyPending(messages, "c2", "run", "run")).toBe(true);
    expect(classifyPending(messages, "c2", "agent_task", "run")).toBe(false); // sub-agent shape
    expect(classifyPending(messages, "c1", "look", "look")).toBe(false); // already answered
    expect(classifyPending(messages.slice(0, 2), "c2", "run", "run")).toBe(false); // c1 unanswered
  });

  test("P7 pinned: agent_task never asks for permission itself", () => {
    expect(
      createTaskTool(async () => ({ report: "", toolUses: 0, stopReason: "end_turn" }), [])
        .permission,
    ).toBe("none");
  });

  test("reconcile: a turn without tool calls keeps its history; steers become user messages", () => {
    const r = reconcileOnReload(
      base({
        messages: [{ role: "user", content: "go" }],
        turns: [{ turnId: "T" }],
        turn: { turnId: "T", steering: ["s1", "s2"] },
      }),
    );
    expect(shape(r.messages)).toEqual(["user:go", "user:s1", "user:s2"]);
    expect(r.turns).toEqual([{ turnId: "T", end: RESTART_TURN_END }]);
  });

  test("reconcile: a pending id that is not the first unanswered call → 'Interrupted' (conservative)", () => {
    const r = reconcileOnReload(
      base({
        messages: [
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "x", arguments: "{}" }] },
        ],
        turns: [{ turnId: "T" }],
        turn: {
          turnId: "T",
          steering: [],
          pending: { toolCallId: "zz", tool: "x", resumable: true, requestedAt: 1 },
        },
      }),
    );
    expect(shape(r.messages).at(-1)).toBe(`tool(c1):${INTERRUPTED_NOTE}`);
  });

  test("restoredActivity: idle → the recorded clock; mid-turn → now (keep it longer)", () => {
    expect(restoredActivity(base({ lastActiveAt: 5 }), 100)).toBe(5);
    expect(
      restoredActivity(base({ lastActiveAt: 5, turn: { turnId: "T", steering: [] } }), 100),
    ).toBe(100);
  });
});
