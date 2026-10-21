import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import {
  MAX_SKILL_BODY_CHARS,
  SKILL_TOOL_NAME,
  ToolRegistry,
  activeSkillNames,
  createSkillActivator,
  createSkillTool,
} from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import {
  type CarriedSkill,
  type CarriedSkillSource,
  CompactError,
  MAX_KEPT_SKILL_CHARS,
  carryOverSkills,
  compactedHistory,
  summarizeConversation,
} from "../src/compact.ts";
import type { ResultTransform } from "../src/result-pipeline.ts";
import { Session } from "../src/session.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

describe("summarizeConversation", () => {
  test("sends a tool-free summary request and returns the text", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "SUMMARY" }, { type: "done" }]]);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const summary = await summarizeConversation(model, messages);
    expect(summary).toBe("SUMMARY");
    expect(model.requests[0]?.tools).toEqual([]);
  });
});

describe("compactedHistory", () => {
  test("keeps the system prompt then one summary user message", () => {
    const next = compactedHistory(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      "the gist",
    );
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ role: "system", content: "sys" });
    expect(next[1]?.role).toBe("user");
    expect(next[1]?.content).toContain("the gist");
  });
});

describe("empty-summary guard", () => {
  test("summarizeConversation rejects with CompactError when the model emits no visible text", async () => {
    // A thinking model that spends its whole budget in reasoning (or an
    // in-band error chunk the provider skips) yields only `reasoning` events.
    const model = new ScriptedProvider([
      [{ type: "reasoning", delta: "lots of thinking, no visible content" }, { type: "done" }],
    ]);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "important task" },
    ];
    await expect(summarizeConversation(model, messages)).rejects.toBeInstanceOf(CompactError);
  });

  test("Session.compact leaves the history untouched and unpersisted when the summary is empty", async () => {
    const model = new ScriptedProvider([
      [{ type: "reasoning", delta: "thinking only" }, { type: "done" }],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "SYS",
    });
    const persisted: unknown[] = [];
    const session = new Session(agent, "empty-guard", {
      onPersist: (snap) => {
        persisted.push(snap);
      },
    });
    const before = session.messages.map((m) => ({ ...m }));

    await expect(session.compact()).rejects.toBeInstanceOf(CompactError);

    // The exact property that kills the data loss: history byte-identical AND
    // nothing persisted (so no wiped 2-message state reaches disk).
    expect(session.messages).toEqual(before);
    expect(session.snapshot().messages).toEqual(before);
    expect(persisted).toHaveLength(0);
  });
});

describe("Session.compact", () => {
  test("replaces the history with the system prompt + summary", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "a dense brief" }, { type: "done" }],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "SYS",
    });
    const session = new Session(agent);
    session.messages.push({ role: "user", content: "do x" });
    session.messages.push({ role: "assistant", content: "did x" });

    const result = await session.compact();
    expect(result.before).toBe(3); // system + user + assistant
    expect(result.after).toBe(2); // system + summary
    expect(result.summary).toBe("a dense brief");
    expect(session.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(session.messages[1]?.content).toContain("a dense brief");
  });
});

