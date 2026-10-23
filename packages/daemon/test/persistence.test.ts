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
import { type Attachment, HostedSession, untilAborted } from "../src/hosted-session.ts";
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

/**
 * Run `[c1 look (none), c2 run (ask), c3 run (ask)]` until the turn waits on
 * c2, enqueue `steer-1`, and return what a restarted daemon would read back.
 */
async function suspendedOnC2(
  runs: string[],
  tools: (broker: PermissionBroker) => Tool[],
): Promise<{ record: DaemonSessionRecord; oldId: string }> {
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
  expect(runs).toEqual(["look:{}"]);
  return { record: reread(r.store.durable.get(hosted.id)), oldId: c.asks[0]?.requestId ?? "" };
}

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

  test("B1 a restart mid-suspension RESUMES the turn: asked again (new id), each call runs once", async () => {
    // Mutation: no `resume` branch in reconcileOnReload → "Not run", idle, never asked again.
    const runs: string[] = [];
    const tools = () => [tool("look", "none", runs), tool("run", "ask", runs)];
    const { record, oldId } = await suspendedOnC2(runs, tools);
    expect(record.turn?.pending).toMatchObject({ toolCallId: "c2", tool: "run", resumable: true });
    expect(record.turn?.steering).toEqual(["steer-1"]);

    const r2 = rig([text("all done")], tools);
    const restored = r2.host.restore(record);
    expect(restored.running).toBe(true);
    const page = restored.snapshotPage();
    expect(page.turn).toEqual({ turnId: "T1" });
    expect(shape(page.messages)).toEqual(["user:go", "assistant[c1,c2,c3]", "tool(c1):look ok"]);
    // A retry of the client's prompt joins the running turn (no restart end any more).
    expect(restored.prompt("T1", go)).toEqual({ turnId: "T1" });

    const c = client();
    restored.attach(c.attachment);
    await until(() => c.asks.length === 1);
    const newId = c.asks[0]?.requestId;
    expect(newId).not.toBe(oldId);
    expect(c.updates.some((u) => u.update.type === "turn_start")).toBe(false);
    // A client attaching later gets the same request from the replay.
    const late = client();
    restored.attach(late.attachment);
    expect(late.asks.map((a) => a.requestId)).toEqual([newId ?? ""]);
    // The answer to the pre-restart request does not bind to the new one.
    let code: number | undefined;
    try {
      restored.resolvePermission(oldId, "allow_once");
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.PermissionNotPending);
    expect(runs).toEqual(["look:{}"]);

    c.allow(restored); // c2
    await until(() => runs.length === 2 && c.asks.length === 1);
    c.allow(restored); // c3, asked in its turn as it would have been
    await until(() => c.ended("T1"));
    expect(runs).toEqual(["look:{}", 'run:{"n":2}', 'run:{"n":3}']);
    expect(r2.model.calls).toHaveLength(1);
    expect(shape(restored.snapshotPage().messages)).toEqual([
      "user:go",
      "assistant[c1,c2,c3]",
      "tool(c1):look ok",
      "tool(c2):run ok",
      "tool(c3):run ok",
      "user:steer-1",
      "assistant:all done",
    ]);
    const end = c.updates.find((u) => u.update.type === "turn_end")?.update;
    expect(end).toMatchObject({ turnId: "T1", stopReason: "end_turn" });
    expect(restored.prompt("T1", go)).toEqual({ turnId: "T1", ended: { stopReason: "end_turn" } });
    await restored.persisted();
    expect(r2.store.durable.get(restored.id)?.turn).toBeUndefined();
  });

  test("B2 the restored session's FIRST write still says 'suspended on c2' (the restore window)", async () => {
    // Mutation: seed the resumed turn after the constructor's write → that write has no
    // `turn` over a history with unanswered calls (a crash then reloads it idle and broken).
    const runs: string[] = [];
    const tools = () => [tool("look", "none", runs), tool("run", "ask", runs)];
    const { record } = await suspendedOnC2(runs, tools);
    const store = new SpyStore();
    store.hold = true;
    rig([], tools, store).host.restore(record);
    const first = store.saves[0];
    expect(first?.turn).toEqual({
      turnId: "T1",
      steering: ["steer-1"],
      ...(record.turn?.pending ? { pending: record.turn.pending } : {}),
    });
    expect(first?.messages).toEqual(record.messages);
    // And that write, reloaded, resumes again (a second restart).
    const again = rig([], tools).host.restore(reread(first));
    expect(again.running).toBe(true);
  });

  test("B3 a permission_request is streamed only once its suspension is on disk", async () => {
    // Mutation: emit the request before `await this.persisted()` → a client sees an ask a crash would lose.
    const store = new SpyStore();
    const runs: string[] = [];
    const durableAtEmit: unknown[] = [];
    const updates: KnownSessionUpdateParams[] = [];
    const r2 = rig(
      [[call("c1", "run"), { type: "done" }], text("ok")],
      () => [tool("run", "ask", runs)],
      store,
    );
    const { hosted } = r2.host.open(
      { create: true },
      {
        send: (u) => {
          updates.push(u);
          if (u.update.type === "permission_request") {
            durableAtEmit.push(store.durable.get(u.sessionId)?.turn?.pending?.toolCallId);
          }
        },
      },
    );
    await hosted.persisted();
    store.hold = true;
    hosted.prompt("T1", go);
    await until(() => store.saves.some((s) => s.turn?.pending !== undefined));
    await tick(10);
    expect(updates.some((u) => u.update.type === "permission_request")).toBe(false);
    store.hold = false;
    store.release();
    await until(() => durableAtEmit.length === 1);
    expect(durableAtEmit).toEqual(["c1"]);
  });

  test("B3b a cancel while the ask is still being written: the ask was never shown, nothing is resolved", async () => {
    // Mutation: emit `permission_resolved` for an ask nobody was shown → a resolution
    // for an id no client ever received.
    const store = new SpyStore();
    const runs: string[] = [];
    const r = rig([[call("c1", "run"), { type: "done" }]], () => [tool("run", "ask", runs)], store);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    await hosted.persisted();
    store.hold = true;
    hosted.prompt("T1", go);
    await until(() => store.saves.some((s) => s.turn?.pending !== undefined));
    hosted.cancel();
    store.hold = false;
    store.release();
    await until(() => c.ended("T1"));
    await tick(5);
    const types = c.updates.map((u) => u.update.type);
    expect(types).not.toContain("permission_request");
    expect(types).not.toContain("permission_resolved");
    expect(c.updates.find((u) => u.update.type === "turn_end")?.update).toMatchObject({
      stopReason: "cancelled",
    });
    expect(runs).toEqual([]);
  });

  // A hung disk (a write that never settles) must never trap a cancel
  // (docs/fix/cancel-hung-disk.md). Each runs to `turn_end{cancelled}` with the
  // store still held: nothing is released, ever.
  // Mutation: `await this.persisted()` in the gate without the abort race → no turn_end.
  async function cancelOnHungDisk(
    hangAt: "before-ask" | "after-shown" | "after-allow" | "after-deny",
  ): Promise<{
    c: ReturnType<typeof client>;
    runs: string[];
    store: SpyStore;
    hosted: HostedSession;
  }> {
    const store = new SpyStore();
    const runs: string[] = [];
    const r = rig(
      [[call("c1", "run"), { type: "done" }], text("after")],
      () => [tool("run", "ask", runs)],
      store,
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    await hosted.persisted();
    if (hangAt === "before-ask") {
      store.hold = true;
      hosted.prompt("T1", go);
      await until(() => store.saves.some((s) => s.turn?.pending !== undefined));
    } else {
      hosted.prompt("T1", go);
      await until(() => c.asks.length === 1);
      store.hold = true;
      const ask = c.asks[0];
      if (hangAt !== "after-shown" && ask) {
        hosted.resolvePermission(
          ask.requestId,
          hangAt === "after-allow" ? "allow_once" : "reject_once",
        );
        // The gate is now parked on the clear-before-run write, which never lands.
        await until(() =>
          store.saves.some((s) => s.turn !== undefined && s.turn.pending === undefined),
        );
        await tick(5);
        expect(c.ended("T1")).toBe(false);
      }
    }
    hosted.cancel();
    await until(() => c.ended("T1"));
    return { c, runs, store, hosted };
  }

  const endOf = (c: ReturnType<typeof client>) =>
    c.updates.find((u) => u.update.type === "turn_end")?.update;

  test("H1 a hung disk before the ask is shown: cancel still ends the turn (never shown, never resolved)", async () => {
    const { c, runs } = await cancelOnHungDisk("before-ask");
    expect(endOf(c)).toMatchObject({ stopReason: "cancelled" });
    const types = c.updates.map((u) => u.update.type);
    expect(types).not.toContain("permission_request");
    expect(types).not.toContain("permission_resolved");
    expect(runs).toEqual([]);
  });

  test("H2 a hung disk while the ask is shown: cancel resolves it as cancelled and ends the turn", async () => {
    const { c, runs } = await cancelOnHungDisk("after-shown");
    expect(endOf(c)).toMatchObject({ stopReason: "cancelled" });
    expect(c.updates.find((u) => u.update.type === "permission_resolved")?.update).toMatchObject({
      outcome: { outcome: "cancelled" },
    });
    expect(runs).toEqual([]);
  });

  test("H3 approved, the clear never lands, then cancel: the turn ends and the tool NEVER runs", async () => {
    // Mutations: drop the abort check after `authorize` in agent.ts `runTool` → the tool
    // runs while the disk still says 'pending' (a reload would run it again); skip the
    // clear-before-run wait → the turn ends before the cancel (also A6/B4).
    const { c, runs, store, hosted } = await cancelOnHungDisk("after-allow");
    expect(endOf(c)).toMatchObject({ stopReason: "cancelled" });
    expect(runs).toEqual([]);
    // The disk comes back later: still nothing runs, and the turn does not end twice.
    store.hold = false;
    store.release();
    await hosted.persisted();
    await tick(5);
    expect(runs).toEqual([]);
    expect(c.updates.filter((u) => u.update.type === "turn_end")).toHaveLength(1);
    const tools = hosted.snapshotPage().messages.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.content)).toEqual(["Cancelled by the user before this tool ran."]);
  });

  test("H4 denied, the clear never lands, then cancel: the turn ends cancelled", async () => {
    const { c, runs } = await cancelOnHungDisk("after-deny");
    expect(endOf(c)).toMatchObject({ stopReason: "cancelled" });
    expect(runs).toEqual([]);
  });

  test("B3c a failed write before the ask: logged, and the request is shown anyway (no daemon decision)", async () => {
    // Mutation: show the request only when its write succeeded → the turn waits on a
    // request nobody can see, a decision made by a disk.
    const store = new SpyStore();
    const runs: string[] = [];
    const r = rig(
      [[call("c1", "run"), { type: "done" }], text("ok")],
      () => [tool("run", "ask", runs)],
      store,
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    await hosted.persisted();
    store.fail = new Error("disk full");
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    expect(r.errors.length).toBeGreaterThan(0);
    store.fail = null;
    c.allow(hosted);
    await until(() => c.ended("T1"));
    expect(runs).toEqual(["run:{}"]);
  });

  test("B8 a resumed turn whose key is missing still frees the slot when it ends (never held forever)", async () => {
    // Mutation: drop `this.turns.set(resume.turnId, {})` → finishTurn finds no key and
    // the session stays busy forever (no prompt, no compact, never reaped).
    const runs: string[] = [];
    const tools = () => [tool("look", "none", runs), tool("run", "ask", runs)];
    const { record } = await suspendedOnC2(runs, tools);
    const resume = reconcileOnReload(record).resume;
    if (!resume) throw new Error("expected a resumable record");
    const registry = new ToolRegistry();
    for (const t of tools()) registry.register(t);
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model: new Scripted([]),
      tools: registry,
      env,
      requestPermission: (req) => permissions.request(req),
    });
    const persister = new SessionPersister({
      store: new SpyStore(),
      cwd: CWD,
      model: "m",
      onError: () => {},
    });
    const hosted = new HostedSession(
      record.id,
      new Session(agent, record.id, { messages: record.messages }),
      permissions,
      undefined,
      {},
      undefined,
      Date.now,
      {
        persister,
        restored: {
          createdAt: 1,
          lastActiveAt: 1,
          lastChangeAt: 1,
          turns: [],
          enqueueIds: [],
          resume,
          cutShort: true,
        },
      },
    );
    expect(hosted.running).toBe(true);
    hosted.cancel();
    await until(() => !hosted.running);
    expect(runs).toEqual(["look:{}"]);
  });

  test("B4 a crash after an approval, mid-tool: reloaded as 'Interrupted' — never asked or run again", async () => {
    // Mutation: drop the durable clear before the run → the mid-run record still says
    // pending → the reload asks again and the tool can run twice.
    const runs: string[] = [];
    let unpark: () => void = () => {};
    const parked = new Promise<void>((r) => {
      unpark = r;
    });
    let midRun: DaemonSessionRecord | undefined;
    const store = new SpyStore();
    const tools = () => [
      tool("run", "ask", runs, async () => {
        midRun = store.durable.get([...store.durable.keys()][0] ?? "");
        await parked;
      }),
    ];
    const r = rig([[call("c1", "run"), { type: "done" }]], tools, store);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    // A slow disk at the approval: the run must still wait for the clear.
    store.hold = true;
    c.allow(hosted);
    await tick(5);
    store.hold = false;
    store.release();
    await until(() => midRun !== undefined);
    const restored = rig([], tools).host.restore(reread(midRun));
    const c2 = client();
    restored.attach(c2.attachment);
    await tick(5);
    expect(restored.running).toBe(false);
    expect(c2.asks).toHaveLength(0);
    expect(shape(restored.snapshotPage().messages).at(-1)).toBe(`tool(c1):${INTERRUPTED_NOTE}`);
    expect(runs).toEqual(["run:{}"]);
    unpark();
  });

  test("B5 a resumed turn cancelled before its re-ask: no write says 'pending' on an answered call", async () => {
    // Mutation: drop the `pending` clear at history_commit → the commit after tool(c2) still says pending c2.
    const runs: string[] = [];
    const tools = () => [tool("look", "none", runs), tool("run", "ask", runs)];
    const { record } = await suspendedOnC2(runs, tools);
    const r2 = rig([], tools);
    const restored = r2.host.restore(record);
    const c = client();
    restored.attach(c.attachment);
    restored.cancel();
    await until(() => !restored.running);
    await restored.persisted();
    expect(c.updates.some((u) => u.update.type === "permission_request")).toBe(false);
    expect(c.updates.find((u) => u.update.type === "turn_end")?.update).toMatchObject({
      turnId: "T1",
      stopReason: "cancelled",
    });
    const answeredC2 = r2.store.saves.filter(
      (s) => s.turn && s.messages.some((m) => m.role === "tool" && m.toolCallId === "c2"),
    );
    expect(answeredC2.length).toBeGreaterThan(0);
    expect(answeredC2.map((s) => s.turn?.pending)).toEqual(answeredC2.map(() => undefined));
    expect(shape(restored.snapshotPage().messages).slice(3)).toEqual([
      "tool(c2):Cancelled by the user before this tool ran.",
      "tool(c3):Cancelled by the user before this tool ran.",
    ]);
    // As in an uninterrupted turn, a steer still queued at a cancel is dropped
    // (by design: docs/fix/steering-over-rpc.md — the user cancelled).
    expect(runs).toEqual(["look:{}"]);
    expect(r2.model.calls).toHaveLength(0);
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
  test("A8 a retried prompt{turnId} of a turn closed by the restart gets its restart end, never runs again", async () => {
    // Mutation: do not persist `turns` → the retry starts a second turn (model called).
    const runs: string[] = [];
    let unpark: () => void = () => {};
    const parked = new Promise<void>((r) => {
      unpark = r;
    });
    // Crashed mid-tool (not resumable): the restart closes the turn.
    const tools = () => [tool("slow", "none", runs, () => parked)];
    const r = rig([[call("c1", "slow"), { type: "done" }]], tools);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => runs.length === 1);
    hosted.enqueue("e1", "T1", "x");
    await hosted.persisted();
    const r2 = rig([text("should not run")], tools);
    const restored = r2.host.restore(reread(r.store.durable.get(hosted.id)));
    expect(restored.running).toBe(false);
    expect(restored.prompt("T1", go)).toEqual({ turnId: "T1", ended: RESTART_TURN_END });
    expect(RESTART_TURN_END.error?.code).toBe(DomainErrorCode.DaemonRestarted);
    expect(r2.model.calls).toHaveLength(0);
    // An enqueue id seen before the restart stays a no-op success (never NoTurnRunning).
    expect(() => restored.enqueue("e1", "T1", "x")).not.toThrow();
    unpark();
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
      lastChangeAt: 1,
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
      lastChangeAt: 1,
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
      lastChangeAt: 1,
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

describe("daemon persistence: the record's updatedAt is the last conversation change (session/list)", () => {
  const idleRecord = (over: Partial<DaemonSessionRecord> = {}): DaemonSessionRecord =>
    reread({
      id: "back",
      cwd: CWD,
      model: "m",
      createdAt: 1,
      updatedAt: 7,
      title: "t",
      messages: [{ role: "user", content: "go" }],
      kind: "tentacle.daemon-session",
      schemaVersion: 1,
      lastActiveAt: 7,
      turns: [],
      enqueueIds: [],
      ...over,
    });

  test("R7 the detach write carries the turn's end, not the detach time", async () => {
    // Mutations M7 (detach stamps lastChangeAt), M8 (persister writes its clock) → red.
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
    expect(record.updatedAt).toBe(1_000);
    expect(record.lastActiveAt).toBe(50_000);
  });

  test("R8 a restart re-stamps nothing: the reload write keeps the record's updatedAt", async () => {
    // Mutations M8, M9 (restore ignores record.updatedAt) → red.
    const r = rig(
      [],
      () => [],
      new SpyStore(),
      () => 100,
    );
    const hosted = r.host.restore(idleRecord());
    await hosted.persisted();
    expect(reread(r.store.durable.get("back")).updatedAt).toBe(7);
    expect(r.host.list({}).sessions.map((s) => s.updatedAt)).toEqual([7]);
  });

  test("R9 a record cut mid-turn is reconciled at reload: a change at the restart", async () => {
    const r = rig(
      [],
      () => [],
      new SpyStore(),
      () => 100,
    );
    const hosted = r.host.restore(
      idleRecord({ turns: [{ turnId: "T" }], turn: { turnId: "T", steering: [] } }),
    );
    expect(hosted.running).toBe(false);
    await hosted.persisted();
    expect(reread(r.store.durable.get("back")).updatedAt).toBe(100);
    expect(r.host.list({}).sessions.map((s) => s.updatedAt)).toEqual([100]);
  });
});

describe("untilAborted (the gate's abortable disk wait)", () => {
  // Mutation: no `removeEventListener` in `finish` → one listener leaks per approved ask.
  const spied = (c: AbortController) => {
    const live = new Set<unknown>();
    const add = c.signal.addEventListener.bind(c.signal);
    const remove = c.signal.removeEventListener.bind(c.signal);
    c.signal.addEventListener = ((t: string, l: EventListener, o?: AddEventListenerOptions) => {
      live.add(l);
      add(t, l, o);
    }) as AbortSignal["addEventListener"];
    c.signal.removeEventListener = ((t: string, l: EventListener) => {
      live.delete(l);
      remove(t, l);
    }) as AbortSignal["removeEventListener"];
    return live;
  };

  test("settles with the write; the abort listener is gone", async () => {
    const c = new AbortController();
    const live = spied(c);
    const write = Promise.withResolvers<void>();
    let done = false;
    const wait = untilAborted(write.promise, c.signal).then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    expect(live.size).toBe(1);
    write.resolve();
    await wait;
    expect(live.size).toBe(0);
  });

  test("settles on the abort while the write never does; a rejected write never throws", async () => {
    const c = new AbortController();
    const live = spied(c);
    const wait = untilAborted(new Promise<void>(() => {}), c.signal);
    c.abort();
    await wait;
    expect(live.size).toBe(0);
    await untilAborted(Promise.reject(new Error("disk")), new AbortController().signal);
    // Already aborted: at once, no listener added.
    await untilAborted(new Promise<void>(() => {}), c.signal);
    expect(live.size).toBe(0);
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

  test("parseDaemonRecord refuses wire stamps that are not non-negative safe integers (Review finding 2)", () => {
    // Mutation: drop the integer check → a record with `updatedAt: 1.5` loads, and its
    // `session/list` entry makes the client reject the WHOLE page.
    const reason = (over: Partial<DaemonSessionRecord>) => {
      const p = parseDaemonRecord(base(over), (c) => c === CWD);
      return p.ok ? "ok" : p.reason;
    };
    expect(reason({})).toBe("ok");
    expect(reason({ createdAt: 0, updatedAt: Number.MAX_SAFE_INTEGER })).toBe("ok");
    for (const bad of [1.5, -1, 2 ** 53]) {
      expect(reason({ updatedAt: bad })).toBe('"updatedAt" is not a non-negative integer');
      expect(reason({ createdAt: bad })).toBe('"createdAt" is not a non-negative integer');
    }
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

  test("reconcile: a compacted history's skill round is left as is (idle, or a later turn cut short)", () => {
    // docs/feat/skills-compaction.md: compaction appends a fully answered
    // `skill` round after the summary. Reload must not treat it as a turn's
    // unanswered calls.
    const compacted: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "Summary of the earlier conversation …" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "skill", arguments: '{"name":"a"}' }],
      },
      { role: "tool", content: '<skill_content name="a">\nbody', toolCallId: "c1" },
    ];
    const idle = reconcileOnReload(base({ messages: compacted }));
    expect(idle.messages).toEqual(compacted);
    // The next turn died before its first model reply: only its prompt is in.
    const cut = reconcileOnReload(
      base({
        messages: [...compacted, { role: "user", content: "next" }],
        turns: [{ turnId: "T" }],
        turn: { turnId: "T", steering: [] },
      }),
    );
    expect(cut.messages).toEqual([...compacted, { role: "user", content: "next" }]);
    expect(cut.turns).toEqual([{ turnId: "T", end: RESTART_TURN_END }]);
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

  test("B6 reconcile resumes only its own call's suspension with an open turn key; else closes it", () => {
    // Mutation: drop the turn-key check in resumableTurn → a turn with no (or an ended) key
    // resumes, and its end could never be recorded (the slot held forever).
    const pending = { toolCallId: "c2", tool: "run", resumable: true, requestedAt: 1 };
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
    const record = (over: Partial<DaemonSessionRecord>) =>
      base({
        messages,
        turns: [{ turnId: "T" }],
        turn: { turnId: "T", steering: ["s1"], pending },
        ...over,
      });
    const ok = reconcileOnReload(record({}));
    expect(ok.resume).toEqual({ turnId: "T", toolCallId: "c2", steering: ["s1"], pending });
    expect(ok.messages).toEqual(messages); // untouched: no notes, no steers appended
    expect(ok.turns).toEqual([{ turnId: "T" }]);

    const closed = (r: ReturnType<typeof reconcileOnReload>) => ({
      resume: r.resume,
      last: shape(r.messages).slice(-2),
    });
    const notRun = { resume: undefined, last: [`tool(c2):${NOT_RUN_NOTE}`, "user:s1"] };
    expect(closed(reconcileOnReload(record({ turns: [] })))).toEqual(notRun);
    expect(
      closed(
        reconcileOnReload(record({ turns: [{ turnId: "T", end: { stopReason: "end_turn" } }] })),
      ),
    ).toEqual(notRun);
    // The asking tool is not the call's (a sub-agent shape recorded as resumable).
    expect(
      closed(
        reconcileOnReload(
          record({ turn: { turnId: "T", steering: ["s1"], pending: { ...pending, tool: "x" } } }),
        ),
      ),
    ).toEqual(notRun);
    // Not resumable (a sub-agent's): the D4 note, never resumed.
    expect(
      reconcileOnReload(
        record({
          turn: { turnId: "T", steering: [], pending: { ...pending, resumable: false } },
        }),
      ).resume,
    ).toBeUndefined();
  });

  test("restoredActivity: idle → the recorded clock; mid-turn → now (keep it longer)", () => {
    expect(restoredActivity(base({ lastActiveAt: 5 }), 100)).toBe(5);
    expect(
      restoredActivity(base({ lastActiveAt: 5, turn: { turnId: "T", steering: [] } }), 100),
    ).toBe(100);
  });
});
