/**
 * docs/feat/cron-tool.md slice S2 — the CLIENT half of scheduled wakes.
 *
 * Two rules, both pinned here:
 * 1. **The trust bit gates the feed.** A `schedules` frame is read only by a
 *    client that knows its daemon starts turns on its own (`daemonWakes`: a
 *    `serve` `connect`, the worker; NEVER a pod, AGENTS §7). A pod's list would
 *    otherwise be a pod-supplied claim about the laptop's wake-ups.
 * 2. **The client is the gate for the LABELS.** `spec`/`prompt` come from the
 *    model, land in a terminal, and are cut here — one line, control characters
 *    gone, bounded — never in a component and never (only) in the daemon.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import {
  JsonRpcErrorCode,
  Method,
  Notification,
  PROTOCOL_VERSION,
  type ScheduleRow,
} from "@tentacle/protocol";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { type SessionEvent, updateToEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import {
  MAX_SCHEDULE_ROWS,
  SCHEDULE_LABEL_CLIENT_MAX,
  SCHEDULE_OLD_DAEMON,
  boundSchedules,
  firedScheduleRef,
  schedulesFromSnapshot,
} from "../src/schedules.ts";
import { until } from "./support/fakes.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

const row = (i: number, extra: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: `sc-${i}`,
  kind: "every",
  spec: `every ${i}m`,
  prompt: `check ${i}`,
  nextAt: 1_000 + i,
  fires: i,
  createdAt: 1,
  ...extra,
});

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Drain a turn's stream into `into`, ignoring when it closes. */
const drainInto = async (
  events: AsyncIterable<SessionEvent>,
  into: SessionEvent[],
): Promise<void> => {
  try {
    for await (const e of events) into.push(e);
  } catch {}
};

describe("boundSchedules: the rows are the client's (≤ 32, one line, bounded)", () => {
  test("at most MAX_SCHEDULE_ROWS, in the daemon's order", () => {
    const many = Array.from({ length: 60 }, (_, i) => row(i + 1));
    const bounded = boundSchedules(many);
    expect(bounded).toHaveLength(MAX_SCHEDULE_ROWS);
    expect(bounded[0]?.id).toBe("sc-1");
    // A hostile list costs a slice, not 10 000 mappings.
    expect(boundSchedules(Array.from({ length: 10_000 }, (_, i) => row(i + 1)))).toHaveLength(
      MAX_SCHEDULE_ROWS,
    );
  });

  test("every label is one line, escape-free, cut with an ellipsis; the numbers as sent", () => {
    const [clean] = boundSchedules([
      row(1, {
        id: "sc-1\n",
        kind: "every\n",
        spec: `every\n10m\u001b[31m\u009b2J${"z".repeat(400)}`,
        prompt: `p\u202e${"q".repeat(400)}`,
      }),
    ]);
    expect(clean?.id).toBe("sc-1");
    expect(clean?.kind).toBe("every");
    for (const label of [clean?.spec ?? "", clean?.prompt ?? ""]) {
      expect(CONTROL.test(label)).toBe(false);
      expect(FORMAT.test(label)).toBe(false);
      expect(label.length).toBeLessThanOrEqual(SCHEDULE_LABEL_CLIENT_MAX);
    }
    expect(clean?.spec.endsWith("…")).toBe(true);
    expect(clean?.nextAt).toBe(1_001);
    expect(clean?.fires).toBe(1);
  });

  test("a snapshot's list goes through the same bounding; absent stays absent", () => {
    expect(schedulesFromSnapshot(Array.from({ length: 60 }, (_, i) => row(i + 1)))).toHaveLength(
      MAX_SCHEDULE_ROWS,
    );
    expect(schedulesFromSnapshot(undefined)).toBeUndefined();
    expect(schedulesFromSnapshot([])).toEqual([]);
  });
});

