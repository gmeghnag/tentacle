/**
 * `stepLayout` (docs/feat/mobile-tool-rows.md, Design 2): how transcript rows
 * become a thread of steps — thoughts folded into the next tool, orphan
 * thoughts, the live "Thinking…" tail, and each node's thread segments. One
 * list cell per row stays the contract: the layout only says how a row draws.
 */
import { describe, expect, test } from "bun:test";
import { isOpen, stepA11yLabel, stepLayout, toggleOpen } from "../src/tool-steps.ts";
import type { Row, ToolRow, ToolStatus } from "../src/transcript-rows.ts";

const user = (key: string): Row => ({ kind: "user", key, text: "do it", images: [] });
const text = (key: string): Row => ({ kind: "assistant", key, text: "reply", version: 5 });
const think = (key: string, t = `thinking ${key}`): Row => ({
  kind: "reasoning",
  key,
  text: t,
  version: t.length,
});
const notice = (key: string): Row => ({ kind: "notice", key, text: "output truncated" });
const tool = (key: string, status: ToolStatus = "ok", extra: Partial<ToolRow> = {}): ToolRow => ({
  kind: "tool",
  key,
  id: key,
  name: "shell",
  label: "Bash",
  args: '{"command":"ls -la polpo-page.png"}',
  status,
  ...extra,
});

const UP_DOWN = (up: boolean, down: boolean) => ({ up, down });

describe("fold: a thought joins the NEXT tool across thought-only gaps", () => {
  test("reasoning → tool: the tool carries the thought, the reasoning cell is hidden", () => {
    const { cells } = stepLayout([user("u"), think("r1"), tool("t1")], false);
    expect(cells.get("r1")).toEqual({ kind: "hidden" });
    expect(cells.get("t1")).toMatchObject({ kind: "step", thought: "thinking r1" });
    // Rows that are not steps are absent: drawn as today.
    expect(cells.has("u")).toBe(false);
  });

  test("several reasoning rows in a row fold together, joined by a blank line", () => {
    const { cells } = stepLayout([think("r1", "a"), think("r2", "b"), tool("t1")], false);
    expect(cells.get("r1")).toEqual({ kind: "hidden" });
    expect(cells.get("r2")).toEqual({ kind: "hidden" });
    expect(cells.get("t1")).toMatchObject({ thought: "a\n\nb" });
  });

  test("NO fold across assistant text (Owner Q3): the reasoning is an orphan thought", () => {
    const { cells } = stepLayout([think("r1"), text("a1"), tool("t1")], false);
    expect(cells.get("r1")).toMatchObject({ kind: "thought", ms: undefined });
    expect(cells.get("t1")).toMatchObject({ kind: "step", thought: null });
  });

  test("no fold across a notice or a user row either", () => {
    for (const between of [notice("n"), user("u2")]) {
      const { cells } = stepLayout([think("r1"), between, tool("t1")], false);
      expect(cells.get("r1")).toMatchObject({ kind: "thought" });
      expect(cells.get("t1")).toMatchObject({ thought: null });
    }
  });

  test("in a parallel batch, only the FIRST tool gets the thought", () => {
    const { cells } = stepLayout([think("r1"), tool("t1"), tool("t2"), tool("t3")], false);
    expect(cells.get("t1")).toMatchObject({ thought: "thinking r1" });
    expect(cells.get("t2")).toMatchObject({ thought: null });
    expect(cells.get("t3")).toMatchObject({ thought: null });
  });

  test("an empty reasoning row folds to no thought (and is still hidden)", () => {
    const { cells } = stepLayout([think("r1", "  "), tool("t1")], false);
    expect(cells.get("r1")).toEqual({ kind: "hidden" });
    expect(cells.get("t1")).toMatchObject({ thought: null });
  });
});

