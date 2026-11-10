/**
 * feat/subagent-panel (task 7): the dock's view-model (AGENTS §7 — the logic
 * lives here, pure, and the component only paints the segments). The visual
 * target is `.tentacle/tmp/subagent-panel/mockups/01..07`: glyphs, the titled
 * rule, the 5-row window, the width tiers at 100/80/56.
 */
import { describe, expect, test } from "bun:test";
import {
  LIST_MAX_ROWS,
  backgroundListView,
  dockRows,
  drawerView,
  inputTitle,
  listVisible,
  rowText,
} from "../src/background-list.ts";
import type { BackgroundAgentRow } from "../src/background-view.ts";
import { cellWidth } from "../src/cells.ts";

const row = (i: number, extra: Partial<BackgroundAgentRow> = {}): BackgroundAgentRow => ({
  id: `sa-${i}`,
  agentType: "explore",
  description: `find callers of parseConfig ${i}`,
  toolUses: 19,
  tokens: 12_400,
  startedAt: 0,
  tail: ["fs_read a.ts"],
  ...extra,
});

const view = (opts: Partial<Parameters<typeof backgroundListView>[0]> = {}) =>
  backgroundListView({
    rows: [],
    jobs: [],
    askingId: null,
    focus: { kind: "input" },
    width: 100,
    now: 72_000,
    ...opts,
  });

describe("T-L1: the width tiers, cells-cut, one line per row", () => {
  test("100 columns: id, type, description and `tools · tokens · time`", () => {
    const v = view({ rows: [row(1)], focus: { kind: "list", selected: "sa-1", armed: false } });
    const [first] = v.rows;
    expect(first).toBeDefined();
    const line = rowText(first ?? { segments: [] });
    expect(line).toContain("●");
    expect(line).toContain("sa-1 ");
    expect(line).toContain("explore ");
    expect(line).toContain("19 tools · 12k · 1m 12s");
    // The selection grammar: a `›` marker, the rest of the dock's rows unmarked.
    expect(line.startsWith("› ")).toBe(true);
    expect(cellWidth(line)).toBe(100);
  });

  test("80 columns: the token figure and the type column are dropped only below their tiers", () => {
    const at80 = rowText(view({ width: 80, rows: [row(1)] }).rows[0] ?? { segments: [] });
    expect(at80).toContain("19 tools · 1m 12s");
    expect(at80).not.toContain("12.4k");
    expect(at80).toContain("explore");
    expect(cellWidth(at80)).toBe(80);
    const at56 = rowText(view({ width: 56, rows: [row(1)] }).rows[0] ?? { segments: [] });
    expect(at56).toContain("19 tools · 1m 12s");
    // Under 60 the type column goes too.
    expect(at56).not.toContain("explore");
    expect(cellWidth(at56)).toBe(56);
  });

  test("a double-width description is cut by CELLS, never mid-glyph", () => {
    // 78 cells of description: it must NOT fit the ~47 a row leaves for it.
    const cjk =
      "設定ファイル読み込みの呼び出し元を探す設定ファイル読み込みの呼び出し元を探す設定ファイル";
    const v = view({
      width: 80,
      rows: [row(1, { description: cjk })],
      focus: { kind: "list", selected: "sa-1", armed: false },
    });
    const [first] = v.rows;
    expect(first).toBeDefined();
    const line = rowText(first ?? { segments: [] });
    expect(cellWidth(line)).toBe(80);
    expect(line).toContain("…");
    // Never a stray half of a wide character: every cell of the row adds up.
    expect(line).not.toContain("\uFFFD");
  });

  test("every row is exactly one line, at every tier, unfocused and selected", () => {
    for (const width of [100, 90, 80, 70, 60, 56, 40, 20]) {
      for (const focus of [
        { kind: "input" as const },
        { kind: "list" as const, selected: "sa-1", armed: false },
        { kind: "list" as const, selected: "sa-1", armed: true },
      ]) {
        const v = view({ width, rows: [row(1), row(2)], focus });
        for (const r of v.rows) {
          expect(rowText(r)).not.toContain("\n");
          expect(cellWidth(rowText(r))).toBeLessThanOrEqual(width);
        }
        expect(cellWidth(v.rule.map((s) => s.text).join(""))).toBeLessThanOrEqual(width);
        expect(v.rule.map((s) => s.text).join("")).not.toContain("\n");
      }
    }
  });
});

