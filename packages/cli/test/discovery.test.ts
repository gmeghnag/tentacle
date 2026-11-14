/**
 * Sibling discovery on the `serve` side (docs/feat/sibling-discovery.md):
 * `buildDiscovery` (pure: records + interfaces + self → the snapshot's daemons),
 * `nextMembership` (pure hysteresis) and `startDiscovery` (the driver: one
 * heartbeat and one poller per PROCESS).
 *
 * The properties, each with the mutation that would fake it:
 * - a stop is not a flicker: a sibling missing from one poll is kept until a
 *   second one misses it (mutation: drop on the first miss → the test fails);
 * - a DEAD pid is definitive and drops at once (mutation: apply hysteresis to
 *   a dead pid → it would linger one poll);
 * - the poller runs only while somebody is subscribed, the heartbeat always
 *   (mutation: tie the heartbeat to subscribers → a daemon with no client stops
 *   looking alive to its siblings);
 * - the host-sleep rule: a poll gap past `staleAfterMs` skips freshness for
 *   that one poll (mutation: always apply it → every sibling vanishes on wake).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonRecord, writeDaemonRecord } from "@tentacle/daemon";
import type { DaemonDiscovery, DiscoveredDaemon } from "@tentacle/protocol";
import {
  type DiscoveryTimers,
  buildDiscovery,
  nextMembership,
  startDiscovery,
} from "../src/discovery.ts";
import type { InterfaceEntry } from "../src/pair-addresses.ts";

const interfaces = (): readonly InterfaceEntry[] => [
  { address: "192.168.1.5", family: "IPv4", internal: false },
  { address: "127.0.0.1", family: "IPv4", internal: true },
];

const record = (over: Partial<DaemonRecord> = {}): DaemonRecord => ({
  pid: 100,
  host: "0.0.0.0",
  port: 4001,
  tls: false,
  cwd: "/work/a",
  startedAt: 10,
  ...over,
});

describe("buildDiscovery (pure)", () => {
  test("self is first and present even with an empty dir (F16), and its file is not duplicated", () => {
    const self = record({ pid: process.pid, cwd: "/work/self", port: 4100 });
    const built = buildDiscovery({
      self,
      records: [],
      interfaces: interfaces(),
    });
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ cwd: "/work/self", self: true });
    // Its OWN record (a failed write would leave none) must not appear twice.
    const withOwn = buildDiscovery({
      self,
      records: [self],
      interfaces: interfaces(),
    });
    expect(withOwn).toHaveLength(1);
  });

  test("a wildcard bind expands to the machine's reachable IPv4 addresses", () => {
    const built = buildDiscovery({
      self: record({ pid: process.pid, host: "0.0.0.0", port: 4100 }),
      records: [record({ host: "0.0.0.0", port: 4001, cwd: "/work/b" })],
      interfaces: interfaces(),
    });
    expect(built[1]?.addresses).toEqual(["ws://192.168.1.5:4001/e2e"]);
  });

  test("`tls` makes them `wss`", () => {
    const built = buildDiscovery({
      self: record({ pid: process.pid }),
      records: [record({ host: "0.0.0.0", tls: true, cwd: "/work/b" })],
      interfaces: interfaces(),
    });
    expect(built[1]?.addresses).toEqual(["wss://192.168.1.5:4001/e2e"]);
  });

  test("a LOOPBACK-only sibling is listed with NO addresses (owner Q4), never hidden", () => {
    const built = buildDiscovery({
      self: record({ pid: process.pid }),
      records: [record({ host: "127.0.0.1", port: 4002, cwd: "/work/b" })],
      interfaces: interfaces(),
    });
    expect(built[1]).toMatchObject({ cwd: "/work/b", addresses: [] });
  });

  test("the record's own `addresses` (--address) are appended and deduped", () => {
    const built = buildDiscovery({
      self: record({ pid: process.pid }),
      records: [
        record({
          host: "0.0.0.0",
          cwd: "/work/b",
          addresses: ["ws://192.168.1.5:4001/e2e", "wss://mac.tailnet.ts.net/e2e"],
        }),
      ],
      interfaces: interfaces(),
    });
    // The interface address comes first (it is the same URL), then the tailnet.
    expect(built[1]?.addresses).toEqual([
      "ws://192.168.1.5:4001/e2e",
      "wss://mac.tailnet.ts.net/e2e",
    ]);
  });

  test("a sibling's relay address is announced LAST, behind every direct one", () => {
    // The announcement must carry the same dial order the QR does (docs/feat/
    // mobile-relay.md Design §5), and a sibling record can list its relay
    // address BEFORE a direct one (`serve --address <relay> --address <tailnet>`,
    // or a hand-edited record — a record is input). Mutation: `recordAddressList`
    // returning `unique(list)` → the relay lands second and the phone dials it
    // before the tailnet name beside it.
    const built = buildDiscovery({
      self: record({ pid: process.pid }),
      records: [
        record({
          host: "0.0.0.0",
          cwd: "/work/b",
          addresses: [
            "wss://relay.tentacle.so/d/AbCdEfGhIjKlMnOpQrStUv/e2e",
            "wss://mac.tailnet.ts.net/e2e",
          ],
        }),
      ],
      interfaces: interfaces(),
    });
    expect(built[1]?.addresses).toEqual([
      "ws://192.168.1.5:4001/e2e",
      "wss://mac.tailnet.ts.net/e2e",
      "wss://relay.tentacle.so/d/AbCdEfGhIjKlMnOpQrStUv/e2e",
    ]);
  });

  test("the cap keeps the FIRST addresses (the daemon's own order is the dial order)", () => {
    const extra = Array.from({ length: 12 }, (_, i) => `wss://h${i}.ts.net/e2e`);
    const built = buildDiscovery({
      self: record({ pid: process.pid }),
      records: [record({ addresses: extra, cwd: "/work/b" })],
      interfaces: interfaces(),
    });
    expect(built[1]?.addresses.length).toBe(8);
    expect(built[1]?.addresses[1]).toBe(extra[0] ?? "");
  });

  test("`buildDiscovery` is pure: it keeps whatever records it is handed", () => {
    // Freshness is the READER's job (F1/F2 test in device-store); nothing here
    // looks at a clock, so this cannot drift into a time-dependent test.
    const built = buildDiscovery({
      self: record({ pid: process.pid }),
      records: [record({ startedAt: 0, cwd: "/work/b" })],
      interfaces: interfaces(),
    });
    expect(built).toHaveLength(2);
  });
});

describe("nextMembership (pure hysteresis)", () => {
  const member = (cwd: string, pid: number): DiscoveredDaemon => ({
    cwd,
    addresses: [],
    startedAt: pid,
  });
  const seen = (...pids: number[]): DiscoveredDaemon[] =>
    pids.map((pid) => member(`/work/${pid}`, pid));

  test("a sibling missing once is kept (a slow heartbeat is not a flicker)", () => {
    const first = nextMembership(undefined, seen(1, 2), new Set());
    expect(first.members.map((d) => d.cwd)).toEqual(["/work/1", "/work/2"]);
    const second = nextMembership(first.state, seen(1), new Set());
    expect(second.members.map((d) => d.cwd)).toEqual(["/work/1", "/work/2"]);
  });

  test("missing twice in a row is dropped", () => {
    let step = nextMembership(undefined, seen(1, 2), new Set());
    step = nextMembership(step.state, seen(1), new Set());
    step = nextMembership(step.state, seen(1), new Set());
    expect(step.members.map((d) => d.cwd)).toEqual(["/work/1"]);
  });

  test("a DEAD pid drops at once, whatever its miss count (F1: definitive)", () => {
    const step = nextMembership(undefined, seen(1, 2), new Set());
    const after = nextMembership(step.state, seen(1), new Set(["/work/2"]));
    expect(after.members.map((d) => d.cwd)).toEqual(["/work/1"]);
  });

  test("a returning sibling resets its miss count", () => {
    let step = nextMembership(undefined, seen(1, 2), new Set());
    step = nextMembership(step.state, seen(1), new Set());
    step = nextMembership(step.state, seen(1, 2), new Set());
    step = nextMembership(step.state, seen(1), new Set());
    // Still here: one miss after a return is not two in a row.
    expect(step.members.map((d) => d.cwd)).toEqual(["/work/1", "/work/2"]);
  });
});

// --- the driver ------------------------------------------------------------

/** Fake timers: nothing runs until the test says so. */
function fakeTimers() {
  let now = 0;
  const pending: Array<{ at: number; run: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const timers: DiscoveryTimers = {
    setInterval: (fn, ms) => {
      const id = nextId++;
      const arm = (): void => {
        pending.push({
          at: now + ms,
          ms,
          id,
          run: () => {
            arm();
            fn();
          },
        });
      };
      arm();
      return id;
    },
    clearInterval: (handle) => {
      const i = pending.findIndex((e) => e.id === handle);
      if (i >= 0) pending.splice(i, 1);
    },
    now: () => now,
  };
  return {
    timers,
    /**
     * Move the clock WITHOUT running timers, as a suspended host does: nothing
     * fires while the machine sleeps, and on wake an interval fires ONCE (its
     * missed ticks are not replayed — Node does not replay them either), so
     * every pending timer is rebased to `now + its period`.
     */
    jump(ms: number) {
      now += ms;
      for (const entry of pending) {
        entry.at = now + entry.ms;
      }
    },
    /** Advance the clock by `ms`, running everything due (in order, once each). */
    advance(ms: number) {
      const target = now + ms;
      for (let guard = 0; guard < 1000; guard++) {
        const next = pending
          .filter((e) => e.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        now = next.at;
        pending.splice(pending.indexOf(next), 1);
        next.run();
      }
      now = target;
    },
  };
}

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "cli-discovery-"));
  mkdirSync(join(dir, "daemons"), { recursive: true });
  return dir;
};

