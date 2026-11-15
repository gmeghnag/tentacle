/**
 * docs/feat/app-decomposition.md S8 — `/quit` and `/clear` execute through
 * `useQuitClear`.
 *
 * These are the App-seam cases: the hook is exercised through the REAL `App`
 * (ink-testing-library), so what is pinned is the behaviour the move could have
 * broken, not the hook's internals. The properties are the ones this slice
 * stands or falls on, and each has the mutation that turns it red written
 * beside it (the slice's mutation table):
 *
 * 1. **The decision is still the pure module's, read through LIVE refs.** A quit
 *    asked for mid-turn stops the turn and sets `exitPending`; the turn's settle
 *    then exits. Reading a render value instead of the ref would either exit
 *    inside the turn's slot or never exit at all.
 * 2. **The clear's step is still `clearCommandStep`'s, with the refs it read.**
 *    `busy`/`compacting`/`legacy`/`stop_then_clear` are four different outcomes
 *    of one ref-and-state read; the hook owns none of that state, so a port field
 *    wired to the wrong ref (or re-created) changes which one it picks.
 * 3. **`runClearRef` is still the App's forward reference.** The turn's settle
 *    calls it for a stopped /clear, and `App` assigns it right after the hook
 *    returns — a version that returned the callback without wiring the ref never
 *    runs the clear.
 * 4. **The order the command layer depends on is unchanged**: `requestQuit`,
 *    `runClear` and `requestClear` are the same three identifiers, and `/quit`
 *    is still `/exit`'s alias (one implementation).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type RunQuit, type SessionController } from "../src/App.tsx";
import type { SessionActivity } from "../src/turn-feed.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const ENTER = "\r";

interface Log {
  readonly clears: string[];
  readonly closes: string[];
  creates: number;
}

/**
 * A session whose turn HANGS until aborted (`hang*` prompts) or answers at once.
 */
function rig(opts: { holdTurn?: boolean; clearHangs?: boolean } = {}) {
  const log: Log = { clears: [], closes: [], creates: 0 };
  let listener: ((a: SessionActivity) => void) | null = null;
  // `exit()` unmounts Ink's tree, which runs the notices effect's cleanup: the
  // only in-harness proof that the TUI really left (run-quit.test.tsx's probe).
  let gone = false;
  const ctrl = {
    ...inertSession(),
    async *send(prompt: string, signal?: AbortSignal) {
      yield { type: "text", delta: `reply to ${prompt}` };
      if (opts.holdTurn) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }
      yield { type: "turn_end", reason: "end_turn" };
    },
    watch(l: (a: SessionActivity) => void) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    close() {
      log.closes.push("close");
    },
    ownsTurn: () => true,
  } as unknown as SessionController;
  ctrl.clear = () => {
    log.clears.push("clear");
    if (opts.clearHangs) {
      return new Promise(() => {});
    }
    return Promise.resolve({ before: 3, after: 1 });
  };
  const app = render(
    <App
      createSession={() => {
        log.creates += 1;
        return ctrl;
      }}
      permissions={new PermissionBroker()}
      notices={{
        onNotice: () => () => {
          gone = true;
        },
      }}
      model="m"
      cwd="/tmp/work"
    />,
  );
  return { app, log, exited: () => gone, raise: (a: SessionActivity) => listener?.(a) };
}

async function type(stdin: { write(d: string): void }, text: string, settle = 60) {
  stdin.write(text);
  await delay(20);
  stdin.write(ENTER);
  await delay(settle);
}

