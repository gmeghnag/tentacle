/**
 * docs/feat/shell-jobs-panel.md — the FRAMES of the real `App` with a running
 * background SHELL JOB, at real widths (190 and 80 columns through `renderAt`,
 * so Ink itself wraps at that size: a `columns` prop with a 100-column stdout
 * proves nothing — Review round 3, M3).
 *
 * Owner answers baked in: Q4 (b) — ONE merged output, as the model sees it;
 * Q5 (b) — `bg-N` everywhere, no `sh-N` alias; Q1 (a) — a job's drawer leaves the
 * input on the MAIN agent, so its rule is plain.
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The mockup's job row (gen-v3.ts:236), with the wire's own `bg-` id. */
const SHELL_ROW: DockJobRow = {
  id: "bg-3",
  command: "watch: grep -c '### Turno' conversazione.md",
  startedAt: Date.now() - 250_000,
  status: "running",
};

const extraJobs = (n: number): DockJobRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `bg-${i + 1}`,
    command: `job ${i + 1}`,
    startedAt: Date.now() - 60_000,
    status: "running",
  }));

interface JobApi {
  readonly reads: { jobId: string; at: number }[];
  readonly kills: string[];
  readonly prompts: string[];
  readonly rows: () => readonly DockJobRow[];
  readonly setJobs: (rows: readonly DockJobRow[]) => void;
  readonly exitJob: (id: string, status: "exited" | "killed", exitCode: number | null) => void;
  readonly readsOf: (id: string) => number;
}

/**
 * A session controller the test drives: the live job list, the two RPC methods
 * as spies, and NO `jobOutput` when `noOutput` (the older-daemon case, F7).
 */
