/**
 * docs/feat/harness-notices.md S1: `/compact` reports the context size before
 * (the main agent's last real prompt tokens — the status bar's figure) and
 * after, and the new segment's persisted summary `message` entry carries it.
 */
import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, Session } from "@tentacle/agent";
import {
  COMPACTION_SUMMARY_HEAD,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  compactionOf,
} from "@tentacle/core";
import { LogMessageEntrySchema } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { HostedSession } from "../src/hosted-session.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.reject(new Error("unused")),
  readFile: () => Promise.reject(new Error("unused")),
  writeFile: () => Promise.reject(new Error("unused")),
};

const isCompacted = (r: ChatRequest) =>
  r.messages.some((m) => m.content.startsWith(COMPACTION_SUMMARY_HEAD));

/** Every call answers text with `prompts[i]` prompt tokens; counts 9000 compacted, 7777 otherwise. */
function provider(prompts: readonly number[]): ModelProvider {
  let call = 0;
  return {
    id: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      const promptTokens = prompts[call++];
      yield { type: "text", delta: "ok" };
      yield promptTokens === undefined
        ? { type: "done" }
        : { type: "done", usage: { promptTokens, completionTokens: 1 } };
    },
    countTokens: (r: ChatRequest) => Promise.resolve(isCompacted(r) ? 9000 : 7777),
  };
}

/** Adds a sub-agent's (huge) usage to every turn: it must not move the main figure. */
class SubAgentNoise extends Agent {
  override async *runMessages(
    ...args: Parameters<Agent["runMessages"]>
  ): AsyncGenerator<AgentEvent> {
    for await (const event of super.runMessages(...args)) {
      yield event;
      if (event.type === "usage") {
        yield { type: "subagent_usage", id: "sa-1", promptTokens: 999_000, completionTokens: 1 };
      }
    }
  }
}

const sessionOf = new WeakMap<HostedSession, Session>();

function makeHosted(prompts: readonly number[], AgentClass: typeof Agent = Agent): HostedSession {
  const agent = new AgentClass({
    model: provider(prompts),
    tools: new ToolRegistry(),
    env: noopEnv,
    systemPrompt: "SYS",
  });
  const session = new Session(agent, "s1");
  const hosted = new HostedSession("s1", session, new PermissionBroker());
  sessionOf.set(hosted, session);
  return hosted;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));
async function turn(hosted: HostedSession, id: string): Promise<void> {
  hosted.prompt(id, [{ type: "text", text: `go ${id}` }]);
  await tick();
  while (hosted.running) await tick();
}

describe("session/compact reports the context sizes", () => {
  test("from = the LAST main-agent prompt tokens; a sub-agent's usage does not move it", async () => {
    // turn 1: 50k, turn 2: 182k, then the summary call (no usage).
    const hosted = makeHosted([50_000, 182_000], SubAgentNoise);
    await turn(hosted, "t1");
    await turn(hosted, "t2");
    const result = await hosted.compact();
    expect(result).toMatchObject({ fromTokens: 182_000, toTokens: 9000, toExact: true });
  });

  test("no turn measured yet → from is measured on the old history", async () => {
    const hosted = makeHosted([]);
    expect(await hosted.compact()).toMatchObject({ fromTokens: 7777, toTokens: 9000 });
  });

  test("a usage without a prompt count (0) is unmeasured: from is measured, never 0 nor stale", async () => {
    // turn 1: 50k, turn 2: a provider that defaulted a missing count to 0.
    const hosted = makeHosted([50_000, 0]);
    await turn(hosted, "t1");
    await turn(hosted, "t2");
    expect(await hosted.compact()).toMatchObject({ fromTokens: 7777, toTokens: 9000 });
  });

  test("a history replacement drops the figure: re-measured, not the stale one", async () => {
    const hosted = makeHosted([182_000]);
    await turn(hosted, "t1");
    hosted.clear();
    expect(await hosted.compact()).toMatchObject({ fromTokens: 7777 });
  });

  test("a /clear (its segment is logged as `compact`) leaves no compaction summary", async () => {
    const hosted = makeHosted([182_000]);
    await turn(hosted, "t1");
    hosted.clear();
    const messages = sessionOf.get(hosted)?.messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.map(compactionOf).filter((c) => c !== null)).toEqual([]);
  });

  test("the new segment's persisted summary message carries the fact", async () => {
    const hosted = makeHosted([182_000]);
    await turn(hosted, "t1");
    await hosted.compact();
    const messages = hosted
      .logRead()
      .entries.flatMap((e) =>
        e.type === "message" ? [LogMessageEntrySchema.parse(e).message] : [],
      );
    expect(messages.at(-1)?.compacted).toEqual({
      fromTokens: 182_000,
      toTokens: 9000,
      toExact: true,
    });
  });
});
