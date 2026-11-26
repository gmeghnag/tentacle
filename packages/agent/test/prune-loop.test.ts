/**
 * Smart compaction in the agent loop (docs/feat/smart-compaction.md, S2): the
 * request is the stored history with the prune set applied, the set grows only
 * in gain-gated batches (so the prefix bytes stay stable between them), the
 * stored history is never touched, and every in-place history replacement
 * drops the set explicitly.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { CONTEXT_RESET_TOOL_NAME, ToolRegistry, createContextResetTool } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentConfig } from "../src/agent.ts";
import { PRUNE_MARKER } from "../src/prune.ts";
import { Session } from "../src/session.ts";

/** Replays a script, one round per request, and keeps a deep copy of each request. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    for (const e of this.script[this.turn++] ?? [
      { type: "text", delta: "end" },
      { type: "done" },
    ]) {
      yield e;
    }
  }
}

/** A `shell` whose output is `lines` 40-char lines: an R3 candidate once old. */
const shell: Tool<{ lines: number }> = {
  name: "shell",
  description: "shell",
  inputSchema: z.object({ lines: z.number() }),
  permission: "none",
  async execute(input) {
    const body = Array.from({ length: input.lines }, (_, i) =>
      `line ${String(i).padStart(4, "0")} `.padEnd(39, "x"),
    ).join("\n");
    return { content: `exit 0\n${body}` };
  },
};

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const sh = (id: string, lines = 250): StreamEvent[] => [
  { type: "tool_call", toolCall: { id, name: "shell", arguments: JSON.stringify({ lines }) } },
  { type: "done" },
];
const say = (text: string): StreamEvent[] => [{ type: "text", delta: text }, { type: "done" }];

/** Six long shell rounds, then an answer: 7 requests. */
const SIX = [sh("c1"), sh("c2"), sh("c3"), sh("c4"), sh("c5"), sh("c6"), say("done")];

/**
 * Window 10k tokens; each output ~2.5k tokens, its stub ~0.45k. Over 50 % with
 * a fresh gain of 30 % (two stubs, not one) → a batch.
 */
const PRUNE: NonNullable<AgentConfig["contextPrune"]> = {
  window: 10_000,
  pruneAtPercent: 50,
  minGainPercent: 30,
  keepRecentRounds: 1,
  outputChars: 2000,
};

function agentWith(model: ModelProvider, extra: Partial<AgentConfig> = {}): Agent {
  const tools = new ToolRegistry();
  tools.register(shell);
  tools.register(createContextResetTool());
  return new Agent({ model, tools, env, systemPrompt: "sys", maxIterations: 40, ...extra });
}

async function send(session: Session, text: string): Promise<void> {
  for await (const _ of session.send(text)) {
    // drain
  }
}

const pruned = (r: ChatRequest | undefined): number =>
  (r?.messages ?? []).filter(
    (m) => typeof m.content === "string" && m.content.startsWith(PRUNE_MARKER),
  ).length;

/** Requests (index) whose messages do NOT start with the previous request's exact bytes. */
function breaks(requests: readonly ChatRequest[]): number[] {
  const out: number[] = [];
  for (let j = 1; j < requests.length; j++) {
    const prev = requests[j - 1]?.messages ?? [];
    const cur = requests[j]?.messages ?? [];
    if (JSON.stringify(cur.slice(0, prev.length)) !== JSON.stringify(prev)) {
      out.push(j);
    }
  }
  return out;
}

async function prunedRun(): Promise<{ agent: Agent; session: Session; model: Scripted }> {
  const model = new Scripted(SIX);
  const agent = agentWith(model, { contextPrune: PRUNE });
  const session = new Session(agent, "s1");
  await send(session, "go");
  return { agent, session, model };
}

