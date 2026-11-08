import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, projectKey } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import { Connection, type HostedSession, SessionHost } from "@tentacle/daemon";
import { type LogCursor, LogCursorSchema } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { openTuiSessions, readSessionRecord } from "../src/tui-sessions.ts";

// docs/feat/session-log-laptop-store.md, W1 — the load-bearing assumption, run
// FIRST: the laptop's `<uid>.jsonl` mirrors the daemon's log from `readBack`
// alone. A real daemon (`SessionHost` + `Connection`), the laptop's runtime and
// the saver `openTuiSessions` builds. After every turn the file's last segment
// equals the daemon's (entry for entry, so its fold too); at quiescent points
// inside a turn it is a PREFIX of the daemon's entries (a round's save is in).
// The fold here is the test's own (an independent oracle, not the store's).

type Entry = Record<string, unknown> & { type: string; seq: number; id: string };

const env = {} as ExecutionEnvironment;
/** Any arguments (the scripted calls send `{}`). */
const ANY_ARGS = LogCursorSchema.partial().passthrough();
const FRESH: readonly ChatMessage[] = [
  { role: "system", content: "FRESH SYSTEM" },
  { role: "user", content: "RESTART PROMPT" },
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-session-log-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A scripted model: one list of events per request; `"fail"` throws (a failed turn). */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[] | "fail")[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const step = this.script[this.turn++] ?? [{ type: "text", delta: "end" }];
    if (step === "fail") {
      throw new Error("the model failed");
    }
    for (const event of step) {
      yield event;
    }
    yield { type: "done" };
  }
}

/** At the reset probe's commit: replace the history in place + `context_reset` (context-reset.test.ts). */
class ResettingAgent extends Agent {
  override async *runMessages(
    ...args: Parameters<Agent["runMessages"]>
  ): AsyncGenerator<AgentEvent> {
    const messages = args[0];
    let probed = false;
    for await (const event of super.runMessages(...args)) {
      if (event.type === "tool_result" && event.name === "reset_probe") {
        probed = true;
      }
      if (probed && event.type === "history_commit") {
        probed = false;
        messages.length = 0;
        messages.push(...FRESH.map((m) => ({ ...m })));
        yield { type: "context_reset", messages: [...messages] };
        continue;
      }
      yield event;
    }
  }
}

const call = (id: string, name: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: "{}" },
});

/** JSON with sorted keys: the client re-serializes in its schema's key order (F4). */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/** The last segment (from the last `base`) of `entries`. */
function lastSegment(entries: readonly Entry[]): Entry[] {
  let start = -1;
  entries.forEach((e, i) => {
    if (e.type === "base") start = i;
  });
  return start < 0 ? [] : entries.slice(start);
}

/** The test's own fold of one segment. */
function fold(segment: readonly Entry[]): unknown[] {
  let out: unknown[] = [];
  for (const e of segment) {
    if (e.type === "base") out = [];
    else if (e.type === "message") out.push(e.message);
    else if (e.type === "replace") out[e.index as number] = e.message;
    else if (e.type === "truncate") out.length = e.length as number;
  }
  return out;
}

/** The daemon's current segment (a cold read from its last base), as plain JSON. */
function daemonSegment(hosted: HostedSession): Entry[] {
  const all: Entry[] = [];
  let after: LogCursor | undefined;
  for (;;) {
    const page = hosted.logRead(after);
    all.push(...(page.entries as Entry[]));
    const last = page.entries.at(-1);
    if (!page.more || last === undefined) break;
    after = { seq: last.seq, id: last.id };
  }
  return JSON.parse(JSON.stringify(lastSegment(all))) as Entry[];
}

/** The file's entries (line 1 is the header), or null when there is no file. */
async function fileEntries(path: string): Promise<{ header: unknown; entries: Entry[] } | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((l) => l !== "");
  const [first, ...rest] = lines;
  return {
    header: first === undefined ? undefined : JSON.parse(first),
    entries: rest.map((l) => JSON.parse(l) as Entry),
  };
}

