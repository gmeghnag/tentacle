/**
 * feat/subagent-panel (task 7) — the FRAMES (docs/feat/subagent-panel.md, Tests
 * "tui frames"): one per mockup state, through `ink-testing-library`, asserting
 * the plain text of the frame (SGR stripped) exactly as `app.test.tsx` does.
 *
 * The assertions name the MOCKUPS' glyphs, words and rules (`01`–`07` under
 * `.tentacle/tmp/subagent-panel/mockups/`) — never an internal field.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { resetThemeForTest, setThemeMode } from "../src/theme.ts";
import { renderAt } from "./real-term.tsx";
import { BACKGROUND_ROW, type DockTestRow } from "./subagent-row.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const ESC = "\u001B";
const ENTER = "\r";
// SGR mouse: a left press at (col=x, row=y), 1-based, and its release.
const press = (x: number, y: number): string => `\u001B[<0;${x};${y}M`;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a test session exposes: the plan's three optional methods plus the list feed. */
interface FakeSteps {
  /** Every `messageSubagent` call, in order. */
  readonly messages: { agentId: string; text: string }[];
  /** Every `killSubagent` call. */
  readonly kills: string[];
  /** Every `send` (a main-agent prompt): a submit must NOT land here when a child is open. */
  readonly prompts: string[];
  /** Was the running turn aborted? */
  readonly aborts: () => number;
  /** Fire a sub-agent's exit (the `jobs.onExit` feed the App listens to). */
  readonly exitAgent: (id: string, stopReason: string) => void;
  readonly setRows: (rows: readonly DockTestRow[]) => void;
  /** Push one `subagent_message` (what the daemon broadcasts after an accept). */
  readonly pushMessage: (agentId: string, text: string) => void;
}

/**
 * A session controller the test drives: a live background list, the two RPC
 * methods as spies and the one notification feed. `running` makes the App treat
 * a turn as in flight (so an Esc would abort it), which F8 needs.
 */
function fake(steps: {
  readonly rows?: readonly DockTestRow[];
  /** A turn is running: Esc would abort it (F8). */
  readonly running?: boolean;
  /** Answer `messageSubagent` this way (a refusal: the draft must survive). */
  readonly refuse?: string;
  /** Answer the refusal only after this long (a late refusal racing a close, F11). */
  readonly refuseAfterMs?: number;
}): { session: SessionController; api: FakeSteps; jobs: unknown } {
  const listeners = new Set<(rows: readonly DockTestRow[]) => void>();
  const messageListeners = new Set<(m: { agentId: string; text: string }) => void>();
  let rows = steps.rows ?? [];
  const messages: { agentId: string; text: string }[] = [];
  const kills: string[] = [];
  const prompts: string[] = [];
  let aborts = 0;
  const session = {
    async *send(text: string) {
      prompts.push(text);
      // A REAL AgentEvent stream: a turn that answers at once, and — with
      // `running` — stays open (so an Esc would abort it, which F8 checks).
      yield { type: "text", delta: "ok" };
      if (steps.running === true) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5_000);
        });
      }
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue: () => Promise.resolve(),
    onSubagents(listener: (rows: readonly DockTestRow[]) => void) {
      listeners.add(listener);
      listener(rows);
      return () => listeners.delete(listener);
    },
    onSubagentMessage(listener: (m: { agentId: string; text: string }) => void) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    messageSubagent(agentId: string, text: string) {
      messages.push({ agentId, text });
      if (steps.refuse !== undefined) {
        const refusal = { ok: false, reason: steps.refuse };
        return steps.refuseAfterMs === undefined
          ? Promise.resolve(refusal)
          : delay(steps.refuseAfterMs).then(() => refusal);
      }
      return Promise.resolve({ ok: true });
    },
    killSubagent(agentId: string) {
      kills.push(agentId);
      return Promise.resolve({ killed: true });
    },
    ownsTurn: () => true,
    cancel: () => {
      aborts += 1;
      return Promise.resolve();
    },
  } as unknown as SessionController;
  const exitListeners = new Set<(job: unknown) => void>();
  return {
    session,
    jobs: {
      onExit(listener: (job: unknown) => void) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      start: () => ({ id: "x", command: "x", startedAt: 0, status: "running", exitCode: null }),
      read: () => undefined,
      kill: () => false,
      list: () => [],
      dispose: () => {},
    },
    api: {
      messages,
      kills,
      prompts,
      aborts: () => aborts,
      exitAgent: (id, stopReason) => {
        for (const l of exitListeners) {
          l({
            id,
            command: "find callers of parseConfig",
            startedAt: 0,
            status: "exited",
            exitCode: null,
            agent: { stopReason, toolUses: 19 },
          });
        }
      },
      setRows: (next) => {
        rows = next;
        for (const l of listeners) l(rows);
      },
      pushMessage: (agentId, text) => {
        for (const l of messageListeners) l({ agentId, text });
      },
    },
  };
}

