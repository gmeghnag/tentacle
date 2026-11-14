/**
 * docs/feat/app-decomposition.md S0b (Fable M3) — the SGR-class blind spot.
 *
 * `app-frames.test.tsx` compares `lastFrame()` AFTER stripping SGR (its `norm`
 * collapses runs of `─` too), so it cannot see which cells are painted inverse:
 * the selection highlight (`<Text inverse>`, `App.tsx:4105`), a focused pill
 * (`StatusBar`'s `Pill`, inverse + bold), an attach row. M3 asks for raw frames
 * for exactly those, and for a pill CLICK after each layout state, to pin
 * `onPillRange` (`App.tsx:4252-4258`): the cell range the bar reports and the
 * row the App derives must agree with what it PAINTED, or a click opens the
 * wrong thing.
 *
 * This harness forces truecolour (`chalk.level = 3`) as `app.test.tsx` does, so
 * the SGR codes are present in the frame at all — with colour off, none of this
 * is observable, which is why the plain frame set could not cover it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import chalk from "chalk";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController } from "../src/App.tsx";
import type { FileProbe } from "../src/attach-files.ts";
import type { BackgroundAgentRow } from "../src/background-view.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CTRL_T = "\x14";
const ENTER = "\r";
const ESC = "\x1b";
/** SGR inverse on, in its opening form (`ESC[7m`). */
const INVERSE = "\x1b[7m";

/** SGR mouse: left press at 1-based (col, row). */
const press = (x: number, y: number): string => `\u001B[<0;${x};${y}M`;
const stripAnsi = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
  s.replace(/\x1b\[[0-9;]*m/g, "");

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const probe: FileProbe = {
  read: async (path: string) =>
    path === "/tmp/a.png" ? { kind: "file", size: PNG.length, bytes: PNG } : null,
};

const AGENT: BackgroundAgentRow = {
  id: "sa-1",
  agentType: "explore",
  description: "find callers of parseConfig",
  state: "running",
  toolUses: 19,
  tokens: 12_400,
  startedAt: Date.now() - 72_000,
  tail: ["fs_read a.ts"],
};

function fake(opts: { agents?: readonly BackgroundAgentRow[] } = {}): SessionController {
  return {
    async *send(prompt: string, signal?: AbortSignal) {
      yield { type: "text", delta: `reply to ${prompt}` };
      if (prompt.startsWith("hang")) {
        // A turn that stays open, so the running layout can be pinned.
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      yield { type: "turn_end", reason: "end_turn" };
    },
    onJobs(listener: (r: { rows: readonly never[]; count: number }) => void) {
      listener({ rows: [], count: 0 });
      return () => {};
    },
    onSubagents(listener: (rows: readonly BackgroundAgentRow[]) => void) {
      listener(opts.agents ?? []);
      return () => {};
    },
    imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }),
    ownsTurn: () => true,
  } as unknown as SessionController;
}

/**
 * Truecolour is FORCED for the SGR pins: with colour off Ink emits no codes at
 * all, so nothing here is observable — the same reason `app.test.tsx` sets
 * `chalk.level = 3` around its conceal-phase tests.
 */
const level = chalk.level;
chalk.level = 3;

async function mount(session: SessionController, extra: Partial<AppProps> = {}) {
  const app = render(
    <App
      createSession={() => session}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
      fileProbe={probe}
      home="/home/u"
      localCwd="/work"
      {...extra}
    />,
  );
  await delay(80);
  return {
    app,
    /** The frame WITH SGR codes, split into screen rows. */
    rawRows: () => (app.lastFrame() ?? "").split("\n"),
    keys: async (...chunks: string[]) => {
      for (const chunk of chunks) {
        app.stdin.write(chunk);
        await delay(35);
      }
      await delay(70);
    },
  };
}

/** The status bar: the frame's last row, raw. */
const barRow = (rows: readonly string[]): string => rows.at(-1) ?? "";

describe("S0b SGR pins: what is painted inverse, which the stripped frames cannot see", () => {
  test("a FOCUSED pill is painted inverse and bold; an unfocused one is neither", async () => {
    const t = await mount(fake({ agents: [AGENT] }));
    // Unfocused: `1 agent ↓` in the accent colour, with no inverse run at all.
    const idle = barRow(t.rawRows());
    expect(stripAnsi(idle)).toContain("1 agent ↓");
    expect(idle).not.toContain(INVERSE);
    // Focused (the input's Ctrl+T): the SAME control, painted inverse + bold.
    await t.keys(CTRL_T);
    const focused = barRow(t.rawRows());
    expect(stripAnsi(focused)).toContain("1 agent ⏎");
    expect(focused).toContain(INVERSE);
    // Exactly ONE inverse run, and it opens right at the pill's own cells (the
    // bar's other parts — the hint, auto-accept — stay plain).
    expect(focused.split(INVERSE).length - 1).toBe(1);
    const at = focused.indexOf(INVERSE);
    expect(stripAnsi(focused.slice(at))).toMatch(/^ 1 agent ⏎ $/);
    t.app.unmount();
  });

  test("a text SELECTION is painted inverse over the dragged cells only, and cleared on release", async () => {
    const t = await mount(fake());
    await t.keys("hello world", ENTER);
    // Press at column 3 of row 1, drag to column 9, then release.
    t.app.stdin.write(press(3, 1));
    await delay(60);
    t.app.stdin.write("\u001B[<32;9;1M"); // motion (btn bit 32) to column 9
    await delay(60);
    const dragging = t.rawRows()[0] ?? "";
    expect(dragging).toContain(INVERSE);
    // The inverse run is the SELECTED CELLS, not the whole row: it opens after
    // the row's first cells and closes before its end.
    const plain = stripAnsi(dragging);
    const at = dragging.indexOf(INVERSE);
    const before = stripAnsi(dragging.slice(0, at));
    expect(before.length).toBe(2); // columns 1-2 (0-based 0-1) are plain
    expect(plain.length).toBeGreaterThan(before.length + 1);
    t.app.stdin.write("\u001B[<0;9;1m"); // release: copies, then clears
    await delay(80);
    expect(t.rawRows()[0]).not.toContain(INVERSE);
    t.app.unmount();
  });

  test("an attach row carries the paperclip and its `name size`, before any upload", async () => {
    const t = await mount(fake());
    await t.keys("/tmp/a.png");
    await delay(150);
    t.app.stdin.write(ENTER);
    await delay(400);
    expect(stripAnsi(t.rawRows().join("\n"))).toContain("📎 a.png");
    t.app.unmount();
  });
});

