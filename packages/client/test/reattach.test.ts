/**
 * `RemoteClient` re-attach, case by case, over real daemon objects
 * (docs/feat/client-reattach.md): the link lifecycle, the obligations handed
 * over by `permission-events` and `suspended-turn-resume`, recreate, and the
 * keyed / unkeyed command rules. The every-drop-point property is
 * `reattach.e2e.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { Agent, type LoadResult } from "@tentacle/agent";
import { type ModelProvider, PermissionBroker, allowAll } from "@tentacle/core";
import {
  Connection,
  type DaemonSessionRecord,
  type RecordStore,
  SessionHost,
  SessionPersister,
  parseDaemonRecord,
} from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, type DuplexChannel, createChannelPair } from "@tentacle/transport";
import type { ReturnedRow } from "../src/hand-back.ts";
import { ChannelError, LIVENESS_MS, type LinkStatus } from "../src/link-machine.ts";
import type { SessionEvent } from "../src/mapping.ts";
import { type Clock, RemoteClient } from "../src/remote-client.ts";
import type { StreamOutput } from "../src/session-reducer.ts";
import { GatedModel, type Step, approver, done, t, tick, until } from "./support/fakes.ts";
import { cutLink } from "./support/link-cutter.ts";

const CWD = "/tmp/reattach-cases";
const shell = (id: string): Step => ({
  kind: "event",
  event: { type: "tool_call", toolCall: { id, name: "shell", arguments: '{"command":"ls"}' } },
});

function makeHost(
  model: ModelProvider,
  runs: { n: number },
  persister?: SessionPersister,
): SessionHost {
  return new SessionHost({
    defaultCwd: CWD,
    ...(persister ? { persister } : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env: {
          id: "e",
          exec: async () => {
            runs.n += 1;
            return { stdout: "ok", stderr: "", exitCode: 0 };
          },
          readFile: async () => "",
          writeFile: async () => {},
        },
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
}

/** Where a dial lands (swappable: a restarted daemon), and outbound frames per channel. */
class Target {
  host: SessionHost;
  /** Outbound client frames of every channel this target handed out, by generation. */
  readonly frames: { method?: string; params?: Record<string, unknown> }[][] = [];
  last: DuplexChannel | null = null;
  /** Called after each outbound client frame is forwarded (to race a call against it). */
  onFrame: ((frame: { method?: string; params?: Record<string, unknown> }) => void) | null = null;
  constructor(host: SessionHost) {
    this.host = host;
  }
  connect(): DuplexChannel {
    const [d, c] = createChannelPair();
    new Connection(d, this.host);
    const log: { method?: string; params?: Record<string, unknown> }[] = [];
    this.frames.push(log);
    const tapped: DuplexChannel = {
      send: (data) => {
        const frame = JSON.parse(data);
        log.push(frame);
        c.send(data);
        this.onFrame?.(frame);
      },
      close: () => c.close(),
      setOnMessage: (h) => c.setOnMessage(h),
      setOnClose: (h) => c.setOnClose(h),
    };
    this.last = tapped;
    return tapped;
  }
}

/** A channel factory the test can hold (the link stays down) and count. */
function dialer(target: Target) {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  let calls = 0;
  return {
    calls: () => calls,
    hold: () => {
      gate = new Promise((r) => {
        open = r;
      });
    },
    release: () => {
      gate = null;
      open();
    },
    factory: async (): Promise<DuplexChannel> => {
      calls += 1;
      if (gate) await gate;
      return target.connect();
    },
  };
}

async function drain(iter: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const methods = (log: readonly { method?: string }[]): string[] =>
  log.flatMap((f) => (f.method ? [f.method] : []));

describe("re-attach: link lifecycle", () => {
  test("without a factory a drop stays terminal (the inert default): turn fails, status stopped", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), { kind: "gate" }, t("b"), done]]);
    const target = new Target(makeHost(model, runs));
    const client = new RemoteClient(target.connect(), new PermissionBroker());
    const statuses: LinkStatus[] = [];
    client.onLinkStatus((s) => statuses.push(s));
    await client.initialize();
    const turn = drain(client.newSession(undefined, "S").send("go")).catch((e: Error) => e);
    await until(() => model.waiting);
    target.last?.close();
    expect(String(await turn)).toMatch(/connection closed/);
    expect(statuses).toEqual([{ state: "stopped", reason: "disconnected" }]);
    client.close();
  });

  test("E1/E2: a drop after the permission request is applied keeps the dialog; re-attach with since; Approve runs once", async () => {
    // Obligation (permission-events finding 2): `since` is past the request, so
    // the daemon does not replay it — the client must keep it.
    // Mutation: call `router.connectionClosed()` on a reconnectable drop → the
    // dialog is withdrawn and never re-offered → the turn never ends.
    const runs = { n: 0 };
    const model = new GatedModel([
      [t("a"), shell("c1"), done],
      [t("b"), done],
    ]);
    const target = new Target(makeHost(model, runs));
    const ap = approver();
    const dial = dialer(target);
    const client = new RemoteClient(target.connect(), ap.broker, undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    const statuses: LinkStatus[] = [];
    client.onLinkStatus((s) => statuses.push(s));
    await client.initialize();
    const turn = drain(client.newSession(undefined, "S").send("go"));
    expect(await until(() => ap.pending() === 1)).toBe(true);
    target.last?.close();
    expect(await until(() => statuses.at(-1)?.state === "up")).toBe(true);
    await tick();
    expect(ap.aborts()).toBe(0); // the dialog survived the drop
    // Re-attached by replay from its own position: `since`, and no snapshot.
    const gen1 = target.frames[1] ?? [];
    expect(gen1.find((f) => f.method === "session/open")?.params?.since).toBeDefined();
    expect(methods(gen1)).not.toContain("session/snapshot");
    ap.approve();
    const events = await turn;
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(runs.n).toBe(1);
    expect(ap.prompts()).toBe(1); // one broker, one prompt, across the drop
    expect(statuses).toEqual([
      { state: "reconnecting", attempt: 1, nextAtMs: expect.any(Number) },
      { state: "up" },
    ]);
    client.close();
    expect(statuses.at(-1)).toEqual({ state: "stopped", reason: "closed" });
  });

  test("E3: answered on another client while this one was away — the dialog is withdrawn on recovery, its turn completes", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([
      [t("a"), shell("c1"), done],
      [t("b"), done],
    ]);
    const target = new Target(makeHost(model, runs));
    const apA = approver();
    const dial = dialer(target);
    const aLink = target.connect();
    const a = new RemoteClient(aLink, apA.broker, undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await a.initialize();
    const turn = drain(a.newSession(undefined, "S").send("go"));
    await until(() => apA.pending() === 1);
    const apB = approver();
    const b = new RemoteClient(target.connect(), apB.broker);
    await b.initialize();
    await b.openSession(undefined, undefined, "S"); // attaches: the replay offers the request
    await until(() => apB.pending() === 1);
    dial.hold();
    aLink.close(); // the laptop goes offline (and stays: the dial is held)
    await tick();
    apB.approve(); // the phone answers while the laptop is offline
    await until(() => target.host.get("S")?.running === false);
    dial.release();
    const events = await turn;
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(apA.aborts()).toBe(1); // withdrawn, never answered here
    expect(runs.n).toBe(1);
    a.close();
    b.close();
  });

  test("a factory rejecting with `unauthorized` stops for good: status stopped, the turn fails, no retry storm", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), { kind: "gate" }, done]]);
    const target = new Target(makeHost(model, runs));
    let calls = 0;
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => {
        calls += 1;
        throw new ChannelError("unauthorized", "401");
      },
      random: () => 0,
    });
    const statuses: LinkStatus[] = [];
    client.onLinkStatus((s) => statuses.push(s));
    await client.initialize();
    const turn = drain(client.newSession(undefined, "S").send("go")).catch((e: Error) => e);
    await until(() => model.waiting);
    target.last?.close();
    expect(String(await turn)).toMatch(/rejected the credentials: 401/);
    await tick();
    expect(calls).toBe(1);
    expect(statuses.at(-1)).toEqual({
      state: "stopped",
      reason: "the daemon rejected the credentials: 401",
    });
    client.close();
  });

  test("close() during the backoff: the scheduled dial never runs", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), { kind: "gate" }, done]]);
    const target = new Target(makeHost(model, runs));
    const timers: (() => void)[] = [];
    const clock: Clock = {
      now: () => 0,
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {
        timers.length = 0;
      },
    };
    let calls = 0;
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => {
        calls += 1;
        return target.connect();
      },
      clock,
      random: () => 0.5,
    });
    await client.initialize();
    const turn = drain(client.newSession(undefined, "S").send("go")).catch((e: Error) => e);
    await until(() => model.waiting);
    target.last?.close();
    await tick();
    expect(timers.length).toBe(1);
    client.close();
    for (const fire of timers.splice(0)) fire();
    await tick();
    expect(calls).toBe(0);
    expect(String(await turn)).toMatch(/connection closed/);
  });

  test("generation guard: a late frame on a dead channel is ignored", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), { kind: "gate" }, t("b"), done]]);
    const target = new Target(makeHost(model, runs));
    // Gen 0 keeps a handle on the client's inbound handler, to deliver after the drop.
    let late: ((data: string) => void) | null = null;
    const [d, c] = createChannelPair();
    new Connection(d, target.host);
    const gen0: DuplexChannel = {
      send: (data) => c.send(data),
      close: () => c.close(),
      setOnMessage: (h) => {
        late = h;
        c.setOnMessage(h);
      },
      setOnClose: (h) => c.setOnClose(h),
    };
    const statuses: LinkStatus[] = [];
    const client = new RemoteClient(gen0, new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    client.onLinkStatus((s) => statuses.push(s));
    await client.initialize();
    const turn = drain(client.newSession(undefined, "S").send("go"));
    await until(() => model.waiting);
    c.close();
    await until(() => statuses.at(-1)?.state === "up");
    // A frame the dead generation delivers late: a seq far ahead (a gap if applied).
    (late as ((data: string) => void) | null)?.(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "S",
          seq: 999,
          update: { type: "agent_message_chunk", content: { type: "text", text: "GHOST" } },
        },
      }),
    );
    await tick();
    model.open();
    const events = await turn;
    expect(JSON.stringify(events)).not.toContain("GHOST");
    // Not applied: no gap, so no forced reopen on the live channel.
    expect(methods(target.frames[0] ?? []).filter((m) => m === "session/open")).toHaveLength(1);
    client.close();
  });
});

