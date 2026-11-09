import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import type { KnownLogEntry, LogCursor } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import {
  HostedSession,
  type SessionLogOptions,
  type SessionPersistence,
} from "../src/hosted-session.ts";
import type { SessionPersister } from "../src/session-persister.ts";

// docs/feat/subagent-ledger-log.md §4 — the seam 6a calls on `HostedSession`:
// `backgroundAgent` / `agentEnded` / `agentJobsRunning`, the ledger's
// `noteSeen` at every cut, and `logSegmentFacts` at BOTH segment starts.

const env = {} as ExecutionEnvironment;
const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Answers one short text round per model call. */
class QuietModel {
  readonly id = "quiet";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    await tick(1);
    yield { type: "text", delta: "ok" };
    await tick(1);
    yield { type: "done" };
  }
}

/** Counts the writes the seam asks for (a real persister's disk is not this test's subject). */
interface SpyPersister {
  scheduled: number;
  schedule(): void;
  flush(): Promise<void>;
  writable(): boolean;
  write(): Promise<boolean>;
}

function spyPersister(): SpyPersister {
  return {
    scheduled: 0,
    schedule() {
      this.scheduled++;
    },
    async flush() {},
    writable: () => false,
    async write() {
      return false;
    },
  };
}

function harness(
  log: SessionLogOptions = {},
  history: readonly ChatMessage[] = [],
): { readonly hosted: HostedSession; readonly persister: SpyPersister } {
  const persister = spyPersister();
  const agent = new Agent({
    model: new QuietModel(),
    systemPrompt: "SYS",
    tools: new ToolRegistry(),
    env,
  });
  const session = new Session(agent, "s1", history.length > 0 ? { messages: history } : {});
  const hosted = new HostedSession(
    "s1",
    session,
    new PermissionBroker(),
    undefined,
    {},
    undefined,
    Date.now,
    { persister: persister as unknown as SessionPersister } satisfies SessionPersistence,
    {},
    {},
    log,
  );
  return { hosted, persister };
}

/** Every entry of a cold read. */
function readAll(hosted: HostedSession): KnownLogEntry[] {
  const all: KnownLogEntry[] = [];
  let after: LogCursor | undefined;
  for (;;) {
    const page = hosted.logRead(after);
    all.push(...(page.entries as KnownLogEntry[]));
    const last = page.entries.at(-1);
    if (!page.more || !last) return all;
    after = { seq: last.seq, id: last.id };
  }
}

const of = <T extends KnownLogEntry["type"]>(entries: readonly KnownLogEntry[], type: T) =>
  entries.filter((e): e is Extract<KnownLogEntry, { type: T }> => e.type === type);

/** The entries a reader sees AFTER the last `base`'s owed messages (title, markers, …). */
function afterLastBase(hosted: HostedSession): KnownLogEntry[] {
  const entries = readAll(hosted);
  let at = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "base") {
      at = i;
      break;
    }
  }
  const base = entries[at];
  const owed = base?.type === "base" ? base.count : 0;
  return entries.slice(at + 1 + owed);
}

const isMarker = (e: KnownLogEntry): boolean =>
  e.type === "subagent_background" || e.type === "subagent_end";

/** The session's live history (the agent's own array). */
const messagesOf = (hosted: HostedSession): ChatMessage[] =>
  (hosted as unknown as { session: Session }).session.messages;

