import { describe, expect, test } from "bun:test";
import { layoutTranscript } from "../src/render-lines.ts";
import type { DisplayItem, ToolItem } from "../src/state.ts";
import { toolCallAt, toolCallAtViewport } from "../src/tool-hit.ts";

// A laid-out transcript built by the REAL layout, never a hand-built array: the
// hit-test's contract is "the rows `layoutTranscript` produced", and a fake
// would silently drift from the separator/`start` bookkeeping (AGENTS §9).
const LONG =
  "cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v -timeout 120s 2>&1 | tail -50";
const tool = (id: string, command = LONG): ToolItem => ({
  kind: "tool",
  id,
  name: "shell",
  args: JSON.stringify({ command }),
  status: "ok",
  durationMs: 100,
  resultText: Array.from({ length: 8 }, (_, i) => `out ${i + 1}`).join("\n"),
});
// Long enough that the two calls are many rows apart: the window test below
// needs `win.start` values far enough apart to fall on different items.
const pad = (n: number): DisplayItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "assistant" as const, text: `pad ${i}` }));
const items = (): DisplayItem[] => [
  { kind: "user", text: "run the tests" },
  ...pad(10),
  tool("c1"),
  { kind: "assistant", text: "done, next" },
  tool("c2", "make build && make test"),
];
const opts = { expandAll: false, width: 40 };

describe("toolCallAt: which tool call is under screen row y (docs/feat/tui-tool-expand.md)", () => {
  test("a call's FIRST row is its header and resolves to that call's id", () => {
    const { laid } = layoutTranscript(items(), opts);
    const first = laid.find((l) => l.id === "c1");
    expect(first).toBeDefined();
    if (!first) return;
    expect(toolCallAt(laid, first.start)).toBe("c1");
    const second = laid.find((l) => l.id === "c2");
    if (!second) return;
    expect(toolCallAt(laid, second.start)).toBe("c2");
  });

  test("a wrapped continuation row and a body row are NOT controls", () => {
    // Non-vacuity: the call really spans several rows (the command wraps at 40
    // columns and the body adds one), so the assertion below is not vacuous.
    const { laid } = layoutTranscript(items(), opts);
    const c1 = laid.find((l) => l.id === "c1");
    expect(c1).toBeDefined();
    if (!c1) return;
    expect(c1.rows.length).toBeGreaterThan(2); // header + command wrap + body
    for (let r = c1.start + 1; r < c1.start + c1.rows.length; r++) {
      expect(toolCallAt(laid, r)).toBeNull();
    }
  });

  test("a non-tool row (a prompt, a reply, the blank separator) resolves to null", () => {
    const { laid, total } = layoutTranscript(items(), opts);
    expect(toolCallAt(laid, 0)).toBeNull(); // the user prompt
    // The reply, and every blank separator row between items.
    const c1 = laid.find((l) => l.id === "c1");
    const c2 = laid.find((l) => l.id === "c2");
    if (!c1 || !c2) return;
    expect(toolCallAt(laid, c1.start - 1)).toBeNull(); // separator above c1
    expect(toolCallAt(laid, c2.start - 1)).toBeNull(); // separator above c2
    for (let r = c2.start; r < total; r++) {
      const id = toolCallAt(laid, r);
      expect(id === null || id === "c2").toBe(true);
    }
    expect(toolCallAt(laid, total)).toBeNull(); // past the end
    expect(toolCallAt(laid, -1)).toBeNull(); // above the top
  });

  test("the SCROLL WINDOW is the caller's job, and the same row means different calls", () => {
    // `toolCallAt` takes an ABSOLUTE row: at one window a screen row is a pad
    // row, in another it is a call's header. This is exactly why the App must
    // pass `win.start + (y - 1)` and not `y - 1` — the mutation that drops
    // `win.start` resolves a text row and expands nothing.
    const { laid } = layoutTranscript(items(), opts);
    const c2 = laid.find((l) => l.id === "c2");
    if (!c2) return;
    const screenY = 3; // the 3rd visible row of ANY window
    const tailWindow = { start: c2.start - (screenY - 1) }; // the call is at row 3
    const earlierWindow = { start: Math.max(0, c2.start - 10) }; // a text row is
    expect(toolCallAt(laid, tailWindow.start + (screenY - 1))).toBe("c2");
    expect(toolCallAt(laid, earlierWindow.start + (screenY - 1))).toBeNull();
  });

  test("an expanded call's `$` rows toggle (docs/fix/tui-click-dollar-row); its output rows do not", () => {
    const { laid } = layoutTranscript(items(), { ...opts, expandedIds: ["c1"] });
    const c1 = laid.find((l) => l.id === "c1");
    if (!c1) return;
    expect(toolCallAt(laid, c1.start)).toBe("c1");
    // The `⎿ $ …` block (and its hung continuation rows) sits directly under
    // the header; the output rows after it are text.
    expect(c1.rows[1]?.startsWith("⎿ $ ")).toBe(true);
    expect(toolCallAt(laid, c1.start + 1)).toBe("c1");
    const out = c1.rows.findIndex((r) => r === "  out 1");
    expect(out).toBeGreaterThan(1);
    for (let r = 1; r < c1.rows.length; r++) {
      expect(toolCallAt(laid, c1.start + r)).toBe(r < out ? "c1" : null);
    }
  });

  test("an empty layout answers null for every row", () => {
    expect(toolCallAt([], 0)).toBeNull();
    expect(toolCallAt([], 7)).toBeNull();
  });
});