describe("firedScheduleRef: the ONE gate both doors of `turn_start.schedule` share", () => {
  test("an untrusted daemon's claim spreads nothing at all", () => {
    const ref = { id: "sc-1", spec: "every 10m" };
    expect(firedScheduleRef(ref, false)).toEqual({});
    // Not even a partial ref: a `{spec}` alone would still paint the row.
    expect(firedScheduleRef(ref, false).schedule).toBeUndefined();
  });

  test("a trusted daemon's claim is sanitized (id bounded like the protocol's, spec like a row)", () => {
    const hostile = {
      id: "sc-\u001b[2J1",
      spec: `every\u0007 10m\u202e${"z".repeat(400)}`,
    };
    const { schedule } = firedScheduleRef(hostile, true);
    if (schedule === undefined) throw new Error("no ref");
    expect(CONTROL.test(schedule.id)).toBe(false);
    expect(CONTROL.test(schedule.spec)).toBe(false);
    expect(FORMAT.test(schedule.spec)).toBe(false);
    expect(schedule.id.length).toBeLessThanOrEqual(64);
    expect(schedule.spec.length).toBeLessThanOrEqual(SCHEDULE_LABEL_CLIENT_MAX);
    expect(schedule.spec.endsWith("…")).toBe(true);
  });

  test("no claim, or an older daemon's absent one: nothing to spread", () => {
    expect(firedScheduleRef(undefined, true)).toEqual({});
    expect(firedScheduleRef(undefined, false)).toEqual({});
  });
});

/** A fake daemon: answers the handshake and `session/open`, and nothing else unless told. */
function fakeDaemon(
  handlers: Record<string, (params: unknown) => unknown> = {},
  snapshot: (params: unknown) => unknown = () => ({ messages: [] }),
  resync = false,
) {
  const [daemonCh, clientCh] = createChannelPair();
  const sent: { method: string; params: unknown }[] = [];
  let seq = 0;
  const peer = new RpcPeer(daemonCh, {
    onRequest: async (method: string, params: unknown) => {
      sent.push({ method, params });
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      if (method === Method.Open) {
        return {
          sessionId: "s1",
          epoch: "e",
          created: !resync,
          resync,
          ...(resync ? { since: { epoch: "e", seq: 0 } } : {}),
        };
      }
      if (method === Method.Snapshot) {
        const snap = snapshot(params) as Record<string, unknown>;
        return resync ? { since: { epoch: "e", seq: 0 }, ...snap } : snap;
      }
      const handler = handlers[method];
      if (handler) {
        return handler(params);
      }
      // An older daemon knows nothing else.
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
    },
  });
  const notify = (update: unknown): void => {
    peer.notify(Notification.SessionUpdate, { sessionId: "s1", seq: ++seq, update });
  };
  return { peer, sent, notify, clientCh };
}

async function attach(d: ReturnType<typeof fakeDaemon>, opts: { daemonWakes?: boolean } = {}) {
  const client = new RemoteClient(d.clientCh, new PermissionBroker(), undefined, {
    channelFactory: async () => {
      throw new Error("unused");
    },
    random: () => 0,
    ...(opts.daemonWakes === undefined ? {} : { daemonWakes: opts.daemonWakes }),
  });
  await client.initialize();
  // Attached and LIVE: an unopened session drops every frame by design.
  const session = client.newSession(undefined, "s1", undefined, { attach: {} });
  await session.open();
  return { client, session };
}

