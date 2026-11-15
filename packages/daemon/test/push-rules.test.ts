/**
 * The push rules (docs/feat/mobile-push.md Design 1, P6).
 *
 * Table-driven, with an injected clock and an explicit `tick`, so every rule is
 * a boundary a test names: 29.9 s vs 30 s, the 10 s ask window, the 60/min cap.
 * Each block names the mutation that would fake it.
 *
 * The properties:
 * - the GRACE (answered at 29.9 s → silence; unanswered at 30 s → one push);
 * - EXCLUSION (a device attached to that session is not pushed to: it is showing
 *   the sheet) — mutation: include attached → fails;
 * - REPLACEMENT (after a push, a settle sends `ask_resolved` under the SAME
 *   collapse id, to exactly the devices that got the ask — mutation: a fresh id
 *   → the stale actionable banner stays on the lock screen);
 * - the RE-OFFER (the same `requestId` never restarts the timer);
 * - the TURN rule (`turn_done` / `turn_failed` only with nobody attached,
 *   `cancelled` never — mutation: ignore `attached.clients` → a desk TUI buzzes);
 * - CAPS (folding into "+N more", a bounded rate, an uncappable `ask_resolved`);
 * - the SESSION's own state (its timers die with it).
 */
import { describe, expect, test } from "bun:test";
import type { PushAttached, PushCommand, PushEvent, PushRules } from "../src/push-rules.ts";
import { PUSH_MAX_PER_MINUTE, PUSH_TTL_SECONDS, createPushRules } from "../src/push-rules.ts";

/** A clock a test moves by hand. */
interface Clock {
  at: number;
  advance(ms: number): void;
  now(): number;
}

const clockAt = (start = 1_700_000_000_000): Clock => {
  const clock: Clock = {
    at: start,
    advance(ms) {
      clock.at += ms;
    },
    now: () => clock.at,
  };
  return clock;
};

const ALICE = "a".repeat(16);
const BOB = "b".repeat(16);
const CAROL = "c".repeat(16);

interface Harness {
  readonly rules: PushRules;
  readonly clock: Clock;
  /** Every command from every `apply`, in order. */
  readonly commands: PushCommand[];
  /** `devices` the rules may push to (registered AND authorised). */
  setRegistered(ids: readonly string[]): void;
  send(event: PushEvent): PushCommand[];
  /** `apply({type:"tick"})` — the caller's timer, driven by hand. */
  tick(): PushCommand[];
}

const harness = (
  registered: readonly string[] = [ALICE, BOB],
  options: { graceMs?: number; askWindowMs?: number; maxPerMinute?: number } = {},
): Harness => {
  let available = [...registered];
  const clock = clockAt();
  const commands: PushCommand[] = [];
  const rules = createPushRules({
    now: clock.now,
    registered: () => available,
    ...options,
  });
  const record = (result: { commands: readonly PushCommand[] }): PushCommand[] => {
    commands.push(...result.commands);
    return [...result.commands];
  };
  return {
    rules,
    clock,
    commands,
    setRegistered(ids) {
      available = [...ids];
    },
    send(event) {
      return record(rules.apply(event));
    },
    tick() {
      return record(rules.apply({ type: "tick" }));
    },
  };
};

const NOBODY: PushAttached = { clients: 0, devices: [] };
const ask = (sessionId: string, requestId: string, attached = NOBODY): PushEvent => ({
  type: "ask",
  sessionId,
  requestId,
  attached,
});

