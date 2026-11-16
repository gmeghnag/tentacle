/**
 * `hub-actions.ts` — what the hub offers (docs/feat/mobile-hub.md Design 5–6,
 * P6, M7/M8/M9/M14): the order, the turn pair, absent-never-dead entries, badge
 * promotion, the six-slot rule, the commit re-validation, the button's badge.
 */
import { describe, expect, test } from "bun:test";
import {
  ALREADY_FINISHED,
  type ButtonBadgeInput,
  DUE_SOON_MS,
  type HubContext,
  type HubEntries,
  type HubOpen,
  NO_CONNECTION,
  buttonBadge,
  hubA11yLabel,
  hubActions,
  hubOpen,
  resolveCommit,
} from "../src/hub-actions.ts";

const noop = (): void => undefined;
const TURN = { kind: "turn", key: "t1", turnId: "t1", own: true } as const;

/** What `main` wires today (H3): no artifacts, no scheduled, no dictate. */
const MAIN: HubEntries = {
  stop: noop,
  steer: noop,
  attach: noop,
  activity: noop,
  sessions: noop,
  info: noop,
  new: noop,
};
const EVERY: HubEntries = { ...MAIN, artifacts: noop, scheduled: noop, dictate: noop };

const IDLE_CTX: HubContext = {
  link: "up",
  turn: null,
  ended: null,
  editable: true,
  dictation: false,
  schedules: 0,
  nextWakeInMs: null,
  unseenArtifacts: 0,
};
const RUNNING: HubContext = { ...IDLE_CTX, turn: TURN };
/** The snapshot a fan opened while `TURN` ran carries (H3 passes the `HubMenu` itself). */
const OPENED_RUNNING: HubOpen = { turnId: TURN.turnId };
const OPENED_IDLE: HubOpen = { turnId: null };

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

describe("hubActions: order and presence", () => {
  test("idle: the canonical order, no More while it fits in six", () => {
    const a = hubActions(IDLE_CTX, MAIN);
    expect(ids(a.fan)).toEqual(["attach", "activity", "sessions", "info", "new"]);
    expect(a.more).toEqual([]);
    expect(ids(a.all)).toEqual(ids(a.fan));
  });

  test("running: Stop, Steer first, then the canonical list; Stop is the only red item", () => {
    const a = hubActions(RUNNING, MAIN);
    expect(ids(a.all)).toEqual(["stop", "steer", "attach", "activity", "sessions", "info", "new"]);
    expect(a.all.filter((i) => i.danger).map((i) => i.id)).toEqual(["stop"]);
    expect(a.all[0]?.label).toBe("Stop");
  });

  test("a foreign turn gets the turn pair too", () => {
    const a = hubActions({ ...RUNNING, turn: { ...TURN, own: false } }, MAIN);
    expect(ids(a.all).slice(0, 2)).toEqual(["stop", "steer"]);
  });

  test("link down (M8): no Stop, no Steer", () => {
    const a = hubActions({ ...RUNNING, link: "down" }, MAIN);
    expect(ids(a.all)).not.toContain("stop");
    expect(ids(a.all)).not.toContain("steer");
  });

  test("an ended session: no turn pair, no Attach", () => {
    const a = hubActions({ ...RUNNING, ended: "closed", editable: false }, MAIN);
    expect(ids(a.all)).toEqual(["activity", "sessions", "info", "new"]);
  });

  test("Attach only while the session is editable", () => {
    expect(ids(hubActions({ ...IDLE_CTX, editable: false }, MAIN).all)).not.toContain("attach");
  });

  test("a missing entry is an absent action (P6/M9), whatever the context says", () => {
    const a = hubActions(
      { ...RUNNING, dictation: true, schedules: 2, unseenArtifacts: 3 },
      { activity: noop, info: noop },
    );
    expect(ids(a.all)).toEqual(["activity", "info"]);
    expect(hubActions(IDLE_CTX, {}).all).toEqual([]);
  });

  test("Dictate only with settings.dictation", () => {
    expect(ids(hubActions(IDLE_CTX, EVERY).all)).not.toContain("dictate");
    expect(ids(hubActions({ ...IDLE_CTX, dictation: true }, EVERY).all)).toContain("dictate");
  });

  test("Scheduled only with schedules (an older daemon never sends any)", () => {
    expect(ids(hubActions(IDLE_CTX, EVERY).all)).not.toContain("scheduled");
    expect(ids(hubActions({ ...IDLE_CTX, schedules: 1 }, EVERY).all)).toContain("scheduled");
  });
});