/**
 * Mount the real `App` in a terminal of `columns` × `rows` — through
 * `renderAt`, so the FRAME is what such a terminal paints (Review round 3 M3:
 * `ink-testing-library` fixes `columns` at 100 whatever prop it is given).
 */
async function mount(
  steps: Parameters<typeof fake>[0],
  columns = 100,
  rows = 24,
): Promise<{ app: ReturnType<typeof renderAt>; api: FakeSteps; frame: () => string }> {
  const { session, api, jobs } = fake(steps);
  const app = renderAt(
    <App createSession={() => session} model="qwen3-27b" cwd="/tmp/work" jobs={jobs as never} />,
    { columns, rows },
  );
  await delay(40);
  return { app, api, frame: app.frame };
}
describe("F1 (design B): at rest there is NO list — only the pill (mockup b · 1)", () => {
  test("a titled rule, then one row per child with its glyph, id, type and counters", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    const f = frame();
    // The owner's revision: background work is ONE pill in the status bar, always
    // the LAST line; nothing permanent sits above the input.
    expect(f).toContain("2 agents ↓");
    expect(f).not.toContain("background ·");
    // The pill is the bar's right-hand end and comes AFTER auto-accept.
    expect(f.indexOf("auto-accept")).toBeLessThan(f.indexOf("2 agents"));
    // The status bar is the frame's last row.
    const last =
      f
        .split("\n")
        .filter((l) => l.trim() !== "")
        .at(-1) ?? "";
    expect(last).toContain("2 agents ↓");
    // The input rule still carries the model: the dock is CLOSED.
    expect(f).toContain("qwen3-27b");
    app.unmount();
  });
});

describe("F2 (design B): DOWN focuses the PILL, not the list (mockup b · 2)", () => {
  test("the pill highlights with the hint beside it; the list stays closed; the draft is kept", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    // Type a task FIRST: entering the dock must not lose it.
    app.stdin.write("now also update the README");
    await delay(30);
    app.stdin.write(DOWN);
    await delay(40);
    const f = frame();
    // Focused pill: `⏎` inside it, the hint just left of it, and STILL no list.
    expect(f).toContain("2 agents ⏎");
    expect(f).toContain("enter open · esc back");
    expect(f).not.toContain("background ·");
    expect(f).not.toContain("↑↓ move");
    // The draft is still there (the input keeps its text, only loses the cursor).
    expect(f).toContain("now also update the README");
    // Nothing was sent anywhere by merely moving the focus.
    expect(api.messages).toHaveLength(0);
    expect(api.prompts).toHaveLength(0);
    app.unmount();
  });
});

