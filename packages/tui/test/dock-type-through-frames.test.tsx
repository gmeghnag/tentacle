/**
 * docs/fix/dock-list-type-through.md — the FRAMES of the real `App` with the
 * background dropdown OPEN (the pure machine's side is `background-focus.test.ts`).
 *
 * Owner decision 2026-11-11 (supersedes P3 (a) of `docs/feat/subagent-panel.md`):
 * a printable key at `list` focus moves the focus to the input AND is typed
 * there, the dropdown STAYS VISIBLE, Esc closes it, ↓ goes back into the list,
 * and the stop key is `ctrl+x` twice — no bare `x`/`y` acts in the list, so
 * typing can never arm or confirm a stop. In the PINNED state those keys are the
 * input's, so `ctrl+x` there is the `Ctrl+X Ctrl+S` chord's (never a stop): the
 * stop is ↓ first (Review round 1, M1).
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
const CTRL_S = "\x13";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The successor a fake `sendNow` hands back: a turn that is already over. */
async function* emptyTurn(): AsyncGenerator<{
  readonly type: "turn_end";
  readonly reason: "end_turn";
}> {
  yield { type: "turn_end", reason: "end_turn" };
}

const SHELL_ROW: DockJobRow = {
  id: "bg-3",
  command: "watch: grep -c '### Turno' conversazione.md",
  startedAt: Date.now() - 250_000,
  status: "running",
};

interface DockApi {
  /** `killSubagent` calls — a SEPARATE array from the jobs' (D4/D6 pin the ROUTE, not just "a kill"). */
  readonly killSubagents: string[];
  /** `killJob` calls (`session/job_kill`). */
  readonly killJobs: string[];
  /** `sendNow` calls (the `ctrl+x ctrl+s` chord): the texts of the queued rows it took. */
  readonly sendNows: string[][];
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
  const killSubagents: string[] = [];
  const killJobs: string[] = [];
  const sendNows: string[][] = [];
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
      killSubagents.push(agentId);
      return Promise.resolve({ killed: true });
    },
    killJob(jobId: string) {
      killJobs.push(jobId);
      return Promise.resolve({ killed: true });
    },
    sendNow(messages: readonly { readonly text: string }[]) {
      sendNows.push(messages.map((m) => m.text));
      return Promise.resolve(emptyTurn());
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
    api: { killSubagents, killJobs, sendNows, prompts, aborts: () => aborts },
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
    expect(api.killSubagents).toHaveLength(0);
    expect(api.killJobs).toHaveLength(0);
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
    expect(api.killSubagents).toHaveLength(0);
    expect(api.killJobs).toHaveLength(0);
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
    expect(api.killSubagents).toEqual(["sa-1"]);
    expect(api.killJobs).toHaveLength(0);
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
    // The ROUTE, not just "a kill": the job's RPC, never `killSubagent`.
    expect(api.killJobs).toEqual(["bg-3"]);
    expect(api.killSubagents).toHaveLength(0);
    app.unmount();
  });
});

describe("D7: with the dropdown PINNED (typing), ctrl+x is the INPUT's — never a stop", () => {
  test("`ctrl+x ctrl+x` kills nothing and leaves the chord's behaviour as without a dropdown", async () => {
    // Review round 1, M1. In the pinned state the keys are the input's (the
    // owner's own rule, and what the DOWN table already does), so `ctrl+x` must
    // be the `Ctrl+X Ctrl+S` chord's, exactly as at the bare input: it arms the
    // chord and a second `ctrl+x` merely re-arms. A doubled `ctrl+x` is a
    // fumbled chord at the input — it must not stop a child (whose row was
    // painted CALM, not focused, when the first press landed).
    //
    // MUTATION: `dockClaimsCtrlX` → `state.focus.kind === "list"` again (the
    // shipped bug) + the `typing` + `ctrlX` arm restored → RED (a kill).
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    await openDropdown(app);
    app.stdin.write("hello");
    await delay(50);
    expect(frame()).toContain("↓ list · esc close");
    app.stdin.write(CTRL_X);
    await delay(40);
    app.stdin.write(CTRL_X);
    await delay(60);
    expect(api.killSubagents).toHaveLength(0);
    expect(api.killJobs).toHaveLength(0);
    // Never armed, never swallowed as an arm: the calm rule is still the typing one.
    expect(frame()).not.toContain("stop sa-1?");
    expect(frame()).not.toContain("ctrl+x stop · any other key cancels");
    expect(frame()).toContain("↓ list · esc close");
    // The keys never left the input: the draft is still there, still being edited.
    expect(frame()).toContain("hello");
    app.stdin.write("!");
    await delay(40);
    expect(frame()).toContain("hello!");
    app.unmount();
  });

  test("the chord itself works while pinned: `ctrl+x ctrl+s` sends the queued rows now", async () => {
    // The other half of the same property (M1's scenario 1): the chord is not
    // merely skipped, it FIRES. A held turn + a queued row are what
    // `planSendNow` needs.
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1], running: true });
    app.stdin.write("a long task");
    await delay(30);
    app.stdin.write(ENTER);
    await delay(80);
    app.stdin.write("queued one");
    await delay(30);
    app.stdin.write(ENTER);
    await delay(60);
    expect(frame()).toContain("queued one");
    await openDropdown(app);
    expect(frame()).toContain("background · 1");
    app.stdin.write("typing here");
    await delay(50);
    expect(frame()).toContain("↓ list · esc close");
    app.stdin.write(CTRL_X);
    await delay(40);
    app.stdin.write(CTRL_S);
    await delay(80);
    expect(api.sendNows).toEqual([["queued one"]]);
    expect(api.killSubagents).toHaveLength(0);
    app.unmount();
  });
});

describe("D8: from the PINNED state, ↓ first then ctrl+x twice still stops the child", () => {
  test("the stop is reachable — one ↓ away, with the rule highlighted", async () => {
    // M1's fix must not remove the capability: ↓ puts the keys back on the list
    // (the row focused, the rule saying `ctrl+x stop`), and there the two presses
    // stop it.
    const { app, api, frame } = await mount({ rows: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] });
    await openDropdown(app);
    app.stdin.write("hello");
    await delay(50);
    app.stdin.write(DOWN);
    await delay(50);
    expect(frame()).toContain("enter open · ctrl+x stop · esc back");
    app.stdin.write(CTRL_X);
    await delay(40);
    expect(frame()).toContain("ctrl+x stop · any other key cancels");
    app.stdin.write(CTRL_X);
    await delay(60);
    expect(api.killSubagents).toEqual(["sa-1"]);
    expect(api.killJobs).toHaveLength(0);
    app.unmount();
  });
});
