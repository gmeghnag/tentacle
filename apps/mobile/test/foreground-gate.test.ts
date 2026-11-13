/**
 * The foreground gate (docs/feat/mobile-session-view.md 12a.4, plan T5's
 * transport half): dials wait while suspended, `resume` releases the one that
 * was waiting, and `suspend` twice is idempotent. A channel that arrives while
 * the app is leaving the foreground is closed, never handed out — otherwise the
 * gate would leave behind the very ghost attachment it exists to avoid.
 */
import { describe, expect, test } from "bun:test";
import type { DuplexChannel } from "@tentacle/transport";
import { createForegroundGate } from "../src/foreground-gate.ts";

/** A channel whose close is observable (nothing else is used here). */
function channel(name: string, closed: string[]): DuplexChannel {
  return {
    send: () => {},
    close: () => {
      closed.push(name);
    },
    setOnMessage: () => {},
    setOnClose: () => {},
  };
}

/** A factory whose dials the test controls: each call parks until `open(i)`. */
function harness() {
  const dials: ((c: DuplexChannel) => void)[] = [];
  const closed: string[] = [];
  const gate = createForegroundGate(
    () =>
      new Promise<DuplexChannel>((resolve) => {
        dials.push(resolve);
      }),
  );
  return {
    gate,
    closed,
    count: () => dials.length,
    open: (i: number) => dials[i]?.(channel(`c${i}`, closed)),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createForegroundGate", () => {
  test("a dial while suspended WAITS: nothing reaches the socket (mutation: resolve instead of hold → red)", async () => {
    const h = harness();
    h.gate.suspend();
    let settled = false;
    const dialling = h.gate.dial().then((c) => {
      settled = true;
      return c;
    });
    await flush();
    expect(settled).toBe(false);
    expect(h.count()).toBe(0); // the inner factory was never even called
    h.gate.resume();
    await flush();
    expect(h.count()).toBe(1); // released: now it dials
    h.open(0);
    await dialling;
    expect(h.closed).toEqual([]);
  });

  test("suspend closes the live channel (the client's drop) and is idempotent", async () => {
    const h = harness();
    const first = h.gate.dial();
    h.open(0);
    await first;
    h.gate.suspend();
    h.gate.suspend(); // iOS delivers `inactive` then `background`
    expect(h.closed).toEqual(["c0"]);
    expect(h.gate.isSuspended).toBe(true);
    h.gate.resume();
    h.gate.resume(); // and `active` twice
    expect(h.gate.isSuspended).toBe(false);
  });

  test("a channel that arrives while suspending is CLOSED, not handed out, and the dial waits", async () => {
    const h = harness();
    let resolved = false;
    const dialling = h.gate.dial().then((c) => {
      resolved = true;
      return c;
    });
    await flush();
    expect(h.count()).toBe(1); // in flight
    h.gate.suspend(); // the app backgrounds mid-dial
    h.open(0); // the inner dial answers now: too late
    await flush();
    expect(resolved).toBe(false);
    expect(h.closed).toEqual(["c0"]);
    h.gate.resume();
    await flush();
    expect(h.count()).toBe(2); // redialled, not the stale channel
    h.open(1);
    await dialling;
    expect(resolved).toBe(true);
    expect(h.closed).toEqual(["c0"]);
  });

  test("a resume dials ONCE for the newest caller: the dials the client abandoned never reach the socket (mutation: drop the supersession check → red)", async () => {
    const h = harness();
    h.gate.suspend();
    // The client's `dialChannel` gives up after LIVENESS_MS and dials again; the
    // abandoned attempt stays parked in the gate (`dialFailed` never sees it).
    const abandoned = h.gate.dial().then(
      () => "resolved",
      (error: unknown) => (error as Error).name,
    );
    const kept = h.gate.dial();
    await flush();
    expect(h.count()).toBe(0); // both held: neither reached the socket
    h.gate.resume();
    await flush();
    expect(h.count()).toBe(1); // one dial, not a burst of N
    expect(await abandoned).toBe("ChannelError"); // the abandoned one gave up, without dialling
    h.open(0);
    await kept;
    h.gate.suspend();
    // `current` is the channel the NEWEST caller received, so it is the one closed.
    expect(h.closed).toEqual(["c0"]);
  });

  test("a channel from an attempt the client abandoned is closed and never becomes `current` (mutation: drop the supersession check → the live socket is never closed)", async () => {
    const h = harness();
    const stale = h.gate.dial().then(
      () => "resolved",
      (error: unknown) => (error as Error).name,
    );
    await flush(); // dialling: `c0` connects LAST
    h.gate.suspend(); // the app backgrounds; the client will give this attempt up
    const live = h.gate.dial();
    h.gate.resume();
    await flush();
    expect(h.count()).toBe(2); // the newest dialled; the stale one is still in flight
    h.open(1); // the newest caller's socket connects first
    await live;
    h.open(0); // ...and the abandoned attempt's connects last, with the app foregrounded
    expect(await stale).toBe("ChannelError");
    h.gate.suspend();
    // The live socket (c1) is closed; the stale one was closed on arrival. Without
    // the guard, `current` would be c0 and c1 would stay up: the ghost attachment.
    expect(h.closed).toEqual(["c0", "c1"]);
  });
});