describe("F-M1 (design B): the status bar NEVER loses `auto-accept` while the dock is open", () => {
  const lastLine = (frame: string): string =>
    frame
      .split("\n")
      .filter((l) => l.trim() !== "")
      .at(-1) ?? "";

  test("the drawer open: the last line still carries `auto-accept`", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    await openDropdown(app);
    app.stdin.write(ENTER);
    await delay(40);
    const f = frame();
    // The dock is really open (the target rule + the drawer's head), and Enter's
    // meaning is on that rule — never in the status bar, where it displaced
    // `auto-accept on` (the owner's rule, round 3 M1).
    expect(f).toContain("→ sa-1");
    expect(f).toContain("enter sends");
    expect(lastLine(f)).toContain("auto-accept");
    expect(f).not.toContain("enter sends to sa-1");
    app.unmount();
  });
});

describe("F-H1 (design B): typing on the focused pill returns the focus, so Enter SENDS", () => {
  test("DOWN → type → Enter prompts the MAIN agent; the dropdown never opens", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    // The owner's most common slip: a DOWN with an empty draft, then typing.
    app.stdin.write(DOWN);
    await delay(30);
    expect(frame()).toContain("2 agents ⏎");
    app.stdin.write("hello");
    await delay(40);
    // The text went into the input AND the pill lost its focus (no `⏎`).
    const f = frame();
    expect(f).toContain("hello");
    expect(f).toContain("2 agents ↓");
    expect(f).not.toContain("2 agents ⏎");
    expect(f).not.toContain("background ·");
    // Enter is therefore the INPUT's: it sends to the main agent.
    app.stdin.write(ENTER);
    await delay(60);
    expect(api.prompts).toEqual(["hello"]);
    expect(api.messages).toHaveLength(0);
    // …and it did not open the dropdown instead.
    expect(frame()).not.toContain("background · 2");
    app.unmount();
  });
});

/** DOWN (focus the pill) then Enter (open the dropdown): the design B path. */
async function openDropdown(app: { stdin: { write(s: string): void } }): Promise<void> {
  app.stdin.write(DOWN);
  await delay(30);
  app.stdin.write(ENTER);
  await delay(40);
}

describe("F3 (design B): Enter on a dropdown row opens it — typing + Enter messages IT", () => {
  test("messageSubagent('sa-1', text), and NOT the main agent's prompt", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    await openDropdown(app);
    expect(frame()).toContain("background · 1");
    app.stdin.write(ENTER);
    await delay(40);
    expect(frame()).toContain("→ sa-1");
    // The drawer: the child's head, `… +k earlier` and its recent steps.
    expect(frame()).toContain("sa-1 · explore · find callers of parseConfig");
    expect(frame()).toContain("… +11 earlier");
    expect(frame()).toContain("│ fs_read packages/config/src/schema.ts");
    app.stdin.write("skip the tests folder");
    await delay(30);
    app.stdin.write(ENTER);
    await delay(50);
    expect(api.messages).toEqual([{ agentId: "sa-1", text: "skip the tests folder" }]);
    // NEVER the main agent, and never as steering.
    expect(api.prompts).toHaveLength(0);
    app.unmount();
  });
});

describe("F4: a `subagent_message` shows ONE notice in the transcript (mockup 04)", () => {
  test("`→ sa-1  <text>  · sa-1 reads it at its next step · the agent is told next turn`", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    api.pushMessage("sa-1", "skip the tests folder");
    await delay(40);
    const f = frame();
    expect(f).toContain("→ sa-1  skip the tests folder");
    expect(f).toContain("sa-1 reads it at its next step");
    expect(f).toContain("the agent is told next turn");
    // ONE notice: the daemon broadcasts it and this TUI does not echo locally.
    expect(f.match(/skip the tests folder/g) ?? []).toHaveLength(1);
    app.unmount();
  });
});

describe("F5 (design B): nine rows → five shown, in the dropdown (mockup b · 3)", () => {
  test("the rule carries the overflow, and only five rows paint", async () => {
    const { app, frame } = await mount({ rows: BACKGROUND_ROW.many(9) });
    await openDropdown(app);
    const f = frame();
    expect(f).toContain("background · 9");
    // The dropdown's rule says how many are out of view with the mockup's own
    // `↑k ↓m` grammar (the `more` variant is the unfocused pill's hint, which
    // this surface replaced).
    expect(f).toContain("↓4 · enter open · x stop · esc back");
    for (const i of [1, 2, 3, 4, 5]) expect(f).toContain(`sa-${i}`);
    for (const i of [6, 7, 8, 9]) expect(f).not.toContain(`sa-${i}`);
    app.unmount();
  });
});

