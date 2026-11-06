import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  type AgentConfig,
  HookRunner,
  JsonSessionStore,
  type LoadResult,
  Session,
  parseSessionRecord,
  subagentRequester,
} from "@tentacle/agent";
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
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import { type Attachment, HostedSession, untilAborted } from "../src/hosted-session.ts";
import {
  ARCHIVED_TURN_END,
  type DaemonSessionRecord,
  ENDED_INTERRUPTED_NOTE,
  ENDED_NOT_RUN_NOTE,
  ENDED_SUBAGENT_INTERRUPTED_NOTE,
  INTERRUPTED_NOTE,
  NOT_RUN_NOTE,
  RESTART_TURN_END,
  SUBAGENT_INTERRUPTED_NOTE,
  classifyPending,
  parseDaemonRecord,
  reconcileOnReload,
  restoredActivity,
  toDaemonRecord,
} from "../src/persisted-session.ts";
import { SessionHost, type SessionHostOptions } from "../src/session-host.ts";
import { type RecordStore, SessionPersister } from "../src/session-persister.ts";
import { TOMBSTONE_FILE, TombstoneFile } from "../src/session-tombstones.ts";

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
  /** Ids read back; `holdLoads` parks a read until `releaseLoads()`; `loadAs` overrides its result. */
  readonly loads: string[] = [];
  holdLoads = false;
  loadAs: LoadResult | null = null;
  private heldLoads: Array<() => void> = [];
  async load(id: string): Promise<LoadResult> {
    this.loads.push(id);
    if (this.holdLoads) await new Promise<void>((r) => this.heldLoads.push(r));
    if (this.loadAs) return this.loadAs;
    const record = this.durable.get(id);
    return record
      ? { status: "ok", record: JSON.parse(JSON.stringify(record)) }
      : { status: "absent" };
  }
  releaseLoads(): void {
    for (const r of this.heldLoads.splice(0)) r();
  }
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
  extra: Partial<SessionHostOptions> = {},
  agentConfig: Partial<AgentConfig> = {},
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
    ...extra,
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
        requestPermission: (req, options) => permissions.request(req, options),
        ...agentConfig,
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
    expect(record.turn?.pending?.[0]).toMatchObject({
      toolCallId: "c2",
      tool: "run",
      resumable: true,
    });
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

  test("B1b the re-ask REPLACES the record carried from disk: a second restart while it is open asks again", async () => {
    // Mutation: `if (false)` at the `this.carried = undefined` branch in `awaitDecision` →
    // `carried` + the live ask = 2 entries, no `pending` written, the 2nd reload closes the turn.
    const runs: string[] = [];
    const tools = () => [tool("look", "none", runs), tool("run", "ask", runs)];
    const { record } = await suspendedOnC2(runs, tools);

    const r2 = rig([text("all done")], tools);
    const restored = r2.host.restore(record);
    const c = client();
    restored.attach(c.attachment);
    await until(() => c.asks.length === 1);
    await restored.persisted();
    const second = reread(r2.store.durable.get(restored.id));
    expect(second.turn?.pending?.[0]).toMatchObject({
      toolCallId: "c2",
      tool: "run",
      resumable: true,
    });

    const r3 = rig([text("all done")], tools);
    const again = r3.host.restore(second);
    expect(again.running).toBe(true);
    const c3 = client();
    again.attach(c3.attachment);
    await until(() => c3.asks.length === 1);
    expect(c3.asks[0]?.requestId).not.toBe(c.asks[0]?.requestId);
    expect(runs).toEqual(["look:{}"]);
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
      // v4: the steer keeps its enqueue id across the restart (docs/feat/queued-broadcast.md).
      steeringIds: ["e1"],
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
            durableAtEmit.push(store.durable.get(u.sessionId)?.turn?.pending?.[0]?.toolCallId);
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
      requestPermission: (req, options) => permissions.request(req, options),
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
    // As in an uninterrupted turn, a steer still queued at a cancel is not
    // delivered (the user cancelled): it is RETURNED to its writer, with the
    // id the v4 record kept (docs/feat/queued-broadcast.md; it was dropped
    // before, docs/fix/steering-over-rpc.md).
    expect(runs).toEqual(["look:{}"]);
    expect(r2.model.calls).toHaveLength(0);
    const lastQueued = c.updates.filter((u) => u.update.type === "queued").at(-1)?.update;
    expect(lastQueued).toEqual({
      type: "queued",
      entries: [],
      returned: [{ id: "e1", text: "steer-1", cause: "cancelled" }],
    });
    expect(shape(restored.snapshotPage().messages)).not.toContain("user:steer-1");
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
    // Mutation: drop BOTH the origin and the tool-name checks in classifyPending
    // → the agent_task reads "Not run" (each alone still refuses it).
    const runs: string[] = [];
    const tools = (broker: PermissionBroker) => [
      {
        ...tool("agent_task", "none", runs),
        async execute(_input, ctx) {
          // A sub-agent shares the parent's broker: its request goes through the
          // same requester, wrapped as the runner wraps it (attributed to this call).
          const child = subagentRequester(
            (req, options) => broker.request(req, options),
            ctx.toolCallId,
            { type: "explore", description: "d" },
          );
          await child({ tool: "run", level: "ask", title: "run", input: {} });
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
    expect(record.turn?.pending?.[0]).toMatchObject({
      toolCallId: "t1",
      tool: "run",
      resumable: false,
    });
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
    expect(store.durable.get(hosted.id)?.turn?.pending?.[0]?.toolCallId).toBe("c1");
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

  test("A9′ close (and the reaper's close) ARCHIVES: the record is kept, stamped, listed; one write", async () => {
    // Mutation M1: SessionHost.close → today's `persister.remove` → red (removed, not listed).
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
    now += 1;
    r.host.close(a.id);
    await tick();
    expect(r.store.removed).toEqual([]);
    expect(reread(r.store.durable.get(a.id)).archivedAt).toBe(now);
    expect(reread(r.store.durable.get(a.id)).messages).toEqual(a.snapshotPage().messages);
    // Exactly the archive write; nothing after it.
    expect(r.store.saves.length).toBe(saves + 1);
    expect(r.host.get(a.id)).toBeUndefined();

    const d = client();
    const b = r.host.open({ create: true }, d.attachment).hosted;
    b.detach(d.attachment);
    now += 10_000;
    expect(r.host.reapExpired({ idleTtlMs: 5_000 }).map((e) => e.id)).toEqual([b.id]);
    await tick();
    expect(r.store.removed).toEqual([]);
    expect(reread(r.store.durable.get(b.id)).archivedAt).toBe(now);
    const listed = r.host.list({}).sessions;
    expect(listed.map((s) => [s.sessionId, s.archived, s.cwd, s.running, s.attached])).toEqual([
      [b.id, true, CWD, false, 0],
      [a.id, true, CWD, false, 0],
    ]);
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
        schemaVersion: 8,
        lastActiveAt: 5,
        turns: [{ turnId: "T" }],
        enqueueIds: [],
        returned: [],
        turn: { turnId: "T", steering: [], steeringIds: [] },
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
      schemaVersion: 8,
      lastActiveAt: 7,
      turns: [],
      enqueueIds: [],
      returned: [],
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
      idleRecord({
        turns: [{ turnId: "T" }],
        turn: { turnId: "T", steering: [], steeringIds: [] },
      }),
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
    schemaVersion: 8,
    lastActiveAt: 2,
    turns: [],
    enqueueIds: [],
    returned: [],
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
    expect(reason({ ...base(), schemaVersion: 9 })).toMatch(/unsupported record version 9/);
    expect(reason(base(), "/elsewhere")).toMatch(/another project/);
    expect(reason({ ...base(), turns: [{ turnId: "x", end: { stopReason: "nope" } }] })).toMatch(
      /invalid end/,
    );
    expect(reason({ ...base(), turn: { turnId: "x", steering: [1] } })).toMatch(/"turn"/);
  });

  test("classifyPending: true only for a call's own, next-in-line request (A14, T4)", () => {
    // Mutation: drop the `origin` check → the sub-agent shape reads resumable.
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
    expect(classifyPending(messages, "c2", "call", "run")).toBe(true);
    // A sub-agent inside c2 asking for c2's own tool: still not resumable.
    expect(classifyPending(messages, "c2", "subagent", "run")).toBe(false);
    expect(classifyPending(messages, "c2", "call", "look")).toBe(false); // another tool than the call
    expect(classifyPending(messages, "c1", "call", "look")).toBe(false); // already answered
    expect(classifyPending(messages.slice(0, 2), "c2", "call", "run")).toBe(false); // c1 unanswered
    expect(classifyPending(messages, undefined, "call", "run")).toBe(false); // no attribution
    expect(classifyPending(messages, "c2", undefined, "run")).toBe(false); // no origin
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
          pending: [{ toolCallId: "zz", tool: "x", resumable: true, requestedAt: 1 }],
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
        turn: { turnId: "T", steering: ["s1"], pending: [pending] },
        ...over,
      });
    const ok = reconcileOnReload(record({}));
    expect(ok.resume).toEqual({ turnId: "T", from: "c2", steering: ["s1"], pending: [pending] });
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
          record({ turn: { turnId: "T", steering: ["s1"], pending: [{ ...pending, tool: "x" }] } }),
        ),
      ),
    ).toEqual(notRun);
    // Not resumable (a sub-agent's): the D4 note, never resumed.
    expect(
      reconcileOnReload(
        record({
          turn: { turnId: "T", steering: [], pending: [{ ...pending, resumable: false }] },
        }),
      ).resume,
    ).toBeUndefined();
  });

  test("U2 parseDaemonRecord: a v1 record reads as current, not archived; archivedAt is a wire stamp; v9 refused", () => {
    // Mutation: refuse v1 → every session of the previous build is skipped at the upgrade.
    // (Task 3 took the current version to 3, task 5 to 4, tui-spill-note to 5, tool-duration
    // to 6, context-awareness to 7, permission-reply to 8: v1–v7 all read as v8.)
    const parse = (r: unknown) => parseDaemonRecord(r as DaemonSessionRecord, (c) => c === CWD);
    const v1 = parse({ ...base(), schemaVersion: 1, archivedAt: 9 });
    expect(v1.ok ? [v1.record.schemaVersion, v1.record.archivedAt] : v1.reason).toEqual([
      8,
      undefined,
    ]);
    const v2 = parse(base({ archivedAt: 5 }));
    expect(v2.ok ? v2.record.archivedAt : v2.reason).toBe(5);
    expect(parse(base()).ok).toBe(true);
    for (const bad of [1.5, -1, "5", 2 ** 53]) {
      const p = parse({ ...base(), archivedAt: bad });
      expect(p.ok ? "ok" : p.reason).toBe('"archivedAt" is not a non-negative integer');
    }
    const v9 = parse({ ...base(), schemaVersion: 9 });
    expect(v9.ok ? "ok" : v9.reason).toMatch(
      /unsupported record version 9 \(this daemon reads 1, 2, 3, 4, 5, 6, 7, 8\)/,
    );
  });

  test("U3 reconcile of an ARCHIVED record cut mid-turn: ended, never resumed nor re-asked", () => {
    // Mutation M3: reconcileOnReload ignores archivedAt → resumed (asked again) / restart notes.
    const pending = { toolCallId: "c2", tool: "run", resumable: true, requestedAt: 1 };
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "look", arguments: "{}" },
          { id: "c2", name: "run", arguments: "{}" },
          { id: "c3", name: "run", arguments: "{}" },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ];
    const r = reconcileOnReload(
      base({
        archivedAt: 10,
        messages,
        turns: [{ turnId: "T" }],
        turn: { turnId: "T", steering: ["s1"], pending: [pending] },
      }),
    );
    expect(r.resume).toBeUndefined();
    expect(shape(r.messages).slice(-3)).toEqual([
      `tool(c2):${ENDED_NOT_RUN_NOTE}`,
      `tool(c3):${ENDED_NOT_RUN_NOTE}`,
      "user:s1",
    ]);
    expect(r.turns).toEqual([{ turnId: "T", end: ARCHIVED_TURN_END }]);
    expect(ARCHIVED_TURN_END).toEqual({ stopReason: "cancelled" });
    // In flight (no pending) → the ended "Interrupted"; a sub-agent's ask → its ended note.
    const inFlight = reconcileOnReload(
      base({ archivedAt: 10, messages, turns: [], turn: { turnId: "T", steering: [] } }),
    );
    expect(shape(inFlight.messages).at(-2)).toBe(`tool(c2):${ENDED_INTERRUPTED_NOTE}`);
    const sub = reconcileOnReload(
      base({
        archivedAt: 10,
        messages,
        turns: [],
        turn: { turnId: "T", steering: [], pending: [{ ...pending, resumable: false }] },
      }),
    );
    expect(shape(sub.messages).at(-2)).toBe(`tool(c2):${ENDED_SUBAGENT_INTERRUPTED_NOTE}`);
    // A turn key the close already ended keeps its end.
    const keyed = reconcileOnReload(
      base({
        archivedAt: 10,
        messages,
        turns: [{ turnId: "T", end: { stopReason: "cancelled" } }],
        turn: { turnId: "T", steering: [], pending: [pending] },
      }),
    );
    expect(keyed.turns).toEqual([{ turnId: "T", end: { stopReason: "cancelled" } }]);
    // Archived idle (the TTL, the detached cap: never busy) → as is.
    const idle = reconcileOnReload(base({ archivedAt: 10, messages: messages.slice(0, 1) }));
    expect(idle.messages).toEqual(messages.slice(0, 1));
    expect(idle.resume).toBeUndefined();
  });

  test("restoredActivity: idle → the recorded clock; mid-turn → now (keep it longer)", () => {
    expect(restoredActivity(base({ lastActiveAt: 5 }), 100)).toBe(5);
    expect(
      restoredActivity(base({ lastActiveAt: 5, turn: { turnId: "T", steering: [] } }), 100),
    ).toBe(100);
  });
});

