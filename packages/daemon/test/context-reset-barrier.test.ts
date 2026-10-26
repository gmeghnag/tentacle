import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, Session } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import {
  DomainErrorCode,
  type HistoryCut,
  type KnownSessionUpdateParams,
  type SnapshotResult,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError } from "@tentacle/transport";
import { z } from "zod";
import { HostedSession } from "../src/hosted-session.ts";
import type { DaemonSessionState, SessionPersister } from "../src/index.ts";

// docs/feat/context-reset-barrier.md (slice 2): the daemon's MID-TURN barrier.
// The agent side (the tool, the loop intercept) is slice 3; here a fake agent
// does what slice 3's commit does — replace the history in place, then yield
// `context_reset` in the same synchronous stretch.

const env = {} as ExecutionEnvironment;

/** What the fake reset installs: `[system, restart message]`. */
const FRESH: readonly ChatMessage[] = [
  { role: "system", content: "FRESH SYSTEM" },
  { role: "user", content: "RESTART PROMPT" },
];

/**
 * Round 1 calls `reset_probe`; round 2 (on the fresh history) streams text,
 * or waits at `gate` until the turn's abort when `hold` is set.
 */
class ScriptModel implements ModelProvider {
  readonly id = "script";
  private round = 0;
  constructor(private readonly hold = false) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.round++;
    await new Promise((r) => setTimeout(r, 1));
    if (this.round === 1) {
      yield { type: "tool_call", toolCall: { id: "c1", name: "reset_probe", arguments: "{}" } };
    } else if (this.hold) {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    } else {
      yield { type: "text", delta: "after " };
      yield { type: "text", delta: "the reset" };
    }
    yield { type: "done" };
  }
}

const probe: Tool = {
  name: "reset_probe",
  description: "probe",
  inputSchema: z.object({}).passthrough(),
  permission: "none",
  execute: async () => ({ content: "reset done" }),
};

/** Fakes slice 3's commit: at the probe's commit, replace in place + `context_reset`, no await between. */
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

interface Capture {
  readonly messages: readonly ChatMessage[];
  readonly turnId: string | undefined;
}

function makeHosted(o: { readonly hold?: boolean; readonly captures?: Capture[] } = {}) {
  const agent = new ResettingAgent({
    model: new ScriptModel(o.hold === true),
    tools: new ToolRegistry().register(probe),
    env,
  });
  const session = new Session(agent, "s1", {
    messages: [{ role: "system", content: "OLD SYSTEM" }],
  });
  const captures = o.captures;
  const persister = captures
    ? ({
        schedule(_id: string, build: () => DaemonSessionState) {
          const state = build();
          captures.push({ messages: state.messages, turnId: state.turn?.turnId });
        },
        flush: () => Promise.resolve(),
      } as unknown as SessionPersister)
    : undefined;
  return new HostedSession(
    "s1",
    session,
    new PermissionBroker(),
    undefined,
    {},
    undefined,
    Date.now,
    persister ? { persister } : undefined,
  );
}

const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function idle(hosted: HostedSession): Promise<void> {
  while (hosted.running) await tick();
}

/** user/assistant text, calls and results by id: what a history and a replay can both say. */
function project(messages: readonly ChatMessage[]): string[] {
  const out: string[] = [];
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

function applyReplay(base: string[], replay: readonly KnownSessionUpdateParams[]): string[] {
  const out = [...base];
  let text = "";
  for (const { update: u } of replay) {
    if (u.type === "agent_message_chunk" && u.content.type === "text") text += u.content.text;
    if (u.type === "history_replaced") throw new Error("a replay never crosses a barrier");
  }
  if (text !== "") out.push(`assistant:${text}`);
  return out;
}

describe("context_reset: the daemon's mid-turn barrier", () => {
  test("history_replaced{context_reset} (mandatory) opens a new epoch whose cut NAMES the running turn; snapshot + replay rebuild the history", async () => {
    const hosted = makeHosted();
    const seen: KnownSessionUpdateParams[] = [];
    let atBarrier: SnapshotResult | undefined;
    let before: HistoryCut | undefined;
    hosted.attach({
      send: (p) => {
        seen.push(p);
        if (p.update.type === "tool_call") before = hosted.historyCut;
        // Re-entrant, at the barrier itself: what a resync right now would read.
        if (p.update.type === "history_replaced") atBarrier = hosted.snapshotPage();
      },
    });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);

    const barrier = seen.find((p) => p.update.type === "history_replaced");
    expect(barrier?.update).toEqual({ type: "history_replaced", reason: "context_reset" });
    expect(barrier?.mandatory).toBe(true);
    if (!barrier || !atBarrier?.since || !before) throw new Error("no barrier");
    // The exact property the client needs: the cut names the turn (not null).
    expect(atBarrier.turn).toEqual({ turnId: "t1" });
    expect(atBarrier.since.seq).toBe(barrier.seq);
    expect(atBarrier.since.epoch).not.toBe(before.epoch);
    expect(atBarrier.messages as ChatMessage[]).toEqual([...FRESH]);
    // A pre-barrier position is a resync; from the barrier's cut the rest of
    // the turn replays, contiguous, and rebuilds the daemon's final history.
    expect(hosted.replayFrom(before)).toEqual({ resync: true });
    const replay = hosted.replayFrom(atBarrier.since);
    if (!("replay" in replay)) throw new Error("the barrier's cut must replay");
    replay.replay.forEach((p, i) => expect(p.seq).toBe(barrier.seq + 1 + i));
    expect(replay.replay.map((p) => p.update.type)).toContain("agent_message_chunk");
    expect(replay.replay.at(-1)?.update).toMatchObject({ type: "turn_end", turnId: "t1" });
    const final = hosted.snapshotPage().messages as ChatMessage[];
    expect(applyReplay(project(atBarrier.messages as ChatMessage[]), replay.replay)).toEqual(
      project(final),
    );
    expect(project(final)).toEqual(["user:RESTART PROMPT", "assistant:after the reset"]);
  });

  test("the barrier writes its own capture: the fresh history, with the turn in flight", async () => {
    const captures: Capture[] = [];
    const hosted = makeHosted({ captures });
    hosted.attach({ send: () => {} });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await idle(hosted);
    // Only the barrier sees exactly `[system, restart]` mid-turn: the next
    // commit already holds the post-reset reply.
    expect(captures).toContainEqual({ messages: [...FRESH], turnId: "t1" });
  });

  test("cancelled right after a reset: the restart message is the installed head, so a send-now has nothing to answer", async () => {
    const hosted = makeHosted({ hold: true });
    let reset = false;
    hosted.attach({
      send: (p) => {
        if (p.update.type === "history_replaced") reset = true;
      },
    });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    for (let i = 0; i < 200 && !reset; i++) await tick();
    expect(reset).toBe(true);
    hosted.cancel("t1");
    await idle(hosted);
    expect(project(hosted.snapshotPage().messages as ChatMessage[])).toEqual([
      "user:RESTART PROMPT",
    ]);
    let code: number | undefined;
    try {
      hosted.sendNow("t2", { kind: "turn", turnId: "t1" }, []);
    } catch (error) {
      code = error instanceof RpcError ? error.code : -1;
    }
    expect(code).toBe(DomainErrorCode.NoTurnRunning);
    expect(hosted.running).toBe(false);
  });
});
