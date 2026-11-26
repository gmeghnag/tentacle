import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  DEFAULT_SCHEDULE_LIMITS,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  SCHEDULE_CHECK_INTERVAL_MS,
  SCHEDULE_TTL_MS,
  type ScheduleLimits,
  type ScheduleLink,
  type StreamEvent,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type SessionUpdate,
  type SnapshotResult,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { DAEMON_STATE_VERSION_SCHEDULES, parseSidecar } from "../src/daemon-state-file.ts";
import type { HostedSession } from "../src/hosted-session.ts";
import type { DaemonSessionState } from "../src/persisted-session.ts";
import { type AgentContext, SessionHost } from "../src/session-host.ts";
import { SessionPersister, type StateBuild } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";
import { stripped } from "./support/model-prompt.ts";

// The agent's own scheduled wakes, daemon side (docs/feat/cron-tool.md S3):
// the table + ONE timer on `HostedSession`, a fire = an ordinary `prompt()`
// under a `wake-` id. Real `SessionHost` + `Connection`, a scripted model, an
// injected clock and an injected timer (no real sleeps). Each test names the
// mutation that turns it red (AGENTS §9).

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 16, 9, 0);

async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await flush();
  }
}

const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done: StreamEvent = { type: "done" };
const shell = (id: string, command: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "shell", arguments: JSON.stringify({ command }) },
});

type Step =
  | readonly StreamEvent[]
  | { readonly fail: string }
  | { readonly gate: Promise<void>; readonly events?: readonly StreamEvent[] };

function gated(events?: readonly StreamEvent[]): { step: Step; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { step: { gate: promise, ...(events ? { events } : {}) }, release: () => resolve() };
}

class Model implements ModelProvider {
  readonly id = "model";
  readonly seen: ChatRequest[] = [];
  readonly steps: Step[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request);
    const step = this.steps.shift() ?? [text("ok"), done];
    if ("fail" in step) throw new Error(step.fail);
    if ("gate" in step) {
      await step.gate;
      for (const e of step.events ?? [text("ok"), done]) yield e;
      return;
    }
    for (const e of step) yield e;
  }
  /** The fired prompts the model was given, in order (a request's last user message). */
  fired(): string[] {
    return this.seen
      .map((r) => stripped(r.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""))
      .filter((c) => c.startsWith("[scheduled "));
  }
}