describe("T-L2: nine rows → a window of 5 that follows the selection", () => {
  const nine = Array.from({ length: 9 }, (_, i) => row(i + 1));

  test("unfocused: the first five, and the rule says how many are below", () => {
    const v = view({ rows: nine, width: 100 });
    expect(v.rows).toHaveLength(LIST_MAX_ROWS);
    expect(v.rows.map((r) => r.id)).toEqual(["sa-1", "sa-2", "sa-3", "sa-4", "sa-5"]);
    expect(v.above).toBe(0);
    expect(v.below).toBe(4);
    expect(v.hint).toContain("↓4 more");
    expect(v.hint).toContain("↓ select · ctrl+t");
  });

  test("selected on the 7th: the window follows it, `↑2 ↓2` (mockup 05)", () => {
    const v = view({
      rows: nine,
      width: 100,
      focus: { kind: "list", selected: "sa-7", armed: false },
    });
    // The selection holds the window's last row once it passes the fifth, so the
    // rows above it never jump away (mockup 05: `↑2 ↓2`, the item at the bottom).
    expect(v.rows.map((r) => r.id)).toEqual(["sa-3", "sa-4", "sa-5", "sa-6", "sa-7"]);
    expect(v.above).toBe(2);
    expect(v.below).toBe(2);
    expect(v.start).toBe(2);
    expect(v.hint).toContain("↑2 ↓2");
    expect(v.hint).toContain("enter open · x stop · esc back");
  });

  test("selected on the LAST row: the window is flush with the end", () => {
    const v = view({
      rows: nine,
      width: 100,
      focus: { kind: "list", selected: "sa-9", armed: false },
    });
    expect(v.rows.map((r) => r.id)).toEqual(["sa-5", "sa-6", "sa-7", "sa-8", "sa-9"]);
    expect(v.above).toBe(4);
    expect(v.below).toBe(0);
  });

  test("five or fewer: no window at all, no overflow arrow", () => {
    const v = view({ rows: nine.slice(0, 5), width: 100 });
    expect(v.rows).toHaveLength(5);
    expect(v.above).toBe(0);
    expect(v.below).toBe(0);
    expect(v.hint).not.toContain("more");
  });
});

describe("T-L3: the asking row, and the header hints per focus", () => {
  test("only the child on screen is marked `⚠ needs your permission`", () => {
    const v = view({ rows: [row(1), row(2), row(3)], askingId: "sa-2", width: 100 });
    const metas = v.rows.map((r) => r.meta);
    expect(metas[1]).toBe("⚠ needs your permission");
    expect(metas[0]).toBe("19 tools · 12k · 1m 12s");
    expect(metas[2]).toBe("19 tools · 12k · 1m 12s");
    // Its glyph is the waiting one, not the running one (mockup 01).
    expect(v.rows.map((r) => r.glyph)).toEqual(["running", "asking", "running"]);
  });

  test("a shell row: its own glyph and meta, and it always comes after the sub-agents", () => {
    const v = view({
      rows: [row(1)],
      jobs: [{ id: "sh-3", command: "npm run watch", startedAt: 0 }],
      now: 300_000,
      width: 100,
    });
    expect(v.rows.map((r) => r.id)).toEqual(["sa-1", "sh-3"]);
    expect(v.rows[1]?.glyph).toBe("job");
    expect(v.rows[1]?.meta).toBe("running · 5m 0s");
    expect(rowText(v.rows[1] ?? { segments: [] })).toContain("npm run watch");
  });

  test("the hints, per focus and width", () => {
    const idle = view({ rows: [row(1)], width: 100 });
    expect(idle.label).toBe("background");
    expect(idle.count).toBe(1);
    expect(idle.hint).toBe("↓ select · ctrl+t");
    expect(view({ rows: [row(1)], width: 60 }).hint).toBe("↓ · ctrl+t");
    expect(
      view({ rows: [row(1)], focus: { kind: "list", selected: "sa-1", armed: false } }).hint,
    ).toBe("enter open · x stop · esc back");
    // Armed: the confirm's own words, and the arming row says what `y` does.
    const armed = view({ rows: [row(1)], focus: { kind: "list", selected: "sa-1", armed: true } });
    expect(armed.hint).toBe("y stop · any other key cancels");
    expect(armed.rows[0]?.armed).toBe(true);
    expect(armed.rows[0]?.meta).toBe("stop sa-1? y/N");
  });
});

