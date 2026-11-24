/**
 * `hub-actions.ts` — what the hub offers (docs/feat/mobile-hub.md Design 5–6,
 * P6, M7/M8/M9/M14): the order, the turn pair, absent-never-dead entries, badge
 * promotion, the six-slot rule, the commit re-validation, the button's badge.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
import { NOTHING_SEEN } from "../src/artifact-seen-store.ts";
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
  NO_ARTIFACTS,
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
import { commitPlan, hubA11yRoute, hubContextOf } from "../src/hub-session.ts";
import { type SwitchFacts, toolsSummary } from "../src/tools-view.ts";
import { WORKFLOWS_UPDATE_TENTACLE } from "../src/workflow-runs-controller.ts";

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
  commands: noop,
};

const art = (artifactId: string, version = 1): ArtifactMeta => ({
  artifactId,
  version,
  sha256: `${artifactId}${version}`.padEnd(64, "a"),
  size: 1_000,
  mimeType: "image/png",
  kind: "image",
  title: artifactId,
  callId: `c-${artifactId}-${version}`,
  createdAt: 0,
});
const ARTIFACT = art("a1");

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
  artifactsEmpty: false,
  toolsEmpty: false,
  toolsRim: null,
};
/**
 * The facts right after attach, before either pull answers: both still
 * `loading`, so `toolsSummary` says `{known:false,total:0}` (D4's starting
 * point). Typed, so a pull that stops being `loading` breaks the build too.
 */
const LOADING_TOOLS = {
  link: "up",
  computerName: "MacBook Pro",
  mcp: { state: "loading" },
  skills: { state: "loading" },
  capabilities: undefined,
} as const satisfies SwitchFacts;

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