describe("re-attach: commands across a drop", () => {
  test("a drop before the first open answered: the session is opened again (create), the turn runs once", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), done]]);
    const target = new Target(makeHost(model, runs));
    const link = cutLink(1); // the open request is delivered, its answer is lost
    new Connection(link.daemon, target.host);
    const client = new RemoteClient(link.client, new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    link.arm();
    const events = await drain(client.newSession(undefined, "S").send("go"));
    expect(link.cut()).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(model.calls).toBe(1);
    client.close();
  });

  test("a drop before the first open left the client: the next link CREATES the session, the turn runs (never 'lost')", async () => {
    // Mutation: recover a never-live session like a live one (no `create`) →
    // UnknownSession → recreate → `turn_lost` for a prompt that was never sent.
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), done]]);
    const target = new Target(makeHost(model, runs));
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    target.last?.close(); // gone before the first `session/open` could leave
    // A raw stream consumer (a mobile view) opens it: no spurious turn_lost / reset.
    const outs: StreamOutput[] = [];
    await client.openSession(undefined, undefined, "S", {
      output: (out) => outs.push(out),
      recovered: () => {},
      linkClosed: () => {},
    });
    expect(outs.map((o) => o.kind)).toEqual([]);
    const events = await drain(client.newSession(undefined, "S").send("go"));
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(model.calls).toBe(1);
    client.close();
  });

  test("enqueue whose ack is lost is re-sent with its key: the steer lands once", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([
      [t("a"), { kind: "gate" }, t("b"), done],
      [t("c"), done],
    ]);
    const target = new Target(makeHost(model, runs));
    const link = cutLink(1); // the enqueue request is delivered, its ack is lost
    new Connection(link.daemon, target.host);
    const client = new RemoteClient(link.client, new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const turn = drain(session.send("go"));
    await until(() => model.waiting);
    link.arm();
    await session.enqueue("steer-1"); // resolves after the re-send
    expect(link.cut()).toBe(true);
    model.open();
    await turn;
    const history = await client.snapshot("S");
    expect(history.filter((m) => m.role === "user" && m.content === "steer-1")).toHaveLength(1);
    client.close();
  });

  test("compact is not re-sent after a drop (no key): it rejects; the session stays usable", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([
      [t("a"), done],
      [t("summary"), done],
      [t("z"), done],
    ]);
    const target = new Target(makeHost(model, runs));
    const link = cutLink(1);
    new Connection(link.daemon, target.host);
    const client = new RemoteClient(link.client, new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    await drain(session.send("first"));
    link.arm();
    await expect(session.compact()).rejects.toThrow(/not retried/);
    // It still runs daemon-side (a drop does not cancel it): wait it out.
    await until(() => model.calls === 2);
    await until(() => target.host.get("S")?.running === false);
    const events = await drain(session.send("second"));
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(model.calls).toBe(3); // the compaction ran once daemon-side
    client.close();
  });

  test("the daemon lost the session (UnknownSession): recreated from the client's history; the turn is lost, never re-run", async () => {
    const runs = { n: 0 };
    const modelA = new GatedModel([
      [t("one"), done],
      [t("a"), { kind: "gate" }, done],
    ]);
    const target = new Target(makeHost(modelA, runs));
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    await drain(session.send("first"));
    const history = await session.snapshot(); // what the persisting wrapper reads after a turn
    const turn = drain(session.send("second")).catch((e: Error) => e);
    await until(() => modelA.waiting);
    // A new daemon that never heard of S (a new stdio daemon in a pod).
    const modelB = new GatedModel([]);
    target.host = makeHost(modelB, runs);
    target.last?.close();
    expect(String(await turn)).toMatch(/lost the session; the turn in flight was not re-run/);
    expect(modelB.calls).toBe(0); // not re-run
    expect((await client.snapshot("S")).map((m) => m.content)).toEqual(
      (history ?? []).map((m) => m.content),
    );
    client.close();
  });
});

/** An in-memory record store (what a `serve` restart reads back). */
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

const persisterFor = (store: MemStore): SessionPersister =>
  new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });

describe("re-attach: a `serve` restart with a turn suspended on approval (suspended-turn-resume obligation)", () => {
  test("E4: no turn_start after the restart; the old dialog is withdrawn, the re-ask prompts once; Approve runs once; the turn ends", async () => {
    // Mutation: skip `retainOnly` on a resync → the pre-restart dialog stays
    // on screen (its id answers PermissionNotPending), aborts stays 0.
    const runs = { n: 0 };
    const store = new MemStore();
    const model1 = new GatedModel([[t("a"), shell("c1"), done]]);
    const target = new Target(makeHost(model1, runs, persisterFor(store)));
    const ap = approver();
    const client = new RemoteClient(target.connect(), ap.broker, undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const log: StreamOutput[] = [];
    const output = session.output.bind(session);
    session.output = (out: StreamOutput): void => {
      log.push(out);
      output(out);
    };
    const turn = drain(session.send("go"));
    await until(() => ap.pending() === 1);
    await target.host.get("S")?.persisted();
    const durable = store.durable.get("S");
    if (!durable) throw new Error("nothing durable");
    const parsed = parseDaemonRecord(JSON.parse(JSON.stringify(durable)), (c) => c === CWD);
    if (!parsed.ok) throw new Error(parsed.reason);
    // The restart: a new daemon restores the record; the old one is gone.
    const model2 = new GatedModel([[t("b"), done]]);
    const host2 = makeHost(model2, runs, persisterFor(new MemStore()));
    host2.restore(parsed.record);
    target.host = host2;
    target.last?.close();
    // The resumed turn asks again under a fresh id: one new dialog.
    expect(await until(() => ap.prompts() === 2 && ap.pending() === 1)).toBe(true);
    expect(ap.aborts()).toBe(1); // the pre-restart dialog, withdrawn
    ap.approve();
    const events = await turn;
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(ap.prompts()).toBe(2); // never a third
    expect(runs.n).toBe(1);
    const afterReset = log.slice(log.findIndex((o) => o.kind === "reset"));
    expect(afterReset.some((o) => o.kind === "update" && o.update.type === "turn_start")).toBe(
      false,
    );
    client.close();
  });
});

describe("re-attach: send-now after a `serve` restart (send-now-c follow-up 1)", () => {
  test("R1: an idle reloaded [user] record → the daemon answers NoTurnRunning (no turn); an undelivered text → a turn", async () => {
    // Mutation: the client's local NoTurnRunning (no live turn) → red: the
    // daemon is never asked (0 calls) and "Z" never runs.
    const runs = { n: 0 };
    const store = new MemStore();
    const model1 = new GatedModel([[t("a"), { kind: "gate" }, done]]);
    const target = new Target(makeHost(model1, runs, persisterFor(store)));
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const turn = drain(session.send("go"));
    await until(() => model1.waiting);
    await session.enqueue("A", "a");
    await target.host.get("S")?.persisted();
    const durable = store.durable.get("S");
    if (!durable?.turn) throw new Error("no running turn on disk");
    expect(durable.enqueueIds).toContain("a");
    // What the restart reads: T1 ended after draining "A" with no reply (a
    // hook-stop / max_iterations drain), so the idle history is [user "A"] —
    // the shape a reload reads as a compaction summary (addendum item 5).
    const { turn: running, ...idle } = durable;
    const record = {
      ...idle,
      messages: [{ role: "user", content: "A" }],
      turns: [{ turnId: running.turnId, end: { stopReason: "end_turn" } }],
    };
    const parsed = parseDaemonRecord(JSON.parse(JSON.stringify(record)), (c) => c === CWD);
    if (!parsed.ok) throw new Error(parsed.reason);
    const model2 = new GatedModel([[t("Z-answer"), done]]);
    const host2 = makeHost(model2, runs, persisterFor(new MemStore()));
    const restored = host2.restore(parsed.record);
    let daemonCalls = 0;
    const original = restored.sendNow.bind(restored);
    restored.sendNow = (...args: Parameters<typeof original>) => {
      daemonCalls += 1;
      return original(...args);
    };
    target.host = host2;
    target.last?.close();
    // The old turn's prompt is re-sent; the restarted daemon answers its cached end.
    const old = await turn;
    expect(old.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });

    // Delivered before the restart, nothing to answer (by the reload's rule).
    await expect(session.sendNow([{ id: "a", text: "A" }], "turn")).rejects.toMatchObject({
      code: DomainErrorCode.NoTurnRunning,
    });
    expect(daemonCalls).toBe(1);
    expect(model2.calls).toBe(0);
    expect((await client.snapshot("S")).map((m) => m.content)).toEqual(["A"]);

    // Never delivered: the daemon runs it.
    const events = await drain(await session.sendNow([{ id: "z", text: "Z" }], "turn"));
    expect(daemonCalls).toBe(2);
    expect(events[0]).toEqual({ type: "user_message", text: "Z" });
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(model2.calls).toBe(1);
    client.close();
  });
});

/** Loses the first delivery of every 3rd update while `loss.on`: more gaps than the guard allows. */
function lossy(inner: DuplexChannel, loss: { on: boolean }): DuplexChannel {
  const seen = new Set<number>();
  return {
    send: (data) => inner.send(data),
    close: () => inner.close(),
    setOnMessage: (h) =>
      inner.setOnMessage((data: string) => {
        const f = JSON.parse(data);
        const seq = f.params?.seq;
        if (loss.on && f.method === "session/update" && seq % 3 === 0 && !seen.has(seq)) {
          seen.add(seq);
          return;
        }
        h(data);
      }),
    setOnClose: (h) => inner.setOnClose(h),
  };
}

/** How a call settles within `ms`: "completed", its error message, or "hung". */
const outcome = (p: Promise<unknown>, ms = 500): Promise<string> =>
  Promise.race([
    p.then(
      () => "completed",
      (e: Error) => e.message,
    ),
    new Promise<string>((r) => setTimeout(() => r("hung"), ms)),
  ]);

/** A long reply: the turn spans many macrotasks, so a cancel can still land mid-turn. */
const long = (n: number): Step[] => [...Array.from({ length: n }, (_, i) => t(`${i} `)), done];