function fake(opts: {
  readonly jobs?: readonly DockJobRow[];
  readonly agents?: readonly DockTestRow[];
  readonly noOutput?: boolean;
  /** The drawer's read answers this output (default: the mockup's three lines). */
  readonly output?: readonly string[];
  /** The read says the buffer dropped older output (the `… earlier` row). */
  readonly truncated?: boolean;
}): { session: SessionController; api: JobApi; jobs: unknown } {
  const jobListeners = new Set<(r: { rows: readonly DockJobRow[]; count: number }) => void>();
  let rows = opts.jobs ?? [];
  const reads: { jobId: string; at: number }[] = [];
  /** The exits this test fired: a later read answers what the daemon's would. */
  const exits = new Map<string, { status: string; exitCode: number | null }>();
  const kills: string[] = [];
  const prompts: string[] = [];

  const session = {
    async *send(text: string) {
      prompts.push(text);
      yield { type: "text", delta: "ok" };
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue: () => Promise.resolve(),
    onSubagents(listener: (next: readonly DockTestRow[]) => void) {
      listener(opts.agents ?? []);
      return () => {};
    },
    onJobs(listener: (r: { rows: readonly DockJobRow[]; count: number }) => void) {
      jobListeners.add(listener);
      listener({ rows, count: rows.length });
      return () => jobListeners.delete(listener);
    },
    ...(opts.noOutput === true
      ? {}
      : {
          jobOutput(jobId: string) {
            reads.push({ jobId, at: Date.now() });
            const gone = exits.get(jobId);
            return Promise.resolve({
              found: true,
              jobId,
              status: gone === undefined ? "running" : gone.status,
              ...(gone === undefined || gone.exitCode === null ? {} : { exitCode: gone.exitCode }),
              // Owner A: one array in arrival order, as `shell_output` reads it.
              output: opts.output ?? ["found Turno 12", "found Turno 13", ""],
              truncated: opts.truncated ?? false,
            });
          },
        }),
    killJob(jobId: string) {
      kills.push(jobId);
      return Promise.resolve({ killed: true });
    },
    killSubagent: () => Promise.resolve({ killed: true }),
    messageSubagent: () => Promise.resolve({ ok: true }),
    ownsTurn: () => true,
    cancel: () => Promise.resolve(),
  } as unknown as SessionController;

  const exitListeners = new Set<(job: unknown) => void>();
  return {
    session,
    jobs: {
      onStart: () => () => {},
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
      reads,
      kills,
      prompts,
      rows: () => rows,
      setJobs: (next) => {
        rows = next;
        for (const l of jobListeners) l({ rows, count: rows.length });
      },
      exitJob: (id, status, exitCode) => {
        exits.set(id, { status, exitCode });
        // The EXIT first, then the list (the daemon's order, review 3): a client
        // freezes an open drawer from the exit record, so the outcome is known
        // before the row that drops it can be acted on.
        for (const l of exitListeners) {
          l({ id, command: "watch", startedAt: 0, status, exitCode });
        }
        rows = rows.filter((r) => r.id !== id);
        for (const l of jobListeners) l({ rows, count: rows.length });
      },
      readsOf: (id) => reads.filter((r) => r.jobId === id).length,
    },
  };
}

async function mount(
  opts: Parameters<typeof fake>[0],
  columns = 190,
  rows = 24,
  jobRefreshMs?: number,
): Promise<{ app: ReturnType<typeof renderAt>; api: JobApi; frame: () => string }> {
  const { session, api, jobs } = fake(opts);
  const app = renderAt(
    <App
      createSession={() => session}
      model="qwen3-27b"
      cwd="/tmp/work"
      jobs={jobs as never}
      permissions={new PermissionBroker()}
      {...(jobRefreshMs === undefined ? {} : { jobRefreshMs })}
    />,
    { columns, rows },
  );
  await delay(60);
  return { app, api, frame: app.frame };
}

/** DOWN onto the pill, ENTER into the dropdown. */
async function openDropdown(app: { stdin: { write(s: string): void } }): Promise<void> {
  app.stdin.write(DOWN);
  await delay(40);
  app.stdin.write(ENTER);
  await delay(50);
}

/** ENTER on the selected row: opens its drawer. */
async function openFirstJob(app: { stdin: { write(s: string): void } }): Promise<void> {
  await openDropdown(app);
  // The dropdown selects its FIRST row; a job-only list selects the job.
  app.stdin.write(ENTER);
  await delay(60);
}

const lines = (frame: string): string[] => frame.split("\n");
const lastLine = (frame: string): string =>
  lines(frame)
    .filter((l) => l.trim() !== "")
    .at(-1) ?? "";

describe("F1: the pill counts shells beside agents (190 and 80 columns)", () => {
  for (const columns of [190, 80]) {
    test(`at ${columns} columns: \`2 agents · 1 shell\`, and the shell is counted apart`, async () => {
      const { app, frame } = await mount(
        { jobs: [SHELL_ROW], agents: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] },
        columns,
      );
      const f = frame();
      expect(f).toContain("2 agents · 1 shell");
      // The pill is the status bar's LAST row (nothing permanent above the input).
      expect(lastLine(f)).toContain("· 1 shell");
      expect(f).not.toContain("background ·");
      app.unmount();
    });
  }

  test("a job alone says `0 agents · 1 shell`? No: it says `1 shell`, no agent count", async () => {
    const { app, frame } = await mount({ jobs: [SHELL_ROW] });
    const f = frame();
    // `status-view`'s grammar: the agents half is always present; with none it
    // reads `0 agents · 1 shell` — the honest total, never a made-up agent.
    expect(f).toContain("1 shell");
    expect(f).not.toContain("2 agents");
    app.unmount();
  });
});

describe("F2: the dropdown paints the mockup's shell row (190 and 80 columns)", () => {
  for (const columns of [190, 80]) {
    test(`at ${columns} columns: the rule counts 3, the job row says shell + the clock`, async () => {
      const { app, frame } = await mount(
        { jobs: [SHELL_ROW], agents: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2] },
        columns,
      );
      await openDropdown(app);
      const f = frame();
      expect(f).toContain("─ background · 3 ");
      expect(f).toContain("enter open · x stop · esc back");
      // The mockup's row (gen-v3.ts:236), with the wire's id (owner Q5 (b)).
      expect(f).toContain("◆ bg-3");
      expect(f).toContain("shell");
      expect(f).toContain("watch: grep -c");
      expect(f).toContain("running · 4m");
      // No `sh-` alias anywhere (owner Q5 (b)).
      expect(f).not.toContain("sh-3");
      app.unmount();
    });
  }
});

