/**
 * feat/subagent-panel (task 7): the dock's view-model (AGENTS §7 — the logic
 * lives here, pure, and the component only paints the segments). The visual
 * target is `.tentacle/tmp/subagent-panel/mockups/01..07`: glyphs, the titled
 * rule, the 5-row window, the width tiers at 100/80/56.
 */
import { describe, expect, test } from "bun:test";
import {
  LIST_MAX_ROWS,
  TITLE_MAX_COLS,
  backgroundListView,
  dockRows,
  drawerView,
  frozenAgent,
  frozenJob,
  inputTitle,
  jobDrawerView,
  listVisible,
  rowText,
  ruleText,
  sentState,
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
  test("100 columns: id, type, title and `tools · tokens · time`", () => {
    const v = view({
      rows: [row(1)],
      focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
    });
    const [first] = v.rows;
    expect(first).toBeDefined();
    const line = rowText(first ?? { segments: [] });
    expect(line).toContain("●");
    expect(line).toContain("sa-1");
    expect(line).toContain("explore");
    expect(line).toContain("19 tools · 12k · 1m 12s");
    // The selection grammar: a `›` marker, the rest of the dock's rows unmarked.
    expect(line.startsWith("› ")).toBe(true);
    // NEVER padded to the far edge (the owner's rejection of the old dock): the
    // row ends 3 cells after its title — the meta starts there, and that is it.
    expect(line.endsWith("19 tools · 12k · 1m 12s")).toBe(true);
    expect(cellWidth(line)).toBeLessThan(100);
  });

  test("80 columns: the token figure and the type column are dropped only below their tiers", () => {
    const at80 = rowText(view({ width: 80, rows: [row(1)] }).rows[0] ?? { segments: [] });
    expect(at80).toContain("19 tools · 1m 12s");
    expect(at80).not.toContain("12.4k");
    expect(at80).toContain("explore");
    expect(cellWidth(at80)).toBeLessThanOrEqual(80);
    const at56 = rowText(view({ width: 56, rows: [row(1)] }).rows[0] ?? { segments: [] });
    expect(at56).toContain("19 tools · 1m 12s");
    // Under 60 the type column goes too.
    expect(at56).not.toContain("explore");
    expect(cellWidth(at56)).toBeLessThanOrEqual(56);
  });

  test("a double-width description is cut by CELLS, never mid-glyph", () => {
    // 78 cells of description: it must NOT fit the ~47 a row leaves for it.
    const cjk =
      "設定ファイル読み込みの呼び出し元を探す設定ファイル読み込みの呼び出し元を探す設定ファイル";
    const v = view({
      width: 80,
      rows: [row(1, { description: cjk })],
      focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
    });
    const [first] = v.rows;
    expect(first).toBeDefined();
    const line = rowText(first ?? { segments: [] });
    expect(cellWidth(line)).toBeLessThanOrEqual(80);
    expect(line).toContain("…");
    // Never a stray half of a wide character: every cell of the row adds up.
    expect(line).not.toContain("\uFFFD");
  });

  test("every row is exactly one line, at every tier, unfocused and selected", () => {
    for (const width of [100, 90, 80, 70, 60, 56, 40, 20]) {
      for (const focus of [
        { kind: "input" as const },
        { kind: "list" as const, selected: "sa-1", armed: false, typing: false },
        { kind: "list" as const, selected: "sa-1", armed: true, typing: false },
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

describe("T-L1b: the compact column grammar (owner's UI revision)", () => {
  /** The cell where a row's meta begins: the owner's "meta starts 3 cells after the widest title". */
  const metaAt = (line: string): number => line.indexOf(" tools ·") - 5;

  test("the meta starts at the SAME cell on every row: aligned on the widest title, never at the far edge", () => {
    const v = view({
      width: 190,
      rows: [row(1, { description: "short" }), row(2, { description: "a much longer title here" })],
    });
    const a = rowText(v.rows[0] ?? { segments: [] });
    const b = rowText(v.rows[1] ?? { segments: [] });
    // The long title decides the column; the short one is padded to it (3 cells
    // before its meta), so both figures start in the same cell.
    expect(a.indexOf("19 tools")).toBe(b.indexOf("19 tools"));
    // …and that cell is nowhere near 190 (the old dock put it at ~150-186).
    expect(a.indexOf("19 tools")).toBeLessThan(60);
  });
  test("the type column exists only when SOME row is not `general`", () => {
    const allGeneral = view({
      rows: [
        row(1, { agentType: "general", description: "Ada: turni dispari" }),
        row(2, { agentType: "general", description: "Bruno: turni pari" }),
      ],
    });
    for (const r of allGeneral.rows) {
      expect(rowText(r)).not.toContain("general");
    }
    const mixed = view({
      rows: [row(1, { agentType: "general" }), row(2, { agentType: "explore" })],
    });
    // Mixed: the column appears, and `general` itself stays BLANK (it is the norm,
    // so repeating it on every row is exactly what the owner rejected).
    expect(rowText(mixed.rows[1] ?? { segments: [] })).toContain("explore");
    const generalLine = rowText(mixed.rows[0] ?? { segments: [] });
    expect(generalLine).not.toContain("general");
    // Both rows align on the type column's cells.
    expect(generalLine.indexOf("find callers")).toBe(
      rowText(mixed.rows[1] ?? { segments: [] }).indexOf("find callers"),
    );
  });

  test("the model column exists only when some row runs another model, and the pill never shows it", () => {
    const noModel = view({ rows: [row(1), row(2, { description: "other" })] });
    for (const r of noModel.rows) {
      expect(r.segments.some((s) => s.text.includes("qwen3"))).toBe(false);
    }
    const mixed = view({
      rows: [row(1), row(2, { description: "other", model: "qwen3-8" })],
    });
    expect(rowText(mixed.rows[1] ?? { segments: [] })).toContain("qwen3-8");
    // The row WITHOUT one leaves the column blank, so the metas still align.
    expect(rowText(mixed.rows[0] ?? { segments: [] }).indexOf("19 tools")).toBe(
      rowText(mixed.rows[1] ?? { segments: [] }).indexOf("19 tools"),
    );
  });

  test("the title column is capped at 56 cells, and the meta keeps its 3-cell gap", () => {
    const long = "x".repeat(120);
    const v = view({ width: 190, rows: [row(1, { description: long })] });
    const line = rowText(v.rows[0] ?? { segments: [] });
    // From the title's first character (after the columns) to its `…`.
    const at = line.indexOf("xxx");
    const elided = line.slice(at);
    const shown = elided.slice(0, elided.indexOf("…") + 1);
    expect(cellWidth(shown)).toBe(TITLE_MAX_COLS);
    // 3 cells, then the meta (the mockups' grammar: never padded to the edge).
    expect(line).toContain(`${shown}   19 tools`);
  });
});

/**
 * Step 0 of the UI revision (docs/feat/subagent-panel.md): the owner's broken
 * dock rule. Measured before any other change — `ruleText` was already `width`
 * cells at every wide width, so the fill was never the fault; the fault was that
 * a line too narrow for the HINT lost the fill AND the closing dash with it, and
 * collapsed to `─ background · 2 ` (17 cells, no end). Kept as the regression.
 */
describe("T-L0: the rule is ALWAYS one whole line of `width` cells", () => {
  test("at every width, focused or not — never a label with no fill and no end", () => {
    for (let width = 20; width <= 200; width += 1) {
      for (const focus of [
        { kind: "input" as const },
        { kind: "list" as const, selected: "sa-1", armed: false, typing: false },
        { kind: "list" as const, selected: "sa-1", armed: true, typing: false },
      ]) {
        const rule = ruleText(view({ width, rows: [row(1)], focus }));
        expect(cellWidth(rule)).toBe(width);
        // It ENDS in the rule, never in a floating label.
        expect(rule.endsWith("─")).toBe(true);
        // The fill is CONTIGUOUS: one run of dashes, so there is never a blank
        // hole between the title and the hint (the owner's gap) — the only
        // spaces are the single cell the grammar puts either side of a label.
        expect(rule).not.toMatch(/─ +─/);
      }
    }
  });

  test("the hint is what gives way, never the fill (the owner's gap)", () => {
    // 45 columns cannot hold `enter open · ctrl+x stop · esc back`: the rule keeps its
    // title and its fill and drops only the keys.
    const narrow = ruleText(
      view({
        width: 45,
        rows: [row(1)],
        focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
      }),
    );
    expect(cellWidth(narrow)).toBe(45);
    expect(narrow).toContain("background · 1");
    expect(narrow).not.toContain("enter open");
    expect(narrow.endsWith("─")).toBe(true);
    // Wide enough, the keys are back and the fill still closes the line.
    const wide = ruleText(
      view({
        width: 90,
        rows: [row(1)],
        focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
      }),
    );
    expect(wide).toContain("enter open · ctrl+x stop · esc back");
    expect(cellWidth(wide)).toBe(90);
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
      focus: { kind: "list", selected: "sa-7", armed: false, typing: false },
    });
    // The selection holds the window's last row once it passes the fifth, so the
    // rows above it never jump away (mockup 05: `↑2 ↓2`, the item at the bottom).
    expect(v.rows.map((r) => r.id)).toEqual(["sa-3", "sa-4", "sa-5", "sa-6", "sa-7"]);
    expect(v.above).toBe(2);
    expect(v.below).toBe(2);
    expect(v.start).toBe(2);
    expect(v.hint).toContain("↑2 ↓2");
    expect(v.hint).toContain("enter open · ctrl+x stop · esc back");
  });

  test("selected on the LAST row: the window is flush with the end", () => {
    const v = view({
      rows: nine,
      width: 100,
      focus: { kind: "list", selected: "sa-9", armed: false, typing: false },
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
      jobs: [{ id: "bg-3", command: "npm run watch", startedAt: 0 }],
      now: 300_000,
      width: 100,
    });
    expect(v.rows.map((r) => r.id)).toEqual(["sa-1", "bg-3"]);
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
      view({
        rows: [row(1)],
        focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
      }).hint,
    ).toBe("enter open · ctrl+x stop · esc back");
    // Armed: the confirm's own words, and the arming row says what the second
    // `ctrl+x` does.
    const armed = view({
      rows: [row(1)],
      focus: { kind: "list", selected: "sa-1", armed: true, typing: false },
    });
    expect(armed.hint).toBe("ctrl+x stop · any other key cancels");
    expect(armed.rows[0]?.armed).toBe(true);
    expect(armed.rows[0]?.meta).toBe("stop sa-1? ctrl+x");
    // TYPING with the dropdown pinned (docs/fix/dock-list-type-through.md): the
    // rule offers only the two keys that still concern the dock — never `enter
    // open`, which now sends. The row stays SELECTED (↓ comes back to it) but the
    // rule paints calm, so the accent says where the keys really are.
    const typing = view({
      rows: [row(1), row(2)],
      focus: { kind: "list", selected: "sa-2", armed: false, typing: true },
    });
    expect(typing.hint).toBe("↓ list · esc close");
    expect(typing.focused).toBe(false);
    expect(typing.rows[1]?.selected).toBe(true);
    // The overflow prefix still says how much is out of view.
    expect(
      view({
        rows: Array.from({ length: 9 }, (_, i) => row(i + 1)),
        focus: { kind: "list", selected: "sa-9", armed: false, typing: true },
        width: 100,
      }).hint,
    ).toBe("↑4 · ↓ list · esc close");
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
      sent: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }],
      outcome: null,
      width: 80,
      now: 72_000,
    });
    expect(d.sent).toHaveLength(3);
    expect(d.sent[0]?.text).toBe("two");
    expect(d.sent[2]?.text).toBe("four");
    const long = drawerView({
      row: full,
      sent: [{ text: "x".repeat(500) }],
      outcome: null,
      width: 80,
      now: 72_000,
    });
    expect(cellWidth(long.sent[0]?.text ?? "")).toBeLessThanOrEqual(80);
    // A message with a newline shows its first line only (one row each).
    const multi = drawerView({
      row: full,
      sent: [{ text: "first\nsecond" }],
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

  test("the head carries the child's MODEL only when it differs (the mockup's grammar)", () => {
    // `─ sa-2 · Bruno: … · qwen3-8 ─── running · … ─`; a child on the main model
    // shows no model at all (the owner: "only when it differs"), and the generic
    // `general` type is left out of the head too (the old `· general ·` is gone).
    const differs = drawerView({
      row: row(2, { agentType: "general", description: "Bruno: turni pari", model: "qwen3-8" }),
      sent: [],
      outcome: null,
      width: 100,
      now: 72_000,
    });
    const head = differs.head.map((s) => s.text).join("");
    expect(head).toContain("sa-2 · Bruno: turni pari · qwen3-8 ");
    expect(head).not.toContain("general");
    const same = drawerView({
      row: row(1, { agentType: "general", description: "Ada: turni dispari" }),
      sent: [],
      outcome: null,
      width: 100,
      now: 72_000,
    });
    expect(same.head.map((s) => s.text).join("")).toContain("sa-1 · Ada: turni dispari ");
    // A real type still tells the children apart.
    const explore = drawerView({
      row: row(1, { agentType: "explore", description: "find callers" }),
      sent: [],
      outcome: null,
      width: 100,
      now: 72_000,
    });
    expect(explore.head.map((s) => s.text).join("")).toContain("sa-1 · explore · find callers");
    // Still exactly one row of `width` cells, the model included.
    for (const d of [differs, same, explore]) {
      expect(cellWidth(d.head.map((s) => s.text).join(""))).toBe(100);
    }
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
      sent: [{ text: "one" }, { text: "two" }],
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
    expect(inputTitle({ kind: "list", selected: "sa-1", armed: false, typing: false })).toBeNull();
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
    expect(listVisible([], [{ id: "bg-1", command: "x", startedAt: 0 }])).toBe(true);
  });

  test("the count includes the shell jobs (the list says the total)", () => {
    const v = view({
      rows: [row(1), row(2)],
      jobs: [{ id: "bg-3", command: "watch", startedAt: 0 }],
    });
    expect(v.count).toBe(3);
  });
});

describe("a shell job's drawer (docs/feat/shell-jobs-panel.md)", () => {
  const job = { id: "bg-3", command: "watch: grep -c '### Turno' conversazione.md", startedAt: 0 };

  test("the head: the wire's id, the cut command, the live clock", () => {
    const v = jobDrawerView({
      row: job,
      output: ["one"],
      outcome: null,
      width: 100,
      now: 250_000,
    });
    const head = rowText({ segments: v.head });
    // Owner Q5 (b): `bg-3`, never an `sh-3` alias.
    expect(head.startsWith("─ bg-3 · ")).toBe(true);
    expect(head).toContain("watch: grep -c");
    expect(head).toContain("running · 4m 10s");
    expect(v.meta).toBe("running · 4m 10s");
    // Exactly the width: the head is a rule, never a wrap.
    expect(cellWidth(head)).toBe(100);
  });

  test("at 80 columns it still fits the terminal", () => {
    const v = jobDrawerView({ row: job, output: [], outcome: null, width: 80, now: 0 });
    expect(cellWidth(rowText({ segments: v.head }))).toBe(80);
    expect(rowText({ segments: v.head })).toContain("bg-3");
  });

  test("the outcome replaces the clock, with the total run time (owner B)", () => {
    const done = jobDrawerView({
      row: job,
      output: ["x"],
      outcome: { kind: "exited", exitCode: 0 },
      width: 100,
      now: 250_000,
    });
    expect(done.meta).toBe("✓ exited (0) · 4m 10s");
    expect(rowText({ segments: done.head })).toContain("✓ exited (0) · 4m 10s");
    // The tone: ok for a clean exit, error for anything else.
    expect(done.head.find((s) => s.text.startsWith("✓"))?.tone).toBe("success");
    const stopped = jobDrawerView({
      row: job,
      output: ["x"],
      outcome: { kind: "stopped" },
      width: 100,
      now: 250_000,
    });
    expect(stopped.meta).toBe("✗ stopped · 4m 10s");
    expect(stopped.head.find((s) => s.text.startsWith("✗"))?.tone).toBe("error");
  });

  test("owner B: a failed exit never paints ✓, and the tone says error", () => {
    const failed = jobDrawerView({
      row: job,
      output: ["x"],
      outcome: { kind: "exited", exitCode: 3 },
      width: 100,
      now: 250_000,
    });
    expect(failed.meta).toBe("✗ exited (3) · 4m 10s");
    expect(failed.head.find((s) => s.text.startsWith("✗"))?.tone).toBe("error");
    const killed = jobDrawerView({
      row: job,
      output: ["x"],
      outcome: { kind: "killed" },
      width: 100,
      now: 250_000,
    });
    expect(killed.meta).toBe("✗ killed · 4m 10s");
    expect(killed.head.some((s) => s.text.includes("✓"))).toBe(false);
  });

  test("fix round 2: an ENDED drawer's duration is the job's total run, not a live clock", () => {
    // The exit record carries the ONE instant the run ended (`endedAt`, stamped in
    // the App's exit handler). Two frames minutes apart therefore say the same
    // thing: `now` is not the clock of a finished job.
    const ended = { kind: "exited", exitCode: 2, endedAt: 65_000 } as const;
    const at = (now: number): string =>
      jobDrawerView({ row: job, output: ["x"], outcome: ended, width: 100, now }).meta;
    expect(at(70_000)).toBe("✗ exited (2) · 1m 5s");
    // 3.2 s later — the review's own repro — and then a whole minute later.
    expect(at(73_200)).toBe("✗ exited (2) · 1m 5s");
    expect(at(125_000)).toBe("✗ exited (2) · 1m 5s");
    // While it RUNS there is no end to measure to: the clock still ticks.
    const running = (now: number): string =>
      jobDrawerView({ row: job, output: ["x"], outcome: null, width: 100, now }).meta;
    expect(running(70_000)).toBe("running · 1m 10s");
    expect(running(73_200)).toBe("running · 1m 13s");
  });

  test("review 4: `maxRows` bounds the drawer's total height", () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    for (const maxRows of [8, 5, 2, 1]) {
      const v = jobDrawerView({ row: job, output, outcome: null, width: 80, now: 0, maxRows });
      // The reservation `dockRows` makes never exceeds the room the terminal gave.
      expect(dockRows(null, v)).toBeLessThanOrEqual(maxRows);
    }
    // `truncated`'s `… earlier` row is dropped too when only one row is left.
    const tight = jobDrawerView({
      row: job,
      output,
      truncated: true,
      outcome: null,
      width: 80,
      now: 0,
      maxRows: 1,
    });
    expect(dockRows(null, tight)).toBe(1);
    expect(tight.hidden).toBe("");
  });

  test("a cut read says so, above the tail", () => {
    const v = jobDrawerView({
      row: job,
      output: ["a"],
      truncated: true,
      outcome: null,
      width: 100,
      now: 0,
    });
    expect(v.hidden).toBe("… earlier output not shown");
  });

  test("M3: a blank line in the tail is ONE space and the body keeps its height", () => {
    const v = jobDrawerView({
      row: job,
      output: ["a", "", "b"],
      outcome: null,
      width: 100,
      now: 0,
    });
    expect(v.tail).toEqual(["a", " ", "b"]);
    // Three painted rows, so `dockRows`' reservation matches them exactly.
    expect(dockRows(null, v)).toBe(1 + 3);
  });

  test("M3: no output yet is the one `(no output yet)` row, never a zero-height body", () => {
    const v = jobDrawerView({ row: job, output: undefined, outcome: null, width: 100, now: 0 });
    expect(v.tail).toEqual(["(no output yet)"]);
    expect(dockRows(null, v)).toBe(2);
  });

  test("a job paints no `you → …` messages (it has no inbox)", () => {
    const v = jobDrawerView({ row: job, output: ["a"], outcome: null, width: 100, now: 0 });
    expect(v.sent).toEqual([]);
  });

  test("`inputTitle` is null for a job: the input stays on the main agent (Q1 (a))", () => {
    // The frozen shape carries the row; the live one is frozen by `reconcile`
    // when its row leaves, so the drawer keeps its subject either way.
    expect(
      inputTitle({ kind: "open", id: "bg-3", ended: null, frozen: { kind: "job", row: job } }),
    ).toBeNull();
    expect(
      inputTitle({
        kind: "open",
        id: "bg-3",
        ended: { kind: "finished" },
        frozen: { kind: "job", row: job },
      }),
    ).toBeNull();
    // A child's is unchanged.
    expect(inputTitle({ kind: "open", id: "sa-1", ended: null, frozen: null })?.target).toBe(
      "→ sa-1",
    );
  });

  test("`dockRows` counts the dropdown's job rows too", () => {
    const v = view({
      rows: [row(1)],
      jobs: [{ id: "bg-3", command: "watch", startedAt: 0 }],
      now: 0,
    });
    expect(dockRows(v, null)).toBe(1 + v.rows.length);
    expect(v.rows).toHaveLength(2);
  });

  test("`frozenJob` / `frozenAgent` tell the two shapes apart", () => {
    expect(frozenJob({ kind: "job", row: job })?.id).toBe("bg-3");
    expect(frozenAgent({ kind: "job", row: job })).toBeNull();
    expect(frozenJob(null)).toBeNull();
    expect(frozenAgent(row(1))?.id).toBe("sa-1");
    expect(frozenJob(row(1))).toBeNull();
  });

  // docs/fix/autoaccept-wake-turns.md T10 (part B): `✓ read` once the child took
  // the message into its context — one absolute, cumulative count on both sides.
  // MUTATION: drop the `n <= userRead` comparison (or the ended branch) → one of
  // these goes red.
  test("`sentState`: the truth table (read / unread / unread_ended / unknown)", () => {
    // Read: the row's count reached this message's index.
    expect(sentState(1, 1, null)).toBe("read");
    expect(sentState(1, 3, null)).toBe("read");
    // Accepted, not read yet: today's text.
    expect(sentState(3, 2, null)).toBe("unread");
    // The child ended with it unread: honest, not "before its next step".
    expect(sentState(3, 2, { kind: "finished" })).toBe("unread_ended");
    // Read wins over an outcome: it WAS read.
    expect(sentState(2, 2, { kind: "finished" })).toBe("read");
    // An older daemon: no index, no count → no claim either way.
    expect(sentState(undefined, 2, null)).toBe("unknown");
    expect(sentState(2, undefined, null)).toBe("unknown");
    expect(sentState(undefined, undefined, { kind: "stopped" })).toBe("unread_ended");
  });

  test("the drawer's suffixes: `✓ read`, today's text, `· not read`", () => {
    const suffix = (extra: Partial<BackgroundAgentRow>, sent: { text: string; n?: number }[]) =>
      drawerView({
        row: row(1, extra),
        sent,
        outcome: null,
        width: 80,
        now: 0,
      })
        .sent[0]?.segments.map((s) => s.text)
        .join("");
    expect(suffix({ userRead: 1 }, [{ text: "hi", n: 1 }])).toContain("  ✓ read");
    expect(suffix({ userRead: 0 }, [{ text: "hi", n: 1 }])).toContain(
      "  · read before its next step",
    );
    // An older daemon (no `userRead`, or no `n`): today's text, nothing invented.
    expect(suffix({}, [{ text: "hi", n: 1 }])).toContain("  · read before its next step");
    expect(suffix({ userRead: 1 }, [{ text: "hi" }])).toContain("  · read before its next step");
    // Ended with it unread.
    const ended = drawerView({
      row: row(1, { userRead: 0 }),
      sent: [{ text: "hi", n: 1 }],
      outcome: { kind: "finished" },
      width: 80,
      now: 0,
    });
    expect(ended.sent[0]?.segments.map((s) => s.text).join("")).toContain("  · not read");
    // The row's own text is never cut by the suffix at a narrow width.
    const narrow = drawerView({
      row: row(1, { userRead: 1 }),
      sent: [{ text: "x".repeat(300), n: 1 }],
      outcome: null,
      width: 40,
      now: 0,
    });
    expect(
      cellWidth(narrow.sent[0]?.segments.map((s) => s.text).join("") ?? ""),
    ).toBeLessThanOrEqual(40);
  });
});
