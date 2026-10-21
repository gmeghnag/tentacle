import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@tentacle/agent";
import {
  type DisplayState,
  type NoticeItem,
  appendBackgroundExit,
  applyEvent,
  applySessionEvent,
  backgroundExitNotice,
  initialState,
  pushNoticeItem,
  resetHistory,
  startTurn,
} from "../src/state.ts";

function fold(state: DisplayState, events: AgentEvent[], from = 1000): DisplayState {
  let current = state;
  let now = from;
  for (const event of events) {
    current = applyEvent(current, event, now);
    now += 10;
  }
  return current;
}

describe("display state reducer", () => {
  test("startTurn appends the user message and marks running", () => {
    const s = startTurn(initialState, "hello", 1);
    expect(s.items).toEqual([{ kind: "user", text: "hello" }]);
    expect(s.running).toBe(true);
    expect(s.turnStartedAt).toBe(1);
  });

  test("attaches sub-agent progress to the matching task tool item", () => {
    const s = fold(initialState, [
      { type: "tool_start", id: "t1", name: "agent_task", arguments: '{"description":"d"}' },
      { type: "subagent_start", id: "t1", agentType: "explore", description: "find it" },
      { type: "subagent_tool", id: "t1", label: "Read a.ts" },
      { type: "subagent_tool", id: "t1", label: "Read b.ts" },
      { type: "subagent_end", id: "t1", toolUses: 2, stopReason: "end_turn" },
    ]);
    const tool = s.items.find((i) => i.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") {
      expect(tool.sub).toEqual({
        agentType: "explore",
        description: "find it",
        activities: ["Read a.ts", "Read b.ts"],
        toolUses: 2,
        done: true,
      });
    }
  });

  test("streams assistant text into a single trailing item", () => {
    let s = startTurn(initialState, "hi", 1);
    s = fold(s, [
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
    ]);
    expect(s.items).toHaveLength(2);
    expect(s.items.at(-1)).toEqual({ kind: "assistant", text: "Hello" });
  });

  test("a tool call keeps assistant text, then records the result with its diff", () => {
    let s = startTurn(initialState, "write", 1);
    s = fold(s, [
      { type: "text", delta: "Writing..." },
      { type: "tool_start", id: "t1", name: "fs_write", arguments: '{"path":"a"}' },
      {
        type: "tool_result",
        id: "t1",
        name: "fs_write",
        result: {
          content: "wrote",
          details: { kind: "diff", path: "a", patch: "@@\n+x", added: 1, removed: 0 },
        },
      },
    ]);
    const kinds = s.items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "assistant", "tool"]);
    const tool = s.items[2];
    expect(tool).toMatchObject({ kind: "tool", status: "ok", name: "fs_write" });
    if (tool?.kind === "tool") {
      expect(tool.detail?.kind).toBe("diff");
      expect(tool.endedAt).toBeDefined();
    }
  });

  test("a tool result's hook annotation is copied onto the tool item (H1)", () => {
    let s = startTurn(initialState, "go", 1);
    const hook = { action: "blocked", name: "no-rm", reason: "no" } as const;
    s = fold(s, [
      { type: "tool_start", id: "t1", name: "shell", arguments: '{"command":"rm"}' },
      {
        type: "tool_result",
        id: "t1",
        name: "shell",
        result: { content: "x", isError: true, hook },
      },
    ]);
    expect(s.items.at(-1)).toMatchObject({ kind: "tool", hook });
  });

  test("tool_result updates the matching running tool in place", () => {
    let s = startTurn(initialState, "go", 1);
    s = fold(s, [
      { type: "tool_start", id: "t1", name: "shell", arguments: "{}" },
      { type: "text", delta: "after" },
      {
        type: "tool_result",
        id: "t1",
        name: "shell",
        result: { content: "boom", isError: true },
      },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    const tool = s.items[1];
    expect(tool).toMatchObject({ kind: "tool", status: "error", resultText: "boom" });
  });

  test("accumulates token totals across usage events", () => {
    let s = startTurn(initialState, "q", 1);
    s = fold(s, [
      { type: "usage", usage: { promptTokens: 10, completionTokens: 5 } },
      { type: "usage", usage: { promptTokens: 3, completionTokens: 7 } },
    ]);
    expect(s.sessionTokens).toEqual({ prompt: 13, completion: 12 });
    expect(s.lastTurnTokens).toEqual({ prompt: 3, completion: 7 });
  });

  test("turn_end keeps the trailing assistant text and stops running", () => {
    let s = startTurn(initialState, "q", 1);
    s = fold(s, [
      { type: "text", delta: "done" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(s.running).toBe(false);
    expect(s.items.at(-1)).toEqual({ kind: "assistant", text: "done" });
    expect(s.lastStopReason).toBe("end_turn");
  });

  test("reasoning sets the flag and anchors the start time once", () => {
    let s = startTurn(initialState, "q", 1);
    s = applyEvent(s, { type: "reasoning", delta: "thinking" }, 500);
    expect(s.reasoning).toBe(true);
    expect(s.reasoningStartedAt).toBe(500);
    s = applyEvent(s, { type: "reasoning", delta: "more" }, 800);
    expect(s.reasoningStartedAt).toBe(500);
  });

  test("background_exit appends one notice and does not duplicate by jobId", () => {
    // The live JobController subscription surfaced it first…
    let s = appendBackgroundExit(
      initialState,
      backgroundExitNotice("bg-1", "python3 -m http.server", "exited", 0),
    );
    const notice = s.items.at(-1) as NoticeItem;
    expect(notice.kind).toBe("notice");
    expect(notice.jobId).toBe("bg-1");
    expect(notice.text).toContain("exited (exit=0)");

    // …then the agent's event for the same job is deduped (no second notice).
    s = applyEvent(
      s,
      { type: "background_exit", jobId: "bg-1", command: "x", status: "exited", exitCode: 0 },
      2000,
    );
    expect(s.items.filter((i) => i.kind === "notice")).toHaveLength(1);

    // A different job does add its own notice.
    s = applyEvent(
      s,
      {
        type: "background_exit",
        jobId: "bg-2",
        command: "serve",
        status: "killed",
        exitCode: null,
      },
      2100,
    );
    expect(s.items.filter((i) => i.kind === "notice")).toHaveLength(2);
    expect((s.items.at(-1) as NoticeItem).text).toContain("killed");
  });
});

describe("reconnect events (docs/feat/client-reattach.md)", () => {
  const history = [
    { role: "user" as const, content: "hi" },
    {
      role: "assistant" as const,
      content: "let me look",
      toolCalls: [{ id: "c1", name: "shell", arguments: "{}" }],
    },
  ];

  test("history_reset replaces the transcript and keeps the turn running; an unanswered call of a running turn is running", () => {
    // Mutation: drop the running-call mapping → the call awaiting approval shows "ok".
    const before = fold(startTurn(initialState, "hi", 1), [{ type: "text", delta: "let me l" }]);
    const s = applySessionEvent(before, { type: "history_reset", messages: history }, 2);
    expect(s.running).toBe(true);
    expect(s.items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "let me look" },
      { kind: "tool", id: "c1", name: "shell", args: "{}", status: "running", startedAt: 0 },
    ]);
    // Idle (no turn running): historical calls stay as `messagesToItems` shows them.
    expect(resetHistory(initialState, history).items.at(-1)).toMatchObject({ status: "ok" });
  });

  test("user_message appends the replayed prompt; other events still go through applyEvent", () => {
    let s = applySessionEvent(initialState, { type: "history_reset", messages: [] }, 1);
    s = applySessionEvent(s, { type: "user_message", text: "go" }, 2);
    s = applySessionEvent(s, { type: "text", delta: "ok" }, 3);
    expect(s.items).toEqual([
      { kind: "user", text: "go" },
      { kind: "assistant", text: "ok" },
    ]);
  });
});

describe("a command notice is never extended by model text (docs/feat/mcp-status.md F1)", () => {
  test("text after a notice starts a new assistant item; the notice is untouched", () => {
    let s = fold(startTurn(initialState, "q", 1), [{ type: "text", delta: "part one " }]);
    s = pushNoticeItem(s, "**MCP servers** — 1 of 1 reachable");
    s = fold(s, [{ type: "text", delta: "part two" }]);
    expect(s.items.slice(1)).toEqual([
      { kind: "assistant", text: "part one " },
      { kind: "assistant", text: "**MCP servers** — 1 of 1 reachable", notice: true },
      { kind: "assistant", text: "part two" },
    ]);
  });

  test("a notice pushed while idle is not the start of the next reply", () => {
    let s = pushNoticeItem(initialState, "Model: `m`");
    s = fold(s, [{ type: "text", delta: "reply" }]);
    expect(s.items).toEqual([
      { kind: "assistant", text: "Model: `m`", notice: true },
      { kind: "assistant", text: "reply" },
    ]);
  });
});
