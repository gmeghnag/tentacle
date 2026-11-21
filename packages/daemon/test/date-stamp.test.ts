/**
 * The date stamp daemon-side (docs/fix/prompt-current-date.md): the session — not
 * the client, not the model — decides WHEN from its own clock and history, and
 * renders in the LAPTOP's zone. A fired wake is stamped with its FIRE instant
 * while the stored job prompt never carries a date (a recurring job must not
 * replay an old one). Real `SessionHost` + `Connection`, a scripted model, an
 * injected clock and timer.
 */
import { describe, expect, test } from "bun:test";
import { Agent, type Session } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type ScheduleLink,
  type StreamEvent,
  nextDateStamp,
} from "@tentacle/core";
import { PROTOCOL_VERSION, type SessionUpdate } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { type AgentContext, SessionHost } from "../src/session-host.ts";

const MIN = 60_000;
/** 2026-11-20T12:00Z = 13:00 in Rome (CET). */
const T0 = Date.UTC(2026, 10, 20, 12, 0);

class Model implements ModelProvider {
  readonly id = "model";
  readonly seen: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(structuredClone({ ...request, signal: undefined }));
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
  /** The last user message's content, per request. */
  userLines(): string[] {
    return this.seen.map((r) => r.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
  }
}

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
  run(): void {
    for (const t of this.armed.filter((t) => !t.cleared)) {
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

async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await flush();
  }
}

function rig() {
  const model = new Model();
  const clock = { now: T0 };
  const timers = new FakeTimers();
  const host = new SessionHost({
    defaultCwd: "/tmp/date-stamp",
    now: () => clock.now,
    schedules: {
      onAudit: () => {},
      setTimeout: timers.set,
      clearTimeout: timers.clear,
    },
    createAgent: (_cwd: string, context: AgentContext) => {
      const permissions = context.reuse?.permissions ?? new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const connect = async (capabilities: Record<string, unknown> = {}) => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const updates: SessionUpdate[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") {
          updates.push((params as { update: SessionUpdate }).update);
        }
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true, ...capabilities },
    });
    const open = (params: Record<string, unknown> = {}) =>
      client.request("session/open", { sessionId: "S", ...params });
    const prompt = (turnId: string, text = "go") =>
      client.request("session/prompt", {
        sessionId: "S",
        turnId,
        content: [{ type: "text", text }],
      });
    const detach = () => client.request("session/detach", { sessionId: "S" });
    return { client, updates, open, prompt, detach };
  };
  const hosted = () => {
    const s = host.get("S");
    if (!s) throw new Error("no session S");
    return s;
  };
  /** The session's own history (private daemon-side; the `subagent-seam` shape). */
  const history = () => (hosted() as unknown as { session: Session }).session.messages;
  const link = (): ScheduleLink => {
    const l = hosted().scheduleLink();
    if (!l) throw new Error("no schedule link");
    return l;
  };
  /** Move the clock and run the session's own check, as its timer would. */
  const tick = async (ms: number) => {
    clock.now += ms;
    hosted().checkSchedules();
    await settle();
  };
  return { model, clock, timers, host, connect, hosted, history, link, tick };
}

