/**
 * docs/fix/dock-list-type-through.md — the FRAMES of the real `App` with the
 * background dropdown OPEN (the pure machine's side is `background-focus.test.ts`).
 *
 * Owner decision 2026-11-11 (supersedes P3 (a) of `docs/feat/subagent-panel.md`):
 * a printable key at `list` focus moves the focus to the input AND is typed
 * there, the dropdown STAYS VISIBLE, Esc closes it, ↓ goes back into the list,
 * and the stop key is `ctrl+x` twice — no bare `x`/`y` acts in the list, so
 * typing can never arm or confirm a stop.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { App, type SessionController } from "../src/App.tsx";
import type { DockJobRow } from "../src/background-list.ts";
import { renderAt } from "./real-term.tsx";
import { BACKGROUND_ROW, type DockTestRow } from "./subagent-row.ts";

const DOWN = "\u001B[B";
const ESC = "\u001B";
const ENTER = "\r";
const CTRL_X = "\x18";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SHELL_ROW: DockJobRow = {
  id: "bg-3",
  command: "watch: grep -c '### Turno' conversazione.md",
  startedAt: Date.now() - 250_000,
  status: "running",
};

interface DockApi {
  readonly kills: string[];
  readonly prompts: string[];
  readonly aborts: () => number;
}

/** The controller the tests drive: a live list, the kill/a prompt spies, a held turn. */
function fake(opts: {
  readonly rows?: readonly DockTestRow[];
  readonly jobs?: readonly DockJobRow[];
  /** A turn is running: Esc would abort it (the Esc chain must reach the dock first). */
  readonly running?: boolean;
}): { session: SessionController; api: DockApi; jobs: unknown } {
  const listeners = new Set<(rows: readonly DockTestRow[]) => void>();
  const jobListeners = new Set<(r: { rows: readonly DockJobRow[]; count: number }) => void>();
  const jobRows = opts.jobs ?? [];
  const kills: string[] = [];
  const prompts: string[] = [];
  let aborts = 0;
  const session = {
    async *send(text: string) {
      prompts.push(text);
      yield { type: "text", delta: "ok" };
      if (opts.running === true) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5_000);
        });
      }
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue: () => Promise.resolve(),
    onSubagents(listener: (rows: readonly DockTestRow[]) => void) {
      listeners.add(listener);
      listener(opts.rows ?? []);
      return () => listeners.delete(listener);
    },
    onJobs(listener: (r: { rows: readonly DockJobRow[]; count: number }) => void) {
      jobListeners.add(listener);
      listener({ rows: jobRows, count: jobRows.length });
      return () => jobListeners.delete(listener);
    },
    killSubagent(agentId: string) {
      kills.push(agentId);
      return Promise.resolve({ killed: true });
    },
    killJob(jobId: string) {
      kills.push(jobId);
      return Promise.resolve({ killed: true });
    },
    messageSubagent: () => Promise.resolve({ ok: true }),
    ownsTurn: () => true,
    cancel: () => {
      aborts += 1;
      return Promise.resolve();
    },
  } as unknown as SessionController;
  void jobListeners;
  void jobRows;
  return {
    session,
    api: { kills, prompts, aborts: () => aborts },
    jobs: {
      onStart: () => () => {},
      onExit: () => () => {},
      start: () => ({ id: "x", command: "x", startedAt: 0, status: "running", exitCode: null }),
      read: () => undefined,
      kill: () => false,
      list: () => [],
      dispose: () => {},
    },
  };
}

async function mount(
  opts: Parameters<typeof fake>[0],
  columns = 100,
  rows = 24,
): Promise<{ app: ReturnType<typeof renderAt>; api: DockApi; frame: () => string }> {
  const { session, api, jobs } = fake(opts);
  const app = renderAt(
    <App
      createSession={() => session}
      model="qwen3-27b"
      cwd="/tmp/work"
      jobs={jobs as never}
      permissions={new PermissionBroker()}
    />,
    { columns, rows },
  );
  await delay(40);
  return { app, api, frame: app.frame };
}

/** DOWN onto the pill, ENTER into the dropdown (the owner's DOWN table). */
async function openDropdown(app: { stdin: { write(s: string): void } }): Promise<void> {
  app.stdin.write(DOWN);
  await delay(40);
  app.stdin.write(ENTER);
  await delay(50);
}

const lastLine = (frame: string): string =>
  frame
    .split("\n")
    .filter((l) => l.trim() !== "")
    .at(-1) ?? "";

