/**
 * The Live Activity RULES (docs/feat/mobile-live-activity.md Design 3, L6).
 *
 * Pure: no sockets, no fs, no timers. Time is an injected clock and every
 * time-driven decision is an explicit `tick`, so the whole cadence is a table
 * test rather than a sleep — the same inversion `push-rules.ts` uses, for the
 * same reason (AGENTS §7 "logic in pure modules").
 *
 * The rules, and the mutations each test names:
 *  - START only for a REGISTERED device that is NOT attached to that session,
 *    once the turn has run `startAfterSeconds` or an ask is raised (mutation:
 *    include attached devices → the exclusion test fails);
 *  - tool updates COALESCED to one per {@link LA_TOOL_COALESCE_MS} (mutation:
 *    drop the window → the coalescing test fails);
 *  - a HEARTBEAT every {@link LA_HEARTBEAT_MS} of silence, moving `stale-date`
 *    (mutation: never heartbeat → the stale test fails);
 *  - END on the turn's end with `done`/`failed`/`cancelled` and a dismissal
 *    (mutation: no dismissal date → the "stays a few minutes" test fails);
 *  - the 8 h ROLLOVER at 7 h 45 min: end, then a continuation with the SAME
 *    `startedAt` and a NEW slot (mutations: reuse the slot; reset startedAt);
 *  - a DISMISSED activity is never restarted for that turn (mutation: restart it);
 *  - at most {@link LA_MAX_LIVE_PER_DEVICE} live, the oldest `done` giving way.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LA_START_AFTER_SECONDS,
  LA_DONE_LINGER_MS,
  LA_HEARTBEAT_MS,
  LA_MAX_LIVE_PER_DEVICE,
  LA_ROLLOVER_MS,
  LA_STALE_MS,
  LA_TOOL_COALESCE_MS,
  type LaCommand,
  type LaEvent,
  type LiveActivityRules,
  createLiveActivityRules,
} from "../src/live-activity-rules.ts";

const SESSION = "s1";
const DEVICE = "0123456789abcdef";
const OTHER_DEVICE = "fedcba9876543210";
const T0 = 1_731_000_000_000;
const SLOT = "00112233445566778899aabb";

/** A device that may be started for: registered, and not attached. */
const registered = () => new Map([[DEVICE, { enabled: true }]]);

function rules(options: { startAfterSeconds?: number; registered?: boolean } = {}) {
  let at = T0;
  const instance = createLiveActivityRules({
    now: () => at,
    startAfterSeconds: options.startAfterSeconds ?? DEFAULT_LA_START_AFTER_SECONDS,
    newSlot: () => SLOT,
  });
  // One registered, enabled, non-attached device unless a test says otherwise:
  // the start rules are meaningless without a candidate (the §4 "empty input"
  // case is its own test below).
  if (options.registered !== false) {
    instance.setRegistrations(new Map([[DEVICE, { enabled: true }]]));
  }
  return {
    instance,
    advance: (ms: number) => {
      at += ms;
    },
    now: () => at,
  };
}

/** Feed one event and return the commands it produced. */
function feed(input: LiveActivityRules, event: LaEvent): LaCommand[] {
  return input.apply(event);
}

const turnStart = (at = T0): LaEvent => ({
  type: "turn_start",
  sessionId: SESSION,
  turnId: "t1",
  computer: "mac-mini",
  project: "tentacle",
  title: "fix the live activity",
  at,
});

