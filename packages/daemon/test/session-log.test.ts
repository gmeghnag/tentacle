import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Agent, type AgentEvent, Session, createSubagentRunner } from "@tentacle/agent";
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
  type KnownLogEntry,
  type LogCursor,
  type LogResult,
  PROTOCOL_VERSION,
  projectionDigest,
} from "@tentacle/protocol";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import { HostedSession, type SessionLogOptions } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { SessionLog, replayFromBase } from "../src/session-log.ts";

// docs/feat/session-log.md — the daemon side of `session/log`.

const env = {} as ExecutionEnvironment;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function idle(hosted: HostedSession): Promise<void> {
  while (hosted.running) await tick();
}

type Step = readonly StreamEvent[] | "throw";

/** One shared script for every agent of a session (a head swap keeps the provider). */
class ScriptModel implements ModelProvider {
  readonly id = "script";
  private i = 0;
  constructor(private readonly script: readonly Step[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const step = this.script[this.i++] ?? [{ type: "done" }];
    await tick(1);
    if (step === "throw") {
      throw new Error("model exploded");
    }
    for (const event of step) {
      await tick(1);
      yield event;
    }
  }
}

const echo: Tool<{ text: string }> = {
  name: "echo",
  description: "echo",
  inputSchema: z.object({ text: z.string() }),
  permission: "none",
  // Read-class: a round of several runs as ONE parallel group (one commit).
  concurrency: () => [{ mode: "read", resource: "x" }],
  async execute(input) {
    await tick(1);
    return { content: input.text };
  },
};

const probe: Tool = {
  name: "reset_probe",
  description: "probe",
  inputSchema: z.object({}).passthrough(),
  permission: "none",
  execute: async () => ({ content: "reset done" }),
};

const FRESH: readonly ChatMessage[] = [
  { role: "system", content: "FRESH SYSTEM" },
  { role: "user", content: "RESTART PROMPT" },
];

/** Does what the agent's own context reset commits: replace in place, then `context_reset`, no await between. */
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

const call = (id: string, name: string, args: unknown): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});

/** Every kind of history change the plan's inventory lists, in one session. */
const SCRIPT: Step[] = [
  // t1: a parallel group (two read-class calls, ONE commit), then text.
  [call("c1", "echo", { text: "one" }), call("c2", "echo", { text: "two" }), { type: "done" }],
  [{ type: "text", delta: "ok" }, { type: "done" }],
  // t2: the model fails — `closeFailedTurn` replaces/pushes behind the cut.
  "throw",
  // compaction's summary.
  [{ type: "text", delta: "SUMMARY" }, { type: "done" }],
  // t3: a context reset mid-turn, then text on the fresh history.
  [call("r1", "reset_probe", {}), { type: "done" }],
  [{ type: "text", delta: "after the reset" }, { type: "done" }],
  // the wake turn (a background job exited while idle).
  [{ type: "text", delta: "woke" }, { type: "done" }],
];

function makeAgent(model: ModelProvider, jobs: FakeJobs, system: string): Agent {
  return new ResettingAgent({
    model,
    systemPrompt: system,
    tools: new ToolRegistry().register(echo).register(probe),
    env,
    jobs,
    toolExecution: { mode: "parallel", maxParallel: 4 },
    // Annotations land often (`messages[target] = {...}`, possibly behind the cut).
    contextAwareness: { window: 400, stepPercent: 1 },
  });
}

/** Every page of a cold read (from the last `base`). */
function readAll(
  hosted: { logRead(after?: LogCursor, maxChars?: number): LogResult },
  maxChars?: number,
) {
  const all: KnownLogEntry[] = [];
  let after: LogCursor | undefined;
  for (;;) {
    const page = hosted.logRead(after, maxChars);
    all.push(...(page.entries as KnownLogEntry[]));
    const last = page.entries.at(-1);
    if (!page.more || !last) return all;
    after = { seq: last.seq, id: last.id };
  }
}

interface Harness {
  readonly hosted: HostedSession;
  readonly drift: string[];
  readonly checks: { n: number };
  readonly seen: KnownLogEntry[];
  /** Read everything new since the last call (incremental, like the laptop). */
  readonly pull: () => void;
  readonly swap: (system: string) => void;
  readonly jobs: FakeJobs;
}