/** The injected timer: every arm recorded, run by hand. */
class FakeTimers {
  readonly armed: { fn: () => void; ms: number; cleared: boolean }[] = [];
  readonly set = (fn: () => void, ms: number): unknown => {
    const handle = { fn, ms, cleared: false };
    this.armed.push(handle);
    return handle;
  };
  readonly clear = (handle: unknown): void => {
    (handle as { cleared: boolean }).cleared = true;
  };
  /** The live (not cleared, not run) timers. */
  live(): { fn: () => void; ms: number; cleared: boolean }[] {
    return this.armed.filter((t) => !t.cleared);
  }
  /** Run every live timer once (as if each delay elapsed). */
  run(): void {
    for (const t of this.live()) {
      t.cleared = true;
      t.fn();
    }
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

interface RigOptions {
  readonly schedules?: boolean;
  readonly persister?: SessionPersister;
  readonly model?: Model;
  readonly clock?: { now: number };
  /** The host's `schedules.*` limits (S4); absent = the defaults. */
  readonly limits?: ScheduleLimits;
}

function rig(opts: RigOptions = {}) {
  const model = opts.model ?? new Model();
  const clock = opts.clock ?? { now: T0 };
  const timers = new FakeTimers();
  const audit: string[] = [];
  const errors: Error[] = [];
  const contexts: AgentContext[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/schedules",
    now: () => clock.now,
    ...(opts.persister ? { persister: opts.persister } : {}),
    ...(opts.schedules !== false
      ? {
          schedules: {
            onAudit: (line: string) => audit.push(line),
            setTimeout: timers.set,
            clearTimeout: timers.clear,
            ...(opts.limits ? { limits: opts.limits } : {}),
          },
        }
      : {}),
    onTurnError: (error) => errors.push(error),
    createAgent: (_cwd, context) => {
      contexts.push(context);
      const permissions = context.reuse?.permissions ?? new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return {
        agent,
        permissions,
        ...(context.settings
          ? { settingsReport: { carried: context.settings, overridden: {} } }
          : {}),
      };
    },
  });
  const connect = async () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", INIT);
    const open = (params: Record<string, unknown> = {}) =>
      client.request("session/open", { sessionId: "S", ...params }) as Promise<OpenResult>;
    const prompt = (turnId: string, value = "go") =>
      client.request("session/prompt", {
        sessionId: "S",
        turnId,
        content: [{ type: "text", text: value }],
      });
    const detach = () => client.request("session/detach", { sessionId: "S" });
    const resolve = (requestId: string, optionId: string) =>
      client.request("session/resolve_permission", { sessionId: "S", requestId, optionId });
    const snapshot = () =>
      client.request("session/snapshot", { sessionId: "S" }) as Promise<SnapshotResult>;
    const of = <T extends SessionUpdate["type"]>(type: T) =>
      updates
        .map((u) => u.update)
        .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
    return { client, updates, open, prompt, detach, resolve, snapshot, of };
  };
  const hosted = (): HostedSession => {
    const s = host.get("S");
    if (!s) throw new Error("no session S");
    return s;
  };
  const link = (): ScheduleLink => {
    const l = hosted().scheduleLink();
    if (!l) throw new Error("no schedule link");
    return l;
  };
  /** A session with one normal turn behind it, then detached: nobody attached. */
  const detachedAfterTurn = async () => {
    const a = await connect();
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    await a.detach();
    await settle();
    return a;
  };
  /** Move the clock and run the session's check, as its timer would. */
  const tick = async (ms: number) => {
    clock.now += ms;
    hosted().checkSchedules();
    await settle();
  };
  return {
    model,
    clock,
    timers,
    audit,
    errors,
    contexts,
    host,
    connect,
    hosted,
    link,
    detachedAfterTurn,
    tick,
  };
}

/** A `SessionPersister` that also keeps every state it was handed, in order. */
class CapturingPersister extends SessionPersister {
  readonly captures: DaemonSessionState[] = [];
  override schedule(id: string, build: StateBuild): void {
    this.captures.push(build());
    super.schedule(id, build);
  }
}

function persisterOn(store: SpyDaemonStore): CapturingPersister {
  return new CapturingPersister({ store, cwd: "/tmp/schedules", model: "m", onError: () => {} });
}

