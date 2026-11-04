import { describe, expect, test } from "bun:test";
import { itemLines } from "../src/render-lines.ts";
import { messagesToItems } from "../src/resume.ts";
import { type ToolItem, applyEvent, initialState, startTurn } from "../src/state.ts";

// docs/feat/permission-reply.md (owner Q-A): a call refused WITH a reply shows
// the structured fact `✗ Denied · <text>` — never the model-facing three lines.

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const MODEL_TEXT =
  "Permission denied by the user: `shell` was not run. The user replied:\nwhy?\ntry bun run build\nAnswer the user or change your approach; request this tool again only if you still need it.";

const refused = (over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: "c1",
  name: "shell",
  args: JSON.stringify({ command: "rm -rf build" }),
  status: "error",
  resultText: MODEL_TEXT,
  denialReply: "why?\ntry bun run build",
  ...over,
});
const body = (tool: ToolItem, expandAll = false): string[] =>
  itemLines(tool, { expandAll })
    .slice(1)
    .map((l) => strip(l).replace(/^(⎿ | {2})/, ""));

describe("the row of a call refused with a reply", () => {
  test("collapsed and expanded: `✗ Denied · <text>`, continuation indented, no model text", () => {
    // Mutation (red): render `resultText` when `denialReply` is set → fails.
    for (const expanded of [false, true]) {
      const lines = body(refused(), expanded);
      // Expanded, the full command leads on `│ ` rows (docs/feat/tui-tool-expand.md).
      const command = expanded ? ["│ rm -rf build"] : [];
      expect(lines).toEqual([...command, "✗ Denied · why?", "           try bun run build"]);
      expect(lines.join("\n")).not.toContain("Answer the user");
    }
  });

  test("a plain refusal (no reply) still shows its content", () => {
    const { denialReply: _r, ...plain } = refused({
      resultText: "Permission denied by the user: `shell` was not run.",
    });
    expect(body(plain as ToolItem)).toEqual([
      "Permission denied by the user: `shell` was not run.",
    ]);
  });

  test("live: the tool_result's denialReply lands on the row", () => {
    let s = startTurn(initialState, "go", 1);
    s = applyEvent(s, { type: "tool_start", id: "c1", name: "shell", arguments: "{}" }, 2);
    s = applyEvent(
      s,
      {
        type: "tool_result",
        id: "c1",
        name: "shell",
        result: { content: MODEL_TEXT, isError: true, denialReply: "why?" },
      },
      3,
    );
    const tool = s.items.find((i): i is ToolItem => i.kind === "tool");
    expect(tool?.denialReply).toBe("why?");
  });

  test("resume: the history's denialReply lands on the row", () => {
    const items = messagesToItems([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: "{}" }] },
      { role: "tool", content: MODEL_TEXT, toolCallId: "c1", denialReply: "why?" },
    ]);
    expect((items[0] as ToolItem).denialReply).toBe("why?");
  });
});