describe("start: only a registered, NON-attached device, after the threshold", () => {
  test("19.9 s of a running turn starts nothing; 20 s starts one", () => {
    const { instance, advance } = rules();
    const run = (ms: number) => {
      const commands: LaCommand[] = [];
      commands.push(...feed(instance, turnStart()));
      advance(ms);
      commands.push(...feed(instance, { type: "tick" }));
      return commands.filter((c) => c.kind === "start");
    };
    expect(run(19_900)).toHaveLength(0);
    // The threshold is a floor in MS, so 20_000 exactly is the first start.
    const { instance: second, advance: adv2 } = rules();
    feed(second, turnStart());
    adv2(20_000);
    const started = feed(second, { type: "tick" });
    expect(started.filter((c) => c.kind === "start")).toHaveLength(1);
  });

  test("a device ATTACHED to that session is never started for (it is showing it)", () => {
    // The mutation this kills: ignore `attached` → the phone in the person's hand
    // lights up for the session they are already reading.
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    instance.setAttached(SESSION, new Set([DEVICE]));
    const commands = feed(instance, { type: "tick" });
    expect(commands.filter((c) => c.kind === "start")).toHaveLength(0);
    // Excluded ONLY for that session's activity: the device is not attached to
    // anything else, so another session's start would still fire (not asserted
    // here; the per-(session, device) key is what the next test pins).
  });

  test("the attached set is REMEMBERED per session, so a later tick still excludes it (R1)", () => {
    // The bug (Review round 1, finding 1): the attached set existed only as
    // `tick`'s argument, and the shell's own timer passed `new Set()` — so the
    // start that the DEADLINE produced knew nothing about who was attached. The
    // rules now remember what each session last reported.
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    // The phone is attached to this session; the set arrives as its own event.
    instance.setAttached(SESSION, new Set([DEVICE]));
    advance(20_000);
    expect(feed(instance, { type: "tick" }).filter((c) => c.kind === "start")).toHaveLength(0);
    // …and the moment it detaches, the next tick starts one.
    instance.setAttached(SESSION, new Set());
    expect(feed(instance, { type: "tick" }).filter((c) => c.kind === "start")).toHaveLength(1);
  });

  test("an ask while the device is ATTACHED to that session starts nothing (R1)", () => {
    // The mutation this kills: `permission_request` calling `startFor` with no
    // attached check at all — the phone in the person's hand lights up for a
    // sheet it is already showing (F16).
    const { instance, advance } = rules();
    feed(instance, turnStart());
    advance(1_000);
    instance.setAttached(SESSION, new Set([DEVICE]));
    const commands = feed(instance, {
      type: "permission_request",
      sessionId: SESSION,
      requestId: "req-1",
      tool: "Shell",
      preview: "rm -rf build",
      options: [{ optionId: "allow_once", kind: "allow_once" }],
    });
    expect(commands.filter((c) => c.kind === "start")).toHaveLength(0);
  });

  test("the attached set is PER SESSION: session X's devices do not silence session Y (R1)", () => {
    // The other half of finding 1: an `attachment` event from session X must not
    // apply X's attached devices to every session's turns.
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    feed(instance, {
      type: "turn_start",
      sessionId: "s2",
      turnId: "t2",
      computer: "mac-mini",
      project: "tentacle",
      title: "other session",
      at: T0,
    });
    advance(1);
    // D is attached to s1 only: s1 starts nothing, s2 still starts one.
    instance.setAttached(SESSION, new Set([DEVICE]));
    const starts = feed(instance, { type: "tick" }).filter(
      (c) => c.kind === "start" && "sessionId" in c,
    );
    expect(starts.map((c) => ("sessionId" in c ? c.sessionId : ""))).toEqual(["s2"]);
  });

  test("a device with no registration is never started for", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0, registered: false });
    feed(instance, turnStart());
    advance(1);
    expect(feed(instance, { type: "tick" }).filter((c) => c.kind === "start")).toHaveLength(0);
  });

  test("a registered device whose switch is OFF is never started for", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    // `registrations` is the rules' own input; an OFF record is not a candidate.
    instance.setRegistrations(new Map([[DEVICE, { enabled: false }]]));
    feed(instance, turnStart());
    advance(1);
    expect(feed(instance, { type: "tick" }).filter((c) => c.kind === "start")).toHaveLength(0);
  });

  test("an ask starts one IMMEDIATELY, even well before the threshold", () => {
    const { instance, advance } = rules();
    feed(instance, turnStart());
    advance(1_000);
    const commands = feed(instance, {
      type: "permission_request",
      sessionId: SESSION,
      requestId: "req-1",
      tool: "Shell",
      preview: "rm -rf build",
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "reject_once", kind: "reject_once" },
      ],
    });
    const starts = commands.filter((c) => c.kind === "start");
    expect(starts).toHaveLength(1);
    const start = starts[0];
    expect(start?.kind).toBe("start");
    if (start?.kind === "start") {
      // The activity is QUIET and shows the ask: that is `asking`, not `running`.
      expect(start.content.kind).toBe("asking");
      expect(start.content.ask?.requestId).toBe("req-1");
      // Time Sensitive stays task 16's notification: priority 10, no banner.
      expect(start.priority).toBe(10);
    }
  });

  test("one activity per (device, session): a second turn does not start a second", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    const first = feed(instance, { type: "tick" }).filter((c) => c.kind === "start");
    expect(first).toHaveLength(1);
    advance(1);
    const second = feed(instance, { type: "tick" }).filter((c) => c.kind === "start");
    expect(second).toHaveLength(0);
  });
});