async function setup() {
  const cwd = join(dir, "work");
  const root = join(dir, "sessions");
  const sessions = await openTuiSessions({ root, cwd }, { wanted: false }, () => {});
  if ("exit" in sessions) throw new Error("no sessions");
  const notices: string[] = [];
  sessions.notices.onNotice((text) => notices.push(text));
  const hooks: { check: () => Promise<void> } = { check: async () => {} };
  let lockedPath: string | null = null;
  const tools: Tool[] = [
    {
      name: "check",
      description: "a mid-turn check",
      inputSchema: ANY_ARGS,
      permission: "none",
      execute: async () => {
        await hooks.check();
        return { content: "checked" };
      },
    },
    {
      name: "reset_probe",
      description: "the reset",
      inputSchema: ANY_ARGS,
      permission: "none",
      execute: async () => ({ content: "reset done" }),
    },
    {
      name: "plain",
      description: "plain",
      inputSchema: ANY_ARGS,
      permission: "none",
      execute: async () => ({ content: "ok ".repeat(40) }),
    },
  ];
  const model = new Scripted([
    // turn 1: a multi-round turn with a parallel group
    [call("a1", "plain"), call("a2", "plain")],
    [call("a3", "check")],
    [{ type: "text", delta: "turn one done" }],
    // turn 2: a round, then the write fails (the file is read-only), then heals
    [call("b1", "check")],
    [call("b2", "plain")],
    [{ type: "text", delta: "turn two done" }],
    // turn 3: a failed turn after a round
    [call("c1", "plain")],
    "fail",
    // compaction: the summary
    [{ type: "text", delta: "SUMMARY of the conversation" }],
    // turn 4: a context reset mid-turn, then more rounds on the fresh history
    [call("d1", "reset_probe")],
    [call("d2", "check")],
    [{ type: "text", delta: "after the reset" }],
  ]);
  const host = new SessionHost({
    defaultCwd: cwd,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const registry = new ToolRegistry();
      for (const tool of tools) registry.register(tool);
      const agent = new ResettingAgent({
        model,
        tools: registry,
        env,
        requestPermission: (req, options) => permissions.request(req, options),
        contextAwareness: { window: 2000, stepPercent: 1 },
      });
      return { agent, permissions };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver: sessions.saver,
    cwd,
    model: "scripted",
    resume: null,
  });
  const controller = runtime.createSession();
  const file = (): string => join(root, projectKey(cwd), `${controller.sessionId}.jsonl`);
  const hosted = (): HostedSession => {
    const h = host.get(controller.sessionId ?? "");
    if (!h) throw new Error("no hosted session");
    return h;
  };
  return {
    sessions,
    root,
    cwd,
    notices,
    hooks,
    runtime,
    controller,
    file,
    hosted,
    lock: async () => {
      lockedPath = file();
      await chmod(lockedPath, 0o400).catch(() => {}); // absent: nothing to lock
    },
    unlock: async () => {
      if (lockedPath) await chmod(lockedPath, 0o600).catch(() => {});
      lockedPath = null;
    },
  };
}

const drainTurn = async (events: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of events) {
    // run the turn to its end
  }
};

