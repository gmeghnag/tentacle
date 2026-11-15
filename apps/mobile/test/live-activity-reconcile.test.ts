/**
 * Live Activity RECONCILE (docs/feat/mobile-live-activity.md Design 7, L11): on
 * every connect, bringing the phone's activities back in line with the daemon.
 *
 * The daemon is the TRUTH: it decides whether a turn is still running, and the
 * phone cannot know when it was offline (F1/F2). So the plan is computed from
 * what the daemon says, with these rules:
 *
 *  - an activity whose content no longer OPENS (a forged one, or one sealed
 *    before a computer reset — F6/F11) is ENDED, never left on the lock screen;
 *  - an activity for a turn that is no longer running is ENDED (`ended`), and
 *    one the person dismissed is reported `dismissed` so the daemon never
 *    restarts it for that turn (F17);
 *  - an activity whose update token the daemon does not know yet is REPORTED, so
 *    updates resume (Owner Q8: the table is memory-only, so a daemon restart
 *    makes every token unknown).
 *
 * Pure: the daemon's view and the phone's list are injected.
 */
import { describe, expect, test } from "bun:test";
import type { ActivityContent } from "@tentacle/protocol";
import {
  type LaLocalActivity,
  type LaReconcileDeps,
  planLiveActivityReconcile,
} from "../src/live-activity-reconcile.ts";

const COMPUTER = "0123456789abcdef";
const SESSION = "s1";
const SLOT = "00112233445566778899aabb";

const content = (over: Partial<ActivityContent> = {}): ActivityContent => ({
  v: 1,
  slot: SLOT,
  seq: 1,
  at: 1_731_000_000_000,
  kind: "running",
  computer: "mac-mini",
  project: "tentacle",
  title: "fix",
  turnId: "t1",
  startedAt: 1_730_999_980_000,
  ...over,
});

const local = (over: Partial<LaLocalActivity> = {}): LaLocalActivity => ({
  id: "activity-1",
  slot: SLOT,
  computerId: COMPUTER,
  sessionId: SESSION,
  turnId: "t1",
  state: "active",
  contentState: { v: 1, e: "A".repeat(43), c: "B".repeat(704) },
  ...over,
});

const deps = (over: Partial<LaReconcileDeps> = {}): LaReconcileDeps => ({
  activities: [local()],
  // The daemon's view: the session exists and its turn t1 is RUNNING.
  daemon: { isTurnRunning: (sessionId, turnId) => sessionId === SESSION && turnId === "t1" },
  // The seal opens (a key is pinned and the state is current).
  openContent: () => content(),
  // The daemon already knows this activity's update token.
  updateTokenOf: () => "c".repeat(64),
  ackedToken: "c".repeat(64),
  ...over,
});

describe("planLiveActivityReconcile", () => {
  test("everything consistent: nothing to do", () => {
    expect(planLiveActivityReconcile(deps())).toEqual([]);
  });

  test("an activity whose content does not OPEN is ended (F6/F11)", () => {
    // Mutation: skip the open check → a forged activity stays on the lock screen.
    const plan = planLiveActivityReconcile(deps({ openContent: () => undefined }));
    expect(plan).toEqual([{ do: "end", activityId: "activity-1", reason: "stale" }]);
  });

  test("an activity for a turn that is NO LONGER RUNNING is ended", () => {
    // The daemon is the truth: the app was closed when the turn finished.
    const plan = planLiveActivityReconcile(deps({ daemon: { isTurnRunning: () => false } }));
    expect(plan).toEqual([{ do: "end", activityId: "activity-1", reason: "ended" }]);
  });

  test("a dismissed activity is reported `dismissed`, so it is never restarted (F17)", () => {
    const plan = planLiveActivityReconcile(deps({ activities: [local({ state: "dismissed" })] }));
    expect(plan).toEqual([{ do: "end", activityId: "activity-1", reason: "dismissed" }]);
  });

  test("an unacked update token is reported, so updates resume (Owner Q8)", () => {
    const plan = planLiveActivityReconcile(
      deps({ updateTokenOf: () => "d".repeat(64), ackedToken: undefined }),
    );
    expect(plan).toEqual([
      { do: "reportToken", activityId: "activity-1", slot: SLOT, token: "d".repeat(64) },
    ]);
  });

  test("the same token twice is reported once (nothing to say)", () => {
    const plan = planLiveActivityReconcile(
      deps({ updateTokenOf: () => "d".repeat(64), ackedToken: "d".repeat(64) }),
    );
    expect(plan).toEqual([]);
  });

  test("an activity with NO update token yet is not reported (iOS has not issued one)", () => {
    const plan = planLiveActivityReconcile(
      deps({ updateTokenOf: () => undefined, ackedToken: undefined }),
    );
    expect(plan).toEqual([]);
  });

  test("ending takes precedence over reporting a token (a dead activity needs no token)", () => {
    const plan = planLiveActivityReconcile(
      deps({
        daemon: { isTurnRunning: () => false },
        updateTokenOf: () => "d".repeat(64),
        ackedToken: undefined,
      }),
    );
    expect(plan).toEqual([{ do: "end", activityId: "activity-1", reason: "ended" }]);
  });
});
