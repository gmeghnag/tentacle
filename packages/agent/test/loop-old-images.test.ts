/**
 * T2 of docs/feat/image-old-on-demand.md: the projection inside the loop.
 *
 * A recording model captures every `ChatRequest`; a fake `toolImages` store and
 * a registered `image_view` turn the gate on. What is pinned:
 *  (a) an image attached in turn 1 is carried by turns 1-2 and aged in turn 3;
 *  (b) every request of an aged turn sends `messages[0, turnFrom)` byte-identically;
 *  (c) a late steer that produces a second answer does not change them;
 *  (d) the STORED history (the log's copy) keeps its refs;
 *  (e) gate off (no store, `image_view` switched off, no tool) -> today's bytes.
 */
import { describe, expect, test } from "bun:test";
import { NO_CAPABILITIES } from "@tentacle/agent";
import type {
  AttachmentRef,
  AttachmentSource,
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  ToolImageStore,
} from "@tentacle/core";
import { ToolRegistry, createImageViewTool } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentConfig } from "../src/agent.ts";
import { contextResetHistory } from "../src/context-reset.ts";
import { PRUNE_MARKER } from "../src/prune.ts";
import { Session } from "../src/session.ts";

const env: ExecutionEnvironment = {
  id: "stub",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const ref: AttachmentRef = { id: "a".repeat(64), mimeType: "image/png", size: 10 };
const src: AttachmentSource = { read: async () => null };

/** The sentinel the placeholder starts with, spelled without the literal. */
const MARK = `${PRUNE_MARKER}: image`;

/** A store that holds everything (the bytes never matter here). */
const store: ToolImageStore = {
  putTool: async () => ({ refused: "not used" }),
  resolve: () => ({ kind: "none" }),
  holds: () => true,
};

/** Records every request, and answers from a script (one entry per model call). */
class Spy implements ModelProvider {
  readonly id = "spy";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    for (const e of this.script[this.turn++] ?? [
      { type: "text", delta: "end" },
      { type: "done" },
    ]) {
      yield e;
    }
  }
}

const answer = (text: string): StreamEvent[] => [{ type: "text", delta: text }, { type: "done" }];
const toolRound = (id: string): StreamEvent[] => [
  { type: "tool_call", toolCall: { id, name: "echo", arguments: '{"x":"1"}' } },
  { type: "done" },
];

const echo = {
  name: "echo",
  description: "echo",
  inputSchema: z.object({ x: z.string() }),
  permission: "none" as const,
  execute: async () => ({ content: "ok" }),
};