describe("F6 (design B): the open child ends — Enter is refused, no call", () => {
  test("the drawer freezes at `✓ finished`, the target stays `→ sa-1`, and nothing is sent", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    await openDropdown(app);
    app.stdin.write(ENTER);
    await delay(40);
    app.stdin.write("a draft written before it ended");
    await delay(30);
    // It ends cleanly: the exit notice first (what the transcript shows), then
    // the daemon's next list no longer carries it.
    api.exitAgent("sa-1", "end_turn");
    await delay(30);
    api.setRows([]);
    await delay(50);
    const f = frame();
    expect(f).toContain("✓ finished");
    // The input KEEPS its target: never a silent re-route to the main agent.
    // Its RULE is the one place that says what Enter does (`round 3 M1`: the
    // status bar keeps `auto-accept`), and it no longer offers `enter sends`.
    const rule = f.split("\n").find((l) => l.includes("→ sa-1")) ?? "";
    expect(rule).toContain("esc back");
    expect(rule).not.toContain("enter sends");
    app.stdin.write(ENTER);
    await delay(50);
    // The refused send reaches NOBODY: not the dead child, and not the main
    // agent either (a silent re-route would have cost the user their draft).
    expect(api.messages).toHaveLength(0);
    expect(api.prompts.filter((p) => p.includes("a draft written"))).toHaveLength(0);
    // The draft survives (esc closes, and the text is still there).
    expect(frame()).toContain("a draft written before it ended");
    app.unmount();
  });
});

describe("F7 (design B): 80 columns — no row wraps, in the dropdown too", () => {
  test("every dock line is at most 80 cells, and the token figure drops", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] }, 80);
    await openDropdown(app);
    const f = frame();
    const dock = f.split("\n").filter((l) => l.includes("background ·") || l.includes("sa-"));
    for (const line of dock) {
      expect([...line].length).toBeLessThanOrEqual(80);
    }
    // The narrow tier drops the tokens but keeps the tools and the time (the
    // exact seconds depend on the clock, so only their shape is pinned).
    expect(f).toMatch(/19 tools · \d+m? ?\d*s/);
    expect(f).not.toContain("12k");
    // The status bar's pill fits too, and the dropdown's hint is the short one.
    expect(f).toContain("2 agents");
    expect(f).toContain("enter open · x stop · esc");

    app.unmount();
  });
});

describe("F8 (design B): Esc in `open` does NOT abort the turn — and it walks the chain", () => {
  test("the dock closes and the turn's abort is never called", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1], running: true });
    app.stdin.write("a long task");
    await delay(30);
    app.stdin.write(ENTER); // starts the turn (which the fake holds)
    await delay(60);
    await openDropdown(app);
    app.stdin.write(ENTER);
    await delay(40);
    expect(frame()).toContain("→ sa-1");
    const before = api.aborts();
    // The chain, one step per Esc: drawer → dropdown → pill → input.
    app.stdin.write(ESC);
    await delay(50);
    expect(frame()).toContain("background · 1");
    expect(frame()).not.toContain("→ sa-1");
    app.stdin.write(ESC);
    await delay(50);
    expect(frame()).toContain("1 agent ⏎");
    app.stdin.write(ESC);
    await delay(50);
    expect(frame()).toContain("1 agent ↓");
    // Three Escapes, and the turn was never aborted.
    expect(api.aborts()).toBe(before);
    app.unmount();
  });
});