describe("F3: Enter on the job row opens its drawer (190 and 80 columns)", () => {
  for (const columns of [190, 80]) {
    test(`at ${columns} columns: head, merged tail, a PLAIN input rule, the frame height exact`, async () => {
      const { app, frame } = await mount({ jobs: [SHELL_ROW] }, columns, 24);
      await openFirstJob(app);
      const f = frame();
      // The head: the wire's id, the command, the live clock.
      expect(f).toContain("─ bg-3 · watch: grep -c");
      expect(f).toContain("running · 4m");
      // The tail is the MERGED output (Q4 (b)): no `stderr` section anywhere.
      expect(f).toContain("found Turno 12");
      expect(f).toContain("found Turno 13");
      expect(f).not.toContain("stderr");
      // Owner Q1 (a): the input stays on the main agent — a PLAIN rule.
      expect(f).not.toContain("→ bg-3");
      expect(f).not.toContain("enter sends");
      // The drawer's rows are reserved: the frame never exceeds the terminal's
      // rows (a frame TALLER than the terminal is what Ink re-clears every repaint).
      expect(lines(f).length).toBeLessThanOrEqual(24);
      app.unmount();
    });
  }

  test("M3: a blank line in the tail still paints a row and the frame height holds", async () => {
    // The daemon's answer carries `""` as its third line (the merge keeps it); the
    // drawer paints it as ONE space, so the height `dockRows` reserved is true.
    const { app, frame } = await mount({ jobs: [SHELL_ROW] }, 80, 24);
    await openFirstJob(app);
    const f = frame();
    expect(f).toContain("found Turno 13");
    expect(lines(f).length).toBeLessThanOrEqual(24);
    // No Ink "previous line repeated" collapse: nothing shifted.
    expect(f).not.toContain("previous line repeated");
    app.unmount();
  });

  test("M3: a job with no output yet paints the one `(no output yet)` row", async () => {
    const { session, jobs } = fake({ jobs: [SHELL_ROW] });
    // A session that reads fine but has written nothing yet.
    const quiet = {
      ...session,
      jobOutput: (jobId: string) => Promise.resolve({ found: true, jobId, output: [] }),
    } as unknown as SessionController;
    const app = renderAt(
      <App createSession={() => quiet} model="qwen3-27b" cwd="/tmp/work" jobs={jobs as never} />,
      { columns: 80, rows: 24 },
    );
    await delay(60);
    await openFirstJob(app);
    const f = app.frame();
    expect(f).toContain("(no output yet)");
    // A non-zero body: the head plus that one row, and the frame still fits.
    expect(lines(f).length).toBeLessThanOrEqual(24);
    app.unmount();
  });
});

describe("F4: the ≤ 1/s refresh — exact counts through the ONE seam (M4)", () => {
  test("the dropdown alone reads NOTHING; opening reads once, then once per tick", async () => {
    const { app, api } = await mount({ jobs: [SHELL_ROW] }, 100, 24, 50);
    // The effect exists for an OPEN JOB ONLY: a dropdown (or a child's drawer)
    // must not read at all — red if the effect ran on the dock being open.
    await openDropdown(app);
    await delay(160);
    expect(api.reads).toHaveLength(0);

    // Opening the drawer: exactly ONE read at once.
    app.stdin.write(ENTER);
    await delay(10);
    expect(api.readsOf("bg-3")).toBe(1);
    // Three more ticks ⇒ three more reads (never a burst, never zero).
    await delay(140);
    const afterOpen = api.readsOf("bg-3");
    expect(afterOpen).toBeGreaterThanOrEqual(2);
    expect(afterOpen).toBeLessThanOrEqual(6);
    app.unmount();
  });

  test("exactly +1 at the exit frame, then silence — and 0 after Esc (long interval)", async () => {
    // A long interval so NO tick can land in the window: the only reads are the
    // open's and the exit's, so both counts are exact.
    const { app, api } = await mount({ jobs: [SHELL_ROW] }, 100, 24, 60_000);
    await openFirstJob(app);
    expect(api.readsOf("bg-3")).toBe(1);

    api.exitJob("bg-3", "exited", 0);
    await delay(60);
    // One FINAL read: the registry still answers for an exited job.
    expect(api.readsOf("bg-3")).toBe(2);

    // Esc out of the drawer: no further read, ever.
    app.stdin.write(ESC);
    await delay(40);
    app.stdin.write(ESC);
    await delay(40);
    app.stdin.write(ESC);
    await delay(120);
    expect(api.readsOf("bg-3")).toBe(2);
    app.unmount();
  });

  test("the read count never reaches one per render (the effect cannot re-arm)", async () => {
    // A long window with many ticks: the count tracks the TICKS, not the frames.
    const { app, api } = await mount({ jobs: [SHELL_ROW] }, 80, 24, 40);
    await openFirstJob(app);
    const first = api.readsOf("bg-3");
    await delay(200);
    const second = api.readsOf("bg-3");
    // 200 ms at 40 ms ⇒ ~5 ticks: a re-arming effect would be 10× that.
    expect(second - first).toBeLessThanOrEqual(6);
    expect(second - first).toBeGreaterThanOrEqual(3);
    app.unmount();
  });
});

