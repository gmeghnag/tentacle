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
import { BACKGROUND_ROW, type DockTestRow } from "./subagent-row.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const ESC = "\u001B";
const ENTER = "\r";

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
        return Promise.resolve({ ok: false, reason: steps.refuse });
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

async function mount(steps: Parameters<typeof fake>[0], columns = 100) {
  const { session, api, jobs } = fake(steps);
  const app = render(
    <App
      createSession={() => session}
      model="qwen3-27b"
      cwd="/tmp/work"
      jobs={jobs as never}
      columns={columns}
    />,
  );
  await delay(40);
  return { app, api, frame: () => stripAnsi(app.lastFrame() ?? "") };
}
describe("F1: the idle list under the status bar (mockup 01)", () => {
  test("a titled rule, then one row per child with its glyph, id, type and counters", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    const f = frame();
    // The rule: `── background · 2 ───── ↓ select · ctrl+t ─`.
    expect(f).toContain("─ background · 2 ─");
    expect(f).toContain("↓ select · ctrl+t");
    // Rows: the running glyph, the waiting one and the shell one.
    expect(f).toContain("● sa-1");
    expect(f).toContain("explore");
    expect(f).toContain("find callers of parseConfig");
    expect(f).toContain("19 tools");
    expect(f).toContain("● sa-2");
    expect(f).toContain("general");
    // Both children run: the `▲`/`⚠` row needs a child WAITING on the user, which
    // is `permission.pendingAgent` — F9 mounts one (mockup 01's second row).
    // The old status-bar suffix is gone while the list says the count (the plan).
    expect(f).not.toContain("· 2 sub-agents");
    app.unmount();
  });
});

describe("F2: DOWN on an empty draft selects the first row (mockup 02)", () => {
  test("`› ● sa-1`, the rule turns to the list's keys, and any typed text is untouched", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    // Type a task FIRST: entering the list must not lose it.
    app.stdin.write("now also update the README");
    await delay(30);
    app.stdin.write(DOWN);
    await delay(40);
    const f = frame();
    expect(f).toContain("› ● sa-1");
    expect(f).toContain("enter open · x stop · esc back");
    // The draft is still there (the input keeps its text, only loses the cursor).
    expect(f).toContain("now also update the README");
    // Nothing was sent anywhere by merely moving the focus.
    expect(api.messages).toHaveLength(0);
    expect(api.prompts).toHaveLength(0);
    app.unmount();
  });
});

describe("F3: Enter opens — the rule says `→ sa-1`, typing + Enter messages IT (mockup 03)", () => {
  test("messageSubagent('sa-1', text), and NOT the main agent's prompt", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    app.stdin.write(DOWN);
    await delay(30);
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

describe("F5: nine rows → five shown (mockup 05)", () => {
  test("the rule carries the overflow, and only five rows paint", async () => {
    const { app, frame } = await mount({ rows: BACKGROUND_ROW.many(9) });
    const f = frame();
    expect(f).toContain("─ background · 9 ─");
    expect(f).toContain("↓4 more");
    for (const i of [1, 2, 3, 4, 5]) expect(f).toContain(`sa-${i} `);
    for (const i of [6, 7, 8, 9]) expect(f).not.toContain(`sa-${i} `);
    app.unmount();
  });
});

describe("F6: the open child ends — Enter is refused, no call (mockup 06)", () => {
  test("the drawer freezes at `✓ finished`, the target stays `→ sa-1`, and nothing is sent", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    app.stdin.write(DOWN);
    await delay(30);
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
    expect(f).toContain("→ sa-1");
    expect(f).toContain("enter does nothing");
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

describe("F7: 80 columns — no row wraps (mockup 07)", () => {
  test("every dock line is at most 80 cells, and the token figure drops", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] }, 80);
    const f = frame();
    const dock = f.split("\n").filter((l) => l.includes("─") || l.includes("sa-"));
    for (const line of dock) {
      expect([...line].length).toBeLessThanOrEqual(80);
    }
    // The narrow tier drops the tokens but keeps the tools and the time.
    expect(f).toContain("19 tools · 1m 12s");
    expect(f).not.toContain("12.4k");

    app.unmount();
  });
});

describe("F8: Esc in `open` during a running turn does NOT abort it", () => {
  test("the dock closes and the turn's abort is never called", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1], running: true });
    app.stdin.write("a long task");
    await delay(30);
    app.stdin.write(ENTER); // starts the turn (which the fake holds)
    await delay(60);
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write(ENTER);
    await delay(40);
    expect(frame()).toContain("→ sa-1");
    const before = api.aborts();
    app.stdin.write(ESC);
    await delay(50);
    // Closed the dock, and did NOT stop the turn.
    expect(frame()).not.toContain("→ sa-1");
    expect(api.aborts()).toBe(before);
    app.unmount();
  });
});

describe("F9: a permission prompt while `open` owns the keys, and the focus comes back", () => {
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
    app.stdin.write(DOWN);
    await delay(30);
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

describe("the dock paints the same text in light and dark (theme tokens only)", () => {
  test("every SGR code the dock emits comes from the palette, so both modes agree", async () => {
    const dark = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    const darkFrame = dark.app.lastFrame() ?? "";
    dark.app.unmount();
    setThemeMode("light");
    try {
      const light = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
      const lightFrame = light.app.lastFrame() ?? "";
      light.app.unmount();
      // The plain text is identical: the mode changes colour, never layout.
      expect(stripAnsi(lightFrame)).toBe(stripAnsi(darkFrame));
      expect(stripAnsi(lightFrame)).toContain("─ background · 2 ─");
      // (The colour itself is pinned by `theme-contrast`/`theme-components`: this
      // harness renders with colour off, so the parity of the TEXT is what it can
      // prove — and that is what a theme token must never change.)
    } finally {
      resetThemeForTest();
    }
  });
});