describe("the trust bit gates the feed (AGENTS §7)", () => {
  test("with daemonWakes ON the list arrives and can be deleted from", async () => {
    const d = fakeDaemon({
      [Method.ScheduleDelete]: (params) => ({
        deleted: (params as { scheduleId: string }).scheduleId === "sc-1",
      }),
    });
    const { client, session } = await attach(d, { daemonWakes: true });
    const reports: { rows: number; count: number }[] = [];
    session.onSchedules((r) => reports.push({ rows: r.rows.length, count: r.count }));

    d.notify({ type: "schedules", schedules: [row(1), row(2)] });
    await tick();

    expect(session.schedules?.map((r) => r.id)).toEqual(["sc-1", "sc-2"]);
    expect(reports.at(-1)).toEqual({ rows: 2, count: 2 });
    expect(await session.deleteSchedule("sc-1")).toEqual({ deleted: true });
    expect(d.sent.at(-1)).toEqual({
      method: Method.ScheduleDelete,
      params: { sessionId: "s1", scheduleId: "sc-1" },
    });
    // An id the daemon does not hold: a refusal result, never a throw.
    expect(await session.deleteSchedule("sc-9")).toEqual({ deleted: false });
    client.close();
  });

  test("with the bit OFF (a pod, run/attach) the frame is DROPPED: no rows, no listener", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d);
    let notices = 0;
    session.onSchedules(() => {
      notices += 1;
    });
    d.notify({ type: "schedules", schedules: [row(1)] });
    await tick();
    expect(session.schedules).toBeUndefined();
    expect(notices).toBe(0);
    // A pod can neither state nor delete one on the laptop's behalf.
    expect(await session.deleteSchedule("sc-1")).toEqual({
      deleted: false,
      reason: "this client does not trust its daemon to schedule wakes",
    });
    expect(d.sent.some((s) => s.method === Method.ScheduleDelete)).toBe(false);
    client.close();
  });

  test("a snapshot's list is adopted only with the bit ON", async () => {
    const snap = (): unknown => ({ messages: [], schedules: [row(1, { nextAt: 2 })] });
    const on = fakeDaemon({}, snap, true);
    const a = await attach(on, { daemonWakes: true });
    await tick(40);
    expect(a.session.schedules?.map((r) => r.id)).toEqual(["sc-1"]);
    a.client.close();

    const off = fakeDaemon({}, snap, true);
    const b = await attach(off);
    await tick(40);
    expect(b.session.schedules).toBeUndefined();
    b.client.close();
  });
});

describe("the reverse mapping: `schedules` is a listener's fact, not a turn event", () => {
  test("updateToEvent returns null for it (and for a fired turn's styled ref)", () => {
    // The table is `RemoteClient`'s (the same rule `jobs`/`subagents` follow):
    // pushing it into a turn's event stream would tie an idle-time change to a
    // turn that has nothing to do with it.
    expect(updateToEvent({ type: "schedules", schedules: [] }, new Map())).toBeNull();
    // And a `turn_start` is consumed by `RemoteSession` (the bracket), not mapped.
    expect(
      updateToEvent(
        {
          type: "turn_start",
          turnId: "wake-1",
          prompt: "p",
          schedule: { id: "sc-1", spec: "every 10m" },
        },
        new Map(),
      ),
    ).toBeNull();
  });
});