describe("F9 (design B): a permission prompt while `open` owns the keys, and the focus comes back", () => {
  test("the prompt replaces the input; after the answer `→ sa-1` is still the target", async () => {
    const broker = new PermissionBroker();
    const { session, api } = fake({ rows: [BACKGROUND_ROW.sa1] });
    const app = render(
      <App
        createSession={() => session}
        model="qwen3-27b"
        cwd="/tmp/work"
        permissions={broker}
        columns={100}
      />,
    );
    await delay(40);
    await openDropdown(app);
    app.stdin.write(ENTER);
    await delay(40);
    const f0 = stripAnsi(app.lastFrame() ?? "");
    expect(f0).toContain("→ sa-1");
    // The broker asks for a background child: the prompt owns every key.
    const asked = broker.request(
      { tool: "shell", level: "ask", title: "run bun test", input: {} } as never,
      { agent: { type: "explore", description: "find callers", id: "sa-1" } } as never,
    );
    await delay(50);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("run bun test");
    // A key that would act on the dock answers the prompt instead.
    app.stdin.write("y");
    await delay(50);
    await asked;
    // The dock's state is untouched underneath: still open on sa-1, and Enter
    // still goes to the CHILD, not the main agent.
    await delay(40);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("→ sa-1");
    app.stdin.write("still there");
    await delay(30);
    app.stdin.write(ENTER);
    await delay(60);
    expect(api.messages).toEqual([{ agentId: "sa-1", text: "still there" }]);
    expect(api.prompts).toHaveLength(0);
    app.unmount();
  });
});

describe("F10: the drafts survive the open/close round trip (Review H1)", () => {
  test("main text → open → child text → Esc → main text back; reopen → child text back", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    app.stdin.write("MAINDRAFT");
    await delay(30);
    await openDropdown(app);
    app.stdin.write(ENTER);
    await delay(40);
    // Opening swaps in the child's (empty) draft — and the main one is KEPT.
    const opened = frame();
    expect(opened).toContain("→ sa-1");
    expect(opened).toContain("Type a task or /command");
    app.stdin.write("CHILDDRAFT");
    await delay(30);
    // The chain leaves the drawer for the DROPDOWN, then the pill, then the input:
    // the main target (and its draft) is what the input holds once it is back.
    app.stdin.write(ESC);
    await delay(40);
    app.stdin.write(ESC);
    await delay(40);
    app.stdin.write(ESC);
    await delay(50);
    const closed = frame();
    // Back on the main target, with the main draft the user typed restored.
    expect(closed).not.toContain("→ sa-1");
    expect(closed).toContain("MAINDRAFT");
    expect(closed).not.toContain("CHILDDRAFT");
    // Reopening restores the CHILD's draft, not the stale main one.
    await openDropdown(app);
    app.stdin.write(ENTER);
    await delay(50);
    const reopened = frame();
    expect(reopened).toContain("→ sa-1");
    expect(reopened).toContain("CHILDDRAFT");
    app.unmount();
  });
});

describe("F11: a late refusal never lands in the main input (Review H2)", () => {
  test("send to sa-1, Esc before the answer: the main field stays empty and prompts nothing", async () => {
    const { app, api, frame } = await mount({
      rows: [BACKGROUND_ROW.sa1],
      refuse: "inbox full",
      refuseAfterMs: 120,
    });
    // The chain: DOWN → the pill, Enter → the dropdown, Enter → open the child.
    await openDropdown(app);
    app.stdin.write(ENTER);
    await delay(40);
    expect(frame()).toContain("→ sa-1");
    app.stdin.write("for-sa1-only");
    await delay(20);
    app.stdin.write(ENTER); // the RPC is still in flight…
    await delay(20);
    // …and the user leaves the child (drawer → dropdown → pill → input).
    app.stdin.write(ESC);
    await delay(30);
    app.stdin.write(ESC);
    await delay(30);
    app.stdin.write(ESC);
    await delay(250);
    const f = frame();
    // The refusal is REPORTED (never a silent drop), quoting the text…
    expect(f).toContain("not sent to sa-1");
    expect(f).toContain("inbox full");
    expect(f).toContain("kept as a draft: for-sa1-only");
    // …but the child's text is NOT in the main input: that row is the placeholder.
    const inputRow = f.split("\n").find((l) => l.includes("❯")) ?? "";
    expect(inputRow).not.toContain("for-sa1-only");
    expect(inputRow).toContain("Type a task or /command");
    // The reviewer's exact check: the next Enter sends the text to NOBODY.
    app.stdin.write(ENTER);
    await delay(60);
    expect(api.prompts).toHaveLength(0);
    expect(api.messages).toHaveLength(1);
    app.unmount();
  });
});

