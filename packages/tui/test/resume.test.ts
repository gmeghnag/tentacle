import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { itemLines, stripAnsi } from "../src/render-lines.ts";
import { messagesToItems } from "../src/resume.ts";
import type { ToolItem } from "../src/state.ts";
import { EXPAND_HINT } from "../src/tool-expand.ts";

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

  test("a NOTED user message becomes a notice, not a row the person typed (docs/feat/subagent-ledger-log.md)", () => {
    // RED on main: `note` does not exist, so the note renders as a user row —
    // a resume shows a message nobody typed.
    // Mutation: drop the `m.note` branch in resume.ts → `{kind: "user"}` → red.
    const items = messagesToItems([
      {
        role: "user",
        content: "[background] job sh-1 (`sleep 1`) exited with exit code 0. Read its output…",
        note: { kind: "background_exit", id: "sh-1" },
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notice",
      text: "[background] job sh-1 (`sleep 1`) exited with exit code 0. Read its output…",
      noteKind: "background_exit",
    });
    expect("body" in (items[0] as object)).toBe(false);
  });

  test("a sub-agent report's rest is the notice's body; an unknown kind is a plain notice", () => {
    // A newer build's kind must never break a resume (free string on the wire).
    const [report] = messagesToItems([
      {
        role: "user",
        content: "[background] sub-agent sa-1 (map) finished (end_turn):\nline one\nline two",
        note: { kind: "subagent_report", id: "sa-1" },
      },
    ]);
    expect(report).toMatchObject({
      kind: "notice",
      text: "[background] sub-agent sa-1 (map) finished (end_turn):",
      body: "line one\nline two",
      noteKind: "subagent_report",
    });
    const [future] = messagesToItems([
      { role: "user", content: "a newer note", note: { kind: "user_to_subagent", id: "sa-2" } },
    ]);
    expect(future).toEqual({ kind: "notice", text: "a newer note", noteKind: "user_to_subagent" });
  });

  test("the body shows only when expanded (Ctrl+O); collapsed, the notice carries the hint", () => {
    // Mutation: always draw `body` → a resume of a long report floods the
    // transcript (and Ctrl+O would change nothing) → red.
    const [item] = messagesToItems([
      {
        role: "user",
        content: "[background] sub-agent sa-1 (map) finished (end_turn):\nTHE REPORT",
        note: { kind: "subagent_report", id: "sa-1" },
      },
    ]);
    if (!item) throw new Error("no item");
    const collapsed = itemLines(item, { width: 80, expandAll: false }).map(stripAnsi);
    expect(collapsed.join("\n")).toContain(EXPAND_HINT);
    expect(collapsed.join("\n")).not.toContain("THE REPORT");
    const expanded = itemLines(item, { width: 80, expandAll: true }).map(stripAnsi);
    expect(expanded.join("\n")).toContain("THE REPORT");
    expect(expanded.join("\n")).not.toContain("to expand");
  });
});

/**
 * A resumed image prompt (docs/feat/attachments-tui.md D7, T2): the history has
 * the refs, so the row says `[image: name]` — for an image-only prompt too,
 * where the item has no text at all.
 */
describe("resumed image prompts", () => {
  const ref = (name: string, id: string) => ({
    id: id.repeat(64).slice(0, 64),
    mimeType: "image/png",
    size: 2048,
    name,
  });

  test("a user message with two refs becomes one item with two image rows", () => {
    const items = messagesToItems([
      {
        role: "user",
        content: "what are these?",
        attachments: [ref("a.png", "a"), ref("b.png", "b")],
      },
    ]);
    expect(items).toEqual([
      { kind: "user", text: "what are these?", images: ["[image: a.png]", "[image: b.png]"] },
    ]);
  });

  test("an image-only prompt is an item with no text, just its rows (P9)", () => {
    const items = messagesToItems([
      { role: "user", content: "", attachments: [ref("a.png", "a")] },
    ]);
    expect(items).toEqual([{ kind: "user", text: "", images: ["[image: a.png]"] }]);
  });

  test("a text-only message carries no images key at all", () => {
    expect(messagesToItems([{ role: "user", content: "hi" }])).toEqual([
      { kind: "user", text: "hi" },
    ]);
  });

  test("a nameless ref shows its MIME type", () => {
    const items = messagesToItems([
      {
        role: "user",
        content: "",
        attachments: [{ id: "c".repeat(64), mimeType: "image/gif", size: 5 }],
      },
    ]);
    expect(items[0]).toMatchObject({ images: ["[image: image/gif]"] });
  });
});
