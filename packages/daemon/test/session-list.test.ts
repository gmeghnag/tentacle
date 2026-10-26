import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  MAX_SESSION_TITLE,
  type OpenResult,
  PROTOCOL_VERSION,
  type SessionListParams,
  type SessionListResult,
  SessionListResultSchema,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import type { Attachment } from "../src/hosted-session.ts";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { type SessionSummary, toSessionList } from "../src/session-list.ts";
import { type RecordStore, SessionPersister } from "../src/session-persister.ts";

// `session/list` (docs/feat/session-list.md). Each test names the mutation
// (the plan's M1..M10) that must turn it red (AGENTS §9).

const CWD = "/tmp/session-list";
const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

const summary = (
  id: string,
  lastChangeAt: number,
  over: Partial<SessionSummary> = {},
): SessionSummary => ({
  id,
  createdAt: 1,
  lastChangeAt,
  running: false,
  attached: 0,
  title: `title ${id}`,
  cwd: CWD,
  archived: false,
  ...over,
});
const list = (summaries: SessionSummary[], params: SessionListParams = {}) =>
  toSessionList(summaries, params);
const ids = (r: SessionListResult): string[] => r.sessions.map((s) => s.sessionId);

/** Every page, following the cursors. */
function pages(summaries: SessionSummary[], limit: number): SessionListResult[] {
  const out: SessionListResult[] = [];
  let cursor: string | undefined;
  do {
    const page = list(summaries, { limit, ...(cursor ? { cursor } : {}) });
    out.push(page);
    cursor = page.cursor;
  } while (cursor !== undefined && out.length < 100);
  return out;
}

