import { describe, expect, spyOn, test } from "bun:test";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import * as wrapAnsiModule from "wrap-ansi";
import * as format from "../src/format.ts";
import { expandTabs } from "../src/input-view.ts";
import * as markdown from "../src/markdown.ts";
import {
  carryColor,
  itemLines,
  layoutTranscript,
  sliceLaid,
  toolTitle,
  transcriptLines,
  transcriptRows,
  warmRowsChunk,
  wrapLines,
} from "../src/render-lines.ts";
import type { DisplayItem, ToolItem } from "../src/state.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const opts = { expandAll: false };

describe("itemLines", () => {
  test("renders a user prompt with a prefix", () => {
    const lines = itemLines({ kind: "user", text: "do a thing" }, opts).map(strip);
    expect(lines[0]?.trimEnd()).toBe("› do a thing"); // the rest is the full-width pad
  });

  test("renders assistant markdown", () => {
    const lines = itemLines({ kind: "assistant", text: "hello **world**" }, opts).map(strip);
    expect(lines.join("\n")).toContain("hello");
    expect(lines.join("\n")).toContain("world");
  });

  test("skips an empty assistant item", () => {
    expect(itemLines({ kind: "assistant", text: "   " }, opts)).toEqual([]);
  });

  test("renders a tool diff with a friendly header, clean gutter and no meta noise", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "t1",
      name: "fs_write",
      args: '{"path":"a.txt"}',
      status: "ok",
      durationMs: 500,
      detail: {
        kind: "diff",
        path: "a.txt",
        patch:
          "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-old\n+new\n",
        added: 1,
        removed: 1,
      },
    };
    const text = itemLines(tool, opts).map(strip).join("\n");
    // Friendly header: action + target, not the raw JSON args.
    expect(text).toContain("Write a.txt");
    expect(text).not.toContain('{"path"');
    // Summary and coloured rows.
    expect(text).toContain("+1 -1");
    expect(text).toContain("+ new");
    expect(text).toContain("- old");
    // Unified-diff noise is stripped.
    expect(text).not.toContain("Index:");
    expect(text).not.toContain("@@");
    expect(text).not.toContain("+++");
    // Framed with a dashed rule top and bottom.
    expect(text).toContain("╌");
  });

  test("diff keeps context with line numbers and separates hunks with ⋯", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "t3",
      name: "fs_edit",
      args: '{"path":"m.ts"}',
      status: "ok",
      durationMs: 10,
      detail: {
        kind: "diff",
        path: "m.ts",
        patch: [
          "--- m.ts",
          "+++ m.ts",
          "@@ -1,2 +1,2 @@",
          " keep one",
          "-drop a",
          "+add a",
          "@@ -10,2 +10,2 @@",
          " keep two",
          "-drop b",
          "+add b",
          "",
        ].join("\n"),
        added: 2,
        removed: 2,
      },
    };
    const text = itemLines(tool, { expandAll: true, width: 60 }).map(strip);
    const joined = text.join("\n");
    // Context lines are preserved with their new-file line numbers.
    expect(joined).toContain("1   keep one");
    expect(joined).toContain("10   keep two");
    // The two hunks are separated by an ellipsis row.
    expect(text.some((l) => l.trim() === "⋯")).toBe(true);
    // Changed rows survive in full.
    expect(joined).toContain("+ add a");
    expect(joined).toContain("- drop b");
  });

  test("renders a sub-agent's nested activity tree and its report", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "t",
      name: "agent_task",
      args: '{"description":"find bug"}',
      status: "ok",
      durationMs: 5,
      resultText: "The bug is in auth.ts",
      sub: {
        agentType: "explore",
        description: "find bug",
        activities: ["Read auth.ts", "$ grep -n token"],
        toolUses: 2,
        tokens: 12_345,
        done: true,
      },
    };
    const text = itemLines(tool, { expandAll: true }).map(strip).join("\n");
    expect(text).toContain("Agent find bug"); // header
    // Own tokens: a bare number, the session total's formatter (12345 → "12k").
    expect(text).toContain("explore · 2 tool uses · 12k"); // tree head
    expect(text).toContain("Read auth.ts");
    expect(text).toContain("$ grep -n token");
    expect(text).toContain("The bug is in auth.ts"); // report after the tree
  });

  test("tool header shows a friendly action label per tool", () => {
    const base = { kind: "tool" as const, status: "ok" as const, durationMs: 1 };
    const read = itemLines({ ...base, id: "r", name: "fs_read", args: '{"path":"x.ts"}' }, opts)[0];
    const bash = itemLines(
      { ...base, id: "b", name: "shell", args: '{"command":"ls -la"}' },
      opts,
    )[0];
    expect(strip(read ?? "")).toContain("Read x.ts");
    expect(strip(bash ?? "")).toContain("Bash ls -la");
  });
});