describe("startDiscovery (driver)", () => {
  test("one synchronous build at the first subscriber, so `current()` has self at once", () => {
    const configDir = scratch();
    const clock = fakeTimers();
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
    });
    try {
      expect(driver.current().daemons[0]).toMatchObject({ cwd: "/work/self", self: true });
      expect(driver.current().rev).toBe(0);
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("the DEFAULT interfaces are this machine's, so a `0.0.0.0` serve announces an address", () => {
    // `serve` passes NO `interfaces`, so the default is what a user gets: a
    // `--host 0.0.0.0` daemon — the very setup REACHABLE_HINT recommends, and
    // the one `pair`'s QR expands — must announce its LAN address. Mutation:
    // default to `[]` → `addresses: []` for self and every sibling, so a DHCP
    // or Wi-Fi change is never announced (decision 3, F6).
    const v4 = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry?.address ?? "");
    if (v4.length === 0) {
      return; // a machine with no LAN address has nothing to expand
    }
    const configDir = scratch();
    const clock = fakeTimers();
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, host: "0.0.0.0", cwd: "/work/self", port: 4100 }),
      timers: clock.timers,
      now: () => clock.timers.now(),
    });
    try {
      driver.subscribe(() => {});
      const addresses = driver.current().daemons[0]?.addresses ?? [];
      expect(addresses.length).toBeGreaterThan(0);
      expect(addresses.some((address) => v4.some((ip) => address.includes(ip)))).toBe(true);
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("the first subscriber after an idle spell still applies freshness (Repro 3: no phantom)", () => {
    // A record whose pid IS alive (a reused pid: launchd's 1, or any stranger)
    // but whose heartbeat stopped with the `serve` that wrote it — its mtime is
    // an hour old, which is the ONLY signal that tells it from a live sibling
    // (F2). The poller runs only while somebody is subscribed, so this daemon
    // sat idle for a minute first; measuring the wake gap from the last POLL
    // would switch freshness off for exactly that first poll.
    const configDir = scratch();
    const clock = fakeTimers();
    writeDaemonRecord(configDir, record({ pid: 999_006, host: "127.0.0.1", cwd: "/work/phantom" }));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(configDir, "daemons", "999006.json"), old, old);
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
      alive: () => true,
      touch: () => true,
    });
    try {
      clock.advance(60_000);
      // Nobody was looking: only the heartbeat ran.
      expect(driver.polls()).toBe(0);
      driver.subscribe(() => {});
      // The heartbeat kept the wake gap honest, so freshness applies here.
      expect(driver.current().daemons.map((d) => d.cwd)).toEqual(["/work/self"]);
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a daemon that SLEPT with no subscriber still skips freshness on the waking poll (F3)", () => {
    // The poller was off across the sleep, so its own gap cannot say the host
    // slept — but the HEARTBEAT's can: on wake its missed tick fires once,
    // far later than its period. Without that signal the first poll after wake
    // would apply freshness to records whose own heartbeats also just slept,
    // so every sibling would flicker off until its beat landed (F3).
    const configDir = scratch();
    const clock = fakeTimers();
    writeDaemonRecord(configDir, record({ pid: 999_007, host: "127.0.0.1", cwd: "/work/slow" }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(configDir, "daemons", "999007.json"), old, old);
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
      alive: () => true,
      touch: () => true,
    });
    try {
      // Asleep: the clock moves, nothing fires, and on wake the heartbeat's
      // missed tick runs ONCE (rebased, not replayed — Node's behaviour too).
      clock.jump(120_000);
      clock.advance(10_000);
      // Only now does the phone connect.
      driver.subscribe(() => {});
      // The waking poll kept the sibling: its record is old because the host
      // slept, not because its daemon died.
      expect(driver.current().daemons.map((d) => d.cwd)).toContain("/work/slow");
      // A poll with an ordinary gap applies freshness again, so the sibling is
      // no longer SEEN — kept one more by the hysteresis, gone after that.
      clock.advance(2000);
      expect(driver.current().daemons.map((d) => d.cwd)).toContain("/work/slow");
      clock.advance(2000);
      expect(driver.current().daemons.map((d) => d.cwd)).not.toContain("/work/slow");
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a sleep long past EXPIRES, so a later subscriber still applies freshness (Repro D)", () => {
    // The normal laptop case: the lid is closed overnight with NO client (so
    // nothing polls), then the machine is awake for an hour with on-time beats
    // — every sibling's record is fresh again by then — and only then does a
    // phone subscribe. A `slept` FLAG would survive all of that (only a poll
    // could clear it, and there was none), switching freshness off for that
    // first poll and re-admitting the pid-reuse phantom (Repro 3, F2).
    // Mutation: `slept` as a flag, or `sleptAt` never expiring → it fails.
    const configDir = scratch();
    const clock = fakeTimers();
    writeDaemonRecord(configDir, record({ pid: 999_008, host: "127.0.0.1", cwd: "/work/phantom" }));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(configDir, "daemons", "999008.json"), old, old);
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
      alive: () => true,
      touch: () => true,
    });
    try {
      // Overnight with no subscriber: the heartbeat's missed tick runs once on
      // wake (rebased, not replayed) and records when the missed beat happened.
      clock.jump(8 * 3_600_000);
      clock.advance(10_000);
      expect(driver.polls()).toBe(0);
      // An hour awake, still no client: on-time beats only, no poll to clear it.
      clock.advance(3_600_000);
      expect(driver.polls()).toBe(0);
      driver.subscribe(() => {});
      // The sleep is long past, so freshness applies and the phantom is gone.
      expect(driver.current().daemons.map((d) => d.cwd)).toEqual(["/work/self"]);
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("the poller runs only while subscribed; the heartbeat always (owner Q5)", () => {
    const configDir = scratch();
    const clock = fakeTimers();
    let touches = 0;
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
      touch: () => {
        touches++;
        return true;
      },
    });
    try {
      const before = driver.polls();
      clock.advance(10_000);
      // Nobody subscribed: the heartbeat ran, the poll did not.
      expect(touches).toBe(1);
      expect(driver.polls()).toBe(before);
      const seen: DaemonDiscovery[] = [];
      const unsubscribe = driver.subscribe((d) => seen.push(d));
      expect(driver.polls()).toBe(before + 1);
      // The poll interval was armed at t=10000, so its first tick is t=12000
      // (the heartbeat is due at t=20000, so it has not run a second time).
      clock.advance(2000);
      expect(driver.polls()).toBe(before + 2);
      expect(touches).toBe(1);
      unsubscribe();
      const afterUnsub = driver.polls();
      clock.advance(10_000);
      // t=22000: the heartbeat ran at 20000, and the poller did NOT.
      expect(driver.polls()).toBe(afterUnsub);
      expect(touches).toBe(2);
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a new sibling appears and `rev` increments ONLY on change", () => {
    const configDir = scratch();
    const clock = fakeTimers();
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
      alive: () => true,
      touch: () => true,
    });
    try {
      const seen: DaemonDiscovery[] = [];
      driver.subscribe((d) => seen.push(d));
      const start = driver.current().rev;
      // A quiet poll: no change, no notification, no rev move.
      clock.advance(2000);
      expect(driver.current().rev).toBe(start);
      expect(seen).toHaveLength(0);
      writeDaemonRecord(configDir, record({ pid: 999_001, cwd: "/work/b", port: 4002 }));
      clock.advance(2000);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.rev).toBe(start + 1);
      expect(seen[0]?.daemons.map((d) => d.cwd)).toEqual(["/work/self", "/work/b"]);
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a poll error keeps the last snapshot and logs once per distinct message (F15)", () => {
    const configDir = scratch();
    const clock = fakeTimers();
    const logged: string[] = [];
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
      touch: () => true,
      readRecords: () => {
        throw new Error("EACCES: permission denied");
      },
      log: (line) => logged.push(line),
    });
    try {
      const before = driver.current();
      const seen: DaemonDiscovery[] = [];
      driver.subscribe((d) => seen.push(d));
      clock.advance(2000);
      clock.advance(2000);
      // The sibling list did not vanish on a transient error.
      expect(driver.current().daemons.map((d) => d.cwd)).toEqual(before.daemons.map((d) => d.cwd));
      expect(seen).toHaveLength(0);
      expect(logged).toHaveLength(1);
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("after a suspend, freshness is skipped for the waking poll (F3: no flicker)", () => {
    const configDir = scratch();
    const clock = fakeTimers();
    writeDaemonRecord(configDir, record({ pid: 999_002, cwd: "/work/b" }));
    // Its mtime is old, but the RECORD lives on the fake clock: the driver's
    // own gap check is what this test drives, so a record is aged for real.
    const path = join(configDir, "daemons", "999002.json");
    const old = new Date(Date.now() - 120_000);
    utimesSync(path, old, old);
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
      alive: () => true,
      touch: () => true,
    });
    try {
      driver.subscribe(() => {});
      // The subscribing poll has a normal gap, so freshness applies and the
      // already-old record is correctly ignored at t=2000.
      clock.advance(2000);
      expect(driver.current().daemons.map((d) => d.cwd)).not.toContain("/work/b");
      // Now the host sleeps: the clock moves but no timer fires, so the waking
      // tick's own gap exceeds `staleAfterMs` and freshness is SKIPPED — the
      // sibling comes back instead of flickering off (mutation: always apply
      // freshness → it never comes back and the app flickers on every wake).
      clock.jump(120_000);
      clock.advance(2000);
      expect(driver.current().daemons.map((d) => d.cwd)).toContain("/work/b");
      // A normal gap after that: freshness applies again, so the stale sibling
      // is no longer SEEN — but the hysteresis keeps it for its second miss
      // (a slow heartbeat is not a flicker), so it goes one poll later.
      clock.advance(2000);
      expect(driver.current().daemons.map((d) => d.cwd)).toContain("/work/b");
      clock.advance(2000);
      expect(driver.current().daemons.map((d) => d.cwd)).not.toContain("/work/b");
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("the sweep removes a dead pid's record and never a live-but-stale one (F1/F2)", () => {
    const configDir = scratch();
    const clock = fakeTimers();
    writeDaemonRecord(configDir, record({ pid: 999_003, cwd: "/work/dead" }));
    writeDaemonRecord(configDir, record({ pid: 999_004, cwd: "/work/slow", port: 4003 }));
    const slowPath = join(configDir, "daemons", "999004.json");
    const old = new Date(Date.now() - 120_000);
    utimesSync(slowPath, old, old);
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid, cwd: "/work/self" }),
      interfaces,
      timers: clock.timers,
      now: () => Date.now(),
      // Only 999004 is alive; the fake clock's pid is not.
      alive: (pid) => pid === 999_004,
      touch: () => true,
    });
    try {
      driver.subscribe(() => {});
      clock.advance(2000);
      const names = readdirSync(join(configDir, "daemons")).sort();
      expect(names).toContain("999004.json");
      expect(names).not.toContain("999003.json");
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("log noise", () => {
  test("a failed touch is one log line, never fatal (F4)", () => {
    const configDir = scratch();
    const clock = fakeTimers();
    const logged: string[] = [];
    const driver = startDiscovery({
      configDir,
      self: record({ pid: process.pid }),
      interfaces,
      timers: clock.timers,
      now: () => clock.timers.now(),
      touch: () => false,
      log: (line) => logged.push(line),
    });
    try {
      clock.advance(10_000);
      clock.advance(10_000);
      expect(logged).toHaveLength(1);
    } finally {
      driver.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("a record planted by a same-uid process", () => {
  test("its addresses are hints only: a bogus URL is dropped before the wire", () => {
    const configDir = scratch();
    // Written by hand, not through `writeDaemonRecord` (which validates).
    writeFileSync(
      join(configDir, "daemons", "999005.json"),
      JSON.stringify({
        v: 1,
        pid: 999_005,
        host: "0.0.0.0",
        port: 4004,
        tls: false,
        cwd: "/work/forged",
        startedAt: 5,
        addresses: ["http://evil.example/e2e", "ws://192.168.1.5:4004/e2e"],
      }),
    );
    const built = buildDiscovery({
      self: record({ pid: process.pid }),
      records: [
        record({
          pid: 999_005,
          cwd: "/work/forged",
          port: 4004,
          addresses: ["http://evil.example/e2e", "ws://192.168.1.5:4004/e2e"],
        }),
      ],
      interfaces: interfaces(),
    });
    expect(built[1]?.addresses).toEqual([
      // The interface address first (from the wildcard bind), then the record's
      // own unreachable-by-bind one... deduped to ONE because both are the same
      // URL: the forged `http` one never reaches the wire.
      "ws://192.168.1.5:4004/e2e",
    ]);
    rmSync(configDir, { recursive: true, force: true });
  });
});
