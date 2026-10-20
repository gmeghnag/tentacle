import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import {
  DomainErrorCode,
  type HistoryCut,
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  type SnapshotResult,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError } from "@tentacle/transport";
import { z } from "zod";
import { type Attachment, HostedSession, type UpdateSink } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";

/** A test client attached to a hosted session: receives updates, denies permissions. */
const sinkTo = (send: UpdateSink): Attachment => ({
  send,
  requestPermission: async () => ({ outcome: "cancelled" }),
});

/** Each event after a timer: one macrotask per event, like network I/O. */
class TimedProvider implements ModelProvider {
  readonly id = "timed";
  private call = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    for (const event of this.script[this.call++] ?? [{ type: "done" }]) {
      await new Promise((r) => setTimeout(r, 1));
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  writeFile() {
    throw new Error("unused");
  },
};

const echoTool: Tool<{ text: string }> = {
  name: "echo",
  description: "Echo text back.",
  inputSchema: z.object({ text: z.string() }),
  permission: "none",
  async execute(input) {
    return { content: input.text };
  },
};

const call = (id: string, text: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "echo", arguments: JSON.stringify({ text }) },
});

/** Background jobs whose exits the test fires by hand (the agent and the daemon both listen). */
class FakeJobs implements JobController {
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  exit(id: string): void {
    const job: BackgroundJob = {
      id,
      command: "sleep 1",
      startedAt: 0,
      status: "exited",
      exitCode: 0,
    };
    for (const l of this.listeners) l(job);
  }
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read() {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [];
  }
  dispose(): void {}
}

/**
 * Turn 1: text → tool → (steer) → an empty round (the nudge) → text; a
 * background job exits; a compaction; turn 2 (starts with the job's note):
 * tool → text. Every kind of history push the agent loop makes.
 */
