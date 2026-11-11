/**
 * A turn that produces NOTHING must say so (docs/fix/truncated-reply-silent.md,
 * cases 3–4). On the buggy code the owner's second message ran three empty
 * model rounds and ended `end_turn` with no user-visible event at all — the TUI
 * looked hung (`agent4.ts`: `["context_note(continue)", "turn_end"]`).
 *
 * Two facts, two notices:
 * (3) an empty reply cut by `finish_reason: "length"` is not the model's choice
 *     to say nothing: it gets its own bounded re-ask and does NOT spend the
 *     loop's stall nudges;
 * (4) a turn that still ends with nothing yields `empty_turn` before `turn_end`.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import type { AgentEvent } from "../src/index.ts";
import { Agent, Session } from "../src/index.ts";

const noopEnv = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly seen: ChatMessage[][] = [];
  private round = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request.messages.map((m) => ({ ...m })));
    for (const event of this.script[this.round++] ?? [{ type: "done" }]) {
      yield event;
    }
  }
}

const types = (events: readonly AgentEvent[]): string[] => events.map((e) => e.type);

describe("case (4): the model says nothing and the nudges run out", () => {
  test("yields `empty_turn` before `turn_end`, instead of silence", async () => {
    // A model that genuinely answers nothing, four times (a real stall).
    const model = new Scripted([
      [{ type: "done", stopReason: "stop" }],
      [{ type: "done", stopReason: "stop" }],
      [{ type: "done", stopReason: "stop" }],
      [{ type: "done", stopReason: "stop" }],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const events: AgentEvent[] = [];
    for await (const event of agent.runMessages(messages, "s1")) {
      events.push(event);
    }
    // The user sees a notice, and it comes immediately before the turn's end.
    const tail = types(events).slice(-2);
    expect(tail).toEqual(["empty_turn", "turn_end"]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    // The turn is NOT a failure: an empty reply is not an error (unchanged
    // behaviour for a small model that returns nothing).
    expect(types(events)).not.toContain("truncated_reply");
  });

  test("a turn that DID say something never gets the empty-turn notice", async () => {
    const model = new Scripted([
      [
        { type: "text", delta: "an answer" },
        { type: "done", stopReason: "stop" },
      ],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const events: AgentEvent[] = [];
    for await (const event of agent.runMessages([{ role: "user", content: "hi" }], "s1")) {
      events.push(event);
    }
    expect(types(events)).not.toContain("empty_turn");
    expect(types(events)).not.toContain("truncated_reply");
  });
});

describe("case (3): an empty reply cut by 'length'", () => {
  test("is not the model's choice: it gets the truncation re-ask, not the stall nudge", async () => {
    const model = new Scripted([
      [{ type: "done", stopReason: "length" }],
      [
        { type: "text", delta: "here it is" },
        { type: "done", stopReason: "stop" },
      ],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const events: AgentEvent[] = [];
    for await (const event of agent.runMessages(messages, "s1")) {
      events.push(event);
    }
    // The cut is announced, the reply arrives, the turn ends normally.
    expect(events.filter((e) => e.type === "truncated_reply")).toEqual([
      { type: "truncated_reply", reason: "length", retrying: true },
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual([
      "here it is",
    ]);
    // The re-ask note tells the model to RESUME, never the generic stall nudge.
    const note = model.seen[1]?.at(-1)?.content ?? "";
    expect(note).toContain("cut off at the output limit");
    expect(note).not.toBe("Continue with the task.");
  });

  test("an empty 'length' reply does NOT spend the stall nudges", async () => {
    // Two `length` empties then a real answer: with the cut counted against
    // `emptyRounds` this would be a stall and end with nothing.
    const model = new Scripted([
      [{ type: "done", stopReason: "length" }],
      [{ type: "done", stopReason: "length" }],
      [
        { type: "text", delta: "at last" },
        { type: "done", stopReason: "stop" },
      ],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const events: AgentEvent[] = [];
    for await (const event of agent.runMessages(messages, "s1")) {
      events.push(event);
    }
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual([
      "at last",
    ]);
    expect(types(events)).not.toContain("empty_turn");
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
  });

  test("a turn whose ONLY text is a cut reply keeps its text and never says empty", async () => {
    // The `Session` path the TUI uses. Owner Q1a: keep the partial text (it is
    // real work), show the notice, re-ask once; the second round is empty and
    // the turn ends with the partial answer rather than the empty-turn notice.
    const model = new Scripted([
      [
        { type: "text", delta: "la vera" },
        { type: "done", stopReason: "length" },
      ],
      [{ type: "done", stopReason: "stop" }],
      [{ type: "done", stopReason: "stop" }],
    ]);
    const session = new Session(new Agent({ model, tools: new ToolRegistry(), env: noopEnv }));
    const events: AgentEvent[] = [];
    for await (const event of session.send("hi")) {
      events.push(event);
    }
    expect(types(events)).toContain("truncated_reply");
    expect(types(events)).not.toContain("empty_turn");
    // The partial answer is the turn's assistant message, kept for the next turn.
    // (A trailing EMPTY assistant message after the nudges run out is pre-existing
    // history debt — `agent4.ts` shows it on the buggy code too — not this fix's.)
    const assistant = session.messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(assistant[0]).toBe("la vera");
  });
});