describe("update: coalescing, and the states that move the view", () => {
  test("a tool call updates the view, then tool calls are coalesced to 1 / 15 s", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    feed(instance, { type: "tick" }); // the start
    const tool = (tool: string, ms: number): LaCommand[] => {
      advance(ms);
      return feed(instance, { type: "tool_call", sessionId: SESSION, turnId: "t1", tool }).filter(
        (c) => c.kind === "update",
      );
    };
    // The START is itself a push and already carries the current tool, so a tool
    // call 100 ms later is inside the window and is correctly suppressed: the
    // rule is "≤ 1 push / 15 s", and the phone is not missing anything.
    expect(tool("bun test", 100)).toHaveLength(0);
    // Past the window, the next one goes out.
    expect(tool("bun test", LA_TOOL_COALESCE_MS)).toHaveLength(1);
    // Then 14.9 s later it is still inside the window: nothing.
    expect(tool("bun test --watch", LA_TOOL_COALESCE_MS - 200)).toHaveLength(0);
    // Past the window, the LATEST state goes out (not a queue of stale ones).
    const late = tool("git status", 300);
    expect(late).toHaveLength(1);
    const update = late[0];
    if (update?.kind === "update") {
      expect(update.content.tool).toBe("git status");
      expect(update.priority).toBe(5);
    }
  });

  test("an ask is immediate, and its resolution returns the view to `running`", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    feed(instance, { type: "tick" });
    const asking = feed(instance, {
      type: "permission_request",
      sessionId: SESSION,
      requestId: "req-1",
      tool: "Shell",
      preview: "ls",
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "reject_once", kind: "reject_once" },
      ],
    }).filter((c) => c.kind === "update");
    // Immediate: no coalescing window applies to an approval waiting.
    expect(asking).toHaveLength(1);
    expect(asking[0]?.kind === "update" && asking[0].priority).toBe(10);

    const resolved = feed(instance, {
      type: "permission_resolved",
      sessionId: SESSION,
      requestId: "req-1",
    }).filter((c) => c.kind === "update");
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.kind === "update") {
      expect(resolved[0].content.kind).toBe("running");
      expect(resolved[0].content.ask).toBeUndefined();
      expect(resolved[0].priority).toBe(10);
    }
  });

  test("the title is coalesced, not immediate (it changes rarely and is not actionable)", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    feed(instance, { type: "tick" });
    // The START is a push and already carries the title, so a title change
    // 1 ms later is inside the window (the same rule as a tool call).
    advance(1);
    expect(
      feed(instance, { type: "session_title", sessionId: SESSION, title: "new name" }).filter(
        (c) => c.kind === "update",
      ),
    ).toHaveLength(0);
    // Past the window it goes out, and a second one inside that window does not.
    advance(LA_TOOL_COALESCE_MS);
    const first = feed(instance, {
      type: "session_title",
      sessionId: SESSION,
      title: "newer name",
    }).filter((c) => c.kind === "update");
    expect(first).toHaveLength(1);
    advance(100);
    expect(
      feed(instance, { type: "session_title", sessionId: SESSION, title: "newest name" }).filter(
        (c) => c.kind === "update",
      ),
    ).toHaveLength(0);
  });

  test("a heartbeat after 10 min of silence moves `stale-date`, at priority 5", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    feed(instance, { type: "tick" });
    // Nothing happens for 9m59s.
    advance(LA_HEARTBEAT_MS - 1);
    expect(feed(instance, { type: "tick" }).filter((c) => c.kind === "update")).toHaveLength(0);
    advance(1);
    const beat = feed(instance, { type: "tick" }).filter((c) => c.kind === "update");
    expect(beat).toHaveLength(1);
    const command = beat[0];
    if (command?.kind === "update") {
      expect(command.priority).toBe(5);
      // The stale date is `now + LA_STALE_MS`, so the view says "may be out of
      // date" if the daemon goes quiet (F2).
      // `staleAt` is in SECONDS (Apple's `aps.stale-date`).
      expect(command.staleAt).toBe(Math.floor((T0 + 1 + LA_HEARTBEAT_MS + LA_STALE_MS) / 1_000));
    }
  });
});

