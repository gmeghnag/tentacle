/**
 * docs/feat/cron-tool.md S5 — the FRAMES of the real `App` with the session's
 * armed scheduled wakes: the dock row and the pill (mockup M2), the `/schedule`
 * panel (M3), the fired turn's styled row (M4 option B), and the quit warning
 * (M6). One frame per mockup, at a real terminal size (`renderAt`, so Ink itself
 * wraps at the width the assertion is made at — `shell-panel-frames`' lesson).
 *
 * The pure decisions are `schedule-view.test.ts`'s; here the property is that
 * the App PAINTS them, and that a session with no table paints nothing.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { App, type SessionController } from "../src/App.tsx";
import type { ScheduleDockRow } from "../src/schedule-view.ts";
import { renderAt } from "./real-term.tsx";
import { inertSession } from "./session-stub.ts";

const DOWN = "\u001B[B";
const ESC = "\u001B";
/** The dock's stop/delete key: `ctrl+x` twice (its own grammar, not a plain `x`). */
const CTRL_X = "\u0018";
const ENTER = "\r";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The mockups' two wakes (M2/M3), on this test's own clock. */
const NOW = Date.now();
const WAKE_1: ScheduleDockRow = {
  id: "sc-1",
  kind: "every",
  spec: "every 10m",
  prompt: "check CI on PR #412",
  nextAt: NOW + 9 * 60_000,
  expiresAt: NOW + 6 * 24 * 3_600_000,
  fires: 4,
  createdAt: NOW - 3_600_000,
};
const WAKE_2: ScheduleDockRow = {
  id: "sc-2",
  kind: "at",
  spec: "at 17:00",
  prompt: "remind: standup notes",
  nextAt: NOW + 149 * 60_000,
  fires: 0,
  createdAt: NOW,
};

interface WakeApi {
  readonly session: SessionController;
  readonly deletes: string[];
  /** Push a new table, as the daemon's `schedules` frame would. */
  readonly report: (rows: readonly ScheduleDockRow[] | undefined) => void;
  /** Another device's turn starts (a `turn_start` with a schedule ref). */
  readonly fire: () => void;
}

/**
 * A session whose armed wakes this test drives: `onSchedules` delivers the first
 * table at once (as the client's does), then whatever `report` sends.
 */
function fake(opts: { readonly schedules?: readonly ScheduleDockRow[] } = {}): WakeApi {
  const deletes: string[] = [];
  let listener: ((report: { rows: readonly ScheduleDockRow[]; count: number }) => void) | null =
    null;
  let turn: ((event: unknown) => void) | null = null;
  const session = {
    ...inertSession(),
    async *send() {
      // A turn that never yields: the App stays idle and no reply is painted.
      yield* [] as never[];
    },
    watch: (l: (event: unknown) => void) => {
      turn = l;
      return () => {
        turn = null;
      };
    },
    onSchedules: (l: (report: { rows: readonly ScheduleDockRow[]; count: number }) => void) => {
      listener = l;
      if (opts.schedules !== undefined) {
        l({ rows: opts.schedules, count: opts.schedules.length });
      }
      return () => {
        listener = null;
      };
    },
    deleteSchedule: (id: string) => {
      deletes.push(id);
      return Promise.resolve({ deleted: true });
    },
    ownsTurn: () => true,
    close() {},
  } as unknown as SessionController;
  return {
    session,
    deletes,
    report: (rows) => listener?.({ rows: rows ?? [], count: rows?.length ?? 0 }),
    fire: () =>
      turn?.({
        kind: "turn",
        turnId: "wake-1",
        events: (async function* () {
          yield {
            type: "user_message",
            text: "[scheduled sc-1 · every 10m · fire 5] check CI on PR #412",
            schedule: { id: "sc-1", spec: "every 10m" },
          };
          yield { type: "text", delta: "CI is still running." };
          yield { type: "turn_end", reason: "end_turn" };
        })(),
      }),
  };
}

/** DOWN onto the pill, ENTER into the dropdown (`shell-panel-frames`'s helper). */
async function openDropdown(term: { stdin: { write(s: string): void } }): Promise<void> {
  term.stdin.write(DOWN);
  await delay(40);
  term.stdin.write(ENTER);
  await delay(60);
}

async function mount(api: WakeApi, columns = 120) {
  const term = renderAt(
    <App
      createSession={() => api.session}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
    />,
    { columns, rows: 40 },
  );
  await delay(40);
  const line = async (text: string, settle = 80) => {
    term.stdin.write(text);
    await delay(20);
    term.stdin.write(ENTER);
    await delay(settle);
  };
  return { term, line, frame: () => term.frame() };
}

