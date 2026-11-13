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

  test("every dial waiting on one hold is released by a single resume", async () => {
    const h = harness();
    h.gate.suspend();
    const both = Promise.all([h.gate.dial(), h.gate.dial()]);
    await flush();
    expect(h.count()).toBe(0);
    h.gate.resume();
    await flush();
    expect(h.count()).toBe(2);
    h.open(0);
    h.open(1);
    await both;
  });
});
