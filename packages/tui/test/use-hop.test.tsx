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
import type { HopSpec } from "../src/hop-command.ts";
import { HOP_QUEUED_NOTICE } from "../src/hop-command.ts";
import type { PermissionController } from "../src/permission-ui.ts";
import type { DisplayState } from "../src/state.ts";
import { type HopLayer, useHop } from "../src/useHop.ts";

/**
 * A minimal host. The turn is RUNNING, so every `/move` is the boundary case:
 * queued, never started — which is the branch whose two writes must agree.
 */
function harness() {
  const notices: string[] = [];
  const started: string[] = [];
  const layer: { current: HopLayer | null } = { current: null };
  const host = {
    sessionRef: { current: null },
    stateRef: { current: { running: true } as DisplayState },
    rowsRef: { current: [] },
    daemonQueueRef: { current: undefined },
    switchingRef: { current: false },
    startHopRef: { current: null },
    hop: {
      label: (spec: HopSpec) => (spec.target === "local" ? "local" : "docker:box"),
      start(spec: HopSpec) {
        started.push(spec.target);
        return { onStatus: () => () => {}, done: new Promise<never>(() => {}) };
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
