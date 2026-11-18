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
  type HubBadge,
  type HubContext,
  type HubEntries,
  type HubItem,
  type HubOpen,
  NOTHING_RUNNING,
  NO_CONNECTION,
  NO_TOOLS,
  PULSE_START,
  type PulseInput,
  type PulseState,
  buttonBadge,
  hubA11yLabel,
  hubActions,
  hubOpen,
  hubPulse,
  itemA11yLabel,
  pulseStep,
  resolveCommit,
} from "../src/hub-actions.ts";
import { fanItemLook } from "../src/hub-fan.ts";
import { commitPlan, hubContextOf } from "../src/hub-session.ts";

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
const EVERY: HubEntries = {
  ...MAIN,
  artifacts: noop,
  scheduled: noop,
  dictate: noop,
  tools: noop,
};

const IDLE_CTX: HubContext = {
  link: "up",
  turn: null,
  ended: null,
  editable: true,
  dictation: false,
  schedules: 0,
  nextWakeInMs: null,
  unseenArtifacts: 0,
  activityEmpty: false,
  toolsEmpty: false,
  toolsRim: null,
};
const RUNNING: HubContext = { ...IDLE_CTX, turn: TURN };
/** The snapshot a fan opened while `TURN` ran carries (H3 passes the `HubMenu` itself). */
const OPENED_RUNNING: HubOpen = { turnId: TURN.turnId };
const OPENED_IDLE: HubOpen = { turnId: null };

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