describe("re-attach: review findings (docs/feat/client-reattach.md, Review)", () => {
  test("finding 1: Esc while down, for a prompt that never reached the daemon, cancels the turn", async () => {
    // Mutation: drop the cancel on the prompt's ack → the cancel sent from
    // `recovered()` beats the prompt (a no-op) and the turn runs to end_turn.
    const runs = { n: 0 };
    const model = new GatedModel([[t("w"), done], long(40)]);
    const target = new Target(makeHost(model, runs));
    const dial = dialer(target);
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    await drain(session.send("warm up"));
    dial.hold();
    target.last?.close();
    await tick();
    const controller = new AbortController();
    const turn = drain(session.send("second", controller.signal));
    await tick();
    controller.abort(); // still down: the prompt is waiting for the link
    dial.release();
    const events = await turn;
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    client.close();
  });

  test("the cancel of an acked turn, lost while down, is re-sent after the reconnect", async () => {
    // Mutation: never re-send the cancel from `recovered()` → the turn completes.
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), { kind: "gate" }, ...long(40)]]);
    const target = new Target(makeHost(model, runs));
    const dial = dialer(target);
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await client.initialize();
    const controller = new AbortController();
    const turn = drain(client.newSession(undefined, "S").send("go", controller.signal));
    await until(() => model.waiting);
    dial.hold();
    target.last?.close();
    await tick();
    controller.abort(); // the notification is lost: the link is down
    dial.release();
    await until(() => (target.frames[1] ?? []).some((f) => f.method === "session/cancel"));
    model.open();
    const events = await turn;
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    client.close();
  });

  test("finding 2: no factory — a command on a session the reducer gave up on rejects at once", async () => {
    // Mutation: send it to the peer anyway → acked, its turn_end never applied:
    // the turn hangs silently.
    const runs = { n: 0 };
    const model = new GatedModel([long(15), [t("x"), done]]);
    const host = makeHost(model, runs);
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const loss = { on: true };
    const client = new RemoteClient(lossy(c, loss), new PermissionBroker(), undefined, {
      onError: () => {},
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    expect(String(await drain(session.send("one")).catch((e: Error) => e))).toMatch(
      /giving up on this session/,
    );
    loss.on = false;
    await until(() => host.get("S")?.running === false);
    expect(await outcome(drain(session.send("two")))).toMatch(/could not be resumed/);
    expect(model.calls).toBe(1); // never sent to the daemon
    client.close();
  });

  test("with a factory: a command waiting out a drop rejects when the recovery fails (whenLive)", async () => {
    // Mutation: drop the `failed` check in `whenLive` → the command waits forever.
    const runs = { n: 0 };
    const model = new GatedModel([[t("w"), done]]);
    const target = new Target(makeHost(model, runs));
    const dial = dialer(target);
    let refuseOpen = false;
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => {
        const inner = await dial.factory();
        if (!refuseOpen) return inner;
        // The recovery's `open` fails with the daemon's own error: not retried.
        let inbound: ((data: string) => void) | null = null;
        return {
          send: (data) => {
            const f = JSON.parse(data);
            if (f.method !== "session/open") return inner.send(data);
            const error = { code: -32603, message: "open refused" };
            queueMicrotask(() => inbound?.(JSON.stringify({ jsonrpc: "2.0", id: f.id, error })));
          },
          close: () => inner.close(),
          setOnMessage: (h) => {
            inbound = h;
            inner.setOnMessage(h);
          },
          setOnClose: (h) => inner.setOnClose(h),
        };
      },
      random: () => 0,
      onError: () => {},
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    await drain(session.send("warm up"));
    dial.hold();
    refuseOpen = true;
    target.last?.close();
    await tick();
    // A raw command (no turn listener to fail it): only `whenLive` can settle it.
    const next = outcome(client.prompt("S", "t2", "two"), 1000); // waits for the link
    dial.release();
    expect(await next).toMatch(/could not be resumed/);
    expect(model.calls).toBe(1);
    client.close();
  });

  test("finding 4: closeSession during a recovery that hits UnknownSession never recreates it", async () => {
    // Mutation: drop the `closing` check on the recreate path → the closed
    // session is created again on the new daemon (an orphan).
    const runs = { n: 0 };
    const model = new GatedModel([[t("w"), done]]);
    const target = new Target(makeHost(model, runs));
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    await drain(session.send("warm up"));
    await client.snapshot("S");
    // The daemon restarts: a new host that never heard of S.
    target.host = makeHost(new GatedModel([]), runs);
    let closed: Promise<void> | null = null;
    target.onFrame = (f) => {
      if (f.method === "session/open" && !closed) {
        queueMicrotask(() => {
          closed = client.closeSession("S");
        });
      }
    };
    target.last?.close();
    await until(() => closed !== null);
    await closed;
    await tick();
    await tick();
    expect(target.host.get("S")).toBeUndefined();
    client.close();
  });

  test("an update for a session this client never opened is dropped (no prompt from a pod)", async () => {
    // Mutation: route an unknown session's update to the permission router →
    // a pod-originated prompt for a session the user never opened.
    const runs = { n: 0 };
    const model = new GatedModel([]);
    const target = new Target(makeHost(model, runs));
    let inbound: ((data: string) => void) | null = null;
    const [d, c] = createChannelPair();
    new Connection(d, target.host);
    const channel: DuplexChannel = {
      send: (data) => c.send(data),
      close: () => c.close(),
      setOnMessage: (h) => {
        inbound = h;
        c.setOnMessage(h);
      },
      setOnClose: (h) => c.setOnClose(h),
    };
    const ap = approver();
    const client = new RemoteClient(channel, ap.broker, undefined, { onError: () => {} });
    await client.initialize();
    (inbound as ((data: string) => void) | null)?.(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "NOT-OPENED",
          seq: 1,
          mandatory: true,
          update: {
            type: "permission_request",
            requestId: "r1",
            toolCallId: "c1",
            tool: "shell",
            title: "rm -rf ~",
            options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
          },
        },
      }),
    );
    await tick();
    expect(ap.prompts()).toBe(0);
    client.close();
  });

  test("snapshot() waits out a drop and retries (read-only: safe to repeat)", async () => {
    // Mutation: no retry loop (one attempt) → the read rejects with the drop.
    const runs = { n: 0 };
    const model = new GatedModel([[t("w"), done]]);
    const target = new Target(makeHost(model, runs));
    const link = cutLink(1); // the snapshot request is delivered, its answer is lost
    new Connection(link.daemon, target.host);
    const client = new RemoteClient(link.client, new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    await drain(client.newSession(undefined, "S").send("warm up"));
    link.arm();
    const history = await client.snapshot("S");
    expect(link.cut()).toBe(true);
    expect(history.map((m) => m.content)).toContain("warm up");
    client.close();
  });

  test("an answer the daemon refused is offered again when the request comes back (answerFailed)", async () => {
    // Mutation: skip `router.answerFailed` → the id stays "answered" and the
    // re-delivered request is swallowed: no dialog, the turn never ends.
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), shell("c1"), done]]);
    const host = makeHost(model, runs);
    const [d, c] = createChannelPair();
    new Connection(d, host);
    let inbound: ((data: string) => void) | null = null;
    let seq = 0;
    let request: unknown = null;
    let refused = false;
    const channel: DuplexChannel = {
      send: (data) => {
        const f = JSON.parse(data);
        if (f.method === "session/resolve_permission" && !refused) {
          refused = true; // the daemon "fails" it (not PermissionNotPending)
          const error = { code: -32603, message: "refused once" };
          queueMicrotask(() => inbound?.(JSON.stringify({ jsonrpc: "2.0", id: f.id, error })));
          return;
        }
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (h) => {
        inbound = h;
        c.setOnMessage((data: string) => {
          const f = JSON.parse(data);
          if (f.method === "session/update") {
            seq = Math.max(seq, f.params.seq);
            if (f.params.update.type === "permission_request") request = f.params.update;
          }
          h(data);
        });
      },
      setOnClose: (h) => c.setOnClose(h),
    };
    const ap = approver();
    const client = new RemoteClient(channel, ap.broker, undefined, { onError: () => {} });
    await client.initialize();
    void drain(client.newSession(undefined, "S").send("go")).catch(() => {});
    expect(await until(() => ap.pending() === 1)).toBe(true);
    ap.approve();
    expect(await until(() => refused)).toBe(true);
    await tick();
    // The same request comes back (as a later replay would offer it).
    (inbound as ((data: string) => void) | null)?.(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "S", seq: seq + 1, mandatory: true, update: request },
      }),
    );
    expect(await until(() => ap.prompts() === 2)).toBe(true);
    client.close();
  });
});