function harness(script: readonly Step[], log: SessionLogOptions = {}): Harness {
  const jobs = new FakeJobs();
  const model = new ScriptModel(script);
  const agent = makeAgent(model, jobs, "SYS-1");
  const session = new Session(agent, "s1", {});
  const drift: string[] = [];
  const checks = { n: 0 };
  const hosted = new HostedSession(
    "s1",
    session,
    new PermissionBroker(),
    jobs,
    {},
    undefined,
    Date.now,
    undefined,
    {},
    {},
    {
      ...log,
      verify: (replayed, committed) => {
        checks.n++;
        if (!Bun.deepEquals(replayed, committed)) {
          drift.push(
            `replay ${JSON.stringify(replayed.map((m) => m.content.slice(0, 20)))} != committed ${JSON.stringify(committed.map((m) => m.content.slice(0, 20)))}`,
          );
        }
      },
    },
  );
  const seen: KnownLogEntry[] = [];
  let after: LogCursor | undefined;
  const pull = (): void => {
    for (;;) {
      const page = hosted.logRead(after);
      seen.push(...(page.entries as KnownLogEntry[]));
      const last = page.entries.at(-1);
      if (last) after = { seq: last.seq, id: last.id };
      if (!page.more) break;
    }
    // At a READ point too (not only at a derivation): a cold read's replay is
    // exactly today's snapshot at the cut — a change with no derivation (the
    // head swap without its hook) shows here.
    const cold = readAll(hosted);
    checks.n++;
    const snapshot = hosted.snapshotPage().messages;
    if (!Bun.deepEquals(replayFromBase(cold), snapshot)) {
      drift.push(`at a read: replay != snapshot (${snapshot.length} messages)`);
    }
  };
  const swap = (system: string): void => {
    hosted.assertIdle();
    hosted.swapAgent(makeAgent(model, jobs, system), {
      settingsReport: { carried: {}, overridden: {} },
      id: crypto.randomUUID(),
    });
  };
  return { hosted, drift, checks, seen, pull, swap, jobs };
}