describe("orphan: a thought with no tool to fold into (Owner Q1)", () => {
  test("a trailing thought before the final answer is a Thought node", () => {
    const { cells, tail } = stepLayout([tool("t1"), think("r1"), text("a1")], false);
    expect(cells.get("r1")).toEqual({
      kind: "thought",
      ms: undefined,
      thread: UP_DOWN(true, false),
    });
    expect(tail).toBeNull();
  });

  test("a turn that ends mid-thought (not running) leaves an orphan, not a tail", () => {
    const { cells, tail } = stepLayout([user("u"), think("r1")], false);
    expect(cells.get("r1")).toMatchObject({ kind: "thought" });
    expect(tail).toBeNull();
  });

  test("an empty orphan is hidden", () => {
    const { cells } = stepLayout([think("r1", ""), text("a1")], false);
    expect(cells.get("r1")).toEqual({ kind: "hidden" });
  });
});

describe("the live tail: the 'Thinking…' footer (Owner Q2)", () => {
  test("on: the last row is reasoning — the footer carries it, the cell is hidden", () => {
    const { cells, tail } = stepLayout([user("u"), think("r1")], true);
    expect(tail).toEqual({ thought: "thinking r1", up: false });
    expect(cells.get("r1")).toEqual({ kind: "hidden" });
  });

  test("on: the last row is a finished tool", () => {
    for (const status of ["ok", "error", "denied"] as const) {
      const { tail, cells } = stepLayout([user("u"), tool("t1", status)], true);
      expect(tail).toEqual({ thought: "", up: true });
      expect(cells.get("t1")).toMatchObject({ thread: UP_DOWN(false, true) });
    }
  });

  test("on: the user's own prompt, nothing streamed yet", () => {
    expect(stepLayout([user("u")], true).tail).toEqual({ thought: "", up: false });
  });

  test("off: streaming text", () => {
    expect(stepLayout([user("u"), think("r1"), text("a1")], true).tail).toBeNull();
  });

  test("off: a running or queued tool, even behind a finished one in its batch", () => {
    expect(stepLayout([user("u"), tool("t1", "running")], true).tail).toBeNull();
    expect(stepLayout([user("u"), tool("t1", "queued")], true).tail).toBeNull();
    expect(stepLayout([tool("t1", "running"), tool("t2", "ok")], true).tail).toBeNull();
  });

  test("off: not running", () => {
    expect(stepLayout([user("u"), tool("t1")], false).tail).toBeNull();
    expect(stepLayout([user("u")], false).tail).toBeNull();
  });

  test("tool_start replaces the footer with the tool node, its thought folded", () => {
    const before = stepLayout([user("u"), think("r1")], true);
    const after = stepLayout([user("u"), think("r1"), tool("t1", "running")], true);
    expect(before.tail).not.toBeNull();
    expect(after.tail).toBeNull();
    expect(after.cells.get("t1")).toMatchObject({ thought: "thinking r1" });
  });
});

describe("the thread: up/down per node", () => {
  test("1 node: no line at all", () => {
    const { cells } = stepLayout([user("u"), tool("t1"), text("a")], false);
    expect(cells.get("t1")).toMatchObject({ thread: UP_DOWN(false, false) });
  });

  test("2 and 3 nodes; hidden cells are transparent", () => {
    const two = stepLayout([tool("t1"), think("r"), tool("t2")], false).cells;
    expect(two.get("t1")).toMatchObject({ thread: UP_DOWN(false, true) });
    expect(two.get("t2")).toMatchObject({ thread: UP_DOWN(true, false) });
    const three = stepLayout([tool("t1"), tool("t2"), tool("t3")], false).cells;
    expect(three.get("t1")).toMatchObject({ thread: UP_DOWN(false, true) });
    expect(three.get("t2")).toMatchObject({ thread: UP_DOWN(true, true) });
    expect(three.get("t3")).toMatchObject({ thread: UP_DOWN(true, false) });
  });

  test("a notice (or text) splits a run into two threads", () => {
    const { cells } = stepLayout(
      [tool("t1"), tool("t2"), notice("n"), tool("t3"), tool("t4")],
      false,
    );
    expect(cells.get("t2")).toMatchObject({ thread: UP_DOWN(true, false) });
    expect(cells.get("t3")).toMatchObject({ thread: UP_DOWN(false, true) });
  });

  test("an orphan thought is a node on the thread", () => {
    const { cells } = stepLayout([tool("t1"), think("r"), notice("n")], false);
    expect(cells.get("t1")).toMatchObject({ thread: UP_DOWN(false, true) });
    expect(cells.get("r")).toMatchObject({ kind: "thought", thread: UP_DOWN(true, false) });
  });

  test("the tail extends the last node `down`, across hidden cells, and is `up` itself", () => {
    const { cells, tail } = stepLayout([user("u"), tool("t1"), tool("t2"), think("r")], true);
    expect(cells.get("t2")).toMatchObject({ thread: UP_DOWN(true, true) });
    expect(tail).toEqual({ thought: "thinking r", up: true });
  });

  test("the tail extends ONLY the last run: an earlier run's last node stays `down: false`", () => {
    const { cells, tail } = stepLayout([tool("a1"), tool("a2"), text("x"), tool("b")], true);
    expect(cells.get("a2")).toMatchObject({ thread: UP_DOWN(true, false) });
    expect(cells.get("b")).toMatchObject({ thread: UP_DOWN(false, true) });
    expect(tail).toEqual({ thought: "", up: true });
  });
});