/** A client clock the test advances by hand (timers fire in due order, new ones included). */
function manualClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number): void {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

/** A channel that can go half-open: outbound frames vanish ("out"), or both directions ("both"). */
function halfOpen(inner: DuplexChannel) {
  let mode: "ok" | "out" | "both" = "ok";
  const channel: DuplexChannel = {
    send: (data) => {
      if (mode === "ok") inner.send(data);
    },
    close: () => inner.close(),
    setOnClose: (handler) => inner.setOnClose(handler),
    setOnMessage: (handler) =>
      inner.setOnMessage((data) => {
        if (mode !== "both") handler(data);
      }),
  };
  return {
    channel,
    set: (next: "ok" | "out" | "both") => {
      mode = next;
    },
  };
}

describe("re-attach: liveness (docs/feat/client-reattach-frontends.md §4)", () => {
  test("half-open with a command outstanding: after 15 s of silence the link is redialled and the keyed command lands once", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([
      [t("a"), { kind: "gate" }, t("b"), done],
      [t("c"), done],
    ]);
    const target = new Target(makeHost(model, runs));
    const time = manualClock();
    const first = halfOpen(target.connect());
    let dials = 0;
    const client = new RemoteClient(first.channel, new PermissionBroker(), undefined, {
      channelFactory: async () => {
        dials += 1;
        return target.connect();
      },
      clock: time.clock,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const turn = drain(session.send("go"));
    await until(() => model.waiting);
    first.set("both"); // the laptop slept: nothing in, nothing out
    const steer = session.enqueue("steer-1");
    await tick();
    time.advance(LIVENESS_MS - 1);
    await tick();
    expect(dials).toBe(0); // not yet
    time.advance(1);
    expect(await until(() => dials === 1)).toBe(true);
    for (let i = 0; i < 20; i++) {
      time.advance(0);
      await tick();
    }
    await steer; // re-sent with its key on the new link
    model.open();
    await turn;
    const history = await client.snapshot("S");
    expect(history.filter((m) => m.role === "user" && m.content === "steer-1")).toHaveLength(1);
    client.close();
  });

  test("a slow but alive link is not declared dead: inbound frames restart the window", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([
      [t("a"), { kind: "gate" }, t("b"), { kind: "gate" }, t("c"), { kind: "gate" }, done],
    ]);
    const target = new Target(makeHost(model, runs));
    const time = manualClock();
    const first = halfOpen(target.connect());
    let dials = 0;
    const client = new RemoteClient(first.channel, new PermissionBroker(), undefined, {
      channelFactory: async () => {
        dials += 1;
        return target.connect();
      },
      clock: time.clock,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const events: SessionEvent[] = [];
    void (async () => {
      for await (const e of session.send("go")) events.push(e);
    })().catch(() => {});
    await until(() => model.waiting);
    first.set("out"); // the enqueue never reaches the daemon, but frames still arrive
    void session.enqueue("never-acked").catch(() => {});
    await tick();
    time.advance(10_000);
    model.open(); // an inbound text frame
    expect(await until(() => events.some((e) => e.type === "text" && e.delta === "b"))).toBe(true);
    time.advance(10_000); // 20 s since the request, 10 s since the last frame
    await tick();
    expect(dials).toBe(0);
    time.advance(5_000); // 15 s of silence now
    expect(await until(() => dials === 1)).toBe(true);
    client.close();
  });

  test("inert without a factory: no liveness timer, a silent command just waits", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), { kind: "gate" }, done]]);
    const target = new Target(makeHost(model, runs));
    const time = manualClock();
    const first = halfOpen(target.connect());
    const client = new RemoteClient(first.channel, new PermissionBroker(), undefined, {
      clock: time.clock,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    void drain(session.send("go")).catch(() => {});
    await until(() => model.waiting);
    first.set("both");
    let settled = false;
    void session.enqueue("x").then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    time.advance(60_000);
    await tick();
    expect(time.pending()).toBe(0);
    expect(settled).toBe(false);
    client.close();
  });

  test("compact is not watched (it answers after a model call)", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), done]]);
    const target = new Target(makeHost(model, runs));
    const time = manualClock();
    const first = halfOpen(target.connect());
    let dials = 0;
    const client = new RemoteClient(first.channel, new PermissionBroker(), undefined, {
      channelFactory: async () => {
        dials += 1;
        return target.connect();
      },
      clock: time.clock,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    await drain(session.send("first"));
    first.set("both");
    void session.compact().catch(() => {});
    await tick();
    time.advance(60_000);
    await tick();
    expect(dials).toBe(0);
    client.close();
  });

  test("a dial that never settles is bounded: the next dial runs, the late channel is closed", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), { kind: "gate" }, t("b"), done]]);
    const target = new Target(makeHost(model, runs));
    const time = manualClock();
    let release: (channel: DuplexChannel) => void = () => {};
    let lateClosed = false;
    let dials = 0;
    const statuses: LinkStatus[] = [];
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: () => {
        dials += 1;
        if (dials === 1) {
          return new Promise<DuplexChannel>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(target.connect());
      },
      clock: time.clock,
      random: () => 0,
    });
    client.onLinkStatus((s) => statuses.push(s));
    await client.initialize();
    const turn = drain(client.newSession(undefined, "S").send("go"));
    await until(() => model.waiting);
    target.last?.close();
    await tick();
    time.advance(0); // backoff 0 → dial 1, which hangs
    await tick();
    expect(dials).toBe(1);
    time.advance(LIVENESS_MS);
    await tick();
    time.advance(0);
    expect(await until(() => dials === 2)).toBe(true);
    expect(
      statuses.some((s) => s.state === "reconnecting" && /no connection after/.test(s.error ?? "")),
    ).toBe(true);
    expect(await until(() => statuses.at(-1)?.state === "up")).toBe(true);
    const [, late] = createChannelPair();
    release({
      ...late,
      close: () => {
        lateClosed = true;
        late.close();
      },
    } as DuplexChannel);
    await tick();
    expect(lateClosed).toBe(true);
    model.open();
    const events = await turn;
    expect(events.at(-1)?.type).toBe("turn_end");
    client.close();
  });

  test("close() during a dial that hangs leaves no timer armed (review nit 1)", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([[t("a"), { kind: "gate" }, done]]);
    const target = new Target(makeHost(model, runs));
    const time = manualClock();
    let dials = 0;
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: () => {
        dials += 1;
        return new Promise<DuplexChannel>(() => {}); // a black-holed host
      },
      clock: time.clock,
      random: () => 0,
    });
    await client.initialize();
    const turn = drain(client.newSession(undefined, "S").send("go")).catch((e: Error) => e);
    await until(() => model.waiting);
    target.last?.close();
    await tick();
    time.advance(0); // dial starts and hangs
    await tick();
    expect(dials).toBe(1);
    client.close();
    expect(time.pending()).toBe(0);
    expect(String(await turn)).toMatch(/connection closed/);
  });
});