describe("the grace", () => {
  test("answered at 29.9 s → NOTHING is ever pushed (the desk case)", () => {
    const h = harness();
    expect(h.send(ask("s1", "r1"))).toEqual([]);
    h.clock.advance(29_900);
    expect(h.tick()).toEqual([]);
    expect(
      h.send({ type: "ask_settled", sessionId: "s1", requestId: "r1", attached: NOBODY }),
    ).toEqual([]);
    h.clock.advance(60_000);
    expect(h.tick()).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  test("unanswered at 30 s → one `ask` push, at the deadline not at the ask", () => {
    const h = harness();
    const startedAt = h.clock.now();
    h.send(ask("s1", "r1"));
    h.clock.advance(29_999);
    expect(h.tick()).toEqual([]);
    h.clock.advance(1);
    const pushed = h.tick();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.kind).toBe("ask");
    expect(pushed[0]?.requestId).toBe("r1");
    expect(pushed[0]?.at).toBe(startedAt + 30_000);
    // The tick is idempotent: the same due ask is not pushed twice.
    expect(h.tick()).toEqual([]);
  });

  test("the deadline is offered to the shell, so it needs only one timer", () => {
    const h = harness();
    expect(h.rules.nextDeadlineAt()).toBeUndefined();
    const at = h.clock.now();
    h.send(ask("s1", "r1"));
    expect(h.rules.nextDeadlineAt()).toBe(at + 30_000);
    h.clock.advance(30_000);
    h.tick();
    // Pushed: nothing more is due for it.
    expect(h.rules.nextDeadlineAt()).toBeUndefined();
  });

  test("grace `0` pushes at once, through the same path", () => {
    const h = harness([ALICE, BOB], { graceMs: 0 });
    const pushed = h.send(ask("s1", "r1"));
    expect(pushed.map((c) => c.kind)).toEqual(["ask"]);
    expect(pushed[0]?.devices).toEqual([ALICE, BOB]);
  });

  test("`graceMs` overrides the default (a config value, not a constant)", () => {
    const h = harness([ALICE], { graceMs: 5_000 });
    h.send(ask("s1", "r1"));
    h.clock.advance(4_999);
    expect(h.tick()).toEqual([]);
    h.clock.advance(1);
    expect(h.tick().map((c) => c.kind)).toEqual(["ask"]);
  });
});

describe("who is pushed to", () => {
  test("an attached device is EXCLUDED; the others are (mutation: include attached)", () => {
    const h = harness([ALICE, BOB, CAROL]);
    h.send(ask("s1", "r1", { clients: 1, devices: [ALICE] }));
    h.clock.advance(30_000);
    const pushed = h.tick();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.devices).toEqual([BOB, CAROL]);
  });

  test("a device not registered (or revoked) is never pushed to", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1"));
    h.clock.advance(30_000);
    expect(h.tick()[0]?.devices).toEqual([ALICE]);
    // Revoked between the ask and its deadline: the authority snapshot is re-read.
    h.setRegistered([]);
    const second = harness([ALICE]);
    second.send(ask("s1", "r2"));
    second.setRegistered([]);
    second.clock.advance(30_000);
    expect(second.tick()).toEqual([]);
  });

  test("every device attached → no push, and the asks are not retried forever", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1", { clients: 1, devices: [ALICE] }));
    h.clock.advance(30_000);
    expect(h.tick()).toEqual([]);
    expect(h.rules.nextDeadlineAt()).toBeUndefined();
    // A settle afterwards is silent (nothing was pushed, so nothing to replace).
    expect(
      h.send({ type: "ask_settled", sessionId: "s1", requestId: "r1", attached: NOBODY }),
    ).toEqual([]);
  });

  test("the device set is the attachment's, read at the DEADLINE, not at the ask", () => {
    const h = harness([ALICE, BOB]);
    h.send(ask("s1", "r1"));
    // The phone attaches while the grace runs: it is now showing the sheet.
    h.send(ask("s1", "r1", { clients: 1, devices: [ALICE] }));
    h.clock.advance(30_000);
    expect(h.tick()[0]?.devices).toEqual([BOB]);
  });

  // Review P5+P6 finding 1 (HIGH), F17: the phone is attached when the ask
  // arrives and the user locks it without answering. The foreground gate closes
  // the socket, so the device detaches — and a detach is not an `ask`, so the
  // rules only learn about it from its own event. Mutation: drop the
  // `attachment` arm (state.attached only moves on `ask`/`ask_settled`) → the
  // phone stays "attached" at the deadline, the grace ends `push-empty`, the ask
  // is marked decided and no push ever comes.
  test("a device DETACHED during the grace is pushed to (F17: locking the phone)", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1", { clients: 1, devices: [ALICE] }));
    h.clock.advance(5_000);
    // The phone locks: the socket closes, the device is no longer attached.
    // It says ONE thing — the attachment changed — and pushes nothing: anything
    // else here (a `turn_done`, say) would be a buzz about an event that did not
    // happen. Mutation: drop the `attachment` arm so the event falls through to
    // the turn path → this arrays a `turn_done`.
    expect(h.send({ type: "attachment", sessionId: "s1", attached: NOBODY })).toEqual([]);
    h.clock.advance(25_000);
    const pushed = h.tick();
    expect(pushed.map((c) => c.kind)).toEqual(["ask"]);
    expect(pushed[0]?.devices).toEqual([ALICE]);
  });

  test("a device ATTACHED during the grace is not pushed to (the inverse)", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1"));
    h.clock.advance(5_000);
    expect(
      h.send({ type: "attachment", sessionId: "s1", attached: { clients: 1, devices: [ALICE] } }),
    ).toEqual([]);
    h.clock.advance(25_000);
    const result = h.rules.apply({ type: "tick" });
    expect(result.commands).toEqual([]);
    expect(result.notes.map((n) => n.code)).toEqual(["push-empty"]);
  });

  test("an `attachment` for a session the rules do not track is dropped", () => {
    const h = harness([ALICE]);
    expect(
      h.send({
        type: "attachment",
        sessionId: "nobody",
        attached: { clients: 1, devices: [ALICE] },
      }),
    ).toEqual([]);
    expect(h.rules.nextDeadlineAt()).toBeUndefined();
    expect(h.rules.trackedAsks("nobody")).toBe(0);
  });
});