// --- session archive (docs/feat/session-archive.md) ------------------------

/** The RPC code `fn` throws (or "no throw"). */
function codeOf(fn: () => unknown): number | string {
  try {
    fn();
    return "no throw";
  } catch (error) {
    return error instanceof RpcError ? error.code : String(error);
  }
}

/** One idle, ended turn on a new session; returns it (attached to `c`). */
async function idleSession(r: Rig, c: ReturnType<typeof client>): Promise<HostedSession> {
  const { hosted } = r.host.open({ create: true }, c.attachment);
  hosted.prompt("T1", go);
  await until(() => c.ended("T1"));
  await hosted.persisted();
  return hosted;
}

describe("session archive: the host (close keeps, reopen reloads, delete removes)", () => {
  test("A20 reopen: full history, created false, resync, new epoch; create/messages ignored; live again", async () => {
    // Mutation: open of an archived id ignores `reopen` (always reloads) → the plain open succeeds.
    const r = rig([text("hi")], () => []);
    const a = await idleSession(r, client());
    const before = a.snapshotPage();
    r.host.close(a.id);
    await tick();
    const saves = r.store.saves.length;
    // Without `reopen`: refused as archived, whatever create/messages say — nothing written.
    const seed = [{ role: "user" as const, content: "other" }];
    for (const params of [
      { sessionId: a.id },
      { sessionId: a.id, create: true },
      { sessionId: a.id, messages: seed },
    ]) {
      expect(codeOf(() => r.host.open(params, client().attachment))).toBe(
        DomainErrorCode.SessionArchived,
      );
    }
    expect(r.store.saves.length).toBe(saves);
    const d = client();
    const params = { sessionId: a.id, reopen: true, create: true, messages: seed };
    const out = r.host.open(params, d.attachment, await r.host.prepareOpen(params));
    expect([out.created, out.resync]).toEqual([false, true]);
    expect(out.epoch).not.toBe(before.since?.epoch);
    expect(out.hosted.snapshotPage().messages).toEqual(before.messages);
    await out.hosted.persisted();
    expect(r.store.durable.get(a.id)?.archivedAt).toBeUndefined();
    expect(r.host.list({}).sessions.map((s) => [s.sessionId, s.archived, s.attached])).toEqual([
      [a.id, false, 1],
    ]);
  });

  test("A21 reopen from disk over the wire: two concurrent reopens → one read, one restore, both attached", async () => {
    // Mutation M2: open ignores `prepared` (resident record only) → UnknownSession.
    const r = rig([text("hi")], () => []);
    const a = await idleSession(r, client());
    r.host.close(a.id);
    await tick();
    const record = reread(r.store.durable.get(a.id));
    expect(record.archivedAt).toEqual(expect.any(Number));
    const store = new SpyStore();
    store.durable.set(a.id, record);
    const r2 = rig([], () => [], store);
    r2.host.addArchived(record);
    const connect = async () => {
      const [d, c] = createChannelPair();
      new Connection(d, r2.host);
      const peer = new RpcPeer(c, { onNotification: () => {} });
      await peer.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      return peer;
    };
    const [p1, p2] = [await connect(), await connect()];
    store.holdLoads = true;
    const o1 = p1.request("session/open", { sessionId: a.id, reopen: true });
    const o2 = p2.request("session/open", { sessionId: a.id, reopen: true });
    await until(() => store.loads.length === 1);
    await tick(5);
    store.releaseLoads();
    const [res1, res2] = (await Promise.all([o1, o2])) as { epoch: string; created: boolean }[];
    expect(store.loads).toEqual([a.id]);
    expect(r2.host.size).toBe(1);
    expect(r2.host.archivedCount).toBe(0);
    expect(res1?.epoch).toBe(res2?.epoch ?? "");
    expect(r2.host.get(a.id)?.attachedCount).toBe(2);
  });

  test("A22 a reopen before the archive write lands works from memory; the final record is the live one", async () => {
    // Mutation: the archive keeps no resident record → the reopen reads a disk that has nothing yet.
    const r = rig([text("hi")], () => []);
    const a = await idleSession(r, client());
    r.store.hold = true;
    r.host.close(a.id);
    const params = { sessionId: a.id, reopen: true };
    const out = r.host.open(params, client().attachment, await r.host.prepareOpen(params));
    expect(r.store.loads).toEqual([]);
    expect(out.hosted.snapshotPage().messages).toEqual(a.snapshotPage().messages);
    r.store.release();
    await out.hosted.persisted();
    expect(reread(r.store.durable.get(a.id)).archivedAt).toBeUndefined();
  });

  test("A23 a failed archive write: reported once, reopen from memory, sweeps retry quietly, landed → memory freed", async () => {
    // Mutation M5: drop the resident record even on a failed write → X's reopen finds nothing.
    const r = rig([text("hi"), text("hi")], () => []);
    const x = await idleSession(r, client());
    const y = await idleSession(r, client());
    const errors = r.errors.length;
    r.store.fail = new Error("couldn't write x.json: no space left on device (ENOSPC)");
    r.host.close(x.id);
    r.host.close(y.id);
    await tick(5);
    expect(r.errors.length).toBe(errors + 2);
    expect(r.host.list({}).sessions.every((s) => s.archived)).toBe(true);
    // X: reopened from memory (nothing on disk to read).
    r.store.fail = null;
    const px = { sessionId: x.id, reopen: true };
    r.host.open(px, client().attachment, await r.host.prepareOpen(px));
    expect(r.store.loads).toEqual([]);
    expect(r.host.get(x.id)?.snapshotPage().messages).toEqual(x.snapshotPage().messages);
    await r.host.get(x.id)?.persisted();
    // Y: a sweep with the disk still full retries without a new report.
    r.store.fail = new Error("still full");
    r.host.reapExpired({ idleTtlMs: null });
    await tick(5);
    expect(r.errors.length).toBe(errors + 2);
    expect(r.store.durable.get(y.id)?.archivedAt).toBeUndefined();
    r.store.fail = null;
    r.host.reapExpired({ idleTtlMs: null });
    await tick(5);
    expect(reread(r.store.durable.get(y.id)).archivedAt).toEqual(expect.any(Number));
    // Landed → the resident copy is gone: the reopen reads the disk.
    const py = { sessionId: y.id, reopen: true };
    r.host.open(py, client().attachment, await r.host.prepareOpen(py));
    expect(r.store.loads).toEqual([y.id]);
  });

  test("A24 delete: a live attached running session ends `deleted` and its record goes; open is SessionDeleted", async () => {
    // Mutation M7: delete skips `persister.remove` for a live id → the record survives.
    const runs: string[] = [];
    let unpark: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      unpark = resolve;
    });
    const r = rig([[call("c1", "slow"), { type: "done" }]], () => [
      tool("slow", "none", runs, () => parked),
    ]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => runs.length === 1);
    await hosted.persisted();
    expect(r.host.delete(hosted.id)).toBe(true);
    const tail = c.updates.slice(-2).map((u) => u.update);
    expect(tail).toEqual([
      { type: "turn_end", turnId: "T1", stopReason: "cancelled" },
      { type: "session_closed", reason: "deleted" },
    ]);
    await tick();
    expect(r.store.removed).toEqual([hosted.id]);
    expect(r.store.durable.has(hosted.id)).toBe(false);
    expect(r.host.list({}).sessions).toEqual([]);
    // Tombstoned (F1): never reattached, reopened, recreated nor reused.
    const seed = [{ role: "user" as const, content: "mine" }];
    for (const params of [
      { sessionId: hosted.id },
      { sessionId: hosted.id, reopen: true },
      { sessionId: hosted.id, create: true },
      { sessionId: hosted.id, messages: seed },
    ]) {
      expect(codeOf(() => r.host.open(params, client().attachment))).toBe(
        DomainErrorCode.SessionDeleted,
      );
    }
    expect(r.host.size).toBe(0);
    expect(r.host.delete(hosted.id)).toBe(false);
    expect(r.host.delete("never-existed")).toBe(false);
    // An unknown id is not tombstoned by a delete: it can still be created.
    expect(
      r.host.open({ sessionId: "never-existed", create: true }, client().attachment).created,
    ).toBe(true);
    unpark();
  });

  test("A24b delete of an archived session whose write is still in flight: the file is gone at the end (real store)", async () => {
    // Mutation: delete of an archived id skips `persister.remove` → the file stays.
    const dir = await mkdtemp(join(tmpdir(), "archive-delete-"));
    try {
      const store = new JsonSessionStore(dir);
      const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
      const host = new SessionHost({
        defaultCwd: CWD,
        persister,
        createAgent: () => ({
          agent: new Agent({ model: new Scripted([]), tools: new ToolRegistry(), env }),
          permissions: new PermissionBroker(),
        }),
      });
      const { hosted } = host.open(
        { create: true, messages: [{ role: "user", content: "x" }] },
        client().attachment,
      );
      await store.drain();
      expect(await readdir(dir)).toContain(`${hosted.id}.json`);
      host.close(hosted.id); // the archive write starts …
      expect(host.delete(hosted.id)).toBe(true); // … the removal is queued after it
      await persister.stop();
      expect(await readdir(dir)).not.toContain(`${hosted.id}.json`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // docs/fix/tool-output-location.md: a session's spilled tool output goes with it.
  describe("onSessionDeleted", () => {
    const hooked = (hook: (id: string) => void) =>
      rig([[{ type: "done" }]], () => [], new SpyStore(), Date.now, { onSessionDeleted: hook });

    test("delete of a LIVE session calls it once with the id; close alone does not", () => {
      // Mutation: drop the call in the live branch of `delete` → red.
      const seen: string[] = [];
      const r = hooked((id) => seen.push(id));
      const { hosted } = r.host.open({ create: true }, client().attachment);
      expect(seen).toEqual([]);
      expect(r.host.delete(hosted.id)).toBe(true);
      expect(seen).toEqual([hosted.id]);
    });

    test("delete of an ARCHIVED session calls it once; the archiving does not", async () => {
      // Mutation: drop the call in the archived branch of `delete` → red.
      const seen: string[] = [];
      const r = hooked((id) => seen.push(id));
      const { hosted } = r.host.open(
        { create: true, messages: [{ role: "user", content: "x" }] },
        client().attachment,
      );
      r.host.close(hosted.id);
      await tick(5);
      expect(seen).toEqual([]);
      expect(r.host.delete(hosted.id)).toBe(true);
      expect(seen).toEqual([hosted.id]);
    });

    test("an unknown id (and a second delete) does not call it", () => {
      const seen: string[] = [];
      const r = hooked((id) => seen.push(id));
      expect(r.host.delete("never-existed")).toBe(false);
      const { hosted } = r.host.open({ create: true }, client().attachment);
      r.host.delete(hosted.id);
      r.host.delete(hosted.id);
      expect(seen).toEqual([hosted.id]);
    });

    test("a throwing hook does not break delete (the session is still gone and tombstoned)", () => {
      // Mutation: call the hook unguarded → delete throws → red.
      const r = hooked(() => {
        throw new Error("disk on fire");
      });
      const { hosted } = r.host.open({ create: true }, client().attachment);
      expect(r.host.delete(hosted.id)).toBe(true);
      expect(codeOf(() => r.host.open({ sessionId: hosted.id }, client().attachment))).toBe(
        DomainErrorCode.SessionDeleted,
      );
    });
  });

  test("F1 the tombstone is recorded BEFORE the file is removed; a failed one is reported and the file still goes", async () => {
    // Mutation: remove the file without waiting for the tombstone → `removed` before `added`.
    const order: string[] = [];
    const store = new SpyStore();
    const remove = store.remove.bind(store);
    store.remove = async (id) => {
      order.push(`removed ${id}`);
      await remove(id);
    };
    const errors: Error[] = [];
    const persister = new SessionPersister({
      store,
      cwd: CWD,
      model: "m",
      onError: (e) => errors.push(e),
      tombstones: {
        add: async (id) => {
          await tick();
          if (id === "b") throw new Error("disk full");
          order.push(`added ${id}`);
        },
      },
    });
    persister.remove("a");
    persister.remove("b");
    persister.remove("c", false); // a removal finished at start: no new tombstone
    await persister.stop();
    expect(order).toEqual(["removed c", "added a", "removed a", "removed b"]);
    expect(errors.map((e) => e.message)).toEqual(["disk full"]);
  });

  test("F1 TombstoneFile: appended in order, survives a reload, a torn last line is dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tombstones-"));
    try {
      const file = new TombstoneFile(dir);
      expect(await file.load()).toEqual([]); // no file yet
      await Promise.all([file.add("s-1"), file.add("s-2")]);
      await appendFile(file.path, "s-3-torn"); // a crash mid-append: no newline
      expect(await new TombstoneFile(dir).load()).toEqual(["s-1", "s-2"]);
      await expect(file.add("../x")).rejects.toThrow("invalid session id");
      expect(await readdir(dir)).toEqual([TOMBSTONE_FILE]); // never a `.json`: the scan skips it
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("R2-1 a torn tail does not swallow the NEXT tombstone (the Review's repro)", async () => {
    // Mutation: append `${id}\n` without the leading newline → the id glues onto the torn tail.
    const dir = await mkdtemp(join(tmpdir(), "tombstones-"));
    try {
      const file = new TombstoneFile(dir);
      const first = "a1b2c3d4-0000-4000-8000-000000000001";
      const second = "ffffffff-0000-4000-8000-000000000002";
      await file.add(first);
      await appendFile(file.path, "a1b2c3d4-0000-40"); // a crash mid-append: no newline
      expect(await file.load()).toEqual([first]);
      await file.add(second);
      const ids = await new TombstoneFile(dir).load();
      expect(ids).toContain(first);
      expect(ids).toContain(second);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("R2-3 a garbled line is skipped and reported (not silently)", async () => {
    // Mutation: the filter drops invalid lines without calling `onGarbled`.
    const dir = await mkdtemp(join(tmpdir(), "tombstones-"));
    try {
      const file = new TombstoneFile(dir);
      await writeFile(file.path, "s-1\n../evil\n\ns-2\n");
      const garbled: string[] = [];
      expect(await file.load((line) => garbled.push(line))).toEqual(["s-1", "s-2"]);
      expect(garbled).toEqual(["../evil"]); // the blank line is not garbled
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("R2-5 a blocked id is still tombstoned (its file is left as is)", async () => {
    // Mutation: `remove` returns early for a blocked id → no tombstone.
    const store = new SpyStore();
    const added: string[] = [];
    const persister = new SessionPersister({
      store,
      cwd: CWD,
      model: "m",
      onError: () => {},
      tombstones: {
        add: async (id) => {
          added.push(id);
        },
      },
    });
    persister.block("x");
    persister.remove("x");
    await persister.stop();
    expect(added).toEqual(["x"]);
  });

  test("A24c delete during a reopen's disk read → the reopen is SessionDeleted", async () => {
    const r = rig([text("hi")], () => []);
    const a = await idleSession(r, client());
    r.host.close(a.id);
    await tick();
    const record = reread(r.store.durable.get(a.id));
    const store = new SpyStore();
    store.durable.set(a.id, record);
    const r2 = rig([], () => [], store);
    r2.host.addArchived(record);
    store.holdLoads = true;
    const params = { sessionId: a.id, reopen: true };
    const preparing = r2.host.prepareOpen(params);
    await until(() => store.loads.length === 1);
    expect(r2.host.delete(a.id)).toBe(true);
    store.releaseLoads();
    const prepared = await preparing;
    expect(codeOf(() => r2.host.open(params, client().attachment, prepared))).toBe(
      DomainErrorCode.SessionDeleted,
    );
    expect(store.removed).toEqual([a.id]);
  });

  test("F2 a reopen counts against maxSessions: TooManySessions (same data), the record stays archived, untouched", async () => {
    // Mutation: the reopen branch skips the live-cap check → a second live session.
    const audits: string[] = [];
    const r = rig([text("hi"), text("hi")], () => [], new SpyStore(), Date.now, {
      maxSessions: 1,
      onAudit: (l) => audits.push(l),
    });
    const a = await idleSession(r, client());
    r.host.close(a.id);
    await tick(5);
    const b = await idleSession(r, client());
    const bytes = JSON.stringify(r.store.durable.get(a.id));
    const saves = r.store.saves.length;
    const params = { sessionId: a.id, reopen: true };
    let refused: unknown;
    try {
      r.host.open(params, client().attachment, await r.host.prepareOpen(params));
    } catch (error) {
      refused = error;
    }
    expect(refused instanceof RpcError ? [refused.code, refused.data] : refused).toEqual([
      DomainErrorCode.TooManySessions,
      { limit: "sessions", max: 1 },
    ]);
    expect(audits).toEqual(["session-refused sessions 1/1"]);
    expect(r.host.size).toBe(1);
    expect(r.host.list({}).sessions.map((s) => [s.sessionId, s.archived])).toEqual(
      expect.arrayContaining([
        [a.id, true],
        [b.id, false],
      ]),
    );
    await tick(5);
    expect(r.store.saves.length).toBe(saves);
    expect(JSON.stringify(r.store.durable.get(a.id))).toBe(bytes);
    // Room again → the same reopen succeeds; nothing was evicted to make room.
    r.host.close(b.id);
    const out = r.host.open(params, client().attachment, await r.host.prepareOpen(params));
    expect(out.created).toBe(false);
    expect(r.host.size).toBe(1);
  });

  test("A25 an archived record damaged after start: reopen → UnknownSession, hidden, reported, never touched", async () => {
    // Mutation: a failed load keeps the entry → still listed, the open answers "not loaded".
    const r = rig([text("hi")], () => []);
    const a = await idleSession(r, client());
    r.host.close(a.id);
    await tick();
    const record = reread(r.store.durable.get(a.id));
    const store = new SpyStore();
    store.loadAs = { status: "unreadable", file: `/x/${a.id}.json`, reason: "invalid JSON (boom)" };
    const r2 = rig([], () => [], store);
    r2.host.addArchived(record);
    const params = { sessionId: a.id, reopen: true };
    const prepared = await r2.host.prepareOpen(params);
    expect(prepared).toBeUndefined();
    expect(codeOf(() => r2.host.open(params, client().attachment, prepared))).toBe(
      DomainErrorCode.UnknownSession,
    );
    expect(r2.host.list({}).sessions).toEqual([]);
    expect(r2.errors.map((e) => e.message)).toEqual([
      `archived session ${a.id} could not be reopened: invalid JSON (boom) (left as is)`,
    ]);
    // Blocked: a new session under that id lives in memory only — never written, never removed.
    const fresh = r2.host.open({ sessionId: a.id, create: true }, client().attachment).hosted;
    r2.host.delete(fresh.id);
    await tick();
    expect(store.saves.filter((s) => s.id === a.id)).toEqual([]);
    expect(store.removed).toEqual([]);
  });

  test("A26 a turn suspended on a permission: the idle TTL skips it; the admin cap archives it; reopen ends it, never re-asks", async () => {
    // Mutation M3: reconcileOnReload ignores archivedAt → the restart notes, not the ended ones.
    let now = 1_000_000;
    const runs: string[] = [];
    const r = rig(
      [[call("c1", "run"), { type: "done" }]],
      () => [tool("run", "ask", runs)],
      new SpyStore(),
      () => now,
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    hosted.detach(c.attachment);
    now += 10 * 24 * 60 * 60 * 1000;
    expect(r.host.reapExpired({ idleTtlMs: 1000 })).toEqual([]);
    expect(r.host.reapExpired({ idleTtlMs: 1000, adminCapMs: 1000 })).toEqual([
      { id: hosted.id, reason: "admin_cap", archived: true },
    ]);
    await tick(5);
    const d = client();
    const params = { sessionId: hosted.id, reopen: true };
    const out = r.host.open(params, d.attachment, await r.host.prepareOpen(params));
    expect(out.hosted.running).toBe(false);
    await tick(5);
    expect(d.updates.some((u) => u.update.type === "permission_request")).toBe(false);
    expect(shape(out.hosted.snapshotPage().messages).at(-1)).toBe(`tool(c1):${ENDED_NOT_RUN_NOTE}`);
    expect(out.hosted.prompt("T1", go)).toEqual({
      turnId: "T1",
      ended: { stopReason: "cancelled" },
    });
    expect(runs).toEqual([]);
  });

  test("A27 the detached cap archives the oldest idle detached session; all busy → refused; no persister → refused", async () => {
    // Mutation M4: selectEvictable ignores busy → a session suspended on a permission is evicted.
    let now = 1_000;
    const audit: string[] = [];
    const r = rig(
      [],
      () => [],
      new SpyStore(),
      () => now,
      { maxDetachedSessions: 2, onAudit: (l) => audit.push(l) },
    );
    const make = () => {
      const c = client();
      const h = r.host.open({ create: true }, c.attachment).hosted;
      h.detach(c.attachment);
      now += 10;
      return h;
    };
    const older = make();
    const newer = make();
    const third = r.host.open({ create: true }, client().attachment);
    expect(third.created).toBe(true);
    expect(audit).toEqual([`session-archived ${older.id} evicted`]);
    expect(r.host.get(older.id)).toBeUndefined();
    expect(r.host.get(newer.id)).toBeDefined();
    expect(r.host.list({}).sessions.find((s) => s.sessionId === older.id)?.archived).toBe(true);

    // Every detached session busy (suspended on a permission) → refused, nothing evicted.
    const busy = rig(
      [
        [call("c1", "run"), { type: "done" }],
        [call("c2", "run"), { type: "done" }],
      ],
      () => [tool("run", "ask", [])],
      new SpyStore(),
      () => now,
      { maxDetachedSessions: 2 },
    );
    for (const turnId of ["A", "B"]) {
      const c = client();
      const h = busy.host.open({ create: true }, c.attachment).hosted;
      h.prompt(turnId, go);
      await until(() => c.asks.length === 1);
      h.detach(c.attachment);
    }
    expect(codeOf(() => busy.host.open({ create: true }, client().attachment))).toBe(
      DomainErrorCode.TooManySessions,
    );
    expect(busy.host.size).toBe(2);

    // No persister: an archive would be a deletion → refused.
    const bare = new SessionHost({
      defaultCwd: CWD,
      maxDetachedSessions: 1,
      createAgent: () => ({
        agent: new Agent({ model: new Scripted([]), tools: new ToolRegistry(), env }),
        permissions: new PermissionBroker(),
      }),
    });
    const c = client();
    bare.open({ create: true }, c.attachment).hosted.detach(c.attachment);
    expect(codeOf(() => bare.open({ create: true }, client().attachment))).toBe(
      DomainErrorCode.TooManySessions,
    );
  });

  test("A28 no id is ever both live and archived (create, archive, reopen, delete)", async () => {
    const r = rig([text("hi")], () => []);
    const consistent = (): void => {
      const listed = r.host.list({}).sessions;
      expect(new Set(listed.map((s) => s.sessionId)).size).toBe(listed.length);
      for (const s of listed) {
        expect({ id: s.sessionId, live: r.host.get(s.sessionId) !== undefined }).toEqual({
          id: s.sessionId,
          live: !s.archived,
        });
      }
    };
    const a = await idleSession(r, client());
    consistent();
    r.host.close(a.id);
    consistent();
    const params = { sessionId: a.id, reopen: true };
    r.host.open(params, client().attachment, await r.host.prepareOpen(params));
    consistent();
    r.host.close(a.id);
    await tick();
    consistent();
    expect(() => r.host.restore(reread(r.store.durable.get(a.id)))).toThrow(/already known/);
    r.host.delete(a.id);
    consistent();
    expect(r.host.list({}).sessions).toEqual([]);
  });

  test("A29 no persister (pod daemon, worker): close forgets; delete of a live one says `deleted`; unknown is a no-op", () => {
    const host = new SessionHost({
      defaultCwd: CWD,
      createAgent: () => ({
        agent: new Agent({ model: new Scripted([]), tools: new ToolRegistry(), env }),
        permissions: new PermissionBroker(),
      }),
    });
    const c = client();
    const a = host.open({ create: true }, c.attachment).hosted;
    expect(host.close(a.id)).toBe(true);
    expect(host.list({}).sessions).toEqual([]);
    expect(codeOf(() => host.open({ sessionId: a.id }, client().attachment))).toBe(
      DomainErrorCode.UnknownSession,
    );
    const d = client();
    const b = host.open({ create: true }, d.attachment).hosted;
    expect(host.delete(b.id)).toBe(true);
    expect(d.updates.at(-1)?.update).toEqual({ type: "session_closed", reason: "deleted" });
    expect(host.delete(b.id)).toBe(false);
    expect(host.list({}).sessions).toEqual([]);
  });
});

describe("the v4 record: steer ids and returned rows (docs/feat/queued-broadcast.md)", () => {
  const v4 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "s",
    cwd: CWD,
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    messages: [{ role: "user", content: "go" }],
    kind: "tentacle.daemon-session",
    schemaVersion: 4,
    lastActiveAt: 2,
    turns: [{ turnId: "T" }],
    enqueueIds: ["i1"],
    returned: [{ id: "r1", text: "R", cause: "cancelled" }],
    turn: { turnId: "T", steering: ["s1"], steeringIds: ["i1"] },
    ...over,
  });
  const parse = (r: unknown) => parseDaemonRecord(r as DaemonSessionRecord, (c) => c === CWD);

  test("P-R1 a v4 record round-trips steer ids and returned rows; a malformed one is refused, never half-loaded", () => {
    const ok = parse(v4());
    expect(ok.ok ? [ok.record.turn, ok.record.returned] : ok.reason).toEqual([
      { turnId: "T", steering: ["s1"], steeringIds: ["i1"] },
      [{ id: "r1", text: "R", cause: "cancelled" }],
    ]);
    const reason = (over: Record<string, unknown>) => {
      const p = parse(v4(over));
      return p.ok ? "ok" : p.reason;
    };
    expect(reason({ turn: { turnId: "T", steering: ["s1"], steeringIds: [] } })).toBe(
      '"turn.steeringIds" is malformed',
    );
    expect(reason({ turn: { turnId: "T", steering: ["s1"] } })).toBe(
      '"turn.steeringIds" is malformed',
    );
    expect(reason({ returned: undefined })).toBe('"returned" is malformed');
    expect(reason({ returned: [{ id: "r1", text: "R", cause: "lost" }] })).toBe(
      '"returned" is malformed',
    );
    expect(reason({ returned: [{ id: "", text: "R", cause: "ended" }] })).toBe(
      '"returned" is malformed',
    );
  });

  test("P-R1 a v3 record reads as v4 with no ids and nothing returned; a chosen title still loads (the title gate)", () => {
    // Mutation: the title gate left at `schemaVersion !== DAEMON_RECORD_VERSION` → the v3 record is refused.
    const v3 = parse(
      v4({
        schemaVersion: 3,
        title: { text: "Fix login", source: "user" },
        returned: [{ id: "forged", text: "F", cause: "ended" }],
        turn: { turnId: "T", steering: ["s1"], steeringIds: ["i1"] },
      }),
    );
    expect(
      v3.ok ? [v3.record.schemaVersion, v3.record.turn, v3.record.returned] : v3.reason,
    ).toEqual([8, { turnId: "T", steering: ["s1"] }, []]);
    const v3Title = parse(v4({ schemaVersion: 3, title: { text: "Fix login", source: "user" } }));
    expect(v3Title.ok ? v3Title.record.title : v3Title.reason).toEqual({
      text: "Fix login",
      source: "user",
    });
    // v1/v2 never wrote a chosen title: still refused.
    expect(parse(v4({ schemaVersion: 2, title: { text: "x", source: "user" } })).ok).toBe(false);
  });

  test("Q-R2 a v4 turn cut short by a crash: its steers go back to their writer (returned, ended), never into the history", () => {
    // Owner decision Q2 (docs/feat/queued-broadcast.md). Mutation: no v4 branch → "user:s1", nothing returned.
    const ok = parse(v4());
    if (!ok.ok) throw new Error(ok.reason);
    const back = reconcileOnReload(ok.record);
    expect(shape(back.messages)).toEqual(["user:go"]);
    expect(back.returned).toEqual([
      { id: "r1", text: "R", cause: "cancelled" },
      { id: "i1", text: "s1", cause: "ended" },
    ]);
    expect(back.turns).toEqual([{ turnId: "T", end: RESTART_TURN_END }]);
    expect(back.resume).toBeUndefined();
    // An id already returned is not returned twice (the reload is idempotent).
    // Mutation: no "already returned" guard → i1 twice.
    const twice = parse(v4({ returned: [{ id: "i1", text: "s1", cause: "ended" }] }));
    if (!twice.ok) throw new Error(twice.reason);
    expect(reconcileOnReload(twice.record).returned).toEqual([
      { id: "i1", text: "s1", cause: "ended" },
    ]);
  });

  test("Q-R2 a v3 turn cut short by a crash keeps today's behaviour: no writer known, its steers become user messages", () => {
    const old = parse(v4({ schemaVersion: 3 }));
    if (!old.ok) throw new Error(old.reason);
    const back = reconcileOnReload(old.record);
    expect(shape(back.messages)).toEqual(["user:go", "user:s1"]);
    expect(back.returned).toEqual([]);
  });

  /** A turn running a tool (no permission) with `steer-1` queued: what a crash mid-turn leaves on disk. */
  async function crashedMidTool(): Promise<DaemonSessionRecord> {
    let release = (): void => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const runs: string[] = [];
    const r = rig([[call("c1", "look"), { type: "done" }]], () => [
      tool("look", "none", runs, () => blocked),
    ]);
    const { hosted } = r.host.open({ create: true }, client().attachment);
    hosted.prompt("T1", go);
    await until(() => runs.length === 1);
    hosted.enqueue("e1", "T1", "steer-1");
    await hosted.persisted();
    const record = reread(r.store.durable.get(hosted.id));
    release();
    return record;
  }

  const crashReturned = [{ id: "e1", text: "steer-1", cause: "ended" as const }];

  test("Q-R2 writer offline: the reload holds the row (snapshot, disk); a second crash before the reclaim neither duplicates nor loses it", async () => {
    const record = await crashedMidTool();
    expect(record.turn).toMatchObject({ steering: ["steer-1"], steeringIds: ["e1"] });
    const r2 = rig([], () => []);
    const restored = r2.host.restore(record);
    expect(restored.running).toBe(false);
    expect(shape(restored.snapshotPage().messages)).not.toContain("user:steer-1");
    expect(restored.snapshotPage().queued).toEqual({ entries: [], returned: crashReturned });
    // A writer attaching later reads it from the snapshot (its client hands it back, C5).
    const late = client();
    restored.attach(late.attachment);
    expect(restored.snapshotPage().queued?.returned).toEqual(crashReturned);
    await restored.persisted();
    const after = reread(r2.store.durable.get(restored.id));
    expect(after.turn).toBeUndefined();
    expect(after.returned).toEqual(crashReturned);
    // Second crash, after the reload's write: once, still not in the history.
    const r3 = rig([], () => []);
    const again = r3.host.restore(after);
    expect(again.snapshotPage().queued?.returned).toEqual(crashReturned);
    expect(shape(again.snapshotPage().messages)).not.toContain("user:steer-1");
    await again.persisted();
    expect(reread(r3.store.durable.get(again.id)).returned).toEqual(crashReturned);
    // Second crash BEFORE the reload's write landed: the same record, the same result.
    expect(
      rig([], () => [])
        .host.restore(record)
        .snapshotPage().queued?.returned,
    ).toEqual(crashReturned);
    // No expiry: only a reclaim takes it.
    again.reclaim(["e1"]);
    await again.persisted();
    expect(reread(r3.store.durable.get(again.id)).returned).toEqual([]);
  });

  test("Q-R2 a send-now citing a crash-returned row after the reload sends it (it was never delivered)", async () => {
    // Mutation: the reloaded returned ids stay in `restoredIds` → read as delivered → NoTurnRunning.
    const record = await crashedMidTool();
    const r2 = rig([text("ok")], () => []);
    const restored = r2.host.restore(record);
    const c = client();
    restored.attach(c.attachment);
    expect(
      restored.sendNow("T2", { kind: "turn", turnId: "T1" }, [{ id: "e1", text: "steer-1" }]),
    ).toEqual({ turnId: "T2" });
    await until(() => c.ended("T2"));
    expect(
      shape(restored.snapshotPage().messages).filter((m) => m === "user:steer-1"),
    ).toHaveLength(1);
    await restored.persisted();
    expect(reread(r2.store.durable.get(restored.id)).returned).toEqual([]);
  });

  test("Q-R2 a turn suspended on its own permission is RE-RUN, not cut: its steers stay its queue (v4 ids), returned only if it is stopped", async () => {
    const runs: string[] = [];
    const tools = () => [tool("look", "none", runs), tool("run", "ask", runs)];
    const { record } = await suspendedOnC2(runs, tools);
    const r2 = rig([], tools);
    const restored = r2.host.restore(record);
    expect(restored.running).toBe(true);
    expect(restored.snapshotPage().queued).toEqual({
      entries: [{ id: "e1", text: "steer-1" }],
      returned: [],
    });
    // A crash while it is still suspended: the record still resumes it, nothing returned.
    await restored.persisted();
    const still = reread(r2.store.durable.get(restored.id));
    expect(still.turn).toMatchObject({ steering: ["steer-1"], steeringIds: ["e1"] });
    expect(still.returned).toEqual([]);
    // Delivered if it drains (B1). Stopped before: back to its writer, with its id.
    const c = client();
    restored.attach(c.attachment);
    await until(() => c.asks.length === 1);
    restored.cancel();
    await until(() => c.ended("T1"));
    await restored.persisted();
    const record2 = reread(r2.store.durable.get(restored.id));
    expect(record2.returned).toEqual([{ id: "e1", text: "steer-1", cause: "cancelled" }]);
    expect(shape(record2.messages)).not.toContain("user:steer-1");
  });

  test("Q-R2 close of a reloaded session holding crash-returned rows: archived once, the reopen shows them, never delivers them", async () => {
    const record = await crashedMidTool();
    const r2 = rig([], () => []);
    const restored = r2.host.restore(record);
    r2.host.close(restored.id);
    await tick(5);
    const archived = reread(r2.store.durable.get(restored.id));
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(archived.turn).toBeUndefined();
    expect(archived.returned).toEqual(crashReturned);
    const d = client();
    const params = { sessionId: restored.id, reopen: true };
    const out = r2.host.open(params, d.attachment, await r2.host.prepareOpen(params));
    expect(shape(out.hosted.snapshotPage().messages)).not.toContain("user:steer-1");
    expect(out.hosted.snapshotPage().queued?.returned).toEqual(crashReturned);
  });

  test("Q9 a restart resumes a suspended turn's steer with the id its writer sent (v4); a v3 record mints one, nobody's", async () => {
    const runs: string[] = [];
    const tools = () => [tool("look", "none", runs), tool("run", "ask", runs)];
    const { record } = await suspendedOnC2(runs, tools);
    expect(record.turn?.steeringIds).toEqual(["e1"]);
    const restored = rig([], tools).host.restore(record);
    expect(restored.snapshotPage().queued).toEqual({
      entries: [{ id: "e1", text: "steer-1" }],
      returned: [],
    });
    // A v3 record held ONE pending object, never a group (the v8 list and
    // `groupStart` are round-groups-persistence's).
    const v3 = JSON.parse(JSON.stringify(record));
    const { groupStart: _g, ...entry } = v3.turn?.pending?.[0] ?? {};
    const old = parse({ ...v3, schemaVersion: 3, turn: { ...v3.turn, pending: entry } });
    if (!old.ok) throw new Error(old.reason);
    const minted = rig([], tools).host.restore(old.record).snapshotPage().queued?.entries ?? [];
    expect(minted.map((r) => r.text)).toEqual(["steer-1"]);
    expect(record.enqueueIds).not.toContain(minted[0]?.id);
  });

  test("P-R3 archive mid-queue: the record keeps the row as returned, not as a steer; the reopen shows it, never delivers it", async () => {
    // Mutation: `archive` keeps `before.turn.steering` → the reopen also appends "steer-1".
    const runs: string[] = [];
    const r = rig([[call("c1", "run"), { type: "done" }]], () => [tool("run", "ask", runs)]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    hosted.enqueue("e1", "T1", "steer-1");
    r.host.close(hosted.id);
    await tick(5);
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.archivedAt).toEqual(expect.any(Number));
    expect(record.turn?.steering).toEqual([]);
    expect(record.returned).toEqual([{ id: "e1", text: "steer-1", cause: "ended" }]);
    // Streamed to the attached writer before the end.
    expect(c.updates.slice(-2).map((u) => u.update.type)).toEqual(["queued", "session_closed"]);
    const d = client();
    const params = { sessionId: hosted.id, reopen: true };
    const out = r.host.open(params, d.attachment, await r.host.prepareOpen(params));
    expect(shape(out.hosted.snapshotPage().messages)).not.toContain("user:steer-1");
    expect(out.hosted.snapshotPage().queued?.returned).toEqual([
      { id: "e1", text: "steer-1", cause: "ended" },
    ]);
    expect(runs).toEqual([]);
  });

  test("P-R5 a reclaim landing between a reopen's read and its open: the reopened session does not hand the row back", async () => {
    // Mutation: `restore(record, …)` instead of `restore(withoutReclaimed(record, entry.reclaimed), …)` → `returned` holds e1 again.
    const runs: string[] = [];
    const r = rig([[call("c1", "run"), { type: "done" }]], () => [tool("run", "ask", runs)]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    hosted.enqueue("e1", "T1", "steer-1");
    r.host.close(hosted.id);
    await tick(5);
    const params = { sessionId: hosted.id, reopen: true };
    // The reopen's read is done (the record is pinned for its `open`) ...
    const prepared = await r.host.prepareOpen(params);
    expect(prepared?.returned.map((x) => x.id)).toEqual(["e1"]);
    // ... then the reclaim lands, and the reopen's `open` runs with the stale record.
    await r.host.reclaimArchived(hosted.id, ["e1"]);
    const d = client();
    const out = r.host.open(params, d.attachment, prepared);
    expect(out.hosted.snapshotPage().queued?.returned).toEqual([]);
  });

  test("P-R4 a reclaim is on disk before its ack (serve), and survives a restart", async () => {
    const runs: string[] = [];
    const r = rig([[call("c1", "run"), { type: "done" }]], () => [tool("run", "ask", runs)]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    hosted.enqueue("e1", "T1", "steer-1");
    hosted.cancel();
    await until(() => c.ended("T1"));
    await hosted.persisted();
    expect(reread(r.store.durable.get(hosted.id)).returned).toEqual([
      { id: "e1", text: "steer-1", cause: "cancelled" },
    ]);
    hosted.reclaim(["e1"]);
    await hosted.persisted();
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.returned).toEqual([]);
    const again = rig([], () => []).host.restore(record);
    expect(again.snapshotPage().queued).toEqual({ entries: [], returned: [] });
  });
});

describe("the v5 record: a tool message may carry its spill (docs/feat/tui-spill-note.md)", () => {
  const spill = {
    chars: 40800,
    path: ".tentacle/tool-output/big-c1.txt",
    head: "h",
    tail: "t",
    omitted: 39600,
  };
  const v4 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "s",
    cwd: CWD,
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    messages: [{ role: "user", content: "go" }],
    kind: "tentacle.daemon-session",
    schemaVersion: 4,
    lastActiveAt: 2,
    turns: [{ turnId: "T" }],
    enqueueIds: ["i1"],
    returned: [{ id: "r1", text: "R", cause: "cancelled" }],
    turn: { turnId: "T", steering: ["s1"], steeringIds: ["i1"] },
    ...over,
  });
  const parse = (r: unknown) => parseDaemonRecord(r as DaemonSessionRecord, (c) => c === CWD);

  test("V5-1 a v5 record still reads (as the current v7; tool-duration took the version to 6, context-awareness to 7)", () => {
    // Was "written as v5; v6 refused" — superseded by V6-1, then V7-1 below.
    const ok = parse(v4({ schemaVersion: 5 }));
    expect(ok.ok ? ok.record.schemaVersion : ok.reason).toBe(8);
  });

  test("V5-2 a v4 record reads as current with its ids, rows and messages intact — and still refuses a v4 turn without ids", () => {
    // The v4 gates are their OWN constant, not the current version. Mutation
    // (red, verified): leave them at `DAEMON_RECORD_VERSION` → the v4 turn
    // loses its ids, its rows are dropped, and an id-less v4 turn loads.
    const ok = parse(v4());
    expect(
      ok.ok
        ? [ok.record.schemaVersion, ok.record.turn, ok.record.returned, ok.record.messages]
        : ok.reason,
    ).toEqual([
      8,
      { turnId: "T", steering: ["s1"], steeringIds: ["i1"] },
      [{ id: "r1", text: "R", cause: "cancelled" }],
      [{ role: "user", content: "go" }],
    ]);
    const idless = parse(v4({ turn: { turnId: "T", steering: ["s1"] } }));
    expect(idless.ok ? "ok" : idless.reason).toBe('"turn.steeringIds" is malformed');
  });

  test("V5-3 a restart keeps the spill: the disk bytes pass the store's strict parser and the snapshot carries it", async () => {
    // Mutation (red, verified): drop "spill" from the store's MESSAGE_KEYS → the reread fails.
    const big: Tool = {
      name: "big",
      description: "big",
      inputSchema: anyInput,
      permission: "none",
      execute: async () => ({ content: "[large big output: …]", spill }),
    };
    const r = rig([[call("c1", "big"), { type: "done" }], text("done")], () => [big]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    await hosted.persisted();
    const durable = r.store.durable.get(hosted.id);
    const bytes = JSON.parse(JSON.stringify(durable));
    const stored = parseSessionRecord(bytes, hosted.id);
    expect(stored.ok ? "ok" : stored.reason).toBe("ok");
    const record = reread(durable);
    expect(record.schemaVersion).toBe(8);
    const restored = rig([], () => []).host.restore(record);
    const toolMessage = restored.snapshotPage().messages.find((m) => m.role === "tool");
    expect(toolMessage?.spill).toEqual(spill);
  });
});

describe("the v6 record: a tool message may carry its durationMs (docs/fix/tool-duration.md)", () => {
  const v5 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "s",
    cwd: CWD,
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ],
    kind: "tentacle.daemon-session",
    schemaVersion: 5,
    lastActiveAt: 2,
    turns: [{ turnId: "T" }],
    enqueueIds: ["i1"],
    returned: [],
    ...over,
  });
  const parse = (r: unknown) => parseDaemonRecord(r as DaemonSessionRecord, (c) => c === CWD);

  test("V6-1 a v6 record still reads (as the current v7; docs/feat/context-awareness.md took the version to 7)", () => {
    // Was "written as v6; v7 refused" — superseded by V7-1 below.
    const ok = parse(v5({ schemaVersion: 6 }));
    expect(ok.ok ? ok.record.schemaVersion : ok.reason).toBe(8);
  });

  test("V6-2 a v1–v5 record reads as current with no durations, its messages intact", () => {
    for (const schemaVersion of [1, 2, 3, 4, 5]) {
      const turn = schemaVersion >= 4 ? { turnId: "T", steering: [], steeringIds: [] } : undefined;
      const ok = parse(v5({ schemaVersion, ...(turn ? { turn } : {}) }));
      expect(ok.ok ? ok.record.schemaVersion : ok.reason).toBe(8);
      expect(ok.ok ? (ok.record.messages as unknown) : ok.reason).toEqual(v5().messages);
      expect(ok.ok && ok.record.messages.some((m) => "durationMs" in m)).toBe(false);
    }
  });

  test("V6-3 a restart keeps the duration: the disk bytes pass the store's strict parser and the snapshot carries the live value", async () => {
    // Mutation (red, verified): drop "durationMs" from the store's MESSAGE_KEYS → the reread fails.
    const quick: Tool = {
      name: "quick",
      description: "quick",
      inputSchema: anyInput,
      permission: "none",
      execute: async () => ({ content: "ok" }),
    };
    const r = rig([[call("c1", "quick"), { type: "done" }], text("done")], () => [quick]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    await hosted.persisted();
    const live = c.updates.flatMap((u) =>
      u.update.type === "tool_call_update" ? [u.update.durationMs] : [],
    );
    expect(live).toHaveLength(1);
    expect(Number.isInteger(live[0])).toBe(true);
    const durable = r.store.durable.get(hosted.id);
    const bytes = JSON.parse(JSON.stringify(durable));
    const stored = parseSessionRecord(bytes, hosted.id);
    expect(stored.ok ? "ok" : stored.reason).toBe("ok");
    const record = reread(durable);
    expect(record.schemaVersion).toBe(8);
    const restored = rig([], () => []).host.restore(record);
    const toolMessage = restored.snapshotPage().messages.find((m) => m.role === "tool");
    expect(toolMessage?.durationMs).toBe(live[0] ?? -1);
  });
});

describe("the v7 record: a message may carry its contextUsage (docs/feat/context-awareness.md)", () => {
  const v6 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "s",
    cwd: CWD,
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
      { role: "tool", content: "ok", toolCallId: "c1", durationMs: 3 },
    ],
    kind: "tentacle.daemon-session",
    schemaVersion: 6,
    lastActiveAt: 2,
    turns: [{ turnId: "T" }],
    enqueueIds: ["i1"],
    returned: [],
    ...over,
  });
  const parse = (r: unknown) => parseDaemonRecord(r as DaemonSessionRecord, (c) => c === CWD);

  test("V7-1 a v7 record still reads (as the current v8; docs/feat/permission-reply.md took the version to 8)", () => {
    // Was "written as v7; v8 refused" — superseded by V8-1 below.
    const ok = parse(v6({ schemaVersion: 7 }));
    expect(ok.ok ? ok.record.schemaVersion : ok.reason).toBe(8);
  });

  test("V7-2 a v1–v6 record reads as v7 with no lines, its messages intact", () => {
    for (const schemaVersion of [1, 2, 3, 4, 5, 6]) {
      const turn = schemaVersion >= 4 ? { turnId: "T", steering: [], steeringIds: [] } : undefined;
      const ok = parse(v6({ schemaVersion, ...(turn ? { turn } : {}) }));
      expect(ok.ok ? ok.record.schemaVersion : ok.reason).toBe(8);
      expect(ok.ok ? (ok.record.messages as unknown) : ok.reason).toEqual(v6().messages);
      expect(ok.ok && ok.record.messages.some((m) => "contextUsage" in m)).toBe(false);
    }
  });

  test("V7-3 a restart keeps the line: the disk bytes pass the store's strict parser and the snapshot carries it", async () => {
    const r = rig(
      [text("done")],
      () => [],
      undefined,
      undefined,
      {},
      {
        contextAwareness: { window: 1000, stepPercent: 1 },
      },
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.ended("T1"));
    await hosted.persisted();
    const durable = r.store.durable.get(hosted.id);
    const bytes = JSON.parse(JSON.stringify(durable));
    const stored = parseSessionRecord(bytes, hosted.id);
    expect(stored.ok ? "ok" : stored.reason).toBe("ok");
    const record = reread(durable);
    expect(record.schemaVersion).toBe(8);
    const line = record.messages.find((m) => m.role === "user")?.contextUsage;
    expect(line?.window).toBe(1000);
    const restored = rig([], () => []).host.restore(record);
    const user = restored.snapshotPage().messages.find((m) => m.role === "user");
    expect(user?.content).toBe("go");
    expect(user?.contextUsage).toEqual(line ?? { used: -1, window: 1 });
  });
});

describe("the v8 record: a refused call's reply and the installed head (docs/feat/permission-reply.md)", () => {
  const SYS: ChatMessage = { role: "system", content: "S" };
  const HEAD: ChatMessage = { role: "user", content: "RESTART PROMPT" };
  const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "s",
    cwd: CWD,
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    messages: [SYS, HEAD],
    kind: "tentacle.daemon-session",
    schemaVersion: 8,
    lastActiveAt: 2,
    turns: [{ turnId: "t1" }],
    enqueueIds: [],
    returned: [],
    ...over,
  });
  const parse = (r: unknown) => parseDaemonRecord(r as DaemonSessionRecord, (c) => c === CWD);
  const parsed = (r: unknown): DaemonSessionRecord => {
    const p = parse(JSON.parse(JSON.stringify(r)));
    if (!p.ok) throw new Error(p.reason);
    return p.record;
  };
  /** Cut short AT a context reset's barrier: the fresh history, its turn in flight. */
  const atBarrier = { turn: { turnId: "t1", steering: [], steeringIds: [] } };

  test("V8-1 a record is written as v8; a v9 one is refused (a v7 daemon refuses a v8 the same way)", () => {
    const written = toDaemonRecord(
      {
        id: "s",
        createdAt: 1,
        lastActiveAt: 1,
        lastChangeAt: 1,
        messages: [],
        turns: [],
        enqueueIds: [],
      },
      { cwd: CWD, model: "m" },
      1,
    );
    expect(written.schemaVersion).toBe(8);
    expect(parse(record()).ok).toBe(true);
    const v9 = parse(record({ schemaVersion: 9 }));
    expect(v9.ok ? "ok" : v9.reason).toBe(
      "unsupported record version 9 (this daemon reads 1, 2, 3, 4, 5, 6, 7, 8)",
    );
  });

  test("V8-2 a tool message's denialReply survives a restart: the bytes pass the store's strict parser, the snapshot carries it", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: "{}" }] },
      { role: "tool", content: "denied…", toolCallId: "c1", denialReply: "try bun run build" },
    ];
    const bytes = JSON.parse(
      JSON.stringify(
        record({ messages, turns: [{ turnId: "t1", end: { stopReason: "end_turn" } }] }),
      ),
    );
    const stored = parseSessionRecord(bytes, "s");
    expect(stored.ok ? "ok" : stored.reason).toBe("ok");
    const restored = rig([], () => []).host.restore(parsed(bytes));
    const tool = restored.snapshotPage().messages.find((m) => m.role === "tool");
    expect(tool?.denialReply).toBe("try bun run build");
  });

  test("V8-3 `head` must name a user message of the history", () => {
    expect(parse(record({ head: 1 })).ok).toBe(true);
    for (const head of [0, 2, -1, 1.5, "1", null]) {
      const p = parse(record({ head }));
      expect(p.ok ? "ok" : p.reason).toBe('"head" is malformed');
    }
  });

  test("V8-4 an unmarked head is the reload rule (idle and `[system?, user]` only), for v1–v7 and v8 alike", () => {
    const v8 = parse(record({ turns: [] }));
    expect(v8.ok ? v8.record.head : v8.reason).toBe(1);
    const head = (over: Record<string, unknown>): unknown => {
      const p = parse(record({ schemaVersion: 7, ...over }));
      return p.ok ? (p.record.head ?? "none") : p.reason;
    };
    expect(head({})).toBe(1);
    expect(head({ messages: [HEAD] })).toBe(0);
    expect(head(atBarrier)).toBe("none");
    expect(head({ messages: [SYS, HEAD, { role: "assistant", content: "hi" }] })).toBe("none");
    // A head an older build somehow wrote is not read: v8 is its first version.
    expect(head({ messages: [SYS, HEAD, { role: "assistant", content: "x" }], head: 1 })).toBe(
      "none",
    );
  });

  test("V8-5 (context-reset slice-2 F1) cut short at a reset: the marked head is the summary again — a send-now has nothing to answer, as before the crash", () => {
    // Mutation: ignore `head` on reload → the send-now starts a turn answering the restart prompt.
    const marked = rig([text("unasked")], () => []).host.restore(
      parsed(record({ ...atBarrier, head: 1 })),
    );
    let code: number | undefined;
    try {
      marked.sendNow("t2", { kind: "turn", turnId: "t1" }, []);
    } catch (error) {
      code = error instanceof RpcError ? error.code : -1;
    }
    expect(code).toBe(DomainErrorCode.NoTurnRunning);
    expect(marked.running).toBe(false);
    // What v7 could not say (the debt): the same record unmarked starts a turn.
    const unmarked = rig([text("unasked")], () => []).host.restore(
      parsed(record({ ...atBarrier, schemaVersion: 7 })),
    );
    expect(unmarked.sendNow("t2", { kind: "turn", turnId: "t1" }, [])).toEqual({ turnId: "t2" });
  });

  test("V8-6 every write marks the installed head while it is in the history", async () => {
    // Mutation: drop `head` from `persistedState` → the record after the turn has none.
    const r = rig([text("done")], () => []);
    const restored = r.host.restore(parsed(record({ head: 1, turns: [] })));
    const c = client();
    restored.attach(c.attachment);
    restored.prompt("T2", go);
    await until(() => c.ended("T2"));
    await restored.persisted();
    const after = reread(r.store.durable.get("s"));
    expect(after.head).toBe(1);
    expect(after.messages[1]).toEqual(HEAD);
  });
});