describe("re-attach: send-now across a drop (docs/feat/send-now-b.md)", () => {
  test("T-B5: a drop after the ack — the replay hands over, the successor streams to its end, send_now runs once", async () => {
    const runs = { n: 0 };
    const model = new GatedModel([
      [t("a"), { kind: "gate" }, t("b"), done],
      [t("x"), done],
    ]);
    const target = new Target(makeHost(model, runs));
    const dial = dialer(target);
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const old = drain(session.send("go"));
    await until(() => model.waiting);
    const events = await session.sendNow([{ id: "a", text: "A" }], "turn");
    // Down: T1 unwinds, the successor runs and ends — all of it only in the ring.
    dial.hold();
    target.last?.close();
    await tick();
    model.open();
    await until(() => model.calls === 2);
    dial.release();
    const nextEvents: SessionEvent[] = [];
    const collect = (async () => {
      for await (const e of events) nextEvents.push(e);
    })();
    expect(await outcome(collect, 2000)).toBe("completed");
    expect(nextEvents).toEqual([
      { type: "user_message", text: "A" },
      { type: "text", delta: "x" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    const oldEvents = await old;
    expect(oldEvents.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(oldEvents.some((e) => e.type === "text" && e.delta === "x")).toBe(false);
    // Re-sent on the new link (same key) and answered from the cache: one "A",
    // two model calls.
    expect(methods(target.frames[1] ?? [])).toContain("session/send_now");
    const history = await client.snapshot("S");
    expect(history.filter((m) => m.role === "user" && m.content === "A")).toHaveLength(1);
    expect(model.calls).toBe(2);
    client.close();
  });

  /**
   * A host whose ring holds ~1 KB: a long outage forces a resync from a
   * snapshot. Tools are approved daemon-side (`allowAll`): a tool runs while
   * no client is attached to answer a prompt.
   */
  function tinyRingHost(model: ModelProvider): SessionHost {
    return new SessionHost({
      defaultCwd: CWD,
      ringBytes: 1000,
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model,
          tools: new ToolRegistry().register(shellTool),
          env: {
            id: "e",
            exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
            readFile: async () => "",
            writeFile: async () => {},
          },
          requestPermission: allowAll,
        });
        return { agent, permissions };
      },
    });
  }

  test("T-B5b: both turns end behind a resync cut — the re-sent send_now's `ended` closes the successor", async () => {
    const model = new GatedModel([[t("a"), { kind: "gate" }, t("b"), done], long(60)]);
    const target = new Target(tinyRingHost(model));
    const dial = dialer(target);
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const old = drain(session.send("go"));
    await until(() => model.waiting);
    const events = await session.sendNow([{ id: "a", text: "A" }], "turn");
    dial.hold();
    target.last?.close();
    await tick();
    model.open();
    await until(() => model.calls === 2);
    await new Promise((r) => setTimeout(r, 200)); // the successor's 60 deltas overflow the ring
    dial.release();
    const nextEvents: SessionEvent[] = [];
    const collect = (async () => {
      for await (const e of events) nextEvents.push(e);
    })();
    expect(await outcome(collect, 2000)).toBe("completed");
    expect(nextEvents.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    const oldEvents = await old;
    expect(oldEvents.some((e) => e.type === "history_reset")).toBe(true);
    expect(oldEvents.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(methods(target.frames[1] ?? [])).toContain("session/send_now");
    client.close();
  });

  /**
   * Drop after the send-now's ack; while down, T1 unwinds and the successor
   * runs `successor` until its gate, overflowing the ring. Then reconnect
   * (a resync) and open the gate: the successor's tail is "z". `esc`: the
   * user cancels the successor first (after the resync), then the gate opens.
   */
  async function resyncMidSuccessor(successor: Step[][], opts: { esc?: boolean } = {}) {
    const esc = new AbortController();
    const model = new GatedModel([[t("a"), { kind: "gate" }, t("b"), done], ...successor]);
    const target = new Target(tinyRingHost(model));
    const dial = dialer(target);
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const old = drain(session.send("go"));
    await until(() => model.waiting);
    const events = await session.sendNow([{ id: "a", text: "A" }], "turn", esc.signal);
    dial.hold();
    target.last?.close();
    await tick();
    model.open();
    await until(() => model.calls === 1 + successor.length && model.waiting);
    dial.release();
    await until(() => methods(target.frames[1] ?? []).includes("session/send_now"));
    await new Promise((r) => setTimeout(r, 20));
    if (opts.esc) {
      esc.abort();
      await until(() => methods(target.frames[1] ?? []).includes("session/cancel"));
      await new Promise((r) => setTimeout(r, 20));
    }
    model.open();
    const nextEvents: SessionEvent[] = [];
    const collect = (async () => {
      for await (const e of events) nextEvents.push(e);
    })();
    const settled = await outcome(collect, 2000);
    return { client, old, nextEvents, settled, frames: target.frames };
  }
  const tail = (n: number): Step[] => [...long(n).slice(0, -1), { kind: "gate" }, t("z"), done];

  test("T-B5c: a resync cut before the successor committed a round — the reset goes to the old turn, the rest to the successor", async () => {
    // The cut is still at T1's end (taken before the successor's `turn_start`):
    // the snapshot shows T1's history (the reset goes to T1), and the replay
    // past the cut carries the successor's start, rounds and tail — routed by
    // turn id to the successor (docs/feat/tui-foreign-turns.md: before, they
    // went to T1's stream, the latent routing bug, and the start was dropped).
    const r = await resyncMidSuccessor([tail(60)]);
    expect(r.settled).toBe("completed");
    const oldEvents = await r.old;
    expect(oldEvents.some((e) => e.type === "history_reset")).toBe(true);
    expect(oldEvents.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(oldEvents.some((e) => e.type === "text" && (e.delta === "z" || e.delta === "0 "))).toBe(
      false,
    );
    expect(r.nextEvents).toEqual([
      { type: "user_message", text: "A" },
      ...Array.from({ length: 60 }, (_, i) => ({ type: "text" as const, delta: `${i} ` })),
      { type: "text", delta: "z" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    r.client.close();
  });

  test("T-B5d: a resync cut past the hand-off (the successor runs at the cut) — the old turn ends, the reset and the rest go to the successor", async () => {
    // The successor's round 1 is a tool call: its commit moves the cut, which
    // then names the successor as the turn running.
    const r = await resyncMidSuccessor([[shell("s1"), done], tail(60)]);
    expect(r.settled).toBe("completed");
    const oldEvents = await r.old;
    expect(oldEvents.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(oldEvents.some((e) => e.type === "history_reset")).toBe(false);
    expect(oldEvents.some((e) => e.type === "text" && e.delta === "z")).toBe(false);
    // The reset, then the replay past the cut (round 2's deltas), then the tail.
    expect(r.nextEvents[0]?.type).toBe("history_reset");
    expect(r.nextEvents.slice(1)).toEqual([
      ...Array.from({ length: 60 }, (_, i) => ({ type: "text" as const, delta: `${i} ` })),
      { type: "text", delta: "z" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    r.client.close();
  });

  /**
   * T1 ends on its own while the link is dying (its `turn_end` never reaches
   * the client), so the client's send-now takes the daemon's slot-free path:
   * the successor starts at once. Then the link drops and a resync follows,
   * with the cut past the hand-off: the old turn is left settling, and its
   * prompt is re-sent on the new link. `onResentPrompt` runs right after that
   * frame is forwarded (to kill the link while the call is in flight).
   */
  async function pastHandOff(
    onResentPrompt?: (ctl: { target: Target; refuseDials: () => void }) => void,
  ) {
    const model = new GatedModel([
      [t("a"), { kind: "gate" }, t("b"), done],
      [shell("s1"), done],
      tail(60),
    ]);
    const target = new Target(tinyRingHost(model));
    const dial = dialer(target);
    let refused = false;
    const mute = { on: false };
    const first = target.connect();
    const client = new RemoteClient(
      {
        send: (data) => first.send(data),
        close: () => first.close(),
        setOnMessage: (h) => first.setOnMessage((data: string) => (mute.on ? undefined : h(data))),
        setOnClose: (h) => first.setOnClose(h),
      },
      new PermissionBroker(),
      undefined,
      {
        channelFactory: async () => {
          if (refused) throw new ChannelError("unauthorized", "401");
          return dial.factory();
        },
        random: () => 0,
      },
    );
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const old = drain(session.send("go")).catch((e: Error) => e);
    await until(() => model.waiting);
    mute.on = true; // from here the daemon's frames on this link are lost
    model.open();
    await until(() => target.host.get("S")?.running === false);
    const sent = session.sendNow([{ id: "a", text: "A" }], "turn"); // T1 still live here
    await until(() => model.calls === 3 && model.waiting);
    dial.hold();
    first.close();
    await tick();
    if (onResentPrompt) {
      target.onFrame = (frame) => {
        if (target.frames.length === 2 && frame.method === "session/prompt") {
          target.onFrame = null;
          onResentPrompt({
            target,
            refuseDials: () => {
              refused = true;
            },
          });
        }
      };
    }
    dial.release();
    return { client, old, sent, target, model };
  }

  test("T-B5e (follow-up 1): a resync cut past the hand-off — the old turn gets its REAL end (end_turn) from its re-sent prompt, not a guess", async () => {
    const { client, old, sent, target, model } = await pastHandOff();
    const events = await sent; // the re-sent send_now's cached ack
    await until(() => methods(target.frames[1] ?? []).includes("session/prompt"));
    await new Promise((r) => setTimeout(r, 20));
    model.open();
    const nextEvents: SessionEvent[] = [];
    const collect = (async () => {
      for await (const e of events) nextEvents.push(e);
    })();
    expect(await outcome(collect, 2000)).toBe("completed");
    const oldEvents = await old;
    if (oldEvents instanceof Error) throw oldEvents;
    expect(oldEvents.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(oldEvents.some((e) => e.type === "history_reset")).toBe(false);
    expect(nextEvents[0]?.type).toBe("history_reset");
    expect(nextEvents.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    client.close();
  });

  // Review finding 3: a settling old turn always has its keyed `prompt` in
  // flight, and `sessionCall` rejects that call on every terminal path, so the
  // turn fails through its own call; no separate branch is needed.
  test("follow-up 2: settling, then the link stops for good — the old turn fails through its in-flight prompt", async () => {
    const r = await pastHandOff(({ target, refuseDials }) => {
      refuseDials();
      target.last?.close(); // the re-sent prompt's answer is lost with this link
    });
    const end = await Promise.race([
      r.old,
      new Promise((res) => setTimeout(() => res("hung"), 2000)),
    ]);
    expect(String(end)).toMatch(/rejected the credentials: 401/);
    await r.sent.catch(() => undefined);
    r.client.close();
  });

  test("follow-up 2: settling, then the daemon loses the session — the old turn fails, never re-run", async () => {
    const fresh = new GatedModel([]);
    const r = await pastHandOff(({ target }) => {
      target.host = tinyRingHost(fresh); // a new daemon that never heard of S
      target.last?.close();
    });
    const end = await Promise.race([
      r.old,
      new Promise((res) => setTimeout(() => res("hung"), 2000)),
    ]);
    expect(String(end)).toMatch(/lost the session/);
    expect(fresh.calls).toBe(0);
    await r.sent.catch(() => undefined);
    r.client.close();
  });

  test("T-B5f (follow-up 1): the resync hid the successor's turn_start, then Esc — it delivered, so it ends cancelled (no restore, no duplicate)", async () => {
    // As T-B5c (the cut is at T1's end; the successor's `turn_start` is in
    // the replay — before docs/feat/tui-foreign-turns.md it was misrouted to
    // T1 and so never seen), then the user cancels the started successor.
    const r = await resyncMidSuccessor([tail(60)], { esc: true });
    expect(r.settled).toBe("completed"); // not "send-now cancelled before it started"
    expect(r.nextEvents.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    // Its prompt shown once (from its own start), never restored.
    expect(r.nextEvents.filter((e) => e.type === "user_message")).toEqual([
      { type: "user_message", text: "A" },
    ]);
    const history = await r.client.snapshot("S");
    expect(history.filter((m) => m.role === "user" && m.content === "A")).toHaveLength(1);
    r.client.close();
  });
});

describe("session archive across devices (docs/feat/session-archive.md)", () => {
  test("DECISIVE: A's link drops, B closes the session, A reconnects → still archived, A told it ended, never revived", async () => {
    // Owner's addition to 2a. Mutation: SessionHost.open reloads an archived id without
    // `reopen` → A's reconnect silently revives it (live again, archived: false).
    const store = new MemStore();
    const target = new Target(makeHost(new GatedModel([]), { n: 0 }, persisterFor(store)));
    const errors: Error[] = [];
    const dial = dialer(target);
    const aLink = target.connect();
    const a = new RemoteClient(aLink, new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
      onError: (e) => errors.push(e),
    });
    await a.initialize();
    await a.openSession(undefined, undefined, "S");
    const b = new RemoteClient(target.connect(), new PermissionBroker());
    await b.initialize();
    dial.hold();
    aLink.close(); // A goes offline (and stays: the dial is held)
    await tick();
    await b.closeSession("S"); // B ends it meanwhile: archived
    expect(target.host.archivedCount).toBe(1);
    dial.release();
    expect(await until(() => errors.length > 0)).toBe(true);
    expect(errors[0]?.message).toMatch(/session S: recovery failed: .*archived/);
    // Never revived, never recreated from A's copy.
    expect(target.host.get("S")).toBeUndefined();
    const list = await b.sessionList();
    expect(list.sessions.map((s) => [s.sessionId, s.archived])).toEqual([["S", true]]);
    const reopens = (target.frames.at(-1) ?? []).filter((f) => f.method === "session/open");
    expect(reopens.length).toBeGreaterThan(0);
    for (const frame of reopens) {
      expect(frame.params?.create).toBeUndefined();
      expect(frame.params?.messages).toBeUndefined();
      expect(frame.params?.reopen).toBeUndefined();
    }
    a.close();
    b.close();
  });

  test("deleteSession: an attached client sees session_closed{deleted}; the record is gone; a second delete is a no-op", async () => {
    const store = new MemStore();
    const target = new Target(makeHost(new GatedModel([]), { n: 0 }, persisterFor(store)));
    const a = new RemoteClient(target.connect(), new PermissionBroker());
    await a.initialize();
    const reasons: string[] = [];
    await a.openSession(undefined, undefined, "S", {
      output: (out) => {
        if (out.kind === "update" && out.update.type === "session_closed") {
          reasons.push(out.update.reason);
        }
      },
      recovered: () => {},
      linkClosed: () => {},
    });
    // `until` here answers false on a timeout (it never throws): assert it.
    expect(await until(() => store.durable.has("S"))).toBe(true);
    const b = new RemoteClient(target.connect(), new PermissionBroker());
    await b.initialize();
    await b.deleteSession("S");
    expect(await until(() => reasons.length === 1)).toBe(true);
    expect(reasons).toEqual(["deleted"]);
    expect(await until(() => !store.durable.has("S"), 500)).toBe(true);
    expect((await b.sessionList()).sessions).toEqual([]);
    await b.deleteSession("S");
    a.close();
    b.close();
  });

  test("R2-2: the delete lands between the reconnect's UnknownSession and the recreate → A is told, S is not recreated", async () => {
    // Mutation: drop `noteDeleted` in `recreate`'s catch → the listener never fires.
    const target = new Target(makeHost(new GatedModel([]), { n: 0 }));
    const a = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
      onError: () => {},
    });
    const deleted: string[] = [];
    a.onSessionDeleted(({ sessionId }) => deleted.push(sessionId));
    await a.initialize();
    await a.openSession(undefined, [{ role: "user", content: "mine" }], "S");
    // A daemon that never heard of S: the reconnect is UnknownSession...
    const fresh = makeHost(new GatedModel([]), { n: 0 });
    const open = fresh.open.bind(fresh);
    let opens = 0;
    fresh.open = (params, attachment, prepared) => {
      opens += 1;
      try {
        return open(params, attachment, prepared);
      } finally {
        // ...and another device deletes S right after, before A's recreate.
        if (opens === 1) fresh.addDeleted("S");
      }
    };
    target.host = fresh;
    target.last?.close();
    expect(await until(() => deleted.length > 0)).toBe(true);
    expect(deleted).toEqual(["S"]);
    expect(opens).toBe(2); // the reconnect, then the recreate that was refused
    expect(fresh.get("S")).toBeUndefined();
    a.close();
  });

  test("F1: A's link drops, B DELETES the session, A reconnects → SessionDeleted, never recreated, A is told (by code)", async () => {
    // The Review's repro, through the client. Mutation: the daemon keeps no
    // tombstone → UnknownSession → A recreates S from its own copy (live again).
    const store = new MemStore();
    const target = new Target(makeHost(new GatedModel([]), { n: 0 }, persisterFor(store)));
    const dial = dialer(target);
    const aLink = target.connect();
    const a = new RemoteClient(aLink, new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
      onError: () => {},
    });
    const deleted: string[] = [];
    a.onSessionDeleted(({ sessionId }) => deleted.push(sessionId));
    await a.initialize();
    await a.openSession(undefined, [{ role: "user", content: "mine" }], "S");
    const b = new RemoteClient(target.connect(), new PermissionBroker());
    await b.initialize();
    dial.hold();
    aLink.close();
    await tick();
    await b.deleteSession("S");
    dial.release();
    expect(await until(() => deleted.length > 0)).toBe(true);
    expect(deleted).toEqual(["S"]);
    expect(target.host.get("S")).toBeUndefined();
    expect(await until(() => !store.durable.has("S"), 500)).toBe(true);
    expect((await b.sessionList()).sessions).toEqual([]);
    const opens = (target.frames.at(-1) ?? []).filter((f) => f.method === "session/open");
    expect(opens.length).toBe(1); // the reconnect only: no recreate after it
    expect(opens[0]?.params?.messages).toBeUndefined();
    // A later open of it (a `--resume` of the local copy) is refused the same way.
    await expect(
      a.openSession(undefined, [{ role: "user", content: "mine" }], "S"),
    ).rejects.toMatchObject({
      code: DomainErrorCode.SessionDeleted,
    });
    expect(deleted).toEqual(["S", "S"]);
    expect(target.host.get("S")).toBeUndefined();
    a.close();
    b.close();
  });
});

describe("re-attach: a crash-cut turn's steers after a `serve` restart (docs/feat/queued-broadcast.md, owner Q2)", () => {
  /** A writer with "A" (id `a`) queued in a running turn, and the record a crash leaves. */
  async function crashedWriter() {
    const runs = { n: 0 };
    const store = new MemStore();
    const model1 = new GatedModel([[t("a"), { kind: "gate" }, done]]);
    const target = new Target(makeHost(model1, runs, persisterFor(store)));
    const d = dialer(target);
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: d.factory,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const returned: (readonly ReturnedRow[])[] = [];
    session.onReturned((rows) => returned.push(rows));
    const turn = drain(session.send("go")).catch((e: Error) => e);
    await until(() => model1.waiting);
    await session.enqueue("A", "a");
    await target.host.get("S")?.persisted();
    const parsed = parseDaemonRecord(
      JSON.parse(JSON.stringify(store.durable.get("S"))),
      (c) => c === CWD,
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.record.turn).toMatchObject({ steering: ["A"], steeringIds: ["a"] });
    const model2 = new GatedModel([[t("sent"), done]]);
    const host2 = makeHost(model2, runs, persisterFor(new MemStore()));
    return { client, session, returned, turn, target, d, record: parsed.record, host2, model2 };
  }

  test("Q-R2 the writer reconnects: its steer comes back once (ended), is reclaimed, never enters the history", async () => {
    // Mutation: no v4 branch in reconcileOnReload → nothing returned, "A" in the history.
    const w = await crashedWriter();
    w.host2.restore(w.record);
    w.target.host = w.host2;
    w.target.last?.close();
    await until(() => w.returned.length === 1);
    expect(w.returned).toEqual([[{ id: "a", text: "A", cause: "ended" }]]);
    await until(() => w.client.queuedOf("S")?.returned.length === 0);
    await w.turn;
    expect((await w.client.snapshot("S")).map((m) => m.content)).not.toContain("A");
    expect(w.returned).toHaveLength(1);
    expect(w.model2.calls).toBe(0); // never re-sent by itself
    w.client.close();
  });

  test("Q-R2 my send-now in flight across the crash carries the returned row: sent once, never also handed back", async () => {
    // Mutation: queueChanged ignores the live send-now's ids → "A" handed back AND sent.
    const w = await crashedWriter();
    w.d.hold();
    w.target.last?.close();
    w.host2.restore(w.record);
    w.target.host = w.host2;
    // The chord while the link is down: it goes out after the resync.
    const sent = w.session.sendNow([{ id: "a", text: "A" }], "turn");
    w.d.release();
    const events = await drain(await sent);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(w.model2.calls).toBe(1);
    await until(() => w.client.queuedOf("S")?.returned.length === 0);
    expect(w.returned).toEqual([]);
    const history = (await w.client.snapshot("S")).map((m) => m.content);
    expect(history.filter((c) => c === "A")).toHaveLength(1);
    await w.turn;
    w.client.close();
  });
});

describe("returned rows of a closed session (docs/feat/queued-broadcast.md, owner F2)", () => {
  /** The writer with "A" (id `a`) queued in a running turn on a persisting daemon. */
  async function queuedWriter() {
    const runs = { n: 0 };
    const store = new MemStore();
    const model = new GatedModel([[t("a"), { kind: "gate" }, done]]);
    const target = new Target(makeHost(model, runs, persisterFor(store)));
    const d = dialer(target);
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: d.factory,
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const returned: (readonly ReturnedRow[])[] = [];
    session.onReturned((rows) => returned.push(rows));
    const turn = drain(session.send("go")).catch((e: Error) => e);
    await until(() => model.waiting);
    await session.enqueue("A", "a");
    return { client, returned, turn, target, d, store };
  }

  /** Reopen the archived "S" (an explicit act): the queue the reopened session holds. */
  async function reopened(host: SessionHost) {
    const prepared = await host.prepareOpen({ sessionId: "S", reopen: true });
    const { hosted } = host.open({ sessionId: "S", reopen: true }, { send: () => {} }, prepared);
    return hosted.snapshotPage().queued;
  }

  test("closed with my row queued: it comes back once, my reclaim lands in the archive, a reopen returns nothing", async () => {
    // Mutation: `session/reclaim` refuses an archived session (UnknownSession) → the reopen returns "A" again.
    const w = await queuedWriter();
    w.target.host.close("S");
    await until(() => w.returned.length === 1);
    expect(w.returned).toEqual([[{ id: "a", text: "A", cause: "ended" }]]);
    await until(() => w.store.durable.get("S")?.returned.length === 0);
    expect(w.store.durable.get("S")?.archivedAt).toBeNumber();
    // Still archived: the reclaim revived nothing.
    expect(w.target.host.get("S")).toBeUndefined();
    expect(await reopened(w.target.host)).toEqual({ entries: [], returned: [] });
    expect(w.returned).toHaveLength(1);
    await w.turn;
    w.client.close();
  });

  test("the writer is offline at the close: its row stays held in the archive, a reopen returns it once", async () => {
    // Mutation: the archived record loses its returned rows → the reopen returns nothing.
    const w = await queuedWriter();
    w.d.hold();
    w.target.last?.close();
    w.target.host.close("S");
    await until(() => w.store.durable.get("S")?.archivedAt !== undefined);
    expect(w.store.durable.get("S")?.returned).toEqual([{ id: "a", text: "A", cause: "ended" }]);
    expect(await reopened(w.target.host)).toEqual({
      entries: [],
      returned: [{ id: "a", text: "A", cause: "ended" }],
    });
    expect(w.returned).toEqual([]);
    w.client.close();
  });
});