describe("toSessionList (pure)", () => {
  test("L1 order: updatedAt desc, ties by sessionId asc", () => {
    // Mutation M2: sort ascending → red.
    const r = list([summary("b", 5), summary("c", 9), summary("a", 5), summary("d", 1)]);
    expect(ids(r)).toEqual(["c", "a", "b", "d"]);
    expect(r.cursor).toBeUndefined();
  });

  test("L2 updatedAt = lastChangeAt, running or not (never the clock); the rest passed through", () => {
    // The pre-Review rule (`running ? now`) is gone with the `now` parameter;
    // its host-level mutation M3' reds H1 and H8.
    const r = list([
      summary("idle", 7, { attached: 2, createdAt: 3 }),
      summary("busy", 4, { running: true }),
    ]);
    expect(r.sessions).toEqual([
      {
        sessionId: "idle",
        title: "title idle",
        cwd: CWD,
        createdAt: 3,
        updatedAt: 7,
        running: false,
        attached: 2,
        archived: false,
      },
      {
        sessionId: "busy",
        title: "title busy",
        cwd: CWD,
        createdAt: 1,
        updatedAt: 4,
        running: true,
        attached: 0,
        archived: false,
      },
    ]);
  });

  test("L3 the title is one wire line: control chars → space, cut, never empty", () => {
    // Mutation M1: drop the sanitising → red.
    const title = (t: string) => list([summary("s", 1, { title: t })]).sessions[0]?.title;
    expect(title("a\u001bb")).toBe("a b");
    expect(title("x\u001b]52;c;AAAA\u0007y")).toBe("x ]52;c;AAAA y");
    expect(title("t".repeat(MAX_SESSION_TITLE + 50))).toBe("t".repeat(MAX_SESSION_TITLE));
    expect(title("\u0000\u0007\u009b")).toBe("(empty)");
    expect(title("")).toBe("(empty)");
  });

  test("L4 paging: cursor iff more follow; the union is the full list, no duplicates", () => {
    // Mutations M2, M5 (a cursor on an exactly-full last page) → red.
    const five = [
      summary("a", 5),
      summary("b", 4),
      summary("c", 3),
      summary("d", 2),
      summary("e", 1),
    ];
    const got = pages(five, 2);
    expect(got.map(ids)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(got.map((p) => p.cursor !== undefined)).toEqual([true, true, false]);
    // Exactly `limit` left → no cursor, no empty last page.
    expect(pages(five.slice(0, 4), 2).map(ids)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(list(five, { limit: 5 }).cursor).toBeUndefined();
    expect(list([]).sessions).toEqual([]);
    expect(list([]).cursor).toBeUndefined();
    // Absent limit → MAX_SESSION_LIST (200).
    const many = Array.from({ length: 201 }, (_, i) =>
      summary(`s${String(i).padStart(3, "0")}`, 1),
    );
    const first = list(many);
    expect(first.sessions.length).toBe(200);
    expect(ids(list(many, { cursor: first.cursor ?? "" }))).toEqual(["s200"]);
  });

  test("L5 a cursor is a position: a vanished key, a moved entry, an id with ':'", () => {
    const all = [summary("a", 5), summary("b", 4), summary("c", 3), summary("d", 2)];
    const page1 = list(all, { limit: 2 });
    expect(ids(page1)).toEqual(["a", "b"]);
    const cursor = page1.cursor ?? "";
    // `b` (the cursor's key) was closed; `a` changed since page 1: neither repeats.
    const later = [summary("a", 50), summary("c", 3), summary("d", 2)];
    expect(ids(list(later, { limit: 2, cursor }))).toEqual(["c", "d"]);
    // The id part may hold ':' (split at the FIRST one).
    const colon = [summary("x:1", 5), summary("x:2", 5)];
    const p = list(colon, { limit: 1 });
    expect(ids(list(colon, { limit: 1, cursor: p.cursor ?? "" }))).toEqual(["x:2"]);
  });

  test("L8 more running sessions than `limit`: a later page skips and repeats nothing (Review finding 1)", () => {
    // Running entries page on their stored stamp like any other (the timing half,
    // page 2 asked later, is H8).
    const all = [
      summary("r1", 900, { running: true }),
      summary("r2", 900, { running: true }),
      summary("r3", 900, { running: true }),
      summary("idle", 500),
    ];
    const page1 = list(all, { limit: 2 });
    const page2 = list(all, { limit: 2, cursor: page1.cursor ?? "" });
    expect([...ids(page1), ...ids(page2)]).toEqual(["r1", "r2", "r3", "idle"]);
    expect(page2.cursor).toBeUndefined();
  });

  test("L-cwd each entry carries its OWN cwd and archived flag; live + archived page as one list", () => {
    // Mutation M6: one cwd (the host's) for every entry → red.
    const all = [
      summary("live-new", 9, { running: true, attached: 1 }),
      summary("arch-a", 7, { archived: true, cwd: "/w/other" }),
      summary("live-old", 7),
      summary("arch-b", 3, { archived: true, cwd: "/w/third" }),
      summary("arch-c", 1, { archived: true, cwd: "/w/other" }),
    ];
    const r = list(all);
    expect(r.sessions.map((s) => [s.sessionId, s.cwd, s.archived])).toEqual([
      ["live-new", CWD, false],
      ["arch-a", "/w/other", true],
      ["live-old", CWD, false],
      ["arch-b", "/w/third", true],
      ["arch-c", "/w/other", true],
    ]);
    // Keyset paging across the mix: no entry twice, none skipped.
    for (const limit of [1, 2, 3, 4]) {
      expect(pages(all, limit).flatMap(ids)).toEqual(r.sessions.map((s) => s.sessionId));
    }
  });

  test("L6 a malformed cursor → InvalidParams", () => {
    for (const cursor of ["x", "abc:s", ":s", "1:", "-1:s", "1.5:s", "1e3:s", " 1:s"]) {
      let error: unknown;
      try {
        list([summary("a", 1)], { cursor });
      } catch (e) {
        error = e;
      }
      expect(error instanceof RpcError && error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error instanceof RpcError && error.message).toBe("invalid session list cursor");
    }
  });

  test("L7 every output is schema-valid, whatever the titles and the cwd", () => {
    // Mutation M1 → red (a control character reaches the result).
    const hostile = ["", " ", "\u001b[2J", "a\nb", "\u009b31m", "t".repeat(10_000), "ok"];
    for (const cwd of [CWD, "/w\u0007x", "x".repeat(5_000), ""]) {
      const summaries = hostile.map((title, i) => summary(`s${i}`, i, { title, cwd }));
      const r = toSessionList(summaries, {});
      expect(SessionListResultSchema.safeParse(r).success).toBe(true);
      expect(r.sessions.length).toBe(hostile.length);
    }
  });
});

// --- host + wire ----------------------------------------------------------

const env = {} as ExecutionEnvironment;
const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} };
const go = [{ type: "text" as const, text: "go" }];