describe("S5 M2: the dock's row and the pill", () => {
  test("two armed wakes: the pill says `2 sched`, and DOWN lists their rows", async () => {
    const api = fake({ schedules: [WAKE_1, WAKE_2] });
    const t = await mount(api);
    // The pill carries the count (no other background work: schedules alone
    // still make a pill — they are the session's work the user must reach).
    expect(t.frame()).toContain("2 sched");
    await openDropdown(t.term);
    const frame = t.frame();
    // Both rows, with the dock's own glyph and their two metas.
    expect(frame).toContain("sc-1");
    expect(frame).toContain("check CI on PR #412");
    expect(frame).toContain("every 10m");
    expect(frame).toContain("4×");
    expect(frame).toContain("sc-2");
    expect(frame).toContain("remind: standup notes");
    // The dock's title counts them with the children and jobs (two here).
    expect(frame).toContain("background · 2");
    t.term.unmount();
  });

  test("no report at all (a pod, an older daemon): no pill, no row, no claim", async () => {
    const api = fake();
    const t = await mount(api);
    expect(t.frame()).not.toContain("sched");
    t.term.stdin.write(DOWN);
    await delay(40);
    expect(t.frame()).not.toContain("sc-1");
    t.term.unmount();
  });

  test("the dropdown's `x` twice deletes: the method goes out with the wire id", async () => {
    const api = fake({ schedules: [WAKE_1] });
    const t = await mount(api);
    await openDropdown(t.term);
    t.term.stdin.write(CTRL_X);
    await delay(60);
    // Armed: the row names the delete, and nothing has gone out yet.
    expect(api.deletes).toEqual([]);
    t.term.stdin.write(CTRL_X);
    await delay(80);
    expect(api.deletes).toEqual(["sc-1"]);
    t.term.unmount();
  });
});

describe("S5 M3: the /schedule panel", () => {
  test("each wake is a summary plus its quoted prompt, and `x x` deletes", async () => {
    const api = fake({ schedules: [WAKE_1, WAKE_2] });
    const t = await mount(api);
    await t.line("/schedule");
    const frame = t.frame();
    expect(frame).toContain("Scheduled wakes (2)");
    expect(frame).toContain("every 10m");
    expect(frame).toContain("fired 4×");
    expect(frame).toContain("one-shot");
    expect(frame).toContain('"check CI on PR #412"');
    expect(frame).toContain("x delete");
    // Arm, then delete the selected (first) wake.
    t.term.stdin.write("x");
    await delay(60);
    expect(t.frame()).toContain("delete sc-1?");
    t.term.stdin.write("x");
    await delay(80);
    expect(api.deletes).toEqual(["sc-1"]);
    t.term.unmount();
  });

  test("the arrow walks WAKES, so `x` deletes the one the cursor is on", async () => {
    const api = fake({ schedules: [WAKE_1, WAKE_2] });
    const t = await mount(api);
    await t.line("/schedule");
    t.term.stdin.write(DOWN);
    await delay(60);
    t.term.stdin.write("x");
    await delay(60);
    t.term.stdin.write("x");
    await delay(80);
    expect(api.deletes).toEqual(["sc-2"]);
    t.term.unmount();
  });

  test("Esc closes the panel and never stops a turn", async () => {
    const api = fake({ schedules: [WAKE_1] });
    const t = await mount(api);
    await t.line("/schedule");
    expect(t.frame()).toContain("Scheduled wakes");
    t.term.stdin.write(ESC);
    await delay(80);
    expect(t.frame()).not.toContain("Scheduled wakes");
    t.term.unmount();
  });

  test("a session with no table says so instead of claiming `no wakes`", async () => {
    const api = fake();
    // The command gates on the member existing; without `onSchedules` it
    // refuses through a notice (this session's daemon cannot report a table).
    (api.session as unknown as { onSchedules?: unknown }).onSchedules = undefined;
    const t = await mount(api);
    await t.line("/schedule");
    expect(t.frame()).toContain("not supported by this session");
    t.term.unmount();
  });
});

describe("S5 M4: the fired turn's styled row (option B)", () => {
  test("a `turn_start.schedule` paints its own head above the prompt", async () => {
    const api = fake({ schedules: [WAKE_1] });
    const t = await mount(api);
    api.fire();
    await delay(120);
    const frame = t.frame();
    // The styled head, with the ordinal read out of the durable prefix.
    expect(frame).toContain("◷ scheduled · sc-1 every 10m · fire 5");
    // The prompt itself is still the durable text (option A is inside it).
    expect(frame).toContain("check CI on PR #412");
    t.term.unmount();
  });
});

describe("S5: a wake that leaves the table says why (S3 drift 5)", () => {
  test("the expiry notice is derived from the list diff, never a frame", async () => {
    const expired: ScheduleDockRow = { ...WAKE_1, expiresAt: Date.now() - 1 };
    const api = fake({ schedules: [expired] });
    const t = await mount(api);
    expect(t.frame()).toContain("1 sched");
    // The daemon publishes ONLY the new list: the row disappears.
    api.report([]);
    await delay(120);
    const frame = t.frame();
    expect(frame).toContain("Schedule sc-1 expired.");
    // The dock row is gone with it, and no wake is left to warn about.
    expect(frame).not.toContain("check CI on PR #412");
    expect(frame).not.toContain("sched");
    t.term.unmount();
  });

  test("a wake still in date was stopped after failures, and says THAT", async () => {
    const api = fake({ schedules: [WAKE_1] });
    const t = await mount(api);
    api.report([]);
    await delay(120);
    expect(t.frame()).toContain("Schedule sc-1 stopped after repeated failures.");
    t.term.unmount();
  });
});

describe("S5 M6: quitting with armed wakes asks first", () => {
  test("a local quit names them; `n` stays", async () => {
    const api = fake({ schedules: [WAKE_1, WAKE_2] });
    const t = await mount(api);
    await t.line("/quit");
    const frame = t.frame();
    expect(frame).toContain("2 scheduled wakes (sc-1, sc-2)");
    expect(frame).toContain("end with this session");
    t.term.stdin.write("n");
    await delay(60);
    // Still here: no quit happened.
    t.term.unmount();
  });
});