describe("D1: typing with the dropdown open reaches the input and the MAIN agent", () => {
  test("`hello` + Enter sends to the main agent, and the dropdown stays visible", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    await openDropdown(app);
    expect(frame()).toContain("background · 2");
    // The bug (owner, live): every printable key was swallowed here, while the
    // input's own cursor was still on screen — it read as a hang.
    app.stdin.write("hello");
    await delay(60);
    expect(frame()).toContain("hello");
    // The dropdown is STILL there while the user types (owner decision).
    expect(frame()).toContain("background · 2");
    expect(frame()).toContain("sa-1");
    app.stdin.write(ENTER);
    await delay(80);
    // Enter reached the main agent — not a child, not the dock's `open`.
    expect(api.prompts).toEqual(["hello"]);
    expect(api.kills).toHaveLength(0);
    expect(frame()).toContain("background · 2");
    app.unmount();
  });
});

describe("D2: Esc with the dropdown open closes it, and never stops a running turn", () => {
  test("the running turn is untouched; the draft typed during it survives", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1], running: true });
    app.stdin.write("a long task");
    await delay(30);
    app.stdin.write(ENTER); // starts the turn the fake holds open
    await delay(80);
    await openDropdown(app);
    expect(frame()).toContain("background · 1");
    app.stdin.write("and then");
    await delay(50);
    expect(frame()).toContain("and then");
    const before = api.aborts();
    app.stdin.write(ESC);
    await delay(60);
    // Closed: the dropdown is gone, the text is not.
    expect(frame()).not.toContain("background · 1");
    expect(frame()).toContain("and then");
    // The Esc chain stayed honest: the App's "Esc stops the turn" never ran.
    expect(api.aborts()).toBe(before);
    app.unmount();
  });
});

describe("D3: typing `xyz` never arms or stops anything (no bare x/y in the list)", () => {
  test("three letters land in the input; no kill happens", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    await openDropdown(app);
    for (const char of ["x", "y", "z"]) {
      app.stdin.write(char);
      await delay(30);
    }
    const f = frame();
    expect(f).toContain("xyz");
    // Never armed: the confirm's words are nowhere, and nothing was stopped.
    expect(f).not.toContain("stop sa-1?");
    expect(api.kills).toHaveLength(0);
    app.unmount();
  });
});

describe("D4: ctrl+x then ctrl+x stops the selected child", () => {
  test("`killSubagent('sa-1')`, the armed rule naming ctrl+x, and nothing typed", async () => {
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    await openDropdown(app);
    app.stdin.write(CTRL_X);
    await delay(40);
    // The armed rule says what the second ctrl+x will do (its words, not a glyph).
    expect(frame()).toContain("ctrl+x stop · any other key cancels");
    app.stdin.write(CTRL_X);
    await delay(60);
    expect(api.kills).toEqual(["sa-1"]);
    // A ctrl chord is never text: the input is still empty (its placeholder).
    expect(frame()).toContain("❯  Type a task or /command");
    app.unmount();
  });
});

describe("D5: ↓ from the input goes back into the list", () => {
  test("after typing, the dropdown rule offers the list's keys again", async () => {
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    await openDropdown(app);
    app.stdin.write("hello");
    await delay(50);
    // While typing, the rule offers the two keys that concern it.
    expect(frame()).toContain("↓ list · esc close");
    app.stdin.write(DOWN);
    await delay(50);
    // Back in the list: the selection's keys, and the draft is still there.
    expect(frame()).toContain("enter open · ctrl+x stop · esc back");
    expect(frame()).toContain("hello");
    // ↓ moves the selection again.
    app.stdin.write(DOWN);
    await delay(40);
    expect(frame()).toContain("› ● sa-2");
    app.unmount();
  });

  test("↓ inside a MULTI-LINE draft still moves the cursor: the dropdown is not re-entered", async () => {
    // The DOWN table comes first (`resolveLineInput`): a line below the cursor is
    // still a move, so the pinned dropdown waits.
    const { app, frame } = await mount({ rows: [BACKGROUND_ROW.sa1] });
    await openDropdown(app);
    app.stdin.write("one\\");
    await delay(40);
    app.stdin.write(ENTER); // the `\` continuation: a newline, not a submit
    await delay(40);
    app.stdin.write("two");
    await delay(40);
    expect(frame()).toContain("one");
    // UP then DOWN moves inside the buffer; the rule keeps the typing hint, so
    // the list did not take the keys back.
    app.stdin.write("\u001B[A");
    await delay(40);
    app.stdin.write(DOWN);
    await delay(40);
    expect(frame()).toContain("↓ list · esc close");
    app.unmount();
  });
});

describe("D6: the shell job row takes the same ctrl+x twice", () => {
  test("`killJob('bg-3')` — the job's own RPC, by the id's kind", async () => {
    const { app, api } = await mount({ jobs: [SHELL_ROW] });
    await openDropdown(app);
    app.stdin.write(CTRL_X);
    await delay(40);
    app.stdin.write(CTRL_X);
    await delay(60);
    expect(api.kills).toEqual(["bg-3"]);
    app.unmount();
  });
});