describe("a session fires its own scheduled wakes (S3)", () => {
  test("T-D1 a due job starts ONE `wake-` turn whose prompt names the job; the model sees it", async () => {
    // Mutation: skip the `prompt()` in the fire → no second model call.
    const r = rig();
    await r.detachedAfterTurn();
    const made = r.link().create({ prompt: "check CI", every: "10m" });
    expect(made.ok && made.job.id).toBe("sc-1");
    await r.tick(9 * MIN);
    expect(r.model.seen.length).toBe(1);
    await r.tick(1 * MIN);
    expect(r.model.seen.length).toBe(2);
    expect(r.model.fired()).toEqual(["[scheduled sc-1 · every 10m · fire 1] check CI"]);
    expect(r.hosted().running).toBe(false);
    expect(r.audit).toContain("wake: scheduled sc-1 S");
    // Advanced and re-armed: the next slot is the grid's, not "now + 10m" drift.
    const [job] = r.link().list();
    expect(job?.fires).toBe(1);
    expect(job?.nextAt).toBe(T0 + 20 * MIN);
  });

  test("T-D1b an attached client sees the fired turn_start's {id, spec} and every list change", async () => {
    // Mutation: drop `schedule` from the fire's `turn_start` → no ref on the wire.
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    r.link().create({ prompt: "check CI", every: "10m" });
    await settle();
    await r.tick(10 * MIN);
    const start = a.of("turn_start").at(-1);
    expect(start?.turnId.startsWith("wake-")).toBe(true);
    expect(start?.prompt).toBe("[scheduled sc-1 · every 10m · fire 1] check CI");
    // The fire stamped with its ordinal and instant (scheduled-fire-row): the
    // same record on the wire ref and on the stored user message.
    const fired = { id: "sc-1", spec: "every 10m", fire: 1, at: T0 + 10 * MIN };
    expect(start?.schedule).toEqual(fired);
    await settle();
    const stored = (await a.snapshot()).messages.filter((m) => m.role === "user").at(-1);
    expect(stored?.content).toBe("[scheduled sc-1 · every 10m · fire 1] check CI");
    expect(stored?.scheduled).toEqual(fired);
    // One frame for the create, one for the fire (fires 0 → 1).
    const lists = a.of("schedules").map((u) => u.schedules.map((row) => [row.id, row.fires]));
    expect(lists).toEqual([[["sc-1", 0]], [["sc-1", 1]]]);
    expect(r.link().delete("sc-1")).toBe(true);
    await settle();
    expect(a.of("schedules").at(-1)?.schedules).toEqual([]);
  });

  test("T-D2 due while a turn runs: no second turn, no lost slot; exactly one fire at its end", async () => {
    // Mutation: pass `idle: true` to `scheduleStep` whatever the slot → the
    // slot is advanced while busy, `prompt` throws, and nothing fires at the end.
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    r.link().create({ prompt: "check CI", every: "10m" });
    const { step, release } = gated();
    r.model.steps.push(step);
    await a.prompt("t1");
    await settle();
    expect(r.hosted().running).toBe(true);
    await r.tick(25 * MIN);
    // Busy: nothing fired, nothing advanced, and the timer polls (never a 0 ms spin).
    expect(r.model.seen.length).toBe(1);
    expect(r.link().list()[0]?.fires).toBe(0);
    expect(r.timers.live().map((t) => t.ms)).toEqual([SCHEDULE_CHECK_INTERVAL_MS]);
    release();
    await settle();
    // The turn's end kicked a check on the next macrotask.
    expect(r.timers.live().map((t) => t.ms)).toEqual([0]);
    r.timers.run();
    await settle();
    expect(r.model.fired()).toEqual(["[scheduled sc-1 · every 10m · fire 1] check CI"]);
    // Catch-up ONCE: two missed slots, one fire, the next slot after now.
    expect(r.link().list()[0]?.nextAt).toBe(T0 + 30 * MIN);
    expect(r.errors).toEqual([]);
  });

  test("T-D3 advance BEFORE fire: every capture naming the fired turn already has the slot moved", async () => {
    // Mutation: commit the advanced table AFTER `prompt()` → the turn's own
    // capture still holds the old slot (a crash there would fire it again).
    const store = new SpyDaemonStore();
    const persister = persisterOn(store);
    const r = rig({ persister });
    await r.detachedAfterTurn();
    r.link().create({ prompt: "check CI", every: "10m" });
    await r.tick(10 * MIN);
    const withWake = persister.captures.filter((c) => c.turn?.turnId.startsWith("wake-"));
    expect(withWake.length).toBeGreaterThan(0);
    for (const capture of withWake) {
      expect(capture.schedules?.map((j) => [j.fires, j.nextAt])).toEqual([[1, T0 + 20 * MIN]]);
    }
    await persister.stop();
  });

  test("T-D3b a recurring job past its 7-day expiry: removed, published, captured, audited; never fired", async () => {
    // Mutation: drop `persist()` / `publishSchedules()` from `checkSchedules`'
    // `due === null && changed` branch → the dead row stays on the wire / on disk.
    const store = new SpyDaemonStore();
    const persister = persisterOn(store);
    const r = rig({ persister });
    const a = await r.connect();
    await a.open({ create: true });
    r.link().create({ prompt: "check CI", every: "10m" });
    await settle();
    expect(
      a
        .of("schedules")
        .at(-1)
        ?.schedules.map((row) => row.id),
    ).toEqual(["sc-1"]);
    expect(persister.captures.at(-1)?.schedules?.map((j) => j.id)).toEqual(["sc-1"]);
    const captured = persister.captures.length;
    await r.tick(SCHEDULE_TTL_MS);
    // Expired, not fired: the sweep runs before the due pick.
    expect(r.model.fired()).toEqual([]);
    expect(r.link().list()).toEqual([]);
    expect(a.of("schedules").at(-1)?.schedules).toEqual([]);
    expect(persister.captures.length).toBeGreaterThan(captured);
    expect(persister.captures.at(-1)?.schedules ?? []).toEqual([]);
    expect(r.audit).toContain("schedule: sc-1 expired S");
    await persister.stop();
  });

  test("T-D4 a restart past two slots fires exactly ONCE (catch-up); v3 only while non-empty", async () => {
    // Mutation: drop `schedules` from `restore`'s state → nothing fires after the restart.
    const store = new SpyDaemonStore();
    const persister = persisterOn(store);
    const clock = { now: T0 };
    const r = rig({ persister, clock });
    await r.detachedAfterTurn();
    await persister.flush("S");
    const version = () => JSON.parse(store.files.get("S")?.state ?? "{}").schemaVersion;
    expect(version()).toBe(1);
    r.link().create({ prompt: "check CI", every: "10m" });
    await persister.flush("S");
    expect(version()).toBe(3);
    await persister.stop();
    const record = store.durable.get("S");
    if (!record) throw new Error("not saved");
    expect(record.schedules?.map((j) => j.id)).toEqual(["sc-1"]);
    // The daemon was down for 25 minutes (two missed slots), then restarts.
    clock.now = T0 + 25 * MIN;
    const persister2 = persisterOn(store);
    const r2 = rig({ persister: persister2, clock, model: r.model });
    const restored = r2.host.restore(record);
    // Re-armed at once: the first check is due now.
    expect(r2.timers.live().map((t) => t.ms)).toEqual([0]);
    r2.timers.run();
    await settle();
    r2.timers.run();
    await settle();
    expect(r.model.fired()).toEqual(["[scheduled sc-1 · every 10m · fire 1] check CI"]);
    expect(restored.scheduleLink()?.list()[0]?.nextAt).toBe(T0 + 30 * MIN);
    // A new create after the restart never reuses an id the model has seen.
    const next = restored.scheduleLink()?.create({ prompt: "two", every: "1h" });
    expect(next?.ok && next.job.id).toBe("sc-2");
    // Back to empty → back to v1 (readable by every build).
    restored.deleteSchedule("sc-1");
    restored.deleteSchedule("sc-2");
    await persister2.flush("S");
    expect(version()).toBe(1);
    await persister2.stop();
  });

  test("T-D5 a fired turn's ask with nobody attached is HELD: busy, no further fire; an answer completes it", async () => {
    // Mutation: fire while busy (`idle: true`) → a second fire during the held ask.
    const r = rig();
    await r.detachedAfterTurn();
    r.link().create({ prompt: "run make", every: "10m" });
    r.model.steps.push([shell("c1", "make"), done]);
    await r.tick(10 * MIN);
    expect(r.hosted().running).toBe(true);
    await r.tick(30 * MIN);
    expect(r.model.fired().length).toBe(1);
    expect(r.link().list()[0]?.fires).toBe(1);
    const b = await r.connect();
    await b.open();
    const ask = b.of("permission_request")[0];
    if (!ask) throw new Error("no ask replayed");
    await b.resolve(ask.requestId, "allow_once");
    await settle();
    expect(r.hosted().running).toBe(false);
    // The slot is free again: the overdue job fires at the check its end kicked.
    r.timers.run();
    await settle();
    expect(r.model.fired().at(-1)).toBe("[scheduled sc-1 · every 10m · fire 2] run make");
  });
});