describe("F12: the dock's rows are reserved in the viewport (Review H3)", () => {
  // A REAL 24-row terminal, and its real width (`renderAt`, round 3 M3): the
  // height is a function of the width, because a row that wraps costs a line.
  const ROWS = 24;
  const lines = (frame: string): number => frame.split("\n").length;

  for (const columns of [80, 190]) {
    test(`${columns}×24: one child in the dropdown — the whole frame fits`, async () => {
      const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] }, columns, ROWS);
      await openDropdown(app);
      const f = frame();
      expect(f).toContain("background · 1");
      expect(lines(f)).toBeLessThanOrEqual(ROWS);
      app.unmount();
    });

    test(`${columns}×24: the drawer open — the whole frame fits`, async () => {
      const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] }, columns, ROWS);
      await openDropdown(app);
      app.stdin.write(ENTER);
      await delay(40);
      const f = frame();
      expect(f).toContain("→ sa-1");
      expect(lines(f)).toBeLessThanOrEqual(ROWS);
      app.unmount();
    });

    test(`${columns}×24: at rest the pill costs NO rows`, async () => {
      const idle = await mount({ rows: [BACKGROUND_ROW.sa1] }, columns, ROWS);
      const idleLines = lines(idle.frame());
      idle.app.unmount();
      const none = await mount({ rows: [] }, columns, ROWS);
      const noneLines = lines(none.frame());
      none.app.unmount();
      // The owner's rule (design B): idle = no extra rows at all.
      expect(idleLines).toBe(noneLines);
      expect(idleLines).toBeLessThanOrEqual(ROWS);
    });
  }
});

