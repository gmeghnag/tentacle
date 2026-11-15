/**
 * docs/feat/app-decomposition.md S11 (`feat/app-decomp-11-hop`) — the hop's
 * executor moved into `useHop`, so the ONE thing the move could silently change
 * is the SOURCE of the facts its commands read.
 *
 * `requestHop` runs inside the ONE `useInput` handler, and two commands can be
 * dispatched in that same handler with no render between them (`App` re-resolves
 * a command through `handleCommandRef`, and a proposal's approval arrives
 * asynchronously). In that window React has not committed, so `hopQueued` (state)
 * still reads its OLD value while `hopQueuedRef` is already the new one — the
 * freshness rule (plan H3) the pre-S11 code obeyed by writing the ref eagerly
 * inside `requestHop`.
 *
 * Why this is a HOOK test and not a frame test: the frames cannot express the
 * window. `/move` text reaches `requestHop` through the field editor, and the key
 * snapshot reads the field's RENDER value (`keys/snapshot.ts`), so an Enter with
 * no render between the typing and itself sees an empty field and dispatches
 * nothing at all. The property is therefore only observable where the hook is
 * called twice without a commit — which is exactly what this test does.
 *
 * A hook that kept the state and let the ref follow at render time (the obvious
 * "simplification") passes every render test in the package and fails here: the
 * second `/move` would see `hopQueued: false`, decide it may queue, and REPLACE
 * the hop the user already queued.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import type { SessionController } from "../src/app-types.ts";
import type { HopRun } from "../src/app-types.ts";
import type { HopSpec } from "../src/hop-command.ts";
import { HOP_QUEUED_NOTICE } from "../src/hop-command.ts";
import type { PermissionController } from "../src/permission-ui.ts";
import type { DaemonQueue, QueuedRows } from "../src/queued.ts";
import type { DisplayState } from "../src/state.ts";
import { type HopLayer, useHop } from "../src/useHop.ts";

/**
 * The two facts the boundary reads, as the host holds them at the moment a
 * command runs. Defaults: a turn in flight and an empty queue — the boundary
 * case whose two writes must agree.
 */
interface Boundary {
  readonly running?: boolean;
  readonly rows?: QueuedRows;
  readonly daemonQueue?: DaemonQueue;
}