describe("tool-body collapse", () => {
  const bigTool: ToolItem = {
    kind: "tool",
    id: "t2",
    name: "shell",
    args: "{}",
    status: "ok",
    durationMs: 100,
    resultText: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
  };

  test("collapses a long body to a preview plus a hint", () => {
    const lines = itemLines(bigTool, opts).map(strip);
    // header + 6 preview + 1 hint
    expect(lines).toHaveLength(8);
    // Preview lines are the real content, one per row (regression: chalk.map).
    // The first output line carries the corner connector.
    expect(lines[1]?.trim()).toBe("⎿ line 1");
    expect(lines[6]?.trim()).toBe("line 6");
    expect(lines.at(-1)).toContain("+14 more lines");
    expect(lines.at(-1)).toContain("ctrl+o");
  });

  test("shows the full body when expanded", () => {
    const lines = itemLines(bigTool, { expandAll: true }).map(strip);
    // header + 20 body lines
    expect(lines).toHaveLength(21);
    expect(lines.join("\n")).toContain("line 20");
  });
});

describe("transcriptLines", () => {
  test("separates items with a blank line", () => {
    const lines = transcriptLines(
      [
        { kind: "user", text: "hi" },
        { kind: "assistant", text: "yo" },
      ],
      opts,
    ).map(strip);
    expect(lines[0]?.trimEnd()).toBe("› hi");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("yo");
  });
});