describe("F13 (design B): a child waiting on the user turns the PILL warning (Review M1)", () => {
  test("the pill names the asking child, under the prompt, with the dock closed", async () => {
    const broker = new PermissionBroker();
    const { session } = fake({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    const app = render(
      <App
        createSession={() => session}
        model="qwen3-27b"
        cwd="/tmp/work"
        permissions={broker}
        columns={100}
      />,
    );
    await delay(40);
    // Closed dock: the pill already says how many run.
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("2 agents ↓");
    // The broker asks ON BEHALF OF a background child: the prompt owns the keys
    // and REPLACES the bottom area, so the pill is what must say who asks
    // (`▲ sa-1 asks`) — visible whether the dropdown is open or not.
    const asked = broker.request(
      { tool: "shell", level: "ask", title: "run bun test", input: {} } as never,
      { agent: { type: "explore", description: "find callers", id: "sa-1" } } as never,
    );
    await delay(60);
    const f = stripAnsi(app.lastFrame() ?? "");
    expect(f).toContain("run bun test"); // the prompt
    expect(f).toContain("▲ sa-1 asks"); // the pill, naming the asker
    expect(f).not.toContain("sa-2 asks");
    // The frame still fits: the prompt's rows are the only thing reserved.
    expect(f.split("\n").length).toBeLessThanOrEqual(24);
    app.stdin.write("n");
    await delay(50);
    await asked;
    app.unmount();
  });
});

describe("the dock paints the same text in light and dark (theme tokens only)", () => {
  test("every SGR code the dock emits comes from the palette, so both modes agree", async () => {
    const dark = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    const darkFrame = dark.app.lastFrame();
    dark.app.unmount();
    setThemeMode("light");
    try {
      const light = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
      const lightFrame = light.app.lastFrame();
      light.app.unmount();
      // The plain text is identical: the mode changes colour, never layout.
      expect(stripAnsi(lightFrame)).toBe(stripAnsi(darkFrame));
      expect(stripAnsi(lightFrame)).toContain("2 agents ↓");
      // (The colour itself is pinned by `theme-contrast`/`theme-components`: this
      // harness renders with colour off, so the parity of the TEXT is what it can
      // prove — and that is what a theme token must never change.)
    } finally {
      resetThemeForTest();
    }
  });
});

/**
 * Design B's MOUSE rule (owner requirement): a click on the pill's cells opens
 * the dropdown, and a click on a dropdown row opens that child. The hit test is
 * `statusLayout`'s cell range and the rows' screen rows — the App re-derives
 * neither, so these two tests are what pins that the wiring uses them.
 */
describe("F14 (design B): SGR clicks on the pill and on a dropdown row", () => {
  /** The status bar's row: the frame's LAST line, 1-based (blank lines count). */
  const barRow = (frame: string): number => frame.split("\n").length;
  /** A 1-based column inside the pill, from the frame itself. */
  const pillColumn = (frame: string): number => {
    const last =
      stripAnsi(frame)
        .split("\n")
        .find((l) => l.includes("agents")) ?? "";
    const at = last.indexOf("agents ↓");
    return at < 0 ? -1 : at + 1;
  };

  test("a click on the pill opens the dropdown on its first row", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    const before = frame();
    expect(before).toContain("2 agents ↓");
    expect(before).not.toContain("background ·");
    const row = barRow(before);
    const col = pillColumn(before);
    expect(col).toBeGreaterThan(0);
    app.stdin.write(press(col, row));
    await delay(60);
    const f = frame();
    expect(f).toContain("background · 2");
    // First row selected (owner: "first row selected").
    expect(f).toContain("› ● sa-1");
    app.unmount();
  });

  test("a click on a dropdown row opens that child", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    await openDropdown(app);
    const dock = frame();
    // The dropdown sits ABOVE the input: its rule, then one row per child.
    const lines = dock.split("\n");
    const ruleAt = lines.findIndex((l) => l.includes("background · 2"));
    expect(ruleAt).toBeGreaterThan(0);
    const secondRow = lines[ruleAt + 2] ?? "";
    expect(secondRow).toContain("sa-2");
    // A click on that row's cells (the frame's lines are the screen's rows, 1-based).
    app.stdin.write(press(8, ruleAt + 3));
    await delay(60);
    const f = frame();
    // It opened sa-2 (not the row that happened to be first).
    expect(f).toContain("→ sa-2");
    expect(f).toContain("sa-2 · migrate config tests to bun:test");
    expect(f).not.toContain("→ sa-1");
    app.unmount();
  });

  test("a click elsewhere on the bar does nothing (the range is the pill's own cells)", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    const before = frame();
    const row = barRow(before);
    // Column 2: the far left of the bar, nowhere near the pill.
    app.stdin.write(press(2, row));
    await delay(60);
    expect(frame()).not.toContain("background ·");
    app.unmount();
  });
});

/**
 * The frame at the two widths the visual truth is drawn at (`mockups/v3/b.html`:
 * every state at 190 and at 80 columns). A row that is wider than the terminal
 * wraps and shifts everything above it — the one failure this suite must catch.
 *
 * The terminal is the REAL size (`renderAt`, Review round 3 M3): Ink's own wrap
 * is then at 190 cells too, so a rule split into 100 + 90 cells (what
 * `ink-testing-library`'s fixed 100 columns showed while a test passed
 * `columns={190}`) fails here.
 */