describe("hubActions: order and presence", () => {
  test("idle: the canonical order, no More while it fits in six", () => {
    const a = hubActions(IDLE_CTX, MAIN);
    expect(ids(a.fan)).toEqual(["attach", "activity", "info", "sessions", "new"]);
    expect(a.more).toEqual([]);
    expect(ids(a.all)).toEqual(ids(a.fan));
  });

  test("running: Stop, Steer first, then the canonical list; Stop is the only red item", () => {
    const a = hubActions(RUNNING, MAIN);
    expect(ids(a.all)).toEqual(["stop", "steer", "attach", "activity", "info", "sessions", "new"]);
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
    expect(ids(a.all)).toEqual(["activity", "info", "sessions", "new"]);
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
      "info",
      "tools",
      "sessions",
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
      "info",
      "tools",
      "sessions",
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

  test("ten candidates: the first five + More, and the five others in More in canonical order", () => {
    const a = hubActions({ ...RUNNING, schedules: 1 }, EVERY);
    expect(a.all.length).toBe(10);
    expect(ids(a.fan)).toEqual(["stop", "steer", "attach", "activity", "artifacts", "more"]);
    expect(ids(a.more)).toEqual(["info", "tools", "sessions", "scheduled", "new"]);
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

describe("a dimmed item: nothing to show, but its slot stays (Design 2)", () => {
  /** Nothing running and no wake feed: Activity has nothing to open. */
  const EMPTY: HubContext = { ...IDLE_CTX, activityEmpty: true };
  const dimmedIds = (items: readonly { id: string; dimmed: boolean }[]) =>
    items.filter((i) => i.dimmed).map((i) => i.id);

  test("only Activity is dimmed, and only when it is empty", () => {
    expect(dimmedIds(hubActions(EMPTY, EVERY).all)).toEqual(["activity"]);
    expect(dimmedIds(hubActions(IDLE_CTX, EVERY).all)).toEqual([]);
  });

  test("a dimmed item keeps its slot: the order is the owner's, never a hidden row", () => {
    const a = hubActions(EMPTY, EVERY);
    expect(ids(a.all)).toEqual(ids(hubActions(IDLE_CTX, EVERY).all));
    expect(ids(a.fan)).toEqual(ids(hubActions(IDLE_CTX, EVERY).fan));
  });

  test("an item that is not offered is not dimmed either (no dimmed row for an absent action)", () => {
    expect(hubActions(EMPTY, { info: noop }).all.every((i) => !i.dimmed)).toBe(true);
  });

  test('committing an empty Activity → a no-op saying "Nothing running"', () => {
    expect(resolveCommit("activity", EMPTY, EVERY, OPENED_IDLE)).toEqual({
      kind: "noop",
      notice: NOTHING_RUNNING,
    });
    expect(NOTHING_RUNNING).toBe("Nothing running");
  });

  test("a live Activity runs, and the release-time world is what counts (both directions)", () => {
    expect(resolveCommit("activity", IDLE_CTX, EVERY, OPENED_IDLE)).toEqual({
      kind: "run",
      id: "activity",
    });
    // Dimmed at the open, something started running before the release: it opens.
    expect(resolveCommit("activity", IDLE_CTX, EVERY, OPENED_IDLE).kind).toBe("run");
    // Live at the open, the last child ended before the release: it says so.
    expect(resolveCommit("activity", EMPTY, EVERY, OPENED_IDLE)).toEqual({
      kind: "noop",
      notice: NOTHING_RUNNING,
    });
    // And the end-to-end plan the screen acts on carries it (`hub-session.ts`).
    expect(commitPlan("activity", EMPTY, EVERY, hubOpen(EMPTY))).toEqual({
      kind: "notice",
      text: NOTHING_RUNNING,
    });
    expect(commitPlan("activity", IDLE_CTX, EVERY, hubOpen(IDLE_CTX))).toEqual({
      kind: "run",
      id: "activity",
    });
  });
});

describe("buttonBadge + hubA11yLabel", () => {
  const none: ButtonBadgeInput = { running: 0, unseenArtifacts: 0, unreadReport: false };

  test("only a running count: news is the glow's business, never a dot (mobile-hub-badges Q1 C)", () => {
    expect(buttonBadge({ running: 2, unseenArtifacts: 3, unreadReport: true })).toEqual({
      kind: "count",
      n: 2,
    });
    // The dot is gone: nothing new draws a mark on the button.
    expect(buttonBadge({ ...none, unseenArtifacts: 3 })).toBeNull();
    expect(buttonBadge({ ...none, unreadReport: true })).toBeNull();
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

describe("hubPulse (mobile-hub-badges Design 2: one-shot glow, Q1 C)", () => {
  const quiet: PulseInput = { unseenArtifacts: 0, unreadReport: false };

  test("a first render has no baseline: opening a session with news never pulses (F1, Q3)", () => {
    expect(hubPulse(null, quiet)).toBe(false);
    expect(hubPulse(null, { unseenArtifacts: 4, unreadReport: true })).toBe(false);
  });

  test("an increase pulses", () => {
    expect(
      hubPulse(
        { unseenArtifacts: 2, unreadReport: false },
        { unseenArtifacts: 3, unreadReport: false },
      ),
    ).toBe(true);
    expect(hubPulse(quiet, { unseenArtifacts: 1, unreadReport: false })).toBe(true);
    expect(hubPulse(quiet, { unseenArtifacts: 0, unreadReport: true })).toBe(true);
  });

  test("no change, or a decrease, is silent (F2: a resync that relists the same news)", () => {
    expect(
      hubPulse(
        { unseenArtifacts: 3, unreadReport: false },
        { unseenArtifacts: 3, unreadReport: false },
      ),
    ).toBe(false);
    expect(
      hubPulse(
        { unseenArtifacts: 3, unreadReport: false },
        { unseenArtifacts: 2, unreadReport: false },
      ),
    ).toBe(false);
    // Reading the report is not news either: true → true is unchanged.
    expect(
      hubPulse(
        { unseenArtifacts: 0, unreadReport: true },
        { unseenArtifacts: 0, unreadReport: true },
      ),
    ).toBe(false);
  });

  test("a count that drops while the report lands is still news (the report went false → true)", () => {
    expect(
      hubPulse(
        { unseenArtifacts: 3, unreadReport: false },
        { unseenArtifacts: 1, unreadReport: true },
      ),
    ).toBe(true);
  });
});

describe("pulseStep (mobile-hub-badges Design 4: the screen's ONE pulse decision, F1–F3)", () => {
  const quiet: PulseInput = { unseenArtifacts: 0, unreadReport: false };
  const three: PulseInput = { unseenArtifacts: 3, unreadReport: false };
  const KEY = "session-a";
  /** One render: feed the retained state back in, as the screen's ref does. */
  const run = (state: PulseState, link: "up" | "down", news: PulseInput, sessionKey = KEY) =>
    pulseStep(state, { sessionKey, link, news });

  test("a first render takes a baseline and does not pulse (F1: opening a session with news)", () => {
    const step = run(PULSE_START, "up", three);
    expect(step.pulse).toBe(false);
    expect(step.state).toEqual({ sessionKey: KEY, prev: three });
  });

  test("the increase AFTER that first render pulses (F1: the reset must not swallow it)", () => {
    // The old wiring reset the baseline to `null` on a session switch and left the
    // comparison to a later render, which then saw `null` and stayed silent.
    const opened = run(PULSE_START, "up", three);
    expect(run(opened.state, "up", { unseenArtifacts: 4, unreadReport: false }).pulse).toBe(true);
  });

  test("a session switch is a new baseline, and the next real increase still pulses (F1)", () => {
    const onA = run(run(PULSE_START, "up", three).state, "up", three);
    // Switching to a session that already holds MORE news: baseline, not news.
    const switched = run(onA.state, "up", { unseenArtifacts: 7, unreadReport: false }, "session-b");
    expect(switched.pulse).toBe(false);
    expect(switched.state).toEqual({
      sessionKey: "session-b",
      prev: { unseenArtifacts: 7, unreadReport: false },
    });
    // And the very next increase — the property the old reset swallowed.
    expect(
      run(switched.state, "up", { unseenArtifacts: 8, unreadReport: false }, "session-b").pulse,
    ).toBe(true);
  });

  test("a link drop clears the baseline, so the reconnect's refill is not news (F2)", () => {
    const live = run(run(PULSE_START, "up", three).state, "up", three);
    // Down: no baseline retained, nothing pulses.
    const down = run(live.state, "down", { unseenArtifacts: 0, unreadReport: false });
    expect(down.pulse).toBe(false);
    expect(down.state.prev).toBeNull();
    // Reconnect relists the SAME three artifacts: a fresh baseline, not a 0 → 3 jump.
    const back = run(down.state, "up", three);
    expect(back.pulse).toBe(false);
    expect(back.state.prev).toEqual(three);
  });

  test("a resync that relists the same news is silent (F2: 3 → 3)", () => {
    const live = run(run(PULSE_START, "up", three).state, "up", three);
    expect(run(live.state, "up", three).pulse).toBe(false);
  });

  test("the baseline advances while down as nothing, never as the reading (F2)", () => {
    // Advancing the baseline during the outage is what made the refill silent in
    // the WRONG direction (a drop-time 0 became the baseline); it must be cleared.
    const down = run({ sessionKey: KEY, prev: three }, "down", {
      unseenArtifacts: 9,
      unreadReport: true,
    });
    expect(down.state.prev).toBeNull();
  });

  test("the verdict ignores whether the button is shown, so a hidden button still advances (F3)", () => {
    // F3 is the screen's: the rule has no `shown` input at all, and the same step
    // both decides and re-baselines, so nothing is deferred and nothing replayed.
    const live = run(run(PULSE_START, "up", three).state, "up", three);
    const grown = run(live.state, "up", { unseenArtifacts: 4, unreadReport: false });
    expect(grown.pulse).toBe(true);
    expect(grown.state.prev).toEqual({ unseenArtifacts: 4, unreadReport: false });
  });
});

describe("itemA11yLabel (mobile-hub-badges Design 10: the rim is spoken)", () => {
  const item = (badge: HubBadge | null, dimmed = false): HubItem => ({
    id: "artifacts",
    label: "Artifacts",
    badge,
    danger: false,
    dimmed,
  });

  test("a count says how many are new (the bubble's number, now in words)", () => {
    expect(itemA11yLabel(item({ kind: "count", n: 3 }))).toBe("Artifacts, 3 new");
    expect(itemA11yLabel(item({ kind: "count", n: 1 }))).toBe("Artifacts, 1 new");
  });

  test("a dot (a wake due) says due soon", () => {
    expect(itemA11yLabel(item({ kind: "dot" }))).toBe("Artifacts, due soon");
  });

  test("a dimmed item says why, and that wins over a badge (it has nothing to show)", () => {
    expect(itemA11yLabel(item(null, true))).toBe("Artifacts, nothing running");
    expect(itemA11yLabel(item({ kind: "count", n: 2 }, true))).toBe("Artifacts, nothing running");
  });

  test("otherwise the plain label", () => {
    expect(itemA11yLabel(item(null))).toBe("Artifacts");
  });
});

describe("the Tools item (docs/feat/mobile-hub-tools.md D3)", () => {
  const dimmedIds = (items: readonly HubItem[]) => items.filter((i) => i.dimmed).map((i) => i.id);

  test("it is offered only with a callback (P6: a missing one is a missing action)", () => {
    expect(ids(hubActions(IDLE_CTX, EVERY).all)).toContain("tools");
    expect(ids(hubActions(IDLE_CTX, { ...MAIN, tools: undefined }).all)).not.toContain("tools");
  });

  test("its slot is between Session info and Sessions, and the label is Tools", () => {
    const a = hubActions(IDLE_CTX, EVERY);
    const at = ids(a.all).indexOf("tools");
    expect(ids(a.all).slice(at - 1, at + 2)).toEqual(["info", "tools", "sessions"]);
    expect(a.all[at]?.label).toBe("Tools");
  });

  test("the idle fan is Attach · Activity · Artifacts · Session info · Tools · More", () => {
    // What the screen wires once Session info exists (artifacts + tools): six
    // candidates, so the SIXTH slot is More and the rest go into it.
    const a = hubActions(IDLE_CTX, { ...EVERY, sessions: noop, new: noop });
    expect(ids(a.fan)).toEqual(["attach", "activity", "artifacts", "info", "tools", "more"]);
    expect(ids(a.more)).toEqual(["sessions", "new"]);
    expect(a.fan[5]?.label).toBe("More");
  });

  test("nothing to switch dims it, and a commit says why and opens nothing", () => {
    const empty: HubContext = { ...IDLE_CTX, toolsEmpty: true };
    expect(dimmedIds(hubActions(empty, EVERY).all)).toEqual(["tools"]);
    expect(resolveCommit("tools", empty, EVERY, OPENED_IDLE)).toEqual({
      kind: "noop",
      notice: NO_TOOLS,
    });
    expect(commitPlan("tools", empty, EVERY, hubOpen(empty))).toEqual({
      kind: "notice",
      text: NO_TOOLS,
    });
  });

  test("unknown counts never dim: a count not seen yet is not zero", () => {
    // The wiring's default (`hubContextOf` with no `tools` input) says unknown.
    const unknown = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
    });
    expect(unknown.toolsEmpty).toBe(false);
    expect(unknown.toolsRim).toBeNull();
    expect(dimmedIds(hubActions(unknown, EVERY).all)).toEqual([]);

    // Known and non-empty is not dimmed either.
    const some = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      tools: { known: true, total: 2, on: 2 },
    });
    expect(some.toolsEmpty).toBe(false);
  });

  test("a known empty result IS dimmed (one source with the sheet's summary)", () => {
    const empty = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      tools: { known: true, total: 0, on: 0 },
    });
    expect(empty.toolsEmpty).toBe(true);
    expect(dimmedIds(hubActions(empty, EVERY).all)).toEqual(["tools"]);
  });

  test("its rim is the share switched OFF, and no arc while everything is on (owner Q2)", () => {
    const allOn = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      tools: { known: true, total: 4, on: 4 },
    });
    expect(allOn.toolsRim).toBeNull();
    expect(hubActions(allOn, EVERY).all.find((i) => i.id === "tools")?.rim).toBeNull();

    const someOff = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      tools: { known: true, total: 4, on: 3 },
    });
    expect(someOff.toolsRim).toBe(0.25);
    expect(hubActions(someOff, EVERY).all.find((i) => i.id === "tools")?.rim).toBe(0.25);
  });

  test("the arc is the item's OWN: it never leaks onto another item, and a dimmed item keeps none", () => {
    const ctx = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      tools: { known: true, total: 4, on: 1 },
    });
    const all = hubActions({ ...ctx, activityEmpty: true }, EVERY).all;
    expect(all.find((i) => i.id === "activity")?.rim).toBeUndefined();
    // A dimmed item draws no rim whatever its figure (`fanItemLook`).
    expect(fanItemLook(all.find((i) => i.id === "activity") as HubItem, false).rim).toBeNull();
    expect(fanItemLook(all.find((i) => i.id === "tools") as HubItem, false).rim).toBe(0.75);
  });

  test("a badge-bearing item still takes its rim from its badge (no regression)", () => {
    const a = hubActions({ ...IDLE_CTX, unseenArtifacts: 3 }, EVERY);
    const artifacts = a.all.find((i) => i.id === "artifacts");
    expect(artifacts?.rim).toBeUndefined();
    expect(fanItemLook(artifacts as HubItem, false).rim).toBe(0.3);
  });
});
