import { describe, expect, test } from "bun:test";
import { restartMessage } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import { itemLines, stripAnsi } from "../src/render-lines.ts";
import { CONTEXT_RESET_SEPARATOR, messagesToItems } from "../src/resume.ts";
import { type DisplayState, applyEvent, initialState, startTurn } from "../src/state.ts";

// docs/feat/context-reset-barrier.md (slice 2), decision 9 of
// docs/eval/context-reset.md: the old transcript stays, then a grey separator
// `↻ context reset by the model`, then the restart prompt labelled
// "restart prompt" — from the history itself, so live, a resync and
// `--resume` render it the same way.

const reset: ChatMessage[] = [
  { role: "system", content: "FRESH SYSTEM" },
  {
    role: "user",
    content: `${restartMessage("goal: ship slice 3\nplan: docs/feat/x.md")}\n\nBackground jobs still running:\n- j1: \`sleep 9\``,
  },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "k1", name: "skill", arguments: '{"name":"s"}' }],
  },
  { role: "tool", content: "skill body", toolCallId: "k1" },
];

describe("messagesToItems: a restart message", () => {
  test("becomes the separator, then the prompt alone as a restart row; the rest as usual", () => {
    expect(messagesToItems(reset)).toEqual([
      { kind: "notice", text: CONTEXT_RESET_SEPARATOR, separator: true },
      { kind: "user", text: "goal: ship slice 3\nplan: docs/feat/x.md", restart: true },
      {
        kind: "tool",
        id: "k1",
        name: "skill",
        args: '{"name":"s"}',
        status: "ok",
        resultText: "skill body",
      },
    ]);
  });

  test("a plain user message stays a plain user row", () => {
    expect(messagesToItems([{ role: "user", content: "hi" }])).toEqual([
      { kind: "user", text: "hi" },
    ]);
  });
});

describe("applyEvent(context_reset)", () => {
  test("keeps the transcript and appends the new history; the turn keeps running", () => {
    const before: DisplayState = applyEvent(
      startTurn(initialState, "go", 0),
      { type: "text", delta: "old reply" },
      0,
    );
    const after = applyEvent(before, { type: "context_reset", messages: reset }, 1);
    expect(after.items.slice(0, before.items.length)).toEqual([...before.items]);
    expect(after.items.slice(before.items.length)).toEqual(messagesToItems(reset));
    expect(after.running).toBe(true);
  });

  test("a call the new history lists with no result yet shows running, as at a resync", () => {
    const pending: ChatMessage[] = [
      { role: "user", content: restartMessage("p") },
      { role: "assistant", content: "", toolCalls: [{ id: "c9", name: "shell", arguments: "{}" }] },
    ];
    const after = applyEvent(
      startTurn(initialState, "go", 0),
      { type: "context_reset", messages: pending },
      1,
    );
    expect(after.items.at(-1)).toMatchObject({ kind: "tool", id: "c9", status: "running" });
  });
});

describe("render-lines: the separator and the restart row", () => {
  test("the separator is one full-width grey rule around its text", () => {
    const lines = itemLines(
      { kind: "notice", text: CONTEXT_RESET_SEPARATOR, separator: true },
      { expandAll: false, width: 40 },
    );
    expect(lines).toHaveLength(1);
    const plain = stripAnsi(lines[0] ?? "");
    expect(plain.startsWith(`── ${CONTEXT_RESET_SEPARATOR} ─`)).toBe(true);
    expect(plain.endsWith("─")).toBe(true);
    expect([...plain].length).toBe(40);
  });

  test("the restart row is labelled, then the prompt as a user row", () => {
    const opts = { expandAll: false, width: 40 };
    const plain = itemLines({ kind: "user", text: "goal", restart: true }, opts).map(stripAnsi);
    expect(plain[0]).toBe("restart prompt");
    expect(plain.slice(1)).toEqual(itemLines({ kind: "user", text: "goal" }, opts).map(stripAnsi));
  });
});