describe("Session.compact cancellation", () => {
  test("a signal aborted while summarizing wins over the late summary: history untouched", async () => {
    const controller = new AbortController();
    // Ignores the signal: the summary lands AFTER the abort.
    const model: ModelProvider = {
      id: "late",
      async *stream(): AsyncIterable<StreamEvent> {
        controller.abort();
        yield { type: "text", delta: "a late brief" };
        yield { type: "done" };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "SYS",
    });
    const persisted: unknown[] = [];
    const session = new Session(agent, "abort-guard", {
      onPersist: (snap) => {
        persisted.push(snap);
      },
    });
    session.messages.push({ role: "user", content: "do x" });
    const before = session.messages.map((m) => ({ ...m }));

    await expect(session.compact(controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(session.messages).toEqual(before);
    expect(persisted).toHaveLength(0);
  });
});

describe("Session.compact cancelled before it starts", () => {
  test("no skills, signal already aborted → rejects without asking for a summary", async () => {
    const model = new ScriptedProvider([say("brief")]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "SYS",
    });
    const session = new Session(agent);
    session.messages.push({ role: "user", content: "x" });
    const ac = new AbortController();
    ac.abort();
    await expect(session.compact(ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(model.requests).toHaveLength(0);
  });
});

describe("Session.compact onReplaced (the daemon's stream barrier)", () => {
  test("runs once, synchronously after the replacement and before persist", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "brief" }, { type: "done" }]]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "SYS",
    });
    const order: string[] = [];
    const session = new Session(agent, "s", { onPersist: () => order.push("persist") });
    session.messages.push({ role: "user", content: "do x" });
    let seen: string[] = [];
    const done = session.compact(undefined, () => {
      seen = session.messages.map((m) => m.content);
      order.push("replaced");
      // Synchronous with the replacement: no microtask has run in between.
      queueMicrotask(() => order.push("microtask"));
    });
    await done;
    expect(seen).toEqual(["SYS", expect.stringContaining("brief")]);
    expect(order.slice(0, 2)).toEqual(["replaced", "persist"]);
  });

  test("is not called when the compaction fails or is aborted", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "late" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent);
    session.messages.push({ role: "user", content: "x" });
    const ac = new AbortController();
    ac.abort();
    let called = 0;
    await expect(session.compact(ac.signal, () => called++)).rejects.toBeDefined();
    expect(called).toBe(0);
  });
});

// --- skills carried over compaction (docs/feat/skills-compaction.md) ---------

/** A real `skill` tool over one or more skills; `bodies` is read per activation. */
function skillAgent(
  script: readonly (readonly StreamEvent[])[],
  read: (name: string) => Promise<string>,
  names: readonly string[] = ["deploy-app"],
  resultTransforms: readonly ResultTransform[] = [],
): { agent: Agent; model: ScriptedProvider } {
  const entries = names.map((name) => ({
    name,
    location: `/s/${name}/SKILL.md`,
    dir: `/s/${name}`,
    files: [],
    filesTruncated: false,
  }));
  const reader = async (s: { name: string }) => ({ body: await read(s.name), bodyLine: 5 });
  const tool = createSkillTool(entries, reader);
  if (!tool) {
    throw new Error("expected a skill tool");
  }
  const model = new ScriptedProvider(script);
  // As the wiring does: the tool for the model, the activator for the rest.
  const agent = new Agent({
    model,
    tools: new ToolRegistry().register(tool),
    env: noopEnv,
    systemPrompt: "SYS",
    resultTransforms,
    skills: createSkillActivator(
      entries.map((e) => ({ ...e, userInvocable: true })),
      reader,
    ),
  });
  return { agent, model };
}

const skillCall = (id: string, name = "deploy-app"): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: SKILL_TOOL_NAME, arguments: JSON.stringify({ name }) },
});
const say = (text: string): StreamEvent[] => [{ type: "text", delta: text }, { type: "done" }];

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) {
    // consume
  }
}

const carried = (
  name: string,
  id: string,
  content: string,
  source: CarriedSkillSource = "fresh",
  resultIndex = -1,
): CarriedSkill => ({
  name,
  call: { id, name: SKILL_TOOL_NAME, arguments: JSON.stringify({ name }) },
  content,
  source,
  resultIndex,
});