// docs/feat/permission-call-attribution.md: the daemon attributes an ask from
// the requester's options, never from the last `tool_start`, and holds several
// live asks at once. Asks are raised straight through the broker's requester
// (what a parallel call or sub-agent will do in tasks 6/7).
describe("permission call attribution", () => {
  const ask = (tool: string) => ({ tool, level: "ask" as const, title: tool, input: {} });

  test("T3 the ask names the call from its options, not the last tool_start", async () => {
    // Mutation: attribute from the last `tool_start` (main) → "c2" on the wire and on disk.
    const tools = (broker: PermissionBroker): Tool[] => [
      {
        ...tool("asker", "none", []),
        async execute() {
          await broker.request(ask("run"), { toolCallId: "c1", origin: "call" });
          return { content: "ok" };
        },
      },
    ];
    const r = rig([[call("c2", "asker"), { type: "done" }]], tools);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    expect(c.asks[0]?.toolCallId).toBe("c1");
    await hosted.persisted();
    expect(reread(r.store.durable.get(hosted.id)).turn?.pending?.[0]).toMatchObject({
      toolCallId: "c1",
      tool: "run",
    });
    c.allow(hosted);
    await until(() => c.ended("T1"));
  });

  test("T8 a sub-agent ask streams its agent; an ask without options falls back to 'pending'", async () => {
    const tools = (broker: PermissionBroker): Tool[] => [
      {
        ...tool("agent_task", "none", []),
        async execute() {
          await broker.request(ask("run"), {
            toolCallId: "t1",
            origin: "subagent",
            agent: { type: "explore", description: "find callers" },
          });
          await broker.request(ask("run"));
          return { content: "ok" };
        },
      },
    ];
    const r = rig([[call("t1", "agent_task"), { type: "done" }]], tools);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    expect(c.asks[0]).toMatchObject({
      toolCallId: "t1",
      agent: { type: "explore", description: "find callers" },
    });
    await hosted.persisted();
    expect(reread(r.store.durable.get(hosted.id)).turn?.pending?.[0]).toMatchObject({
      toolCallId: "t1",
      resumable: false,
    });
    c.allow(hosted);
    await until(() => c.asks.length === 1 && c.asks[0]?.toolCallId === "pending");
    expect(c.asks[0]?.agent).toBeUndefined();
    await hosted.persisted();
    // No attribution: never resumable, never the wrong call.
    expect(reread(r.store.durable.get(hosted.id)).turn?.pending?.[0]).toMatchObject({
      toolCallId: "",
      resumable: false,
    });
    c.allow(hosted);
    await until(() => c.ended("T1"));
  });

  /** One call `f1` that raises two asks at once (x1, x2) and reports both answers. */
  function fanRig(answers: boolean[]) {
    const tools = (broker: PermissionBroker): Tool[] => [
      {
        ...tool("fan", "none", []),
        async execute() {
          const both = await Promise.all([
            broker.request(ask("run"), { toolCallId: "x1", origin: "call" }),
            broker.request(ask("run"), { toolCallId: "x2", origin: "call" }),
          ]);
          answers.push(...both.map((a) => a.allowed));
          return { content: "ok" };
        },
      },
    ];
    return rig([[call("f1", "fan"), { type: "done" }]], tools);
  }

  test("T5/T6 two live asks: each its own request; answered one by one; disk holds both (v8 list)", async () => {
    // Mutation: one `pending` slot overwritten by each ask (main) → the record
    // names x2 while two are live; or only the first of two is written → the
    // record says "x1 pending" while x2 is too
    // (docs/feat/round-groups-persistence.md: the list goes on disk with v8).
    const answers: boolean[] = [];
    const r = fanRig(answers);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 2);
    const [first, second] = c.asks;
    expect(first?.requestId).not.toBe(second?.requestId);
    expect(c.asks.map((a) => a.toolCallId)).toEqual(["x1", "x2"]);
    await hosted.persisted();
    const both = reread(r.store.durable.get(hosted.id));
    expect(both.turn).toBeDefined();
    expect(both.turn?.pending?.map((p) => [p.toolCallId, p.resumable])).toEqual([
      ["x1", false],
      ["x2", false],
    ]);
    // A record written with two live asks (not the call's own: f1 asked nothing)
    // reloads CLOSED: never resumed, never re-run.
    const reloaded = rig([], () => []).host.restore(both);
    expect(shape(reloaded.snapshotPage().messages).at(-1)).toBe(`tool(f1):${INTERRUPTED_NOTE}`);
    expect(reconcileOnReload(both).resume).toBeUndefined();
    expect(reconcileOnReload(both).turns).toContainEqual({ turnId: "T1", end: RESTART_TURN_END });

    hosted.resolvePermission(first?.requestId ?? "", "allow_once");
    expect(c.asks.map((a) => a.toolCallId)).toEqual(["x2"]);
    await tick(); // the settled ask's write is scheduled after the answer returns
    await hosted.persisted();
    expect(reread(r.store.durable.get(hosted.id)).turn?.pending?.map((p) => p.toolCallId)).toEqual([
      "x2",
    ]);
    // A stale answer to the first never binds to the second.
    expect(() => hosted.resolvePermission(first?.requestId ?? "", "reject_once")).toThrow(
      expect.objectContaining({ code: DomainErrorCode.PermissionNotPending }),
    );
    hosted.resolvePermission(second?.requestId ?? "", "reject_once");
    await until(() => c.ended("T1"));
    expect(answers).toEqual([true, false]);
  });

  test("T5 a cancel settles every live ask", async () => {
    const answers: boolean[] = [];
    const r = fanRig(answers);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 2);
    hosted.cancel();
    await until(() => c.ended("T1"));
    expect(c.asks).toEqual([]);
    const cancelled = c.updates.flatMap((u) =>
      u.update.type === "permission_resolved" ? [u.update.outcome] : [],
    );
    expect(cancelled).toEqual([{ outcome: "cancelled" }, { outcome: "cancelled" }]);
    expect(answers).toEqual([false, false]);
  });

  test("T7 a history_commit does not drop another call's live ask from the record", async () => {
    // Mutation: clear every pending ask at a commit (main's single slot) → red.
    let unpark: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      unpark = resolve;
    });
    let parkedRunning = false;
    let answered: Promise<unknown> = Promise.resolve();
    const tools = (broker: PermissionBroker): Tool[] => [
      {
        ...tool("fire", "none", []),
        async execute() {
          // Left live past this call's own commit (as a parallel sibling's would be).
          answered = broker.request(ask("run"), { toolCallId: "c1", origin: "call" });
          return { content: "ok" };
        },
      },
      tool("park", "none", [], async () => {
        parkedRunning = true;
        await parked;
      }),
    ];
    const r = rig([[call("c1", "fire"), call("c2", "park"), { type: "done" }]], tools);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => parkedRunning && c.asks.length === 1);
    await hosted.persisted();
    expect(reread(r.store.durable.get(hosted.id)).turn?.pending?.[0]).toMatchObject({
      toolCallId: "c1",
    });
    c.allow(hosted);
    await answered;
    unpark();
    await until(() => c.ended("T1"));
  });
});