describe("a resync: the same rows without reasoning", () => {
  test("gives the same steps, with no thoughts", () => {
    const live = stepLayout([user("u"), think("r1"), tool("t1"), tool("t2"), text("a")], false);
    const reloaded = stepLayout([user("u"), tool("t1"), tool("t2"), text("a")], false);
    for (const key of ["t1", "t2"]) {
      const a = live.cells.get(key);
      const b = reloaded.cells.get(key);
      expect(b?.kind).toBe("step");
      expect(b?.kind === "step" ? b.thread : null).toEqual(a?.kind === "step" ? a.thread : null);
      expect(b?.kind === "step" ? b.thought : "x").toBeNull();
    }
  });
});

describe("stepA11yLabel: one VoiceOver element per step", () => {
  test("name, subtitle, status, duration, thought", () => {
    const row = tool("t1", "ok", { durationMs: 14 });
    expect(stepA11yLabel(row, true)).toBe(
      "Bash, ls -la polpo-page.png, succeeded, 14 milliseconds, thought first",
    );
  });

  test("each status has a word; nothing unknown is invented", () => {
    const words = {
      ok: "succeeded",
      error: "failed",
      denied: "denied",
      running: "running",
      queued: "queued",
    };
    for (const [status, word] of Object.entries(words)) {
      expect(stepA11yLabel(tool("t", status as ToolStatus), false)).toBe(
        `Bash, ls -la polpo-page.png, ${word}`,
      );
    }
  });

  test("an MCP step reads its server and tool; a diff reads its counts", () => {
    const mcp = tool("t", "error", {
      name: "mcp__playwright__browser_resize",
      label: "mcp__playwright__browser_resize",
      args: '{"width":430,"height":932}',
    });
    expect(stepA11yLabel(mcp, false)).toBe("playwright browser_resize, 430 × 932, failed");
    const edit = tool("t", "ok", {
      name: "fs_edit",
      label: "Update",
      args: '{"path":"src/a.ts"}',
      diff: { added: 3, removed: 1 } as ToolRow["diff"],
    });
    expect(stepA11yLabel(edit, false)).toBe("Update, a.ts, succeeded, 3 added, 1 removed");
  });
});

describe("toggleOpen / isOpen: the screen-owned open set", () => {
  test("adds sorted, removes, never mutates", () => {
    const empty: readonly string[] = [];
    const one = toggleOpen(empty, "b");
    const two = toggleOpen(one, "a");
    expect(empty).toEqual([]);
    expect(one).toEqual(["b"]);
    expect(two).toEqual(["a", "b"]);
    expect(isOpen(two, "a")).toBe(true);
    expect(toggleOpen(two, "a")).toEqual(["b"]);
    expect(isOpen(toggleOpen(two, "a"), "a")).toBe(false);
  });
});