describe("a fired wake's `turn_start.schedule` reaches the fired row (S2 review 1)", () => {
  /** The durable prefix S3 writes into a fired wake's prompt (M4 option A). */
  const WAKE = "[scheduled sc-1 · every 10m] check the build";

  /** The fired turn as the daemon sends it: a `turn_start` carrying `schedule`. */
  const fired = (schedule: unknown): unknown => ({
    type: "turn_start",
    turnId: "wake-1",
    prompt: WAKE,
    ...(schedule === undefined ? {} : { schedule }),
  });

  test("the client's user_message carries {id, spec} (the bit ON: a serve daemon)", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    const events: SessionEvent[] = [];
    session.watch((a) => {
      if (a.kind === "turn") void drainInto(a.events, events);
    });
    d.notify(fired({ id: "sc-1", spec: "every 10m" }));
    await until(() => events.some((e) => e.type === "user_message"));
    expect(events[0]).toEqual({
      type: "user_message",
      text: WAKE,
      schedule: { id: "sc-1", spec: "every 10m" },
    });
    client.close();
  });

  test("with the bit OFF (a pod) the claim is DROPPED: the prompt alone", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d);
    const events: SessionEvent[] = [];
    session.watch((a) => {
      if (a.kind === "turn") void drainInto(a.events, events);
    });
    d.notify(fired({ id: "sc-1", spec: "every 10m" }));
    await until(() => events.some((e) => e.type === "user_message"));
    // A pod cannot dress its turn up as the laptop's own scheduled wake.
    expect(events[0]).toEqual({ type: "user_message", text: WAKE });
    client.close();
  });

  test("an own turn re-delivered after a reset carries it too (the second door)", async () => {
    // The OTHER door Review 1 named (`:1872`): a turn this session owns, cut
    // mid-turn. Its `turn_start` is replayed after the reset through `onUpdate`,
    // so the same ref must survive there — reached through the public `output`
    // seam, as the attach/send-now suites do.
    const d = fakeDaemon({ [Method.Prompt]: () => new Promise(() => {}) });
    const { client, session } = await attach(d, { daemonWakes: true });
    const events: SessionEvent[] = [];
    const turnId = "t-own";
    const run = drainInto(session.send("go", undefined, { turnId }), events);
    void run;
    await tick(20);
    session.output({
      kind: "update",
      seq: 1,
      update: { type: "history_replaced", reason: "clear" },
      turn: null,
    });
    session.output({ kind: "reset", messages: [], turn: turnId, keepRequests: [] });
    session.output({
      kind: "update",
      seq: 2,
      update: {
        type: "turn_start",
        turnId,
        prompt: WAKE,
        schedule: { id: "sc-1", spec: "every 10m" },
      },
      turn: turnId,
    });
    await until(() => events.some((e) => e.type === "user_message"));
    const again = events.find((e) => e.type === "user_message");
    expect(again).toEqual({
      type: "user_message",
      text: WAKE,
      schedule: { id: "sc-1", spec: "every 10m" },
    });
    client.close();
  });

  test("a hostile `spec` is sanitized before it can reach a terminal", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    const events: SessionEvent[] = [];
    session.watch((a) => {
      if (a.kind === "turn") void drainInto(a.events, events);
    });
    d.notify(fired({ id: "sc-1", spec: `every\u001b[2J\n10m\u202e${"z".repeat(400)}` }));
    await until(() => events.some((e) => e.type === "user_message"));
    const first = events[0];
    if (first?.type !== "user_message" || first.schedule === undefined) {
      throw new Error("no schedule ref");
    }
    expect(CONTROL.test(first.schedule.spec)).toBe(false);
    expect(FORMAT.test(first.schedule.spec)).toBe(false);
    expect(first.schedule.spec.length).toBeLessThanOrEqual(SCHEDULE_LABEL_CLIENT_MAX);
    client.close();
  });
});

describe("an older daemon: a typed refusal, never a throw", () => {
  test("MethodNotFound ⇒ {deleted:false, reason}", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.deleteSchedule("sc-1")).toEqual({
      deleted: false,
      reason: SCHEDULE_OLD_DAEMON,
    });
    client.close();
  });
});

describe("a hostile daemon's `schedules` frame is bounded like any other", () => {
  test("300 rows with control chars: 32 rows, one line each, the count unbounded", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    const reports: { rows: number; count: number }[] = [];
    session.onSchedules((r) => reports.push({ rows: r.rows.length, count: r.count }));
    const hostile = Array.from({ length: 300 }, (_, i) => ({
      id: `sc-${i + 1}`,
      kind: "every",
      spec: `e\u001b[2J\n${"z".repeat(400)}`,
      prompt: `p\u202e${"q".repeat(400)}`,
      nextAt: i,
      fires: 0,
      createdAt: 0,
    }));
    d.notify({ type: "schedules", schedules: hostile });
    await tick();

    expect(reports.at(-1)).toEqual({ rows: MAX_SCHEDULE_ROWS, count: 300 });
    for (const r of session.schedules ?? []) {
      expect(CONTROL.test(r.spec)).toBe(false);
      expect(FORMAT.test(r.prompt)).toBe(false);
      expect(r.spec.length).toBeLessThanOrEqual(SCHEDULE_LABEL_CLIENT_MAX);
    }
    client.close();
  });
});