describe("compactedHistory with skills", () => {
  const old: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "a" },
  ];

  test("nothing to carry → exactly system + summary, as before skills existed", () => {
    const expected: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: "Summary of the earlier conversation (compacted to save context):\n\nthe gist",
      },
    ];
    expect(compactedHistory(old, "the gist")).toEqual(expected);
    expect(compactedHistory(old, "the gist", { kept: [], dropped: [] })).toEqual(expected);
  });

  test("one skill round per kept skill, in order, after the summary; they read as active", () => {
    const a = carried("a", "c1", '<skill_content name="a">\nA');
    const b = carried("b", "c2", '<skill_content name="b">\nB', "unreadable");
    const c = carried("c", "c3", '<skill_content name="c">\nC', "unavailable");
    const next = compactedHistory(old, "the gist", { kept: [a, b, c], dropped: ["z"] });
    expect(next.slice(2)).toEqual([
      { role: "assistant", content: "", toolCalls: [a.call] },
      { role: "tool", content: a.content, toolCallId: "c1" },
      { role: "assistant", content: "", toolCalls: [b.call] },
      { role: "tool", content: b.content, toolCallId: "c2" },
      { role: "assistant", content: "", toolCalls: [c.call] },
      { role: "tool", content: c.content, toolCallId: "c3" },
    ]);
    const note = next[1]?.content ?? "";
    expect(note).toContain('their instructions still apply: "a", "b", "c".');
    expect(note).toContain('SKILL.md could not be read again for "b": the earlier copy');
    expect(note).toContain('No longer in the Skills list: "c". The earlier copy');
    expect(note).toContain('Not loaded again (too much skill content to keep): "z".');
    expect(activeSkillNames(next)).toEqual(["a", "b", "c"]);
  });
});

describe("carryOverSkills (the budget)", () => {
  test("keeps the most recent skills that fit; the first that does not, and older ones, are dropped", () => {
    const s = [
      carried("old", "1", "x".repeat(10)),
      carried("mid", "2", "x".repeat(60)),
      carried("small", "3", "x".repeat(5)),
      carried("new", "4", "x".repeat(30)),
    ];
    const out = carryOverSkills(s, 40);
    expect(out.kept.map((k) => k.name)).toEqual(["small", "new"]);
    // "old" would fit, but it is older than "mid", which does not: oldest go first.
    expect(out.dropped).toEqual(["old", "mid"]);
  });

  test("all fit → all kept in activation order; exactly at the budget still fits", () => {
    const s = [carried("a", "1", "x".repeat(20)), carried("b", "2", "x".repeat(20))];
    expect(carryOverSkills(s, 40)).toEqual({ kept: s, dropped: [] });
  });

  test("the default budget holds two bodies at the skill tool's cap", () => {
    const big = "x".repeat(MAX_SKILL_BODY_CHARS);
    expect(MAX_KEPT_SKILL_CHARS).toBeGreaterThanOrEqual(2 * MAX_SKILL_BODY_CHARS);
    expect(carryOverSkills([carried("a", "1", big), carried("b", "2", big)]).dropped).toEqual([]);
  });
});

describe("summarizeConversation with kept skills", () => {
  test("a kept skill's body is left out of the transcript; a dropped one is not", async () => {
    const model = new ScriptedProvider([say("S")]);
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [carried("a", "c1", "").call] },
      { role: "tool", content: '<skill_content name="a">\nSECRET-A', toolCallId: "c1" },
      { role: "assistant", content: "", toolCalls: [carried("b", "c2", "").call] },
      { role: "tool", content: '<skill_content name="b">\nBODY-B', toolCallId: "c2" },
    ];
    await summarizeConversation(model, messages, undefined, [carried("a", "c1", "", "fresh", 2)]);
    const transcript = model.requests[0]?.messages[1]?.content ?? "";
    expect(transcript).not.toContain("SECRET-A");
    expect(transcript).toContain(
      'TOOL: [skill "a" — its instructions are re-loaded after compaction]',
    );
    expect(transcript).toContain("BODY-B");
  });
});