describe("wrapLines", () => {
  test("folds long lines to the display width and preserves blanks", () => {
    const rows = wrapLines(["", "abcdefghijklmnopqrstuvwxyz"], 10);
    expect(rows[0]).toBe("");
    for (const row of rows.slice(1)) {
      expect(strip(row).length).toBeLessThanOrEqual(10);
    }
    expect(rows.slice(1).map(strip).join("")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  // The pre-fast-path implementation, kept as the reference.
  const reference = (lines: readonly string[], width: number): string[] =>
    lines.flatMap((line) =>
      line === ""
        ? [""]
        : carryColor(
            wrapAnsi(expandTabs(line), width, { hard: true, trim: false, wordWrap: true }).split(
              "\n",
            ),
          ),
    );

  const VARIED = [
    "",
    "plain text",
    "exactly ten",
    "exactly 10",
    "trailing spaces   ",
    "ten spaces         ",
    "\x1b[31mred\x1b[39m and \x1b[1mbold\x1b[22m",
    "\x1b[38;2;10;20;30mtruecolor, unclosed",
    "\x1b[38;2;10;20;30mtrue\x1b[39m",
    "\x1b[48;2;1;2;3m\x1b[38;2;4;5;6m 12 + bar \x1b[0m",
    "\x1b[42m  added bar line       \x1b[49m",
    "日本語のテキスト",
    "日本語のテキストです。",
    "emoji 👍🏽 and 🇮🇹 ok",
    "é decomposed (NFD)",
    "tab\there",
    "has\rcarriage",
    "two\nlogical\nlines",
    "crlf\r\nline",
    "a very long line that certainly does not fit in the narrow width at all",
    "\x1b]8;;http://x\x07link\x1b]8;;\x07 text",
  ];

  test("is identical to the reference wrap for lines that fit and lines that do not", () => {
    for (const width of [1, 5, 10, 11, 12, 20, 80]) {
      expect(wrapLines(VARIED, width)).toEqual(reference(VARIED, width));
    }
  });

  test("a line that fits is not handed to wrapAnsi; one that overflows is", () => {
    const spy = spyOn(wrapAnsiModule, "default");
    try {
      const fit = ["short", "\x1b[38;2;1;2;3mcolour\x1b[39m", "exactly 10", "日本語"];
      wrapLines(fit, 10);
      expect(spy.mock.calls.length).toBe(0);
      wrapLines(["this one is longer than ten columns"], 10);
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a fitting line that wrapAnsi would rewrite still takes the full path", () => {
    const spy = spyOn(wrapAnsiModule, "default");
    try {
      wrapLines(["two\nlines", "é", "a\r\nb"], 40);
      expect(spy.mock.calls.length).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("transcriptRows", () => {
  // A representative transcript: a prompt, markdown that word-wraps, and a tool.
  const tool: ToolItem = {
    kind: "tool",
    id: "t1",
    name: "fs_read",
    args: '{"path":"src/App.tsx"}',
    status: "ok",
    durationMs: 500,
    resultText: "line one\nline two",
  };
  const items: DisplayItem[] = [
    { kind: "user", text: "explain the layout pipeline in detail please" },
    { kind: "assistant", text: "Here is **a long** reply that should wrap at a narrow width." },
    tool,
  ];
  const width = 24;

  test("matches the un-memoised wrapLines(transcriptLines(...)) layout", () => {
    const o = { expandAll: false, width };
    expect(transcriptRows(items, o)).toEqual(wrapLines(transcriptLines(items, o), width));
  });

  test("a resize (new width) re-lays-out rather than serving a stale cache", () => {
    const narrow = transcriptRows(items, { expandAll: false, width: 20 });
    const wide = transcriptRows(items, { expandAll: false, width: 80 });
    expect(narrow).not.toEqual(wide);
    expect(wide).toEqual(wrapLines(transcriptLines(items, { expandAll: false, width: 80 }), 80));
  });

  test("re-render re-lays-out only the item whose identity changed", () => {
    const spy = spyOn(markdown, "renderMarkdown");
    try {
      const o = { expandAll: false, width };
      const settled: DisplayItem = { kind: "assistant", text: "settled reply" };
      // First paint: both assistant items are laid out (2 markdown renders).
      let turn: DisplayItem[] = [settled, { kind: "assistant", text: "streaming" }];
      transcriptRows(turn, o);
      const afterFirst = spy.mock.calls.length;
      expect(afterFirst).toBeGreaterThanOrEqual(2);

      // Re-paint with the SAME objects (an unrelated flush): nothing re-renders.
      transcriptRows(turn, o);
      expect(spy.mock.calls.length).toBe(afterFirst);

      // A streaming delta replaces only the tail item (state.ts semantics):
      // exactly one more markdown render, the settled item stays cached.
      turn = [settled, { kind: "assistant", text: "streaming more" }];
      transcriptRows(turn, o);
      expect(spy.mock.calls.length).toBe(afterFirst + 1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a Ctrl+O (expandAll) toggle re-lays-out only tool items, not user/assistant", () => {
    // Only `tool` items collapse, so only their layout depends on expandAll.
    // Keying expand into every item's cache made a toggle needlessly re-render
    // the whole transcript; non-tool items must stay cached across the flip.
    const spy = spyOn(markdown, "renderMarkdown");
    try {
      // First paint lays everything out (the assistant item renders markdown).
      transcriptRows(items, { expandAll: false, width });
      const afterFirst = spy.mock.calls.length;
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      // Flip expandAll: the user/assistant items are unaffected by expand, so
      // they must be served from cache — zero additional markdown renders.
      transcriptRows(items, { expandAll: true, width });
      expect(spy.mock.calls.length).toBe(afterFirst);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("windowed layout (layoutTranscript + sliceLaid)", () => {
  const bigTool: ToolItem = {
    kind: "tool",
    id: "w",
    name: "shell",
    args: "{}",
    status: "ok",
    durationMs: 1,
    resultText: Array.from({ length: 12 }, (_, i) => `out ${i + 1}`).join("\n"),
  };
  const items: DisplayItem[] = [
    { kind: "user", text: "a prompt long enough to wrap at a narrow width right here" },
    {
      kind: "assistant",
      text: "**bold** reply with enough words to wrap across several rows at width 20",
    },
    bigTool,
    { kind: "assistant", text: "short tail" },
  ];
  const opts = { expandAll: true, width: 20 };

  test("total equals the full transcriptRows length", () => {
    expect(layoutTranscript(items, opts).total).toBe(transcriptRows(items, opts).length);
  });

  test("sliceLaid(s,e) equals transcriptRows(...).slice(s,e) for EVERY window", () => {
    const full = transcriptRows(items, opts);
    const { laid, total } = layoutTranscript(items, opts);
    expect(total).toBe(full.length);
    expect(total).toBeGreaterThan(4); // the transcript really does span many rows
    for (let s = 0; s <= total; s++) {
      for (let e = s; e <= total; e++) {
        expect(sliceLaid(laid, s, e)).toEqual(full.slice(s, e));
      }
    }
  });

  test("an all-blank transcript yields total 0 and an empty slice", () => {
    const blank: DisplayItem[] = [{ kind: "assistant", text: "   " }];
    const { laid, total } = layoutTranscript(blank, opts);
    expect(total).toBe(0);
    expect(sliceLaid(laid, 0, 10)).toEqual([]);
  });

  test("a window clamped past the end returns only the rows that exist", () => {
    const full = transcriptRows(items, opts);
    const { laid, total } = layoutTranscript(items, opts);
    expect(sliceLaid(laid, total - 2, total + 50)).toEqual(full.slice(total - 2));
  });
});

describe("two layout slots per item (Ctrl+O both ways)", () => {
  const body = Array.from({ length: 20 }, (_, i) => `result line ${i}`).join("\n");
  const mkTool = (id: string): ToolItem => ({
    kind: "tool",
    id,
    name: "shell",
    args: '{"command":"ls"}',
    status: "ok",
    durationMs: 500,
    resultText: body,
  });
  // `toolLines` calls formatDurationMs once per (re)layout of a finished tool.
  test("a second toggle in either direction lays nothing out again", () => {
    const items: DisplayItem[] = [mkTool("a"), mkTool("b")];
    const spy = spyOn(format, "formatDurationMs");
    try {
      const c = (expandAll: boolean) => layoutTranscript(items, { expandAll, width: 40 });
      const collapsed = c(false);
      const expanded = c(true);
      expect(spy.mock.calls.length).toBe(4); // 2 items × 2 views
      expect(expanded.total).toBeGreaterThan(collapsed.total);
      // Flip back and forth: all hits, same rows.
      expect(c(false).total).toBe(collapsed.total);
      expect(c(true).total).toBe(expanded.total);
      expect(c(false).laid[0]?.rows === collapsed.laid[0]?.rows).toBe(true); // same array
      expect(spy.mock.calls.length).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  test("a width change invalidates both slots", () => {
    const items: DisplayItem[] = [mkTool("w")];
    const spy = spyOn(format, "formatDurationMs");
    try {
      layoutTranscript(items, { expandAll: false, width: 40 });
      layoutTranscript(items, { expandAll: true, width: 40 });
      expect(spy.mock.calls.length).toBe(2);
      layoutTranscript(items, { expandAll: true, width: 30 }); // new width
      expect(spy.mock.calls.length).toBe(3);
      layoutTranscript(items, { expandAll: false, width: 30 }); // old collapsed slot is gone
      expect(spy.mock.calls.length).toBe(4);
      layoutTranscript(items, { expandAll: true, width: 30 });
      layoutTranscript(items, { expandAll: false, width: 30 });
      expect(spy.mock.calls.length).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  test("a changed threshold re-lays-out the collapsed view; rows stay correct", () => {
    const items: DisplayItem[] = [mkTool("t")];
    const a = layoutTranscript(items, { expandAll: false, width: 40, collapseThreshold: 8 });
    const b = layoutTranscript(items, { expandAll: false, width: 40, collapseThreshold: 50 });
    expect(b.total).toBeGreaterThan(a.total); // 20 lines now fit under the threshold
    const expected = wrapLines(
      itemLines(mkTool("t"), { expandAll: false, collapseThreshold: 50 }),
      40,
    );
    expect(b.laid[0]?.rows).toEqual(expected);
  });
});

describe("warmRowsChunk (non-blocking resize warm)", () => {
  // Fresh item identities → cache is cold regardless of width.
  const items: DisplayItem[] = Array.from({ length: 6 }, (_, i) => ({
    kind: "assistant" as const,
    text: `reply ${i} with **enough** words to wrap at a narrow width right here`,
  }));

  test("processes a bounded prefix within the budget and returns a resume index", () => {
    const next = warmRowsChunk(items, { expandAll: true, width: 24 }, 0, 0);
    // Budget 0 still makes progress (≥1 item) but does not do the whole lot.
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(items.length);
  });

  test("iterating to completion warms the transcript so the commit render is a no-op", () => {
    const o = { expandAll: true, width: 29 };
    let idx = 0;
    let guard = 0;
    while (idx < items.length && guard++ < 1000) {
      idx = warmRowsChunk(items, o, idx, 0);
    }
    expect(idx).toBe(items.length);
    // After warming, laying out at that width must do zero markdown renders —
    // i.e. the size-commit render pays ~nothing (no synchronous re-wrap freeze).
    const spy = spyOn(markdown, "renderMarkdown");
    try {
      layoutTranscript(items, o);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("toolTitle labels", () => {
  const tool = (name: string, args: string): ToolItem => ({
    kind: "tool",
    id: "t",
    name,
    args,
    status: "ok",
  });

  test("fs_multi_edit shows MultiEdit + path + edit count", () => {
    const item = tool("fs_multi_edit", '{"path":"a.ts","edits":[{},{}]}');
    expect(toolTitle(item)).toEqual({ label: "MultiEdit", subtitle: "a.ts · 2 edits" });
    expect(itemLines(item, opts).map(strip).join("\n")).toContain("MultiEdit a.ts · 2 edits");
  });

  test("fs_multi_edit with one edit uses the singular", () => {
    expect(toolTitle(tool("fs_multi_edit", '{"path":"a.ts","edits":[{}]}')).subtitle).toBe(
      "a.ts · 1 edit",
    );
  });

  test("fs_multi_edit with malformed args falls back to path alone, or empty", () => {
    expect(toolTitle(tool("fs_multi_edit", '{"path":"a.ts","edits":"x"}'))).toEqual({
      label: "MultiEdit",
      subtitle: "a.ts",
    });
    expect(toolTitle(tool("fs_multi_edit", "not json"))).toEqual({
      label: "MultiEdit",
      subtitle: "",
    });
  });

  test("shell_output / shell_kill show their label + job id", () => {
    expect(toolTitle(tool("shell_output", '{"job_id":"j1"}'))).toEqual({
      label: "BashOutput",
      subtitle: "j1",
    });
    expect(toolTitle(tool("shell_kill", '{"job_id":"j2"}'))).toEqual({
      label: "BashKill",
      subtitle: "j2",
    });
  });

  test("an unlabelled (MCP) tool keeps its name and raw args", () => {
    expect(toolTitle(tool("mcp__x__y", '{"q":1}'))).toEqual({
      label: "mcp__x__y",
      subtitle: '{"q":1}',
    });
  });
});

describe("hook annotation (H1)", () => {
  const blocked = (reason?: string): ToolItem => ({
    kind: "tool",
    id: "h1",
    name: "shell",
    args: JSON.stringify({ command: "rm -rf build" }),
    status: "error",
    resultText: `Blocked by a hook: \`shell\` was not run. Reason: ${reason ?? ""}`,
    durationMs: 1,
    hook: { action: "blocked", name: "no-rm", ...(reason !== undefined ? { reason } : {}) },
  });

  test("blocked with a reason: the ⎿ hook line, then only the reason (never the model-facing text)", () => {
    const lines = itemLines(blocked("rm -rf not allowed in this repo"), opts).map(strip);
    expect(lines.slice(1).map((l) => l.trim())).toEqual([
      "⎿ hook no-rm blocked Bash",
      "rm -rf not allowed in this repo",
    ]);
    expect(lines.join("\n")).not.toContain("Blocked by a hook");
  });

  test("blocked without a reason: only the ⎿ line", () => {
    expect(
      itemLines(blocked(), opts)
        .map(strip)
        .slice(1)
        .map((l) => l.trim()),
    ).toEqual(["⎿ hook no-rm blocked Bash"]);
  });

  test("a modified fs_edit: the ⎿ hook line, then still its diff", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "h2",
      name: "fs_edit",
      args: JSON.stringify({ path: "a.ts" }),
      status: "ok",
      resultText: "edited a.ts",
      detail: {
        kind: "diff",
        path: "a.ts",
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        added: 1,
        removed: 1,
      },
      durationMs: 1,
      hook: { action: "modified", name: "fmt" },
    };
    const lines = itemLines(tool, opts).map(strip);
    expect(lines[1]?.trim()).toBe("⎿ hook fmt modified Edit input");
    expect(lines.join("\n")).toContain("new");
    expect(lines.length).toBeGreaterThan(2);
  });
});

// docs/feat/tui-spill-note.md: a spilled result shows a short note + the head/tail
// preview from the structured spill — never the model's banner, never parsed.
// (Colours — syntax on fs_read, the error colour — are pinned in read-highlight.test.ts,
// which turns chalk on for the whole file: the highlighter caches its theme on first use.)
describe("a spilled tool result", () => {
  const PATH = ".tentacle/tool-output/fs_read-c1.txt";
  const code = Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i}; // line ${i}`).join(
    "\n",
  );
  const head = code.slice(0, 600);
  const tail = code.slice(code.length - 600);
  const banner = `[large fs_read output: full output (40800 chars) saved to ${PATH} — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]`;
  const spilled = (over: Partial<ToolItem> = {}): ToolItem => ({
    kind: "tool",
    id: "s1",
    name: "fs_read",
    args: JSON.stringify({ path: "src/a.ts" }),
    status: "ok",
    durationMs: 1,
    resultText: `${banner}\n${head}\n…[39600 characters omitted]…\n${tail}`,
    spill: { chars: 40_800, path: PATH, head, tail, omitted: 39_600 },
    ...over,
  });
  const NOTE = "40.8k chars · too large, the model reads it in parts";
  const body = (tool: ToolItem, o: Parameters<typeof itemLines>[1]) =>
    itemLines(tool, o)
      .slice(1)
      .map((l) => strip(l).replace(/^(⎿ | {2})/, ""));

  test("collapsed: the note first, no banner, no path, the usual ctrl+o hint", () => {
    // Mutation (red, verified): render `resultText` instead of the spill view → fails.
    const lines = body(spilled(), opts);
    expect(lines[0]).toBe(NOTE);
    const text = lines.join("\n");
    expect(text).not.toContain("[large ");
    expect(text).not.toContain(PATH);
    expect(text).not.toContain("characters omitted");
    expect(lines.slice(1, 6)).toEqual(head.split("\n").slice(0, 5));
    expect(lines.at(-1)).toMatch(/^… \+\d+ more lines · ctrl\+o to expand$/);
  });

  test("expanded: note, saved to <path>, the head, the omitted line, the tail — in order", () => {
    const lines = body(spilled(), { expandAll: true });
    expect(lines).toEqual([
      NOTE,
      `saved to ${PATH}`,
      ...head.split("\n"),
      "… 39.6k chars omitted …",
      ...tail.split("\n"),
    ]);
  });

  test("in a pod: saved in the pod to <path>", () => {
    expect(body(spilled(), { expandAll: true, spillInPod: true })[1]).toBe(
      `saved in the pod to ${PATH}`,
    );
  });

  test("any tool that spills (shell), and the no-path note", () => {
    const { path: _p, ...noPath } = {
      chars: 40_800,
      path: PATH,
      head: "a\nb",
      tail: "y\nz",
      omitted: 39_600,
    };
    const shell = spilled({
      name: "shell",
      args: JSON.stringify({ command: "ls" }),
      spill: noPath,
    });
    expect(body(shell, { expandAll: true })).toEqual([
      "40.8k chars · too large, could not be saved — the model sees only this preview",
      "a",
      "b",
      "… 39.6k chars omitted …",
      "y",
      "z",
    ]);
  });

  test("a sub-agent whose report spilled: the tree, a blank row, then the spill view", () => {
    const sub = spilled({
      name: "agent_task",
      args: "{}",
      sub: {
        agentType: "explore",
        description: "d",
        activities: ["Read a.ts"],
        toolUses: 1,
        tokens: 0,
        done: true,
      },
      spill: { chars: 40_800, path: PATH, head: "report", tail: "end", omitted: 39_600 },
    });
    expect(body(sub, { expandAll: true })).toEqual([
      "◆ explore · 1 tool use",
      "└─ Read a.ts",
      "",
      NOTE,
      `saved to ${PATH}`,
      "report",
      "… 39.6k chars omitted …",
      "end",
    ]);
  });

  test("an older daemon (no spill field): the banner renders verbatim, nothing is derived from it", () => {
    const { spill: _s, ...older } = spilled({ name: "shell", args: "{}" });
    const lines = body(older, { expandAll: true });
    expect(lines[0]).toBe(banner);
    expect(lines).toContain("…[39600 characters omitted]…");
  });
});

describe("display cells: a tab or a wide char never makes a row overflow", () => {
  const WIDTH = 60;
  const o = { expandAll: true, width: WIDTH };
  const tool = (name: string, extra: Partial<ToolItem>): ToolItem => ({
    kind: "tool",
    id: name,
    name,
    args: "{}",
    status: "ok",
    durationMs: 1,
    ...extra,
  });
  const rowsOf = (item: DisplayItem, width = WIDTH): string[] =>
    wrapLines(itemLines(item, { ...o, width }), width).map(strip);
  const diffTool = (patch: string): ToolItem =>
    tool("fs_write", { detail: { kind: "diff", path: "p.go", added: 1, removed: 1, patch } });
  const isBar = (r: string): boolean => /^ +\d* [+-] /.test(r);

  const PATCH = [
    "@@ -1,3 +1,7 @@",
    "-\told := 1",
    "+\tnew := 1 // a",
    '+\t\t"strings"',
    "+中文中文中文",
    "+\u{1F600}\u{1F600}\u{1F600}",
    "+x\ty",
    " \tcontext\tline",
    "",
  ].join("\n");

  test("no rendered diff row contains a tab", () => {
    for (const w of [30, 60, 120]) {
      for (const r of rowsOf(diffTool(PATCH), w)) {
        expect(r).not.toContain("\t");
      }
    }
  });

  test("every bar row of one diff starts at the same column and has the same display width", () => {
    for (const w of [30, 60, 120]) {
      const bars = rowsOf(diffTool(PATCH), w).filter(isBar);
      expect(bars.length).toBe(6);
      // the +/- marker sits in the same column on every bar (a removed row has no number)
      expect(new Set(bars.map((r) => r.search(/[+-] /))).size).toBe(1);
      expect(new Set(bars.map((r) => stringWidth(r))).size).toBe(1);
      expect(stringWidth(bars[0] ?? "")).toBeLessThanOrEqual(w);
    }
  });

  test("a tab is shown as 4 spaces inside a bar", () => {
    const rows = rowsOf(diffTool("@@ -0,0 +1 @@\n+\tx\n"));
    expect(rows.some((r) => r.includes("+     x"))).toBe(true); // marker + space + 4 + x
  });

  test("a tab inside a word-diff pair keeps both bars aligned", () => {
    const rows = rowsOf(diffTool("@@ -1 +1 @@\n-\tfoo(a, b)\n+\tfoo(a, c)\n"));
    const bars = rows.filter(isBar);
    expect(bars.length).toBe(2);
    expect(new Set(bars.map((r) => stringWidth(r))).size).toBe(1);
    expect(bars.join("")).not.toContain("\t");
  });

  test("a word-diff pair with CJK and emoji renders bars of exactly width cells", () => {
    const rows = rowsOf(
      diffTool(
        "@@ -1,2 +1,2 @@\n-中文中文 foo \u{1F600}\u{1F600} end\n+中文中文 bar \u{1F600}\u{1F600} end\n",
      ),
    );
    const bars = rows.filter(isBar);
    expect(bars.length).toBe(2);
    for (const b of bars) {
      expect(stringWidth(b)).toBe(WIDTH - 1);
    }
  });

  const long = `func main() {\n\t${"word ".repeat(20)}\n}`;
  for (const [name, extra] of [
    ["fs_read", { args: '{"path":"m.txt"}', resultText: long }],
    ["shell", { args: '{"command":"cat m"}', resultText: long }],
  ] as const) {
    test(`${name} output with a long tabbed line has no tab and fits the width`, () => {
      const rows = rowsOf(tool(name, extra));
      for (const r of rows) {
        expect(r).not.toContain("\t");
        expect(stringWidth(r)).toBeLessThanOrEqual(WIDTH);
      }
    });
  }

  test("a user message with a tab has no tab and keeps its full-width row", () => {
    const rows = rowsOf({ kind: "user", text: "a\tb" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain("\t");
    expect(stringWidth(rows[0] ?? "")).toBe(WIDTH);
  });

  test("wrapLines never lets a tab through, and leaves ANSI intact", () => {
    expect(wrapLines(["a\tb", "\x1b[31mx\ty\x1b[39m"], 20)).toEqual([
      "a    b",
      "\x1b[31mx    y\x1b[39m",
    ]);
  });
});