describe("Stop while the phone compacts (mobile-hub-commands C2 item 14)", () => {
  const COMPACTING: HubContext = { ...IDLE_CTX, compacting: true };
  test("Stop is offered with no turn while my compaction runs; Steer is not", () => {
    const a = hubActions(COMPACTING, EVERY);
    expect(ids(a.all).slice(0, 2)).toEqual(["stop", "attach"]);
    expect(ids(a.all)).not.toContain("steer");
    expect(resolveCommit("stop", COMPACTING, EVERY, hubOpen(COMPACTING))).toEqual({
      kind: "run",
      id: "stop",
    });
  });
  test("a dead link offers no Stop (the cancel would be lost)", () => {
    expect(ids(hubActions({ ...COMPACTING, link: "down" }, EVERY).all)).not.toContain("stop");
  });
  test("an idle session without a compaction offers no Stop", () => {
    expect(ids(hubActions(IDLE_CTX, EVERY).all)).not.toContain("stop");
  });
  test("hubContextOf carries the screen's compacting fact", () => {
    const ctx = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      compacting: true,
    });
    expect(ctx.compacting).toBe(true);
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
      "tools",
      "commands",
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
      "tools",
      "commands",
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

  test("eleven candidates: the first five + More, and the six others in More in canonical order", () => {
    const a = hubActions({ ...RUNNING, schedules: 1 }, EVERY);
    expect(a.all.length).toBe(11);
    expect(ids(a.fan)).toEqual(["stop", "steer", "attach", "activity", "artifacts", "more"]);
    expect(ids(a.more)).toEqual(["tools", "commands", "sessions", "info", "scheduled", "new"]);
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
    emptyLabel: dimmed ? NOTHING_RUNNING : null,
  });

  test("a count says how many are new (the bubble's number, now in words)", () => {
    expect(itemA11yLabel(item({ kind: "count", n: 3 }))).toBe("Artifacts, 3 new");
    expect(itemA11yLabel(item({ kind: "count", n: 1 }))).toBe("Artifacts, 1 new");
  });

  test("a dot (a wake due) says due soon", () => {
    expect(itemA11yLabel(item({ kind: "dot" }))).toBe("Artifacts, due soon");
  });

  test("a dimmed item says why, and that wins over a badge (it has nothing to show)", () => {
    expect(itemA11yLabel(item(null, true))).toBe("Artifacts, Nothing running");
    expect(itemA11yLabel(item({ kind: "count", n: 2 }, true))).toBe("Artifacts, Nothing running");
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
    expect(ids(a.all).slice(at - 1, at + 2)).toEqual(["artifacts", "tools", "commands"]);
    expect(a.all[at]?.label).toBe("Tools");
  });

  test("the idle fan is Attach · Activity · Artifacts · Tools · Commands · More (owner Q1 O1)", () => {
    // Six candidates, so the SIXTH slot is More and Session info goes into it.
    const a = hubActions(IDLE_CTX, EVERY);
    expect(ids(a.fan)).toEqual(["attach", "activity", "artifacts", "tools", "commands", "more"]);
    expect(ids(a.more)).toEqual(["sessions", "info", "new"]);
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

    // The attach state itself: both pulls still `loading`, so the summary is
    // `{known:false,total:0}`. Without the `known` guard that reads as empty
    // and dims Tools from attach until a dimmed tap's own pull lands (D4).
    expect(toolsSummary(LOADING_TOOLS).known).toBe(false);
    expect(toolsSummary(LOADING_TOOLS).total).toBe(0);
    const loading = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      tools: toolsSummary(LOADING_TOOLS),
    });
    expect(loading.toolsEmpty).toBe(false);
    expect(loading.toolsRim).toBeNull();
    expect(dimmedIds(hubActions(loading, EVERY).all)).toEqual([]);

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

describe("the Commands item (docs/feat/mobile-hub-commands.md C1, owner Q1 O1)", () => {
  test("the idle fan is exactly O1: Attach · Activity · Artifacts · Tools · Commands · More", () => {
    const a = hubActions(IDLE_CTX, EVERY);
    expect(ids(a.fan)).toEqual(["attach", "activity", "artifacts", "tools", "commands", "more"]);
    expect(a.all.find((i) => i.id === "commands")?.label).toBe("Commands");
  });

  test("More starts Sessions · Session info, and no Commands (it is in the fan)", () => {
    const a = hubActions(IDLE_CTX, EVERY);
    expect(ids(a.more).slice(0, 2)).toEqual(["sessions", "info"]);
    expect(ids(a.more)).not.toContain("commands");
  });

  test("during a turn Stop · Steer push Tools and Commands into More (README Q1)", () => {
    const a = hubActions(RUNNING, EVERY);
    expect(ids(a.fan)).toEqual(["stop", "steer", "attach", "activity", "artifacts", "more"]);
    expect(ids(a.more)).toEqual(["tools", "commands", "sessions", "info", "new"]);
  });

  test("an ended session has no Commands: nothing to run, Rename stays on the title", () => {
    const a = hubActions({ ...IDLE_CTX, ended: "closed" }, EVERY);
    expect(ids(a.all)).not.toContain("commands");
    expect(ids(hubActions(IDLE_CTX, EVERY).all)).toContain("commands");
  });

  test("a missing callback is a missing item, as every other entry (P6)", () => {
    expect(ids(hubActions(IDLE_CTX, MAIN).all)).not.toContain("commands");
    expect(resolveCommit("commands", IDLE_CTX, MAIN, hubOpen(IDLE_CTX))).toEqual({
      kind: "noop",
      notice: null,
    });
  });

  test("a live Commands commits to the screen's sheet", () => {
    expect(resolveCommit("commands", IDLE_CTX, EVERY, hubOpen(IDLE_CTX))).toEqual({
      kind: "run",
      id: "commands",
    });
  });
});

describe("an empty Artifacts is dimmed too (owner Q3 A)", () => {
  const dimmedIds = (items: readonly HubItem[]) => items.filter((i) => i.dimmed).map((i) => i.id);

  test("a KNOWN empty list dims it, with the mockup's words", () => {
    const empty: HubContext = { ...IDLE_CTX, artifactsEmpty: true };
    expect(dimmedIds(hubActions(empty, EVERY).all)).toEqual(["artifacts"]);
    expect(NO_ARTIFACTS).toBe("No artifacts yet");
    expect(hubActions(empty, EVERY).all.find((i) => i.id === "artifacts")?.emptyLabel).toBe(
      NO_ARTIFACTS,
    );
    expect(resolveCommit("artifacts", empty, EVERY, hubOpen(empty))).toEqual({
      kind: "noop",
      notice: NO_ARTIFACTS,
    });
  });

  test("UNKNOWN is never empty: a list not seen yet must not dim (the Tools D3 rule)", () => {
    const unknown = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
    });
    expect(unknown.artifactsEmpty).toBe(false);
    expect(dimmedIds(hubActions(unknown, EVERY).all)).toEqual([]);
    // ...and an empty list the gallery knows about does.
    const known = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      artifacts: { list: [], seen: NOTHING_SEEN },
    });
    expect(known.artifactsEmpty).toBe(true);
    expect(dimmedIds(hubActions(known, EVERY).all)).toEqual(["artifacts"]);
  });

  test("a non-empty list is not dimmed, and a dimmed Artifacts keeps its slot", () => {
    const some = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      artifacts: { list: [ARTIFACT], seen: NOTHING_SEEN },
    });
    expect(some.artifactsEmpty).toBe(false);
    const a = hubActions({ ...IDLE_CTX, artifactsEmpty: true }, EVERY);
    expect(ids(a.all)).toEqual(ids(hubActions(IDLE_CTX, EVERY).all));
  });
});

