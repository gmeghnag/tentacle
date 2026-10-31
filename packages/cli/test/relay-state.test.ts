import { describe, expect, test } from "bun:test";
import {
  RELAY_IDLE_GRACE_MS,
  RELAY_STOP_BOUND_MS,
  type RelayEvent,
  type RelayModel,
  finalView,
  initialRelay,
  relayExits,
  relayStep,
  relayView,
} from "../src/relay-state.ts";

const run = (events: readonly RelayEvent[], from: RelayModel = initialRelay): RelayModel =>
  events.reduce(relayStep, from);
const over = run([{ type: "turn_started" }, { type: "turn_ended", reason: "end_turn" }]);

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
