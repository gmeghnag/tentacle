import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@tentacle/protocol";
import {
  RELAY_IDLE_GRACE_MS,
  RELAY_STOP_BOUND_MS,
  type RelayEvent,
  type RelayModel,
  type ResidentUse,
  exitPlan,
  finalView,
  initialRelay,
  needsUse,
  notifyWakes,
  relayExits,
  relayStep,
  relayView,
  relayWakeDue,
  residentUseOf,
  wantsAwake,
} from "../src/relay-state.ts";

const run = (events: readonly RelayEvent[], from: RelayModel = initialRelay): RelayModel =>
  events.reduce(relayStep, from);
const over = run([{ type: "turn_started" }, { type: "turn_ended", reason: "end_turn" }]);

describe("the wake on a job exit (docs/fix/detached-autowake.md)", () => {
  const exit: RelayEvent = { type: "job_exit" };
  const free: ResidentUse = { jobs: 0, running: false, others: 0 };
  const pendingIdle = run([exit], over);

  test("an exit while idle is due; a turn's start clears it, and its deadline at once", () => {
    expect(relayWakeDue(over, false)).toBe(false);
    expect(relayWakeDue(pendingIdle, false)).toBe(true);
    const graced = run([{ type: "tick", now: 1000 }], pendingIdle);
    expect(graced.exitAt).toBeDefined();
    const started = run([{ type: "turn_started" }], graced);
    expect(relayWakeDue(started, false)).toBe(false);
    expect(started.wake.pending).toBe(false);
    // Without this a wake started at the deadline's last moment is left behind.
    expect(relayExits(started, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test("an exit during a turn waits for its end", () => {
    const running = run([{ type: "turn_started" }, exit]);
    expect(relayWakeDue(running, false)).toBe(false);
    expect(relayWakeDue(run([{ type: "turn_ended", reason: "end_turn" }], running), false)).toBe(
      true,
    );
  });

  test("each block alone says no: an ask, a hand-over, a stop, a stopped link, the exit plan", () => {
    const ask: RelayEvent = { type: "ask_raised", tool: "shell" };
    expect(relayWakeDue(run([ask], pendingIdle), false)).toBe(false);
    const prepared = run([{ type: "handover_prepared" }], pendingIdle);
    expect(relayWakeDue(prepared, false)).toBe(false);
    expect(relayWakeDue(run([{ type: "handed_over" }], prepared), false)).toBe(false);
    expect(relayWakeDue(run([{ type: "stop" }], pendingIdle), false)).toBe(false);
    const link: RelayEvent = { type: "link", status: { state: "stopped", reason: "gone" } };
    expect(relayWakeDue(run([link], pendingIdle), false)).toBe(false);
    expect(relayWakeDue(pendingIdle, true)).toBe(false);
    // Aborted: the relay decides again.
    expect(relayWakeDue(run([{ type: "handover_aborted" }], prepared), false)).toBe(true);
  });

  test("a failed or cut run does not wake, and holds nothing: its reason stays", () => {
    const failed = run([{ type: "turn_started" }, { type: "turn_failed", message: "boom" }, exit]);
    expect(relayWakeDue(failed, false)).toBe(false);
    expect(exitPlan(failed, false, free)).toEqual({ kind: "leave" });
    const cut = run([{ type: "turn_started" }, { type: "turn_ended", reason: "cancelled" }, exit]);
    expect(relayWakeDue(cut, false)).toBe(false);
    expect(exitPlan(cut, true, free)).toEqual({ kind: "leave" });
  });

  test("a refused wake is no failure: the turn is over, the wake pends, the rest is untouched", () => {
    const refused = run([{ type: "turn_started" }, { type: "wake_refused" }], pendingIdle);
    expect(refused.turn).toBe("over");
    expect(refused.rest).toBe("idle");
    expect(refused.detail).toBeUndefined();
    expect(relayWakeDue(refused, false)).toBe(true);
  });

  test("exitPlan: a pending wake holds, rm or not; a stop or a stopped link still exits", () => {
    expect(exitPlan(pendingIdle, false, free)).toEqual({ kind: "hold" });
    expect(exitPlan(pendingIdle, true, free)).toEqual({ kind: "hold" });
    expect(exitPlan(run([{ type: "stop" }], pendingIdle), true, free)).toEqual({ kind: "remove" });
    expect(exitPlan(run([{ type: "stop" }], pendingIdle), false, free)).toEqual({ kind: "leave" });
    const link: RelayEvent = { type: "link", status: { state: "stopped", reason: "gone" } };
    expect(exitPlan(run([link], pendingIdle), true, free)).toEqual({ kind: "leave" });
  });
});

describe("relay state (docs/feat/detached-relay.md R4)", () => {
  test("starts `starting`, a turn is `running`, nothing exits before the turn ended", () => {
    expect(relayView(initialRelay).state).toBe("starting");
    const running = run([{ type: "turn_started" }, { type: "tick", now: 0 }]);
    expect(relayView(running).state).toBe("running");
    expect(relayExits(running, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test("the grace boundary: idle 60 s exits, not 1 ms earlier", () => {
    const idle = run([{ type: "tick", now: 1000 }], over);
    expect(relayView(idle).state).toBe("idle");
    expect(relayExits(idle, 1000 + RELAY_IDLE_GRACE_MS - 1)).toBe(false);
    expect(relayExits(idle, 1000 + RELAY_IDLE_GRACE_MS)).toBe(true);
    // A later tick does not push the deadline.
    const later = run([{ type: "tick", now: 5000 }], idle);
    expect(relayExits(later, 1000 + RELAY_IDLE_GRACE_MS)).toBe(true);
  });

  test("a stopped link's reason is sanitised: it can carry a pod's text", () => {
    // Mutation: raw `event.status.reason` → the ESC and the BEL land in owner.json.
    const stopped = run(
      [{ type: "link", status: { state: "stopped", reason: "skew \u001b]0;pwned\u0007 x" } }],
      over,
    );
    expect(relayView(stopped).state).toBe("failed");
    expect(stopped.detail).toContain("skew");
    expect(stopped.detail).not.toContain("\u001b");
    expect(stopped.detail).not.toContain("\u0007");
  });

  test("a pending ask blocks the exit, and shows its tool", () => {
    const asked = run(
      [
        { type: "ask_raised", tool: "shell" },
        { type: "tick", now: 0 },
      ],
      over,
    );
    expect(relayView(asked)).toMatchObject({ state: "waiting-permission", tool: "shell" });
    expect(relayExits(asked, Number.MAX_SAFE_INTEGER)).toBe(false);
    const gone = run([{ type: "ask_gone" }, { type: "tick", now: 10 }], asked);
    expect(relayView(gone).tool).toBeUndefined();
    expect(relayExits(gone, 10 + RELAY_IDLE_GRACE_MS)).toBe(true);
  });

  test("a running job blocks the exit and cancels a grace already counting", () => {
    // Mutation: drop the `jobs` term of idle → exits with a job running.
    const counting = run([{ type: "tick", now: 0 }], over);
    const job = run(
      [
        { type: "jobs", n: 2 },
        { type: "tick", now: 1 },
      ],
      counting,
    );
    expect(relayView(job).state).toBe("running");
    expect(relayExits(job, Number.MAX_SAFE_INTEGER)).toBe(false);
    const done = run(
      [
        { type: "jobs", n: 0 },
        { type: "tick", now: 100 },
      ],
      job,
    );
    expect(relayExits(done, 100 + RELAY_IDLE_GRACE_MS - 1)).toBe(false);
    expect(relayExits(done, 100 + RELAY_IDLE_GRACE_MS)).toBe(true);
  });

  test("a turn cancelled that nobody stopped is `interrupted`, then the grace", () => {
    const cut = run([
      { type: "turn_started" },
      { type: "turn_ended", reason: "cancelled" },
      { type: "tick", now: 0 },
    ]);
    expect(relayView(cut).state).toBe("interrupted");
    expect(relayExits(cut, RELAY_IDLE_GRACE_MS)).toBe(true);
  });

  test("a failed turn is `failed` with its message, then the grace", () => {
    const failed = run([
      { type: "turn_started" },
      { type: "turn_failed", message: "model down" },
      { type: "tick", now: 0 },
    ]);
    expect(relayView(failed)).toMatchObject({ state: "failed", detail: "model down" });
    expect(relayExits(failed, RELAY_IDLE_GRACE_MS - 1)).toBe(false);
    expect(relayExits(failed, RELAY_IDLE_GRACE_MS)).toBe(true);
  });

  test("the link stopped: `failed`, exit now, whatever is running", () => {
    const down = run([
      { type: "turn_started" },
      { type: "ask_raised", tool: "shell" },
      { type: "jobs", n: 1 },
      { type: "link", status: { state: "stopped", reason: "the container is gone" } },
    ]);
    expect(relayView(down)).toMatchObject({ state: "failed", detail: "the container is gone" });
    expect(relayExits(down, 0)).toBe(true);
    // The turn failing because of it says nothing new.
    const then = run([{ type: "turn_failed", message: "connection closed" }], down);
    expect(relayView(then)).toMatchObject({ state: "failed", detail: "the container is gone" });
    expect(relayView(run([{ type: "turn_ended", reason: "cancelled" }], down)).state).toBe(
      "failed",
    );
  });

  test("a reconnecting link changes nothing: no give-up bound", () => {
    const flaky = run(
      [
        { type: "turn_started" },
        { type: "link", status: { state: "reconnecting", attempt: 9, nextAtMs: 30_000 } },
        { type: "tick", now: 0 },
      ],
      initialRelay,
    );
    expect(relayView(flaky).state).toBe("running");
    expect(relayExits(flaky, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test("stop during a turn: exits once it settled, a turn that never does past the bound", () => {
    const stopping = run([{ type: "turn_started" }, { type: "stop" }, { type: "tick", now: 100 }]);
    expect(relayExits(stopping, 100 + RELAY_STOP_BOUND_MS - 1)).toBe(false);
    expect(relayExits(stopping, 100 + RELAY_STOP_BOUND_MS)).toBe(true);
    const settled = run([{ type: "turn_ended", reason: "cancelled" }], stopping);
    expect(relayExits(settled, 100)).toBe(true);
    expect(relayView(settled).state).toBe("idle"); // stopped: not an interruption
  });

  test("stop with no turn running: exit now, jobs or not", () => {
    expect(relayExits(run([{ type: "stop" }]), 0)).toBe(true);
    expect(relayExits(run([{ type: "jobs", n: 3 }, { type: "stop" }], over), 0)).toBe(true);
  });

  test("the last state written never says a turn is still running", () => {
    expect(finalView(over).state).toBe("idle");
    const cut = run([{ type: "turn_started" }, { type: "stop" }]);
    expect(finalView(cut).state).toBe("interrupted");
    expect(finalView(run([{ type: "stop" }])).state).toBe("interrupted");
    const failed = run([{ type: "link", status: { state: "stopped", reason: "gone" } }]);
    expect(finalView(failed)).toMatchObject({ state: "failed", detail: "gone" });
  });
});

describe("exitPlan: the only place removal is decided (docs/feat/detached-relay-lifecycle.md L10)", () => {
  const free: ResidentUse = { jobs: 0, running: false, others: 0 };
  const lost: RelayEvent = { type: "link", status: { state: "stopped", reason: "gone" } };
  const cut = run([{ type: "turn_started" }, { type: "turn_ended", reason: "cancelled" }]);
  const failed = run([{ type: "turn_started" }, { type: "turn_failed", message: "down" }]);

  test("no `rm` (kept) wins over everything", () => {
    for (const model of [over, cut, failed, run([{ type: "stop" }], over), run([lost], over)]) {
      expect(exitPlan(model, false, free)).toEqual({ kind: "leave" });
    }
  });

  test("a stopped link leaves, before a stop: the name may no longer be ours", () => {
    expect(exitPlan(run([lost], over), true, free).kind).toBe("leave");
    expect(exitPlan(run([lost, { type: "stop" }], over), true, free).kind).toBe("leave");
    expect(exitPlan(run([{ type: "stop" }, lost], over), true, free).kind).toBe("leave");
  });

  test("a stop removes with no read, whatever the rest and the use", () => {
    const stop: RelayEvent = { type: "stop" };
    expect(exitPlan(run([stop], over), true, null)).toEqual({ kind: "remove" });
    expect(exitPlan(run([stop], cut), true, null).kind).toBe("remove");
    expect(exitPlan(run([stop], failed), true, null).kind).toBe("remove");
    // A turn that failed BECAUSE of the stop is not a stopped link.
    const stopped = run(
      [{ type: "turn_started" }, stop, { type: "turn_failed", message: "aborted" }],
      initialRelay,
    );
    expect(exitPlan(stopped, true, null).kind).toBe("remove");
    const busy: ResidentUse = { jobs: 3, running: true, others: 2 };
    expect(exitPlan(run([{ type: "ask_raised", tool: "x" }, stop], over), true, busy).kind).toBe(
      "remove",
    );
  });

  test("`failed` and `interrupted` keep the workload (Q2), the read says nothing", () => {
    // Mutation: remove on any `relayExits`.
    expect(exitPlan(cut, true, free).kind).toBe("leave");
    expect(exitPlan(failed, true, free).kind).toBe("leave");
    expect(exitPlan(cut, true, null).kind).toBe("leave");
  });

  test("an unreadable use leaves, saying so", () => {
    // Mutation: drop the `use === null` row → a job running is deleted on a stale 0.
    expect(exitPlan(over, true, null)).toEqual({
      kind: "leave",
      why: "could not tell whether it is in use",
    });
  });

  test("its own job or turn holds", () => {
    expect(exitPlan(over, true, { ...free, jobs: 1 })).toEqual({ kind: "hold" });
    expect(exitPlan(over, true, { ...free, running: true })).toEqual({ kind: "hold" });
    expect(exitPlan(over, true, { jobs: 1, running: false, others: 1 }).kind).toBe("hold");
  });

  test("another client leaves, saying so; nobody removes", () => {
    expect(exitPlan(over, true, { ...free, others: 1 })).toEqual({
      kind: "leave",
      why: "another client is using it",
    });
    expect(exitPlan(over, true, free)).toEqual({ kind: "remove" });
  });

  test("needsUse: the read happens only where its answer can change the plan", () => {
    expect(needsUse(over, true)).toBe(true);
    expect(needsUse(over, false)).toBe(false);
    expect(needsUse(cut, true)).toBe(false);
    expect(needsUse(failed, true)).toBe(false);
    expect(needsUse(run([{ type: "stop" }], over), true)).toBe(false);
    expect(needsUse(run([lost], over), true)).toBe(false);
  });
});

describe("residentUseOf: `session/list`, as `exitPlan` needs it (L10)", () => {
  const ME = "11111111-1111-4111-8111-111111111111";
  const row = (sessionId: string, over: Partial<SessionListEntry> = {}): SessionListEntry => ({
    sessionId,
    title: "t",
    cwd: "/w",
    createdAt: 1,
    updatedAt: 1,
    running: false,
    attached: 0,
    archived: false,
    ...over,
  });

  test("its own session, and the others in use", () => {
    expect(residentUseOf({ sessions: [row(ME, { attached: 1 })] }, ME)).toEqual({
      jobs: 0,
      running: false,
      others: 0,
    });
    expect(
      residentUseOf(
        {
          sessions: [
            row(ME, { attached: 1, running: true, jobs: 2 }),
            row("a", { attached: 1 }),
            row("b", { running: true }),
            row("c", { jobs: 1 }),
          ],
        },
        ME,
      ),
    ).toEqual({ jobs: 2, running: true, others: 3 });
  });

  test("a session whose client left is nobody (probe A3)", () => {
    // Mutation: count every other session → any earlier `attach` pins the workload.
    expect(residentUseOf({ sessions: [row(ME), row("gone")] }, ME)?.others).toBe(0);
  });

  test("a list that cannot be trusted whole is no answer: a cursor, or no own session", () => {
    expect(residentUseOf({ sessions: [row(ME)], cursor: "next" }, ME)).toBeNull();
    expect(residentUseOf({ sessions: [row("other")] }, ME)).toBeNull();
    expect(residentUseOf({ sessions: [] }, ME)).toBeNull();
  });

  test("D16 `ownMayBeAbsent` (a TUI's quit, docs/fix/detach-live.md A5): no own session is no use of it; a cursor still no answer", () => {
    // Mutation: the option always on → the relay deletes on a missing session.
    const opt = { ownMayBeAbsent: true } as const;
    expect(residentUseOf({ sessions: [row("other", { attached: 1 })] }, ME, opt)).toEqual({
      jobs: 0,
      running: false,
      others: 1,
    });
    expect(residentUseOf({ sessions: [] }, ME, opt)).toEqual({
      jobs: 0,
      running: false,
      others: 0,
    });
    expect(residentUseOf({ sessions: [], cursor: "next" }, ME, opt)).toBeNull();
    // Off (the relay's read): unchanged.
    expect(residentUseOf({ sessions: [row("other", { attached: 1 })] }, ME)).toBeNull();
  });
});

describe("`busy` (L11): `hold` costs another grace, never a spin", () => {
  test("clears the deadline; the next tick counts a full 60 s", () => {
    // Mutation: ignore `busy` → `relayExits` stays true and the loop spins on the read.
    const due = run([{ type: "tick", now: 0 }], over);
    expect(relayExits(due, RELAY_IDLE_GRACE_MS)).toBe(true);
    const held = relayStep(due, { type: "busy" });
    expect(relayExits(held, Number.MAX_SAFE_INTEGER)).toBe(false);
    const again = relayStep(held, { type: "tick", now: RELAY_IDLE_GRACE_MS });
    expect(relayExits(again, 2 * RELAY_IDLE_GRACE_MS - 1)).toBe(false);
    expect(relayExits(again, 2 * RELAY_IDLE_GRACE_MS)).toBe(true);
  });
});

describe("`note`: why a workload stayed", () => {
  test("is the detail of the state left behind, sanitised", () => {
    const noted = relayStep(over, { type: "note", detail: "kept \u001b[2Jit" });
    expect(finalView(noted)).toEqual({ state: "idle", detail: "kept [2Jit" });
  });

  test("a turn still running at the exit: the note stays, after why it was cut", () => {
    // Fix round 3: the "not saved — workload kept" line must reach `ps`.
    const cut = run([{ type: "turn_started" }, { type: "stop" }, { type: "note", detail: "kept" }]);
    expect(finalView(cut)).toEqual({
      state: "interrupted",
      detail: "the relay was stopped before the turn ended; kept",
    });
  });
});

describe("wantsAwake (DR-9, L24)", () => {
  test("only while a turn runs with no ask held", () => {
    // Mutation: drop `asks` → the Mac stays awake through a held ask, for hours.
    expect(wantsAwake(initialRelay)).toBe(false);
    const running = run([{ type: "turn_started" }]);
    expect(wantsAwake(running)).toBe(true);
    expect(wantsAwake(run([{ type: "ask_raised", tool: "x" }], running))).toBe(false);
    expect(wantsAwake(run([{ type: "jobs", n: 1 }], over))).toBe(false);
    expect(wantsAwake(over)).toBe(false);
    // A stop settles within its bound: the ask it cancels must not restart it.
    expect(wantsAwake(run([{ type: "stop" }], running))).toBe(false);
  });
});

describe("WantsAwake with a background sub-agent (docs/feat/subagent-background-ui.md, T47)", () => {
  test("keeps awake while a child runs, with a turn running or over", () => {
    // A child in a pod needs the laptop for its model (the reverse tunnel): if
    // the Mac sleeps, its next call has nowhere to go.
    const agents = (n: number): RelayEvent => ({ type: "agents", n });
    expect(wantsAwake(run([agents(1)], over))).toBe(true);
    expect(wantsAwake(run([agents(1)], run([{ type: "turn_started" }])))).toBe(true);
    // No child, no turn: the Mac may sleep, as before.
    expect(wantsAwake(run([agents(0)], over))).toBe(false);
    // A held ask lets it sleep (the relay is doomed to exit at once).
    expect(wantsAwake(run([{ type: "ask_raised", tool: "x" }], run([agents(2)], over)))).toBe(
      false,
    );
    // A stop, or a finished hand-over: the relay is leaving.
    expect(wantsAwake(run([{ type: "stop" }], run([agents(1)], over)))).toBe(false);
    expect(wantsAwake(run([{ type: "handed_over" }], run([agents(1)], over)))).toBe(false);
  });

  test("a running child holds the idle exit, like a background job", () => {
    // The other half of the same fact: `tick` must not arm the 60 s exit while a
    // child is still using the laptop's model.
    const withChild = run([{ type: "agents", n: 1 }], over);
    const model = relayStep(withChild, { type: "tick", now: 0 });
    expect(model.exitAt).toBeUndefined();
    expect(relayView(withChild).detail).toBe("1 background sub-agent(s) running");
    const quiet = relayStep(run([{ type: "agents", n: 0 }], over), { type: "tick", now: 0 });
    expect(quiet.exitAt).toBe(60_000);
  });
});

describe("H23 the hand-over (docs/feat/detached-handover.md)", () => {
  const free: ResidentUse = { jobs: 0, running: false, others: 0 };
  const prepared: RelayEvent = { type: "handover_prepared" };

  test("exitPlan: handed over leaves, before `rm` or a stop removes anything", () => {
    // Mutation: drop the `done` row → the relay deletes the workload under the TUI (the repro).
    const done = run([prepared, { type: "handed_over" }], over);
    expect(exitPlan(done, true, free)).toEqual({ kind: "leave" });
    expect(exitPlan(run([{ type: "stop" }], done), true, free)).toEqual({ kind: "leave" });
    expect(exitPlan(done, false, free)).toEqual({ kind: "leave" });
  });

  test("exitPlan: prepared holds a due exit; a stop, or a stopped link, still exits", () => {
    // Mutation: drop the `prepared` row → a `prepare` landing during the use read meets a removal.
    const ready = run([prepared], over);
    expect(exitPlan(ready, true, free)).toEqual({ kind: "hold" });
    expect(exitPlan(ready, false, free)).toEqual({ kind: "hold" });
    expect(exitPlan(run([{ type: "stop" }], ready), true, free)).toEqual({ kind: "remove" });
    const lost = run([{ type: "link", status: { state: "stopped", reason: "gone" } }], ready);
    expect(exitPlan(lost, true, free)).toEqual({ kind: "leave" });
    // Aborted: back to the plain rows.
    expect(exitPlan(run([{ type: "handover_aborted" }], ready), true, free)).toEqual({
      kind: "remove",
    });
  });

  test("prepared clears the idle deadline; aborted lets the grace start again", () => {
    const idle = run([{ type: "tick", now: 1000 }], over);
    expect(idle.exitAt).toBe(1000 + RELAY_IDLE_GRACE_MS);
    const ready = run([prepared, { type: "tick", now: 2000 }], idle);
    expect(ready.exitAt).toBeUndefined();
    expect(relayExits(ready, Number.MAX_SAFE_INTEGER)).toBe(false);
    const back = run([{ type: "handover_aborted" }, { type: "tick", now: 3000 }], ready);
    expect(back.exitAt).toBe(3000 + RELAY_IDLE_GRACE_MS);
    // A stop while prepared still runs its bound.
    const stopping = run([{ type: "stop" }, { type: "tick", now: 4000 }], run([prepared]));
    expect(relayExits(stopping, 4000)).toBe(true);
  });

  test("handed over: only the drain ends it; keep-awake is off", () => {
    const running = run([{ type: "turn_started" }]);
    expect(wantsAwake(running)).toBe(true);
    const done = run([prepared, { type: "handed_over" }], running);
    expect(wantsAwake(done)).toBe(false);
    expect(relayExits(run([{ type: "tick", now: 1 }], done), Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(relayExits(run([{ type: "drained" }], done), 1)).toBe(true);
  });
});

describe("T16: a child's message to the agent asks the relay for a wake", () => {
  const allowed = { autoWake: true, subagentsTwoWay: true };

  test("a waking note starts a continuation when this laptop allows two-way", () => {
    expect(notifyWakes({ wake: true }, allowed)).toBe(true);
  });

  test("a NON-waking note never does (the session's wake budget said so)", () => {
    expect(notifyWakes({ wake: false }, allowed)).toBe(false);
  });

  test("`subagents.twoWay` off: a note still arrives, and arms nothing", () => {
    expect(notifyWakes({ wake: true }, { ...allowed, subagentsTwoWay: false })).toBe(false);
  });

  test("`autoWake` off: the same, the laptop's other gate", () => {
    expect(notifyWakes({ wake: true }, { ...allowed, autoWake: false })).toBe(false);
  });
});
