import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { DomainErrorCode } from "@tentacle/transport";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { ARGS, parseArgs, parseDuration, parseServeLimits } from "../src/flags.ts";
import { startDaemon } from "../src/serve.ts";

describe("parseDuration", () => {
  test("whole positive amount + ms|s|m|h", () => {
    expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("90m")).toBe(90 * 60 * 1000);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("1500ms")).toBe(1500);
  });

  test("rejects zero, negative, unknown units, fractions, bare numbers, empty", () => {
    for (const bad of ["0s", "0", "-1h", "1d", "1.5h", "abc", "", "60", "h"]) {
      expect(() => parseDuration(bad)).toThrow(/invalid duration/);
    }
  });
});

describe("parseServeLimits (serve flags)", () => {
  const limits = (args: string[]) => {
    const parsed = parseArgs(args, ARGS.serve);
    if (!parsed.ok) throw new Error(parsed.error);
    return parseServeLimits(parsed);
  };

  test("nothing given → nothing set (startDaemon applies the defaults)", () => {
    expect(limits([])).toEqual({});
  });

  test("every flag parsed", () => {
    expect(
      limits([
        "--session-ttl",
        "2h",
        "--session-admin-cap=7h",
        "--max-sessions",
        "10",
        "--max-detached-sessions",
        "3",
        "--ws-idle-timeout",
        "2m",
      ]),
    ).toEqual({
      sessionTtlMs: 2 * 60 * 60 * 1000,
      adminCapMs: 7 * 60 * 60 * 1000,
      maxSessions: 10,
      maxDetachedSessions: 3,
      wsIdleTimeoutSec: 120,
    });
  });

  test("--session-ttl never → null (no idle expiry); other words are still invalid", () => {
    // Mutation: `never` mapped to the default TTL (or `undefined`) → not `null`.
    expect(limits(["--session-ttl", "never"])).toEqual({ sessionTtlMs: null });
    expect(limits(["--session-ttl=never", "--session-admin-cap", "7h"])).toEqual({
      sessionTtlMs: null,
      adminCapMs: 7 * 60 * 60 * 1000,
    });
    for (const bad of ["nver", "Never", "0s", "forever"]) {
      expect(() => limits(["--session-ttl", bad])).toThrow(/--session-ttl: invalid duration/);
    }
    // `never` is the TTL's alone: the cap and the other durations do not take it.
    expect(() => limits(["--session-admin-cap", "never"])).toThrow(/--session-admin-cap/);
    expect(() => limits(["--ws-idle-timeout", "never"])).toThrow(/--ws-idle-timeout/);
    expect(() => limits(["--session-ttl"])).toThrow(/needs a value/);
  });

  test("invalid values fail loudly, naming the flag", () => {
    expect(() => limits(["--session-ttl", "0s"])).toThrow(/--session-ttl/);
    expect(() => limits(["--max-sessions", "0"])).toThrow(/--max-sessions/);
    expect(() => limits(["--max-detached-sessions", "2.5"])).toThrow(/--max-detached-sessions/);
    expect(() => limits(["--ws-idle-timeout", "1500ms"])).toThrow(/whole seconds/);
    expect(() => limits(["--ws-idle-timeout", "961s"])).toThrow(/at most 960s/);
    // A flag with no value: an error (from the strict parser), never a silent default.
    expect(() => limits(["--session-ttl"])).toThrow(/needs a value/);
    expect(() => limits(["--max-sessions", "--port", "1"])).toThrow(/needs a value/);
  });
});