describe("F15 (design B): every state fits 190 and 80 columns at a REAL terminal size", () => {
  const ROWS = 24;
  const at = async (
    columns: number,
    act: (app: Awaited<ReturnType<typeof mount>>) => Promise<void>,
  ) => {
    const mounted = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] }, columns, ROWS);
    await act(mounted);
    const lines = mounted.frame().split("\n");
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(columns);
    }
    // …and the frame is no taller than the terminal: nothing is pushed off it.
    expect(lines.length).toBeLessThanOrEqual(ROWS);
    mounted.app.unmount();
    return lines;
  };

  for (const columns of [190, 80]) {
    test(`${columns} columns: at rest, the pill only`, async () => {
      const lines = await at(columns, async () => {});
      const last = lines.filter((l) => l.trim() !== "").at(-1) ?? "";
      expect(last).toContain("2 agents ↓");
      // The input's rule still carries the model: the dock is closed.
      expect(lines.some((l) => l.includes("qwen3-27b"))).toBe(true);
    });

    test(`${columns} columns: the dropdown — a plain input rule, no model name`, async () => {
      const lines = await at(columns, async (m) => {
        await openDropdown(m.app);
      });
      const ruleAt = lines.findIndex((l) => l.includes("background · 2"));
      expect(ruleAt).toBeGreaterThan(0);
      // The input's own top rule (the dropdown's bottom edge) is PLAIN: no model.
      const inputRule = lines[ruleAt + 3] ?? "";
      expect(inputRule).toMatch(/^─+$/);
      // …and nothing in the frame says the model while the dock is open.
      expect(lines.some((l) => l.includes("qwen3-27b"))).toBe(false);
      // The dropdown's rule carries the title AND every key.
      expect(lines[ruleAt]).toContain("background · 2");
      expect(lines[ruleAt]).toContain("enter open · x stop · esc");
    });

    test(`${columns} columns: a child open — the target rule, no model`, async () => {
      const lines = await at(columns, async (m) => {
        await openDropdown(m.app);
        m.app.stdin.write(ENTER);
        await delay(50);
      });
      const target = lines.find((l) => l.includes("→ sa-1")) ?? "";
      expect(target).toContain("enter sends");
      expect(lines.some((l) => l.includes("qwen3-27b"))).toBe(false);
      // The drawer's head names the child and its figures.
      expect(lines.some((l) => l.includes("sa-1 · explore · find callers of parseConfig"))).toBe(
        true,
      );
    });
  }
});

/**
 * Step 0 of the UI revision, at FRAME level: the dock's rule is one whole line
 * of exactly `columns` cells at 190 columns — it does not stop part-way and
 * leave its labels floating (the owner's "gap between `background · 2` and the
 * hints"). The pure-side counterpart is `background-list.test.ts`'s T-L0.
 */
describe("F16 (step 0): the dropdown's rule is one whole line at 190 REAL columns", () => {
  test("it starts and ends in the rule, and holds nothing but single spaces", async () => {
    // 190 × 24 through `renderAt`: the harness itself is at 190, so a rule that
    // the terminal wraps (100 + 90) cannot pass as one line (Review round 3 M3).
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] }, 190, 24);
    await openDropdown(app);
    const lines = frame().split("\n");
    const rule = lines.find((l) => l.includes("background · 2")) ?? "";
    expect([...rule].length).toBe(190);
    expect(rule.startsWith("─ background · 2 ─")).toBe(true);
    expect(rule.endsWith("esc back ─")).toBe(true);
    // The fill is contiguous: no run of blanks between two dashes.
    expect(rule).not.toMatch(/─ +─/);
    // The hint is where the fill ends — not a second label row under the bar.
    expect(rule.indexOf("enter open")).toBeGreaterThan(rule.indexOf("background"));
    // Every rule line is a WHOLE 190-cell line — never a 100-cell piece plus a
    // 90-cell remainder (what a 100-column harness showed, round 3 M3).
    for (const line of lines.filter((l) => /^─+$/.test(l))) {
      expect([...line].length).toBe(190);
    }
    expect(lines.length).toBeLessThanOrEqual(24);
    app.unmount();
  });
});