/** A tool whose result is bulky enough to be a prune candidate. */
const bulk = {
  name: "echo",
  description: "echo",
  inputSchema: z.object({ x: z.string() }),
  permission: "none" as const,
  execute: async () => ({
    content: `exit 0\n${Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"x".repeat(28)}`).join("\n")}`,
  }),
};

function build(script: readonly (readonly StreamEvent[])[], extra: Partial<AgentConfig> = {}) {
  const tools = new ToolRegistry();
  tools.register(echo as never);
  tools.register(createImageViewTool());
  const model = new Spy(script);
  const agent = new Agent({
    model,
    tools,
    env,
    systemPrompt: "sys",
    attachments: src,
    toolImages: store,
    ...extra,
  });
  return { agent, model, session: new Session(agent, "s-old") };
}

async function send(
  session: Session,
  text: string,
  refs?: readonly AttachmentRef[],
): Promise<void> {
  for await (const _ of session.send(
    text,
    undefined,
    refs === undefined ? {} : { attachments: refs },
  )) {
    // drain
  }
}

/** Replace the conversation in place, as `/compact` and `context_reset` do. */
function replaceHistory(session: Session, next: readonly ChatMessage[]): void {
  session.messages.length = 0;
  session.messages.push(...next);
}

/** Does this request carry the user's picture? */
function carriesRef(request: ChatRequest | undefined): boolean {
  return (request?.messages ?? []).some((m) => (m.attachments ?? []).some((a) => a.id === ref.id));
}

/** The placeholder line found in a request, if any. */
function placeholder(request: ChatRequest | undefined): string | undefined {
  for (const message of request?.messages ?? []) {
    const line = message.content.split("\n").find((l) => l.startsWith(MARK));
    if (line !== undefined) {
      return line;
    }
  }
  return undefined;
}

/** Three plain turns: the picture in the first. */
const THREE_TURNS: readonly (readonly StreamEvent[])[] = [answer("a1"), answer("a2"), answer("a3")];
/** The same, with turn 3 spending two tool rounds before answering. */
const THREE_TURNS_ROUNDS: readonly (readonly StreamEvent[])[] = [
  answer("a1"),
  answer("a2"),
  toolRound("c1"),
  toolRound("c2"),
  answer("a3"),
];

async function threeTurns(script = THREE_TURNS, extra: Partial<AgentConfig> = {}) {
  const built = build(script, extra);
  await send(built.session, "look", [ref]);
  const afterTurn1 = built.model.requests.length;
  await send(built.session, "and now?");
  const afterTurn2 = built.model.requests.length;
  // The turn's own start is where its opener lands (session.send pushes it).
  const turn3From = built.session.messages.length + 1;
  await send(built.session, "and now??");
  return { ...built, afterTurn1, afterTurn2, turn3From };
}

describe("old user images become on-demand in the request", () => {
  test("(a) turns 1-2 carry the ref; turn 3 carries the placeholder and no ref", async () => {
    const { model, afterTurn2 } = await threeTurns();
    for (let i = 0; i < afterTurn2; i++) {
      expect(carriesRef(model.requests[i])).toBe(true);
    }
    expect(model.requests.length).toBeGreaterThan(afterTurn2);
    for (let i = afterTurn2; i < model.requests.length; i++) {
      expect(carriesRef(model.requests[i])).toBe(false);
      expect(placeholder(model.requests[i])).toContain(`image_view ${ref.id.slice(0, 12)}`);
    }
  });

  test("(d) the stored history keeps its refs — the log's copy is untouched", async () => {
    const { session } = await threeTurns();
    const stored = session.messages.filter((m: ChatMessage) => (m.attachments ?? []).length > 0);
    expect(stored.length).toBe(1);
    expect(stored[0]?.attachments).toEqual([ref]);
    expect(stored[0]?.content).toBe("look");
    // …and nothing ever stores the placeholder.
    expect(session.messages.some((m) => m.content.startsWith(MARK))).toBe(false);
  });

  test("(b) every request of an aged multi-round turn sends messages[0, turnFrom) identically", async () => {
    const { model, turn3From } = await threeTurns(THREE_TURNS_ROUNDS);
    const turn3 = model.requests.slice(-3);
    expect(turn3.length).toBe(3);
    expect(turn3From).toBe(6);
    const heads = turn3.map((r) => JSON.stringify(r.messages.slice(0, turn3From)));
    expect(heads.every((h) => h === heads[0])).toBe(true);
    // It is really aged: the prefix carries the placeholder and no ref.
    expect(heads[0]).toContain(MARK);
    expect(heads[0]).not.toContain(ref.id);
  });

  test("(c) a late steer's second answer inside a turn does not age its images", async () => {
    // The sharp case: the picture's ONE answered turn is behind us, and THIS
    // turn's second answer is what makes the count reach 2 — so the set moves
    // mid-turn unless `turnFrom` is fixed for the whole turn (F1/F2).
    const built = build([answer("a1"), answer("a2"), answer("a2b")]);
    await send(built.session, "look", [ref]);
    const turnFrom = built.session.messages.length; // where turn 2's opener lands
    const before = built.model.requests.length;
    let drains = 0;
    for await (const _ of built.agent.runMessages(
      built.session.messages,
      "s-old",
      undefined,
      () => {
        drains++;
        return drains === 2 ? ["late steer"] : [];
      },
      { newFrom: turnFrom, userMessage: true },
    )) {
      // drain
    }
    const requests = built.model.requests.slice(before);
    expect(requests.length).toBe(2);
    // Both rounds of the turn still send the picture: byte-identical heads.
    for (const request of requests) {
      expect(carriesRef(request)).toBe(true);
      expect(placeholder(request)).toBeUndefined();
    }
    const heads = requests.map((r) => JSON.stringify(r.messages.slice(0, turnFrom)));
    expect(heads[0] !== undefined && heads[0] === heads[1]).toBe(true);
  });

  test("(e) gate off — no store: turn 3 still carries the ref (today's bytes)", async () => {
    const { model, afterTurn2 } = await threeTurns(THREE_TURNS, { toolImages: undefined });
    expect(model.requests.length).toBeGreaterThan(afterTurn2);
    for (const request of model.requests) {
      expect(carriesRef(request)).toBe(true);
      expect(placeholder(request)).toBeUndefined();
    }
  });

  test("(e) gate off — `image_view` switched off in caps: today's bytes", async () => {
    const built = build(THREE_TURNS);
    built.agent.setCapabilities({ ...NO_CAPABILITIES, disabledTools: ["image_view"] });
    await send(built.session, "look", [ref]);
    await send(built.session, "one");
    await send(built.session, "two");
    for (const request of built.model.requests) {
      expect(carriesRef(request)).toBe(true);
      expect(placeholder(request)).toBeUndefined();
    }
  });

  test("(e) gate off — `image_view` not registered: today's bytes", async () => {
    const tools = new ToolRegistry();
    tools.register(echo as never);
    const model = new Spy(THREE_TURNS);
    const agent = new Agent({
      model,
      tools,
      env,
      systemPrompt: "sys",
      attachments: src,
      toolImages: store,
    });
    const session = new Session(agent, "s-old");
    await send(session, "look", [ref]);
    await send(session, "one");
    await send(session, "two");
    expect(model.requests.length).toBe(3);
    for (const request of model.requests) {
      expect(carriesRef(request)).toBe(true);
    }
  });

  test("T6: after a context_reset the next request has no placeholder and no ref", async () => {
    const { session, model } = await threeTurns();
    // What `context_reset` installs: a system prompt + a restart note, NO refs.
    const next = contextResetHistory({
      systemPrompt: "sys",
      prompt: "start over",
      jobs: [],
      skills: { kept: [], dropped: [] },
    });
    replaceHistory(session, next);
    const before = model.requests.length;
    await send(session, "fresh question");
    const request = model.requests[before];
    expect(request).toBeDefined();
    expect(placeholder(request)).toBeUndefined();
    expect(carriesRef(request)).toBe(false);
  });

  test("T6: after compaction the next request has no placeholder and no ref", async () => {
    const { session, model } = await threeTurns();
    // A compaction summary: the picture became `[image: …]` TEXT (compact.ts:40-43),
    // so no ref survives to be aged.
    const next: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "summary: the user showed image/png sha256:aaaaaaaaaaaa" },
      { role: "assistant", content: "understood" },
    ];
    replaceHistory(session, next);
    const before = model.requests.length;
    await send(session, "carry on");
    const request = model.requests[before];
    expect(placeholder(request)).toBeUndefined();
    expect(carriesRef(request)).toBe(false);
  });

  test("the projection composes with prune stubs: both land, and no row is re-identified", async () => {
    // A prune batch and an aged image in the SAME request. The projection runs
    // BEFORE `applyPrune` and keys on the original rows, so a stub and a
    // placeholder coexist — and, the load-bearing bit, a prune entry still
    // matches its message (an identity-changing copy would silently drop it).
    const big = (id: string, n: number): StreamEvent[] => [
      {
        type: "tool_call",
        toolCall: { id, name: "echo", arguments: JSON.stringify({ x: String(n) }) },
      },
      { type: "done" },
    ];
    const cap = 30_000;
    const script = [answer("a1"), big("c1", 1), big("c2", 2), big("c3", 3), answer("a2")];
    const tools = new ToolRegistry();
    tools.register(bulk as never);
    tools.register(createImageViewTool());
    const model = new Spy(script);
    const agent = new Agent({
      model,
      tools,
      env,
      systemPrompt: "sys",
      maxIterations: 40,
      attachments: src,
      toolImages: store,
      contextPrune: {
        window: 3_000,
        pruneAtPercent: 20,
        minGainPercent: 10,
        keepRecentRounds: 1,
        outputChars: 1_000,
      },
    });
    const session = new Session(agent, "s-old");
    await send(session, "look", [ref]);
    await send(session, "one");
    await send(session, "two");
    const last = model.requests[model.requests.length - 1];
    expect(last).toBeDefined();
    // The aged image is a placeholder, and it is still ONE row (indices intact).
    expect(placeholder(last)).toContain("image_view");
    // The final answer is appended AFTER the last request, so the rows match then.
    expect((last?.messages ?? []).length).toBe(session.messages.length - 1);
    // Real stubs landed in the same request: the two projections compose.
    const stubs = (last?.messages ?? []).filter(
      (m) => typeof m.content === "string" && m.content.startsWith(PRUNE_MARKER),
    );
    expect(stubs.length).toBeGreaterThan(0);
    // And the stored history keeps the real output (never the stub).
    // The stored history keeps the real output; only the request carries stubs.
    const toolRows = session.messages.filter((m) => m.role === "tool");
    expect(toolRows.length).toBe(3);
    expect(toolRows.every((m) => m.content.startsWith("exit 0"))).toBe(true);
    expect(toolRows.every((m) => m.content.length > 2000)).toBe(true);
    void cap;
  });

  test("T7: a fresh Agent+Session over the stored history sends turn 3 identically", async () => {
    // Two turns, then the stored history as a resume would rebuild it.
    const first = build(THREE_TURNS);
    await send(first.session, "look", [ref]);
    await send(first.session, "and now?");
    const stored: ChatMessage[] = first.session.messages.map((m) => ({ ...m }));
    // The uninterrupted turn 3 …
    await send(first.session, "and now??");
    const uninterrupted = first.model.requests[2]; // turn 3's only request
    expect(uninterrupted).toBeDefined();
    // … and the same turn on a brand-new agent (a worker resume / rebuild).
    // Its script is already past turns 1-2, so the first call is the answer.
    const resumed = build([answer("a3")]);
    replaceHistory(resumed.session, stored);
    await send(resumed.session, "and now??");
    const rewired = resumed.model.requests[0];
    expect(rewired).toBeDefined();
    expect(JSON.stringify(rewired?.messages)).toBe(JSON.stringify(uninterrupted?.messages));
    expect(rewired?.messages.some((m) => m.content.startsWith(PRUNE_MARKER))).toBe(true);
  });
});