describe("the table is the SESSION's: lifecycle (S3, D7)", () => {
  test("T-D6a `/clear` KEEPS the table (owner Q7) and the kept fork carries none", async () => {
    // Mutation: empty the table in `clear()` → sc-1 gone and nothing fires.
    const store = new SpyDaemonStore();
    const persister = persisterOn(store);
    const r = rig({ persister });
    await r.detachedAfterTurn();
    r.link().create({ prompt: "check CI", every: "10m" });
    r.hosted().clear();
    await persister.flush("S");
    expect(
      r
        .link()
        .list()
        .map((j) => j.id),
    ).toEqual(["sc-1"]);
    const forks = [...store.files.entries()].filter(([id]) => id !== "S");
    expect(forks.length).toBe(1);
    for (const [, files] of forks) {
      expect(JSON.parse(files.state ?? "{}").schedules).toBeUndefined();
    }
    await r.tick(10 * MIN);
    expect(r.model.fired()).toEqual(["[scheduled sc-1 · every 10m · fire 1] check CI"]);
    await persister.stop();
  });

  test("T-D6b a compaction keeps the table; a settings sync hands the rebuilt agent the SAME link", async () => {
    // Mutation: drop `schedules` from `updateSettings`' context → the rebuilt
    // agent has no link (its tools would lose the session's wakes).
    const r = rig();
    await r.detachedAfterTurn();
    r.link().create({ prompt: "check CI", every: "10m" });
    r.model.steps.push([text("summary"), done]);
    await r.hosted().compact();
    expect(
      r
        .link()
        .list()
        .map((j) => j.id),
    ).toEqual(["sc-1"]);
    r.host.updateSettings(r.hosted(), "S", { autoTitle: false });
    const rebuilt = r.contexts.at(-1);
    expect(r.contexts.length).toBe(2);
    expect(
      rebuilt
        ?.schedules?.()
        ?.list()
        .map((j) => j.id),
    ).toEqual(["sc-1"]);
    await r.tick(10 * MIN);
    expect(r.model.fired()).toEqual(["[scheduled sc-1 · every 10m · fire 1] check CI"]);
  });

  test("T-D7 close clears the timer; an archive freezes the table; `reopen` re-arms it (catch-up once)", async () => {
    // Mutation: drop `disarmSchedules()` from `close` → a live timer after close.
    const store = new SpyDaemonStore();
    const persister = persisterOn(store);
    const clock = { now: T0 };
    const r = rig({ persister, clock });
    await r.detachedAfterTurn();
    r.link().create({ prompt: "check CI", every: "10m" });
    expect(r.timers.live().length).toBe(1);
    r.host.close("S");
    expect(r.timers.live()).toEqual([]);
    await persister.flush("S");
    await settle();
    expect(store.durable.get("S")?.archivedAt).toBeNumber();
    expect(store.durable.get("S")?.schedules?.map((j) => j.id)).toEqual(["sc-1"]);
    // Archived for 25 minutes: nothing fires (no session, no timer).
    clock.now = T0 + 25 * MIN;
    expect(r.model.fired()).toEqual([]);
    const a = await r.connect();
    await a.open({ reopen: true });
    expect(r.timers.live().map((t) => t.ms)).toEqual([0]);
    r.timers.run();
    await settle();
    expect(r.model.fired()).toEqual(["[scheduled sc-1 · every 10m · fire 1] check CI"]);
    expect(r.link().list()[0]?.nextAt).toBe(T0 + 30 * MIN);
    await persister.stop();
  });

  test("T-D8 an armed schedule keeps a detached session out of the idle TTL (owner Q5); none → reaped", async () => {
    // Mutation: drop the schedule term from `liveness().busy` → reaped with a wake armed.
    const clock = { now: T0 };
    const r = rig({ clock });
    await r.detachedAfterTurn();
    r.link().create({ prompt: "daily", every: "1d" });
    clock.now += 2 * 60 * MIN;
    expect(r.host.reapExpired({ idleTtlMs: 60 * MIN }).map((e) => e.id)).toEqual([]);
    expect(r.hosted().deleteSchedule("sc-1")).toEqual({ deleted: true });
    expect(r.host.reapExpired({ idleTtlMs: 60 * MIN }).map((e) => e.id)).toEqual(["S"]);
  });
});

