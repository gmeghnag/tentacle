import { describe, expect, test } from "bun:test";
import { AnswerSplit, render } from "../src/index.ts";

describe("render", () => {
  test("text passes the delta through unchanged", () => {
    expect(render({ type: "text", delta: "hello" })).toBe("hello");
  });

  test("a hook's context_note is shown; the loop's own notes are not", () => {
    const text = "[hook turn_start] branch is main";
    expect(render({ type: "context_note", text, reason: "hook" })).toBe(`\n${text}\n`);
    expect(render({ type: "context_note", text: "x", reason: "continue" })).toBe("");
  });

  test("history_repaired prints the shared notice line (docs/feat/history-validity-invariant.md)", () => {
    expect(
      render({
        type: "history_repaired",
        invalidArguments: 1,
        unansweredCalls: 0,
        orphanResults: 0,
      }),
    ).toBe(
      "\nhistory repaired for the model: 1 tool call with invalid arguments — the saved session is unchanged\n",
    );
  });

  test("reasoning is hidden by default", () => {
    expect(render({ type: "reasoning", delta: "thinking" })).toBe("");
  });

  test("tool_start shows the tool and arguments", () => {
    expect(
      render({ type: "tool_start", id: "1", name: "shell", arguments: '{"command":"ls"}' }),
    ).toBe('\n[tool] shell {"command":"ls"}\n');
  });

  test("tool_result marks ok vs error and shows the first line", () => {
    expect(
      render({ type: "tool_result", id: "1", name: "shell", result: { content: "exit=0\nmore" } }),
    ).toBe("[result:ok] exit=0\n");
    expect(
      render({
        type: "tool_result",
        id: "1",
        name: "shell",
        result: { content: "boom", isError: true },
      }),
    ).toBe("[result:error] boom\n");
  });

  test("a hook block shows the hook line and its reason only; a modify adds a line (H1)", () => {
    expect(
      render({
        type: "tool_result",
        id: "1",
        name: "shell",
        result: {
          content: "Blocked by a hook: `shell` was not run. Reason: nope",
          isError: true,
          hook: { action: "blocked", name: "no-rm", reason: "nope" },
        },
      }),
    ).toBe("[hook] no-rm blocked Bash\nnope\n");
    expect(
      render({
        type: "tool_result",
        id: "1",
        name: "shell",
        result: { content: "ok", hook: { action: "modified", name: "fmt" } },
      }),
    ).toBe("[hook] fmt modified Bash input\n[result:ok] ok\n");
  });

  test("a context reset prints the separator, not the new history", () => {
    expect(
      render({ type: "context_reset", messages: [{ role: "user", content: "restart" }] }),
    ).toBe("\n↻ context reset by the model\n");
  });

  test("turn_end reports non-normal stops", () => {
    expect(render({ type: "turn_end", reason: "end_turn" })).toBe("\n");
    expect(render({ type: "turn_end", reason: "max_iterations" })).toBe(
      "\n[stopped: max_iterations]\n",
    );
  });
});

// docs/fix/cli-output-streams.md D5: the answer on stdout, the trace on stderr.
describe("AnswerSplit", () => {
  const run = (events: Parameters<AnswerSplit["push"]>[0][]) => {
    const split = new AnswerSplit();
    let out = "";
    let err = "";
    for (const event of events) {
      const chunk = split.push(event);
      out += chunk.out;
      err += chunk.err;
    }
    return { out, err, split };
  };

  test("text is the answer (stdout); every other visible event is the trace (stderr)", () => {
    // Mutation: send `tool_start`/`usage` to `out` → stdout carries the trace.
    const { out, err } = run([
      { type: "text", delta: "Let me look." },
      { type: "tool_start", id: "1", name: "shell", arguments: "{}" },
      { type: "tool_result", id: "1", name: "shell", result: { content: "ok" } },
      { type: "usage", usage: { promptTokens: 1, completionTokens: 2 } },
      { type: "subagent_start", id: "s1", agentType: "explore", description: "d" },
      { type: "text", delta: "It is 42." },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(out).toBe("Let me look.\nIt is 42.\n");
    expect(err).toContain("[tool] shell {}");
    expect(err).toContain("[result:ok] ok");
    expect(err).not.toContain("tokens");
    expect(err).toContain("└─ explore: d");
    expect(err).not.toContain("42");
  });

  test("an answer-less run writes nothing to stdout; a stop is said on stderr", () => {
    expect(run([{ type: "turn_end", reason: "end_turn" }]).out).toBe("");
    const stopped = run([
      { type: "text", delta: "partial" },
      { type: "turn_end", reason: "max_iterations" },
    ]);
    expect(stopped.out).toBe("partial\n");
    expect(stopped.err).toBe("[stopped: max_iterations]\n");
  });

  test("answer parts with no trace between them are never split", () => {
    expect(
      run([
        { type: "text", delta: "a" },
        { type: "reasoning", delta: "hidden" },
        { type: "text", delta: "b" },
        { type: "turn_end", reason: "end_turn" },
      ]).out,
    ).toBe("ab\n");
  });

  test("an error goes on its own screen line: after a mid-line answer, and none at a line start", () => {
    const mid = new AnswerSplit(true);
    mid.push({ type: "text", delta: "Hello wor" });
    expect(mid.error("boom")).toBe("\n[error] boom\n");
    expect(new AnswerSplit().error("boom")).toBe("[error] boom\n");
  });

  test("stdout redirected: stderr has no leading or trailing blank line, stdout is the exact answer", () => {
    // Mutation: keep render()'s leading "\n" (no per-stream cursor) → red.
    const { out, err } = run([
      { type: "text", delta: "ciao" },
      { type: "tool_start", id: "1", name: "shell", arguments: "{}" },
      { type: "tool_result", id: "1", name: "shell", result: { content: "ok" } },
      { type: "usage", usage: { promptTokens: 8518, completionTokens: 15 } },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(out).toBe("ciao\n");
    expect(err).toBe("[tool] shell {}\n[result:ok] ok\n");
    const first = run([
      { type: "tool_start", id: "1", name: "shell", arguments: "{}" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(first.err).toBe("[tool] shell {}\n");
  });

  test("one terminal: a trace never glues to a mid-line answer, and no blank line at a line start", () => {
    const screen = (events: Parameters<AnswerSplit["push"]>[0][]) => {
      const split = new AnswerSplit(true);
      let text = "";
      for (const event of events) {
        const c = split.push(event);
        text += c.out + c.err;
      }
      return text;
    };
    expect(
      screen([
        { type: "text", delta: "Let me look." },
        { type: "tool_start", id: "1", name: "shell", arguments: "{}" },
        { type: "turn_end", reason: "end_turn" },
      ]),
    ).toBe("Let me look.\n[tool] shell {}\n");
    expect(
      screen([
        { type: "text", delta: "Line.\n" },
        { type: "tool_start", id: "1", name: "shell", arguments: "{}" },
      ]),
    ).toBe("Line.\n[tool] shell {}\n");
  });
});