describe("W1 — the laptop file mirrors the daemon's log", () => {
  test("after every turn the file's segment equals the daemon's; mid-turn it is a prefix", async () => {
    const s = await setup();
    const mismatches: string[] = [];
    let prefixLength = 0;
    const midTurn = async (label: string): Promise<void> => {
      // Let the round's save land (it was triggered by the last tool_result).
      await new Promise((r) => setTimeout(r, 30));
      await s.sessions.saver.drain({ timeoutMs: 2000 });
      const daemon = daemonSegment(s.hosted());
      const disk = await fileEntries(s.file());
      const mine = disk ? lastSegment(disk.entries) : null;
      if (mine === null || mine.length === 0) {
        mismatches.push(`${label}: no file`);
        return;
      }
      const prefix = daemon.slice(0, mine.length);
      if (stable(prefix) !== stable(mine)) {
        mismatches.push(`${label}: the file is not a prefix of the daemon's segment`);
      }
      prefixLength = mine.length;
    };
    const atTurnEnd = async (label: string): Promise<void> => {
      await s.runtime.flushed?.();
      await s.sessions.saver.drain({ timeoutMs: 2000 });
      const daemon = daemonSegment(s.hosted());
      const disk = await fileEntries(s.file());
      if (disk === null) {
        mismatches.push(`${label}: no file`);
        return;
      }
      const mine = lastSegment(disk.entries);
      if (stable(mine) !== stable(daemon)) {
        mismatches.push(
          `${label}: file segment (${mine.length}) != daemon segment (${daemon.length})`,
        );
      }
      if (stable(fold(mine)) !== stable(fold(daemon))) {
        mismatches.push(`${label}: the folds differ`);
      }
      for (const e of mine) seenTypes.add(e.type);
      // The store's own load (its fold; no turn is open at a turn end).
      const loaded = await readSessionRecord(
        { root: s.root, cwd: s.cwd },
        s.controller.sessionId ?? "",
      );
      if (stable(loaded?.messages ?? null) !== stable(fold(daemon))) {
        mismatches.push(`${label}: the store's load is not the daemon's projection`);
      }
    };
    const seenTypes = new Set<string>();

    // Turn 1: multi-round with a parallel group.
    s.hooks.check = () => midTurn("turn 1 round 2");
    await drainTurn(s.controller.send("first prompt"));
    await atTurnEnd("turn 1");

    // Turn 2: the file is read-only for one save (a failed write), then writable again.
    s.hooks.check = async () => {
      await midTurn("turn 2 round 1");
      await s.lock();
      s.hooks.check = async () => {};
    };
    const turn2 = drainTurn(s.controller.send("second prompt"));
    await turn2;
    await s.runtime.flushed?.();
    await s.sessions.saver.drain({ timeoutMs: 2000 });
    await s.unlock();
    // The next save heals the file (a REPLACE from the writer's segment).
    const failed = await drainTurn(s.controller.send("third prompt (fails)")).then(
      () => false,
      () => true,
    );
    expect(failed).toBe(true);
    await atTurnEnd("turn 3 (failed, after the failed write)");

    // A compaction (a new segment).
    await s.controller.compact?.();
    await atTurnEnd("compaction");

    // Turn 4: a context reset mid-turn.
    s.hooks.check = () => midTurn("turn 4 after the reset");
    await drainTurn(s.controller.send("fourth prompt"));
    await atTurnEnd("turn 4");

    expect(mismatches).toEqual([]);
    expect(prefixLength).toBeGreaterThan(0);
    // The scenario really had in-place edits (contextUsage, the failed turn's close)…
    expect(seenTypes.has("replace")).toBe(true);
    // …and a failed write, reported, then healed by a later save.
    expect(s.notices.some((n) => n.includes("not saved"))).toBe(true);
    expect(s.notices.some((n) => n.includes("saved again"))).toBe(true);
    // The header names the session.
    const disk = await fileEntries(s.file());
    expect((disk?.header as { id?: string } | undefined)?.id).toBe(s.controller.sessionId ?? "");
    // One segment on disk (keepSuperseded off by default).
    expect(disk?.entries.filter((e) => e.type === "base").length).toBe(1);
    await s.runtime.dispose();
  });
});

describe("the boundary and the session's file", () => {
  test("W15 F4: an entry's unknown field and an unknown (non-critical) entry from the daemon never reach the file", async () => {
    // A pod is not trusted: the store writes only the client's validated,
    // re-serialized known entries. Mutation: write the raw page entries → both land.
    const s = await setup();
    await drainTurn(s.controller.send("first prompt"));
    const hosted = s.hosted();
    const real = hosted.logRead.bind(hosted);
    hosted.logRead = (after, max) => {
      const page = real(after, max);
      const entries = page.entries.map((e) => ({ ...e, planted: "pod-supplied" }));
      if (page.more) return { ...page, entries };
      const tip = { seq: page.tip.seq + 1, id: `${page.tip.id}-future` };
      const future = {
        type: "future_type",
        seq: tip.seq,
        id: tip.id,
        prev: page.tip.id,
        ts: 1,
        x: 1,
      };
      return { ...page, entries: [...entries, future], tip };
    };
    await drainTurn(s.controller.send("second prompt"));
    await s.runtime.flushed?.();
    await s.sessions.saver.drain({ timeoutMs: 2000 });
    const text = await readFile(s.file(), "utf8");
    expect(text).toContain("second prompt");
    expect(text).not.toContain("pod-supplied");
    expect(text).not.toContain("future_type");
    await s.runtime.dispose();
  });

  test("/clear starts a NEW file; the old session's file is left byte for byte", async () => {
    const s = await setup();
    await drainTurn(s.controller.send("first prompt"));
    await s.runtime.flushed?.();
    await s.sessions.saver.drain({ timeoutMs: 2000 });
    const oldFile = s.file();
    const before = await readFile(oldFile, "utf8");
    s.controller.close?.();
    const next = s.runtime.createSession(); // what /clear does
    expect(next.sessionId).not.toBe(s.controller.sessionId);
    await drainTurn(next.send("second prompt"));
    await next.flushed?.();
    await s.sessions.saver.drain({ timeoutMs: 2000 });
    expect(await readFile(oldFile, "utf8")).toBe(before);
    const newer = join(s.root, projectKey(s.cwd), `${next.sessionId}.jsonl`);
    expect(await readFile(newer, "utf8")).toContain("second prompt");
    await s.runtime.dispose();
  });
});