describe("the wire and the runtimes (S3, D5/D1)", () => {
  test("T-D9 `session/schedule_delete` answers while a turn holds the slot; list, snapshot and count follow", async () => {
    // Mutation: route the method through the busy slot (`assertIdle`) → it rejects mid-turn.
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    r.link().create({ prompt: "one", every: "10m" });
    r.link().create({ prompt: "two", at: "in 30m" });
    await settle();
    const firstPage = await a.snapshot();
    // (`at in 30m` is stored resolved, in the host's zone: only its prefix is pinned here.)
    expect(firstPage.schedules?.map((row) => [row.id, row.kind, row.spec.slice(0, 3)])).toEqual([
      ["sc-1", "every", "eve"],
      ["sc-2", "at", "at "],
    ]);
    // A one-shot carries no user-facing expiry; a recurring one does.
    expect(firstPage.schedules?.map((row) => row.expiresAt === undefined)).toEqual([false, true]);
    const list = (await a.client.request("session/list", {})) as {
      sessions: { sessionId: string; schedules?: number }[];
    };
    expect(list.sessions.find((s) => s.sessionId === "S")?.schedules).toBe(2);
    const { step, release } = gated();
    r.model.steps.push(step);
    await a.prompt("t1");
    await settle();
    expect(r.hosted().running).toBe(true);
    const del = (scheduleId: string) =>
      a.client.request("session/schedule_delete", { sessionId: "S", scheduleId });
    expect(await del("sc-1")).toEqual({ deleted: true });
    expect(await del("sc-1")).toEqual({
      deleted: false,
      reason: "no scheduled wake sc-1 in this session",
    });
    expect(r.hosted().running).toBe(true);
    expect(
      a
        .of("schedules")
        .at(-1)
        ?.schedules.map((row) => row.id),
    ).toEqual(["sc-2"]);
    release();
    await settle();
  });

  test("T-D10 a host without the option (a pod daemon): no link, no list, no count, delete refused", async () => {
    // Mutation: pass the link to the factory unconditionally → a pod's agent gets one.
    const r = rig({ schedules: false });
    const a = await r.connect();
    await a.open({ create: true });
    expect(r.hosted().scheduleLink()).toBeNull();
    expect(r.contexts[0]?.schedules).toBeUndefined();
    expect(await a.snapshot()).not.toHaveProperty("schedules");
    const list = (await a.client.request("session/list", {})) as {
      sessions: { schedules?: number }[];
    };
    expect(list.sessions[0]).not.toHaveProperty("schedules");
    expect(
      await a.client.request("session/schedule_delete", { sessionId: "S", scheduleId: "sc-1" }),
    ).toEqual({ deleted: false, reason: "this session has no scheduled wakes" });
  });

  test("T-D12 the host's limits (`schedules.*`, S4) are the ones the link's create applies", async () => {
    // Mutation: `createSchedule` drops `limits` → the 2-job cap and 5m floor are ignored.
    const r = rig({
      limits: { ...DEFAULT_SCHEDULE_LIMITS, maxJobs: 2, minIntervalMs: 5 * MIN },
    });
    await r.detachedAfterTurn();
    const floor = r.link().create({ prompt: "p", every: "4m" });
    expect(floor.ok).toBe(false);
    if (!floor.ok) expect(floor.reason).toContain("at least 5m");
    expect(r.link().create({ prompt: "a", every: "5m" }).ok).toBe(true);
    expect(r.link().create({ prompt: "b", every: "5m" }).ok).toBe(true);
    const full = r.link().create({ prompt: "c", every: "5m" });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.reason).toContain("already 2 scheduled wakes");
    // A refused create mints no id: the two accepted ones are sc-1 and sc-2.
    expect(
      r
        .link()
        .list()
        .map((job) => job.id),
    ).toEqual(["sc-1", "sc-2"]);
  });

  test("T-D11 three failed fires in a row remove the job; a failed turn does NOT block the next fire", async () => {
    // Mutation: drop the `settleFired` call in `finishTurn` → the job fires forever.
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    r.link().create({ prompt: "ping", every: "1m" });
    for (let i = 0; i < 3; i++) {
      r.model.steps.push({ fail: "401 unauthorized" });
      await r.tick(MIN);
      expect(r.hosted().running).toBe(false);
    }
    expect(r.model.fired().length).toBe(3);
    expect(r.link().list()).toEqual([]);
    expect(a.of("schedules").at(-1)?.schedules).toEqual([]);
    expect(r.audit).toContain("schedule: sc-1 stopped after failures S");
    await r.tick(MIN);
    expect(r.model.fired().length).toBe(3);
  });
});