describe("replacement (ask_resolved)", () => {
  test("resolved after a push → `ask_resolved`, SAME collapse id, to the pushed devices only", () => {
    const h = harness([ALICE, BOB, CAROL]);
    // Carol is showing the sheet, so the ask never reached her.
    h.send(ask("s1", "r1", { clients: 1, devices: [CAROL] }));
    h.clock.advance(30_000);
    const pushed = h.tick()[0];
    if (pushed === undefined) throw new Error("expected an ask push");
    expect(pushed.devices).toEqual([ALICE, BOB]);
    const resolved = h.send({
      type: "ask_settled",
      sessionId: "s1",
      requestId: "r1",
      attached: { clients: 1, devices: [CAROL] },
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.kind).toBe("ask_resolved");
    expect(resolved[0]?.collapseId).toBe(pushed.collapseId);
    expect(resolved[0]?.devices).toEqual([ALICE, BOB]);
    expect(resolved[0]?.requestId).toBe("r1");
  });

  test("an `ask_resolved` is NEVER capped (a stale banner must always be replaceable)", () => {
    const h = harness([ALICE], { graceMs: 0, maxPerMinute: 1 });
    expect(h.send(ask("s1", "r1")).map((c) => c.kind)).toEqual(["ask"]);
    // The cap is full now; the replacement still goes.
    expect(
      h
        .send({ type: "ask_settled", sessionId: "s1", requestId: "r1", attached: NOBODY })
        .map((c) => c.kind),
    ).toEqual(["ask_resolved"]);
  });

  test("F19 both ways: settle first → no push at all; settle after → a replacement", () => {
    // (a) settle wins the race.
    const first = harness([ALICE]);
    first.send(ask("s1", "r1"));
    first.clock.advance(30_000);
    first.send({ type: "ask_settled", sessionId: "s1", requestId: "r1", attached: NOBODY });
    expect(first.commands).toEqual([]);
    expect(first.tick()).toEqual([]);
    // (b) the timer wins, so the banner is replaced rather than left actionable.
    const second = harness([ALICE]);
    second.send(ask("s1", "r1"));
    second.clock.advance(30_000);
    second.tick();
    second.send({ type: "ask_settled", sessionId: "s1", requestId: "r1", attached: NOBODY });
    expect(second.commands.map((c) => c.kind)).toEqual(["ask", "ask_resolved"]);
    const pushed = second.commands[0];
    const replaced = second.commands[1];
    if (pushed === undefined || replaced === undefined) throw new Error("expected two commands");
    expect(replaced.collapseId).toBe(pushed.collapseId);
  });

  test("a settle for an ask this build never saw is ignored", () => {
    const h = harness([ALICE]);
    expect(
      h.send({ type: "ask_settled", sessionId: "s1", requestId: "nope", attached: NOBODY }),
    ).toEqual([]);
  });
});

describe("re-offers", () => {
  test("the same requestId does NOT restart the timer (mutation: overwrite the deadline)", () => {
    const h = harness();
    const at = h.clock.now();
    h.send(ask("s1", "r1"));
    h.clock.advance(20_000);
    // A background child re-offers the same ask at attach, and the replay repeats it.
    h.send(ask("s1", "r1"));
    h.send(ask("s1", "r1"));
    expect(h.rules.nextDeadlineAt()).toBe(at + 30_000);
    h.clock.advance(10_000);
    expect(h.tick().map((c) => c.kind)).toEqual(["ask"]);
    expect(h.tick()).toEqual([]);
  });

  test("two asks of one session due together are one banner with `more` (the fold)", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1"));
    h.clock.advance(1_000);
    h.send(ask("s1", "r2"));
    // Both graces have ended by now (r1 at +30 s, r2 at +31 s).
    h.clock.advance(30_000);
    const pushed = h.tick();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.requestId).toBe("r1");
    expect(pushed[0]?.more).toBe(1);
    expect(h.rules.trackedAsks("s1")).toBe(2);
    // Both banners are the same banner: the FIRST settle is silent (a sibling
    // still blocks the turn), and the LAST one replaces it.
    expect(
      h.send({ type: "ask_settled", sessionId: "s1", requestId: "r1", attached: NOBODY }),
    ).toEqual([]);
    expect(
      h
        .send({ type: "ask_settled", sessionId: "s1", requestId: "r2", attached: NOBODY })
        .map((c) => c.kind),
    ).toEqual(["ask_resolved"]);
    expect(h.rules.trackedAsks("s1")).toBe(0);
  });

  // Review P5+P6 finding 2 (MEDIUM): folded asks share the primary's collapse
  // id, so the FIRST settle used to fire `ask_resolved` — the phone reads
  // "answered on another device" while a sibling still blocks the turn, and the
  // survivor is never re-pushed (`pushedTo` is set). Mutation: resolve on any
  // settle (`ask_resolved` from `ask.collapseId`) → the first assertion below
  // sees an `ask_resolved` and goes RED.
  test("settling ONE of a fold does not claim the banner is answered (finding 2)", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1"));
    h.clock.advance(1_000);
    h.send(ask("s1", "r2"));
    h.clock.advance(30_000);
    const pushed = h.tick()[0];
    if (pushed === undefined) throw new Error("expected the folded ask push");
    expect(pushed.requestId).toBe("r1");
    expect(pushed.more).toBe(1);
    // The user answers r2 at the desk; r1 still blocks the turn, so the banner
    // must stay actionable.
    expect(
      h.send({ type: "ask_settled", sessionId: "s1", requestId: "r2", attached: NOBODY }),
    ).toEqual([]);
    expect(h.rules.trackedAsks("s1")).toBe(1);
    // The LAST ask of that banner settles: now, and only now, it is replaced.
    const resolved = h.send({
      type: "ask_settled",
      sessionId: "s1",
      requestId: "r1",
      attached: NOBODY,
    });
    expect(resolved.map((c) => c.kind)).toEqual(["ask_resolved"]);
    expect(resolved[0]?.collapseId).toBe(pushed.collapseId);
    expect(resolved[0]?.requestId).toBe("r1");
    expect(h.rules.trackedAsks("s1")).toBe(0);
  });

  test("a survivor later pushed on its own keeps its OWN banner (finding 2)", () => {
    // r1 is pushed alone, then r2 folds into a second, later push of this
    // session (outside the ask window). The two banners are distinct, so
    // settling r2 must not retract r1's.
    const h = harness([ALICE], { askWindowMs: 10_000 });
    h.send(ask("s1", "r1"));
    h.clock.advance(30_000);
    const first = h.tick()[0];
    if (first === undefined) throw new Error("expected the first ask push");
    h.send(ask("s1", "r2"));
    h.clock.advance(30_000);
    const second = h.tick()[0];
    if (second === undefined) throw new Error("expected the second ask push");
    expect(second.collapseId).not.toBe(first.collapseId);
    // Settling r2 replaces only r2's banner…
    const resolvedSecond = h.send({
      type: "ask_settled",
      sessionId: "s1",
      requestId: "r2",
      attached: NOBODY,
    });
    expect(resolvedSecond.map((c) => c.collapseId)).toEqual([second.collapseId]);
    // …and r1's is still un-answered, still replaceable under its own id.
    const resolvedFirst = h.send({
      type: "ask_settled",
      sessionId: "s1",
      requestId: "r1",
      attached: NOBODY,
    });
    expect(resolvedFirst.map((c) => c.collapseId)).toEqual([first.collapseId]);
  });
});

