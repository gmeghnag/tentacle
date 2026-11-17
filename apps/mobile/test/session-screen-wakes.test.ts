/**
 * The wakes reach the SCREEN (docs/feat/mobile-hub.md H4a): the session's armed
 * scheduled wakes are followed from the SAME attach as the background lists
 * (cron-tool S6's `RemoteSession.schedules`/`onSchedules`, the seam the Session
 * info sheet already reads), so the hub's Scheduled item can be present, badged,
 * and know what it is about.
 *
 * The seam is the client's, gated by its `daemonWakes` trust bit (a pod's table is
 * dropped there, AGENTS §7) — this file only proves the screen carries whatever
 * that seam reports, and that a handle without it says `undefined`, never `[]`
 * (P6/M9: an older daemon must not look like "zero wakes armed").
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { ScheduleRow } from "@tentacle/protocol";
import { createSessionController } from "../src/session-controller.ts";
import type { SendableHandle } from "../src/session-screen-controller.ts";
import { createSessionScreen } from "../src/session-screen-controller.ts";

const WAKE: ScheduleRow = {
  id: "sc-1",
  kind: "every",
  spec: "every 10m",
  prompt: "check CI on PR #412",
  nextAt: 1_700_000_600_000,
  fires: 4,
  createdAt: 1,
};

function harness(options: { readonly wakes: boolean; readonly initial?: readonly ScheduleRow[] }) {
  let feed: ((report: { rows: readonly ScheduleRow[]; count: number }) => void) | null = null;
  let unsubscribed = 0;
  const handle: SendableHandle = {
    open: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    watch: () => () => {},
    async *send(): AsyncIterable<SessionEvent> {
      yield { type: "turn_end", reason: "end_turn" } as never;
    },
    ...(options.wakes
      ? {
          onSchedules: (fn: (report: { rows: readonly ScheduleRow[]; count: number }) => void) => {
            feed = fn;
            if (options.initial !== undefined) {
              // The seam hands what the client already knows at once (contract).
              fn({ rows: options.initial, count: options.initial.length });
            }
            return () => {
              feed = null;
              unsubscribed += 1;
            };
          },
        }
      : {}),
  };
  const screen = createSessionScreen({
    sessionId: "s1",
    archived: false,
    title: "Alpha",
    project: "e2e-mac",
    controller: createSessionController<SendableHandle>({ newSession: () => handle }),
    broker: new PermissionBroker(undefined, { holdUntilSet: true }),
    now: () => 1_700_000_000_000,
  });
  return {
    screen,
    push: (rows: readonly ScheduleRow[]) => feed?.({ rows, count: rows.length }),
    unsubscribed: () => unsubscribed,
  };
}

describe("the screen follows the daemon's wake table from the attach (H4a)", () => {
  test("the table the seam already knows is on the first frame", async () => {
    const h = harness({ wakes: true, initial: [WAKE] });
    await h.screen.open();
    expect(h.screen.state().schedules).toEqual([WAKE]);
  });

  test("a later report reaches a SUBSCRIBER too (the screen repaints, not just state())", async () => {
    const h = harness({ wakes: true });
    await h.screen.open();
    let seen: readonly ScheduleRow[] | undefined;
    h.screen.subscribe((state) => {
      seen = state.schedules;
    });
    h.push([{ ...WAKE, id: "sc-2" }]);
    // Without the emit the state is right and the screen never repaints — the
    // fan would keep the table it solved at open.
    expect(seen?.map((row) => row.id)).toEqual(["sc-2"]);
  });

  test("a later report replaces it (a wake created, fired, or deleted elsewhere)", async () => {
    const h = harness({ wakes: true, initial: [WAKE] });
    await h.screen.open();
    expect(h.screen.state().schedules).toEqual([WAKE]);
    h.push([{ ...WAKE, id: "sc-2", fires: 5 }]);
    expect(h.screen.state().schedules?.map((row) => row.id)).toEqual(["sc-2"]);
    // Empty is a REPORTED empty table, which is what clears the hub's item.
    h.push([]);
    expect(h.screen.state().schedules).toEqual([]);
  });

  test("a handle with no wake feed says `undefined`, never an empty table (M9/P6)", async () => {
    const h = harness({ wakes: false });
    await h.screen.open();
    // `undefined` is "no table, or a daemon this client must not trust"; `[]`
    // would claim the daemon reported zero wakes, which it never did.
    expect(h.screen.state().schedules).toBeUndefined();
    // …and a report that CANNOT arrive (no feed) never turns it into `[]`.
    h.push([]);
    expect(h.screen.state().schedules).toBeUndefined();
  });

  test("leaving the screen unsubscribes the wake feed (no listener outlives it)", async () => {
    const h = harness({ wakes: true, initial: [WAKE] });
    await h.screen.open();
    h.screen.dispose();
    expect(h.unsubscribed()).toBe(1);
  });
});
