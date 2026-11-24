/**
 * fix/mobile-connect-latency T5 — `RemoteClient.redialNow()` (plan 2c), on a
 * REAL client over an in-process daemon with an injected manual clock: a link
 * that dropped and failed redials until a long backoff is armed dials AT ONCE
 * on `redialNow()` (no clock time passes), never twice while dialing, and
 * never after a terminal stop.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { type ModelProvider, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { ChannelError, type LinkStatus } from "../src/link-machine.ts";
import { type Clock, RemoteClient } from "../src/remote-client.ts";
import { tick, until } from "./support/fakes.ts";

const model: ModelProvider = {
  id: "m",
  async *stream() {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  },
};

function host(): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/reattach-resume",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env: {
          id: "e",
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          readFile: async () => "",
          writeFile: async () => {},
        },
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
}

/** `reattach.test.ts`'s manual clock: timers fire only on `advance`. */
function manualClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    advance(ms: number): void {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

/**
 * A client up for > 10 s whose link then drops; the factory fails `failures`
 * times (each failure advances the backoff to its `nextAtMs`), so the attempt
 * count climbs exactly as in the background (W4). Then the factory answers
 * (or, with `terminal`, rejects `unauthorized`).
 */
async function droppedClient(o: { readonly failures: number; readonly holdNext?: boolean }) {
  const daemon = host();
  const time = manualClock();
  const connect = (): DuplexChannel => {
    const [d, c] = createChannelPair();
    new Connection(d, daemon);
    return c;
  };
  const first = connect();
  let calls = 0;
  let failing = o.failures;
  let release: () => void = () => {};
  let terminal = false;
  const statuses: LinkStatus[] = [];
  const client = new RemoteClient(first, new PermissionBroker(), undefined, {
    channelFactory: async () => {
      calls += 1;
      if (terminal) throw new ChannelError("unauthorized", "revoked");
      if (failing > 0) {
        failing -= 1;
        throw new Error("offline");
      }
      if (o.holdNext === true) {
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return connect();
    },
    clock: time.clock,
    random: () => 0.999,
  });
  client.onLinkStatus((s) => statuses.push(s));
  await client.initialize();
  time.advance(11_000);
  first.close();
  await until(() => statuses.some((s) => s.state === "reconnecting"));
  // Fail through the backoff until attempt ≥ 4 (each ceiling doubles: ~8 s+).
  while (calls < o.failures) {
    const last = statuses.at(-1);
    const wait = last?.state === "reconnecting" ? Math.max(0, last.nextAtMs - time.clock.now()) : 0;
    time.advance(wait);
    await tick();
  }
  await tick();
  return {
    client,
    time,
    statuses,
    calls: () => calls,
    release: () => release(),
    revoke: () => {
      terminal = true;
    },
  };
}

describe("T5 RemoteClient.redialNow (fix/mobile-connect-latency 2c)", () => {
  test("after attempts piled up, redialNow dials with NO clock time passing and the link comes up (mutation: empty redialNow → red)", async () => {
    const c = await droppedClient({ failures: 4 });
    const last = c.statuses.at(-1);
    expect(last?.state).toBe("reconnecting");
    const waitMs = last?.state === "reconnecting" ? last.nextAtMs - c.time.clock.now() : 0;
    expect(waitMs).toBeGreaterThan(4000); // the backoff it would have waited
    const before = c.calls();
    c.client.redialNow();
    c.time.advance(0); // zero time passes
    expect(c.calls()).toBe(before + 1);
    // A return is a fresh start, not the N-th retry (W4).
    expect(c.statuses.at(-1)).toMatchObject({ state: "reconnecting", attempt: 0 });
    expect(await until(() => c.statuses.at(-1)?.state === "up")).toBe(true);
    // The superseded backoff timer is gone: running it out dials nothing more.
    c.time.advance(60_000);
    await tick();
    expect(c.calls()).toBe(before + 1);
    // Up: redialNow is a no-op.
    c.client.redialNow();
    c.time.advance(0);
    expect(c.calls()).toBe(before + 1);
    c.client.close();
  });

  test("while a dial is in flight a second redialNow dials nothing", async () => {
    const c = await droppedClient({ failures: 1, holdNext: true });
    const before = c.calls();
    c.client.redialNow();
    c.time.advance(0);
    expect(c.calls()).toBe(before + 1); // dialing, held
    c.client.redialNow();
    c.time.advance(0);
    await tick();
    expect(c.calls()).toBe(before + 1);
    c.release();
    expect(await until(() => c.statuses.at(-1)?.state === "up")).toBe(true);
    c.client.close();
  });

  test("after a terminal stop (revoked) redialNow never dials", async () => {
    const c = await droppedClient({ failures: 1 });
    c.revoke();
    c.client.redialNow();
    c.time.advance(0);
    expect(await until(() => c.statuses.at(-1)?.state === "stopped")).toBe(true);
    const before = c.calls();
    c.client.redialNow();
    c.time.advance(60_000);
    await tick();
    expect(c.calls()).toBe(before);
    c.client.close();
  });

  test("a closed client: redialNow is a no-op", async () => {
    const c = await droppedClient({ failures: 1 });
    c.client.close();
    const before = c.calls();
    c.client.redialNow();
    c.time.advance(60_000);
    await tick();
    expect(c.calls()).toBe(before);
  });
});
