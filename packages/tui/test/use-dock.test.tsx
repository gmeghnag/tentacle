/**
 * docs/feat/app-decomposition.md S5 — the seam the dock's move created, plus the
 * two structural rules the move had to keep.
 *
 * `useDock` is a HOOK, not a pure module: every decision it executes is already
 * a pure module's (`reconcile`, `dockKey`, `sendTarget`, `toggleList`,
 * `refusalPlacement`, `listVisible`, `backgroundListView`), each with its own
 * unit test. So what is new here is only what the MOVE could break, and there
 * are exactly two things:
 *
 * 1. **No effect moved (Fable H1 / owner Q7 (a)).** App keeps its 22 effects (the
 *    original 20 + session-hop's 2), in
 *    today's order; the dock's four (the `jobs.onExit` subscription, the id-key
 *    reconcile, the timed output read, the last read at an exit) stay where they
 *    were. `useDock` declares NONE. A hook that grew an effect would silently
 *    reorder App's mount sequence — the class of bug S0b's order test exists to
 *    catch, and which nothing else pins per file.
 * 2. **`setDock` still writes its ref EAGERLY.** The ref, not the state, is what
 *    a keypress reads; two dock keys delivered with NO render between them must
 *    see the first one's decision. A hook that returned `useState`'s setter (or
 *    wrote the ref inside the state updater) breaks exactly that: the second key
 *    reads the pre-first-key focus. This is H3's freshness rule at the dock, and
 *    the frames tests never deliver two keys without a render between them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionBroker } from "@tentacle/core";
import { App, type SessionController } from "../src/App.tsx";
import { resetThemeForTest, setThemeMode } from "../src/theme.ts";
import { renderAt } from "./real-term.tsx";
import { inertSession } from "./session-stub.ts";

const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DOWN = "\u001B[B";
const ENTER = "\r";

describe("S5 structure: the dock owns no effect, so App's order cannot move", () => {
  test("`useDock.ts` declares no `useEffect` (the four dock effects stay in App)", () => {
    const src = readSrc("useDock.ts");
    // The CALL, not the word: the header explains why the effects stayed in App.
    // A call without the import does not compile, and an import with no call is
    // dead weight — either means an effect was moved (Fable H1).
    expect(src).not.toMatch(/useEffect\s*\(/);
    expect(src).toMatch(/import \{[^}]*\} from "react";/);
    expect(src).not.toMatch(/import \{[^}]*\buseEffect\b[^}]*\} from "react";/);
  });

  test("App keeps 22 effects (20 + session-hop's 2), and the dock's four keep their order", () => {
    const src = readSrc("App.tsx");
    const at = [...src.matchAll(/^\s*useEffect\(/gm)].map((m) => m.index ?? 0);
    expect(at.length).toBe(22);
    // 1-based positions of the four effects this slice left in place: the
    // `jobs.onExit` subscription, the id-key reconcile, the timed output read,
    // and the one last read when the open job's exit is seen.
    const body = (i: number): string => src.slice(at[i] ?? 0, (at[i] ?? 0) + 400);
    expect(body(3)).toContain("jobs.onExit");
    expect(body(12)).toContain("dockIdKey");
    expect(body(13)).toContain("jobTargetId === null");
    expect(body(14)).toContain("jobEndedWhileOpen === null");
    // …and the hook call sits ABOVE all of them, so the order it was written in
    // is the order React sees.
    expect(src.indexOf("useDock({")).toBeLessThan(at[3] ?? 0);
  });
});

/** The rows a fake reports: one background child, enough to reach the dock. */
const ROW = {
  id: "sa-1",
  agentType: "explore",
  description: "find callers of parseConfig",
  startedAt: 0,
  toolUses: 3,
  userMessages: 0,
  userRead: 0,
  tokens: 0,
  status: "running" as const,
};

/** A running shell job: the only drawer that may READ (`jobOutput`). */
const JOB = { id: "bg-3", command: "watch date", startedAt: 0 };