describe("S0b pill click: `onPillRange` reports the cells the bar actually painted", () => {
  /** The bar's own row content and the 1-based column of the pill's text. */
  const pillAt = (rows: readonly string[]) => {
    const raw = barRow(rows);
    const plain = stripAnsi(raw);
    const at = plain.indexOf("agent");
    return { row: rows.length, col: at < 0 ? -1 : at + 1, plain };
  };

  test("pill click at rest opens the dropdown; the same range after a running turn still does", async () => {
    // (1) at rest.
    const rest = await mount(fake({ agents: [AGENT] }));
    const atRest = pillAt(rest.rawRows());
    expect(atRest.plain).toContain("1 agent ↓");
    expect(atRest.col).toBeGreaterThan(0);
    rest.app.stdin.write(press(atRest.col, atRest.row));
    await delay(150);
    expect(stripAnsi(rest.app.lastFrame() ?? "")).toContain("background · 1");
    rest.app.unmount();

    // (2) with a RUNNING turn: the thinking line takes a row above the input, so
    // the bar's screen row is unchanged but its content is re-laid out — the
    // click must still land on the pill (the range is re-reported every frame).
    const running = await mount(fake({ agents: [AGENT] }));
    await running.keys("hang");
    running.app.stdin.write("\r"); // starts the turn (kept open: `hang`)
    await delay(250);
    expect(stripAnsi(running.app.lastFrame() ?? "")).toContain("Working…");
    const atRun = pillAt(running.rawRows());
    expect(atRun.col).toBeGreaterThan(0);
    running.app.stdin.write(press(atRun.col, atRun.row));
    await delay(150);
    expect(stripAnsi(running.app.lastFrame() ?? "")).toContain("background · 1");
    running.app.unmount();
  });

  test("pill click with the DROPDOWN open re-derives the bar's row from the dock's own height", async () => {
    const t = await mount(fake({ agents: [AGENT] }));
    await t.keys(CTRL_T); // focus the pill
    await t.keys(ENTER); // open the dropdown: the dock paints rows above the input
    expect(stripAnsi(t.app.lastFrame() ?? "")).toContain("background · 1");
    const at = pillAt(t.rawRows());
    expect(at.col).toBeGreaterThan(0);
    // The drawer is a taller dock than the dropdown, and `dockHeight` is part of
    // the row the bar reports. Clicking the pill must still land.
    await t.keys(ENTER); // open the child: the drawer (a taller dock)
    const drawer = stripAnsi(t.app.lastFrame() ?? "");
    expect(drawer).toContain("find callers of parseConfig");
    const atDrawer = pillAt(t.rawRows());
    expect(atDrawer.col).toBeGreaterThan(0);
    t.app.stdin.write(press(atDrawer.col, atDrawer.row));
    await delay(160);
    // The pill's click opened the DROPDOWN for the open child, i.e. it landed.
    // When `dockHeight` is dropped from the reported row the click misses the
    // pill entirely and the drawer stays exactly as it was (mutation M13).
    const after = stripAnsi(t.app.lastFrame() ?? "");
    expect(after).toContain("background · 1");
    expect(after).toContain("find callers of parseConfig");
    t.app.unmount();
  });

  test("a click on the pill with an ATTACH row painted still lands (the row derivation counts the chip row)", async () => {
    const t = await mount(fake({ agents: [AGENT] }));
    await t.keys("/tmp/a.png");
    await delay(150);
    t.app.stdin.write(ENTER);
    await delay(400);
    expect(stripAnsi(t.rawRows().join("\n"))).toContain("📎 a.png");
    const at = pillAt(t.rawRows());
    expect(at.col).toBeGreaterThan(0);
    t.app.stdin.write(press(at.col, at.row));
    await delay(180);
    // The chip row sits INSIDE the input box and shrinks the viewport by one, so
    // it is part of `inputBoxRows` — the row the bar reports. A derivation that
    // forgets it puts the bar one row lower than it paints and the click misses
    // (mutation M14: the frame is 24 rows and nothing opens).
    expect(stripAnsi(t.app.lastFrame() ?? "")).toContain("background · 1");
    t.app.unmount();
  });

  test("a click OUTSIDE the pill's cells does nothing (the range is the pill's, not the bar's)", async () => {
    const t = await mount(fake({ agents: [AGENT] }));
    const at = pillAt(t.rawRows());
    // Column 2 is the bar's far left, nowhere near the pill.
    t.app.stdin.write(press(2, at.row));
    await delay(150);
    expect(stripAnsi(t.app.lastFrame() ?? "")).not.toContain("background · 1");
    t.app.unmount();
  });
});

// Restore the caller's colour level: the rest of the suite must not inherit it.
afterAll(() => {
  chalk.level = level;
});
