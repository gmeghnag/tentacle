import { describe, expect, test } from "bun:test";
import { render } from "../src/index.ts";

describe("render", () => {
  test("text passes the delta through unchanged", () => {
    expect(render({ type: "text", delta: "hello" })).toBe("hello");
  });

  test("a hook's context_note is shown; the loop's own notes are not", () => {
    const text = "[hook turn_start] branch is main";
    expect(render({ type: "context_note", text, reason: "hook" })).toBe(`\n${text}\n`);
    expect(render({ type: "context_note", text: "x", reason: "continue" })).toBe("");
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

  test("turn_end reports non-normal stops", () => {
    expect(render({ type: "turn_end", reason: "end_turn" })).toBe("\n");
    expect(render({ type: "turn_end", reason: "max_iterations" })).toBe(
      "\n[stopped: max_iterations]\n",
    );
  });
});