describe("the state file's v3 (D6, owner Q8)", () => {
  /** A real v3 state file: a session with one wake, persisted. */
  async function v3(): Promise<Record<string, unknown>> {
    const store = new SpyDaemonStore();
    const persister = persisterOn(store);
    const r = rig({ persister });
    await r.detachedAfterTurn();
    r.link().create({ prompt: "check CI", every: "10m" });
    await persister.stop();
    return JSON.parse(store.files.get("S")?.state ?? "{}") as Record<string, unknown>;
  }
  const parse = (value: Record<string, unknown>) => parseSidecar(JSON.stringify(value), "S");

  test("a v3 file round-trips its table", async () => {
    const file = await v3();
    expect(file.schemaVersion).toBe(DAEMON_STATE_VERSION_SCHEDULES);
    const parsed = parse(file);
    expect(parsed.ok && parsed.value.schedules?.map((j) => [j.id, j.kind, j.intervalMs])).toEqual([
      ["sc-1", "every", 10 * MIN],
    ]);
  });

  test("schedules in a v1/v2 file are REFUSED, never half-loaded (what an older build would do)", async () => {
    // Mutation: accept `schedules` whatever the version → the v2 file loads.
    const file = await v3();
    for (const schemaVersion of [1, 2]) {
      const parsed = parse({ ...file, schemaVersion });
      expect(parsed.ok ? "loaded" : parsed.reason).toBe(
        `a schemaVersion ${schemaVersion} state file carries "schedules" (it must be 3)`,
      );
    }
    // And an unknown newer version is refused as before (4 is slice 10's,
    // agent-workflows; 5 is session apps').
    const newer = parse({ ...file, schemaVersion: 6 });
    expect(newer.ok).toBe(false);
  });

  test("a malformed table refuses the session (bad count, duplicate id, `at` with an interval)", async () => {
    const file = await v3();
    const [job] = file.schedules as Record<string, unknown>[];
    const bad = [
      [{ ...job, fires: -1 }],
      [job, job],
      [{ ...job, kind: "at" }],
      [{ ...job, kind: "cron" }],
      [{ ...job, id: "x-1" }],
      "sc-1",
    ];
    for (const schedules of bad) {
      const parsed = parse({ ...file, schedules });
      expect(parsed.ok ? "loaded" : parsed.reason).toBe('"schedules" is malformed');
    }
  });
});