describe("end: done / failed / cancelled, and the dismissal", () => {
  const endOf = (stopReason: string, error?: string): LaEvent => ({
    type: "turn_end",
    sessionId: SESSION,
    turnId: "t1",
    stopReason,
    ...(error === undefined ? {} : { error }),
  });

  for (const [stopReason, kind] of [
    ["end_turn", "done"],
    ["max_tokens", "done"],
    ["cancelled", "cancelled"],
  ] as const) {
    test(`${stopReason} ends the activity as \`${kind}\` with a ${LA_DONE_LINGER_MS / 60_000}-minute dismissal`, () => {
      const { instance, advance } = rules({ startAfterSeconds: 0 });
      feed(instance, turnStart());
      advance(1);
      feed(instance, { type: "tick" });
      advance(5_000);
      const ends = feed(instance, endOf(stopReason)).filter((c) => c.kind === "end");
      expect(ends).toHaveLength(1);
      const end = ends[0];
      if (end?.kind === "end") {
        expect(end.content.kind).toBe(kind);
        // "done for a few minutes" (decision 11).
        expect(end.dismissAt).toBe(Math.floor((T0 + 1 + 5_000 + LA_DONE_LINGER_MS) / 1_000));
        expect(end.priority).toBe(10);
      }
    });
  }

  test("a failed turn says so, and carries the error line", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    feed(instance, { type: "tick" });
    const ends = feed(instance, endOf("error", "the model returned 500")).filter(
      (c) => c.kind === "end",
    );
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end?.kind === "end") {
      expect(end.content.kind).toBe("failed");
      expect(end.content.error).toContain("500");
    }
  });

  test("session_closed ends it at once, part-way through a turn", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    feed(instance, { type: "tick" });
    const ends = feed(instance, { type: "session_closed", sessionId: SESSION }).filter(
      (c) => c.kind === "end",
    );
    expect(ends).toHaveLength(1);
  });

  test("an activity that was never started ends nothing (no phantom pushes)", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    expect(feed(instance, endOf("end_turn")).filter((c) => c.kind === "end")).toHaveLength(0);
  });

  test("ENDING twice sends one end (a turn_end and a close converge on one view)", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    feed(instance, { type: "tick" });
    expect(feed(instance, endOf("end_turn")).filter((c) => c.kind === "end")).toHaveLength(1);
    expect(
      feed(instance, { type: "session_closed", sessionId: SESSION }).filter(
        (c) => c.kind === "end",
      ),
    ).toHaveLength(0);
  });
});