describe("a user turn is stamped from the session's own clock and history", () => {
  test("the first prompt carries the line; `content` in the history stays clean", async () => {
    // Mutation: never pass `stamp` to `session.send` → the line is missing.
    const r = rig();
    const a = await r.connect({ timeZone: "Europe/Rome" });
    await a.open({ create: true });
    await a.prompt("t1", "che giorno è?");
    await settle();
    expect(r.model.userLines()).toEqual(["[Fri 2026-11-20 13:00 CET]\nche giorno è?"]);
    const stored = r.history().filter((m) => m.role === "user");
    expect(stored.map((m) => m.content)).toEqual(["che giorno è?"]);
  });

  test("a burst inside 30 min adds no second stamp; past it, the next turn is stamped", async () => {
    const r = rig();
    const a = await r.connect({ timeZone: "Europe/Rome" });
    await a.open({ create: true });
    await a.prompt("t1", "uno");
    await settle();
    r.clock.now += 10 * MIN;
    await a.prompt("t2", "due");
    await settle();
    r.clock.now += 25 * MIN; // 35 min after the stamp
    await a.prompt("t3", "tre");
    await settle();
    const lines = r.model.userLines();
    // Mutation: stamp on every message → all three carry a line.
    expect(lines.map((l) => l.startsWith("["))).toEqual([true, false, true]);
    expect(lines[2]?.startsWith("[Fri 2026-11-20 13:35 CET]\n")).toBe(true);
  });

  test("the zone is the CLIENT's, not the daemon host's", async () => {
    // The daemon host here is whatever the test machine is; the client declares
    // New York, so the line must read 07:00 (EST), never the host's clock.
    const r = rig();
    const a = await r.connect({ timeZone: "America/New_York" });
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    // Mutation: ignore `attachment.timeZone` → this reads the host's zone.
    expect(r.model.userLines()[0]?.startsWith("[Fri 2026-11-20 07:00 GMT-5]\n")).toBe(true);
  });

  test("a client that declares no zone falls back to the daemon host's, never an error", async () => {
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    const stamp = r.history().find((m) => m.role === "user")?.dateStamp;
    expect(stamp?.zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("a fired wake is stamped with its FIRE time; the stored job prompt never is", () => {
  test("the fire instant, and a second fire of the same job carries a NEWER time", async () => {
    const r = rig();
    const a = await r.connect({ timeZone: "Europe/Rome" });
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    await a.detach();
    await settle();
    const made = r.link().create({ prompt: "check CI", every: "10m" });
    expect(made.ok).toBe(true);
    r.clock.now += 10 * MIN; // 13:10 Rome
    await r.tick(0);
    r.clock.now += 10 * MIN; // 13:20 Rome: the next fire
    await r.tick(0);
    const fired = r.model.userLines().filter((l) => l.includes("[scheduled "));
    expect(fired).toHaveLength(2);
    // Mutation: stamp from the JOB's creation time (or its `nextAt`) → both equal.
    expect(fired[0]?.startsWith("[Fri 2026-11-20 13:10 CET]\n")).toBe(true);
    expect(fired[1]?.startsWith("[Fri 2026-11-20 13:20 CET]\n")).toBe(true);
    // The STORED job prompt is the bare text: a recurring job never replays a date.
    // Mutation: stamp `job.prompt` at fire time → this carries a `[…]`.
    expect(
      r
        .link()
        .list()
        .map((j) => j.prompt),
    ).toEqual(["check CI"]);
    // The STORED history's own copy: the `[scheduled …]` prompt, no date prefix
    // (the stamp is rendered into the model's copy only).
    const storedFired = r
      .history()
      .filter((m) => m.role === "user" && m.content.startsWith("[scheduled "));
    expect(storedFired).toHaveLength(2);
    expect(storedFired[1]?.content).toBe("[scheduled sc-1 · every 10m · fire 2] check CI");
    expect(storedFired.map((m) => m.dateStamp?.at)).toEqual([T0 + 10 * MIN, T0 + 20 * MIN]);
  });

  test("the zone is remembered, so a wake firing with nobody attached still reads the LAPTOP's clock", async () => {
    const r = rig();
    const a = await r.connect({ timeZone: "Asia/Tokyo" });
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    await a.detach();
    await settle();
    r.link().create({ prompt: "wake", every: "10m" });
    await r.tick(10 * MIN);
    const fired = r.model.userLines().filter((l) => l.includes("[scheduled "))[0] ?? "";
    // 2026-11-20T12:10Z = 21:10 in Tokyo (GMT+9).
    // Mutation: read the zone from the attachment SET (empty once detached) → host zone.
    expect(fired.startsWith("[Fri 2026-11-20 21:10 GMT+9]\n")).toBe(true);
  });
});

describe("nextDateStamp on a real session history (the daemon's decision, in one place)", () => {
  test("a resumed history with a stamp an hour old is re-stamped", () => {
    const history = [{ role: "user" as const, content: "x", dateStamp: { at: T0, zone: "UTC" } }];
    expect(nextDateStamp(history, T0 + 61 * MIN, "UTC")).toEqual({
      at: T0 + 61 * MIN,
      zone: "UTC",
    });
  });
});