/** Answers text at once; while `held`, a call parks until `release()`; `fail` throws. */
class Gated implements ModelProvider {
  readonly id = "gated";
  held = false;
  fail = false;
  private waiting: Array<() => void> = [];
  get parked(): number {
    return this.waiting.length;
  }
  release(): void {
    this.held = false;
    for (const r of this.waiting.splice(0)) r();
  }
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.fail) throw new Error("provider down");
    if (this.held) await new Promise<void>((r) => this.waiting.push(r));
    yield { type: "text", delta: "SUMMARY ok" };
    yield { type: "done" };
  }
}

class NullStore implements RecordStore {
  readonly saves: Parameters<RecordStore["save"]>[0][] = [];
  async save(record: Parameters<RecordStore["save"]>[0]): Promise<void> {
    this.saves.push(record);
  }
  async remove(): Promise<void> {}
  async drain(): Promise<void> {}
  async load(): Promise<{ status: "absent" }> {
    return { status: "absent" };
  }
}

function daemon(opts: { persist?: boolean } = {}) {
  const clock = { t: 0 };
  const model = new Gated();
  const store = new NullStore();
  const host = new SessionHost({
    defaultCwd: CWD,
    now: () => clock.t,
    ...(opts.persist
      ? {
          persister: new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} }),
        }
      : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
  const connect = async (initialize = true) => {
    const [d, c] = createChannelPair();
    const connection = new Connection(d, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
    });
    if (initialize) await client.request("initialize", INIT);
    const list = (params: SessionListParams = {}) =>
      client.request("session/list", params) as Promise<SessionListResult>;
    const open = (sessionId: string) =>
      client.request("session/open", { sessionId, create: true }) as Promise<OpenResult>;
    return { connection, client, updates, list, open };
  };
  return { host, model, clock, store, connect };
}

/** Runs one turn on `id` to its end at the current clock. */
async function turn(d: ReturnType<typeof daemon>, id: string, turnId: string): Promise<void> {
  const hosted = d.host.get(id);
  if (!hosted) throw new Error(`no session ${id}`);
  hosted.prompt(turnId, go);
  await idle(d, id);
}

async function idle(d: ReturnType<typeof daemon>, id: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (d.host.get(id)?.running) {
    if (Date.now() > deadline) throw new Error("turn did not end");
    await tick();
  }
}

const detached: Attachment = { send: () => {} };