describe("T-L4: the drawer", () => {
  const full = row(1, {
    toolUses: 19,
    tail: ["a", "b", "c", "d", "e", "f", "g", "h"],
    description: "find callers of parseConfig",
  });

  test("head + counters, `… +k earlier` from toolUses − tail, the 8 labels", () => {
    const d = drawerView({
      row: full,
      sent: [],
      outcome: null,
      width: 100,
      now: 72_000,
    });
    expect(d.head.map((s) => s.text).join("")).toContain("sa-1");
    expect(d.head.map((s) => s.text).join("")).toContain("explore");
    expect(d.head.map((s) => s.text).join("")).toContain("find callers of parseConfig");
    expect(d.meta).toBe("running · 19 tools · 12k · 1m 12s");
    expect(d.hidden).toBe("… +11 earlier");
    expect(d.tail).toHaveLength(8);
    expect(d.tail.at(-1)).toBe("h");
    // 80: the token figure drops from the drawer's counters too.
    const narrow = drawerView({ row: full, sent: [], outcome: null, width: 80, now: 72_000 });
    expect(narrow.meta).toBe("running · 19 tools · 1m 12s");
  });

  test("`sent` keeps the last 3, one line each, cut by cells", () => {
    const d = drawerView({
      row: full,
      sent: ["one", "two", "three", "four"],
      outcome: null,
      width: 80,
      now: 72_000,
    });
    expect(d.sent).toHaveLength(3);
    expect(d.sent[0]?.text).toBe("two");
    expect(d.sent[2]?.text).toBe("four");
    const long = drawerView({
      row: full,
      sent: ["x".repeat(500)],
      outcome: null,
      width: 80,
      now: 72_000,
    });
    expect(cellWidth(long.sent[0]?.text ?? "")).toBeLessThanOrEqual(80);
    // A message with a newline shows its first line only (one row each).
    const multi = drawerView({
      row: full,
      sent: ["first\nsecond"],
      outcome: null,
      width: 80,
      now: 72_000,
    });
    expect(multi.sent[0]?.text).toBe("first");
  });

  test("an ended child: its outcome replaces `running`, and the frozen row still paints", () => {
    const d = drawerView({
      row: full,
      sent: [],
      outcome: { kind: "finished" },
      width: 100,
      now: 72_000,
    });
    expect(d.meta).toBe("✓ finished · report sent to the agent");
    const killed = drawerView({
      row: full,
      sent: [],
      outcome: { kind: "stopped" },
      width: 100,
      now: 72_000,
    });
    expect(killed.meta).toContain("stopped");
  });

  test("no earlier steps to hide: no `… earlier` row at all", () => {
    const d = drawerView({
      row: row(1, { toolUses: 3, tail: ["a", "b", "c"] }),
      sent: [],
      outcome: null,
      width: 100,
      now: 72_000,
    });
    expect(d.hidden).toBe("");
  });
});

describe("T-L5: the dock's height, counted into the viewport (Review H3)", () => {
  test("nothing shown → 0 rows", () => {
    expect(dockRows(null, null)).toBe(0);
  });

  test("the list: its rule plus its windowed rows (never the full item count)", () => {
    const one = view({ rows: [row(1)] });
    expect(dockRows(one, null)).toBe(1 + 1);
    // Nine items still paint five rows: the height follows the WINDOW, not the list.
    const nine = view({ rows: Array.from({ length: 9 }, (_, i) => row(i + 1)) });
    expect(nine.rows).toHaveLength(LIST_MAX_ROWS);
    expect(dockRows(nine, null)).toBe(1 + LIST_MAX_ROWS);
  });

  test("the drawer: head + `… +k earlier` + its tail + the messages sent", () => {
    const full = row(1, {
      tail: ["a", "b", "c", "d", "e", "f", "g", "h"],
    });
    const d = drawerView({
      row: full,
      sent: ["one", "two"],
      outcome: null,
      width: 100,
      now: 72_000,
    });
    expect(d.hidden).not.toBe("");
    expect(d.tail).toHaveLength(8);
    expect(d.sent).toHaveLength(2);
    expect(dockRows(null, d)).toBe(1 + 1 + 8 + 2);
  });

  test("a drawer with no hidden steps and nothing sent is just its head and tail", () => {
    const d = drawerView({
      row: row(2, { toolUses: 1 }),
      sent: [],
      outcome: null,
      width: 100,
      now: 72_000,
    });
    expect(d.hidden).toBe("");
    expect(d.tail).toHaveLength(1);
    expect(dockRows(null, d)).toBe(1 + 1);
  });
});

describe("the input title and the list's visibility", () => {
  test("`inputTitle`: none while the dock is on the input, `→ sa-N · <type|finished>` when open", () => {
    expect(inputTitle({ kind: "input" })).toBeNull();
    expect(inputTitle({ kind: "list", selected: "sa-1", armed: false })).toBeNull();
    expect(
      inputTitle({ kind: "open", id: "sa-1", ended: null, frozen: null }, { sub: "explore" }),
    ).toEqual({ target: "→ sa-1", sub: "explore" });
    expect(
      inputTitle({ kind: "open", id: "sa-1", ended: { kind: "finished" }, frozen: null }),
    ).toEqual({ target: "→ sa-1", sub: "finished" });
  });

  test("`listVisible`: one row is enough; no rows and no jobs is nothing", () => {
    expect(listVisible([], [])).toBe(false);
    expect(listVisible([row(1)], [])).toBe(true);
    expect(listVisible([], [{ id: "sh-1", command: "x", startedAt: 0 }])).toBe(true);
  });

  test("the count includes the shell jobs (the list says the total)", () => {
    const v = view({
      rows: [row(1), row(2)],
      jobs: [{ id: "sh-3", command: "watch", startedAt: 0 }],
    });
    expect(v.count).toBe(3);
  });
});