describe("HostedSession: the background sub-agent seam", () => {
  test("backgroundAgent hands out sa-1, sa-2 and logs `subagent_background` for each", () => {
    // RED on main: neither the methods nor the markers exist (a child that
    // exists is only in memory, or in a tool result a summary may drop).
    // Mutation: return the id WITHOUT logging → no marker → red.
    const { hosted } = harness();
    const first = hosted.backgroundAgent({
      callId: "c1",
      agentType: "explore",
      description: "map the repo",
    });
    const second = hosted.backgroundAgent({
      callId: "c2",
      agentType: "explore",
      description: "another",
    });
    expect([first, second]).toEqual(["sa-1", "sa-2"]);
    const markers = of(readAll(hosted), "subagent_background");
    expect(markers.map((m) => m.agentId)).toEqual(["sa-1", "sa-2"]);
    expect(markers[0]?.callId).toBe("c1");
    expect(markers[0]?.agentType).toBe("explore");
    expect(markers[0]?.description).toBe("map the repo");
    expect(markers[0]?.critical).toBe(false);
    expect(hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1", "sa-2"]);
  });

  test("agentEnded logs `subagent_end` ONCE (a second, later end logs nothing) and persists", () => {
    // Mutation: drop the `persist()` → a child that ends while the session is
    // idle never reaches disk (its report is lost on a crash, FM 2/3) → red.
    const { hosted, persister } = harness();
    hosted.backgroundAgent({ callId: "c1", agentType: "explore", description: "d" });
    const before = persister.scheduled;
    hosted.agentEnded("sa-1", "end_turn", "THE REPORT");
    expect(persister.scheduled).toBe(before + 1);
    hosted.agentEnded("sa-1", "cancelled", "A LATER REPORT");
    expect(persister.scheduled).toBe(before + 1); // a duplicate end writes nothing
    const ends = of(readAll(hosted), "subagent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe("end_turn");
    expect(ends[0]?.report).toBe("THE REPORT");
    expect(hosted.agentJobsRunning()).toEqual([]);
  });

  test("the counter is seeded from the history: no id the model has already seen is reused", () => {
    // FM 20. Mutation: `new AgentJobLedger()` instead of `fromHistory(session.messages)`
    // → a restarted session hands out sa-1 twice → red.
    const { hosted } = harness({}, [
      { role: "system", content: "SYS" },
      { role: "tool", content: "started in background as sa-5: map repo", toolCallId: "c1" },
      { role: "user", content: "go" },
    ]);
    expect(hosted.backgroundAgent({ callId: "c9", agentType: "t", description: "d" })).toBe("sa-6");
  });

  test("a committed note CLOSES its child: the next segment re-emits nothing for it", async () => {
    // Mutation: drop the `noteSeen` loop in `recordCut` → a delivered child is
    // re-emitted at every following segment start, and every load notes it
    // again (FM 12/13) → red.
    const { hosted } = harness();
    hosted.backgroundAgent({ callId: "c1", agentType: "explore", description: "d" });
    hosted.agentEnded("sa-1", "end_turn", "R");
    // 6a's delivery: the note becomes a history message, and the next committed
    // boundary (here the turn that follows) closes the child.
    messagesOf(hosted).push({
      role: "user",
      content: "[background] sub-agent sa-1 (d) finished (end_turn):\nR",
      note: { kind: "subagent_report", id: "sa-1" },
    });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    while (hosted.running) await tick();
    await hosted.compact();
    expect(afterLastBase(hosted).filter(isMarker)).toEqual([]);
  });

  test("a RUNNING child's `bg` is re-emitted right after the new base at a history replacement", async () => {
    // FM 12: a compaction (or a context reset) while a child runs. Mutation:
    // drop `logSegmentFacts` at `historyReplaced` → red: the summary may have
    // dropped the `started in background as sa-N` result and nothing says it existed.
    const { hosted } = harness();
    hosted.backgroundAgent({ callId: "c1", agentType: "explore", description: "map the repo" });
    await hosted.compact();
    const after = afterLastBase(hosted);
    expect(after[0]?.type).toBe("title");
    expect(after[1]?.type).toBe("subagent_background");
    expect(after[1]?.type === "subagent_background" && after[1].agentId).toBe("sa-1");
  });

  test("an ENDED undelivered child re-emits BOTH markers at a segment start", async () => {
    // Running → [bg]; ended-undelivered → [bg, end{report}] (an `end` alone loses
    // the description; the pair is what the load reads). Mutation: emit only
    // the `bg` → the report never reaches the reloaded segment → red.
    const { hosted } = harness();
    hosted.backgroundAgent({ callId: "c1", agentType: "explore", description: "d" });
    hosted.agentEnded("sa-1", "end_turn", "THE REPORT");
    await hosted.compact();
    const markers = afterLastBase(hosted).filter(isMarker);
    expect(markers.map((m) => m.type)).toEqual(["subagent_background", "subagent_end"]);
    expect(markers[1]?.type === "subagent_end" && markers[1].report).toBe("THE REPORT");
  });

  test("an empty ledger logs no marker at a segment start (today's behaviour, unchanged)", async () => {
    const { hosted } = harness();
    await hosted.compact();
    const after = afterLastBase(hosted);
    expect(after[0]?.type).toBe("title");
    expect(after.filter(isMarker)).toEqual([]);
  });

  test("the D1 drift invariant holds with markers in the mix (they never project)", async () => {
    // The markers are non-projecting, so the log's replay must equal the
    // committed prefix after every derivation (as `session-log.test.ts` asserts
    // for the whole entry inventory). Mutation: make a marker project (a
    // `message`-like push) → the replay grows past the snapshot → red.
    const drift: string[] = [];
    const { hosted } = harness({
      verify: (replayed, committed) => {
        if (!Bun.deepEquals(replayed, committed)) {
          drift.push(`replay ${replayed.length} != committed ${committed.length}`);
        }
      },
    });
    hosted.backgroundAgent({ callId: "c1", agentType: "explore", description: "d" });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    while (hosted.running) await tick();
    hosted.agentEnded("sa-1", "end_turn", "THE REPORT");
    hosted.backgroundAgent({ callId: "c2", agentType: "explore", description: "still running" });
    await hosted.compact();
    expect(drift).toEqual([]);
    // The markers really were logged (else the invariant proves nothing).
    expect(readAll(hosted).filter(isMarker).length).toBeGreaterThan(0);
  });
});