describe("smart compaction in the loop", () => {
  test("load-bearing: the request carries stubs while the stored history keeps every output", async () => {
    const { session, model } = await prunedRun();
    expect(model.requests.length).toBe(7);
    expect(pruned(model.requests.at(-1))).toBeGreaterThan(0);
    const stored = session.messages.filter((m) => m.role === "tool");
    expect(stored.length).toBe(6);
    for (const m of stored) {
      expect(m.content.startsWith("exit 0\nline 0000")).toBe(true);
      expect(m.content).not.toContain(PRUNE_MARKER);
    }
  });

  test("below the threshold the requests are exactly today's (no contextPrune)", async () => {
    const off = new Scripted(SIX);
    await send(new Session(agentWith(off), "s1"), "go");
    const high = new Scripted(SIX);
    await send(
      new Session(agentWith(high, { contextPrune: { ...PRUNE, window: 1_000_000_000 } }), "s1"),
      "go",
    );
    // `durationMs` is each tool's wall-clock time: it differs run to run and is not part of the shape.
    const shape = (rs: readonly ChatRequest[]): unknown =>
      JSON.parse(JSON.stringify(rs, (k, v) => (k === "durationMs" ? 0 : v)));
    expect(shape(high.requests)).toEqual(shape(off.requests));
    expect(off.requests.some((r) => pruned(r) > 0)).toBe(false);
  });

  test("a batch only when over the threshold AND the gain gate; the prefix is stable between batches", async () => {
    const { model } = await prunedRun();
    // req 3 (index 2) is over 50 % but only ONE fresh stub (< 30 %): no batch.
    // Batches at index 3 (c1+c2) and 5 (c3+c4); index 4 and 6 append only.
    expect(model.requests.map(pruned)).toEqual([0, 0, 0, 2, 2, 4, 4]);
    expect(breaks(model.requests)).toEqual([3, 5]);
  });

  test("under pruneAtPercent nothing is pruned, even when the gain alone would qualify", async () => {
    // ~15k tokens at the end of a 20k window: under 100 %, over 50 %. Gain gate 1 %.
    const run = async (pruneAtPercent: number) => {
      const model = new Scripted(SIX);
      const config = { ...PRUNE, window: 20_000, minGainPercent: 1, pruneAtPercent };
      await send(new Session(agentWith(model, { contextPrune: config }), "s1"), "go");
      return model.requests.map(pruned);
    };
    expect(await run(100)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect((await run(50)).some((n) => n > 0)).toBe(true);
  });

  test("a batch drops the anchor: the batch round never reports the pre-prune measure", async () => {
    // Request i measures 9000 + 300·i tokens (growing, so a kept anchor's line
    // crosses a new step and is emitted). keepRecentRounds 2 keeps the anchor's
    // ref (the previous request's last message) live through the batch at
    // index 4, so a kept anchor would claim ~9.9k + the new output (~12.4k).
    const measured = (events: StreamEvent[], i: number): StreamEvent[] =>
      events.map((e) =>
        e.type === "done"
          ? { type: "done", usage: { promptTokens: 9000 + 300 * i, completionTokens: 1 } }
          : e,
      );
    const model = new Scripted(SIX.map(measured));
    const agent = agentWith(model, {
      contextPrune: { ...PRUNE, keepRecentRounds: 2 },
      contextAwareness: { window: PRUNE.window, stepPercent: 1 },
    });
    const session = new Session(agent, "s1");
    await send(session, "go");
    expect(model.requests.map(pruned).findIndex((n) => n > 0)).toBe(4);
    const batchRound = session.messages.find((m) => m.toolCallId === "c4");
    expect(batchRound).toBeDefined();
    expect(batchRound?.contextUsage?.used ?? 0).toBeLessThan(9000);
  });

  test("the stored history is byte-identical to an unpruned run (the log is intact)", async () => {
    const { session, model } = await prunedRun();
    expect(model.requests.some((r) => pruned(r) > 0)).toBe(true);
    const off = new Session(agentWith(new Scripted(SIX)), "s1");
    await send(off, "go");
    // `durationMs` is each tool's wall-clock time: it differs run to run (and under a loaded parallel gate).
    const bytes = (ms: readonly ChatMessage[]): string =>
      JSON.stringify(ms, (k, v) => (k === "durationMs" ? 0 : v));
    expect(bytes(session.messages)).toBe(bytes(off.messages));
  });

  test("the context size a client is shown is the pruned one", async () => {
    const { agent, session } = await prunedRun();
    const sent = await agent.contextUsage(session.messages);
    const unpruned = await agent.contextUsage([...session.messages]);
    expect(sent.used).toBeLessThan(unpruned.used);
  });

  test("a fresh Agent over a reloaded history recomputes the set in one batch", async () => {
    const { session } = await prunedRun();
    const model = new Scripted([say("ok")]);
    const reloaded = new Session(agentWith(model, { contextPrune: PRUNE }), "s1", {
      messages: session.messages,
    });
    await send(reloaded, "again");
    expect(model.requests.length).toBe(1);
    expect(pruned(model.requests[0])).toBeGreaterThan(0);
  });
});

/**
 * The replacements reuse the array, so a set that is NOT dropped survives. A
 * fresh-object replacement hides that (`PruneEntry.original` skips stale
 * entries), so each case puts the OLD objects back in place afterwards — a
 * replacement that carries messages over — and asks what would be sent: with
 * the set dropped, the unpruned size.
 */
describe("in-place replacements drop the prune set explicitly", () => {
  async function expectDropped(agent: Agent, messages: ChatMessage[], old: ChatMessage[]) {
    messages.length = 0;
    messages.push(...old);
    const after = await agent.contextUsage(messages);
    const unpruned = await agent.contextUsage([...old]);
    expect(after.used).toBe(unpruned.used);
  }

  test("/clear", async () => {
    const { agent, session } = await prunedRun();
    const old = [...session.messages];
    expect((await agent.contextUsage(session.messages)).used).toBeLessThan(
      (await agent.contextUsage([...old])).used,
    );
    session.clearConversation();
    await expectDropped(agent, session.messages, old);
  });

  test("/compact", async () => {
    const model = new Scripted([...SIX, say("SUMMARY")]);
    const agent = agentWith(model, { contextPrune: PRUNE });
    const session = new Session(agent, "s1");
    await send(session, "go");
    const old = [...session.messages];
    expect((await agent.contextUsage(session.messages)).used).toBeLessThan(
      (await agent.contextUsage([...old])).used,
    );
    await session.compact();
    await expectDropped(agent, session.messages, old);
  });

  test("context_reset", async () => {
    const reset: StreamEvent[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "r1",
          name: CONTEXT_RESET_TOOL_NAME,
          arguments: JSON.stringify({ prompt: "next" }),
        },
      },
      { type: "done" },
    ];
    const script = [...SIX.slice(0, 6), reset, say("on")];
    const model = new Scripted(script);
    const agent = agentWith(model, {
      contextPrune: PRUNE,
      requestPermission: async () => ({ allowed: true }),
      contextReset: {
        maxPerMessage: -1,
        refresh: async () => ({ systemPrompt: "FRESH", skills: {} }),
      },
    });
    const session = new Session(agent, "s1");
    let old: ChatMessage[] = [];
    for await (const e of session.send("go")) {
      if (e.type === "tool_start" && e.name === CONTEXT_RESET_TOOL_NAME) {
        old = [...session.messages];
      }
    }
    expect(pruned(model.requests[5])).toBeGreaterThan(0);
    expect(session.messages[0]?.content).toBe("FRESH");
    await expectDropped(agent, session.messages, old);
  });
});