describe("emptyLabel: a dimmed item carries WHY it is dimmed (owner Q3 A)", () => {
  test("dimmed ⇔ emptyLabel is not null, and it is the notice's own words", () => {
    const empty: HubContext = { ...IDLE_CTX, activityEmpty: true, toolsEmpty: true };
    const empty2: HubContext = { ...empty, artifactsEmpty: true };
    const byId = (ctx: HubContext) =>
      Object.fromEntries(hubActions(ctx, EVERY).all.map((i) => [i.id, i.emptyLabel]));
    expect(byId(IDLE_CTX).activity).toBeNull();
    expect(byId(empty2)).toMatchObject({
      activity: NOTHING_RUNNING,
      artifacts: NO_ARTIFACTS,
      tools: NO_TOOLS,
    });
    for (const item of hubActions(empty2, EVERY).all) {
      expect(item.dimmed).toBe(item.emptyLabel !== null);
    }
  });

  test("the VoiceOver label speaks the empty reason, per item — Tools never says 'nothing running'", () => {
    const empty: HubContext = {
      ...IDLE_CTX,
      activityEmpty: true,
      toolsEmpty: true,
      artifactsEmpty: true,
    };
    const at = (id: string) =>
      itemA11yLabel(hubActions(empty, EVERY).all.find((i) => i.id === id) as HubItem);
    expect(at("activity")).toBe("Activity, Nothing running");
    expect(at("artifacts")).toBe("Artifacts, No artifacts yet");
    // Today's bug: the generic "nothing running" was spoken for Tools too.
    expect(at("tools")).toBe(`Tools, ${NO_TOOLS}`);
    expect(at("tools")).not.toContain("nothing running");
  });
});

describe("the Workflows item (docs/feat/workflows-ui.md D4)", () => {
  const WF: HubEntries = { ...MAIN, workflows: noop };
  const wf = (ctx: HubContext) => hubActions(ctx, WF).all.find((i) => i.id === "workflows");

  test("offered only with its callback (P6), labelled Workflows, unbadged when nothing waits", () => {
    expect(wf(IDLE_CTX)).toMatchObject({ label: "Workflows", badge: null, dimmed: false });
    expect(hubActions(IDLE_CTX, MAIN).all.some((i) => i.id === "workflows")).toBe(false);
  });

  test("the runs that need the person are a COUNT badge (the rim arc), and it is promoted", () => {
    const ctx = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      workflows: { needYou: 2, empty: null },
    });
    expect(wf(ctx)?.badge).toEqual({ kind: "count", n: 2 });
    // Promotion: the badged item moves into the fan ahead of the unbadged ones.
    expect(ids(hubActions(ctx, WF).fan)[0]).toBe("workflows");
    expect(itemA11yLabel(wf(ctx) as HubItem)).toBe("Workflows, 2 new");
  });

  test("an older daemon dims it with its reason; the commit says it, nothing opens", () => {
    // Only an older daemon dims Workflows (docs/feat/workflow-editor.md D8 + E1):
    // an EMPTY list must still open, because the runs screen's empty state is
    // where the first workflow is created (see workflow-runs-controller.test.ts).
    const ctx = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      workflows: { needYou: 0, empty: WORKFLOWS_UPDATE_TENTACLE },
    });
    expect(wf(ctx)).toMatchObject({ dimmed: true, emptyLabel: WORKFLOWS_UPDATE_TENTACLE });
    expect(resolveCommit("workflows", ctx, WF, hubOpen(ctx))).toEqual({
      kind: "noop",
      notice: WORKFLOWS_UPDATE_TENTACLE,
    });
  });

  test("an EMPTY list does NOT dim it: that screen is where the first workflow is made", () => {
    const ctx = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      workflows: { needYou: 0, empty: null },
    });
    expect(wf(ctx)).toMatchObject({ dimmed: false, emptyLabel: null });
    expect(resolveCommit("workflows", ctx, WF, hubOpen(ctx))).toEqual({
      kind: "run",
      id: "workflows",
    });
  });

  test("UNKNOWN (the list not read yet) is never dimmed — its tap is what reads it", () => {
    const ctx = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
    });
    expect(wf(ctx)).toMatchObject({ dimmed: false, badge: null });
  });

  test("VoiceOver reaches it by its action name", () => {
    expect(hubA11yRoute("hub-workflows")).toEqual({ kind: "commit", id: "workflows" });
  });
});