describe("F5: x then y stops the job through session/job_kill", () => {
  test("killJob('bg-3'), and the row is still painted until the exit frame", async () => {
    const { app, api, frame } = await mount({ jobs: [SHELL_ROW] });
    await openDropdown(app);
    app.stdin.write("x");
    await delay(30);
    // The armed rule says what `y` will do.
    expect(frame()).toContain("y stop · any other key cancels");
    app.stdin.write("y");
    await delay(40);
    expect(api.kills).toEqual(["bg-3"]);
    // No exit frame yet: the row is still there, as the mockup paints it.
    api.setJobs([SHELL_ROW]);
    await delay(30);
    expect(frame()).toContain("bg-3");
    app.unmount();
  });
});

describe("F6: an exit while the drawer is open freezes it", () => {
  test("the head says `✓ exited (0)`, the row is gone, and the input is not re-routed", async () => {
    const { app, api, frame } = await mount({ jobs: [SHELL_ROW] });
    await openFirstJob(app);
    api.exitJob("bg-3", "exited", 0);
    await delay(80);
    const f = frame();
    // Frozen with the outcome from the same exit record.
    expect(f).toContain("✓ exited (0)");
    // And still the PLAIN input rule: a job's drawer never takes the input.
    expect(f).not.toContain("→ bg-3");
    // The drawer keeps painting its subject after the row left the list.
    expect(f).toContain("─ bg-3 · ");
    app.unmount();
  });

  test("review 3: SPLIT delivery (frame, then the exit 30 ms later) still says `✓ exited (0)`", async () => {
    // The order the daemon now emits is exit-then-list, so a transport that
    // splits them cannot freeze the drawer as `✗ stopped`. A transport that
    // REORDERS them (or a daemon that still sends the list first) would — this
    // test pins the client's tolerance of the split itself, which is what the
    // reviewer's repro exercised.
    const { app, api, frame } = await mount({ jobs: [SHELL_ROW] });
    await openFirstJob(app);
    // The row leaves the list NOW; the exit notice lands a macrotask later.
    api.setJobs([]);
    await delay(30);
    api.exitJob("bg-3", "exited", 0);
    await delay(80);
    const f = frame();
    expect(f).not.toContain("✗ stopped");
    expect(f).toContain("✓ exited (0)");
    app.unmount();
  });
});

describe("F7: an older daemon (no jobOutput) says so once and keeps the frame", () => {
  test("one notice, the drawer's head intact, no throw", async () => {
    const { app, frame } = await mount({ jobs: [SHELL_ROW], noOutput: true });
    await openFirstJob(app);
    const f = frame();
    // The notice (the session cannot show it), and the head still painted.
    expect(f).toContain("older daemon");
    expect(f).toContain("─ bg-3 · ");
    expect(lines(f).length).toBeLessThanOrEqual(24);
    app.unmount();
  });
});

describe("F8: the 5-row window with 4 children + 3 jobs", () => {
  test("the rule counts 7, the window shows 5, and the selection is kept by id", async () => {
    const agents = BACKGROUND_ROW.many(4);
    const { app, frame } = await mount({ jobs: extraJobs(3), agents });
    await openDropdown(app);
    const f = frame();
    expect(f).toContain("─ background · 7 ");
    // Five rows: the four children, then the FIRST job (paint order).
    expect(f).toContain("sa-1");
    expect(f).toContain("sa-4");
    expect(f).toContain("bg-1");
    expect(f).toContain("↓2 ·");
    // Four DOWNs: the selection lands on the FIRST job (item 5), still the last
    // row of the window — a job is a row like any other, never a second list.
    for (let i = 0; i < 4; i++) {
      app.stdin.write(DOWN);
      await delay(30);
    }
    expect(frame()).toContain("› ◆ bg-1");
    // One more: the window follows the selection (it never jumps under the user).
    app.stdin.write(DOWN);
    await delay(40);
    const moved = frame();
    expect(moved).toContain("› ◆ bg-2");
    expect(moved).toContain("↑1");
    app.unmount();
  });
});

