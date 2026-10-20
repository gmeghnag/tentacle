import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { DomainErrorCode } from "@tentacle/transport";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { ARGS, parseArgs, parseDuration, parseServeLimits } from "../src/flags.ts";
import { startDaemon, sweepIntervalFor } from "../src/serve.ts";

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

describe("sweepIntervalFor (the reaper's period)", () => {
  test("60 s by default; follows a shorter TTL or cap; never under 1 s", () => {
    // Mutations: drop the floor → 1; drop the cap term → 60_000 on the cap row.
    expect(sweepIntervalFor(24 * 60 * 60 * 1000)).toBe(60_000);
    expect(sweepIntervalFor(5000)).toBe(5000);
    expect(sweepIntervalFor(24 * 60 * 60 * 1000, 3000)).toBe(3000);
    expect(sweepIntervalFor(1)).toBe(1000);
    expect(sweepIntervalFor(24 * 60 * 60 * 1000, 1)).toBe(1000);
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
    for (const key of ["TENTACLE_CONFIG_DIR", "TENTACLE_CWD"]) saved[key] = process.env[key];
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
    process.env.TENTACLE_CWD = dir;
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