const SCRIPT: StreamEvent[][] = [
  [
    { type: "text", delta: "Let me " },
    { type: "text", delta: "look." },
    call("c1", "one"),
    { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
  ],
  [{ type: "text", delta: " " }, { type: "done" }],
  [{ type: "text", delta: "Ok, " }, { type: "text", delta: "done." }, { type: "done" }],
  [{ type: "text", delta: "SUMMARY" }, { type: "done" }],
  [{ type: "text", delta: "Again: " }, call("c2", "two"), { type: "done" }],
  [{ type: "text", delta: "Bye." }, { type: "done" }],
];

const jobsOf = new WeakMap<HostedSession, FakeJobs>();

function makeHosted(ringBytes?: number, seed?: readonly ChatMessage[]): HostedSession {
  const jobs = new FakeJobs();
  const agent = new Agent({
    model: new TimedProvider(SCRIPT),
    tools: new ToolRegistry().register(echoTool),
    env: noopEnv,
    jobs,
  });
  const session = new Session(agent, "s1", seed ? { messages: seed } : {});
  const hosted = new HostedSession("s1", session, new PermissionBroker(), jobs, {}, ringBytes);
  jobsOf.set(hosted, jobs);
  return hosted;
}

const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function idle(hosted: HostedSession): Promise<void> {
  while (hosted.running) await tick();
}

/** Run the whole scenario; `onEmit` sees every update, synchronously, as it is emitted. */
async function scenario(
  hosted: HostedSession,
  onEmit: (p: KnownSessionUpdateParams) => void = () => {},
): Promise<KnownSessionUpdateParams[]> {
  const all: KnownSessionUpdateParams[] = [];
  let steered = false;
  hosted.attach(
    sinkTo((p) => {
      all.push(p);
      if (!steered && p.update.type === "agent_message_chunk") {
        steered = true;
        hosted.enqueue("e1", "t1", "steer-A");
      }
      onEmit(p);
    }),
  );
  hosted.prompt("t1", [{ type: "text", text: "go" }]);
  await idle(hosted);
  jobsOf.get(hosted)?.exit("j1");
  await hosted.compact();
  hosted.prompt("t2", [{ type: "text", text: "again" }]);
  await idle(hosted);
  return all;
}

/** Every page, `limit` at a time, newest first; joined chronologically. */
function readAll(
  hosted: HostedSession,
  limit = 2,
): { messages: ChatMessage[]; first: SnapshotResult } {
  const first = hosted.snapshotPage(undefined, limit);
  const pages = [first.messages];
  let cursor = first.cursor;
  while (cursor !== undefined) {
    const page = hosted.snapshotPage(cursor, limit);
    expect(page.since).toBeUndefined();
    pages.unshift(page.messages);
    cursor = page.cursor;
  }
  return { messages: pages.flat() as ChatMessage[], first };
}

// --- the projected transcript (decision C) -----------------------------------
// What both a history and an update stream can say: user text, assistant text,
// tool calls BY ID (an assistant message carries its calls before their
// `tool_call` updates are emitted: a reducer upserts by id), tool results by id.
// Whitespace-only assistant text is not projected: the agent drops an empty
// round from the history (the nudge), so only the live stream ever showed it.
type Item = string;

function fromHistory(messages: readonly ChatMessage[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push(`user:${m.content}`);
    if (m.role === "assistant") {
      if (m.content.trim() !== "") out.push(`assistant:${m.content}`);
      for (const c of m.toolCalls ?? []) out.push(`call:${c.id}`);
    }
    if (m.role === "tool") out.push(`result:${m.toolCallId}:${m.content}`);
  }
  return out;
}

function applyUpdates(base: Item[], updates: readonly KnownSessionUpdateParams[]): Item[] {
  const out = [...base];
  let text = "";
  const flush = (): void => {
    if (text.trim() !== "") out.push(`assistant:${text}`);
    text = "";
  };
  for (const { update: u } of updates) {
    switch (u.type) {
      case "agent_message_chunk":
        text += u.content.type === "text" ? u.content.text : "";
        break;
      case "turn_start":
        flush();
        if (u.prompt !== "") out.push(`user:${u.prompt}`);
        break;
      case "steer":
      case "context_note":
        flush();
        out.push(`user:${u.text}`);
        break;
      case "tool_call":
        flush();
        if (!out.includes(`call:${u.toolCallId}`)) out.push(`call:${u.toolCallId}`);
        break;
      case "tool_call_update": {
        flush();
        const body = (u.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
        out.push(`result:${u.toolCallId}:${body}`);
        break;
      }
      case "turn_end":
        flush();
        break;
      case "history_replaced":
        throw new Error("a replay must never cross a barrier (that is a resync)");
      default:
        break; // display-only: usage, thoughts, plan, background exits
    }
  }
  flush();
  return out;
}

/** Rebuild the transcript a fresh client would have, from a snapshot taken at k. */
function recover(hosted: HostedSession, snap: { messages: ChatMessage[]; since: HistoryCut }) {
  let { messages, since } = snap;
  let replay = hosted.replayFrom(since);
  let resynced = false;
  if ("resync" in replay) {
    resynced = true;
    const again = readAll(hosted);
    if (!again.first.since) throw new Error("first page without a cut");
    messages = again.messages;
    since = again.first.since;
    replay = hosted.replayFrom(since);
    if ("resync" in replay) throw new Error("resync right after a fresh snapshot");
  }
  // Contiguous from the cut, no gap, no duplicate.
  replay.replay.forEach((p, i) => expect(p.seq).toBe(since.seq + 1 + i));
  return { items: applyUpdates(fromHistory(messages), replay.replay), resynced, since };
}

function finalHistory(hosted: HostedSession): ChatMessage[] {
  return hosted.snapshotPage().messages as ChatMessage[];
}

describe("history cut: snapshot + replay at every drop point (the exact property)", () => {
  for (const mode of ["in the sink (microtask order)", "a macrotask later"] as const) {
    test(`every k, ${mode}: projected transcript == the daemon's, seqs contiguous`, async () => {
      // A dry run counts the emits; then one fresh run per drop point.
      const total = (await scenario(makeHosted())).length;
      expect(total).toBeGreaterThan(15);
      let resyncs = 0;
      for (let k = 1; k <= total; k++) {
        const hosted = makeHosted();
        let snap: { messages: ChatMessage[]; since: HistoryCut } | null = null;
        const take = (): void => {
          const { messages, first } = readAll(hosted);
          if (!first.since) throw new Error("first page without a cut");
          snap = { messages, since: first.since };
        };
        let n = 0;
        await scenario(hosted, () => {
          if (++n !== k) return;
          if (mode === "a macrotask later") setTimeout(take, 0);
          else take();
        });
        await tick();
        const taken = snap as { messages: ChatMessage[]; since: HistoryCut } | null;
        if (!taken) throw new Error(`no snapshot at k=${k}`);
        const final = finalHistory(hosted);
        const { items, resynced, since } = recover(hosted, taken);
        expect({ k, items }).toEqual({ k, items: fromHistory(final) });
        // Only a compaction since the snapshot forces a resync with the default ring.
        if (resynced) {
          resyncs++;
          expect(taken.since.epoch).not.toBe(since.epoch);
        }
      }
      // The drop points before the barrier resynced; the ones after replayed.
      expect(resyncs).toBeGreaterThan(0);
      expect(resyncs).toBeLessThan(total);
    });
  }

  test("the reference is not trivial: it holds both turns, the steer and both tools", async () => {
    const hosted = makeHosted();
    await scenario(hosted);
    expect(fromHistory(finalHistory(hosted))).toEqual([
      expect.stringContaining("user:Summary of the earlier conversation"),
      "user:again",
      expect.stringContaining("user:[background] job j1"),
      "assistant:Again: ",
      "call:c2",
      "result:c2:two",
      "assistant:Bye.",
    ]);
  });

  test("a mid-round snapshot is exact BEFORE the compaction too (no resync)", async () => {
    // Stop before the compaction: every drop point of turn 1 must replay.
    for (let k = 1; k <= 14; k++) {
      const hosted = makeHosted();
      let n = 0;
      let snap: { messages: ChatMessage[]; since: HistoryCut } | null = null;
      hosted.attach(
        sinkTo((p) => {
          if (p.update.type === "agent_message_chunk" && n === 1) {
            hosted.enqueue("e1", "t1", "steer-A");
          }
          if (++n === k) {
            const { messages, first } = readAll(hosted, 1);
            if (first.since) snap = { messages, since: first.since };
          }
        }),
      );
      hosted.prompt("t1", [{ type: "text", text: "go" }]);
      await idle(hosted);
      const taken = snap as { messages: ChatMessage[]; since: HistoryCut } | null;
      if (!taken) continue;
      const { items, resynced } = recover(hosted, taken);
      expect(resynced).toBe(false);
      const reference = fromHistory(finalHistory(hosted));
      // The nudge is in the history, so it must be in every rebuilt transcript.
      expect(reference).toContain("user:Continue with the task.");
      expect({ k, items }).toEqual({ k, items: reference });
    }
  });
});

describe("history cut: ring pin, barrier, cursors", () => {
  test("a tiny ring never evicts past the cut: a fresh snapshot always replays", async () => {
    const hosted = makeHosted(1);
    let checked = 0;
    await scenario(hosted, () => {
      const first = hosted.snapshotPage(undefined, 1);
      if (!first.since) throw new Error("first page without a cut");
      expect("replay" in hosted.replayFrom(first.since)).toBe(true);
      checked++;
    });
    expect(checked).toBeGreaterThan(15);
  });

  test("the ring is not reset at a turn boundary: turn 1's tail replays after turn 2", async () => {
    const hosted = makeHosted();
    let since: HistoryCut | undefined;
    hosted.attach(
      sinkTo((p) => {
        if (p.update.type === "tool_call" && !since) since = hosted.snapshotPage().since;
      }),
    );
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    hosted.prompt("t2", [{ type: "text", text: "again" }]);
    await idle(hosted);
    if (!since) throw new Error("no cut taken");
    const r = hosted.replayFrom(since);
    if (!("replay" in r)) throw new Error("expected a replay");
    const types = r.replay.map((p) => p.update.type);
    expect(types.filter((t) => t === "turn_end")).toHaveLength(2);
    expect(types).toContain("turn_start");
  });

  test("compaction emits history_replaced (mandatory) and starts a new epoch", async () => {
    const hosted = makeHosted();
    const seen: KnownSessionUpdateParams[] = [];
    hosted.attach(sinkTo((p) => seen.push(p)));
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    const before = hosted.snapshotPage();
    await hosted.compact();
    const barrier = seen.at(-1);
    expect(barrier?.update).toEqual({ type: "history_replaced", reason: "compact" });
    expect(barrier?.mandatory).toBe(true);
    const after = hosted.snapshotPage();
    if (!before.since || !after.since || !barrier) throw new Error("missing cut");
    expect(after.since.epoch).not.toBe(before.since.epoch);
    expect(after.since.seq).toBe(barrier.seq);
    expect(after.messages).toHaveLength(1);
    // Anything from before the barrier is a resync; the new cut replays nothing.
    expect(hosted.replayFrom(before.since)).toEqual({ resync: true });
    expect(hosted.replayFrom(after.since)).toEqual({ replay: [] });
    // A crafted seq of the CURRENT epoch from before the barrier: resync too.
    expect(hosted.replayFrom({ epoch: after.since.epoch, seq: barrier.seq - 1 })).toEqual({
      resync: true,
    });
  });

  test("a since in the future or of an unknown epoch is a resync, never a throw", () => {
    const hosted = makeHosted();
    const { since } = hosted.snapshotPage();
    if (!since) throw new Error("no cut");
    expect(hosted.replayFrom({ epoch: since.epoch, seq: since.seq + 1 })).toEqual({ resync: true });
    expect(hosted.replayFrom({ epoch: "nope", seq: 0 })).toEqual({ resync: true });
    expect(hosted.replayFrom({ epoch: since.epoch, seq: -1 })).toEqual({ resync: true });
    expect(hosted.replayFrom({ epoch: since.epoch, seq: 0.5 })).toEqual({ resync: true });
    expect(hosted.replayFrom(since)).toEqual({ replay: [] });
  });

  test("a cursor of an older epoch is StaleCursor; a malformed one InvalidParams", async () => {
    const hosted = makeHosted();
    hosted.attach(sinkTo(() => {}));
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    const page = hosted.snapshotPage(undefined, 1);
    const cursor = page.cursor;
    const epoch = page.since?.epoch ?? "";
    if (!cursor) throw new Error("expected an older page");
    const codeOf = (c: string): number | undefined => {
      try {
        hosted.snapshotPage(c, 1);
        return undefined;
      } catch (error) {
        return error instanceof RpcError ? error.code : -1;
      }
    };
    expect(codeOf(cursor)).toBeUndefined();
    for (const bad of [
      "x",
      "/1",
      `${epoch}/0`,
      `${epoch}/-1`,
      `${epoch}/1.5`,
      `${epoch}/999`,
      `${epoch}/`,
    ]) {
      expect({ bad, code: codeOf(bad) }).toEqual({ bad, code: JsonRpcErrorCode.InvalidParams });
    }
    await hosted.compact();
    expect(codeOf(cursor)).toBe(DomainErrorCode.StaleCursor);
  });

  test("`turn` names the turn running at the cut, and only then", async () => {
    const hosted = makeHosted();
    const turns: (string | undefined)[] = [];
    hosted.attach(
      sinkTo((p) => {
        if (p.update.type === "tool_call") turns.push(hosted.snapshotPage().turn?.turnId);
      }),
    );
    expect(hosted.snapshotPage().turn).toBeUndefined();
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    expect(turns).toEqual(["t1"]);
    expect(hosted.snapshotPage().turn).toBeUndefined();
    // A later page never carries the cut or the turn.
    const older = hosted.snapshotPage(hosted.snapshotPage(undefined, 1).cursor, 1);
    expect(older.since).toBeUndefined();
    expect(older.turn).toBeUndefined();
  });

  test("paging: newest page first, chronological inside, joined == one-shot", async () => {
    const hosted = makeHosted();
    await scenario(hosted);
    const whole = hosted.snapshotPage();
    expect(whole.cursor).toBeUndefined();
    for (const limit of [1, 2, 3, 100]) {
      expect(readAll(hosted, limit).messages).toEqual(whole.messages as ChatMessage[]);
    }
    const newest = hosted.snapshotPage(undefined, 2);
    expect(newest.messages).toEqual(whole.messages.slice(-2));
  });

  test("a resumed session's seed is in the snapshot before any turn", () => {
    const seed: ChatMessage[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "answer" },
    ];
    const hosted = makeHosted(undefined, seed);
    const page = hosted.snapshotPage();
    expect(page.messages as ChatMessage[]).toEqual(seed);
    expect(page.since?.seq).toBe(0);
  });

  test("a throwing sink at turn end still moves the cut past the turn", async () => {
    const hosted = makeHosted();
    hosted.attach(
      sinkTo((p) => {
        if (p.update.type === "turn_end") throw new Error("sink down");
      }),
    );
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    const page = hosted.snapshotPage();
    expect(page.turn).toBeUndefined();
    expect(fromHistory(page.messages as ChatMessage[]).at(-1)).toBe("assistant:Ok, done.");
    if (!page.since) throw new Error("no cut");
    expect(hosted.replayFrom(page.since)).toEqual({ replay: [] });
  });
});

describe("history cut: emit order and wiring (review findings)", () => {
  test("the barrier's cut is final before history_replaced reaches the sink", async () => {
    const hosted = makeHosted();
    hosted.attach(sinkTo(() => {}));
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    const before = hosted.snapshotPage().since;
    let inSink: SnapshotResult | undefined;
    let barrierSeq = -1;
    hosted.attach(
      sinkTo((p) => {
        if (p.update.type === "history_replaced") {
          barrierSeq = p.seq;
          inSink = hosted.snapshotPage();
        }
      }),
    );
    await hosted.compact();
    if (!inSink?.since || !before) throw new Error("no snapshot in the sink");
    // Re-entrant read: already the new epoch, the barrier's seq, the new history.
    expect(inSink.since.epoch).not.toBe(before.epoch);
    expect(inSink.since.seq).toBe(barrierSeq);
    expect(inSink.messages).toHaveLength(1);
    expect(hosted.replayFrom(inSink.since)).toEqual({ replay: [] });
  });

  test("a throwing sink is detached; the update stays in the ring, the turn and the others go on", async () => {
    const hosted = makeHosted();
    const since = hosted.snapshotPage().since;
    let thrown = 0;
    let afterThrow = 0;
    const healthy: number[] = [];
    hosted.attach(
      sinkTo((p) => {
        if (thrown > 0) afterThrow++;
        if (p.update.type === "agent_message_chunk") {
          thrown++;
          throw new Error("sink down");
        }
      }),
    );
    hosted.attach(sinkTo((p) => healthy.push(p.seq)));
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    if (!since) throw new Error("no cut");
    const r = hosted.replayFrom(since);
    if (!("replay" in r)) throw new Error("expected a replay");
    r.replay.forEach((p, i) => expect(p.seq).toBe(since.seq + 1 + i));
    // The turn ran to its normal end; the healthy client got every update.
    expect(r.replay.at(-1)?.update).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
    expect(healthy).toEqual(r.replay.map((p) => p.seq));
    // The throwing one was detached at its first throw: never called again.
    expect(thrown).toBe(1);
    expect(afterThrow).toBe(0);
    expect(hosted.attachedCount).toBe(1);
  });

  test("SessionHost passes ringBytes to its sessions", async () => {
    const make = (ringBytes?: number) =>
      new SessionHost({
        defaultCwd: "/tmp/history-cut",
        ...(ringBytes !== undefined ? { ringBytes } : {}),
        createAgent: () => ({
          agent: new Agent({
            model: new TimedProvider(SCRIPT),
            tools: new ToolRegistry(),
            env: noopEnv,
          }),
          permissions: new PermissionBroker(),
        }),
      }).open(
        { sessionId: "s", create: true },
        sinkTo(() => {}),
      ).hosted;
    const outcome = async (hosted: HostedSession) => {
      const since = hosted.snapshotPage().since;
      if (!since) throw new Error("no cut");
      hosted.attach(sinkTo(() => {}));
      hosted.prompt("t1", [{ type: "text", text: "go" }]);
      await idle(hosted);
      return "replay" in hosted.replayFrom(since) ? "replay" : "resync";
    };
    // The turn is far over 1 byte: everything up to the end-of-turn cut is evicted.
    expect(await outcome(make(1))).toBe("resync");
    expect(await outcome(make())).toBe("replay");
  });
});