interface Seams {
  /** Every `jobOutput` call's id: a CHILD's drawer must contribute none. */
  readonly reads: string[];
  /** Every `messageSubagent` call: a refusal's text must never reach the prompt. */
  readonly messages: { id: string; text: string }[];
  /** Every prompt the main agent got. */
  readonly prompts: string[];
  /** The live background list, and a way to report a new one. */
  readonly setRows: (rows: readonly unknown[]) => void;
  readonly setJobs: (rows: readonly unknown[]) => void;
}

function fake(opts: { readonly refuse?: string; readonly refuseAfterMs?: number } = {}): {
  session: SessionController;
  api: Seams;
} {
  const listeners = new Set<(rows: readonly unknown[]) => void>();
  const jobListeners = new Set<(r: { rows: readonly unknown[]; count: number }) => void>();
  let rows: readonly unknown[] = [ROW];
  let jobs: readonly unknown[] = [];
  const reads: string[] = [];
  const messages: { id: string; text: string }[] = [];
  const prompts: string[] = [];
  const session = {
    ...inertSession(),
    async *send(text: string) {
      prompts.push(text);
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue: () => Promise.resolve(),
    onSubagents(listener: (r: readonly unknown[]) => void) {
      listeners.add(listener);
      listener(rows);
      return () => listeners.delete(listener);
    },
    onJobs(listener: (r: { rows: readonly unknown[]; count: number }) => void) {
      jobListeners.add(listener);
      listener({ rows: jobs, count: jobs.length });
      return () => jobListeners.delete(listener);
    },
    jobOutput(id: string) {
      reads.push(id);
      return Promise.resolve({ found: true, jobId: id, status: "running", output: ["x"] });
    },
    messageSubagent(id: string, text: string) {
      messages.push({ id, text });
      if (opts.refuse === undefined) {
        return Promise.resolve({ ok: true });
      }
      const refusal = { ok: false, reason: opts.refuse };
      return opts.refuseAfterMs === undefined
        ? Promise.resolve(refusal)
        : delay(opts.refuseAfterMs).then(() => refusal);
    },
    killSubagent: () => Promise.resolve({ killed: true }),
    killJob: () => Promise.resolve({ killed: true }),
    ownsTurn: () => true,
  } as unknown as SessionController;
  return {
    session,
    api: {
      reads,
      messages,
      prompts,
      setRows: (next) => {
        rows = next;
        for (const l of listeners) l(rows);
      },
      setJobs: (next) => {
        jobs = next;
        for (const l of jobListeners) l({ rows: jobs, count: jobs.length });
      },
    },
  };
}

async function mount(opts: Parameters<typeof fake>[0] = {}): Promise<{
  app: ReturnType<typeof renderAt>;
  api: Seams;
  frame: () => string;
}> {
  resetThemeForTest();
  setThemeMode("dark");
  const { session, api } = fake(opts);
  const app = renderAt(
    <App
      createSession={() => session}
      model="qwen3-27b"
      cwd="/tmp/work"
      permissions={new PermissionBroker()}
      // The ONE cadence seam (AGENTS §9): 40 ms, so a re-arm is visible at once.
      jobRefreshMs={40}
    />,
    { columns: 100, rows: 24 },
  );
  await delay(60);
  return { app, api, frame: app.frame };
}

describe("S5 freshness: two dock keys in ONE chunk, no render between them", () => {
  test("DOWN then ENTER: the first key's focus is READ by the second (`dockRef` is eager)", async () => {
    const { app, frame } = await mount();
    // Nothing at rest: the dock is one pill with one child counted.
    expect(frame()).toContain("1 agent");
    // TWO writes and NO await between them, so React cannot commit between the
    // two keys: DOWN focuses the pill, ENTER opens the dropdown it just focused.
    // A `setDock` that wrote its ref at render time would leave the second key
    // reading the INPUT focus, and no dropdown would paint.
    app.stdin.write(DOWN);
    app.stdin.write(ENTER);
    await delay(120);
    const f = frame();
    // The dropdown's titled rule and its row: painted only by a `list` focus.
    expect(f).toContain("background · 1");
    expect(f).toContain("sa-1");
    app.unmount();
  });

  test("the same two keys with a render between them still work (the control)", async () => {
    const { app, frame } = await mount();
    app.stdin.write(DOWN);
    await delay(80);
    app.stdin.write(ENTER);
    await delay(120);
    expect(frame()).toContain("background · 1");
    app.unmount();
  });
});

describe("S5 seam: the dock's own guards, which only the open drawer can show", () => {
  test("a report that ADDS a job reaches the FRAME (the pill counts STATE, not the ref)", async () => {
    // `setJobs` gates its state on `sameJobIds` so an unchanged frame costs no
    // render (LOW-4) — but the gate must never SWALLOW a real change: the refs
    // feed the decisions, the state feeds what the user sees. A gate inverted to
    // "only the first report ever" keeps `dockIds()`/`listVisible()` correct
    // (they read refs) while the pill and the dropdown freeze as they were.
    const { app, api, frame } = await mount();
    // Nothing is running yet: no pill at all.
    expect(frame()).not.toContain("shell");
    api.setJobs([JOB]);
    await delay(80);
    expect(frame()).toContain("1 shell");
    app.unmount();
  });

  test("a CHILD's drawer never READS its output (only a job has output)", async () => {
    // `jobTargetId` is what arms App's timed read. The pre-S5 line checked the
    // id's KIND (`dockKindOf(id) === "job"`) as well as the focus; a hook that
    // moved the decision and dropped the kind check would fire
    // `session.jobOutput("sa-1")` once a second, forever, for a sub-agent.
    const { app, api, frame } = await mount();
    // DOWN → the pill, ENTER → the dropdown, ENTER → open the child's drawer.
    app.stdin.write(DOWN);
    await delay(60);
    app.stdin.write(ENTER);
    await delay(60);
    app.stdin.write(ENTER);
    await delay(160);
    expect(frame()).toContain("→ sa-1");
    // Several ticks of the 40 ms cadence have passed: still not one read.
    expect(api.reads).toEqual([]);
    app.unmount();
  });

  test("a JOB's drawer DOES read, so the assertion above is not vacuous", async () => {
    const { app, api, frame } = await mount();
    api.setJobs([JOB]);
    await delay(60);
    // The dock lists the children FIRST, then the jobs, so the dropdown's first
    // row is still `sa-1`: one DOWN moves the selection onto the job.
    app.stdin.write(DOWN);
    await delay(60);
    app.stdin.write(ENTER);
    await delay(60);
    app.stdin.write(DOWN);
    await delay(60);
    app.stdin.write(ENTER);
    await delay(140);
    expect(frame()).toContain("watch date");
    expect(api.reads.length).toBeGreaterThan(0);
    expect(api.reads.every((id) => id === "bg-3")).toBe(true);
    app.unmount();
  });

  test("a late refusal asks the field as it is NOW: text typed since goes to the notice", async () => {
    // `refusalPlacement` takes the LIVE field (`fieldValueRef.current`), never a
    // captured one. Pre-S5 the App read that ref; the hook must read the same
    // ref, or a refusal that lands after the user typed would overwrite the new
    // draft with the old text.
    const { app, api, frame } = await mount({ refuse: "inbox full", refuseAfterMs: 120 });
    app.stdin.write(DOWN);
    await delay(60);
    app.stdin.write(ENTER);
    await delay(60);
    app.stdin.write(ENTER);
    await delay(60);
    expect(frame()).toContain("→ sa-1");
    app.stdin.write("for-sa1-only");
    await delay(20);
    app.stdin.write(ENTER); // the RPC is in flight…
    await delay(20);
    // …and the user TYPES in the child's field before the refusal lands.
    app.stdin.write("second draft");
    await delay(200);
    const f = frame();
    expect(api.messages).toHaveLength(1);
    // The refusal is quoted with the text it could not place…
    expect(f).toContain("not sent to sa-1");
    expect(f).toContain("kept as a draft: for-sa1-only");
    // …and the draft on screen is the NEW one, untouched by the refused text.
    expect(f).toContain("second draft");
    app.unmount();
  });
});