/** A minimal host. */
function harness(opts: Boundary = {}) {
  const notices: string[] = [];
  const started: string[] = [];
  /** OD6: what the host's `sendWake` was asked to start (one entry per self-continue). */
  const wakes: string[] = [];
  /** Every hop's `done`, so a test can settle the hop it started. */
  const settles: Array<(outcome: Awaited<HopRun["done"]>) => void> = [];
  const layer: { current: HopLayer | null } = { current: null };
  const host = {
    sessionRef: { current: null },
    stateRef: { current: { running: opts.running ?? true } as DisplayState },
    rowsRef: { current: (opts.rows ?? []) as QueuedRows },
    daemonQueueRef: { current: opts.daemonQueue },
    switchingRef: { current: false },
    startHopRef: { current: null as ((spec: HopSpec) => void) | null },
    wakeAfterHopRef: { current: null as ((outcome: "declined" | "failed") => void) | null },
    sendWake: (text: string) => wakes.push(text),
    hop: {
      label: (spec: HopSpec) => (spec.target === "local" ? "local" : "docker:box"),
      start(spec: HopSpec) {
        started.push(spec.target);
        const done = new Promise<Awaited<HopRun["done"]>>((resolve) => {
          settles.push(resolve);
        });
        return { onStatus: () => () => {}, done };
      },
    },
    permission: {
      autoApprove: false,
      clearAutoApprove: () => {},
    } as unknown as PermissionController,
    swapSession: () => {},
    pushNotice: (text: string) => notices.push(text),
    flushNow: () => {},
  };
  function Probe() {
    const hop = useHop(host);
    layer.current = hop;
    return null;
  }
  const app = render(createElement(Probe));
  const current = layer.current;
  if (current === null) {
    throw new Error("the probe did not render");
  }
  return {
    app,
    hop: current,
    notices,
    started,
    wakes,
    /** Settle the hop started last, as the host's `done` does (then let its `.then` run). */
    settle: async (outcome: Awaited<HopRun["done"]>) => {
      const last = settles.at(-1);
      if (last === undefined) {
        throw new Error("no hop was started");
      }
      last(outcome);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    host,
    /** Commit a render and read what the hook NOW returns (its state, not its refs). */
    show: (): HopLayer | null => {
      app.rerender(createElement(Probe));
      return layer.current;
    },
  };
}

describe("S11 freshness: two `/move`s with NO render between them", () => {
  test("the second sees the FIRST's queued spec (`hopQueuedRef` is eager)", () => {
    // Mutation: write only the state in `requestHop`'s queue branch (let the ref
    // follow the commit) → the second call queues again, and the first spec is
    // silently replaced.
    const h = harness();
    h.hop.requestHop("/move local");
    h.hop.requestHop("/move container");
    // Both calls ran against the same committed state (no render between them),
    // so only the NOTICES can differ — and the second one is the refusal.
    expect(h.notices).toEqual([HOP_QUEUED_NOTICE, "_a move is already queued_"]);
    expect(h.started).toEqual([]);
    // …and the spec the first call queued is the one that survived.
    expect(h.show()?.hopQueued).toEqual({ target: "local", keep: true });
    h.app.unmount();
  });

  test("`/move cancel` clears state AND ref, so the next `/move` may queue again", () => {
    // Mutation: cancel clears the state only → the following `/move`, in the same
    // pre-commit window, still reads "a move is already queued", and the user
    // cannot queue a replacement without a render.
    const h = harness();
    h.hop.requestHop("/move local");
    h.hop.requestHop("/move cancel");
    h.hop.requestHop("/move container");
    expect(h.notices).toEqual([HOP_QUEUED_NOTICE, "_Move cancelled._", HOP_QUEUED_NOTICE]);
    expect(h.show()?.hopQueued).toEqual({ target: "container", keep: true });
    h.app.unmount();
  });

  test("the control: a single `/move` on a running turn queues (`hopReady`, not a start)", () => {
    const h = harness();
    h.hop.requestHop("/move local");
    expect(h.notices).toEqual([HOP_QUEUED_NOTICE]);
    expect(h.started).toEqual([]);
    h.app.unmount();
  });
});

describe("OD6: a hop settles into an IDLE session or it does not wake (review round 1, MEDIUM 2)", () => {
  /** Start a MODEL-proposed hop through the hook's own entry point, and return it. */
  function startProposal(h: ReturnType<typeof harness>): void {
    h.hop.hopOriginRef.current = "proposal";
    h.host.startHopRef.current?.({ target: "local", keep: true });
  }

  test("the control: idle at the settle ⇒ ONE wake send", async () => {
    const h = harness({ running: false });
    startProposal(h);
    await h.settle({ failed: "not moved: nope" });
    expect(h.wakes).toHaveLength(1);
    h.app.unmount();
  });

  test("a turn of ours running at the settle ⇒ HOLD: no second concurrent own turn", async () => {
    // The reviewer's scenario: the hop settles while something else already owns
    // the turn (a job wake started by `wakeIfPending`, a foreign turn `drainHeld`
    // started). RED before the fix: `useHop` called `sendWake` with no `hopReady`
    // check, so the wake began a SECOND own turn on top of the running one.
    // Mutation: drop `ready:` from `after()`'s `hopWakeStep` call → `wakes` has 1.
    const h = harness({ running: false });
    startProposal(h);
    h.host.stateRef.current = { running: true } as DisplayState;
    await h.settle({ failed: "not moved: nope" });
    expect(h.wakes).toEqual([]);
    h.app.unmount();
  });

  test("a queued row at the settle ⇒ HOLD (the messages run first, D4)", async () => {
    // Mutation: same as above; the `queued` half of `hopReady` is what fails here.
    const h = harness({ running: false });
    startProposal(h);
    h.host.daemonQueueRef.current = { entries: [{ id: "q1", text: "next" }] };
    await h.settle({ failed: "not moved: nope" });
    expect(h.wakes).toEqual([]);
    h.app.unmount();
  });

  test("a DECLINED proposal settling into a busy session ⇒ HOLD too (`wakeSettled`)", () => {
    // The other `hopWakeStep` call site: a decline arrives asynchronously (the ask
    // can wait on a human), so it is the one that most easily lands on a busy
    // session. Mutation: drop `ready:` from `wakeSettled` → `wakes` has 1.
    const h = harness({ running: false });
    h.host.wakeAfterHopRef.current?.("declined");
    expect(h.wakes).toHaveLength(1);
    h.host.stateRef.current = { running: true } as DisplayState;
    h.host.wakeAfterHopRef.current?.("declined");
    expect(h.wakes).toHaveLength(1);
    h.app.unmount();
  });
});

/**
 * The daemon-queue HALF of the boundary (review round 1, MEDIUM 1). `hopReady`
 * calls a hop startable only when this TUI's turn is over AND the daemon's queue
 * is empty: the messages already queued run before anything else does (D4). The
 * pure function pins the rule, but the two WIRINGS that feed it were unpinned —
 * `requestHop` and `hopIfQueued` could each pass `queued: 0` (or `hopReady({
 * running })` without the queue at all) and every other test in the package
 * stayed green while a queued `/move` ran AHEAD of the daemon's queued messages.
 *
 * So these drive the hook itself with `running: false` and a non-empty
 * `daemonQueueRef`/`rowsRef`, the exact state the bug needs.
 */
describe("S11 boundary: the daemon's queue blocks a hop even with no turn running", () => {
  test("`requestHop` QUEUES (never starts) while the daemon still holds messages", () => {
    // Mutation: `requestHop` → `hopReady({ running: stateRef.current.running,
    // queued: 0 })` (or `boundary` dropping the queue) → the notice becomes the
    // moved/started path and `started` is non-empty.
    const h = harness({ running: false, daemonQueue: { entries: [{ id: "q1", text: "next" }] } });
    h.hop.requestHop("/move local");
    expect(h.notices).toEqual([HOP_QUEUED_NOTICE]);
    expect(h.started).toEqual([]);
    h.app.unmount();
  });

  test("`hopIfQueued` starts nothing while the queue is non-empty, then starts once it drains", () => {
    // The queued path, end to end: it must re-check the SAME two facts. Mutation:
    // `hopIfQueued` → `hopReady({ running: stateRef.current.running, queued: 0 })`
    // (or `boundary` dropping the queue) → the first call starts the hop while
    // the daemon still has a message waiting.
    const h = harness({ running: false, daemonQueue: { entries: [{ id: "q1", text: "next" }] } });
    h.hop.requestHop("/move local");
    expect(h.notices).toEqual([HOP_QUEUED_NOTICE]);

    // Idle effect #1, daemon still busy: the hop stays queued.
    const first = h.show();
    first?.hopIfQueuedRef.current?.();
    expect(h.started).toEqual([]);
    expect(h.show()?.hopQueued).toEqual({ target: "local", keep: true });

    // The daemon drained its queue and the effect asks again: now it starts.
    h.host.daemonQueueRef.current = { entries: [] };
    h.show()?.hopIfQueuedRef.current?.();
    expect(h.started).toEqual(["local"]);
    expect(h.show()?.hopQueued).toBeNull();
    h.app.unmount();
  });

  test("the control: with no turn and an empty queue the queued hop starts at once", () => {
    const h = harness({ running: false });
    h.hop.requestHop("/move local");
    // Nothing to wait for, so the typed path STARTS it (no queue at all).
    expect(h.notices).toEqual([]);
    expect(h.started).toEqual(["local"]);
    h.app.unmount();
  });
});