describe("toolCallAtViewport: only rows INSIDE the transcript viewport count", () => {
  const windowed = () => layoutTranscript(items(), opts);

  test("a screen row at or below the viewport's end is not a control", () => {
    const { laid } = windowed();
    const c2 = laid.find((l) => l.id === "c2");
    if (!c2) return;
    // A 5-row viewport whose first row is c2's header.
    const visible = { start: c2.start, end: c2.start + 5 };
    expect(toolCallAtViewport(laid, visible, 1)).toBe("c2"); // inside: the header
    // Below the viewport: the prompt rule, the input box, the status bar. These
    // rows are NOT transcript rows at all — the buffer's own rows past the
    // window may well be tool headers (the next test), and that is exactly the
    // bug: a click there toggled a call the user could not see.
    for (const y of [6, 7, 12, 23]) {
      expect(toolCallAtViewport(laid, visible, y)).toBeNull();
    }
    expect(toolCallAtViewport(laid, visible, 0)).toBeNull(); // above the top
  });

  test("a row past the window's end is refused even when the BUFFER has a header there", () => {
    // The exact property (Review finding 1): scrolled up, `win.start + y - 1`
    // walks past `win.end` into real transcript rows. Non-vacuity first — the
    // unbounded lookup really does find a call there.
    const { laid } = windowed();
    const c1 = laid.find((l) => l.id === "c1");
    const c2 = laid.find((l) => l.id === "c2");
    if (!c1 || !c2) return;
    const visible = { start: c1.start, end: c1.start + c1.rows.length + 1 }; // c1 + its separator
    const below = c2.start - visible.start + 1; // the screen row of c2's header
    expect(below).toBeGreaterThan(visible.end - visible.start); // it is below the viewport
    expect(toolCallAt(laid, visible.start + (below - 1))).toBe("c2"); // unbounded: a call
    expect(toolCallAtViewport(laid, visible, below)).toBeNull(); // bounded: nothing
  });

  test("the same screen row means different calls in different windows (no stale start)", () => {
    const { laid } = windowed();
    const c2 = laid.find((l) => l.id === "c2");
    if (!c2) return;
    const tail = { start: c2.start, end: c2.start + 10 };
    const earlier = { start: Math.max(0, c2.start - 10), end: Math.max(0, c2.start - 10) + 10 };
    expect(toolCallAtViewport(laid, tail, 1)).toBe("c2");
    expect(toolCallAtViewport(laid, earlier, 1)).toBeNull(); // a pad/reply row there
  });

  test("an empty viewport (height 0) accepts no row at all", () => {
    const { laid } = windowed();
    expect(toolCallAtViewport(laid, { start: 0, end: 0 }, 1)).toBeNull();
  });
});

