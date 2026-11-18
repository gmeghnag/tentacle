/**
 * docs/fix/thought-placeholder.md: the reasoning TEXT is never stored, only a
 * placeholder (`ChatMessage.thought = { ms }`). A reasoning followed by text is
 * its own collapsed, non-expandable `Thought · 12 s` row — live and after a
 * reload alike; one followed by a tool stays folded into that step ("thought
 * first"). An old log without the field draws no Thought row, as before.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { stepA11yLabel, stepLayout, thoughtRowView } from "../src/tool-steps.ts";
import { historyRows } from "../src/transcript-history.ts";
import type { Row } from "../src/transcript-rows.ts";
import { apply, initialState } from "../src/transcript.ts";

const keys = (): (() => string) => {
  let n = 0;
  return () => {
    n += 1;
    return `h${n}`;
  };
};

const reload = (messages: readonly ChatMessage[]): readonly Row[] => historyRows(messages, keys());

const thoughtCells = (rows: readonly Row[]) => {
  const { cells } = stepLayout(rows, false);
  return rows.flatMap((r) => {
    const cell = cells.get(r.key);
    return cell?.kind === "thought" ? [{ row: r, cell }] : [];
  });
};

describe("reload: a stored thought placeholder projects a Thought row", () => {
  test("thought → text: one collapsed `Thought · 12 s` row before the answer", () => {
    const rows = reload([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", thought: { ms: 12_400 } } as ChatMessage,
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "reasoning", "assistant"]);
    const found = thoughtCells(rows);
    expect(found).toHaveLength(1);
    const cell = found[0]?.cell;
    expect(cell?.kind).toBe("thought");
    if (cell?.kind === "thought") {
      const view = thoughtRowView(cell);
      expect(`Thought ${view.subtitle}`).toBe("Thought · 12 s");
      expect(view.expandable).toBe(false);
      expect(view.a11yLabel).toBe("Thought for 12 seconds. The thinking itself is not kept.");
    }
  });

  test("thought → tool: folded into the step, which says `thought first`", () => {
    const rows = reload([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "shell", arguments: '{"command":"ls"}' }],
        thought: { ms: 3_000 },
      } as ChatMessage,
      { role: "tool", content: "a\nb", toolCallId: "c1" },
    ]);
    expect(thoughtCells(rows)).toHaveLength(0);
    const { cells } = stepLayout(rows, false);
    const tool = rows.find((r) => r.kind === "tool");
    const cell = tool === undefined ? undefined : cells.get(tool.key);
    expect(cell).toMatchObject({ kind: "step", thought: null, thoughtFirst: true });
    if (tool?.kind === "tool") {
      expect(stepA11yLabel(tool, true)).toContain("thought first");
    }
  });

  test("an old log without the field: no Thought row (as before)", () => {
    const rows = reload([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant"]);
  });
});

describe("live: the same row as the reload", () => {
  test("reasoning then text: `Thought · 12 s`, measured from the receipt times", () => {
    let s = apply(initialState, { type: "reasoning", delta: "let me think" } as never, 1_000);
    s = apply(s, { type: "reasoning", delta: " more" } as never, 5_000);
    s = apply(s, { type: "text", delta: "hello" } as never, 13_000);
    const found = thoughtCells(s.rows);
    expect(found).toHaveLength(1);
    const cell = found[0]?.cell;
    if (cell?.kind === "thought") {
      const view = thoughtRowView(cell);
      expect(`Thought ${view.subtitle}`).toBe("Thought · 12 s");
      expect(view.expandable).toBe(false);
    }
  });

  test("reasoning then a tool: folded into the step with its text (live body)", () => {
    let s = apply(initialState, { type: "reasoning", delta: "plan" } as never, 1_000);
    s = apply(s, { type: "tool_start", id: "c1", name: "shell", arguments: "{}" } as never, 2_000);
    const { cells } = stepLayout(s.rows, false);
    const tool = s.rows.find((r) => r.kind === "tool");
    expect(tool === undefined ? undefined : cells.get(tool.key)).toMatchObject({
      kind: "step",
      thought: "plan",
      thoughtFirst: true,
    });
  });
});