describe("hubActions: badges and promotion", () => {
  test("Artifacts carries the unseen count; Scheduled a dot only when due within 10 min", () => {
    const a = hubActions(
      { ...IDLE_CTX, unseenArtifacts: 3, schedules: 1, nextWakeInMs: DUE_SOON_MS },
      EVERY,
    );
    expect(a.all.find((i) => i.id === "artifacts")?.badge).toEqual({ kind: "count", n: 3 });
    expect(a.all.find((i) => i.id === "scheduled")?.badge).toEqual({ kind: "dot" });
    const later = hubActions({ ...IDLE_CTX, schedules: 1, nextWakeInMs: DUE_SOON_MS + 1 }, EVERY);
    expect(later.all.find((i) => i.id === "scheduled")?.badge).toBeNull();
    expect(later.all.find((i) => i.id === "artifacts")?.badge).toBeNull();
  });

  test("a badged item moves up to the first unbadged canonical slot, badged ones keep their order", () => {
    const a = hubActions({ ...IDLE_CTX, unseenArtifacts: 1, schedules: 1, nextWakeInMs: 0 }, EVERY);
    expect(ids(a.all)).toEqual([
      "artifacts",
      "scheduled",
      "attach",
      "activity",
      "sessions",
      "info",
      "new",
    ]);
  });

  test("promotion never passes the turn pair", () => {
    const a = hubActions({ ...RUNNING, unseenArtifacts: 1, schedules: 1, nextWakeInMs: 0 }, EVERY);
    expect(ids(a.all).slice(0, 4)).toEqual(["stop", "steer", "artifacts", "scheduled"]);
  });

  test("without badges nothing moves (muscle memory)", () => {
    const a = hubActions({ ...IDLE_CTX, schedules: 1, dictation: true }, EVERY);
    expect(ids(a.all)).toEqual([
      "attach",
      "activity",
      "artifacts",
      "sessions",
      "info",
      "scheduled",
      "dictate",
      "new",
    ]);
  });
});

describe("hubActions: six slots (M14)", () => {
  test("exactly six: all in the fan, no More", () => {
    const a = hubActions({ ...IDLE_CTX }, { ...MAIN, artifacts: noop });
    expect(a.all.length).toBe(6);
    expect(ids(a.fan)).toEqual(ids(a.all));
    expect(a.more).toEqual([]);
  });

  test("nine candidates: the first five + More, and the four others in More in canonical order", () => {
    const a = hubActions({ ...RUNNING, schedules: 1 }, { ...EVERY, dictate: undefined });
    expect(a.all.length).toBe(9);
    expect(ids(a.fan)).toEqual(["stop", "steer", "attach", "activity", "artifacts", "more"]);
    expect(ids(a.more)).toEqual(["sessions", "info", "scheduled", "new"]);
    expect(a.fan[5]?.label).toBe("More");
    expect(ids(a.all)).not.toContain("more");
  });
});