describe("F9 (owner B): the drawer's outcome, tone and total run time", () => {
  /** A job older than its exit, so the duration is a real figure, not `0s`. */
  const STOPWATCH: DockJobRow = { ...SHELL_ROW, startedAt: Date.now() - 250_000 };

  test("a clean exit: `✓ exited (0) · 4m …`, never a bare `✓ exited`", async () => {
    const { app, api, frame } = await mount({ jobs: [STOPWATCH] });
    await openFirstJob(app);
    api.exitJob("bg-3", "exited", 0);
    await delay(80);
    const f = frame();
    expect(f).toContain("✓ exited (0) · 4m");
    app.unmount();
  });

  test("a non-zero exit says `✗ exited (2)` with the duration — no `✓` anywhere", async () => {
    const { app, api, frame } = await mount({ jobs: [STOPWATCH] });
    await openFirstJob(app);
    api.exitJob("bg-3", "exited", 2);
    await delay(80);
    const f = frame();
    expect(f).toContain("✗ exited (2) · 4m");
    expect(f).not.toContain("✓ exited");
    app.unmount();
  });

  test("a signal death (no code) says `✗ killed`", async () => {
    const { app, api, frame } = await mount({ jobs: [STOPWATCH] });
    await openFirstJob(app);
    api.exitJob("bg-3", "killed", null);
    await delay(80);
    const f = frame();
    expect(f).toContain("✗ killed · 4m");
    expect(f).not.toContain("✗ stopped");
    app.unmount();
  });

  test("stopping it from the dock says `✗ stopped`, not `killed`", async () => {
    const { app, api, frame } = await mount({ jobs: [STOPWATCH] });
    await openDropdown(app);
    app.stdin.write("x");
    await delay(30);
    app.stdin.write("y");
    await delay(40);
    expect(api.kills).toEqual(["bg-3"]);
    // The row is still listed until the exit arrives (F5): open it, so the freeze
    // is what paints the outcome. The kill we asked for is recorded by id.
    app.stdin.write(ENTER);
    await delay(60);
    // The exit the daemon reports for our own kill: `killed`, no code.
    api.exitJob("bg-3", "killed", null);
    await delay(80);
    const f = frame();
    expect(f).toContain("✗ stopped · 4m");
    expect(f).not.toContain("✗ killed");
    app.unmount();
  });
});

describe("F10 (review 4): the drawer never outgrows a short terminal", () => {
  /** A full tail with `truncated`, so the `… earlier output` row is there too. */
  const FULL = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

  for (const rows of [20, 16]) {
    test(`at 80x${rows}: the frame is at most ${rows} lines, and the tail is visible`, async () => {
      const { app, frame } = await mount(
        { jobs: [SHELL_ROW], output: FULL, truncated: true },
        80,
        rows,
      );
      await openFirstJob(app);
      const f = frame();
      const height = lines(f).length;
      // The bug: a fixed 14-row drawer (head + `… earlier` + 12 tail) fitted a
      // 24-row terminal and overflowed this one, so Ink re-cleared it every
      // repaint (Review H3's flicker class).
      expect(height).toBeLessThanOrEqual(rows);
      // And it is still a drawer: the head, and output lines from the tail.
      expect(f).toContain("─ bg-3 · ");
      expect(f).toContain("line 30");
      app.unmount();
    });
  }

  test("the same drawer at 80x24 keeps its full 12-line tail", async () => {
    const { app, frame } = await mount(
      { jobs: [SHELL_ROW], output: FULL, truncated: true },
      80,
      24,
    );
    await openFirstJob(app);
    const f = frame();
    expect(lines(f).length).toBeLessThanOrEqual(24);
    // Room for the whole window: nothing is cut that did not have to be.
    expect(f).toContain("line 19");
    expect(f).toContain("line 30");
    app.unmount();
  });
});

describe("F11 (owner A supersedes review 2): a stderr-heavy job still shows its stdout", () => {
  test("20 stderr + 5 stdout lines: the stdout is in the drawer, in arrival order", async () => {
    // What the daemon now answers: ONE arrival-ordered array, its last 12 lines
    // to fill a 12-row window. Before owner A the window was `err9…err20` and no
    // stdout line could ever be painted.
    const output = [
      ...Array.from({ length: 7 }, (_, i) => `err${i + 14}`),
      "OUT1",
      "OUT2",
      "OUT3",
      "OUT4",
      "OUT5",
    ];
    const { app, frame } = await mount({ jobs: [SHELL_ROW], output }, 80, 24);
    await openFirstJob(app);
    const f = frame();
    for (const line of ["OUT1", "OUT2", "OUT3", "OUT4", "OUT5"]) {
      expect(f).toContain(line);
    }
    // Arrival order, not stdout-then-stderr: the last rows are the stdout ones.
    const body = lines(f)
      .map((l) => l.replace(/^\s*│\s?/, "").trim())
      .filter((l) => l.startsWith("OUT") || l.startsWith("err"));
    expect(body.slice(-5)).toEqual(["OUT1", "OUT2", "OUT3", "OUT4", "OUT5"]);
    app.unmount();
  });
});
