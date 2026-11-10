import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SessionRecord } from "@tentacle/agent";
import { ChannelError, type RemoteSession } from "@tentacle/client";
import type {
  BackgroundJob,
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  PermissionRequester,
  StreamEvent,
  ToolContext,
} from "@tentacle/core";
import { DISMISSED, PermissionBroker } from "@tentacle/core";
import {
  Connection,
  ENDED_INTERRUPTED_NOTE,
  ENDED_TURN_NOTE,
  LogSessionStore,
  ProxyModelProvider,
  SessionHost,
  currentSegment,
  failedTurnNote,
  parseLogFile,
} from "@tentacle/daemon";
import { DomainErrorCode } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { createLocalRuntime, persistingController } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { saveFixture } from "./session-fixture.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

/** A JobController whose exits are fired manually, for testing the live stream. */
class FakeJobs implements JobController {
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read(): undefined {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [];
  }
  dispose(): void {}
  onStart(): () => void {
    return () => {};
  }
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fire(job: BackgroundJob): void {
    for (const listener of this.listeners) {
      listener(job);
    }
  }
}

/** Wire a daemon (SessionHost+Connection) to a client channel over an in-memory pipe. */
function daemon(
  model: ModelProvider,
  jobs?: JobController,
  tools: ToolRegistry = new ToolRegistry(),
): {
  channel: ReturnType<typeof createChannelPair>[1];
  dispose: () => void;
  host: SessionHost;
} {
  const host = new SessionHost({
    defaultCwd: "/tmp/work",
    createAgent: () => ({
      agent: new Agent({ model, tools, env: noopEnv }),
      permissions: new PermissionBroker(),
      ...(jobs ? { jobs } : {}),
    }),
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  return { channel: clientCh, dispose: () => connection.close(), host };
}

const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-local-rt-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createLocalRuntime (local over RPC)", () => {
  test("a non-fatal laptop-peer error (stray daemon frame) reaches onPeerError, never vanishes", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    const daemonPeer = new RpcPeer(daemonCh, {
      onRequest: () => ({
        protocolVersion: 1,
        agentCapabilities: { tools: true, permissions: true },
      }),
    });
    const errors: string[] = [];
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => daemonPeer.close(),
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "peer-error")), () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
      onPeerError: (error) => errors.push(error.message),
    });
    daemonPeer.notify("$/bogus", {}); // unknown to the laptop: reported, not fatal
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual(["unknown notification: $/bogus"]);
    runtime.dispose();
  });

  test("sessions outlive the connection, so the runtime closes them: /clear closes the old one, dispose the rest", async () => {
    // Mutations: drop `closeSessions` from `dispose`; drop the controller's `close` forward.
    const model = new ScriptedProvider([
      [{ type: "text", delta: "a" }, { type: "done" }],
      [{ type: "text", delta: "b" }, { type: "done" }],
    ]);
    const { channel, dispose, host } = daemon(model);
    let transportClosed = false;
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: () => {
        transportClosed = true;
        dispose();
      },
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "close")), () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });
    const first = runtime.createSession();
    await drain(first.send("one"));
    expect(host.size).toBe(1);
    first.close?.(); // the TUI's /clear
    const second = runtime.createSession();
    await drain(second.send("two"));
    await new Promise((r) => setTimeout(r, 20));
    expect(host.size).toBe(1); // only the second one is live
    await runtime.dispose();
    expect(host.size).toBe(0);
    expect(transportClosed).toBe(true);
  });

  test("R6 release: the session stays live with nobody attached; session/detach, never session/close", async () => {
    // Mutation: `release = dispose` → the session is closed.
    const model = new ScriptedProvider([[{ type: "text", delta: "a" }, { type: "done" }]]);
    const { channel, dispose, host } = daemon(model);
    const frames: string[] = [];
    let transportClosed = false;
    const runtime = await createLocalRuntime({
      channel: {
        ...channel,
        send: (frame) => {
          frames.push(frame);
          channel.send(frame);
        },
      },
      disposeTransport: () => {
        transportClosed = true;
        dispose();
      },
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "release")), () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });
    const session = runtime.createSession();
    await drain(session.send("one"));
    await runtime.release();
    expect(host.size).toBe(1);
    expect(host.list({}).sessions[0]?.attached).toBe(0);
    expect(frames.some((frame) => frame.includes('"session/detach"'))).toBe(true);
    expect(frames.some((frame) => frame.includes('"session/close"'))).toBe(false);
    expect(transportClosed).toBe(true);
  });

  test("R6 sessionJobs: the session's running jobs; null when it is unknown or the list fails", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const jobs = new FakeJobs();
    jobs.list = () => [{ id: "j", command: "c", status: "running", exitCode: null, startedAt: 1 }];
    const { channel, dispose } = daemon(model, jobs);
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "jobs")), () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    await drain(runtime.createSession().send("one"));
    expect(await runtime.sessionJobs("11111111-1111-4111-8111-111111111111")).toBe(1);
    expect(await runtime.sessionJobs("no-such-session")).toBeNull();
    expect(await runtime.residentUse("11111111-1111-4111-8111-111111111111")).toEqual({
      jobs: 1,
      running: false,
      others: 0,
    });
    expect(await runtime.residentUse("no-such-session")).toBeNull();
    await runtime.dispose();
    expect(await runtime.sessionJobs("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(await runtime.residentUse("11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  test("R8 sessionId: the first session's record carries it, a second one gets a fresh id", async () => {
    // Mutation: ignore `sessionId` → the record has a random id.
    const id = "22222222-2222-4222-8222-222222222222";
    const model = new ScriptedProvider([
      [{ type: "text", delta: "a" }, { type: "done" }],
      [{ type: "text", delta: "b" }, { type: "done" }],
    ]);
    const { channel, dispose } = daemon(model);
    const store = new LogSessionStore(join(dir, "session-id"));
    const saver = new SessionSaver(store, () => {});
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
      sessionId: id,
    });
    await drain(runtime.createSession().send("one"));
    await drain(runtime.createSession().send("two"));
    await runtime.dispose();
    await saver.drain();
    const ids = (await store.loadAll()).records.map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(id);
  });

  test("persists the session after a turn, under a stable uid", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "hi back" }, { type: "done" }]]);
    const { channel, dispose } = daemon(model);
    const store = new LogSessionStore(join(dir, "a"));
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver: new SessionSaver(store, () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });

    await drain(runtime.createSession().send("hello"));
    // Give the post-turn snapshot/persist a tick to land.
    await new Promise((r) => setTimeout(r, 20));

    const saved = (await store.loadAll()).records;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.messages.map((m) => m.content)).toEqual(["hello", "hi back"]);
    expect(saved[0]?.title).toBe("hello");
    runtime.dispose();
  });

  test("the turn's save is on disk once the saver drains — no sleep, no lost write at exit", async () => {
    // Mutation: drop `deps.saver.save(...)` from the persist callback → no file.
    const model = new ScriptedProvider([[{ type: "text", delta: "bye" }, { type: "done" }]]);
    const { channel, dispose } = daemon(model);
    const store = new LogSessionStore(join(dir, "drain"));
    const saver = new SessionSaver(store, () => {});
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });
    await drain(runtime.createSession().send("last words"));
    await runtime.dispose();
    expect(await saver.drain()).toEqual([]);
    const saved = (await store.loadAll()).records;
    expect(saved.map((r) => r.messages.map((m) => m.content))).toEqual([["last words", "bye"]]);
  });

  test("sub-agent progress crosses the wire: start, tool, usage, end reach the client between tool_start and tool_result", async () => {
    // docs/feat/subagent-progress-wire.md. Mutation: map the subagent_* events to
    // null again in the daemon's eventToUpdate → no subagent_* events here.
    const ARGS = '{"command":"x"}'; // valid for the borrowed shell input schema
    const probe = {
      ...shellTool,
      name: "agent_task",
      permission: "none" as const,
      async execute(_input: unknown, ctx: ToolContext) {
        ctx.emitProgress?.({ kind: "subagent_start", agentType: "explore", description: "find" });
        ctx.emitProgress?.({ kind: "subagent_tool", label: "Read a.ts" });
        ctx.emitProgress?.({ kind: "subagent_usage", promptTokens: 40, completionTokens: 2 });
        ctx.emitProgress?.({ kind: "subagent_end", toolUses: 1, stopReason: "end_turn" });
        return { content: "report" };
      },
    };
    const model = new ScriptedProvider([
      [
        { type: "tool_call", toolCall: { id: "p1", name: "agent_task", arguments: ARGS } },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { channel, dispose } = daemon(model, undefined, new ToolRegistry().register(probe));
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "progress")), () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });
    const seen: unknown[] = [];
    for await (const event of runtime.createSession().send("go")) {
      if (event.type.startsWith("subagent_") || event.type.startsWith("tool_")) {
        seen.push(event.type === "tool_result" ? event.type : event);
      }
    }
    expect(seen).toEqual([
      { type: "tool_start", id: "p1", name: "agent_task", arguments: ARGS },
      // The start signal crossed the wire too (docs/feat/parallel-tools.md).
      { type: "tool_phase", id: "p1", phase: "running" },
      { type: "subagent_start", id: "p1", agentType: "explore", description: "find" },
      { type: "subagent_tool", id: "p1", label: "Read a.ts" },
      { type: "subagent_usage", id: "p1", promptTokens: 40, completionTokens: 2 },
      { type: "subagent_end", id: "p1", toolUses: 1, stopReason: "end_turn" },
      "tool_result",
    ]);
    runtime.dispose();
  });

  test("R-U1/L-1 unflushedExits: 0 before attachTo, the daemon's count after, 0 once a turn flushed them", async () => {
    // docs/fix/attach-unflushed-exits.md, end to end over the real SessionHost +
    // Connection. Mutation: `Connection.open` omits the field (or `unflushedExits`
    // returns 0) → the middle leg fails.
    const jobs = new FakeJobs();
    const model = new ScriptedProvider([]);
    const host = new SessionHost({
      defaultCwd: "/tmp/work",
      createAgent: () => ({
        agent: new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs }),
        permissions: new PermissionBroker(),
        jobs,
      }),
    });
    const runtimeOn = async (name: string) => {
      const [daemonCh, clientCh] = createChannelPair();
      const connection = new Connection(daemonCh, host);
      return createLocalRuntime({
        channel: clientCh,
        disposeTransport: () => connection.close(),
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, name)), () => {}),
        cwd: "/tmp/work",
        model: "qwen3",
        resume: null,
        sessionId: "S1",
        shared: true,
      });
    };
    const a = await runtimeOn("uf-a");
    await drain(a.createSession().send("hi"));
    jobs.fire({ id: "j1", command: "sleep 1", startedAt: 0, status: "exited", exitCode: 0 });
    const b = await runtimeOn("uf-b");
    expect(b.unflushedExits()).toBe(0);
    expect(await b.attachTo("S1", null)).toBe(true);
    expect(b.unflushedExits()).toBe(1);
    await drain(b.createSession().send(""));
    const c = await runtimeOn("uf-c");
    expect(await c.attachTo("S1", null)).toBe(true);
    expect(c.unflushedExits()).toBe(0);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  test("streams a daemon background-job exit to the client's jobs view while idle", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const jobs = new FakeJobs();
    const { channel, dispose } = daemon(model, jobs);
    const store = new LogSessionStore(join(dir, "jobs"));
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver: new SessionSaver(store, () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });

    const received: BackgroundJob[] = [];
    runtime.jobs.onExit((job) => received.push(job));

    // Open the session + finish its turn, so the daemon has subscribed to jobs.
    await drain(runtime.createSession().send("hi"));
    // Now, with NO turn running (idle), a background job exits on the daemon.
    jobs.fire({
      id: "j1",
      command: "sleep 1",
      startedAt: Date.now(),
      status: "exited",
      exitCode: 0,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(received.map((j) => j.id)).toEqual(["j1"]);
    expect(received[0]?.exitCode).toBe(0);
    expect(received[0]?.status).toBe("exited");
    runtime.dispose();
  });

  test("resumes a saved session: seeds history and keeps the same uid file", async () => {
    const store = new LogSessionStore(join(dir, "b"));
    // First run creates a session.
    const model1 = new ScriptedProvider([[{ type: "text", delta: "one" }, { type: "done" }]]);
    const d1 = daemon(model1);
    const rt1 = await createLocalRuntime({
      channel: d1.channel,
      disposeTransport: d1.dispose,
      permissions: new PermissionBroker(),
      saver: new SessionSaver(store, () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });
    await drain(rt1.createSession().send("first question"));
    await new Promise((r) => setTimeout(r, 20));
    const record = (await store.loadAll()).records[0] ?? null;
    expect(record).not.toBeNull();
    rt1.dispose();

    // Second run resumes it.
    const model2 = new ScriptedProvider([[{ type: "text", delta: "two" }, { type: "done" }]]);
    const d2 = daemon(model2);
    const rt2 = await createLocalRuntime({
      channel: d2.channel,
      disposeTransport: d2.dispose,
      permissions: new PermissionBroker(),
      saver: new SessionSaver(store, () => {}),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: record,
    });
    await drain(rt2.createSession().send("second question"));
    await new Promise((r) => setTimeout(r, 20));

    // The model saw the resumed history before the new turn.
    expect(model2.requests[0]?.messages.map((m) => m.content)).toEqual([
      "first question",
      "one",
      "second question",
    ]);
    // And it was saved back under the SAME uid (one file, not two).
    const all = (await store.loadAll()).records;
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(record?.id ?? "");
    rt2.dispose();
  });

  test("F1 a session deleted from another device: never recreated, the local copy is removed, the TUI is told", async () => {
    // Mutation: drop the `onSessionDeleted` subscription → no notice, the file stays.
    const model = new ScriptedProvider([]);
    const { channel, dispose, host } = daemon(model);
    // Another device had S on this daemon and deleted it: tombstoned.
    host.open({ sessionId: "S", create: true }, { send: () => {} });
    expect(host.delete("S")).toBe(true);
    const store = new LogSessionStore(join(dir, "deleted-elsewhere"));
    const record = {
      id: "S",
      cwd: "/tmp/work",
      model: "qwen3",
      createdAt: 1,
      updatedAt: 1,
      title: "mine",
      messages: [{ role: "user" as const, content: "mine" }],
    };
    await saveFixture(store, record);
    const notices: string[] = [];
    const saver = new SessionSaver(store, (t) => notices.push(t));
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver,
      notify: (t) => notices.push(t),
      cwd: "/tmp/work",
      model: "qwen3",
      resume: record,
    });
    const failed = await drain(runtime.createSession().send("again")).then(
      () => null,
      (error: Error) => error,
    );
    expect(failed).not.toBeNull();
    await runtime.dispose();
    expect(await saver.drain()).toEqual([]);
    expect(notices).toEqual([
      "⚠ This session was deleted from another device: it was not restored, and its local copy was removed.",
    ]);
    expect((await store.load("S")).status).toBe("absent");
    expect(host.get("S")).toBeUndefined();
    expect(model.requests).toHaveLength(0);
  });

  test("persistingController.enqueue propagates the inner Promise (resolves AND rejects)", async () => {
    // A stub session whose enqueue resolves — the controller must return that
    // very Promise (not swallow it) so the TUI can await/reconcile it.
    const seen: string[] = [];
    const okInner: RemoteSession = {
      enqueue: (text: string) =>
        Promise.resolve().then(() => {
          seen.push(text);
        }),
      readBack: async () => null,
      onTitle: () => () => {},
      compact: async () => ({ before: 0, after: 0 }),
    } as unknown as RemoteSession;

    const okCtl = persistingController(okInner, () => {});
    const okEnqueue = okCtl.enqueue;
    await expect(okEnqueue?.("hello")).resolves.toBeUndefined();
    expect(seen).toEqual(["hello"]);

    // And a rejecting inner must propagate the rejection (the TUI reconciles).
    const rejInner: RemoteSession = {
      enqueue: () => Promise.reject(new Error("method not found")),
      readBack: async () => null,
      onTitle: () => () => {},
      compact: async () => ({ before: 0, after: 0 }),
    } as unknown as RemoteSession;
    const rejCtl = persistingController(rejInner, () => {});
    const rejEnqueue = rejCtl.enqueue;
    await expect(rejEnqueue?.("nope")).rejects.toThrow(/method not found/);
  });

  // docs/feat/send-now-b.md: the send-now turn is saved like a `send` turn.
  test("persistingController.sendNow: forwarded as is, saved once after the new turn settles", async () => {
    const log: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = {
      sendNow: async (messages: readonly { id: string; text: string }[], target: string) => {
        log.push(`sendNow:${messages.map((m) => `${m.id}=${m.text}`).join(",")}:${target}`);
        return (async function* () {
          yield { type: "user_message", text: "A" };
          await gate;
          yield { type: "turn_end", reason: "end_turn" };
        })();
      },
      enqueue: async (text: string, id?: string) => {
        log.push(`enqueue:${text}:${id}`);
      },
      readBack: async () => {
        log.push("snapshot");
        return { messages: [{ role: "user", content: "A" }] };
      },
      onTitle: () => () => {},
    } as unknown as RemoteSession;
    const saved: string[][] = [];
    const ctl = persistingController(inner, (m) => saved.push(m.map((x) => String(x.content))));
    await ctl.enqueue("A", "a");
    const events = await ctl.sendNow([{ id: "a", text: "A" }], "turn");
    const it = events[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: "user_message", text: "A" });
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(["enqueue:A:a", "sendNow:a=A:turn"]); // no save mid-turn
    release();
    expect((await it.next()).value).toEqual({ type: "turn_end", reason: "end_turn" });
    expect((await it.next()).done).toBe(true);
    await ctl.flushed();
    expect(log.filter((l) => l === "snapshot")).toHaveLength(1);
    expect(saved).toEqual([["A"]]);
  });

  test("R9 synchrony: the idle notification starts the post-turn save in the same tick — saveConfirmed is false at once, true only after that save", async () => {
    // docs/fix/detach-live-followups.md round 3 (review finding 1). The other half
    // of the property is `client/test/idle-sync.test.ts` (the listeners run inside
    // the update that ends the turn). Mutation (local-runtime.ts, the `onIdle`
    // subscription): `flush()` → `queueMicrotask(flush)` → `true` right after.
    const listeners: (() => void)[] = [];
    let busy = true;
    const inner = {
      get busy() {
        return busy;
      },
      onIdle: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
      onTitle: () => () => {},
      readBack: async () => ({ messages: [{ role: "user", content: "a" }] }),
    } as unknown as RemoteSession;
    const saved: number[] = [];
    const ctl = persistingController(inner, (messages) => saved.push(messages.length));
    expect(ctl.saveConfirmed()).toBe(false); // a turn runs on the daemon
    busy = false; // its end, as `RemoteSession`'s setter applies it …
    for (const listener of listeners) {
      listener(); // … then calls the idle listeners, synchronously
    }
    expect(ctl.saveConfirmed()).toBe(false); // the laptop does not hold its end yet
    await ctl.flushed();
    expect(saved).toEqual([1]);
    expect(ctl.saveConfirmed()).toBe(true);
  });

  test("T37 (M5): a sub-agent's exit while idle reaches the laptop's log — one read-back, none without it", async () => {
    // docs/feat/subagent-background.md. A report that ends while nobody streams
    // would sit in the daemon's history only. Mutation: remove the
    // `onAgentExit` subscription → no read-back → red.
    const agentExit: (() => void)[] = [];
    let unsubscribed = 0;
    let reads = 0;
    const inner = {
      busy: false,
      onTitle: () => () => {},
      onAgentExit: (listener: () => void) => {
        agentExit.push(listener);
        return () => {
          unsubscribed++;
        };
      },
      readBack: async () => {
        reads++;
        return { messages: [{ role: "user", content: "a" }] };
      },
      close: () => {},
    } as unknown as RemoteSession;
    const saved: number[] = [];
    const ctl = persistingController(inner, (messages) => saved.push(messages.length));
    await ctl.flushed();
    expect(reads).toBe(0);
    for (const listener of agentExit) {
      listener();
    }
    expect(ctl.saveConfirmed()).toBe(false); // a change to save, noted in the same tick
    await ctl.flushed();
    expect(reads).toBe(1);
    expect(saved).toEqual([1]);
    expect(ctl.saveConfirmed()).toBe(true);
    ctl.close?.();
    expect(unsubscribed).toBe(1);
  });

  test("T-B12 persistingController: a foreign turn's end and an idle history each cause one save (docs/feat/tui-foreign-turns.md B8)", async () => {
    let snapshots = 0;
    let raise: (a: unknown) => void = () => {};
    const inner = {
      watch: (listener: (a: unknown) => void) => {
        raise = listener;
        return () => {};
      },
      readBack: async () => {
        snapshots += 1;
        return { messages: [{ role: "user", content: "theirs" }] };
      },
      onTitle: () => () => {},
    } as unknown as RemoteSession;
    const saved: string[][] = [];
    const ctl = persistingController(inner, (m) => saved.push(m.map((x) => String(x.content))));
    const seen: { kind: string; events?: AsyncIterable<unknown> }[] = [];
    // Optional on purpose: before the hooks the controller had no `watch` (RED: no save).
    (ctl as { watch?: (l: (a: { kind: string }) => void) => () => void }).watch?.((a) =>
      seen.push(a),
    );
    raise({
      kind: "turn",
      turnId: "X",
      cancel: () => {},
      events: (async function* () {
        yield { type: "user_message", text: "theirs" };
        yield { type: "turn_end", reason: "end_turn" };
      })(),
    });
    const [turn] = seen;
    if (turn?.events) await drain(turn.events);
    await ctl.flushed();
    expect(snapshots).toBe(1);
    raise({ kind: "history", messages: [], reason: null });
    await ctl.flushed();
    expect(snapshots).toBe(2);
    expect(saved).toEqual([["theirs"], ["theirs"]]);
    expect(seen.map((a) => a.kind)).toEqual(["turn", "history"]);
  });

  test("persistingController.sendNow: a refusal and a cancel-before-start save nothing", async () => {
    const refusal = Object.assign(new Error("unknown method: session/send_now"), { code: -32601 });
    const cancelled = new Error("send-now cancelled before it started");
    let snapshots = 0;
    let next: "refuse" | "cancel" = "refuse";
    const inner = {
      sendNow: async () => {
        if (next === "refuse") throw refusal;
        return {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(cancelled) }),
        };
      },
      readBack: async () => {
        snapshots += 1;
        return { messages: [] };
      },
      onTitle: () => () => {},
    } as unknown as RemoteSession;
    const ctl = persistingController(inner, () => {});
    // The very error, untouched: the caller falls back on its code.
    await expect(ctl.sendNow([{ id: "a", text: "A" }], "turn")).rejects.toBe(refusal);
    next = "cancel";
    const events = await ctl.sendNow([{ id: "a", text: "A" }], "turn");
    await expect(drain(events)).rejects.toBe(cancelled);
    await ctl.flushed();
    expect(snapshots).toBe(0);
  });

  // docs/feat/client-reattach-frontends.md §6: the post-turn save is detached
  // (a drop before its snapshot must not hold the turn open), serialized and
  // coalesced, and its failure is reported, never thrown.
  function heldInner() {
    const log: string[] = [];
    const held: {
      resolve: (m: { role: "user"; content: string }[]) => void;
      reject: (e: Error) => void;
    }[] = [];
    const inner = {
      async *send(prompt: string) {
        log.push(`send:${prompt}`);
        yield { type: "text", delta: prompt };
      },
      readBack: () =>
        new Promise((resolve, reject) => {
          log.push("snapshot");
          held.push({ resolve: (messages) => resolve({ messages }), reject });
        }),
      onTitle: () => () => {},
      compact: async () => ({ before: 2, after: 1 }),
      enqueue: async () => {},
      close: () => {
        log.push("close");
      },
    } as unknown as RemoteSession;
    return { inner, log, held };
  }

  test("T16 (clear-keeps-jobs): clear saves the new segment — a read-back starts right after it", async () => {
    // Mutation: drop `flush()` after `inner.clear()` → no snapshot is read.
    const { inner, held } = heldInner();
    const saved: string[][] = [];
    const ctl = persistingController(
      { ...inner, clear: async () => ({ before: 2, after: 0 }) } as unknown as RemoteSession,
      (m) => saved.push(m.map((x) => String(x.content))),
    );
    // `/clear` reads the chat first (the copy a fork is made from,
    // docs/feat/clear-fork-history.md): that read is answered, then the clear
    // runs, then a SECOND read saves the new segment.
    const clearing = ctl.clear?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(held).toHaveLength(1);
    held[0]?.resolve([{ role: "user", content: "old" }]);
    expect(await clearing).toEqual({ before: 2, after: 0 });
    expect(held).toHaveLength(2);
    held[1]?.resolve([{ role: "user", content: "note" }]);
    await ctl.flushed();
    expect(saved).toEqual([["old"], ["note"]]);
  });

  test("detached save: send ends while the post-turn snapshot is still pending", async () => {
    const { inner, held } = heldInner();
    const saved: string[][] = [];
    const ctl = persistingController(inner, (m) => saved.push(m.map((x) => String(x.content))));
    await drain(ctl.send("one"));
    expect(held).toHaveLength(1); // the turn is over; its save still waits
    held[0]?.resolve([{ role: "user", content: "one" }]);
    await ctl.flushed();
    expect(saved).toEqual([["one"]]);
  });

  test("R6 saveConfirmed: false mid-turn, while the read waits, after a failed read and after an attach; true once a read answered", async () => {
    // The exit net's check (docs/fix/detach-live.md R6). Mutations: drop `turns`,
    // drop `running`, or keep `confirmed` true after a failed read → one line fails.
    const { inner, held } = heldInner();
    const ctl = persistingController(
      { ...inner, open: async () => {} } as unknown as RemoteSession,
      () => {},
    );
    expect(ctl.saveConfirmed()).toBe(true); // nothing sent: nothing to lose
    const it = ctl.send("one")[Symbol.asyncIterator]();
    await it.next();
    expect(ctl.saveConfirmed()).toBe(false); // the turn runs
    // A save that lands mid-turn (a title change) does not confirm a running turn.
    void ctl.saveNow();
    held[0]?.resolve([{ role: "user", content: "one" }]);
    await ctl.flushed();
    expect(ctl.saveConfirmed()).toBe(false);
    await it.next();
    expect(ctl.saveConfirmed()).toBe(false); // over, its read pending
    held[1]?.resolve([{ role: "user", content: "one" }]);
    await ctl.flushed();
    expect(ctl.saveConfirmed()).toBe(true);
    await drain(ctl.send("two"));
    held[2]?.reject(new Error("link down"));
    await ctl.flushed();
    expect(ctl.saveConfirmed()).toBe(false);
    void ctl.saveNow();
    await new Promise((r) => setTimeout(r, 5));
    expect(ctl.saveConfirmed()).toBe(false); // its read is pending
    held[3]?.resolve([{ role: "user", content: "two" }]);
    await ctl.flushed();
    expect(ctl.saveConfirmed()).toBe(true);
    await ctl.open();
    expect(ctl.saveConfirmed()).toBe(false); // live: the daemon's history is newer
  });

  test("R6 SessionSaver.clean: false while a write is pending and after a failed one", async () => {
    let fail = false;
    let release = () => {};
    const pending = () =>
      new Promise<void>((resolve, reject) => {
        release = () => (fail ? reject(new Error("disk full")) : resolve());
      });
    const saver = new SessionSaver(
      {
        write: pending,
        saveSnapshot: pending,
        remove: async () => {},
      } as unknown as ConstructorParameters<typeof SessionSaver>[0],
      () => {},
    );
    expect(saver.clean()).toBe(true);
    saver.write({ id: "s" } as unknown as Parameters<SessionSaver["write"]>[0]);
    expect(saver.clean()).toBe(false);
    fail = true;
    release();
    await saver.drain();
    expect(saver.clean()).toBe(false);
    fail = false;
    saver.save({ id: "s" } as unknown as Parameters<SessionSaver["save"]>[0]);
    release();
    await saver.drain();
    expect(saver.clean()).toBe(true);
  });

  test("detached save: serialized and coalesced — one read at a time, at most one more, newest wins", async () => {
    const { inner, held } = heldInner();
    const saved: string[][] = [];
    const ctl = persistingController(inner, (m) => saved.push(m.map((x) => String(x.content))));
    await drain(ctl.send("one"));
    await drain(ctl.send("two"));
    await drain(ctl.send("three"));
    expect(held).toHaveLength(1); // the 2nd and 3rd wait behind the 1st, as ONE read
    held[0]?.resolve([{ role: "user", content: "one" }]);
    await new Promise((r) => setTimeout(r, 5));
    expect(held).toHaveLength(2);
    held[1]?.resolve([
      { role: "user", content: "one" },
      { role: "user", content: "three" },
    ]);
    await ctl.flushed();
    expect(held).toHaveLength(2);
    expect(saved).toEqual([["one"], ["one", "three"]]);
  });

  test("detached save: a failed read is reported once per flush, never thrown", async () => {
    const { inner, held } = heldInner();
    const errors: string[] = [];
    const ctl = persistingController(
      inner,
      () => {},
      (e) => errors.push(e.message),
    );
    await drain(ctl.send("one")); // does not throw
    held[0]?.reject(new Error("connection closed"));
    await ctl.flushed();
    expect(errors).toEqual(["connection closed"]);
  });

  test("A3 seal: a read in flight that fails after it reports nothing; a later flush reads nothing; an ended session (UnknownSession) is no failure", async () => {
    // Mutations: `seal` only stops `flush` (the in-flight failure still
    // reports); `seal` a no-op; no ended-session rule.
    const { inner, held } = heldInner();
    const errors: string[] = [];
    const ctl = persistingController(
      inner,
      () => {},
      (e) => errors.push(e.message),
    );
    await drain(ctl.send("one"));
    ctl.seal(); // the quit took its last save; the close is next
    held[0]?.reject(new Error("connection closed"));
    await ctl.flushed();
    await drain(ctl.send("two")); // a turn ending under the close
    expect(held).toHaveLength(1);
    expect(errors).toEqual([]);

    const other = heldInner();
    const ended: string[] = [];
    const open = persistingController(
      other.inner,
      () => {},
      (e) => ended.push(e.message),
    );
    await drain(open.send("one"));
    other.held[0]?.reject(
      Object.assign(new Error("the session was closed"), { code: DomainErrorCode.UnknownSession }),
    );
    await open.flushed();
    expect(ended).toEqual([]);
  });

  test("detached save: /clear closes the session only after its pending save", async () => {
    const { inner, log, held } = heldInner();
    const ctl = persistingController(inner, () => {
      log.push("persist");
    });
    await drain(ctl.send("one"));
    ctl.close?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(["send:one", "snapshot"]); // not closed under its own save
    held[0]?.resolve([{ role: "user", content: "one" }]);
    await ctl.flushed();
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(["send:one", "snapshot", "persist", "close"]);
  });

  test("a save whose read fails reaches the saver as 'not saved' (notice + exit report)", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "x" }, { type: "done" }]]);
    const { channel, dispose } = daemon(model);
    const notices: string[] = [];
    const saver = new SessionSaver(new LogSessionStore(join(dir, "flush-fail")), (t) =>
      notices.push(t),
    );
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });
    const session = runtime.createSession();
    const turn = session.send("hello");
    // Consume the turn, then kill the daemon side before the save's read answers.
    for await (const _ of turn) {
      // consume
    }
    dispose();
    await runtime.dispose();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/not saved — could not read the history back: .*closed/);
    const report = await saver.drain();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatch(/^\[session\] not saved: /);
  });

  test("dispose right after a turn waits for its save, even a paged one (no close between two pages)", async () => {
    // 300 resumed messages → the snapshot takes two pages; a session/close sent
    // right after the turn would land between them (→ UnknownSession, not saved).
    const model = new ScriptedProvider([[{ type: "text", delta: "tail" }, { type: "done" }]]);
    const { channel, dispose } = daemon(model);
    const store = new LogSessionStore(join(dir, "paged"));
    const saver = new SessionSaver(store, () => {});
    const history = Array.from({ length: 300 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      saver,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: {
        id: "paged-uid",
        cwd: "/tmp/work",
        model: "qwen3",
        createdAt: 1,
        updatedAt: 1,
        title: "m0",
        messages: history,
      },
    });
    await drain(runtime.createSession().send("last"));
    await runtime.dispose();
    expect(await saver.drain()).toEqual([]);
    const saved = (await store.loadAll()).records;
    expect(saved[0]?.messages).toHaveLength(302);
  });

  test("detached save: a turn that failed before producing anything saves nothing (no false 'not saved')", async () => {
    // Real cluster, pod deleted: the next send fails at once with "the
    // connection target is gone"; reading the history back would fail too and
    // report a save failure although the disk is complete.
    const reads: string[] = [];
    const errors: string[] = [];
    const inner = {
      // biome-ignore lint/correctness/useYield: fails before its first event
      async *send() {
        throw new Error("the connection target is gone");
      },
      readBack: async () => {
        reads.push("snapshot");
        throw new Error("gone");
      },
      onTitle: () => () => {},
    } as unknown as RemoteSession;
    const ctl = persistingController(
      inner,
      () => {},
      (e) => errors.push(e.message),
    );
    await expect(drain(ctl.send("are you there?"))).rejects.toThrow(/gone/);
    await ctl.flushed();
    expect(reads).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/**
 * docs/feat/detached-handover.md: N laptop clients of ONE resident session.
 * A real `SessionHost` + `Connection{servesModel}` + the proxy model through
 * the newest link + an `ask` shell tool; each client is its own runtime with
 * its own broker, as each laptop process is.
 */
describe("N clients of one session (detached-handover)", () => {
  const UID = "55555555-5555-4555-8555-555555555555";
  /** A model whose call `n` (0-based) holds until `open(n)`; `started` counts calls. */
  class Held implements ModelProvider {
    readonly id = "held";
    started = 0;
    private readonly gates = new Map<number, () => void>();
    private readonly waits = new Map<number, Promise<void>>();
    constructor(
      private readonly script: readonly (readonly StreamEvent[])[],
      held: readonly number[] = [],
    ) {
      for (const n of held) {
        this.waits.set(
          n,
          new Promise<void>((r) => {
            this.gates.set(n, r);
          }),
        );
      }
    }
    open(n: number): void {
      this.gates.get(n)?.();
    }
    async *stream(): AsyncIterable<StreamEvent> {
      const n = this.started++;
      await this.waits.get(n);
      for (const event of this.script[n] ?? [{ type: "done" }]) {
        yield event;
      }
    }
  }
  const SHELL: readonly StreamEvent[] = [
    { type: "tool_call", toolCall: { id: "c1", name: "shell", arguments: '{"command":"x"}' } },
    { type: "done" },
  ];
  const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  /** `hangExec`: a tool runs until its turn is cancelled (a long tool). */
  function shared(hangExec = false) {
    const execs: string[] = [];
    const env: ExecutionEnvironment = {
      id: "noop",
      exec: (command, options) => {
        execs.push(command);
        if (!hangExec) {
          return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
        }
        return new Promise((resolve) => {
          (options as { signal?: AbortSignal } | undefined)?.signal?.addEventListener(
            "abort",
            () => resolve({ stdout: "", stderr: "killed", exitCode: 130 }),
            { once: true },
          );
        });
      },
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
    };
    const tools = new ToolRegistry().register(shellTool);
    const host = new SessionHost({
      defaultCwd: "/tmp/work",
      createAgent: (_cwd, { modelLink }) => {
        const permissions = new PermissionBroker();
        const link = () => {
          const l = modelLink();
          if (!l) throw new Error("no model link");
          return l;
        };
        const agent = new Agent({
          model: new ProxyModelProvider(
            (request) => link().requestModelStream(request),
            (request, handlers) => link().requestModelStreamChunked(request, handlers),
          ),
          tools,
          env,
          requestPermission: (req, opts) => permissions.request(req, opts),
        });
        return { agent, permissions };
      },
    });
    const connect = async (
      opts: {
        model?: ModelProvider;
        broker?: PermissionBroker;
        sessionId?: string;
        shared?: boolean;
        resume?: SessionRecord | null;
        errors?: string[];
        /** A frame that never reaches the daemon (a pod that stopped answering). */
        lose?: (frame: string) => boolean;
        /** Every write of the laptop copy fails (a full disk). */
        fullDisk?: boolean;
        /** Daemon frames arrive this many ms later, as over a real bridge. */
        latency?: number;
        /** A reconnecting client (a pod's), whose redial never completes. */
        factory?: boolean;
      } = {},
    ) => {
      const [daemonCh, clientCh] = createChannelPair();
      const connection = new Connection(daemonCh, host, () => {}, { servesModel: true });
      const frames: string[] = [];
      const store = new LogSessionStore(join(dir, `shared-${crypto.randomUUID()}`));
      const saver = new SessionSaver(
        opts.fullDisk
          ? {
              write: () => Promise.reject(new Error("ENOSPC")),
              saveSnapshot: () => Promise.reject(new Error("ENOSPC")),
              remove: () => Promise.resolve(),
            }
          : store,
        () => {},
      );
      const { latency } = opts;
      const runtime = await createLocalRuntime({
        channel: {
          ...clientCh,
          send: (frame) => {
            frames.push(frame);
            if (!opts.lose?.(frame)) {
              clientCh.send(frame);
            }
          },
          ...(latency
            ? {
                setOnMessage: (handler: (data: string) => void) =>
                  clientCh.setOnMessage((data: string) => {
                    setTimeout(() => handler(data), latency);
                  }),
              }
            : {}),
        },
        ...(opts.factory ? { channelFactory: () => new Promise<never>(() => {}) } : {}),
        disposeTransport: () => connection.close(),
        permissions: opts.broker ?? new PermissionBroker(),
        saver,
        cwd: "/tmp/work",
        model: "m",
        resume: opts.resume ?? null,
        modelProvider: opts.model ?? new ScriptedProvider([]),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.shared ? { shared: true as const } : {}),
        ...(opts.errors ? { onPeerError: (e: Error) => opts.errors?.push(e.message) } : {}),
      });
      return { runtime, frames, saver, store, connection };
    };
    return { host, connect, execs };
  }
  /** A requester that holds every ask and logs it, and its withdrawal. */
  const holding = (name: string, log: string[]) => {
    const answers: ((r: { allowed: boolean }) => void)[] = [];
    const requester: PermissionRequester = (req, options) => {
      log.push(`${name}:asked:${req.tool}`);
      return new Promise((resolve) => {
        answers.push(resolve);
        options?.signal?.addEventListener(
          "abort",
          () => {
            log.push(`${name}:withdrawn`);
            resolve(DISMISSED);
          },
          { once: true },
        );
      });
    };
    return {
      broker: new PermissionBroker(requester),
      answer: (allowed: boolean) => answers.at(-1)?.({ allowed }),
    };
  };
  const methods = (frames: readonly string[]): string[] =>
    frames.map((f) => (JSON.parse(f) as { method?: string }).method ?? "").filter((m) => m !== "");

  test("H2 attachTo opens the live session with no create and no messages; the next createSession is it, a later one fresh", async () => {
    // Mutation: `attachTo` opens with `create: true`.
    const pod = shared();
    const relay = await pod.connect({ sessionId: UID });
    await drain(relay.runtime.createSession().send("one"));
    const tui = await pod.connect({ shared: true });
    expect(await tui.runtime.attachTo(UID, null)).toBe(true);
    const open = tui.frames
      .map((f) => JSON.parse(f) as { method?: string; params?: Record<string, unknown> })
      .find((f) => f.method === "session/open");
    expect(open?.params).toEqual({ sessionId: UID });
    expect(pod.host.get(UID)?.attachedCount).toBe(2);
    expect(tui.runtime.createSession().sessionId).toBe(UID);
    expect(tui.runtime.createSession().sessionId).not.toBe(UID);
    expect(pod.host.size).toBe(1);
  });

  test("H3 attachTo an unknown id: false, nothing created, the seeded path still works; a deleted one rejects", async () => {
    // Mutation: `attachTo` swallows every error → the deleted id resolves false.
    const pod = shared();
    const record: SessionRecord = {
      id: UID,
      cwd: "/tmp/work",
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      title: "kept",
      messages: [{ role: "user", content: "from the laptop" }],
    };
    const tui = await pod.connect({
      shared: true,
      resume: record,
      sessionId: UID,
      model: new ScriptedProvider([[{ type: "done" }]]),
    });
    expect(await tui.runtime.attachTo(UID, record)).toBe(false);
    expect(pod.host.size).toBe(0);
    const seeded = tui.runtime.createSession();
    expect(seeded.sessionId).toBe(UID);
    await drain(seeded.send("again"));
    const snap = pod.host.get(UID)?.snapshotPage().messages ?? [];
    expect(snap[0]).toMatchObject({ role: "user", content: "from the laptop" });

    pod.host.delete(UID);
    const late = await pod.connect({ shared: true });
    await expect(late.runtime.attachTo(UID, null)).rejects.toBeDefined();
  });

  test("KO4 two TUIs on a session the pod no longer has (reopened after a close): ONE live session, A's turn reaches B and its record, A's close for all closes B, nothing re-seeded from a stale copy", async () => {
    // docs/fix/detach-live.md fix round 6 (live re-run KO 4). Mutation: the
    // seeded session stays lazy → B is on no session until its first send.
    const pod = shared();
    const record: SessionRecord = {
      id: UID,
      cwd: "/tmp/work",
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      title: "kept",
      messages: [{ role: "user", content: "from the laptop" }],
    };
    const model = new ScriptedProvider([[{ type: "done" }], [{ type: "done" }]]);
    const join = async () => {
      const c = await pod.connect({ shared: true, resume: record, sessionId: UID, model });
      if (!(await c.runtime.attachTo(UID, record))) {
        // What `joinRun` does on the seeded path (after the relay checks).
        await (c.runtime as { openSeeded?: () => Promise<void> }).openSeeded?.();
      }
      const session = c.runtime.createSession();
      const seen: string[] = [];
      session.watch((activity) => {
        seen.push(activity.kind);
        if (activity.kind === "turn") void drain(activity.events);
      });
      return { ...c, session, seen };
    };
    const a = await join();
    const b = await join();
    expect(pod.host.size).toBe(1);
    await drain(a.session.send("echo due"));
    await until(() => b.seen.includes("turn"), 500).catch(() => {});
    expect(b.seen).toContain("turn"); // B is on A's session: same view
    await b.session.flushed();
    await b.saver.drain();
    const saved = (await b.store.loadAll()).records.find((r) => r.id === UID);
    expect(JSON.stringify(saved?.messages ?? [])).toContain("echo due");
    await a.runtime.quit({ closeForAll: true });
    await until(() => b.seen.includes("closed"), 500).catch(() => {});
    expect(b.seen).toContain("closed"); // D1: B leaves too
    // B's next send never re-creates the session from its stale seed.
    await expect(drain(b.session.send("rispondi solo: ok"))).rejects.toBeDefined();
    expect(pod.host.get(UID)).toBeUndefined();
  });

  test("R8 openSeeded(record) seeds the session from THAT record, not the runtime's startup one", async () => {
    // docs/fix/detach-live.md fix round 7. Mutation: `openSeeded` ignores its
    // argument → a TUI whose join was slow re-creates the session from a stale copy.
    const pod = shared();
    const stale: SessionRecord = {
      id: UID,
      cwd: "/tmp/work",
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      title: "kept",
      messages: [{ role: "user", content: "stale" }],
    };
    const fresh: SessionRecord = {
      ...stale,
      updatedAt: 2,
      messages: [
        { role: "user", content: "stale" },
        { role: "user", content: "echo due" },
      ],
    };
    const tui = await pod.connect({ shared: true, resume: stale, sessionId: UID });
    expect(await tui.runtime.attachTo(UID, stale)).toBe(false);
    await tui.runtime.openSeeded(fresh);
    const snap = pod.host.get(UID)?.snapshotPage().messages ?? [];
    expect(snap.map((m) => m.content)).toEqual(["stale", "echo due"]);
  });

  describe("Q4 attach / open saves the session's current state and waits for the read-back", () => {
    /** A live session with one turn in the pod, left by its first client. */
    const live = async () => {
      const pod = shared();
      const first = await pod.connect({
        sessionId: UID,
        model: new ScriptedProvider([[{ type: "text", delta: "hi" }, { type: "done" }]]),
      });
      await drain(first.runtime.createSession().send("first turn"));
      await first.runtime.release();
      return pod;
    };

    test("attachTo: the laptop copy is written and saveConfirmed holds with no turn since (an exit net deletes)", async () => {
      // docs/fix/detach-live.md fix round 7 (owner Q4=a). Mutation: no save in
      // `open` → `saveConfirmed` stays false until a turn runs.
      const pod = await live();
      const tui = await pod.connect({ shared: true });
      expect(await tui.runtime.attachTo(UID, null)).toBe(true);
      expect(tui.runtime.saveConfirmed()).toBe(true);
      const saved = (await tui.store.loadAll()).records.find((r) => r.id === UID);
      expect(saved?.messages[0]).toMatchObject({ role: "user", content: "first turn" });
    });

    test("R9 attached MID-TURN: not confirmed while that turn runs (the net must not delete under it); confirmed only after a save made after its end", async () => {
      // docs/fix/detach-live.md fix round 8. Mutation: `saveConfirmed` ignores
      // the session's running turn → true right after the attach.
      const pod = shared();
      const log: string[] = [];
      const held = holding("R", log);
      const relay = await pod.connect({
        sessionId: UID,
        model: new Held([SHELL]),
        broker: held.broker,
      });
      const turn = drain(relay.runtime.createSession().send("first turn"));
      await until(() => log.includes("R:asked:shell"));
      const tui = await pod.connect({ shared: true, broker: holding("T", log).broker });
      expect(await tui.runtime.attachTo(UID, null)).toBe(true);
      expect(tui.runtime.saveConfirmed()).toBe(false); // the turn runs
      tui.runtime.createSession(); // no watcher, nobody iterates the turn
      expect(tui.runtime.saveConfirmed()).toBe(false);
      held.answer(true);
      await turn;
      await until(() => tui.runtime.saveConfirmed());
      const saved = (await tui.store.loadAll()).records.find((r) => r.id === UID);
      expect(saved?.messages.map((m) => m.role)).toContain("tool"); // the end is on the laptop
    });

    test("openSeeded on a live session: the same", async () => {
      const pod = await live();
      const record: SessionRecord = {
        id: UID,
        cwd: "/tmp/work",
        model: "m",
        createdAt: 1,
        updatedAt: 1,
        title: "kept",
        messages: [{ role: "user", content: "first turn" }],
      };
      const tui = await pod.connect({ shared: true, resume: record, sessionId: UID });
      await tui.runtime.openSeeded(record);
      expect(tui.runtime.saveConfirmed()).toBe(true);
    });

    test("the initial save fails (a full disk): attach still works, and it stays unconfirmed — as before", async () => {
      const pod = await live();
      const tui = await pod.connect({ shared: true, fullDisk: true });
      expect(await tui.runtime.attachTo(UID, null)).toBe(true);
      expect(tui.runtime.saveConfirmed()).toBe(false);
    });
  });

  test("H4 quit: a last read-back, then close{ifLast}; mid a foreign first turn the transcript reaches the saver", async () => {
    // Mutations: drop the last read-back from `quit` (nothing saved); `quit = dispose`.
    // The relay holds its first turn's ask (the S2 "first turn" case): the
    // committed history is the prompt and the call, and no turn end saved it.
    const pod = shared();
    const log: string[] = [];
    const held = holding("R", log);
    const relay = await pod.connect({
      sessionId: UID,
      model: new Held([SHELL]),
      broker: held.broker,
    });
    const turn = drain(relay.runtime.createSession().send("first turn"));
    await until(() => log.includes("R:asked:shell"));
    const tui = await pod.connect({ shared: true, broker: holding("T", log).broker });
    expect(await tui.runtime.attachTo(UID, null)).toBe(true);
    const { sessionsKept, saved: confirmed } = await tui.runtime.quit();
    expect(sessionsKept).toBe(1); // the relay is still attached: only a detach
    expect(confirmed).toBe(true);
    const sent = methods(tui.frames);
    // The persistence read-back is `session/log` (docs/feat/session-log.md).
    const read = sent.indexOf("session/log");
    const close = sent.indexOf("session/close");
    expect(read).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(read);
    expect(tui.frames.find((f) => f.includes('"session/close"'))).toContain('"ifLast":true');
    expect(await tui.saver.drain()).toEqual([]);
    const saved = (await tui.store.loadAll()).records;
    expect(saved.map((r) => r.id)).toEqual([UID]);
    expect(saved[0]?.messages[0]).toMatchObject({ role: "user", content: "first turn" });
    held.answer(false);
    await turn;
    expect(pod.host.get(UID)).toBeDefined();
  });

  describe("H35 a last save not confirmed: `saved` false, and the session is left in the pod, never closed", () => {
    /** Alone on a live session with a transcript: a close would end its only copy. */
    const alone = async (opts: Parameters<ReturnType<typeof shared>["connect"]>[0]) => {
      const pod = shared();
      const first = await pod.connect({
        sessionId: UID,
        model: new ScriptedProvider([[{ type: "text", delta: "hi" }, { type: "done" }]]),
      });
      await drain(first.runtime.createSession().send("first turn"));
      await first.runtime.release();
      const tui = await pod.connect({ shared: true, ...opts });
      expect(await tui.runtime.attachTo(UID, null)).toBe(true);
      return { pod, tui };
    };

    test("a read-back that fails", async () => {
      // Mutation: `saved` always true → the delete goes ahead on a lost transcript.
      const { pod, tui } = await alone({});
      const session = pod.host.get(UID);
      if (!session) throw new Error("no session");
      // The read-back is `session/log` (docs/feat/session-log.md).
      session.logRead = () => {
        throw new Error("the pod's disk is gone");
      };
      expect(await tui.runtime.quit()).toEqual({ sessionsKept: 1, saved: false });
      expect(methods(tui.frames)).not.toContain("session/close");
      expect(methods(tui.frames)).toContain("session/detach");
      expect(pod.host.get(UID)).toBeDefined();
    });

    test("a read-back that never answers (bounded)", async () => {
      // Mutation: the bound resolves `saved` true.
      let stopped = false;
      const { pod, tui } = await alone({
        lose: (f) => stopped && f.includes('"session/log"'),
      });
      stopped = true;
      expect(await tui.runtime.quit()).toEqual({ sessionsKept: 1, saved: false });
      expect(methods(tui.frames)).not.toContain("session/close");
      expect(pod.host.get(UID)).toBeDefined();
    }, 8000);

    test("a read-back that worked, but the laptop copy could not be written", async () => {
      // Mutation: no saver drain in `quit` → the session is closed before the failure shows.
      const { pod, tui } = await alone({ fullDisk: true });
      expect(await tui.runtime.quit()).toEqual({ sessionsKept: 1, saved: false });
      expect(methods(tui.frames)).not.toContain("session/close");
      expect(pod.host.get(UID)).toBeDefined();
    });

    test("confirmed: closed, as ever", async () => {
      const { pod, tui } = await alone({});
      expect(await tui.runtime.quit()).toEqual({ sessionsKept: 0, saved: true });
      expect(pod.host.get(UID)).toBeUndefined();
    });
  });

  test("H7 shared: a controller's close() (/clear) with another client attached leaves the session live for it", async () => {
    // Mutation: drop `closeIfLast` → the relay's session is closed under it.
    const pod = shared();
    const relay = await pod.connect({ sessionId: UID });
    await drain(relay.runtime.createSession().send("one"));
    const tui = await pod.connect({ shared: true });
    await tui.runtime.attachTo(UID, null);
    tui.runtime.createSession().close?.();
    await until(() => pod.host.get(UID)?.attachedCount !== 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(pod.host.get(UID)?.attachedCount).toBe(1);
  });

  test("H8 the newest client quits during its model call: the other's turn ends clean", async () => {
    // Mutation: drop `modelIdle` from `quit` → the call dies with B, A's turn errors.
    const pod = shared();
    const aModel = new Held([SHELL]);
    const bModel = new Held([[{ type: "text", delta: "from b" }, { type: "done" }]], [0]);
    const log: string[] = [];
    const A = holding("A", log);
    const a = await pod.connect({ sessionId: UID, model: aModel, broker: A.broker });
    const session = a.runtime.createSession();
    const events: string[] = [];
    let failed: unknown = null;
    const turn = (async () => {
      for await (const e of session.send("go")) events.push(e.type);
    })().catch((error: unknown) => {
      failed = error;
    });
    await until(() => log.includes("A:asked:shell"));
    const b = await pod.connect({ shared: true, model: bModel, broker: holding("B", log).broker });
    await b.runtime.attachTo(UID, null);
    // A's call ran before B joined; A allows the tool; the next call is B's (newest).
    A.answer(true);
    await until(() => bModel.started === 1);
    const quitting = b.runtime.quit();
    await new Promise((r) => setTimeout(r, 20));
    bModel.open(0);
    await quitting;
    await turn;
    expect(failed).toBeNull();
    expect(events.at(-1)).toBe("turn_end");
    expect(pod.host.get(UID)?.snapshotPage().messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "from b",
    });
  });

  test("H9 three clients, one ask: asked on all, one answer, the others withdrawn, the tool once; two answers in a tick: one decision, no error", async () => {
    // A pin of the load-bearing assumption (green on main). Mutation, daemon:
    // `settle` skips `permission_resolved` → the losers are never withdrawn.
    for (const race of [false, true]) {
      const pod = shared();
      const log: string[] = [];
      const errors: string[] = [];
      const A = holding("A", log);
      const B = holding("B", log);
      const D = holding("D", log);
      const a = await pod.connect({
        sessionId: UID,
        broker: A.broker,
        model: new Held([SHELL, [{ type: "done" }]]),
        errors,
      });
      const turn = drain(a.runtime.createSession().send("go"));
      await until(() => log.includes("A:asked:shell"));
      const b = await pod.connect({ shared: true, broker: B.broker, errors });
      await b.runtime.attachTo(UID, null);
      const d = await pod.connect({ shared: true, broker: D.broker, errors });
      await d.runtime.attachTo(UID, null);
      await until(() => log.includes("B:asked:shell") && log.includes("D:asked:shell"));
      if (race) {
        D.answer(false);
        B.answer(true);
      } else {
        B.answer(true);
      }
      await turn;
      // The one that did not answer is always withdrawn; without a race, both losers are.
      await until(() => log.includes("A:withdrawn") && (race || log.includes("D:withdrawn")));
      // The first answer to reach the daemon decides: D's deny in the race.
      expect(pod.execs).toHaveLength(race ? 0 : 1);
      expect(errors).toEqual([]);
    }
  });

  test("D21 the relay's turn id: `send` uses it, the ask carries it; `attachTo({ adoptTurn })` owns it, another id and a `/clear`ed session do not", async () => {
    // Mutations: `send` ignores `turnId`; `adoptTurn` dropped.
    const RUN = "77777777-7777-4777-8777-777777777777";
    const pod = shared();
    const asked: (string | undefined)[] = [];
    const relayBroker = new PermissionBroker((_req, options) => {
      asked.push(options?.turnId);
      return new Promise(() => {});
    });
    const relay = await pod.connect({
      sessionId: UID,
      model: new Held([SHELL]),
      broker: relayBroker,
    });
    void drain(relay.runtime.createSession().send("go", undefined, { turnId: RUN })).catch(
      () => {},
    );
    await until(() => asked.length === 1);
    expect(asked[0]).toBe(RUN);
    const tui = await pod.connect({ shared: true });
    expect(await tui.runtime.attachTo(UID, null, { adoptTurn: RUN })).toBe(true);
    const ctl = tui.runtime.createSession();
    expect(ctl.ownsTurn(RUN)).toBe(true);
    expect(ctl.ownsTurn("88888888-8888-4888-8888-888888888888")).toBe(false);
    expect(tui.runtime.createSession().ownsTurn(RUN)).toBe(false);
  });

  // docs/fix/detach-live.md A3: `/quit` closes the session for every client.
  /** Streams one delta, then holds until its request is aborted (a long answer). */
  class Slow implements ModelProvider {
    readonly id = "slow";
    started = 0;
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      this.started++;
      yield { type: "text", delta: "partial " };
      await new Promise<void>((resolve) => {
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done" };
    }
  }
  /** The App's foreign path: every activity logged, each turn's events consumed. */
  const follow = (ctl: { watch: RemoteSession["watch"] }) => {
    const log: string[] = [];
    const cancels: (() => void)[] = [];
    ctl.watch((activity) => {
      log.push(activity.kind === "closed" ? `closed(${activity.reason})` : activity.kind);
      if (activity.kind === "turn") {
        cancels.push(() => activity.cancel());
        void (async () => {
          try {
            for await (const e of activity.events) {
              log.push(e.type === "turn_end" ? `turn_end(${e.reason})` : e.type);
            }
            log.push("stream-end");
          } catch (error) {
            log.push(`THREW:${String(error)}`);
          }
        })();
      }
    });
    return { log, cancels };
  };
  const NOT_SAVED = /not saved/;

  test("D4+D5 a confirmed /quit closes for all: O's own turn ends cancelled, nothing thrown, `closed`, Q serving the call; O's exit then reads nothing", async () => {
    // Mutations: `closeForAll` ignored (ifLast: S3's behaviour, O's turn dies
    // with Q's call); no ended-session rule (O's quit reports "not saved").
    const pod = shared();
    const log: string[] = [];
    const O = holding("O", log);
    const o = await pod.connect({ sessionId: UID, model: new Held([SHELL]), broker: O.broker });
    const oc = o.runtime.createSession();
    const oLog = follow(oc);
    const own: string[] = [];
    let threw: unknown = null;
    const turn = (async () => {
      for await (const e of oc.send("go")) {
        own.push(e.type === "turn_end" ? `turn_end(${e.reason})` : e.type);
      }
    })().catch((error: unknown) => {
      threw = error;
    });
    await until(() => log.includes("O:asked:shell"));
    const slow = new Slow();
    const q = await pod.connect({ shared: true, model: slow, broker: holding("Q", log).broker });
    expect(await q.runtime.attachTo(UID, null)).toBe(true);
    q.runtime.createSession();
    O.answer(true); // the next call is Q's: the newest client serves it
    await until(() => slow.started === 1);
    expect(await q.runtime.quit({ closeForAll: true })).toEqual({ sessionsKept: 0, saved: true });
    await turn;
    expect(threw).toBeNull();
    expect(own.at(-1)).toBe("turn_end(cancelled)");
    await until(() => oLog.log.includes("closed(closed)"));
    expect(pod.host.get(UID)).toBeUndefined();
    // D5: O leaves after it; the session ended, the closer saved it.
    expect(await o.runtime.quit()).toEqual({ sessionsKept: 0, saved: true });
    expect(await o.saver.drain()).toEqual([]);
  }, 15_000);

  // Latency 2: the late read fails "the session was closed"; 0: "connection
  // closed", after the client is gone (f39's two wordings).
  for (const [what, latency] of [
    ["tool", 2],
    ["stream", 2],
    ["tool", 0],
    ["stream", 0],
  ] as const) {
    test(`D6 alone, the run's turn in a ${what} (latency ${latency}), the second /quit (no stop): no false "not saved", also a macrotask later`, async () => {
      // Mutations: `seal` a no-op; `seal` only `flush` (the late read still reports).
      const pod = shared(what === "tool");
      const log: string[] = [];
      const R = holding("R", log);
      const relay = await pod.connect({
        sessionId: UID,
        model: new Held([SHELL]),
        broker:
          what === "tool"
            ? new PermissionBroker(() => Promise.resolve({ allowed: true }))
            : R.broker,
        factory: true,
      });
      void drain(relay.runtime.createSession().send("first turn")).catch(() => {});
      await until(() => (what === "tool" ? pod.execs.length === 1 : log.includes("R:asked:shell")));
      const slow = new Slow();
      const tui = await pod.connect({
        shared: true,
        broker: holding("T", log).broker,
        factory: true,
        latency,
        model: slow,
      });
      expect(await tui.runtime.attachTo(UID, null)).toBe(true);
      const tLog = follow(tui.runtime.createSession());
      await new Promise((r) => setTimeout(r, 30));
      if (what === "stream") {
        R.answer(true);
        await until(() => slow.started === 1);
      }
      relay.runtime.stopSaving();
      await relay.runtime.release(); // handed over
      await new Promise((r) => setTimeout(r, 30));
      expect(await tui.runtime.quit()).toEqual({ sessionsKept: 0, saved: true });
      expect(await tui.saver.drain()).toEqual([]);
      await new Promise((r) => setTimeout(r, 50));
      expect((await tui.saver.drain()).filter((line) => NOT_SAVED.test(line))).toEqual([]);
      expect(pod.host.get(UID)).toBeUndefined();
      expect(tLog.log).toContain("turn");
    }, 15_000);
  }

  test("F4 O's real exit, `release`, with its stream behind the wire: no false `not saved`, also after the stream ended", async () => {
    // Mutation: no seal in `release` → `could not read the history back: peer
    // is closed` (the review's trace). Q closes with no stop (a second /quit),
    // O's consumer lags: its stream ends after O released.
    const pod = shared(true);
    const relay = await pod.connect({
      sessionId: UID,
      model: new Held([SHELL]),
      broker: new PermissionBroker(() => Promise.resolve({ allowed: true })),
      factory: true,
    });
    void drain(relay.runtime.createSession().send("first turn")).catch(() => {});
    await until(() => pod.execs.length === 1);
    const o = await pod.connect({ shared: true, factory: true, latency: 2 });
    await o.runtime.attachTo(UID, null);
    const log: string[] = [];
    let released = false;
    o.runtime.createSession().watch((activity) => {
      log.push(activity.kind);
      if (activity.kind === "closed") {
        void o.runtime.release().then(() => {
          released = true;
        });
      }
      if (activity.kind === "turn") {
        void (async () => {
          for await (const _ of activity.events) {
            await new Promise((r) => setTimeout(r, 40));
          }
          log.push(released ? "stream-end-after-release" : "stream-end");
        })().catch(() => {});
      }
    });
    const q = await pod.connect({ shared: true, factory: true, latency: 2 });
    await q.runtime.attachTo(UID, null);
    q.runtime.createSession();
    await new Promise((r) => setTimeout(r, 30));
    relay.runtime.stopSaving();
    await relay.runtime.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(await q.runtime.quit({ closeForAll: true })).toEqual({ sessionsKept: 0, saved: true });
    await until(() => log.includes("stream-end-after-release"));
    await new Promise((r) => setTimeout(r, 50));
    expect(await o.saver.drain()).toEqual([]);
  }, 15_000);

  describe("Q2 a turn a /quit cuts is marked interrupted in the saved history (the daemon reload's marker)", () => {
    /** The run's turn in a tool; a TUI attached; the relay handed over. */
    const cutInTool = async () => {
      const pod = shared(true);
      const relay = await pod.connect({
        sessionId: UID,
        model: new Held([SHELL]),
        broker: new PermissionBroker(() => Promise.resolve({ allowed: true })),
        factory: true,
      });
      void drain(relay.runtime.createSession().send("first turn")).catch(() => {});
      await until(() => pod.execs.length === 1);
      const tui = await pod.connect({ shared: true, factory: true, latency: 2 });
      await tui.runtime.attachTo(UID, null);
      tui.runtime.createSession();
      await new Promise((r) => setTimeout(r, 30));
      return { pod, relay, tui };
    };

    test("/quit for all in a running tool, no stop first: the dangling call is answered `interrupted`", async () => {
      // docs/fix/detach-live.md fix round 7 (owner Q2=a). Mutation: no `cutTurn`
      // in `quit` → the record ends on an assistant call with no answer.
      const { relay, tui } = await cutInTool();
      relay.runtime.stopSaving();
      await relay.runtime.release();
      await new Promise((r) => setTimeout(r, 30));
      await tui.runtime.quit({ closeForAll: true });
      const stored = (await tui.store.loadAll()).records;
      const messages = stored[0]?.messages ?? [];
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(messages[2]).toEqual({
        role: "tool",
        content: ENDED_INTERRUPTED_NOTE,
        toolCallId: "c1",
      });
      expect(messages[3]?.content).toBe(ENDED_TURN_NOTE); // the model never answered the result
    });

    /** The run's turn while the model streams (its call held): the history is the prompt only. */
    const cutInStream = async () => {
      const pod = shared();
      const model = new Held([SHELL], [0]);
      const relay = await pod.connect({
        sessionId: UID,
        model,
        broker: new PermissionBroker(() => Promise.resolve({ allowed: true })),
        factory: true,
      });
      void drain(relay.runtime.createSession().send("first turn")).catch(() => {});
      await until(() => model.started === 1);
      const tui = await pod.connect({ shared: true, factory: true, latency: 2 });
      await tui.runtime.attachTo(UID, null);
      tui.runtime.createSession();
      await new Promise((r) => setTimeout(r, 30));
      relay.runtime.stopSaving();
      await relay.runtime.release();
      await new Promise((r) => setTimeout(r, 30));
      return tui;
    };

    test("live item 6: /quit for all while the model streams — the saved history ends on an `interrupted` note, not the bare prompt", async () => {
      // docs/fix/detach-live.md fix round 8. Mutation: no tail note → [user] only.
      const tui = await cutInStream();
      await tui.runtime.quit({ closeForAll: true });
      const messages = (await tui.store.loadAll()).records[0]?.messages ?? [];
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      // The relay (the model link) left mid-call first, so the turn FAILED
      // before the close: the daemon's own note (round 10, owner B) says so.
      // Had the close come first, the laptop's `ENDED_TURN_NOTE`. Either way an
      // ending note, never the bare prompt.
      const note = messages[1]?.content ?? "";
      expect(note === ENDED_TURN_NOTE || note === failedTurnNote("connection closed")).toBe(true);
    });

    test("live item 6: a lone /quit (it ends the session, `ending`) is marked the same", async () => {
      const tui = await cutInStream();
      await tui.runtime.quit({ ending: true });
      const messages = (await tui.store.loadAll()).records[0]?.messages ?? [];
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    test("a quit that leaves the turn to others (not for all) marks nothing: the turn goes on", async () => {
      const { relay, tui } = await cutInTool();
      await tui.runtime.quit();
      // The FILE holds the raw log: no note was written at save, the turn is
      // still open in it (no `turn_end`). Only a LOAD closes it (Q11).
      const parsed = parseLogFile(await readFile(tui.store.file(UID), "utf8"), UID);
      const segment = parsed.ok ? currentSegment(parsed) : null;
      expect(segment?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(segment?.openTurns.length).toBe(1);
      void relay;
    });
  });

  test("D7 the run's turn in a tool, stopped first, then the quit: the record holds the interrupted tool", async () => {
    // A pin of the stop-first order (green before the fix too). Mutation, the
    // test's: `quit` before the stream's end → the `tool` message is not stored.
    const pod = shared(true);
    const relay = await pod.connect({
      sessionId: UID,
      model: new Held([SHELL]),
      broker: new PermissionBroker(() => Promise.resolve({ allowed: true })),
      factory: true,
    });
    void drain(relay.runtime.createSession().send("first turn")).catch(() => {});
    await until(() => pod.execs.length === 1);
    const tui = await pod.connect({ shared: true, factory: true, latency: 2 });
    await tui.runtime.attachTo(UID, null);
    const tLog = follow(tui.runtime.createSession());
    await new Promise((r) => setTimeout(r, 30));
    relay.runtime.stopSaving();
    await relay.runtime.release();
    await new Promise((r) => setTimeout(r, 30));
    tLog.cancels[0]?.();
    await until(() => tLog.log.includes("stream-end"));
    expect(await tui.runtime.quit({ closeForAll: true })).toEqual({
      sessionsKept: 0,
      saved: true,
    });
    expect(await tui.saver.drain()).toEqual([]);
    const stored = (await tui.store.loadAll()).records;
    // The stopped turn has its `turn_end` in the log: a CLOSED turn loads as it
    // is (docs/feat/session-log-laptop-store.md Q11). The old save-time cut also
    // put the "session was ended" note on it, because the quit cut every read.
    expect(stored[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  }, 15_000);
});

// docs/fix/run-session-never-saved.md: a long turn is saved on the laptop after
// every committed round (owner Q2), so a pod lost mid-turn loses at most the
// round in progress; the mid-turn record is always closed (cut).
describe("per-round save inside a turn", () => {
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (await check()) {
        return;
      }
      await tick();
    }
    throw new Error(`timed out waiting for: ${what}`);
  };
  const result = (id: string) => ({
    type: "tool_result",
    id,
    name: "shell",
    result: { content: "ok" },
  });
  const user = (content: string) => ({ role: "user" as const, content });
  const asst = (content: string, ids: string[] = []) => ({
    role: "assistant" as const,
    content,
    ...(ids.length > 0
      ? { toolCalls: ids.map((id) => ({ id, name: "shell", arguments: "{}" })) }
      : {}),
  });
  const tool = (toolCallId: string) => ({ role: "tool" as const, content: "ok", toolCallId });

  /** A fake session: events are pushed by the test, each snapshot is held until resolved. */
  function liveInner() {
    const queue: (Record<string, unknown> | null)[] = [];
    let wake: (() => void) | null = null;
    const held: { resolve: (m: unknown[]) => void; reject: (e: Error) => void }[] = [];
    const push = (event: Record<string, unknown> | null) => {
      queue.push(event);
      wake?.();
    };
    const inner = {
      async *send() {
        for (;;) {
          while (queue.length === 0) {
            await new Promise<void>((r) => {
              wake = r;
            });
          }
          const event = queue.shift();
          if (event === null || event === undefined) {
            return;
          }
          yield event;
        }
      },
      readBack: () =>
        new Promise((resolve, reject) => {
          held.push({ resolve: (messages) => resolve({ messages }), reject });
        }),
      runningCalls: () => new Set<string>(),
      onTitle: () => () => {},
      enqueue: async () => {},
      close: () => {},
    } as unknown as RemoteSession;
    return { inner, held, push };
  }

  test("a committed round (tool_result) reads the history back while the turn still runs; the read is saved RAW, saveConfirmed stays false", async () => {
    // Mutation: drop the tool_result flush in `saved()` → held stays empty (red on main).
    // The close of a cut turn moved to LOAD (docs/feat/session-log-laptop-store.md
    // Q11, pinned by W12): the save hands on the read as it is.
    const { inner, held, push } = liveInner();
    const saved: (readonly { role: string; content: unknown }[])[] = [];
    const ctl = persistingController(inner, (m) => saved.push(m));
    const turn = drain(ctl.send("go"));
    push({ type: "tool_start", id: "c1", name: "shell", arguments: "{}" });
    await tick();
    expect(held).toHaveLength(0); // a start commits nothing
    push(result("c1"));
    await until(() => held.length === 1, "mid-turn read-back");
    held[0]?.resolve([user("go"), asst("", ["c1"]), tool("c1")]);
    await ctl.flushed();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual([user("go"), asst("", ["c1"]), tool("c1")]);
    expect(ctl.saveConfirmed()).toBe(false); // R9 unchanged: a turn runs
    push(null);
    await turn;
  });

  test("an unanswered call in a mid-turn read is saved as it is (closed at load, never at save)", async () => {
    // Mutation: put the save-time cut back → 2 answered, not 1. The "Not run"
    // close itself is pinned at load (W12, packages/daemon/test/session-log-file.test.ts).
    const { inner, held, push } = liveInner();
    const saved: { role: string; content: unknown }[][] = [];
    const ctl = persistingController(inner, (m) => saved.push([...m]));
    const turn = drain(ctl.send("go"));
    push(result("c1"));
    await until(() => held.length === 1, "read-back");
    held[0]?.resolve([user("go"), asst("", ["c1", "c2"]), tool("c1")]);
    await ctl.flushed();
    const answered = saved[0]?.filter((m) => m.role === "tool").length;
    expect(answered).toBe(1);
    push(null);
    await turn;
  });

  test("rounds committing while a read is in flight collapse into ONE more read; the last state wins", async () => {
    const { inner, held, push } = liveInner();
    const saved: number[] = [];
    const ctl = persistingController(inner, (m) => saved.push(m.length));
    const turn = drain(ctl.send("go"));
    push(result("c1"));
    await until(() => held.length === 1, "first read");
    push(result("c2"));
    push(result("c3"));
    await tick(20);
    expect(held).toHaveLength(1); // one in flight, the rest collapsed behind it
    held[0]?.resolve([user("go"), asst("", ["c1"]), tool("c1")]);
    await until(() => held.length === 2, "the collapsed read");
    held[1]?.resolve([
      user("go"),
      asst("", ["c1"]),
      tool("c1"),
      asst("", ["c2"]),
      tool("c2"),
      asst("", ["c3"]),
      tool("c3"),
    ]);
    await ctl.flushed();
    expect(held).toHaveLength(2);
    expect(saved).toEqual([3, 7]); // raw reads: the newest state is what is on disk
    push(null);
    await turn;
  });

  test("a failed mid-turn read is reported once and does not stop the turn; the next round saves again", async () => {
    const { inner, held, push } = liveInner();
    const errors: string[] = [];
    const saved: number[] = [];
    const ctl = persistingController(
      inner,
      (m) => saved.push(m.length),
      (e) => errors.push(e.message),
    );
    const turn = drain(ctl.send("go"));
    push(result("c1"));
    await until(() => held.length === 1, "first read");
    held[0]?.reject(new Error("link down"));
    await ctl.flushed();
    expect(errors).toEqual(["link down"]);
    expect(saved).toEqual([]);
    push(result("c2"));
    await until(() => held.length === 2, "retry on the next round");
    held[1]?.resolve([user("go"), asst("", ["c1"]), tool("c1"), asst("", ["c2"]), tool("c2")]);
    await ctl.flushed();
    expect(saved).toEqual([5]);
    push(null);
    await turn;
  });

  test("compaction mid-turn: the rewritten (shorter) history is what the next round saves", async () => {
    const { inner, held, push } = liveInner();
    const saved: { role: string; content: unknown }[][] = [];
    const ctl = persistingController(inner, (m) => saved.push([...m]));
    const turn = drain(ctl.send("go"));
    push(result("c1"));
    await until(() => held.length === 1, "first read");
    held[0]?.resolve([user("a"), asst("b"), user("go"), asst("", ["c1"]), tool("c1")]);
    await ctl.flushed();
    push(result("c2"));
    await until(() => held.length === 2, "second read");
    held[1]?.resolve([user("summary"), asst("", ["c2"]), tool("c2")]);
    await ctl.flushed();
    expect(saved[1]?.[0]).toEqual(user("summary"));
    expect(saved[1]).toHaveLength(3);
    push(null);
    await turn;
  });

  // ---- integration: a pod-like daemon whose tool rounds are released by the test.
  function podLike(rounds: number) {
    const gates: (() => void)[] = [];
    class Looping implements ModelProvider {
      readonly id = "looping";
      private n = 0;
      async *stream(): AsyncIterable<StreamEvent> {
        const i = ++this.n;
        if (i <= rounds) {
          yield {
            type: "tool_call",
            toolCall: { id: `c${i}`, name: "shell", arguments: '{"command":"x"}' },
          } as StreamEvent;
        } else {
          yield { type: "text", delta: "all done" };
        }
        yield { type: "done" };
      }
    }
    const host = new SessionHost({
      defaultCwd: "/tmp/work",
      createAgent: () => ({
        agent: new Agent({
          model: new Looping(),
          tools: new ToolRegistry().register(shellTool),
          env: {
            ...noopEnv,
            exec: () =>
              new Promise((res) =>
                gates.push(() => res({ stdout: "ok", stderr: "", exitCode: 0 })),
              ),
          },
        }),
        permissions: new PermissionBroker(),
      }),
    });
    let current: ReturnType<typeof createChannelPair>[1] | null = null;
    let gone = false;
    const link = () => {
      const [daemonCh, clientCh] = createChannelPair();
      new Connection(daemonCh, host);
      current = clientCh;
      return clientCh;
    };
    return {
      gates,
      link,
      stop: () => {
        gone = true;
        current?.close();
      },
      factory: async () => {
        if (gone) {
          throw new ChannelError("gone", 'the connection target is gone: container "x" is exited');
        }
        return link();
      },
    };
  }

  async function podRuntime(name: string, rounds: number) {
    const pod = podLike(rounds);
    const store = new LogSessionStore(join(dir, name));
    const notices: string[] = [];
    const saver = new SessionSaver(store, (t) => notices.push(t));
    const observed: string[] = [];
    saver.observe((record) => observed.push(record.id));
    const runtime = await createLocalRuntime({
      channel: pod.link(),
      channelFactory: pod.factory,
      disposeTransport: () => {},
      permissions: new PermissionBroker(),
      saver,
      cwd: "/tmp/work",
      model: "m",
      resume: null,
      daemonKind: "container",
    });
    const records = async () => (await store.loadAll()).records;
    return { pod, store, saver, notices, observed, runtime, records };
  }

  test("a pod lost mid-turn: the rounds already committed are on disk, closed; the first save names the session (kept sessionId)", async () => {
    // Red on main: no file at all (the owner's lost session).
    const { pod, saver, notices, observed, runtime, records } = await podRuntime("gone", 5);
    const session = runtime.createSession();
    const turn = drain(session.send("big task")).catch(() => {});
    await until(() => pod.gates.length === 1, "round 1 running");
    pod.gates[0]?.();
    await until(() => pod.gates.length === 2, "round 2 running");
    pod.gates[1]?.();
    await until(() => pod.gates.length === 3, "round 3 running");
    // Rounds 1 and 2 are committed; round 3 is in progress. The pod dies now.
    await until(async () => ((await records())[0]?.messages.length ?? 0) >= 5, "mid-turn save");
    // The kept index (`trackKeptSession`, driven by `observe`) learns the uid on the first mid-turn save.
    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed).size).toBe(1);
    pod.stop();
    await turn;
    await saver.drain();
    const rec = (await records())[0];
    expect(rec?.messages[0]?.content).toBe("big task");
    const calls = rec?.messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []) ?? [];
    const answered = rec?.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect([...answered].sort()).toEqual([...calls].sort()); // never a dangling call
    expect(rec?.messages.at(-1)?.role).toBe("assistant");
    // Only chat messages: no rendering-only event (tool_phase, usage, ...) is persisted (§7).
    for (const m of rec?.messages ?? []) {
      expect(["user", "assistant", "tool"]).toContain(m.role);
      expect(Object.keys(m)).not.toContain("type");
    }
    // The turn-end read fails (the pod is gone) and says so once; the file above is what survives.
    expect(notices.filter((n) => n.includes("not saved"))).toHaveLength(1);
    void runtime.dispose();
  }, 15_000);

  test("a long turn that completes: the mid-turn record grows during the turn, the final one is the real history", async () => {
    const { pod, saver, runtime, records } = await podRuntime("long", 3);
    const session = runtime.createSession();
    const turn = drain(session.send("big task"));
    await until(() => pod.gates.length === 1, "round 1");
    pod.gates[0]?.();
    await until(() => pod.gates.length === 2, "round 2");
    await until(
      async () => ((await records())[0]?.messages.length ?? 0) >= 3,
      "save after round 1",
    );
    const mid = (await records())[0];
    expect(mid?.messages.map((m) => m.content)).not.toContain("all done");
    expect(session.saveConfirmed()).toBe(false);
    pod.gates[1]?.();
    await until(() => pod.gates.length === 3, "round 3");
    pod.gates[2]?.();
    await turn;
    await session.flushed();
    await saver.drain();
    const rec = (await records())[0];
    expect(rec?.messages.at(-1)?.content).toBe("all done");
    expect(rec?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(session.saveConfirmed()).toBe(true);
    void runtime.dispose();
  }, 15_000);

  test("a steered message committed mid-turn is in the next mid-turn record", async () => {
    const { pod, runtime, records } = await podRuntime("steer", 3);
    const session = runtime.createSession();
    const turn = drain(session.send("big task")).catch(() => {});
    await until(() => pod.gates.length === 1, "round 1");
    await session.enqueue("also X", "q1");
    pod.gates[0]?.();
    await until(() => pod.gates.length === 2, "round 2");
    pod.gates[1]?.();
    await until(() => pod.gates.length === 3, "round 3");
    await until(
      async () => (await records())[0]?.messages.some((m) => m.content === "also X") ?? false,
      "the steered message on disk before the turn ends",
    );
    pod.stop();
    await turn;
    void runtime.dispose();
  }, 15_000);

  test("createdAt is the first save's, kept by later saves of a fresh session (updatedAt moves)", async () => {
    // Red on main: build() takes createdAt only from a resumed record → re-stamped each save.
    const { saver, runtime, records } = await podRuntime("created", 0);
    const session = runtime.createSession();
    await drain(session.send("one"));
    await session.flushed();
    await saver.drain();
    const first = (await records())[0];
    await tick(15);
    await drain(session.send("two"));
    await session.flushed();
    await saver.drain();
    const second = (await records())[0];
    expect(second?.messages.length).toBeGreaterThan(first?.messages.length ?? 0);
    expect(first?.createdAt).toBeGreaterThan(0);
    expect(second?.createdAt === first?.createdAt).toBe(true);
    expect(second?.updatedAt).toBeGreaterThan(second?.createdAt ?? 0);
    void runtime.dispose();
  });

  test("every read is persisted RAW, mid-turn ones too (the cut moved to load), and one writer never sets its own copy aside", async () => {
    // docs/feat/session-log-laptop-store.md Q11: was Q6/L1 (the save-time cut
    // and its length hack, `lastMidTurnCount`, both removed). Cancelled-turn and
    // no-growth shapes: equal raw reads, a turn end with a read in flight.
    // Mutation: put `cutHistory` back on mid-turn reads → the first persisted copy has the notes.
    const { inner, held, push } = liveInner();
    const asides: string[] = [];
    const persisted: (readonly ChatMessage[])[] = [];
    const store = new LogSessionStore(join(dir, "raw-reads"), {
      onAside: (info) => asides.push(info.file),
    });
    const saver = new SessionSaver(store, () => {});
    const ctl = persistingController(inner, (messages) => {
      persisted.push(messages);
      saver.save({
        id: "u1",
        cwd: "/",
        model: "m",
        createdAt: 1,
        updatedAt: 1,
        title: "t",
        messages: [...messages],
      });
    });
    const turn = drain(ctl.send("go"));
    const raw = [user("go"), asst("", ["c1"]), tool("c1")];
    push(result("c1"));
    await until(() => held.length === 1, "R1");
    held[0]?.resolve(raw);
    await ctl.flushed();
    await saver.drain();
    push(result("c1b")); // same round: no committed growth, R2 starts
    await until(() => held.length === 2, "R2");
    push(null); // the turn ends while R2 is in flight → `again`
    await turn;
    held[1]?.resolve(raw);
    await until(() => held.length === 3, "R3");
    held[2]?.resolve(raw);
    await ctl.flushed();
    await saver.drain();
    expect(persisted.map((m) => m.length)).toEqual([3, 3, 3]);
    expect(persisted[0]).toEqual(raw);
    expect(asides).toEqual([]);
  });
});

describe("session/log on the laptop (docs/feat/session-log.md)", () => {
  /** A pod whose daemon can be swapped under a connected runtime (a restart). */
  function pod(model: ModelProvider) {
    const at = { host: hostFor(model) };
    const links: ReturnType<typeof createChannelPair>[1][] = [];
    const dial = () => {
      const [d, c] = createChannelPair();
      new Connection(d, at.host);
      links.push(c);
      return c;
    };
    return {
      at,
      dial,
      restart: (next: SessionHost) => {
        at.host = next;
        for (const link of links.splice(0)) link.close();
      },
    };
  }
  function hostFor(model: ModelProvider): SessionHost {
    return new SessionHost({
      defaultCwd: "/tmp/work",
      createAgent: () => ({
        agent: new Agent({ model, tools: new ToolRegistry(), env: noopEnv }),
        permissions: new PermissionBroker(),
      }),
    });
  }
  const UID = "22222222-2222-4222-8222-222222222222";

  test("R2 a FORK is set aside, never lost: the daemon's lineage is adopted, the laptop's copy goes to an .aside file, with a notice", async () => {
    // RED on main: the session file is silently replaced by the daemon's
    // divergent history (no aside, no notice) — F1's silent drop.
    const p = pod(new ScriptedProvider([[{ type: "text", delta: "A-answer" }, { type: "done" }]]));
    const store = new LogSessionStore(join(dir, "fork"));
    const notices: string[] = [];
    const saver = new SessionSaver(store, (text) => notices.push(text));
    const runtime = await createLocalRuntime({
      channel: p.dial(),
      channelFactory: async () => p.dial(),
      disposeTransport: () => {},
      permissions: new PermissionBroker(),
      saver,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
      sessionId: UID,
    });
    const session = runtime.createSession();
    await drain(session.send("A-question"));
    await session.flushed?.();
    await saver.drain();
    const mine = (await store.load(UID)).status === "ok";
    expect(mine).toBe(true);
    // The pod restarts; ANOTHER terminal (B) reseeded the new daemon from its
    // own, different copy before this one came back (the F1 scenario).
    const d2 = hostFor(
      new ScriptedProvider([[{ type: "text", delta: "after" }, { type: "done" }]]),
    );
    d2.open(
      { sessionId: UID, messages: [{ role: "user", content: "B's own history" }] },
      { send: () => {} },
    );
    p.restart(d2);
    await drain(session.send("next"));
    await session.flushed?.();
    await saver.drain();
    const files = await readdir(join(dir, "fork"));
    const asides = files.filter((f) => f.startsWith(`${UID}.stale-`) && f.endsWith(".aside"));
    expect(asides).toHaveLength(1);
    // The aside is a log file too (Q7): its segment folds to this copy.
    const aside = parseLogFile(await readFile(join(dir, "fork", asides[0] ?? ""), "utf8"), UID);
    const asideMessages = aside.ok ? currentSegment(aside).messages : [];
    expect(asideMessages.map((m) => m.content)).toEqual(["A-question", "A-answer"]);
    const main = await store.load(UID);
    const kept = main.status === "ok" ? main.record.messages.map((m) => m.content) : [];
    expect(kept).toEqual(["B's own history", "next", "after"]);
    expect(notices.some((n) => n.includes("diverged") && n.includes(asides[0] ?? "?"))).toBe(true);
    runtime.dispose();
  });

  test("the aside lands BEFORE the session file is replaced; a failed aside keeps the file and is retried at the next save", async () => {
    // Mutation: persist before `setAside` (or drop `pendingAside`) → the first
    // round writes the daemon's copy over a file whose old copy is nowhere.
    const mine = [{ role: "user", content: "mine" }] as const;
    const theirs = [{ role: "user", content: "theirs" }] as const;
    const reads = [
      { messages: theirs, entries: [], aside: mine },
      { messages: theirs, entries: [] },
    ];
    const inner = {
      async *send() {},
      readBack: async () => reads.shift() ?? { messages: theirs, entries: [] },
      runningCalls: () => new Set<string>(),
      onTitle: () => () => {},
      close: () => {},
    } as unknown as RemoteSession;
    const log: string[] = [];
    const errors: string[] = [];
    let failAside = true;
    const ctl = persistingController(
      inner,
      (messages) => log.push(`persist:${messages.map((m) => m.content).join()}`),
      (error) => errors.push(error.message),
      undefined,
      undefined,
      undefined,
      async (messages) => {
        if (failAside) throw new Error("disk full");
        log.push(`aside:${messages.map((m) => m.content).join()}`);
      },
    );
    await drain(ctl.send("one"));
    await ctl.flushed();
    expect(log).toEqual([]); // the aside failed: the session file was NOT replaced
    expect(errors).toEqual(["disk full"]);
    failAside = false;
    await drain(ctl.send("two"));
    await ctl.flushed();
    expect(log).toEqual(["aside:mine", "persist:theirs"]); // retried first, then the file
  });

  test("I5 the saved log after a turn loads to the daemon's history (W1 pins every round)", async () => {
    // A two-round turn: the mid-turn save is the raw log (closed only at load,
    // docs/feat/session-log-laptop-store.md Q11), the turn-end one loads to
    // exactly the daemon's history.
    const model = new ScriptedProvider([
      [
        { type: "tool_call", toolCall: { id: "c1", name: "shell", arguments: '{"command":"ls"}' } },
        { type: "done" },
      ],
      [{ type: "text", delta: "listed" }, { type: "done" }],
    ]);
    const host = new SessionHost({
      defaultCwd: "/tmp/work",
      createAgent: () => {
        const permissions = new PermissionBroker();
        permissions.setRequester(async () => ({ kind: "allow_once" }) as never);
        return {
          agent: new Agent({
            model,
            tools: new ToolRegistry().register(shellTool),
            env: noopEnv,
            requestPermission: async () => ({ outcome: "allow_once" }) as never,
          }),
          permissions,
        };
      },
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const store = new LogSessionStore(join(dir, "i5"));
    const saved: string[] = [];
    const saver = new SessionSaver(store, () => {});
    saver.observe((s) => saved.push(s.id));
    const runtime = await createLocalRuntime({
      channel: c,
      disposeTransport: () => {},
      permissions: new PermissionBroker(),
      saver,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
      sessionId: UID,
    });
    const session = runtime.createSession();
    await drain(session.send("list"));
    await session.flushed?.();
    await saver.drain();
    expect(saved.at(-1)).toBe(UID);
    const loaded = await store.load(UID);
    const last = loaded.status === "ok" ? loaded.record : undefined;
    expect(last?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(last?.messages.at(-1)?.content).toBe("listed");
    expect(last?.messages).toEqual(
      host.get(UID)?.snapshotPage().messages as SessionRecord["messages"],
    );
    runtime.dispose();
  });
});