describe("startDaemon bounds sessions (end to end over a real socket)", () => {
  let dir: string;
  let config: TentacleConfig;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "serve-limits-"));
    for (const key of ["TENTACLE_CONFIG_DIR"]) saved[key] = process.env[key];
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
    config = await loadConfig({ cwd: dir });
  });

  // `serve` persists its sessions now: each test starts from an empty store.
  afterEach(async () => {
    await rm(join(dir, "config", "daemon"), { recursive: true, force: true });
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** A raw JSON-RPC client over the daemon's WebSocket. */
  async function client(url: string) {
    const ws = new WebSocket(url);
    const replies = new Map<
      number,
      { result?: unknown; error?: { code: number; data?: unknown } }
    >();
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    };
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    let id = 0;
    const request = async (method: string, params: unknown) => {
      const n = ++id;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      await until(() => replies.has(n));
      return replies.get(n);
    };
    await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    return { ws, request };
  }
  async function until(cond: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  test("the reaper runs: a detached session is closed after the TTL and audited", async () => {
    // Mutation: drop `startReaper` from `startDaemon` → never audited.
    // Mutation: sweep at the 60 s default regardless of the TTL → not within 3 s.
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: 200, // no sweepIntervalMs: derived from the TTL
      onAudit: (line) => audit.push(line),
    });
    try {
      const a = await client(server.url);
      const opened = (await a.request("session/open", { create: true }))?.result as {
        sessionId: string;
      };
      await new Promise((r) => setTimeout(r, 400));
      expect(audit.some((l) => l.startsWith("session-reaped"))).toBe(false); // attached
      a.ws.close();
      await until(() => audit.includes(`session-reaped ${opened.sessionId} idle_ttl`));
      const b = await client(server.url);
      const reopen = await b.request("session/open", { sessionId: opened.sessionId });
      expect(reopen?.error?.code).toBe(DomainErrorCode.UnknownSession);
      b.ws.close();
    } finally {
      await server.stop();
    }
  });

  test("the sweep follows a short admin cap (derived period), closing a busy-or-not detached session", async () => {
    // Mutation: leave `adminCapMs` out of the derived sweep → 60 s period → not within 3 s.
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      adminCapMs: 200, // TTL stays 24 h: only the cap can close it
      onAudit: (line) => audit.push(line),
    });
    try {
      const a = await client(server.url);
      const opened = (await a.request("session/open", { create: true }))?.result as {
        sessionId: string;
      };
      a.ws.close();
      await until(() => audit.includes(`session-reaped ${opened.sessionId} admin_cap`));
    } finally {
      await server.stop();
    }
  });

  /** Open a session, detach it (close the socket), return its id. */
  async function detachedSession(url: string): Promise<string> {
    const a = await client(url);
    const opened = (await a.request("session/open", { create: true }))?.result as {
      sessionId: string;
    };
    a.ws.close();
    return opened.sessionId;
  }

  test("--session-ttl never keeps an idle detached session; daemon/session_ttl re-arms the reaper at once", async () => {
    // Mutation: `set` updates the policy but does not re-arm → the old interval
    //   keeps the old (never) policy and nothing is ever reaped.
    // Mutation: `expiry` treats null as 0 → reaped before the change.
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: null,
      sweepIntervalMs: 20,
      onAudit: (line) => audit.push(line),
    });
    try {
      const id = await detachedSession(server.url);
      await new Promise((r) => setTimeout(r, 300)); // many sweeps
      expect(audit.filter((l) => l.startsWith("session-reaped"))).toEqual([]);
      const b = await client(server.url);
      expect((await b.request("daemon/session_ttl", {}))?.result).toEqual({
        idleTtlMs: "never",
        persisted: false,
      });
      expect((await b.request("daemon/session_ttl", { idleTtlMs: 100 }))?.result).toEqual({
        idleTtlMs: 100,
        persisted: false,
      });
      await until(() => audit.includes(`session-reaped ${id} idle_ttl`));
      expect(audit).toContain("session-ttl never -> 100ms");
      b.ws.close();
    } finally {
      await server.stop();
    }
  });

  test("never with no cap runs no interval; a change to a duration starts one (derived period)", async () => {
    // Mutation: `arm` never starts a reaper when it was off (guard on the first arm only) → not reaped.
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: null, // no sweepIntervalMs: derived → no interval at all
      onAudit: (line) => audit.push(line),
    });
    try {
      const id = await detachedSession(server.url);
      const b = await client(server.url);
      // 1 ms: the derived period is the 1 s floor.
      await b.request("daemon/session_ttl", { idleTtlMs: 1 });
      await until(() => audit.includes(`session-reaped ${id} idle_ttl`), 4000);
      // And back to never: the interval is cleared (nothing left to reap anyway).
      expect((await b.request("daemon/session_ttl", { idleTtlMs: "never" }))?.result).toEqual({
        idleTtlMs: "never",
        persisted: false,
      });
      expect(audit).toContain("session-ttl 1ms -> never");
      b.ws.close();
    } finally {
      await server.stop();
    }
  });

  test("an invalid daemon/session_ttl is InvalidParams, audits nothing and changes nothing", async () => {
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: 5000,
      onAudit: (line) => audit.push(line),
    });
    try {
      const b = await client(server.url);
      for (const bad of [0, -5, 1.5, "1h"]) {
        expect((await b.request("daemon/session_ttl", { idleTtlMs: bad }))?.error?.code).toBe(
          -32602,
        );
      }
      expect((await b.request("daemon/session_ttl", {}))?.result).toEqual({
        idleTtlMs: 5000,
        persisted: false,
      });
      expect(audit.filter((l) => l.startsWith("session-ttl"))).toEqual([]);
      b.ws.close();
    } finally {
      await server.stop();
    }
  });

  test("stop() after a change stops the CURRENT reaper, not the first one", async () => {
    // Mutation: `stop` clears the interval armed at start only → the re-armed one reaps after stop.
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: null,
      sweepIntervalMs: 20,
      onAudit: (line) => audit.push(line),
    });
    await detachedSession(server.url);
    const b = await client(server.url);
    await b.request("daemon/session_ttl", { idleTtlMs: 300 });
    await server.stop();
    await new Promise((r) => setTimeout(r, 700)); // past the 300 ms TTL, many sweeps
    expect(audit.filter((l) => l.startsWith("session-reaped"))).toEqual([]);
  });

  test("repeated sets with the same period do not starve the sweep (the session is still reaped on time)", async () => {
    // Reviewer's repro: `never`, then a set every 400 ms (< the 1 s period).
    // Mutation: `set` restarts the timer unconditionally → the sweep never fires.
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: null,
      onAudit: (line) => audit.push(line),
    });
    try {
      const id = await detachedSession(server.url);
      const b = await client(server.url);
      const startedAt = Date.now();
      // TTL 100 ms → derived period is the 1 s floor; every set keeps it.
      while (Date.now() - startedAt < 3500 && !audit.some((l) => l.startsWith("session-reaped"))) {
        await b.request("daemon/session_ttl", { idleTtlMs: 100 });
        await new Promise((r) => setTimeout(r, 400));
      }
      expect(audit).toContain(`session-reaped ${id} idle_ttl`);
      expect(Date.now() - startedAt).toBeLessThan(3000);
      b.ws.close();
    } finally {
      await server.stop();
    }
  });

  test("repeated sets that CHANGE the period do not push the next sweep later than it was due", async () => {
    // Mutation: a period change restarts with a full fresh period (phase lost) → starved.
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: 1100, // period 1100 ms
      onAudit: (line) => audit.push(line),
    });
    try {
      const a = await client(server.url);
      const opened = (await a.request("session/open", { create: true }))?.result as {
        sessionId: string;
      };
      const b = await client(server.url);
      // `a` stays attached: not reaped yet. Detach, then alternate the period every 300 ms.
      a.ws.close();
      const startedAt = Date.now();
      let ttl = 1200;
      while (Date.now() - startedAt < 4000 && !audit.some((l) => l.startsWith("session-reaped"))) {
        await b.request("daemon/session_ttl", { idleTtlMs: ttl });
        ttl = ttl === 1200 ? 1300 : 1200; // periods 1200 / 1300
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(audit).toContain(`session-reaped ${opened.sessionId} idle_ttl`);
      expect(Date.now() - startedAt).toBeLessThan(3000);
      b.ws.close();
    } finally {
      await server.stop();
    }
  });

  test("two period changes before the replacement's first sweep: the sweep still runs when it was first due", async () => {
    // Reviewer's repro. TTL 1000 → a sweep is due at ~1000 ms. At 500 ms the period becomes
    // 5000, at 800 ms 4000. The sweep must still run at ~1000 ms, not ~4800.
    // Mutation: `due` recomputed from the last sweep/arm (`lastSweepAt + armedMs`) → ~4800 ms.
    const sweeps: number[] = [];
    const real = SessionHost.prototype.reapExpired;
    SessionHost.prototype.reapExpired = function (this: SessionHost, ...args) {
      sweeps.push(Date.now());
      return real.apply(this, args);
    };
    let server: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      server = await startDaemon(config, { host: "127.0.0.1", port: 0, sessionTtlMs: 1000 });
      const startedAt = Date.now();
      const b = await client(server.url);
      await new Promise((r) => setTimeout(r, 500 - (Date.now() - startedAt)));
      await b.request("daemon/session_ttl", { idleTtlMs: 5000 });
      await new Promise((r) => setTimeout(r, 800 - (Date.now() - startedAt)));
      await b.request("daemon/session_ttl", { idleTtlMs: 4000 });
      await until(() => sweeps.length > 0, 6000);
      const first = (sweeps[0] ?? Number.POSITIVE_INFINITY) - startedAt;
      expect(first).toBeGreaterThanOrEqual(900); // not earlier than the original due time
      expect(first).toBeLessThan(1800); // and nowhere near 4800
      b.ws.close();
    } finally {
      SessionHost.prototype.reapExpired = real;
      await server?.stop();
    }
  });

  test("a set that arrives while the daemon stops starts no new reaper", async () => {
    // Mutation: drop `stopped` (the guard in `arm`) → the set re-arms after stop and reaps.
    // The audit callback runs inside `set`, before its `arm()`: stopping there is "a set in flight at stop".
    const audit: string[] = [];
    const stopNow: { run?: () => void } = {};
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: null,
      onAudit: (line) => {
        audit.push(line);
        if (line.startsWith("session-ttl")) stopNow.run?.();
      },
    });
    stopNow.run = () => void server.stop();
    await detachedSession(server.url);
    const b = await client(server.url);
    b.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "daemon/session_ttl",
        params: { idleTtlMs: 1 },
      }),
    );
    await until(() => audit.some((l) => l.startsWith("session-ttl")));
    await new Promise((r) => setTimeout(r, 2500)); // > the 1 s floor period, twice
    expect(audit.filter((l) => l.startsWith("session-reaped"))).toEqual([]);
    await server.stop();
  });

  test("never with no cap starts no sweep timer at all; a duration starts exactly one; never again clears it", async () => {
    // Mutation: `arm` starts a reaper even when the period is null → one extra timer on boot.
    const created: number[] = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = realSet(fn, ms, ...rest);
      created.push(ms ?? 0);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
      cleared.push(handle);
      realClear(handle);
    }) as typeof clearInterval;
    const reaperTimers = (): number[] => created.filter((ms) => ms === 1000 || ms === 60_000);
    let server: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      server = await startDaemon(config, { host: "127.0.0.1", port: 0, sessionTtlMs: null });
      expect(reaperTimers()).toEqual([]); // no sweep timer on boot
      const b = await client(server.url);
      await b.request("daemon/session_ttl", { idleTtlMs: 1 }); // period = 1 s floor
      expect(reaperTimers()).toEqual([1000]);
      // The same period again: the running timer is kept (no stop, no start).
      // Mutation: `arm` restarts on every set → a clear here.
      const keptCleared = cleared.length;
      await b.request("daemon/session_ttl", { idleTtlMs: 2 });
      expect(cleared.length).toBe(keptCleared);
      expect(reaperTimers()).toEqual([1000]);
      const clearedBefore = cleared.length;
      await b.request("daemon/session_ttl", { idleTtlMs: "never" });
      expect(cleared.length).toBe(clearedBefore + 1); // the sweep timer is gone
      expect(reaperTimers()).toEqual([1000]); // and none was started
      b.ws.close();
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      await server?.stop();
    }
  });

  test("stop() stops the reaper too", async () => {
    // Mutation: `stop` only stops the server → the detached session is reaped later.
    const audit: string[] = [];
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: 100,
      sweepIntervalMs: 20,
      onAudit: (line) => audit.push(line),
    });
    const a = await client(server.url);
    await a.request("session/open", { create: true });
    await server.stop();
    await new Promise((r) => setTimeout(r, 400));
    expect(audit.filter((l) => l.startsWith("session-reaped"))).toEqual([]);
  });

  test("defaults applied: the 65th live session is refused (max 64)", async () => {
    // Mutation: drop the `?? DEFAULT_MAX_SESSIONS` → the 65th is created.
    const server = await startDaemon(config, { host: "127.0.0.1", port: 0 });
    try {
      const a = await client(server.url); // attached: the detached cap never applies
      for (let i = 0; i < 64; i++) {
        expect((await a.request("session/open", { create: true }))?.result).toBeDefined();
      }
      expect((await a.request("session/open", { create: true }))?.error).toMatchObject({
        code: DomainErrorCode.TooManySessions,
        data: { limit: "sessions", max: 64 },
      });
      a.ws.close();
    } finally {
      await server.stop();
    }
  });

  test("defaults applied: the 17th session is refused while 16 are detached", async () => {
    // Mutation: drop the `?? DEFAULT_MAX_DETACHED_SESSIONS` → the 17th is created.
    const server = await startDaemon(config, { host: "127.0.0.1", port: 0 });
    try {
      const a = await client(server.url);
      for (let i = 0; i < 16; i++) {
        expect((await a.request("session/open", { create: true }))?.result).toBeDefined();
      }
      a.ws.close();
      const b = await client(server.url);
      // The socket close reaches the server asynchronously: poll until A's 16
      // sessions count as detached (an early create is closed again at once).
      let refused: { code: number; data?: unknown } | undefined;
      const deadline = Date.now() + 3000;
      while (refused === undefined && Date.now() < deadline) {
        const reply = await b.request("session/open", { create: true });
        if (reply?.error) {
          refused = reply.error;
        } else {
          const { sessionId } = reply?.result as { sessionId: string };
          await b.request("session/close", { sessionId });
        }
      }
      expect(refused).toMatchObject({
        code: DomainErrorCode.TooManySessions,
        data: { limit: "detached", max: 16 },
      });
      b.ws.close();
    } finally {
      await server.stop();
    }
  });
});