describe("D1 — drift invariant: the log's replay equals the committed prefix after EVERY derivation", () => {
  test("multi-round turn, parallel group, failed turn, annotations, head swap, compaction, context reset, wake turn", async () => {
    // Mutations (each must FAIL this test): a "since length" derivation (appends
    // only) — the head swap, the annotations and `closeFailedTurn` are lost;
    // no `commit` in `swapAgent` — the head swap is lost; no reset at
    // `historyReplaced` — the compaction is diffed against the same array.
    const h = harness(SCRIPT);
    const { hosted } = h;
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    h.pull();
    hosted.prompt("t2", [{ type: "text", text: "fail please" }]);
    await idle(hosted);
    h.pull();
    h.swap("SYS-2");
    h.pull();
    await hosted.compact();
    h.pull();
    hosted.prompt("t3", [{ type: "text", text: "reset" }]);
    await idle(hosted);
    h.pull();
    // The wake: serve-only (`wake` option); here a job exit while idle.
    h.jobs.exit("j1");
    await tick(20);
    await idle(hosted);
    h.pull();

    expect(h.drift).toEqual([]);
    expect(h.checks.n).toBeGreaterThan(8);
    // The scenario really exercised each kind (else the invariant proves little).
    const types = h.seen.map((e) => e.type);
    const replaces = h.seen.filter((e) => e.type === "replace");
    expect(replaces.some((e) => e.type === "replace" && e.index === 0)).toBe(true); // head swap
    expect(replaces.some((e) => e.type === "replace" && e.index > 0)).toBe(true); // annotation / failed turn
    const bases = h.seen.filter((e) => e.type === "base").map((e) => e.type === "base" && e.reason);
    expect(bases).toEqual(["create", "compact", "context_reset"]);
    expect(types.filter((t) => t === "turn_start")).toHaveLength(4);
    expect(
      h.seen.filter((e) => e.type === "turn_end").map((e) => e.type === "turn_end" && e.stopReason),
    ).toEqual(["end_turn", "error", "end_turn", "end_turn"]);
    expect(
      h.seen
        .filter((e) => e.type === "call_started")
        .map((e) => e.type === "call_started" && e.callId),
    ).toEqual(["c1", "c2", "r1"]);
    // The context reset ran inside t3: its base names the open turn.
    const reset = h.seen.find((e) => e.type === "base" && e.reason === "context_reset");
    expect(reset?.type === "base" && reset.turn).toBe("t3");
    // One chain: seq +1, prev = the previous id, across every segment.
    for (let i = 1; i < h.seen.length; i++) {
      const [a, b] = [h.seen[i - 1], h.seen[i]];
      expect(b?.seq).toBe((a?.seq ?? 0) + 1);
      expect(b?.prev === a?.id).toBe(true);
    }
  });

  test("D1b a sub-agent (the real `agent_task`): its own history never reaches the log; only its result, as a tool message", async () => {
    const spawn: StreamEvent = {
      type: "tool_call",
      toolCall: {
        id: "s1",
        name: "agent_task",
        arguments: JSON.stringify({ description: "d", prompt: "dig", subagent_type: "worker" }),
      },
    };
    // Parent round 1 spawns; the child answers; parent round 2 ends.
    const model = new ScriptModel([
      [spawn, { type: "done" }],
      [{ type: "text", delta: "CHILD RESULT" }, { type: "done" }],
      [{ type: "text", delta: "parent done" }, { type: "done" }],
    ]);
    const tools = new ToolRegistry();
    const { run, types, readOnlyType } = createSubagentRunner({
      model,
      env,
      tools,
      types: [{ name: "worker", description: "w", prompt: "CHILD SYSTEM", tools: "all" }],
    });
    tools.register(createTaskTool((o, c) => run(o, c), types, { readOnlyType }));
    const drift: string[] = [];
    const hosted = new HostedSession(
      "s3",
      new Session(new Agent({ model, tools, env, systemPrompt: "SYS" }), "s3", {}),
      new PermissionBroker(),
      undefined,
      {},
      undefined,
      Date.now,
      undefined,
      {},
      undefined,
      {
        verify: (replayed, committed) => {
          if (!Bun.deepEquals(replayed, committed)) drift.push("drift");
        },
      },
    );
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    expect(drift).toEqual([]);
    const projection = replayFromBase(readAll(hosted));
    expect(projection).toEqual(hosted.snapshotPage().messages as ChatMessage[]);
    expect(projection.map((x) => x.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(projection[3]?.content).toContain("CHILD RESULT");
    // The child's own system prompt / messages are not in the parent's log.
    expect(JSON.stringify(readAll(hosted))).not.toContain("CHILD SYSTEM");
  });
});

const m = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

/** A pure log over plain arrays. */
function pureLog() {
  let t = 1000;
  const log = new SessionLog("inc-1", () => t++);
  const all = (maxChars?: number) =>
    readAll({ logRead: (a, c) => log.read(a, c ?? 1 << 20, sha256) }, maxChars);
  return { log, all };
}

describe("D2–D5 — the pure derivation and its reads", () => {
  test("D2 replace at index 0, mid and last; appends after; nothing when nothing changed", () => {
    const { log, all } = pureLog();
    const h = [m("system", "S"), m("user", "u1"), m("assistant", "a1")];
    log.start(h, "create");
    const tipBefore = log.tip;
    log.commit(h, 3);
    expect(log.tip).toEqual(tipBefore); // nothing changed → no entry
    h[0] = m("system", "S2");
    h[1] = { ...m("user", "u1"), contextUsage: { used: 10, window: 100 } };
    h[2] = m("assistant", "a1!");
    h.push(m("user", "u2"));
    log.commit(h, 4);
    const tail = log.read(tipBefore, 1 << 20, sha256).entries as KnownLogEntry[];
    expect(tail.map((e) => (e.type === "replace" ? `replace@${e.index}` : e.type))).toEqual([
      "replace@0",
      "replace@1",
      "replace@2",
      "message",
    ]);
    expect(replayFromBase(all())).toEqual(h);
  });

  test("D3 a shrink behind the cut is a `truncate` (F3: never lost silently)", () => {
    const { log, all } = pureLog();
    const h = [m("system", "S"), m("user", "u"), m("assistant", "a"), m("user", "v")];
    log.start(h, "create");
    // Synthetic: nothing shrinks behind a cut today; the derivation must still say it.
    log.commit(h, 2);
    const entries = all();
    expect(entries.at(-1)).toMatchObject({ type: "truncate", length: 2, critical: true });
    expect(replayFromBase(entries)).toEqual(h.slice(0, 2));
  });

  test("D4 retention: current + previous segment; one behind reads the old tail + base; two behind → rebased", () => {
    const { log } = pureLog();
    const h = [m("system", "S"), m("user", "u1")];
    log.start(h, "create");
    const inFirst = log.tip;
    h.push(m("assistant", "a1"));
    log.commit(h, 3);
    // Compaction 1: the same array replaced in place.
    h.length = 0;
    h.push(m("system", "S"), m("user", "SUMMARY 1"));
    log.replaced(h, "compact");
    const oneBehind = log.read(inFirst, 1 << 20, sha256);
    expect(oneBehind.rebased).toBeUndefined();
    expect(oneBehind.entries.map((e) => e.type)).toEqual(["message", "base", "message", "message"]);
    const inSecond = log.tip;
    // Compaction 2: the first segment is evicted.
    h.length = 0;
    h.push(m("system", "S"), m("user", "SUMMARY 2"));
    log.replaced(h, "context_reset", "t9");
    const twoBehind = log.read(inFirst, 1 << 20, sha256);
    expect(twoBehind.rebased).toBe(true);
    expect(twoBehind.entries[0]).toMatchObject({
      type: "base",
      reason: "context_reset",
      turn: "t9",
    });
    // One behind again (the second segment is the previous one now): exact.
    expect(log.read(inSecond, 1 << 20, sha256).rebased).toBeUndefined();
    // The right seq with another lineage's id: rebased (F1).
    expect(log.read({ seq: inSecond.seq, id: "other/7" }, 1 << 20, sha256).rebased).toBe(true);
    // A cold read starts at the LAST base (F5), never at the first.
    expect(log.read(undefined, 1 << 20, sha256).entries[0]).toMatchObject({
      reason: "context_reset",
    });
  });

  test("D5 paging by a char budget: `more`, pages within it, a larger single entry alone", () => {
    const { log, all } = pureLog();
    const h = [
      m("system", "S"),
      ...Array.from({ length: 30 }, (_, i) => m("user", `${i}`.repeat(100))),
      m("tool", "x".repeat(5000)), // larger than the budget below
      m("user", "after"),
    ];
    log.start(h, "seed");
    const pages: LogResult[] = [];
    let after: LogCursor | undefined;
    for (;;) {
      const page = log.read(after, 1000, sha256);
      pages.push(page);
      const last = page.entries.at(-1);
      if (!page.more || !last) break;
      after = { seq: last.seq, id: last.id };
    }
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) {
      const size = page.entries.reduce((n, e) => n + JSON.stringify(e).length, 0);
      expect(page.entries.length === 1 || size <= 1000).toBe(true);
    }
    const big = pages.find((p) => p.entries.some((e) => JSON.stringify(e).length > 1000));
    expect(big?.entries).toHaveLength(1);
    expect(replayFromBase(all(1000))).toEqual(h);
    // At the tip: an empty page, `more: false`.
    expect(log.read(log.tip, 1000, sha256)).toMatchObject({ entries: [], more: false });
  });
});

describe("D9 — `root`: the head an incarnation was reseeded from", () => {
  test("reported on reads that start at a base (cold, rebased), never on a linear tail; absent without a reseed", () => {
    const { log } = pureLog();
    const link = { seq: 7, id: "old/7" };
    log.start([m("system", "S"), m("user", "u")], "seed", link);
    expect(log.read(undefined, 1 << 20, sha256).root).toEqual(link);
    const tip = log.tip;
    log.commit([m("system", "S"), m("user", "u"), m("assistant", "a")], 3);
    expect(log.read(tip, 1 << 20, sha256).root).toBeUndefined(); // linear tail
    log.replaced([m("system", "S"), m("user", "SUMMARY")], "compact");
    log.replaced([m("system", "S"), m("user", "SUMMARY 2")], "compact");
    const rebased = log.read({ seq: 7, id: "old/7" }, 1 << 20, sha256);
    expect(rebased.rebased).toBe(true);
    expect(rebased.root).toEqual(link); // kept after the seed segment was evicted
    const fresh = pureLog().log;
    fresh.start([m("system", "S")], "create");
    expect(fresh.read(undefined, 1 << 20, sha256).root).toBeUndefined();
  });
});

describe("D6–D8 — the session's log over the host and the wire", () => {
  function makeHost(model: ModelProvider): SessionHost {
    return new SessionHost({
      defaultCwd: "/tmp/session-log",
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model,
          tools: new ToolRegistry(),
          env,
          requestPermission: (req, options) => permissions.request(req, options),
        });
        return { agent, permissions };
      },
    });
  }
  const sink = { send: () => {} };

  test("D6 `logBase` is honoured only by a session this open CREATES from `messages`", () => {
    const host = makeHost(new ScriptModel([]));
    const logBase = { seq: 41, id: "old-inc/41" };
    const seeded = host.open(
      { sessionId: "a", messages: [{ role: "user", content: "hi" }], logBase },
      sink,
    ).hosted;
    expect(seeded.logRead().entries[0]).toMatchObject({
      type: "base",
      reason: "seed",
      seq: 42,
      prev: "old-inc/41",
    });
    const fresh = host.open({ sessionId: "b", create: true, logBase }, sink).hosted;
    const first = fresh.logRead().entries[0];
    expect(first).toMatchObject({ type: "base", reason: "create", seq: 1 });
    expect(first?.prev).toBeUndefined(); // a lineage's root
    // A live id: attached; its log untouched by the attach's `logBase`.
    const again = host.open(
      { sessionId: "b", messages: [{ role: "user", content: "x" }], logBase },
      sink,
    );
    expect(again.created).toBe(false);
    expect(again.hosted.logRead().entries[0]).toMatchObject({ seq: 1 });
    expect(again.hosted.logRead().entries[0]?.prev).toBeUndefined();
  });

  test("D7 the checkpoint digest is lazy: no hashing in the turn; the first read hashes; = `projectionDigest`", async () => {
    // Mutation: compute the digest in `checkpoint()` → the spy counts calls inside the turn.
    let hashes = 0;
    const spy = (text: string): string => {
      hashes++;
      return sha256(text);
    };
    const jobs = new FakeJobs();
    const model = new ScriptModel([[{ type: "text", delta: "hi" }, { type: "done" }]]);
    // No `verify` here: it reads the log (and so hashes).
    const hosted = new HostedSession(
      "s2",
      new Session(makeAgent(model, jobs, "S"), "s2", {}),
      new PermissionBroker(),
      undefined,
      {},
      undefined,
      Date.now,
      undefined,
      {},
      undefined,
      { sha256: spy },
    );
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    expect(hashes).toBe(0);
    const entries = readAll(hosted);
    const checkpoint = entries.find((e) => e.type === "checkpoint");
    expect(hashes).toBeGreaterThan(0);
    expect(checkpoint).toMatchObject({ type: "checkpoint", count: 3 });
    const projection = replayFromBase(entries);
    expect(checkpoint?.type === "checkpoint" && checkpoint.digest).toBe(
      projectionDigest(projection, sha256),
    );
  });

  test("D8 `session/log` is answered while a turn is in flight (the peer is not serialized)", async () => {
    let release = (): void => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const model: ModelProvider = {
      id: "held",
      async *stream() {
        await held;
        yield { type: "text", delta: "late" };
        yield { type: "done" };
      },
    };
    const host = makeHost(model);
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, host);
    const client = new RpcPeer(clientCh, {});
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    const { sessionId } = (await client.request("session/open", { create: true })) as {
      sessionId: string;
    };
    await client.request("session/prompt", {
      sessionId,
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    expect(host.get(sessionId)?.running).toBe(true);
    const page = (await client.request("session/log", { sessionId })) as LogResult;
    expect(host.get(sessionId)?.running).toBe(true); // answered mid-turn
    expect(page.entries.map((e) => e.type)).toEqual(["base", "title", "turn_start"]);
    release();
    await tick(20);
    expect(host.get(sessionId)?.running).toBe(false);
  });
});