// --- round groups on disk (docs/feat/round-groups-persistence.md) ----------

describe("round groups on disk: groupStart, pending[] and inFlight (v8)", () => {
  const rec = (over: Partial<DaemonSessionRecord> = {}): DaemonSessionRecord => ({
    id: "s",
    cwd: CWD,
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    messages: [],
    kind: "tentacle.daemon-session",
    schemaVersion: 8,
    lastActiveAt: 2,
    turns: [],
    enqueueIds: [],
    returned: [],
    ...over,
  });
  const round: ChatMessage[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "run", arguments: '{"n":1}' },
        { id: "c2", name: "run", arguments: '{"n":2}' },
        { id: "c3", name: "agent_task", arguments: "{}" },
      ],
    },
  ];
  const entry = (toolCallId: string, over: Record<string, unknown> = {}) => ({
    toolCallId,
    tool: "run",
    resumable: true,
    requestedAt: 1,
    ...over,
  });
  const parse = (r: unknown) => parseDaemonRecord(r as DaemonSessionRecord, (c) => c === CWD);
  const closedBy = (r: DaemonSessionRecord) =>
    shape(reconcileOnReload(r).messages).filter((s) => s.startsWith("tool("));

  test("T1 (repro B) classifyPending: an ask inside its group, before any of it ran, is resumable", () => {
    // Mutation: ignore `groupStart` (today's `suspendedCalls(c2)`) → false.
    expect(classifyPending(round, "c2", "call", "run", "c1")).toBe(true);
    // Absent → the call itself: today's answer (c1 unanswered before c2).
    expect(classifyPending(round, "c2", "call", "run")).toBe(false);
    expect(classifyPending(round, "c2", "subagent", "run", "c1")).toBe(false);
    expect(classifyPending(round, "c2", "call", "look", "c1")).toBe(false);
    expect(classifyPending(round, "c2", "call", "run", "c2")).toBe(false); // c1 unanswered
  });

  test("T2 a record suspended inside a group resumes from the group head: c1 asked again, then c2", async () => {
    // Mutation: resume from `pending.toolCallId` (c2) → ResumeShapeError / closed, c1 never asked.
    const runs: string[] = [];
    const record = rec({
      messages: round.slice(0, 1).concat({
        ...round[1],
        toolCalls: round[1]?.toolCalls?.slice(0, 2),
      } as ChatMessage),
      turns: [{ turnId: "T1" }],
      turn: {
        turnId: "T1",
        steering: [],
        steeringIds: [],
        pending: [{ ...entry("c2"), groupStart: "c1" }],
      },
    });
    const reloaded = reread(record);
    expect(reconcileOnReload(reloaded).resume).toMatchObject({ turnId: "T1", from: "c1" });
    const restored = rig([text("done")], () => [tool("run", "ask", runs)]).host.restore(reloaded);
    const c = client();
    restored.attach(c.attachment);
    expect(restored.running).toBe(true);
    await until(() => c.asks.length === 1);
    expect(c.asks[0]?.toolCallId).toBe("c1");
    c.allow(restored);
    await until(() => c.asks[0]?.toolCallId === "c2");
    c.allow(restored);
    await until(() => !restored.running);
    expect(runs).toEqual(['run:{"n":1}', 'run:{"n":2}']);
  });

  test("T2b not resumed: inFlight present, entries on different groups, or one not resumable", () => {
    const turn = (over: Record<string, unknown>) =>
      rec({
        messages: round,
        turns: [{ turnId: "T" }],
        turn: { turnId: "T", steering: [], steeringIds: [], ...over } as never,
      });
    const g = { groupStart: "c1" };
    expect(reconcileOnReload(turn({ pending: [{ ...entry("c2"), ...g }] })).resume).toBeDefined();
    expect(
      reconcileOnReload(turn({ pending: [{ ...entry("c2"), ...g }], inFlight: ["c1"] })).resume,
    ).toBeUndefined();
    expect(
      reconcileOnReload(
        turn({
          pending: [
            { ...entry("c1"), ...g },
            { ...entry("c2"), groupStart: "c2" },
          ],
        }),
      ).resume,
    ).toBeUndefined();
    expect(
      reconcileOnReload(
        turn({
          pending: [
            { ...entry("c1"), ...g },
            { ...entry("c2"), ...g, resumable: false },
          ],
        }),
      ).resume,
    ).toBeUndefined();
  });

  test("T3 labels with inFlight: in flight → Interrupted (or the sub-agent note), the rest → Not run", () => {
    // Mutation: label from the first unanswered call only (today) → c2 'Not run'.
    const record = (archivedAt?: number) =>
      rec({
        messages: round,
        turns: [{ turnId: "T" }],
        ...(archivedAt !== undefined ? { archivedAt } : {}),
        turn: {
          turnId: "T",
          steering: [],
          steeringIds: [],
          inFlight: ["c1", "c3"],
          pending: [entry("c3", { tool: "run", resumable: false })],
        },
      });
    expect(closedBy(record())).toEqual([
      `tool(c1):${INTERRUPTED_NOTE}`,
      `tool(c2):${NOT_RUN_NOTE}`,
      `tool(c3):${SUBAGENT_INTERRUPTED_NOTE}`,
    ]);
    expect(closedBy(record(10))).toEqual([
      `tool(c1):${ENDED_INTERRUPTED_NOTE}`,
      `tool(c2):${ENDED_NOT_RUN_NOTE}`,
      `tool(c3):${ENDED_SUBAGENT_INTERRUPTED_NOTE}`,
    ]);
    // No inFlight: today's rule (only the first unanswered call may have run).
    const plain = rec({
      messages: round,
      turns: [{ turnId: "T" }],
      turn: { turnId: "T", steering: [], steeringIds: [] },
    });
    expect(closedBy(plain)).toEqual([
      `tool(c1):${INTERRUPTED_NOTE}`,
      `tool(c2):${NOT_RUN_NOTE}`,
      `tool(c3):${NOT_RUN_NOTE}`,
    ]);
  });

  test("T6 v7 → v8: a v7 pending object reads as a one-entry list; malformed v8 turn fields are refused", () => {
    // Mutation: drop the `< V8` wrap → a v7 suspended record is refused at the upgrade.
    const turn = (version: number, over: Record<string, unknown>) =>
      parse({
        ...rec({ messages: round, turns: [{ turnId: "T" }] }),
        schemaVersion: version,
        turn: { turnId: "T", steering: [], steeringIds: [], ...over },
      });
    const v7 = turn(7, { pending: entry("c1") });
    expect(v7.ok ? v7.record.turn?.pending : v7.reason).toEqual([entry("c1")]);
    if (v7.ok) {
      expect(reconcileOnReload(v7.record).resume).toMatchObject({
        from: "c1",
        pending: [entry("c1")],
      });
    }
    const v8 = turn(8, { pending: [{ ...entry("c2"), groupStart: "c1" }], inFlight: ["c1"] });
    expect(v8.ok).toBe(true);
    const reasons = [
      turn(8, { pending: entry("c1") }),
      turn(8, { pending: [] }),
      turn(8, { pending: [{ ...entry("c1"), groupStart: 3 }] }),
      turn(8, { pending: [{ toolCallId: "c1" }] }),
      turn(8, { inFlight: [] }),
      turn(8, { inFlight: ["c1", 2] }),
      turn(7, { inFlight: ["c1"] }),
      turn(7, { pending: entry("c1", { groupStart: "c1" }) }),
    ].map((p) => (p.ok ? "ok" : p.reason));
    expect(reasons).toEqual([
      '"turn.pending" is malformed',
      '"turn.pending" is malformed',
      '"turn.pending" is malformed',
      '"turn.pending" is malformed',
      '"turn.inFlight" is malformed',
      '"turn.inFlight" is malformed',
      '"turn.inFlight" is malformed',
      '"turn.pending" is malformed',
    ]);
  });

  /** A session whose agent is replaced by `fake` (a scripted group, task 6's executor shape). */
  function hostedWith(
    store: SpyStore,
    fake: (
      messages: ChatMessage[],
      opts: { beforeRun?: (ids: readonly string[], s: AbortSignal) => Promise<boolean> },
      signal: AbortSignal,
    ) => AsyncGenerator<import("@tentacle/agent").AgentEvent>,
    persisted = true,
    setup: (persister: SessionPersister) => void = () => {},
  ) {
    const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
    setup(persister);
    const agent = new Agent({ model: new Scripted([]), tools: new ToolRegistry(), env });
    agent.runMessages = (messages, _id, signal, _drain, opts = {}) =>
      fake(messages, opts, signal ?? new AbortController().signal);
    const hosted = new HostedSession(
      "s1",
      new Session(agent),
      new PermissionBroker(),
      undefined,
      {},
      undefined,
      Date.now,
      persisted ? { persister } : undefined,
    );
    const updates: KnownSessionUpdateParams[] = [];
    hosted.attach({ send: (u) => updates.push(u) });
    return { hosted, updates };
  }

  test("T4 beforeRun: inFlight is durable before the group runs, resolves true, cleared at the group's commit", async () => {
    // Mutation: drop the `await` on the write in `beforeRun` → resolved before the disk has it.
    const store = new SpyStore();
    const atRun: (string[] | undefined)[] = [];
    let landed: boolean | undefined;
    let settledWhileHeld: boolean | undefined;
    const { hosted } = hostedWith(store, async function* (messages, opts) {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "run", arguments: "{}" },
          { id: "c2", name: "run", arguments: "{}" },
        ],
      });
      yield { type: "history_commit" };
      yield { type: "tool_start", id: "c1", name: "run", arguments: "{}" };
      yield { type: "tool_start", id: "c2", name: "run", arguments: "{}" };
      store.hold = true;
      const wrote = opts.beforeRun?.(["c1", "c2"], new AbortController().signal);
      void wrote?.then(() => {
        settledWhileHeld = store.hold;
      });
      await tick(5);
      atRun.push(store.durable.get("s1")?.turn?.inFlight as string[] | undefined);
      store.hold = false;
      store.release();
      landed = await wrote;
      atRun.push(store.durable.get("s1")?.turn?.inFlight as string[] | undefined);
      messages.push({ role: "tool", content: "a", toolCallId: "c1" });
      messages.push({ role: "tool", content: "b", toolCallId: "c2" });
      yield { type: "history_commit" };
      yield { type: "turn_end", reason: "end_turn" };
    });
    hosted.prompt("T1", go);
    await until(() => !hosted.running);
    await hosted.persisted();
    // Held: not on disk yet (and `wrote` had not resolved); released: on disk.
    expect(atRun).toEqual([undefined, ["c1", "c2"]]);
    expect(settledWhileHeld).toBe(false); // resolved only once the disk had it
    expect(landed).toBe(true);
    // The group's commit captured the results AND cleared inFlight together.
    const commit = store.saves.find((s) =>
      s.messages.some((m) => m.role === "tool" && m.toolCallId === "c2"),
    );
    expect(commit?.turn?.inFlight).toBeUndefined();
  });

  test("T4b beforeRun: a failed write resolves false; a cancel releases a hung write (false)", async () => {
    // Mutation: return true whatever the write did → task 6 would run a group the disk never saw.
    const failing = new SpyStore();
    let failed: boolean | undefined;
    const a = hostedWith(failing, async function* (_m, opts) {
      failing.fail = new Error("disk full");
      failed = await opts.beforeRun?.(["c1", "c2"], new AbortController().signal);
      failing.fail = null;
      yield { type: "turn_end", reason: "end_turn" };
    });
    a.hosted.prompt("T1", go);
    await until(() => !a.hosted.running);
    expect(failed).toBe(false);

    const hung = new SpyStore();
    let released: boolean | undefined;
    const b = hostedWith(hung, async function* (_m, opts, signal) {
      hung.hold = true;
      released = await opts.beforeRun?.(["c1", "c2"], signal);
      yield { type: "turn_end", reason: "cancelled" };
    });
    b.hosted.prompt("T1", go);
    await tick(5);
    b.hosted.cancel();
    await until(() => released !== undefined);
    expect(released).toBe(false);
    hung.hold = false;
    hung.release();
  });

  test("T4c no persister (pods, the worker): beforeRun resolves true at once and writes nothing", async () => {
    const store = new SpyStore();
    let wrote: boolean | undefined;
    const { hosted } = hostedWith(
      store,
      async function* (_m, opts) {
        wrote = await opts.beforeRun?.(["c1", "c2"], new AbortController().signal);
        yield { type: "turn_end", reason: "end_turn" };
      },
      false,
    );
    hosted.prompt("T1", go);
    await until(() => !hosted.running);
    expect(wrote).toBe(true);
    expect(store.saves).toEqual([]);
  });

  test("T4d a session the persister never writes (blocked file): beforeRun resolves true, like no persister", async () => {
    // docs/feat/round-groups-persistence.md Q-R2. Mutation: return the write's
    // `false` for an unwritable session → task 6 would run its groups one at a
    // time for nothing (no disk to be honest to).
    const store = new SpyStore();
    let wrote: boolean | undefined;
    const { hosted } = hostedWith(
      store,
      async function* (_m, opts) {
        wrote = await opts.beforeRun?.(["c1", "c2"], new AbortController().signal);
        yield { type: "turn_end", reason: "end_turn" };
      },
      true,
      (persister) => persister.block("s1"),
    );
    hosted.prompt("T1", go);
    await until(() => !hosted.running);
    expect(wrote).toBe(true);
    expect(store.saves).toEqual([]);
  });

  test("T9 (F1) a resumed group: while c1 runs the disk no longer says 'resume from c1'", async () => {
    // docs/feat/round-groups-persistence.md Review F1 / Q-R1. The record holds
    // c2 asking inside group c1. c1 is asked again, approved, and RUNS: the
    // carried c2 entry must be gone from the disk by then, or a crash here
    // re-asks (re-runs) c1. Mutation: keep the other carried entries when an
    // ask settles → the reload still resumes from c1 while c1 runs.
    const runs: string[] = [];
    const seen: Array<string | undefined> = [];
    const store = new SpyStore();
    const record = rec({
      messages: round.slice(0, 1).concat({
        ...round[1],
        toolCalls: round[1]?.toolCalls?.slice(0, 2),
      } as ChatMessage),
      turns: [{ turnId: "T1" }],
      turn: {
        turnId: "T1",
        steering: [],
        steeringIds: [],
        pending: [{ ...entry("c2"), groupStart: "c1" }],
      },
    });
    const r = rig(
      [text("done")],
      () => [
        tool("run", "ask", runs, () => {
          const durable = store.durable.get("s");
          seen.push(durable ? reconcileOnReload(reread(durable)).resume?.from : "nothing durable");
        }),
      ],
      store,
    );
    const restored = r.host.restore(reread(record));
    const c = client();
    restored.attach(c.attachment);
    await until(() => c.asks.length === 1);
    expect(c.asks[0]?.toolCallId).toBe("c1");
    c.allow(restored);
    await until(() => c.asks[0]?.toolCallId === "c2");
    c.allow(restored);
    await until(() => !restored.running);
    expect(runs).toEqual(['run:{"n":1}', 'run:{"n":2}']);
    // At c1's run and at c2's: neither reload resumes anything.
    expect(seen).toEqual([undefined, undefined]);
  });

  // docs/fix/resumed-call-pending.md (task-5 Review F3): a resumed call the
  // gate allows WITHOUT an ask (here: its tool's permission became `none`
  // across the restart; a hook `force: "allow"` is the same path) settles no
  // ask, so F1's clear never runs. Mutation: drop the awaited clear before the
  // resumed call runs → the disk still resumes it while it runs.
  const alone = (): DaemonSessionRecord =>
    rec({
      messages: round.slice(0, 1).concat({
        ...round[1],
        toolCalls: round[1]?.toolCalls?.slice(0, 1),
      } as ChatMessage),
      turns: [{ turnId: "T1" }],
      turn: { turnId: "T1", steering: [], steeringIds: [], pending: [entry("c1")] },
    });

  test("T10 (F3) a resumed call allowed without an ask: a crash while it runs never runs it again", async () => {
    const runs: string[] = [];
    const store = new SpyStore();
    let atRun: DaemonSessionRecord | undefined;
    const r = rig(
      [text("done")],
      () => [
        tool("run", "none", runs, () => {
          const durable = store.durable.get("s");
          atRun = durable
            ? (JSON.parse(JSON.stringify(durable)) as DaemonSessionRecord)
            : undefined;
        }),
      ],
      store,
    );
    const restored = r.host.restore(reread(alone()));
    const c = client();
    restored.attach(c.attachment);
    await until(() => !restored.running);
    expect(runs).toEqual(['run:{"n":1}']);
    expect(c.asks).toEqual([]);
    // The daemon died while c1 ran: a restart reads `atRun` back.
    const crashed = reread(atRun);
    expect(reconcileOnReload(crashed).resume).toBeUndefined();
    const again: string[] = [];
    const r2 = rig([text("after")], () => [tool("run", "none", again)]);
    const second = r2.host.restore(crashed);
    await until(() => !second.running);
    expect(again).toEqual([]);
    expect(shape(second.snapshotPage().messages)).toContain(`tool(c1):${INTERRUPTED_NOTE}`);
  });

  test("T10b (F3) a resumed group allowed without asks: while c1 runs the disk no longer resumes from c1", async () => {
    const runs: string[] = [];
    const seen: Array<string | undefined> = [];
    const store = new SpyStore();
    const record = rec({
      messages: round.slice(0, 1).concat({
        ...round[1],
        toolCalls: round[1]?.toolCalls?.slice(0, 2),
      } as ChatMessage),
      turns: [{ turnId: "T1" }],
      turn: {
        turnId: "T1",
        steering: [],
        steeringIds: [],
        pending: [{ ...entry("c2"), groupStart: "c1" }],
      },
    });
    const r = rig(
      [text("done")],
      () => [
        tool("run", "none", runs, () => {
          const durable = store.durable.get("s");
          seen.push(durable ? reconcileOnReload(reread(durable)).resume?.from : "nothing durable");
        }),
      ],
      store,
    );
    const restored = r.host.restore(reread(record));
    await until(() => !restored.running);
    expect(runs).toEqual(['run:{"n":1}', 'run:{"n":2}']);
    expect(seen).toEqual([undefined, undefined]);
  });

  test("T10e (F3) the clear is AWAITED: the call does not start until its write lands", async () => {
    // Mutation: schedule the clear without waiting → c1 runs while the disk
    // still says "resume from c1".
    const runs: string[] = [];
    const store = new SpyStore();
    store.hold = true;
    const r = rig([text("done")], () => [tool("run", "none", runs)], store);
    const restored = r.host.restore(reread(alone()));
    await tick(5);
    expect(runs).toEqual([]);
    store.hold = false;
    store.release();
    await until(() => !restored.running);
    expect(runs).toEqual(['run:{"n":1}']);
  });

  test("T10c (F3) the clear's write fails: the call still runs once and the failure is reported", async () => {
    // The `beforeRun` / clear-before-run rule: a failed write never blocks a
    // call (the daemon decides nothing itself); the persister reports it.
    const runs: string[] = [];
    const store = new SpyStore();
    store.fail = new Error("disk full");
    const r = rig([text("done")], () => [tool("run", "none", runs)], store);
    const restored = r.host.restore(reread(alone()));
    await until(() => !restored.running);
    expect(runs).toEqual(['run:{"n":1}']);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test("T10d (F3) a cancel while the clear's write hangs: released at once, the call never runs", async () => {
    // Mutation: no abort check after the awaited clear → c1 runs after the cancel.
    const runs: string[] = [];
    const store = new SpyStore();
    store.hold = true;
    const r = rig([text("done")], () => [tool("run", "none", runs)], store);
    const restored = r.host.restore(reread(alone()));
    await tick(5);
    restored.cancel();
    await until(() => !restored.running);
    expect(runs).toEqual([]);
    store.hold = false;
    store.release();
  });

  test("T5 sequential pinned: a multi-call round never writes inFlight; each ask is its own group", async () => {
    // Mutation: call beforeRun for a group of one → an `inFlight` appears in a save.
    // A call alone writes the v7 entry shape (no `groupStart`: absent = itself).
    const runs: string[] = [];
    const r = rig(
      [[call("c1", "run", { n: 1 }), call("c2", "run", { n: 2 }), { type: "done" }], text("ok")],
      () => [tool("run", "ask", runs)],
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await hosted.persisted();
    const entries = reread(r.store.durable.get(hosted.id)).turn?.pending;
    expect(entries?.map((p) => [p.toolCallId, p.resumable, "groupStart" in p])).toEqual([
      ["c1", true, false],
    ]);
    c.allow(hosted);
    await until(() => c.asks[0]?.toolCallId === "c2");
    c.allow(hosted);
    await until(() => c.ended("T1"));
    expect(runs).toEqual(['run:{"n":1}', 'run:{"n":2}']);
    expect(r.store.saves.some((s) => s.turn?.inFlight !== undefined)).toBe(false);
  });
});

// --- the group executor against the real daemon (docs/feat/parallel-tools.md) ---

describe("parallel tools: groups on the real daemon (T-F3, T-D1)", () => {
  const readOnly = { mode: "read-only", maxParallel: 8 } as const;
  /** A read-class `run` tool (it may share a group); `during` observes the disk mid-run. */
  const readTool = (runs: string[], during?: () => Promise<void> | void): Tool => ({
    ...tool("run", "none", runs, during),
    concurrency: () => [{ mode: "read", resource: "r" }],
  });
  const resumedGroup = (): DaemonSessionRecord =>
    reread({
      id: "s",
      cwd: CWD,
      model: "m",
      createdAt: 1,
      updatedAt: 2,
      title: "t",
      kind: "tentacle.daemon-session",
      schemaVersion: 8,
      lastActiveAt: 2,
      enqueueIds: [],
      returned: [],
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "run", arguments: '{"n":1}' },
            { id: "c2", name: "run", arguments: '{"n":2}' },
          ],
        },
      ],
      turns: [{ turnId: "T1" }],
      turn: {
        turnId: "T1",
        steering: [],
        steeringIds: [],
        pending: [
          { toolCallId: "c2", tool: "run", resumable: true, requestedAt: 1, groupStart: "c1" },
        ],
      },
    });
  /** A store whose writes of an in-flight set fail (beforeRun → false); the rest land. */
  class NoInFlightStore extends SpyStore {
    override save(record: Parameters<RecordStore["save"]>[0]): Promise<void> {
      if ((record as DaemonSessionRecord).turn?.inFlight !== undefined) {
        this.saves.push(JSON.parse(JSON.stringify(record)) as DaemonSessionRecord);
        return Promise.reject(new Error("disk full"));
      }
      return super.save(record);
    }
  }
  const snapshot = (store: SpyStore, id = "s") => {
    const durable = store.durable.get(id);
    return durable ? reread(durable) : undefined;
  };

  test("T-F3a a resumed group, no asks, beforeRun lands: while the tools run the disk holds inFlight and never resumes", async () => {
    const runs: string[] = [];
    const seen: { resume?: string; inFlight?: readonly string[] }[] = [];
    const store = new SpyStore();
    const r = rig(
      [text("done")],
      () => [
        readTool(runs, () => {
          const rec = snapshot(store);
          const resume = rec ? reconcileOnReload(rec).resume?.from : "nothing durable";
          seen.push({
            ...(resume !== undefined ? { resume } : {}),
            ...(rec?.turn?.inFlight ? { inFlight: rec.turn.inFlight } : {}),
          });
        }),
      ],
      store,
      Date.now,
      {},
      { toolExecution: readOnly },
    );
    const restored = r.host.restore(resumedGroup());
    await until(() => !restored.running);
    expect(runs.sort()).toEqual(['run:{"n":1}', 'run:{"n":2}']);
    expect(seen).toEqual([{ inFlight: ["c1", "c2"] }, { inFlight: ["c1", "c2"] }]);
    await restored.persisted();
    expect(snapshot(store)?.turn?.inFlight).toBeUndefined();
  });

  test("T-F3b the same with beforeRun → false: while c1 runs (one at a time) the disk does not resume", async () => {
    // Mutation: skip the F3 hook in the group path → the disk still resumes from c1.
    const runs: string[] = [];
    const seen: (string | undefined)[] = [];
    const store = new NoInFlightStore();
    const r = rig(
      [text("done")],
      () => [
        readTool(runs, () => {
          const rec = snapshot(store);
          seen.push(rec ? reconcileOnReload(rec).resume?.from : "nothing durable");
        }),
      ],
      store,
      Date.now,
      {},
      { toolExecution: readOnly },
    );
    const restored = r.host.restore(resumedGroup());
    await until(() => !restored.running);
    expect(runs).toEqual(['run:{"n":1}', 'run:{"n":2}']);
    expect(seen).toEqual([undefined, undefined]);
    expect(r.errors.length).toBeGreaterThan(0); // the failed inFlight write is reported
  });

  test("T-F3c a cancel while the F3 write hangs in a group: no call starts", async () => {
    const runs: string[] = [];
    const store = new SpyStore();
    store.hold = true;
    const r = rig(
      [text("done")],
      () => [readTool(runs)],
      store,
      Date.now,
      {},
      {
        toolExecution: readOnly,
      },
    );
    const restored = r.host.restore(resumedGroup());
    await tick(5);
    restored.cancel();
    await until(() => !restored.running);
    expect(runs).toEqual([]);
    store.hold = false;
    store.release();
  });

  test("T-F3d a hook force-allows an `ask` tool in a resumed group: the hold still runs first", async () => {
    // F3 Review finding 1: the allow without an ask may come from a hook.
    const runs: string[] = [];
    const seen: (string | undefined)[] = [];
    const store = new SpyStore();
    const hookEnv = {
      exec: async () => ({ stdout: '{"decision":"allow"}', stderr: "", exitCode: 0 }),
    } as unknown as ExecutionEnvironment;
    const r = rig(
      [text("done")],
      () => [
        {
          ...tool("run", "ask", runs, () => {
            const rec = snapshot(store);
            seen.push(rec ? reconcileOnReload(rec).resume?.from : "nothing durable");
          }),
          concurrency: () => [{ mode: "read", resource: "r" }],
        },
      ],
      store,
      Date.now,
      {},
      {
        toolExecution: readOnly,
        hooks: new HookRunner({
          specs: [{ event: "tool_call", command: "allow" }],
          env: hookEnv,
          cwd: CWD,
        }),
      },
    );
    const c = client();
    const restored = r.host.restore(resumedGroup());
    restored.attach(c.attachment);
    await until(() => !restored.running);
    expect(c.asks).toEqual([]);
    expect(runs.sort()).toEqual(['run:{"n":1}', 'run:{"n":2}']);
    expect(seen).toEqual([undefined, undefined]);
  });

  test("T-D1 a live group: inFlight durable while it runs, a reload labels exactly, gone after the commit; a failed write → one at a time", async () => {
    const runs: string[] = [];
    const release = Promise.withResolvers<void>();
    const store = new SpyStore();
    const r = rig(
      [
        [
          call("c1", "run", { n: 1 }),
          call("c2", "run", { n: 2 }),
          call("c3", "x"),
          { type: "done" },
        ],
        text("ok"),
      ],
      () => [
        readTool(runs, async () => {
          await release.promise;
        }),
        tool("x", "none", runs),
      ],
      store,
      Date.now,
      {},
      { toolExecution: readOnly },
    );
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => runs.length === 2);
    const mid = snapshot(store, hosted.id);
    release.resolve();
    await until(() => c.ended("T1"));
    expect(mid?.turn?.inFlight).toEqual(["c1", "c2"]);
    expect(
      shape(mid ? reconcileOnReload(mid).messages : []).filter((s) => s.startsWith("tool(")),
    ).toEqual([
      `tool(c1):${INTERRUPTED_NOTE}`,
      `tool(c2):${INTERRUPTED_NOTE}`,
      `tool(c3):${NOT_RUN_NOTE}`,
    ]);
    await hosted.persisted();
    expect(reread(store.durable.get(hosted.id)).turn).toBeUndefined();
    expect(store.saves.filter((s) => s.turn?.inFlight !== undefined).length).toBe(1);

    // A failed inFlight write: one at a time.
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const failing = new NoInFlightStore();
    const r2 = rig(
      [[call("c1", "run", { n: 1 }), call("c2", "run", { n: 2 }), { type: "done" }], text("ok")],
      () => [
        readTool(order, async () => {
          if (order.length === 1) await gate.promise;
        }),
      ],
      failing,
      Date.now,
      {},
      { toolExecution: readOnly },
    );
    const c2 = client();
    const second = r2.host.open({ create: true }, c2.attachment).hosted;
    second.prompt("T1", go);
    await until(() => order.length === 1);
    await tick(5);
    expect(order).toEqual(['run:{"n":1}']);
    gate.resolve();
    await until(() => c2.ended("T1"));
    expect(order).toEqual(['run:{"n":1}', 'run:{"n":2}']);
  });
});