describe("toolCallAt: a shell call's `$` rows toggle too (docs/fix/tui-click-dollar-row)", () => {
  const CMD = "echo one\necho two && echo a-very-long-second-line-that-wraps-at-forty";
  const multi = (id: string): ToolItem => ({
    ...tool(id, CMD),
    status: "error",
    resultText: "exit=2\nboom\nbang",
  });
  const sentence = (id: string): ToolItem => ({
    ...multi(id),
    args: JSON.stringify({ command: CMD, description: "Run it" }),
  });
  const o = { expandAll: true, width: 40 };

  test("expanded described shell: header, every `$` row and the exit-spill row hit; output rows do not", () => {
    const { laid } = layoutTranscript([sentence("s1")], o);
    const l = laid[0];
    expect(l).toBeDefined();
    if (!l) return;
    const dollarEnd = l.rows.findIndex((r) => r.includes("boom"));
    expect(dollarEnd).toBeGreaterThan(2); // header + >1 `$` rows (non-vacuous)
    for (let r = 0; r < dollarEnd; r++) {
      expect(toolCallAt(laid, l.start + r)).toBe("s1");
    }
    expect(toolCallAt(laid, l.start + dollarEnd)).toBeNull(); // first output row
    expect(toolCallAt(laid, l.start + l.rows.length - 1)).toBeNull();
  });

  test("collapsed described shell: header and the `$` row hit", () => {
    const { laid } = layoutTranscript([sentence("s1")], { expandAll: false, width: 40 });
    const l = laid[0];
    expect(l).toBeDefined();
    if (!l) return;
    expect(toolCallAt(laid, l.start)).toBe("s1");
    expect(toolCallAt(laid, l.start + 1)).toBe("s1");
    expect(toolCallAt(laid, l.start + 2)).toBeNull();
  });

  test("a non-shell tool's second row is still not a control", () => {
    const read: ToolItem = {
      kind: "tool",
      id: "r1",
      name: "read",
      args: JSON.stringify({ path: "a.ts" }),
      status: "ok",
      durationMs: 5,
      resultText: "l1\nl2\nl3",
    };
    const { laid } = layoutTranscript([read], { expandAll: true, width: 40 });
    const l = laid[0];
    expect(l).toBeDefined();
    if (!l) return;
    expect(l.rows.length).toBeGreaterThan(1);
    expect(toolCallAt(laid, l.start)).toBe("r1");
    expect(toolCallAt(laid, l.start + 1)).toBeNull();
  });

  test("plain shell (no sentence): collapsed → header only; expanded → header + `$` rows", () => {
    const c = layoutTranscript([multi("p1")], { expandAll: false, width: 40 }).laid;
    const cl = c[0];
    expect(cl).toBeDefined();
    if (!cl) return;
    expect(toolCallAt(c, cl.start)).toBe("p1");
    expect(toolCallAt(c, cl.start + 1)).toBeNull();
    const e = layoutTranscript([multi("p1")], o).laid;
    const el = e[0];
    expect(el).toBeDefined();
    if (!el) return;
    expect(toolCallAt(e, el.start + 1)).toBe("p1");
  });
});

describe("toggleRows is memoised per item (layoutTranscript runs every frame)", () => {
  test("a second layout of the SAME item reuses the count; a new width recomputes", () => {
    const t = tool("m1", "echo a && echo b && echo c && echo d && echo e && echo f");
    const o2 = { expandAll: true, width: 20 };
    const first = layoutTranscript([t], o2).laid[0]?.toggleRows ?? 0;
    expect(first).toBeGreaterThan(1);
    // Same object, mutated args: a recompute would see the short command; a
    // cache hit keeps the memoised count (the item is immutable in real use).
    (t as { args: string }).args = JSON.stringify({ command: "x" });
    expect(layoutTranscript([t], o2).laid[0]?.toggleRows).toBe(first);
    // A different width is a different key → recomputed from the mutated args.
    expect(layoutTranscript([t], { expandAll: true, width: 21 }).laid[0]?.toggleRows).not.toBe(
      first,
    );
  });
});
