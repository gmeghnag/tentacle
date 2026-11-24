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
import {
  type DialMemory,
  type DialSteps,
  type DialTimer,
  STAGGER_MS,
  firstAnswering,
  isTerminalDialError,
} from "../src/address-dial.ts";
import { ChannelError } from "../src/link-machine.ts";

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
    /** Fire only the timers armed for `ms` (the deadline, not the stagger). */
    fireFor(ms: number) {
      for (const entry of due.splice(0)) {
        if (!entry.cancelled && entry.ms === ms) {
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

  test("TWO consecutive handshake failures still reach the LAST address (review round 1, finding 1)", async () => {
    // The real list is [LAN, tailnet, relay] and the case R6 exists FOR is the
    // one where both direct paths open and fail their handshake: the relay is
    // the third. A fall-through that slices by a candidate's place in the FIRST
    // round walks past it (`slice(2)` of `[tailnet, relay]` is `[]`), so the
    // relay is silently never dialled — the bug this test pins.
    //
    // Every open resolves at once here, so each round's first candidate wins
    // without the stagger (this is about ROUND numbering, not timing).
    const confirmed: string[] = [];
    const steps: DialSteps<string, string> = {
      open: async (address) => address,
      abandon: () => {},
      confirm: async (address) => {
        confirmed.push(address);
        if (address === "relay") {
          return "answered-relay";
        }
        // A wrong path, not an absent one: non-terminal, so the loop continues.
        throw new ChannelError("unreachable", `handshake closed at ${address}`);
      },
    };
    const answer = await firstAnswering(["lan", "tailnet", "relay"], steps, memory(), {
      timer: manualTimer().timer,
    });
    expect(answer).toBe("answered-relay");
    // Every address was handshaked, in order — none was skipped.
    expect(confirmed).toEqual(["lan", "tailnet", "relay"]);
  });

  test("a loser whose OPEN fails LATE is not reported as a failure (review round 1, finding 2)", async () => {
    const clock = manualTimer();
    const h = harness();
    const reported: string[] = [];
    const steps: DialSteps<string, string> = {
      ...h.steps,
      failed: (failure) => reported.push(failure.address),
    };
    const answering = firstAnswering([A, B], steps, memory(), { timer: clock.timer });
    await settle();
    clock.fire(); // B starts, while A still hangs
    await settle();
    // B opens and wins; its handshake answers. The race is decided.
    h.open(1, "raw-B");
    await settle();
    h.confirm(0, "answer-B");
    await expect(answering).resolves.toBe("answer-B");
    // NOW A's open rejects (a TCP timeout on a LAN address the phone is off).
    // The verdict is already decided, so this path says nothing: reporting it
    // would overwrite an authenticated verdict with `unreachable`.
    h.fail(0, new ChannelError("unreachable", "EHOSTUNREACH"));
    await settle();
    expect(reported).toEqual([]);
  });

  test("an open that fails while its race is UNDECIDED is reported (the failed seam is not dead)", async () => {
    const clock = manualTimer();
    const h = harness();
    const reported: string[] = [];
    const steps: DialSteps<string, string> = {
      ...h.steps,
      failed: (failure) => reported.push(failure.address),
    };
    const answering = firstAnswering([A, B], steps, memory(), { timer: clock.timer });
    await settle();
    h.fail(0, new ChannelError("unreachable", "no route"));
    await settle();
    // Reported, and the ring carries on immediately on a fail (the stagger only throttles hangs).
    expect(reported).toEqual([A]);
    // B started immediately, no clock.fire() — that is W1 (T1 proves it; a hang still keeps the stagger, T2).
    await settle();
    h.open(1, "raw-B");
    await settle();
    h.confirm(0, "answer-B");
    await expect(answering).resolves.toBe("answer-B");
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
    // With fast fails, B is already started — no clock.fire() (W1).
    h.fail(1, failures[1]);
    await settle();
    // Likewise C is already started from B's immediate kick.
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
    // A fail starts the next immediately (no stagger wait) — W1.
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

  describe("fix/mobile-connect-latency — T1/T2 (W1)", () => {
    test("T1: a fast-failing address starts the next one before any stagger fires", async () => {
      const clock = manualTimer();
      const h = harness();
      const answering = firstAnswering([A, B, C], h.steps, memory(), { timer: clock.timer });
      await settle();
      expect(h.started).toEqual([A]);
      h.fail(0, new ChannelError("unreachable", "no route"));
      await settle();
      // With two fast fails, C must already be started — no clock.fire().
      expect(h.started).toEqual([A, B]);
      h.fail(1, new ChannelError("unreachable", "no route"));
      await settle();
      expect(h.started).toEqual([A, B, C]);
      h.open(2, "raw-C");
      await settle();
      h.confirm(0, "answer-C");
      await expect(answering).resolves.toBe("answer-C");
    });
    test("T2: a hanging open keeps the stagger — the next one does NOT start until clock.fire()", async () => {
      const clock = manualTimer();
      const h = harness();
      firstAnswering([A, B], h.steps, memory(), { timer: clock.timer });
      await settle();
      expect(h.started).toEqual([A]);
      // A hangs — no fail: B must still wait for the stagger.
      expect(h.started).toEqual([A]);
      expect(clock.delays()).toEqual([STAGGER_MS]);
      clock.fire();
      await settle();
      expect(h.started).toEqual([A, B]);
    });
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

describe("firstAnswering: the caller's own terminal rule (pairing)", () => {
  test("isTerminal stops the loop on the caller's error, and rethrows it unchanged", async () => {
    // Pairing's rule: a refusal is the DAEMON's answer about the whole computer
    // (a spent or wrong code), so no other address may be tried — exactly like
    // `unauthorized`. Mutation: ignore `options.isTerminal` → B is dialled and
    // this asserts the addresses actually started.
    class Refused extends Error {}
    const refused = new Refused("invalid code");
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A, B, C], h.steps, memory(), {
      timer: clock.timer,
      isTerminal: (error) => error instanceof Refused || isTerminalDialError(error),
    });
    await settle();
    h.open(0, "raw-A");
    await settle();
    h.confirmFail(0, refused);
    const caught = await answering.catch((error: unknown) => error);
    expect(caught).toBe(refused);
    expect(h.started).toEqual([A]);
  });

  test("the default rule still stops on `unauthorized` only (a custom rule does not weaken it)", async () => {
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A, B], h.steps, memory(), {
      timer: clock.timer,
      isTerminal: (error) => error instanceof ChannelError && error.kind === "gone",
    });
    await settle();
    h.open(0, "raw-A");
    await settle();
    // `unauthorized` is NOT terminal under this rule: the next address is tried.
    h.confirmFail(0, new ChannelError("unauthorized", "x"));
    await settle();
    clock.fire();
    await settle();
    expect(h.started).toEqual([A, B]);
    h.open(1, "raw-B");
    await settle();
    h.confirm(1, "answer-B");
    await expect(answering).resolves.toBe("answer-B");
  });
});

describe("firstAnswering: the open deadline (pairing's 15 s)", () => {
  test("no socket opened within the deadline → failed `unreachable`, at: undefined (mutation: drop the deadline branch → this test hangs)", async () => {
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A, B], h.steps, memory(), {
      timer: clock.timer,
      openDeadlineMs: 15_000,
    });
    await settle();
    // A's open is still pending, and the stagger for B was never fired.
    clock.fireFor(15_000);
    const caught = await answering.catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ChannelError);
    expect((caught as ChannelError).kind).toBe("unreachable");
    // `at: undefined` means nothing is left to try: the loop does NOT resume,
    // and no address starts after the deadline either.
    expect(h.started).toEqual([A]);
    clock.fire();
    await settle();
    expect(h.started).toEqual([A]);
  });

  test("a socket that opens AFTER the deadline is abandoned, not confirmed", async () => {
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A], h.steps, memory(), {
      timer: clock.timer,
      openDeadlineMs: 15_000,
    });
    await settle();
    clock.fireFor(15_000);
    const caught = await answering.catch((error: unknown) => error);
    expect((caught as ChannelError).kind).toBe("unreachable");
    h.open(0, "late");
    await settle();
    expect(h.abandoned).toEqual(["late"]);
    expect(h.confirmCount()).toBe(0);
  });

  test("an open BEFORE the deadline cancels it: the winner's handshake has no deadline", async () => {
    // The property F3 needs: `device/pair` may wait on a human for minutes, so
    // the deadline must not survive the race being decided.
    const clock = manualTimer();
    const h = harness();
    const answering = firstAnswering([A], h.steps, memory(), {
      timer: clock.timer,
      openDeadlineMs: 15_000,
    });
    await settle();
    h.open(0, "raw-A");
    await settle();
    expect(clock.armed()).toBe(0); // the deadline timer was cancelled
    h.confirm(0, "answer-A");
    await expect(answering).resolves.toBe("answer-A");
  });

  test("no deadline by default (a link's own dial deadline covers the caller)", async () => {
    const clock = manualTimer();
    const h = harness();
    void firstAnswering([A, B], h.steps, memory(), { timer: clock.timer });
    await settle();
    // Only the stagger is armed — a 15 s entry here would be a second deadline.
    expect(clock.delays().filter((ms) => ms !== STAGGER_MS)).toEqual([]);
  });
});