describe("SessionHost.list over the wire", () => {
  test("H1 running / attached / title / cwd, and a list attaches nothing", async () => {
    // Mutations M3' (running → now) and M11 (no stamp at the turn's start) → red:
    // a running session is keyed on its turn's start (25), not the clock (30)
    // nor its creation (20).
    const d = daemon();
    const a = await d.connect();
    d.clock.t = 10;
    d.host.open({ sessionId: "idle", create: true }, detached);
    await turn(d, "idle", "T1");
    d.host.get("idle")?.detach(detached);
    d.clock.t = 20;
    await a.open("busy");
    d.model.held = true;
    d.clock.t = 25;
    d.host.get("busy")?.prompt("T2", go);
    d.clock.t = 30;
    const listed = await a.list();
    expect(listed.sessions).toEqual([
      {
        sessionId: "busy",
        title: "go",
        cwd: CWD,
        createdAt: 20,
        updatedAt: 25,
        running: true,
        attached: 1,
        archived: false,
      },
      {
        sessionId: "idle",
        title: "go",
        cwd: CWD,
        createdAt: 10,
        updatedAt: 10,
        running: false,
        attached: 0,
        archived: false,
      },
    ]);
    // The lister attached to nothing.
    expect(d.host.get("idle")?.attachedCount).toBe(0);
    expect(d.host.get("busy")?.attachedCount).toBe(1);
    d.model.release();
    await idle(d, "busy");
  });

  test("H2 listing does not move the TTL clock: an idle detached session is still reaped", async () => {
    // Mutation M4 (list attaches, or bumps lastActiveAt) → red.
    const d = daemon();
    d.host.open({ sessionId: "s", create: true }, detached);
    d.host.get("s")?.detach(detached);
    const c = await d.connect();
    d.clock.t = 9_000;
    expect((await c.list()).sessions.map((s) => s.attached)).toEqual([0]);
    expect(d.host.reapExpired({ idleTtlMs: 9_500 })).toEqual([]);
    d.clock.t = 10_001;
    expect(d.host.reapExpired({ idleTtlMs: 9_500 }).map((e) => e.id)).toEqual(["s"]);
    expect((await c.list()).sessions).toEqual([]);
  });

  test("H3 a closed session is listed ARCHIVED (persisting host); a restored record lists its own stamps", async () => {
    // Mutation M9 (restore ignores record.updatedAt) → red. (Before session-archive: "not listed".)
    const d = daemon({ persist: true });
    d.clock.t = 100;
    d.host.open({ sessionId: "gone", create: true }, detached);
    d.host.close("gone");
    const record: DaemonSessionRecord = {
      id: "back",
      cwd: CWD,
      model: "m",
      createdAt: 3,
      updatedAt: 7,
      title: "t",
      messages: [{ role: "user", content: "an old question" }],
      kind: "tentacle.daemon-session",
      schemaVersion: 7,
      lastActiveAt: 9,
      turns: [],
      enqueueIds: [],
      returned: [],
    };
    d.host.restore(record);
    const c = await d.connect();
    expect((await c.list()).sessions).toEqual([
      {
        sessionId: "gone",
        title: "(empty)",
        cwd: CWD,
        createdAt: 100,
        updatedAt: 100,
        running: false,
        attached: 0,
        archived: true,
      },
      {
        sessionId: "back",
        title: "an old question",
        cwd: CWD,
        createdAt: 3,
        updatedAt: 7,
        running: false,
        attached: 0,
        archived: false,
      },
    ]);
  });

  test("H4 before initialize → NotInitialized", async () => {
    const d = daemon();
    const c = await d.connect(false);
    let code: unknown;
    try {
      await c.list();
    } catch (e) {
      code = e instanceof RpcError ? e.code : e;
    }
    expect(code).toBe(DomainErrorCode.NotInitialized);
  });

  test("H5 opening, viewing and closing a session reorders nothing; the TTL clock does move", async () => {
    // Mutations M6 (summary reads lastActiveAt), M7 (detach stamps lastChangeAt) → red.
    const d = daemon();
    d.host.open({ sessionId: "A", create: true }, detached);
    d.host.open({ sessionId: "B", create: true }, detached);
    d.clock.t = 10;
    await turn(d, "A", "TA");
    d.clock.t = 20;
    await turn(d, "B", "TB");
    const lister = await d.connect();
    const order = async () => (await lister.list()).sessions.map((s) => [s.sessionId, s.updatedAt]);
    expect(await order()).toEqual([
      ["B", 20],
      ["A", 10],
    ]);
    d.clock.t = 30;
    const second = await d.connect();
    await second.open("A");
    second.connection.close();
    const third = await d.connect();
    await third.open("A");
    await third.client.request("session/snapshot", { sessionId: "A" });
    third.connection.close();
    await tick();
    expect(await order()).toEqual([
      ["B", 20],
      ["A", 10],
    ]);
    expect(d.host.get("A")?.liveness().lastActiveAt).toBe(30);
  });

  test("H6 a turn end and a compaction end re-stamp (and reorder)", async () => {
    // Mutation M10 (no stamp at the compaction's end) → red.
    const d = daemon();
    d.host.open({ sessionId: "A", create: true }, detached);
    d.host.open({ sessionId: "B", create: true }, detached);
    d.clock.t = 10;
    await turn(d, "A", "TA");
    d.clock.t = 20;
    await turn(d, "B", "TB");
    const c = await d.connect();
    const order = async () => (await c.list()).sessions.map((s) => [s.sessionId, s.updatedAt]);
    d.clock.t = 40;
    await turn(d, "A", "TA2");
    expect(await order()).toEqual([
      ["A", 40],
      ["B", 20],
    ]);
    d.clock.t = 50;
    await d.host.get("B")?.compact();
    expect(await order()).toEqual([
      ["B", 50],
      ["A", 40],
    ]);
  });

  test("H7 a failed or cancelled compaction leaves the history, so it re-stamps nothing", async () => {
    // Mutation: stamp lastChangeAt in the compaction's `finally` again → red.
    const d = daemon();
    d.host.open({ sessionId: "A", create: true }, detached);
    d.host.open({ sessionId: "B", create: true }, detached);
    d.clock.t = 10;
    await turn(d, "A", "TA");
    d.clock.t = 20;
    await turn(d, "B", "TB");
    const c = await d.connect();
    const order = async () => (await c.list()).sessions.map((s) => [s.sessionId, s.updatedAt]);
    const before = [
      ["B", 20],
      ["A", 10],
    ];
    const hosted = d.host.get("A");
    if (!hosted) throw new Error("no session A");
    // Failed: the provider throws.
    d.clock.t = 30;
    d.model.fail = true;
    await expect(hosted.compact()).rejects.toThrow();
    d.model.fail = false;
    expect(await order()).toEqual(before);
    // Cancelled: parked in the model, then `session/cancel`.
    d.clock.t = 40;
    d.model.held = true;
    const compacting = hosted.compact();
    const deadline = Date.now() + 2000;
    while (d.model.parked === 0) {
      if (Date.now() > deadline) throw new Error("compaction never reached the model");
      await tick();
    }
    hosted.cancel();
    // This model ignores the signal: let it finish; the slot is already aborted.
    d.model.release();
    const error = await compacting.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RpcError && error.code).toBe(DomainErrorCode.Cancelled);
    expect(hosted.running).toBe(false);
    expect(await order()).toEqual(before);
    // The TTL clock did move (the two stamps are distinct).
    expect(hosted.liveness().lastActiveAt).toBe(40);
  });

  test("H9 a prompt refused (session busy, unknown skill) stamps nothing (Re-review R1)", async () => {
    // Mutation: the turn-start stamp moved above `assertIdle` → red.
    const d = daemon();
    d.host.open({ sessionId: "B", create: true }, detached);
    d.clock.t = 5;
    await turn(d, "B", "TB");
    d.host.open({ sessionId: "A", create: true }, detached);
    d.model.held = true;
    d.clock.t = 10;
    const a = d.host.get("A");
    const b = d.host.get("B");
    if (!a || !b) throw new Error("no sessions");
    a.prompt("T1", go);
    const c = await d.connect();
    const order = async () => (await c.list()).sessions.map((s) => [s.sessionId, s.updatedAt]);
    const before = [
      ["A", 10],
      ["B", 5],
    ];
    expect(await order()).toEqual(before);
    d.clock.t = 20;
    expect(() => a.prompt("T2", go)).toThrow();
    expect(() => b.prompt("T3", go, "no-such-skill")).toThrow();
    expect(await order()).toEqual(before);
    d.model.release();
    await idle(d, "A");
  });

  test("H8 three running sessions + one idle, limit 2: page 2 asked later lists the rest exactly once", async () => {
    // Review finding 1. Mutation M3' (running keyed on `now`) → red: r3 is skipped.
    const d = daemon();
    d.clock.t = 10;
    d.host.open({ sessionId: "idle", create: true }, detached);
    await turn(d, "idle", "T0");
    d.model.held = true;
    d.clock.t = 20;
    for (const id of ["r1", "r2", "r3"]) {
      d.host.open({ sessionId: id, create: true }, detached);
      d.host.get(id)?.prompt(`T-${id}`, go);
    }
    const c = await d.connect();
    d.clock.t = 1_000;
    const page1 = await c.list({ limit: 2 });
    d.clock.t = 1_001;
    const page2 = await c.list({ limit: 2, ...(page1.cursor ? { cursor: page1.cursor } : {}) });
    const listed = [...page1.sessions, ...page2.sessions].map((s) => s.sessionId);
    expect(listed).toEqual(["r1", "r2", "r3", "idle"]);
    expect(page2.cursor).toBeUndefined();
    d.model.release();
    for (const id of ["r1", "r2", "r3"]) await idle(d, id);
  });
});
