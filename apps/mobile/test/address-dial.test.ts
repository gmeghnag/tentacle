/**
 * Which address to dial (docs/feat/mobile-pairing-screen.md 11b.1, Tests;
 * the staggered race is docs/feat/mobile-relay.md R6, Design §6).
 *
 * The load-bearing rules: a terminal `unauthorized` STOPS the race, the race
 * starts at the address that answered last, a HANGING first address does not
 * hold the rest back beyond `STAGGER_MS`, and a loser is closed BEFORE any
 * handshake is sent on it. The timer is injected, so no test waits 750 ms.
 */
import { describe, expect, test } from "bun:test";
import { ChannelError } from "@tentacle/client";
import {
  type DialMemory,
  type DialSteps,
  type DialTimer,
  STAGGER_MS,
  firstAnswering,
  isTerminalDialError,
} from "../src/address-dial.ts";

const A = "ws://a.local:4001/e2e";
const B = "ws://b.local:4001/e2e";
const C = "ws://c.local:4001/e2e";
const memory = (lastGood?: number): DialMemory => ({ lastGood });

/** A timer the test fires by hand: nothing here waits a real 750 ms. */
function manualTimer() {
  const due: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const timer: DialTimer = {
    schedule(fn, ms) {
      const entry = { fn, ms, cancelled: false };
      due.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  };
  return {
    timer,
    /** What the policy asked for (the stagger is a rule, not a magic number). */
    delays: () => due.map((entry) => entry.ms),
    /** Fire every live timer (the code arms the next one from inside). */
    fire() {
      for (const entry of due.splice(0)) {
        if (!entry.cancelled) {
          entry.fn();
        }
      }
    },
    armed: () => due.filter((entry) => !entry.cancelled).length,
  };
}

/** A path a test opens by hand: `open(i)` resolves it, `fail(i)` rejects it. */
function harness() {
  const opened: ((path: string) => void)[] = [];
  const failed: ((error: unknown) => void)[] = [];
  const confirmed: ((channel: string) => void)[] = [];
  const confirmFailed: ((error: unknown) => void)[] = [];
  const abandoned: string[] = [];
  const started: string[] = [];
  const steps: DialSteps<string, string> = {
    open: (address) => {
      started.push(address);
      return new Promise<string>((resolve, reject) => {
        opened.push(resolve);
        failed.push(reject);
      });
    },
    abandon: (path) => {
      abandoned.push(path);
    },
    confirm: (path) =>
      new Promise<string>((resolve, reject) => {
        confirmed.push(resolve);
        confirmFailed.push(reject);
        void path;
      }),
  };
  return {
    steps,
    started,
    abandoned,
    open: (i: number, path?: string) => opened[i]?.(path ?? `raw-${i}`),
    fail: (i: number, error: unknown) => failed[i]?.(error),
    confirm: (i: number, answer?: string) => confirmed[i]?.(answer ?? `answer-${i}`),
    confirmFail: (i: number, error: unknown) => confirmFailed[i]?.(error),
    /** A new dial may push more entries; index arithmetic stays honest. */
    openCount: () => opened.length,
    confirmCount: () => confirmed.length,
  };
}

/** Let every pending microtask run (a race settles across several of them). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe("firstAnswering: the staggered race (R6)", () => {
  test("a HANGING first address does not block the second beyond STAGGER_MS (mutation: start all at once → the direct-first test fails; start in sequence → this one)", async () => {
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A, B], h.steps, memory(), { timer: clock.timer });
    await settle();
    // Only the first address was started: the stagger is what starts the next.
    expect(h.started).toEqual([A]);
    expect(clock.delays()).toEqual([STAGGER_MS]);
    clock.fire();
    await settle();
    // 750 ms later the second is dialling, while the first still hangs.
    expect(h.started).toEqual([A, B]);
    // The second opens first and wins.
    h.open(1, "raw-B");
    await settle();
    h.confirm(0, "answered-B");
    await expect(answering).resolves.toBe("answered-B");
    // The hanging one never opened, so it was never sent a handshake.
    expect(h.confirmCount()).toBe(1);
  });

  test("the FIRST socket to open wins, and it is the only one that handshakes", async () => {
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A, B, C], h.steps, memory(), { timer: clock.timer });
    await settle();
    clock.fire(); // B starts (A hangs)
    await settle();
    h.open(1, "raw-B");
    await settle();
    clock.fire(); // a stale arm must not start C: the race is decided
    await settle();
    expect(h.started).toEqual([A, B]);
    h.confirm(0, "answer-B");
    await expect(answering).resolves.toBe("answer-B");
    expect(h.confirmCount()).toBe(1);
  });

  test("a loser that opens LATE is closed BEFORE any handshake (mutation: confirm it → the relay is paid for a socket nobody uses)", async () => {
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A, B], h.steps, memory(), { timer: clock.timer });
    await settle();
    clock.fire();
    await settle();
    // B wins…
    h.open(1, "raw-B");
    await settle();
    h.confirm(0, "answer-B");
    await expect(answering).resolves.toBe("answer-B");
    // …and THEN the hanging A opens: abandoned, never handshaked.
    h.open(0, "raw-A");
    await settle();
    expect(h.abandoned).toEqual(["raw-A"]);
    expect(h.confirmCount()).toBe(1);
  });

  test("the loser is abandoned while the winner is still handshaking, not after", async () => {
    const clock = manualTimer();
    const h = harness();
    void firstAnswering([A, B], h.steps, memory(), { timer: clock.timer });
    await settle();
    clock.fire();
    await settle();
    // A opens and wins; B opens while the handshake is still in flight.
    h.open(0, "raw-A");
    await settle();
    h.open(1, "raw-B");
    await settle();
    // The handshake has NOT settled yet, and B is already closed.
    expect(h.confirmCount()).toBe(1);
    expect(h.abandoned).toEqual(["raw-B"]);
  });

  test("a non-terminal handshake failure on the winner continues with the REST (and re-dials what it abandoned)", async () => {
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A, B, C], h.steps, memory(), { timer: clock.timer });
    await settle();
    clock.fire(); // B starts
    await settle();
    clock.fire(); // C starts (nothing has opened yet)
    await settle();
    expect(h.started).toEqual([A, B, C]);
    // B opens, wins, and then fails its handshake.
    h.open(1, "raw-B");
    await settle();
    h.confirmFail(0, new ChannelError("unreachable", "handshake closed"));
    await settle();
    // The next round resumes AFTER B: C (and A, re-dialled) can still answer.
    expect(h.started).toEqual([A, B, C, C]);
    h.open(3, "raw-C2");
    await settle();
    h.confirm(1, "answer-C");
    await expect(answering).resolves.toBe("answer-C");
  });

  test("every address failing its open throws the LAST error UNCHANGED", async () => {
    const clock = manualTimer();
    const h = harness();
    const failures = [
      new ChannelError("unreachable", "first"),
      new ChannelError("rejected", "second"),
      new Error("third"),
    ];
    const answering = firstAnswering([A, B, C], h.steps, memory(), { timer: clock.timer });
    await settle();
    h.fail(0, failures[0]);
    await settle();
    clock.fire(); // B
    await settle();
    h.fail(1, failures[1]);
    await settle();
    clock.fire(); // C
    await settle();
    h.fail(2, failures[2]);
    const caught = await answering.catch((error: unknown) => error);
    // Unchanged: the link machine and `describeError` classify an error by its
    // own kind, so wrapping it would hide exactly what they read.
    expect(caught).toBe(failures[2]);
    expect(h.started).toEqual([A, B, C]);
  });

  test("STOPS on unauthorized without dialling the next (mutation: continue → red)", async () => {
    const clock = manualTimer();
    const h = harness();
    const denied = new ChannelError("unauthorized", "the daemon refused this device");
    const answering = firstAnswering([A, B, C], h.steps, memory(), { timer: clock.timer });
    await settle();
    h.open(0, "raw-A");
    await settle();
    h.confirmFail(0, denied);
    const caught = await answering.catch((error: unknown) => error);
    expect(caught).toBe(denied);
    // The property: no second address was EVER started.
    expect(h.started).toEqual([A]);
    expect(clock.armed()).toBe(0); // and no stagger was left armed behind it
  });

  test("starts at the remembered good address (and wraps)", async () => {
    const clock = manualTimer();
    const h = harness();
    const mem = memory(2);
    const answering = firstAnswering([A, B, C], h.steps, mem, { timer: clock.timer });
    await settle();
    // C first (last known good)…
    expect(h.started).toEqual([C]);
    h.open(0, "raw-C");
    await settle();
    h.confirm(0, "answer-C");
    await expect(answering).resolves.toBe("answer-C");
    // …and C is remembered by its place in the CALLER's array (2), not by its
    // place in the ring (0) — a later dial indexes `addresses` with it.
    expect(mem.lastGood).toBe(2);
  });

  test("the wrap order is the ring, not a restart", async () => {
    const clock = manualTimer();
    const h = harness();
    const mem = memory(2);
    const answering = firstAnswering([A, B, C], h.steps, mem, { timer: clock.timer });
    await settle();
    expect(h.started).toEqual([C]);
    h.fail(0, new ChannelError("unreachable", "no route"));
    await settle();
    clock.fire();
    await settle();
    // After the remembered one comes the ring's next, i.e. A.
    expect(h.started).toEqual([C, A]);
    h.open(1, "raw-A");
    await settle();
    h.confirm(0, "answer-A");
    await expect(answering).resolves.toBe("answer-A");
    expect(mem.lastGood).toBe(0);
  });

  test("a stale memory (more addresses than it knows) starts at 0", async () => {
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A], h.steps, memory(9), { timer: clock.timer });
    await settle();
    expect(h.started).toEqual([A]);
    h.open(0);
    await settle();
    h.confirm(0, "answer-A");
    await expect(answering).resolves.toBe("answer-A");
  });

  test("no addresses at all is a failure, not a hang", async () => {
    const h = harness();
    const caught = await firstAnswering([], h.steps, memory()).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ChannelError);
    expect((caught as ChannelError).kind).toBe("unreachable");
  });

  test("the production timer is real: the stagger constant is 750 ms", () => {
    // The app passes no timer, so the constant IS the behaviour (Owner Q6).
    expect(STAGGER_MS).toBe(750);
  });

  test("isTerminalDialError: only unauthorized", () => {
    expect(isTerminalDialError(new ChannelError("unauthorized", "x"))).toBe(true);
    expect(isTerminalDialError(new ChannelError("unreachable", "x"))).toBe(false);
    expect(isTerminalDialError(new ChannelError("rejected", "x"))).toBe(false);
    expect(isTerminalDialError(new ChannelError("gone", "x"))).toBe(false);
    expect(isTerminalDialError(new Error("x"))).toBe(false);
  });
});