describe("the turn rule", () => {
  const turnEnd = (stopReason: "end_turn" | "error" | "cancelled", clients: number): PushEvent => ({
    type: "turn_end",
    sessionId: "s1",
    turnId: "t1",
    stopReason,
    attached: { clients, devices: clients > 0 ? [ALICE] : [] },
  });

  test("nobody attached → `turn_done`, to every registered device", () => {
    const h = harness([ALICE, BOB]);
    const pushed = h.send(turnEnd("end_turn", 0));
    expect(pushed.map((c) => c.kind)).toEqual(["turn_done"]);
    expect(pushed[0]?.devices).toEqual([ALICE, BOB]);
    expect(pushed[0]?.turnId).toBe("t1");
  });

  test("a TUI at the desk silences it (mutation: ignore attached.clients)", () => {
    const h = harness([ALICE]);
    expect(h.send(turnEnd("end_turn", 1))).toEqual([]);
    // …and so does any other client.
    expect(h.send(turnEnd("end_turn", 2))).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  test("`error` → `turn_failed`; `cancelled` → nothing at all", () => {
    const h = harness([ALICE]);
    expect(h.send(turnEnd("error", 0)).map((c) => c.kind)).toEqual(["turn_failed"]);
    expect(h.send(turnEnd("cancelled", 0))).toEqual([]);
    expect(h.commands).toHaveLength(1);
  });

  test("no registered device → nothing, and it is SAID (never silent)", () => {
    const h = harness([]);
    const result = h.rules.apply(turnEnd("end_turn", 0));
    expect(result.commands).toEqual([]);
    expect(result.notes.map((n) => n.code)).toEqual(["push-empty"]);
  });

  test("a turn's collapse id is the turn's own, so two turns are two banners", () => {
    const h = harness([ALICE]);
    const first = h.send(turnEnd("end_turn", 0));
    const second = h.send({ ...turnEnd("error", 0), turnId: "t2" } as PushEvent);
    expect(first[0]?.collapseId).not.toBe(second[0]?.collapseId);
  });
});

describe("caps and folding", () => {
  test("at most ONE ask push per session per window; the rest fold into the next", () => {
    const h = harness([ALICE], { graceMs: 0, askWindowMs: 10_000 });
    expect(h.send(ask("s1", "r1")).map((c) => c.kind)).toEqual(["ask"]);
    h.clock.advance(1_000);
    // Inside the window: held, and said (mutation: push anyway → a buzz per ask).
    const held = h.rules.apply(ask("s1", "r2"));
    expect(held.commands).toEqual([]);
    expect(held.notes.map((n) => n.code)).toEqual(["push-folded"]);
    expect(h.rules.nextDeadlineAt()).toBe(h.clock.now() + 9_000);
    h.clock.advance(9_000);
    const pushed = h.tick();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.requestId).toBe("r2");
  });

  test("two sessions do not share a window (the window is the session's)", () => {
    const h = harness([ALICE], { graceMs: 0, askWindowMs: 10_000 });
    expect(h.send(ask("s1", "r1")).map((c) => c.kind)).toEqual(["ask"]);
    expect(h.send(ask("s2", "r2")).map((c) => c.kind)).toEqual(["ask"]);
  });

  test("the storm cap at N / N+1, and it is audited (mutation: no cap → a loop floods)", () => {
    const h = harness([ALICE], { graceMs: 0, maxPerMinute: 2 });
    expect(h.send(ask("s1", "r1")).map((c) => c.kind)).toEqual(["ask"]);
    expect(h.send(turnEndOf("s2", "t2"))).toHaveLength(1);
    const capped = h.rules.apply(turnEndOf("s3", "t3"));
    expect(capped.commands).toEqual([]);
    expect(capped.notes.map((n) => n.code)).toEqual(["push-capped"]);
    expect(PUSH_MAX_PER_MINUTE).toBe(60);
  });

  test("the cap is a ROLLING minute, not a fixed bucket", () => {
    const h = harness([ALICE], { graceMs: 0, maxPerMinute: 1 });
    expect(h.send(ask("s1", "r1"))).toHaveLength(1);
    h.clock.advance(59_999);
    expect(h.send(turnEndOf("s2", "t2"))).toEqual([]);
    h.clock.advance(1);
    expect(h.send(turnEndOf("s3", "t3")).map((c) => c.kind)).toEqual(["turn_done"]);
  });
});

/** A `turn_end` with nobody attached, for the cap tests. */
function turnEndOf(sessionId: string, turnId: string): PushEvent {
  return { type: "turn_end", sessionId, turnId, stopReason: "end_turn", attached: NOBODY };
}

describe("the session's own state", () => {
  test("`session_closed` clears its timers (mutation: keep them → a ghost push)", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1"));
    expect(h.rules.trackedAsks("s1")).toBe(1);
    h.send({ type: "session_closed", sessionId: "s1" });
    expect(h.rules.trackedAsks("s1")).toBe(0);
    expect(h.rules.nextDeadlineAt()).toBeUndefined();
    h.clock.advance(30_000);
    expect(h.tick()).toEqual([]);
  });

  test("another session's asks survive one session closing", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1"));
    h.send(ask("s2", "r2"));
    h.send({ type: "session_closed", sessionId: "s1" });
    h.clock.advance(30_000);
    const pushed = h.tick();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.sessionId).toBe("s2");
  });

  test("the grace survives an ask of MANY sessions: one tick pushes each", () => {
    const h = harness([ALICE]);
    h.send(ask("s1", "r1"));
    h.send(ask("s2", "r2"));
    h.clock.advance(30_000);
    expect(h.tick().map((c) => c.sessionId)).toEqual(["s1", "s2"]);
  });
});

describe("constants", () => {
  test("the TTL is inside APNs's 86400 bound", () => {
    expect(PUSH_TTL_SECONDS).toBe(3_600);
    expect(PUSH_TTL_SECONDS).toBeLessThanOrEqual(86_400);
  });
});
