import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { itemLines, stripAnsi } from "../src/render-lines.ts";
import { messagesToItems } from "../src/resume.ts";
import type { ToolItem } from "../src/state.ts";

describe("messagesToItems", () => {
  test("maps user/assistant messages and drops the system prompt", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    expect(messagesToItems(messages)).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "hi there" },
    ]);
  });

  test("renders a tool call and attaches its matching result", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "shell", arguments: '{"command":"ls"}' }],
      },
      { role: "tool", content: "a.txt\nb.txt", toolCallId: "c1" },
    ];
    const items = messagesToItems(messages);
    expect(items).toHaveLength(1);
    const tool = items[0] as ToolItem;
    expect(tool).toMatchObject({
      kind: "tool",
      id: "c1",
      name: "shell",
      status: "ok",
      resultText: "a.txt\nb.txt",
    });
  });

  test("an assistant with both text and a tool call yields two items", () => {
    const items = messagesToItems([
      {
        role: "assistant",
        content: "running it",
        toolCalls: [{ id: "c1", name: "shell", arguments: "{}" }],
      },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
  });

  test("a spilled tool result keeps its spill (docs/feat/tui-spill-note.md: --resume shows the note)", () => {
    // Mutation (red, verified): drop the spill spread in resume.ts → fails.
    const spill = {
      chars: 40800,
      path: ".tentacle/tool-output/x.txt",
      head: "h",
      tail: "t",
      omitted: 39600,
    };
    const items = messagesToItems([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: "{}" }] },
      { role: "tool", content: "[large shell output: …]", toolCallId: "c1", spill },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "shell", arguments: "{}" }] },
      { role: "tool", content: "small", toolCallId: "c2" },
    ]);
    expect((items[0] as ToolItem).spill).toEqual(spill);
    expect("spill" in (items[1] as ToolItem)).toBe(false);
  });

  test("a replayed tool row with no stored duration shows no time, never a fake 0.0s (docs/fix/tool-duration.md)", () => {
    // Mutation (red, verified): fall back to `durationMs: m.durationMs ?? 0` in resume.ts → `0.0s` again.
    const items = messagesToItems([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "shell", arguments: '{"command":"sleep 2"}' }],
      },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ]);
    const header = stripAnsi(
      itemLines(items[0] as ToolItem, { width: 80, expandAll: false })[0] ?? "",
    );
    expect(header).toBe("⏺ Bash sleep 2");
    expect("durationMs" in (items[0] as ToolItem)).toBe(false);
  });

  test("a replayed tool row shows the daemon-measured duration it was stored with", () => {
    // Mutation (red, verified): drop the `durationMs` copy in resume.ts → no time shown.
    const items = messagesToItems([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "shell", arguments: '{"command":"sleep 2"}' }],
      },
      { role: "tool", content: "ok", toolCallId: "c1", durationMs: 2000 },
    ]);
    expect((items[0] as ToolItem).durationMs).toBe(2000);
    const header = stripAnsi(
      itemLines(items[0] as ToolItem, { width: 80, expandAll: false })[0] ?? "",
    );
    expect(header).toBe("⏺ Bash sleep 2 2.0s");
  });

  test("an orphan tool result (truncated history) shows as a notice", () => {
    const items = messagesToItems([{ role: "tool", content: "leftover", toolCallId: "gone" }]);
    expect(items).toEqual([{ kind: "notice", text: "leftover" }]);
  });
});