describe("the 8 h cap (Owner Q5): rollover at 7 h 45 min", () => {
  test("it ends and CONTINUES with the same startedAt and a NEW slot", () => {
    // The slot source CHANGES on every call, so "a new slot" is observable at all
    // (mutation: reuse the old slot → this fails). With a constant fixture the
    // property would be untestable, which is exactly the trap M22 exposed.
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    let issued = 0;
    instance.setSlotSource(() => {
      issued += 1;
      return `${"ab".repeat(12)}`.slice(0, 22) + issued.toString(16).padStart(2, "0");
    });
    feed(instance, turnStart());
    advance(1);
    const start = feed(instance, { type: "tick" }).filter((c) => c.kind === "start");
    expect(start).toHaveLength(1);
    const originalSlot = start[0]?.kind === "start" ? start[0].slot : "";
    expect(originalSlot).not.toBe("");
    expect(issued).toBe(1);

    // Just before the rollover: no end and no start (heartbeats are expected —
    // 7h45m of silence produces plenty, and that is the feature working).
    advance(LA_ROLLOVER_MS - 2);
    const beforeRollover = feed(instance, { type: "tick" });
    expect(beforeRollover.filter((c) => c.kind === "end" || c.kind === "start")).toHaveLength(0);

    // At the rollover: an end, then a start with a DIFFERENT slot.
    advance(2);
    const commands = feed(instance, { type: "tick" });
    const ends = commands.filter((c) => c.kind === "end");
    const starts = commands.filter((c) => c.kind === "start");
    expect(ends).toHaveLength(1);
    expect(starts).toHaveLength(1);
    const continuation = starts[0];
    if (continuation?.kind === "start") {
      // Same turn, same ORIGINAL start (the elapsed timer must not jump), new slot.
      expect(continuation.content.turnId).toBe("t1");
      expect(continuation.content.startedAt).toBe(T0);
      expect(continuation.slot).not.toBe(originalSlot);
      expect(issued).toBe(2);
      // A continuation is immediate (priority 10) and starts `running`.
      expect(continuation.content.kind).toBe("running");
      expect(continuation.priority).toBe(10);
    }
    // The old activity is dismissed at once: exactly one live activity remains.
    const end = ends[0];
    if (end?.kind === "end") {
      expect(end.dismissAt).toBe(Math.floor((T0 + LA_ROLLOVER_MS + 1) / 1_000));
      expect(end.slot).toBe(originalSlot);
    }
    expect(instance.liveSlots()).toHaveLength(1);
  });

  test("a turn that ends BEFORE the rollover never rolls over", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    feed(instance, { type: "tick" });
    advance(LA_ROLLOVER_MS - 10);
    feed(instance, { type: "turn_end", sessionId: SESSION, turnId: "t1", stopReason: "end_turn" });
    advance(20);
    expect(feed(instance, { type: "tick" })).toHaveLength(0);
  });
});