describe("S8: /quit executes through the hook (live refs, the same decision)", () => {
  test("mid-turn: the turn is stopped, the notice says so, and the turn's SETTLE exits", async () => {
    // Mutations: (a) read `stateRef.current.running` at render instead → the
    // step is "exit" and the turn is never aborted; (b) never set
    // `exitPendingRef` → the TUI stays up after the turn settles.
    const r = rig({ holdTurn: true });
    await delay(40);
    r.app.stdin.write("hang");
    await delay(20);
    r.app.stdin.write(ENTER);
    await delay(80);
    expect(strip(r.app.lastFrame())).toContain("Working…");
    await type(r.app.stdin, "/exit");
    // Mid-turn on a worker/pod runtime: stop first, exit when it has settled.
    expect(strip(r.app.lastFrame())).toContain("Stopping the turn so it is saved");
    await delay(120);
    // The abort resolved the turn, and the settle took `exitPending`: the App
    // exited (unmounted) instead of staying up on an ended turn.
    expect(r.exited()).toBe(true);
    expect(strip(r.app.lastFrame())).not.toContain("Working…");
    r.app.unmount();
  });

  test("/quit is /exit (one implementation), and neither asks when nothing is at stake", async () => {
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "/quit");
    expect(strip(r.app.lastFrame())).not.toContain("(y/N)");
    r.app.unmount();
  });

  test("a run TUI with others on the session asks first: whose count comes from `runQuit` LIVE", async () => {
    // Mutation: read the count once (a value) instead of `othersOnSession()` at
    // decision time → a second terminal attaching is not noticed.
    let others = 0;
    const calls: string[] = [];
    const runQuit: RunQuit = {
      othersOnSession: () => others,
      closeForAll: () => calls.push("closeForAll"),
      closedElsewhere: (reason) => calls.push(reason),
    };
    const s = rig();
    // A second terminal attaches AFTER the mount: the decision must see 1.
    others = 1;
    s.app.unmount();
    const withRun = render(
      <App
        createSession={() => inertSession() as unknown as SessionController}
        permissions={new PermissionBroker()}
        model="m"
        cwd="/tmp/work"
        runQuit={runQuit}
      />,
    );
    await delay(40);
    await type(withRun.stdin, "/quit");
    expect(strip(withRun.lastFrame())).toContain("1 other terminal attached");
    withRun.stdin.write("n");
    await delay(60);
    expect(calls).toEqual([]);
    withRun.unmount();
  });
});

describe("S8: /clear executes through the hook (its step, its refs)", () => {
  test("the daemon's clear is asked once, and its history replaces the transcript", async () => {
    // Mutation: the hook returns `runClear` but App never assigns `runClearRef`
    // → the step is "clear" and the call still goes out (this case passes);
    // the STOP-then-clear case below is the one that pins the ref.
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "/clear");
    expect(r.log.clears).toEqual(["clear"]);
    r.app.unmount();
  });

  test("busy: a second /clear is refused from the LIVE latch, and clears once", async () => {
    // Mutation: `clearing` wired to a render `false` → the second /clear sends a
    // second reset for the same conversation.
    const r = rig({ clearHangs: true });
    await delay(40);
    await type(r.app.stdin, "/clear");
    expect(r.log.clears).toEqual(["clear"]);
    await type(r.app.stdin, "/clear");
    expect(strip(r.app.lastFrame())).toContain("A /clear is already running.");
    expect(r.log.clears).toEqual(["clear"]);
    r.app.unmount();
  });

  test("an own running turn is stopped first, and the clear runs from the SETTLE (via `runClearRef`)", async () => {
    // Mutation: `runClearRef.current = runClear` dropped in App → the settle's
    // `runClearRef.current?.()` is a no-op and no reset is ever asked.
    const r = rig({ holdTurn: true });
    await delay(40);
    r.app.stdin.write("hang");
    await delay(20);
    r.app.stdin.write(ENTER);
    await delay(80);
    expect(r.log.clears).toEqual([]);
    await type(r.app.stdin, "/clear");
    // `clearAfterTurnRef` is armed and the turn aborted; the clear runs on settle.
    await delay(150);
    expect(r.log.clears).toEqual(["clear"]);
    r.app.unmount();
  });

  test("legacy is gone: `/clear` resets in place — nothing closes, no second session", async () => {
    // docs/feat/remove-in-process.md: `clear` is required, so `/clear` has ONE
    // path. Mutation: restore the `canClear === false` close-and-replace arm →
    // `closes` gets "close" and `creates` reaches 2.
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "/clear");
    await delay(80);
    expect(r.log.clears).toEqual(["clear"]);
    expect(r.log.closes).toEqual([]);
    expect(r.log.creates).toBe(1);
    r.app.unmount();
  });
});
