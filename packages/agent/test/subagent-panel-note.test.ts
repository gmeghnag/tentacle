/**
 * feat/subagent-panel (task 7) agent half: the parent's `[user → sa-N]` note.
 *
 * The load-bearing property (Implementation §"Load-bearing assumption"): the
 * note rides the SAME pending-exit queue the exits use — so it inherits the
 * carry-over on agent replacement (`retire`/`adoptExits`) and the flush point
 * (the turn's start, after the user's message) — but it WAKES NOBODY
 * (`pendingExitCount` counts only the non-note members). A note is not an exit:
 * it produces no `background_exit` event (the TUI already showed the live
 * notice through `subagent_message`).
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { NOTE_KIND } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent, type AgentEvent } from "../src/agent.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
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

function agentWith(script: readonly (readonly StreamEvent[])[] = []): Agent {
  const model = new ScriptedProvider(script.length > 0 ? script : [[{ type: "done" }]]);
  return new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
}

async function drain(agent: Agent, messages: ChatMessage[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.runMessages(messages, "s1")) {
    events.push(event);
  }
  return events;
}

describe("T-A1: a pending user note never wakes the agent", () => {
  test("the note is queued but `pendingExitCount` stays 0 (mutation: count every member → red)", () => {
    const agent = agentWith();
    expect(agent.pendingExitCount).toBe(0);
    agent.noteUserToSubagent("sa-1", "skip the tests folder");
    // The note IS pending (it will reach the next turn)...
    expect(agent.pendingExitCount).toBe(0);
    // ...and a real exit beside it still counts.
    agent.noteUserToSubagent("sa-2", "and the docs");
    expect(agent.pendingExitCount).toBe(0);
  });
});

describe("T-A2: the next turn reads the note, with no event", () => {
  test("history = the user's prompt, then `[user → sa-1] …`; note.kind is user_to_subagent", async () => {
    const agent = agentWith([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    agent.noteUserToSubagent("sa-1", "skip the tests folder");
    const messages: ChatMessage[] = [{ role: "user", content: "also update the README" }];
    const events = await drain(agent, messages);

    const note = messages.find((m) => m.role === "user" && m.content.includes("[user → sa-1]"));
    expect(note?.content.split("\n")[0]).toBe("[user → sa-1] skip the tests folder");
    // The owner's P7 (a): the second line says what to do with it (nothing).
    expect(note?.content.split("\n")[1]).toBe(
      "(the user wrote this directly to background sub-agent sa-1; it was delivered to it. For your information: no reply is expected.)",
    );
    // Rendered as a notice by a resume, never as a row the person typed (M3).
    expect(note?.note).toEqual({ kind: NOTE_KIND.userToSubagent, id: "sa-1" });
    // It sits right AFTER the user's message (the flush point).
    const userAt = messages.findIndex((m) => m.content === "also update the README");
    expect(messages.indexOf(note as ChatMessage)).toBe(userAt + 1);
    // NO event: the live notice came from `session/subagent_message` already.
    expect(events.some((e) => e.type === "background_exit")).toBe(false);
    expect(events.some((e) => e.type === "context_note" && e.text.includes("[user → sa-1]"))).toBe(
      false,
    );
    // It is not pending any more: a second turn does not repeat it.
    expect(agent.pendingExitCount).toBe(0);
    const again: ChatMessage[] = [...messages, { role: "user", content: "next" }];
    await drain(agent, again);
    expect(again.filter((m) => m.content.includes("[user → sa-1]"))).toHaveLength(1);
  });
});

describe("T-A3: the note survives an agent replacement", () => {
  test("retire() hands it over and adoptExits() keeps it, in order", async () => {
    const old = agentWith();
    old.noteUserToSubagent("sa-1", "first");
    old.noteUserToSubagent("sa-2", "second");
    const carried = old.retire();
    expect(carried).toHaveLength(2);
    const next = agentWith([[{ type: "done" }]]);
    next.adoptExits(carried);
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await drain(next, messages);
    const notes = messages.filter((m) => m.content.includes("[user → sa-"));
    expect(notes.map((m) => m.content.split("\n")[0])).toEqual([
      "[user → sa-1] first",
      "[user → sa-2] second",
    ]);
  });
});

describe("T-A4: two notes keep their order", () => {
  test("one message each, oldest first", async () => {
    const agent = agentWith([[{ type: "done" }]]);
    agent.noteUserToSubagent("sa-1", "one");
    agent.noteUserToSubagent("sa-1", "two");
    agent.noteUserToSubagent("sa-2", "three");
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await drain(agent, messages);
    const notes = messages.filter((m) => m.content.includes("[user → sa-"));
    expect(notes.map((m) => m.content.split("\n")[0])).toEqual([
      "[user → sa-1] one",
      "[user → sa-1] two",
      "[user → sa-2] three",
    ]);
  });
});