describe("dismissed: never restarted for that turn", () => {
  test("a dismiss withdraws the activity, and the tick does not bring it back", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    const starts = feed(instance, { type: "tick" }).filter((c) => c.kind === "start");
    const slot = starts[0]?.kind === "start" ? starts[0].slot : "";
    feed(instance, { type: "ended", sessionId: SESSION, slot, reason: "dismissed" });
    advance(60_000);
    // Mutation: forget the dismissal → this starts a second activity the person
    // just swiped away.
    expect(feed(instance, { type: "tick" })).toHaveLength(0);
    // The NEXT turn may start one: the dismissal is per turn, not per session.
    feed(instance, {
      type: "turn_start",
      sessionId: SESSION,
      turnId: "t2",
      computer: "mac-mini",
      project: "tentacle",
      title: "t",
      at: T0 + 61_000,
    });
    advance(1);
    expect(feed(instance, { type: "tick" }).filter((c) => c.kind === "start")).toHaveLength(1);
  });

  test("a system end (`ended` / `stale`) does not block the next start either", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    feed(instance, turnStart());
    advance(1);
    const starts = feed(instance, { type: "tick" }).filter((c) => c.kind === "start");
    const slot = starts[0]?.kind === "start" ? starts[0].slot : "";
    feed(instance, { type: "ended", sessionId: SESSION, slot, reason: "stale" });
    advance(1);
    // `stale` is not a dismissal: the rules may start a fresh one for the SAME
    // turn (F18's "one continuation start" after iOS ended it first).
    const again = feed(instance, { type: "tick" }).filter((c) => c.kind === "start");
    expect(again).toHaveLength(1);
  });
});

describe(`the per-device cap (${LA_MAX_LIVE_PER_DEVICE} live, Owner Q3)`, () => {
  test("a 4th start ends the oldest `done` one instead of skipping", () => {
    // Three other sessions, all finished (done), then a fourth turn starts.
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    for (const [index, sessionId] of ["sa", "sb", "sc"].entries()) {
      feed(instance, {
        type: "turn_start",
        sessionId,
        turnId: `t-${sessionId}`,
        computer: "mac-mini",
        project: "tentacle",
        title: "x",
        at: T0 + index,
      });
      advance(1);
      feed(instance, { type: "tick" });
      advance(5_000);
      feed(instance, {
        type: "turn_end",
        sessionId,
        turnId: `t-${sessionId}`,
        stopReason: "end_turn",
      });
    }
    feed(instance, turnStart());
    advance(1);
    const commands = feed(instance, { type: "tick" });
    const starts = commands.filter((c) => c.kind === "start");
    const ends = commands.filter((c) => c.kind === "end");
    // The new one starts AND the oldest done one is ended to make room.
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end?.kind === "end") {
      // The oldest is `sa`; dismissed at once (it is giving way, not "done").
      expect(end.content.turnId).toBe("t-sa");
    }
  });

  test("with no `done` activity to evict, the start is SKIPPED and audited (never silent)", () => {
    const { instance, advance } = rules({ startAfterSeconds: 0 });
    for (const sessionId of ["sa", "sb", "sc"]) {
      feed(instance, {
        type: "turn_start",
        sessionId,
        turnId: `t-${sessionId}`,
        computer: "mac-mini",
        project: "tentacle",
        title: "x",
        at: T0,
      });
      advance(1);
      feed(instance, { type: "tick" });
    }
    feed(instance, turnStart());
    advance(1);
    const commands = feed(instance, { type: "tick" });
    expect(commands.filter((c) => c.kind === "start")).toHaveLength(0);
    // The note is how it is never silent (F20).
    expect(commands.filter((c) => c.kind === "note")).toHaveLength(1);
    const note = commands.find((c) => c.kind === "note");
    if (note?.kind === "note") {
      expect(note.code).toBe("la-capped");
    }
  });
});

describe("nextDeadlineAt: the one timer the shell owns", () => {
  test("it names the earliest pending deadline, or undefined when none", () => {
    const { instance, advance } = rules();
    expect(instance.nextDeadlineAt()).toBeUndefined();
    feed(instance, turnStart());
    // The threshold is the first deadline.
    expect(instance.nextDeadlineAt()).toBe(T0 + DEFAULT_LA_START_AFTER_SECONDS * 1_000);
    advance(DEFAULT_LA_START_AFTER_SECONDS * 1_000 + 1);
    feed(instance, { type: "tick" });
    // Then the heartbeat, 10 min after the start.
    expect(instance.nextDeadlineAt()).toBe(
      T0 + DEFAULT_LA_START_AFTER_SECONDS * 1_000 + 1 + LA_HEARTBEAT_MS,
    );
  });
});