describe("Session.compact carries active skills over", () => {
  test("re-reads SKILL.md: the edited body is kept, the skill stays active, and is not loaded twice", async () => {
    let version = 1;
    const { agent, model } = skillAgent(
      [
        [skillCall("c1"), { type: "done" }],
        say("loaded"),
        say("user wants to deploy"), // the summary
        [skillCall("c2"), { type: "done" }],
        say("ok"),
      ],
      async () => `STEP v${version}`,
    );
    const session = new Session(agent);
    await drain(session.send("deploy to staging"));
    version = 2; // SKILL.md edited after activation

    const result = await session.compact();

    expect(result.after).toBe(4); // system, summary, the skill round
    expect(session.messages[1]?.content).toContain('their instructions still apply: "deploy-app".');
    expect(session.messages[3]?.content).toContain("STEP v2");
    expect(session.messages.some((m) => m.content.includes("STEP v1"))).toBe(false);
    expect(activeSkillNames(session.messages)).toEqual(["deploy-app"]);
    // The summariser did not get the body.
    expect(model.requests[2]?.messages[1]?.content).not.toContain("STEP v1");

    await drain(session.send("deploy again"));
    const again = session.messages.find((m) => m.role === "tool" && m.toolCallId === "c2");
    expect(again?.content).toStartWith('Skill "deploy-app" is already loaded');
  });

  test("SKILL.md unreadable at compaction → the copy from the history is kept, named as earlier copy", async () => {
    let gone = false;
    const { agent } = skillAgent(
      [[skillCall("c1"), { type: "done" }], say("loaded"), say("brief")],
      async () => {
        if (gone) {
          throw new Error("ENOENT");
        }
        return "STEP v1";
      },
    );
    const session = new Session(agent);
    await drain(session.send("deploy"));
    gone = true;

    await session.compact();

    expect(session.messages[3]?.content).toContain("STEP v1");
    expect(session.messages[1]?.content).toContain(
      'SKILL.md could not be read again for "deploy-app"',
    );
    expect(activeSkillNames(session.messages)).toEqual(["deploy-app"]);
  });

  test("the skill is no longer offered (no skill tool on resume) → the copy from the history is kept", async () => {
    const history: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "deploy" },
      { role: "assistant", content: "", toolCalls: [carried("deploy-app", "c1", "").call] },
      { role: "tool", content: '<skill_content name="deploy-app">\nOLD', toolCallId: "c1" },
    ];
    const agent = new Agent({
      model: new ScriptedProvider([say("brief")]),
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "SYS",
    });
    const session = new Session(agent, "s", { messages: history });
    await session.compact();
    // The original round, as it was.
    expect(session.messages.slice(2)).toEqual(history.slice(2));
    expect(session.messages[1]?.content).toContain('No longer in the Skills list: "deploy-app".');
  });

  test("a server reusing call ids: only the skill's own result is left out of the summary", async () => {
    // Review finding 1: the placeholder was keyed by call id, so another
    // tool's result with the same id was silently blanked too.
    const history: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "deploy" },
      { role: "assistant", content: "", toolCalls: [carried("deploy-app", "call_0", "").call] },
      { role: "tool", content: '<skill_content name="deploy-app">\nSTEP', toolCallId: "call_0" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_0", name: "shell", arguments: '{"command":"./deploy.sh"}' }],
      },
      { role: "tool", content: "DEPLOY FAILED: quota exceeded", toolCallId: "call_0" },
      { role: "assistant", content: "It failed." },
    ];
    const { agent, model } = skillAgent([say("brief")], async () => "STEP");
    const session = new Session(agent, "s", { messages: history });
    await session.compact();
    const transcript = model.requests[0]?.messages[1]?.content ?? "";
    expect(transcript).toContain("DEPLOY FAILED: quota exceeded");
    expect(transcript.match(/re-loaded after compaction/g)).toHaveLength(1);
    expect(activeSkillNames(session.messages)).toEqual(["deploy-app"]);
  });

  test("a re-read reshaped by a transform (no marker) is not fresh: the earlier copy is kept", async () => {
    // The marker-name guard: only the skill's own content counts as fresh.
    let reads = 0;
    const reshape: ResultTransform = (result, ctx) =>
      ctx.toolName === SKILL_TOOL_NAME && reads > 1
        ? { content: "[output spilled to a file — preview]" }
        : result;
    const { agent } = skillAgent(
      [[skillCall("c1"), { type: "done" }], say("loaded"), say("brief")],
      async () => {
        reads++;
        return `STEP v${reads}`;
      },
      ["deploy-app"],
      [reshape],
    );
    const session = new Session(agent);
    await drain(session.send("deploy"));
    await session.compact();
    expect(session.messages[3]?.content).toContain("STEP v1");
    expect(session.messages[1]?.content).toContain(
      'SKILL.md could not be read again for "deploy-app"',
    );
  });

  test("the skill was removed while others remain (not in the tool's list) → unavailable, nothing read", async () => {
    const history: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "deploy" },
      { role: "assistant", content: "", toolCalls: [carried("deploy-app", "c1", "").call] },
      { role: "tool", content: '<skill_content name="deploy-app">\nOLD', toolCallId: "c1" },
    ];
    const reads: string[] = [];
    const { agent } = skillAgent(
      [say("brief")],
      async (name) => {
        reads.push(name);
        return "NEW";
      },
      ["other-skill"],
    );
    const session = new Session(agent, "s", { messages: history });
    await session.compact();
    expect(reads).toEqual([]);
    expect(session.messages.slice(2)).toEqual(history.slice(2));
    expect(session.messages[1]?.content).toContain('No longer in the Skills list: "deploy-app".');
  });

  test("idempotent: compacting again keeps exactly one round per skill", async () => {
    const { agent } = skillAgent(
      [
        [skillCall("c1"), { type: "done" }],
        say("loaded"),
        say("brief 1"),
        say("more work"),
        say("brief 2"),
      ],
      async () => "STEP",
    );
    const session = new Session(agent);
    await drain(session.send("deploy"));
    await session.compact();
    await drain(session.send("next"));
    await session.compact();

    const calls = session.messages.flatMap((m) => m.toolCalls ?? []);
    expect(calls).toEqual([carried("deploy-app", "c1", "").call]);
    expect(session.messages).toHaveLength(4);
    expect(activeSkillNames(session.messages)).toEqual(["deploy-app"]);
  });

  test("a hung re-read (a stuck pod exec) does not trap a cancel: compaction rejects, history untouched", async () => {
    const controller = new AbortController();
    let reads = 0;
    const { agent, model } = skillAgent(
      [[skillCall("c1"), { type: "done" }], say("loaded"), say("brief")],
      (): Promise<string> => {
        reads++;
        if (reads === 1) {
          return Promise.resolve("STEP");
        }
        setTimeout(() => controller.abort(), 5);
        return new Promise<string>(() => {}); // never settles, ignores the signal
      },
    );
    const session = new Session(agent);
    await drain(session.send("deploy"));
    const before = session.messages.map((m) => ({ ...m }));

    // Bounded here, so a regression fails instead of hanging the runner.
    const outcome = await Promise.race([
      session.compact(controller.signal).then(
        () => "compacted",
        (e: unknown) => (e instanceof Error ? e.name : String(e)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still hung"), 500)),
    ]);

    expect(outcome).toBe("AbortError");
    expect(session.messages).toEqual(before);
    expect(model.requests).toHaveLength(2); // no summary request
  });

  test("an abort during the re-read leaves the history untouched and asks for no summary", async () => {
    const controller = new AbortController();
    let reads = 0;
    const { agent, model } = skillAgent(
      [[skillCall("c1"), { type: "done" }], say("loaded"), say("brief")],
      async () => {
        reads++;
        if (reads === 2) {
          controller.abort(); // the re-read lands after the cancel
        }
        return "STEP";
      },
    );
    const persisted: unknown[] = [];
    const session = new Session(agent, "s", { onPersist: (snap) => persisted.push(snap) });
    await drain(session.send("deploy"));
    const before = session.messages.map((m) => ({ ...m }));
    persisted.length = 0;

    await expect(session.compact(controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(session.messages).toEqual(before);
    expect(persisted).toHaveLength(0);
    expect(model.requests).toHaveLength(2); // the turn's two rounds; no summary request
  });
});
