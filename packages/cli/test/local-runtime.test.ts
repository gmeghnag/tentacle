import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonSessionStore } from "@tentacle/agent";
import type { RemoteSession } from "@tentacle/client";
import type {
  BackgroundJob,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { createLocalRuntime, persistingController } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

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
): {
  channel: ReturnType<typeof createChannelPair>[1];
  dispose: () => void;
  host: SessionHost;
} {
  const host = new SessionHost({
    defaultCwd: "/tmp/work",
    createAgent: () => ({
      agent: new Agent({ model, tools: new ToolRegistry(), env: noopEnv }),
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
        skills: [],
      }),
    });
    const errors: string[] = [];
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => daemonPeer.close(),
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new JsonSessionStore(join(dir, "peer-error")), () => {}),
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
      saver: new SessionSaver(new JsonSessionStore(join(dir, "close")), () => {}),
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

  test("persists the session after a turn, under a stable uid", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "hi back" }, { type: "done" }]]);
    const { channel, dispose } = daemon(model);
    const store = new JsonSessionStore(join(dir, "a"));
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

    const saved = (await store.list()).records;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.messages.map((m) => m.content)).toEqual(["hello", "hi back"]);
    expect(saved[0]?.title).toBe("hello");
    runtime.dispose();
  });

  test("the turn's save is on disk once the saver drains — no sleep, no lost write at exit", async () => {
    // Mutation: drop `deps.saver.save(...)` from the persist callback → no file.
    const model = new ScriptedProvider([[{ type: "text", delta: "bye" }, { type: "done" }]]);
    const { channel, dispose } = daemon(model);
    const store = new JsonSessionStore(join(dir, "drain"));
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
    const saved = (await store.list()).records;
    expect(saved.map((r) => r.messages.map((m) => m.content))).toEqual([["last words", "bye"]]);
  });

  test("streams a daemon background-job exit to the client's jobs view while idle", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const jobs = new FakeJobs();
    const { channel, dispose } = daemon(model, jobs);
    const store = new JsonSessionStore(join(dir, "jobs"));
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
    const store = new JsonSessionStore(join(dir, "b"));
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
    const record = (await store.latest()).record;
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
    const all = (await store.list()).records;
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
    const store = new JsonSessionStore(join(dir, "deleted-elsewhere"));
    const record = {
      id: "S",
      cwd: "/tmp/work",
      model: "qwen3",
      createdAt: 1,
      updatedAt: 1,
      title: "mine",
      messages: [{ role: "user" as const, content: "mine" }],
    };
    await store.save(record);
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
    const saver = new SessionSaver(new JsonSessionStore(join(dir, "flush-fail")), (t) =>
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
    const store = new JsonSessionStore(join(dir, "paged"));
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
    const saved = (await store.list()).records;
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