describe("resolveCommit: the world is read again at release (M7/M8)", () => {
  test("Stop while the turn still runs → run", () => {
    expect(resolveCommit("stop", RUNNING, MAIN, OPENED_RUNNING)).toEqual({
      kind: "run",
      id: "stop",
    });
  });

  test("Stop after the turn ended → no-op + Already finished", () => {
    expect(resolveCommit("stop", IDLE_CTX, MAIN, OPENED_RUNNING)).toEqual({
      kind: "noop",
      notice: ALREADY_FINISHED,
    });
    expect(resolveCommit("steer", IDLE_CTX, MAIN, OPENED_RUNNING)).toEqual({
      kind: "noop",
      notice: ALREADY_FINISHED,
    });
    expect(resolveCommit("stop", { ...RUNNING, ended: "gone" }, MAIN, OPENED_RUNNING)).toEqual({
      kind: "noop",
      notice: ALREADY_FINISHED,
    });
  });

  test("a DIFFERENT turn since the open → Already finished, never that new turn (M7)", () => {
    // Turn A ran when the fan opened; A ended and B started before the release
    // (an outbox flush, another device's prompt). Stopping B cancels a turn the
    // person never saw start.
    const next: HubContext = {
      ...IDLE_CTX,
      turn: { kind: "turn", key: "t2", turnId: "t2", own: false },
    };
    expect(resolveCommit("stop", next, MAIN, OPENED_RUNNING)).toEqual({
      kind: "noop",
      notice: ALREADY_FINISHED,
    });
    expect(resolveCommit("steer", next, MAIN, OPENED_RUNNING)).toEqual({
      kind: "noop",
      notice: ALREADY_FINISHED,
    });
    // B is stoppable now, but not from this fan: a closed fan does not reach it.
    expect(resolveCommit("stop", { ...next, link: "down" }, MAIN, OPENED_RUNNING)).toEqual({
      kind: "noop",
      notice: ALREADY_FINISHED,
    });
  });

  test("idle at the open: a turn that started since is not stoppable from that fan", () => {
    expect(resolveCommit("stop", RUNNING, MAIN, OPENED_IDLE)).toEqual({
      kind: "noop",
      notice: ALREADY_FINISHED,
    });
  });

  test("hubOpen takes the turn's identity at the open, null when idle", () => {
    expect(hubOpen(RUNNING)).toEqual({ turnId: TURN.turnId });
    expect(hubOpen(IDLE_CTX)).toEqual({ turnId: null });
    // End to end: the snapshot H3 takes at the open is what makes Stop reach
    // the turn it shows (and only that one).
    expect(resolveCommit("stop", RUNNING, MAIN, hubOpen(RUNNING))).toEqual({
      kind: "run",
      id: "stop",
    });
    expect(resolveCommit("stop", RUNNING, MAIN, hubOpen(IDLE_CTX))).toEqual({
      kind: "noop",
      notice: ALREADY_FINISHED,
    });
  });

  test("Stop when the link dropped mid-press → no-op + the link notice", () => {
    expect(resolveCommit("stop", { ...RUNNING, link: "down" }, MAIN, OPENED_RUNNING)).toEqual({
      kind: "noop",
      notice: NO_CONNECTION,
    });
  });

  test("Attach on an ended session → a silent no-op, even where the prompt is editable", () => {
    expect(
      resolveCommit("attach", { ...IDLE_CTX, ended: "closed", editable: false }, MAIN, OPENED_IDLE),
    ).toEqual({
      kind: "noop",
      notice: null,
    });
    expect(
      resolveCommit("attach", { ...IDLE_CTX, ended: "closed", editable: true }, MAIN, OPENED_IDLE),
    ).toEqual({ kind: "noop", notice: null });
  });

  test("an entry gone since the open → a silent no-op; More and live entries run", () => {
    expect(resolveCommit("artifacts", IDLE_CTX, MAIN, OPENED_IDLE)).toEqual({
      kind: "noop",
      notice: null,
    });
    expect(resolveCommit("more", IDLE_CTX, MAIN, OPENED_IDLE)).toEqual({ kind: "run", id: "more" });
    expect(resolveCommit("activity", IDLE_CTX, MAIN, OPENED_IDLE)).toEqual({
      kind: "run",
      id: "activity",
    });
  });
});

describe("buttonBadge + hubA11yLabel", () => {
  const none: ButtonBadgeInput = { running: 0, unseenArtifacts: 0, unreadReport: false };

  test("priority: a number (running) > a dot (unseen / unread) > none", () => {
    expect(buttonBadge({ running: 2, unseenArtifacts: 3, unreadReport: true })).toEqual({
      kind: "count",
      n: 2,
    });
    expect(buttonBadge({ ...none, unseenArtifacts: 3 })).toEqual({ kind: "dot" });
    expect(buttonBadge({ ...none, unreadReport: true })).toEqual({ kind: "dot" });
    expect(buttonBadge(none)).toBeNull();
  });

  test("the label says everything the badge stands for", () => {
    expect(hubA11yLabel({ running: 2, unseenArtifacts: 3, unreadReport: false })).toBe(
      "Tentacle hub, 2 running, 3 new artifacts",
    );
    expect(hubA11yLabel({ running: 1, unseenArtifacts: 1, unreadReport: true })).toBe(
      "Tentacle hub, 1 running, 1 new artifact, unread report",
    );
    expect(hubA11yLabel(none)).toBe("Tentacle hub");
  });
});
