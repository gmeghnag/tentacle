import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Agent } from "@tentacle/agent";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { SessionHost } from "@tentacle/daemon";
import {
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import {
  type NodeReadableLike,
  type NodeWritableLike,
  RpcPeer,
  streamChannel,
} from "@tentacle/transport";
import {
  type ProcOf,
  type ResidentHandle,
  acquireResidentLock,
  parseProcStat,
  residentCommand,
  residentGuard,
  residentSkewWarning,
  residentSocketPath,
  residentStateDir,
  residentStatus,
  residentStatusReport,
  residentStop,
  runBridge,
  selfCommand,
  serveResident,
} from "../src/pod-resident.ts";
import { APP_VERSION } from "../src/version.ts";

// The resident pod daemon + its bridge (docs/feat/detached-runs.md S1), on
// REAL unix sockets in a temp dir. Each test names its mutation (AGENTS §9).

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick(2);
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.reject(new Error("unused")),
  readFile: () => Promise.reject(new Error("unused")),
  writeFile: () => Promise.reject(new Error("unused")),
};

/** `n` text chunks, one per few ms, then done: a turn long enough to drop mid-way. */
function slowModel(n: number): ModelProvider {
  return {
    id: "slow",
    async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
      for (let i = 0; i < n; i++) {
        await tick(2);
        yield { type: "text", delta: `c${i} ` };
      }
      yield { type: "done" };
    },
  };
}

function podHost(n = 40, version?: string): SessionHost {
  return new SessionHost({
    defaultCwd: "/pod/work",
    ...(version !== undefined ? { identity: { tentacle: version, kind: "container" } } : {}),
    createAgent: () => ({
      agent: new Agent({ model: slowModel(n), tools: new ToolRegistry(), env: noopEnv }),
      permissions: new PermissionBroker(),
    }),
  });
}

let root: string;
let seq = 0;
/** A fresh state dir (short: a unix socket path is capped at ~104 bytes on macOS). */
const stateDir = (): string => join(root, `s${seq++}`);
const sockIn = (dir: string): string => join(dir, "r.sock");
const handles: ResidentHandle[] = [];
/** A process that is running, with this start time. */
const running =
  (start: string): ProcOf =>
  () => ({ state: "S", start });
async function resident(
  host: SessionHost,
  dir: string,
  extra: {
    servesModel?: boolean;
    idleExitMs?: number;
    sweepIntervalMs?: number;
    procOf?: ProcOf;
  } = {},
): Promise<ResidentHandle> {
  const handle = await serveResident(host, {
    stateDir: dir,
    socketPath: sockIn(dir),
    servesModel: extra.servesModel ?? false,
    log: () => {},
    ...(extra.procOf !== undefined ? { procOf: extra.procOf } : {}),
    ...(extra.idleExitMs !== undefined ? { idleExitMs: extra.idleExitMs } : {}),
    ...(extra.sweepIntervalMs !== undefined ? { sweepIntervalMs: extra.sweepIntervalMs } : {}),
  });
  handles.push(handle);
  return handle;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tres-"));
});
afterAll(async () => {
  for (const handle of handles) await handle.stop();
  await rm(root, { recursive: true, force: true });
});

/** A protocol client over a duplex byte stream pair (a socket, or a bridge's stdio). */
async function protocolClient(input: NodeReadableLike, output: NodeWritableLike) {
  const updates: KnownSessionUpdateParams[] = [];
  const peer = new RpcPeer(streamChannel(input, output), {
    onNotification: (method, params) => {
      if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
    },
  });
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  const open = (params: Record<string, unknown>) =>
    peer.request("session/open", params) as Promise<OpenResult>;
  const prompt = (sessionId: string, turnId: string) =>
    peer.request("session/prompt", { sessionId, turnId, content: [{ type: "text", text: "go" }] });
  return { peer, updates, open, prompt };
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function socketClient(path: string) {
  const socket = await dial(path);
  const client = await protocolClient(
    socket as unknown as NodeReadableLike,
    socket as unknown as NodeWritableLike,
  );
  return { ...client, socket };
}

/** A bridge driven like an exec: its stdin/stdout are in-memory streams. */
function bridge(path: string, spawnResident: () => void, timeoutMs = 2000) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const logs: string[] = [];
  const exit = runBridge(path, {
    stdin,
    stdout,
    spawnResident,
    log: (line) => logs.push(line),
    retryMs: 5,
    timeoutMs,
  });
  return { stdin, stdout, exit, logs };
}

/** An echo server on `path`; records whether a client half-closed. */
function echoServer(path: string): Promise<{ server: Server; ended: () => boolean }> {
  let ended = false;
  const server = createServer((socket) => {
    socket.on("data", (chunk: Uint8Array) => socket.write(chunk));
    socket.on("end", () => {
      ended = true;
      socket.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(path, () => resolve({ server, ended: () => ended }));
  });
}

const ended = (updates: readonly KnownSessionUpdateParams[]): boolean =>
  updates.some((u) => u.update.type === "turn_end");

describe("the bridge (`serve --bridge`)", () => {
  test("T5: pipes stdin → socket → stdout byte for byte; stdin end ends the socket and the bridge exits 0", async () => {
    // Mutation: drop `socket.end()` on stdin end → the server never sees `end`, the bridge never exits.
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const echo = await echoServer(sockIn(dir));
    const b = bridge(sockIn(dir), () => {
      throw new Error("must not spawn: a resident is listening");
    });
    const out: string[] = [];
    b.stdout.on("data", (chunk) => out.push(String(chunk)));
    b.stdin.write("one\ntwo\n");
    await until(() => out.join("") === "one\ntwo\n");
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(echo.ended()).toBe(true);
    echo.server.close();
  });

  test("T6: nobody listening → spawns the resident ONCE, retries, connects; bytes written before the connect arrive first", async () => {
    // Mutation: spawn on every retry → spawned > 1.
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    let spawned = 0;
    let echo: { server: Server; ended: () => boolean } | undefined;
    const b = bridge(sockIn(dir), () => {
      spawned++;
      // The resident comes up a little later, like a real process.
      setTimeout(() => {
        void echoServer(sockIn(dir)).then((e) => {
          echo = e;
        });
      }, 30);
    });
    b.stdin.write("early\n");
    const out: string[] = [];
    b.stdout.on("data", (chunk) => out.push(String(chunk)));
    await until(() => out.join("") === "early\n");
    expect(spawned).toBe(1);
    b.stdin.end();
    expect(await b.exit).toBe(0);
    echo?.server.close();
  });

  test("a resident that never comes up → exit 1 with a line naming the socket (bounded, never a hang)", async () => {
    // Mutation: no deadline → the test times out.
    const dir = stateDir();
    let spawned = 0;
    const b = bridge(sockIn(dir), () => spawned++, 100);
    expect(await b.exit).toBe(1);
    expect(spawned).toBe(1);
    expect(b.logs.at(-1)).toContain(`no resident listening on ${sockIn(dir)}`);
  });

  test("two bridges racing: one resident wins the lock, the other's start fails, BOTH bridges reach the winner", async () => {
    // Mutation: drop the lock (`acquireResidentLock`) → two residents, one socket stolen.
    const dir = stateDir();
    // One host per start, like two processes: only the lock keeps them one.
    const hosts: SessionHost[] = [];
    const failures: Error[] = [];
    const start = (): void => {
      const host = podHost(1);
      hosts.push(host);
      void resident(host, dir).catch((error: Error) => failures.push(error));
    };
    const one = bridge(sockIn(dir), start);
    const two = bridge(sockIn(dir), start);
    const a = await protocolClient(one.stdout, one.stdin);
    const b = await protocolClient(two.stdout, two.stdin);
    await a.open({ sessionId: "X", create: true });
    expect(await b.open({ sessionId: "X" })).toMatchObject({ created: false });
    expect(hosts.length).toBe(2); // both bridges found nobody and started one
    expect(failures.length).toBe(1);
    expect(failures[0]?.message).toContain("another tentacle resident");
    one.stdin.end();
    two.stdin.end();
    expect(await one.exit).toBe(0);
    expect(await two.exit).toBe(0);
  });
});

describe("the resident (`serve --resident`)", () => {
  test("T7: a second resident on the same state dir fails on the lock; the first keeps serving", async () => {
    // Mutation: drop `acquireResidentLock` → the second unlinks and steals the socket.
    const dir = stateDir();
    const first = await resident(podHost(), dir);
    await expect(resident(podHost(), dir)).rejects.toThrow(/another tentacle resident \(pid \d+\)/);
    const c = await socketClient(first.socketPath);
    expect(await c.open({ sessionId: "Y", create: true })).toMatchObject({ created: true });
    c.socket.destroy();
  });

  test("F3c (Review S1): a container restart left the lock and its pid is live again (another process) → taken over", async () => {
    // Mutation: compare the pid only (ignore the start time) → "another tentacle serve" forever.
    const dir = stateDir();
    const before = await resident(podHost(), dir, { procOf: running("100") });
    const left = readFileSync(join(dir, ".lock.1"), "utf8");
    await before.stop();
    writeFileSync(join(dir, ".lock.1"), left); // `/tmp` survives a `docker start`; the process did not
    // Same pid, same start time: still that resident → refused.
    await expect(resident(podHost(), dir, { procOf: running("100") })).rejects.toThrow(
      /\(pid \d+\)/,
    );
    // Same pid, another start time: a recycled pid → stale, taken over.
    const after = await resident(podHost(), dir, { procOf: running("200") });
    const c = await socketClient(after.socketPath);
    expect(await c.open({ sessionId: "R", create: true })).toMatchObject({ created: true });
    c.socket.destroy();
  });

  test("residentStop never signals a recycled pid (start time differs)", async () => {
    // Mutation: `residentStop` checks the pid only → SIGTERMs an unrelated process.
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(join(dir, ".lock.1"), `${child.pid} 1`);
      expect(await residentStop(dir, 200, running("2"))).toBe(false);
      await tick(50);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("finding 1 (Review S1 fix 1): a crashed resident stays a zombie under `sleep infinity` → its lock is taken over", async () => {
    // Mutation: `alive` ignores the state → "another tentacle resident" until the lock is removed by hand.
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    // The pid exists and its start time matches: only the state says it is gone.
    writeFileSync(join(dir, ".lock.1"), `${process.pid} 100`);
    const procOf: ProcOf = () => ({ state: "Z", start: "100" });
    const handle = await resident(podHost(), dir, { procOf });
    const c = await socketClient(handle.socketPath);
    expect(await c.open({ sessionId: "Z", create: true })).toMatchObject({ created: true });
    c.socket.destroy();
  });

  test("finding 1: residentStop neither signals a zombie nor waits out the grace for one", async () => {
    // Mutation: `alive` ignores the state → the 2 s grace is waited, then a useless SIGKILL.
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, "term");
    // Ignores the SIGTERM (bun would reap a real exit), and marks it: the fake then says zombie.
    const child = spawn(
      "sh",
      ["-c", `trap 'touch ${marker}' TERM; echo ready; while :; do sleep 0.02; done`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => child.stdout.once("data", resolve));
    try {
      writeFileSync(join(dir, ".lock.1"), `${child.pid} 1`);
      const procOf: ProcOf = () => ({ state: existsSync(marker) ? "Z" : "S", start: "1" });
      const started = Date.now();
      expect(await residentStop(dir, 2000, procOf)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });

  describe("finding 2 (Review S1 fix 1): exactly one taker", () => {
    // Two residents at one step of each other: the rival runs in `beforeStep`.
    // It has no start time, so the first sees it as a live holder of the same pid.
    const rivalProc: ProcOf = () => undefined;

    test.each(["judged", "link"] as const)(
      "fresh start, rival at step %s: the slower taker loses, the rival's lock stands",
      (at) => {
        // Mutation: create the lock, then write it → a rival reads "", steals it, both win.
        const dir = stateDir();
        mkdirSync(dir, { recursive: true });
        let rival: { release(): void } | undefined;
        expect(() =>
          acquireResidentLock(dir, running("1"), (step) => {
            if (step === at) rival = acquireResidentLock(dir, rivalProc);
          }),
        ).toThrow(/another tentacle resident/);
        expect(rival).toBeDefined();
        expect(readdirSync(dir)).toEqual([".lock.1"]);
        expect(readFileSync(join(dir, ".lock.1"), "utf8")).toBe(String(process.pid));
      },
    );

    test.each(["judged", "link"] as const)(
      "stale lock, rival at step %s: both judged it dead, exactly one takes the next generation",
      (at) => {
        // Mutation: `renameSync` instead of `linkSync` → it replaces the rival's fresh lock, both win.
        const dir = stateDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, ".lock.1"), "999999");
        let rival: { release(): void } | undefined;
        expect(() =>
          acquireResidentLock(dir, running("1"), (step) => {
            if (step === at) rival = acquireResidentLock(dir, rivalProc);
          }),
        ).toThrow(/another tentacle resident/);
        expect(rival).toBeDefined();
        expect(readdirSync(dir)).toEqual([".lock.2"]);
        expect(readFileSync(join(dir, ".lock.2"), "utf8")).toBe(String(process.pid));
      },
    );

    test.each([
      ["before its rename: the lock is still the dead old holder's", "999999"],
      ["after its rename: the lock is the dead taker's own", "999998"],
    ])("old format: a taker died inside the claim, %s → not a wedge", (_when, holder) => {
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".lock"), holder);
      writeFileSync(join(dir, ".lock.takeover"), holder);
      expect(() => acquireResidentLock(dir, running("1"))).not.toThrow();
      expect(readdirSync(dir)).toEqual([".lock.1"]);
    });

    test.each([
      ["before its link: only the dead old holder", [".lock.3"], 4],
      ["after its link: the dead taker is the highest", [".lock.3", ".lock.4"], 5],
      ["after its link, its temp leaked", [".lock.4", ".lock.0a1b-2c"], 5],
    ])("a taker died %s → the next one takes the next generation", (_when, files, next) => {
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      for (const name of files) writeFileSync(join(dir, name), "999999");
      acquireResidentLock(dir, running("1"));
      expect(readdirSync(dir)).toEqual([`.lock.${next}`]);
    });

    test("a live holder of the highest generation refuses, whatever lies below it", () => {
      // Mutation: compare names as strings → `.lock.2` is the highest, read dead, taken over.
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".lock.2"), "999999");
      writeFileSync(join(dir, ".lock.10"), `${process.pid} 1`);
      expect(() => acquireResidentLock(dir, running("1"))).toThrow(/\(pid \d+\)/);
      expect(readdirSync(dir).sort()).toEqual([".lock.10", ".lock.2"]);
    });

    test("a slow taker that links a swept slot sees the higher generation and backs off", () => {
      // Mutation: no re-read after the link → two holders, the slow one on a lower generation.
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".lock.1"), "999999");
      let holder: { release(): void } | undefined;
      expect(() =>
        // Judged 1, so it aims at 2; meanwhile 2 came and went, and 3 swept it.
        acquireResidentLock(dir, running("1"), (step) => {
          if (step === "judged") {
            acquireResidentLock(dir, running("2")).release();
            holder = acquireResidentLock(dir, running("3"));
          }
        }),
      ).toThrow(/another tentacle resident/);
      expect(holder).toBeDefined();
      expect(readdirSync(dir)).toEqual([".lock.3"]);
    });

    test("released: one tombstone stays, however many residents came and went, and it is stale", async () => {
      // Mutation: no sweep → one file per start, without bound.
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 5; i++) acquireResidentLock(dir, running("1")).release();
      expect(readdirSync(dir)).toEqual([".lock.5"]);
      expect(readFileSync(join(dir, ".lock.5"), "utf8")).toBe("");
      expect(await residentStop(dir, 200, running("1"))).toBe(false);
    });

    test("a superseded holder's release leaves the next holder's lock alone", () => {
      // Mutation: `release` empties the highest generation → a live holder reads as a tombstone.
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      const old = acquireResidentLock(dir, running("1"));
      writeFileSync(join(dir, ".lock.1"), "999999");
      acquireResidentLock(dir, running("1"));
      old.release();
      expect(readFileSync(join(dir, ".lock.2"), "utf8")).not.toBe("");
    });

    test("a state dir that was never created: nobody holds it", async () => {
      expect(await residentStop(join(root, "never-created"))).toBe(false);
    });
  });

  describe("real processes: the lock across `serve --resident` processes", () => {
    const main = join(import.meta.dir, "../src/main.ts");
    const generations = (dir: string): string[] =>
      (existsSync(dir) ? readdirSync(dir) : []).filter((name) => /^\.lock\.\d+$/.test(name));
    function start(base: string) {
      const child = spawn(process.execPath, [main, "serve", "--resident"], {
        env: { ...process.env, TMPDIR: base },
        stdio: "ignore",
      });
      const exited = new Promise<number | string | null>((resolve) => {
        child.once("exit", (code, signal) => resolve(signal ?? code));
      });
      return { child, exited };
    }
    /** A fresh `TMPDIR`, its state dir and socket, as the processes will compute them. */
    function realDir() {
      const base = join(root, `p${seq++}`);
      mkdirSync(base);
      const dir = residentStateDir(base);
      return { base, dir, socket: residentSocketPath(dir) };
    }
    /** Until a resident answers on `socket` (the one that won may still be binding). */
    async function serving(socket: string): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (!(await residentStatus(socket).catch(() => ({ resident: false }))).resident) {
        if (Date.now() > deadline) throw new Error(`no resident on ${socket}`);
        await tick(20);
      }
    }

    test("SIGTERM the moment the lock exists (no handler yet): the next resident starts", async () => {
      const { base, dir, socket } = realDir();
      const first = start(base);
      await until(() => generations(dir).length > 0, 10_000);
      first.child.kill("SIGTERM");
      await first.exited;
      const next = start(base);
      try {
        await until(() => generations(dir)[0] === ".lock.2", 10_000);
        await serving(socket);
      } finally {
        next.child.kill("SIGTERM");
        await next.exited;
      }
      expect(generations(dir)).toEqual([".lock.2"]);
      expect(readFileSync(join(dir, ".lock.2"), "utf8")).toBe("");
    }, 30_000);

    test("four racing on a stale lock: exactly one is left serving", async () => {
      const { base, dir, socket } = realDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".lock.1"), "999999");
      const racers = [start(base), start(base), start(base), start(base)];
      let lost = 0;
      for (const r of racers) {
        void r.exited.then((code) => {
          if (code === 1) lost++;
        });
      }
      try {
        await until(() => lost === 3, 20_000);
        await serving(socket);
        expect(lost).toBe(3);
      } finally {
        for (const r of racers) r.child.kill("SIGTERM");
        await Promise.all(racers.map((r) => r.exited));
      }
    }, 30_000);
  });

  test("a stale socket file and a dead pid's lock (the resident crashed) → taken over", async () => {
    // Mutation: no unlink of the stale socket → listen fails EADDRINUSE.
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".lock.1"), "999999");
    const stale = await echoServer(sockIn(dir));
    // Close the listener but leave its socket FILE behind, as a crash would.
    stale.server.close();
    writeFileSync(sockIn(dir), "");
    const handle = await resident(podHost(), dir);
    const c = await socketClient(handle.socketPath);
    expect(await c.open({ sessionId: "Z", create: true })).toMatchObject({ created: true });
    c.socket.destroy();
  });

  test("T8: the resident outlives its first connection; a second one reopens the id MID-TURN with a gapless replay", async () => {
    // Mutation: stop the resident when a connection closes → the second dial fails.
    const dir = stateDir();
    const host = podHost(60);
    const handle = await resident(host, dir);
    const a = await socketClient(handle.socketPath);
    const { epoch } = await a.open({ sessionId: "X", create: true });
    await a.prompt("X", "t1");
    await until(() => a.updates.length >= 4);
    const lastA = a.updates.at(-1)?.seq ?? 0;
    a.socket.destroy(); // the exec died
    await until(() => handle.connections() === 0);
    expect(host.get("X")?.running).toBe(true);
    const b = await socketClient(handle.socketPath);
    expect(await b.open({ sessionId: "X", since: { epoch, seq: lastA } })).toMatchObject({
      created: false,
      resync: false,
    });
    await until(() => ended(b.updates));
    const seqs = b.updates.map((u) => u.seq);
    expect(seqs[0]).toBe(lastA + 1);
    expect(seqs).toEqual(seqs.map((_, i) => lastA + 1 + i));
    expect(b.updates.at(-1)?.update).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
    b.socket.destroy();
  });

  test("the exec link drops (its model-serving connection was the last) → turn cancelled, session intact; the redial finds it live", async () => {
    // Mutation: `release` never cancels → the turn runs on with no model link.
    const dir = stateDir();
    const host = podHost(200);
    const handle = await resident(host, dir, { servesModel: true });
    const a = await socketClient(handle.socketPath);
    const { epoch } = await a.open({ sessionId: "X", create: true });
    await a.prompt("X", "t1");
    await until(() => a.updates.length >= 3);
    a.socket.destroy();
    await until(() => host.get("X")?.running === false);
    const b = await socketClient(handle.socketPath);
    expect(
      await b.open({ sessionId: "X", messages: [{ role: "user", content: "laptop copy" }] }),
    ).toMatchObject({ created: false });
    const c = await socketClient(handle.socketPath);
    await c.open({ sessionId: "X", since: { epoch, seq: 0 } });
    expect(c.updates.at(-1)?.update).toMatchObject({ type: "turn_end", stopReason: "cancelled" });
    b.socket.destroy();
    c.socket.destroy();
  });

  test("idle exit (Review S1 F3a): an unclean exit's detached idle session does not keep it past idleExitMs (socket gone)", async () => {
    // Mutation: the idle check counts any session (`host.size > 0`) → never exits (~24.5 h live).
    const dir = stateDir();
    const host = podHost(1);
    const handle = await resident(host, dir, { idleExitMs: 40, sweepIntervalMs: 10 });
    let stopped = false;
    void handle.done.then(() => {
      stopped = true;
    });
    const c = await socketClient(handle.socketPath);
    await c.open({ sessionId: "X", create: true });
    await tick(120);
    expect(stopped).toBe(false); // attached: never idle
    c.socket.destroy(); // the laptop died: no session/close
    await until(() => stopped, 2000);
    expect(existsSync(handle.socketPath)).toBe(false);
  });

  test("finding 4 (Review S1 fix 1): a detached idle session is REAPED on the resident's bound, before the idle exit", async () => {
    // Mutation: the reaper keeps `serve`'s 24 h → the exit drops the session unclosed (jobs never freed).
    const dir = stateDir();
    const host = podHost(1);
    const handle = await resident(host, dir, { idleExitMs: 40, sweepIntervalMs: 10 });
    const c = await socketClient(handle.socketPath);
    await c.open({ sessionId: "X", create: true });
    c.socket.destroy();
    await until(() => handle.connections() === 0);
    expect(host.get("X")).toBeDefined();
    await handle.done;
    expect(host.get("X")).toBeUndefined();
  });

  test("idle exit: a turn still running with nobody attached keeps it; once it ends, it exits", async () => {
    // Mutation: drop `busy` from the idle check → exits mid-turn.
    const dir = stateDir();
    const host = podHost(150); // ~300 ms turn; not model-proxied: a drop does not cancel it
    const handle = await resident(host, dir, { idleExitMs: 40, sweepIntervalMs: 10 });
    let stopped = false;
    void handle.done.then(() => {
      stopped = true;
    });
    const c = await socketClient(handle.socketPath);
    await c.open({ sessionId: "X", create: true });
    await c.prompt("X", "t1");
    await until(() => c.updates.length >= 2);
    c.socket.destroy();
    await until(() => handle.connections() === 0);
    await tick(120);
    expect(host.get("X")?.running).toBe(true);
    expect(stopped).toBe(false);
    await until(() => stopped, 3000);
  });

  test("--resident-status: counts sessions, running turns and attached clients; nobody listening → resident:false", async () => {
    const dir = stateDir();
    expect(await residentStatus(sockIn(dir))).toEqual({ resident: false });
    const host = podHost(200);
    const handle = await resident(host, dir);
    const a = await socketClient(handle.socketPath);
    await a.open({ sessionId: "X", create: true });
    await a.prompt("X", "t1");
    await until(() => a.updates.length >= 2);
    expect(await residentStatus(handle.socketPath)).toEqual({
      resident: true,
      sessions: 1,
      running: 1,
      attached: 1,
    });
    a.socket.destroy();
  });

  test("L2 --resident-status: the version is the RESIDENT's, never the asker's; an old resident says none", async () => {
    // Mutation: read `APP_VERSION` → this process's version, the bug of the TODO.
    const dir = stateDir();
    const handle = await resident(podHost(200, "0.2.0"), dir);
    const status = await residentStatus(handle.socketPath);
    expect(status.version).toBe("0.2.0");
    expect(status.version).not.toBe(APP_VERSION);

    const old = await resident(podHost(200), stateDir());
    const silent = await residentStatus(old.socketPath);
    expect(silent.resident).toBe(true);
    expect("version" in silent).toBe(false);
  });

  test("L3 busy: the guard's refusal names the RESIDENT's version, from the real report", async () => {
    // Mutation: name the asker's version in `residentStatusReport`.
    const dir = stateDir();
    const handle = await resident(podHost(200, "0.2.0"), dir);
    const a = await socketClient(handle.socketPath);
    await a.open({ sessionId: "X", create: true });
    const report = await residentStatusReport(handle.socketPath);
    expect(residentGuard({ exitCode: report.exitCode, stdout: report.line }, "w")).toEqual({
      kind: "refuse",
      message:
        "a detached run is using tentacle 0.2.0 in w — wait for it, `tentacle rm w`, or attach with tentacle 0.2.0",
      busy: true,
    });
    a.socket.destroy();
  });
});

describe("pure helpers", () => {
  test("residentGuard (Review S1 F3b): a probe that failed REFUSES (fail closed); only a binary with no resident mode → none", () => {
    // Mutation: a failed probe (`null`) → none → the binary is replaced next to a busy resident.
    const refused = (probe: Parameters<typeof residentGuard>[0]) => {
      const verdict = residentGuard(probe, "w");
      expect(verdict.kind).toBe("refuse");
      return verdict.kind === "refuse" ? verdict.message : "";
    };
    expect(refused(null)).toContain("could not ask");
    expect(refused({ exitCode: null, stdout: "" })).toContain("could not ask");
    expect(refused({ exitCode: 0, stdout: "not json" })).toContain("could not ask");
    expect(
      refused({
        exitCode: 1,
        stdout: `${JSON.stringify({ resident: null, error: "boom\x1b[2J" })}\n`,
      }),
    ).toContain("boom");
    // A pre-S1 binary (`unknown option`) or no binary at all: no resident can exist.
    expect(residentGuard({ exitCode: 1, stdout: "" }, "w")).toEqual({ kind: "none" });
    expect(residentGuard({ exitCode: 127, stdout: "" }, "w")).toEqual({ kind: "none" });
  });

  test("residentGuard (finding 3): a status process killed mid-probe (exit ≥ 128, no JSON) REFUSES", () => {
    // Mutation: only exit 0 counts as a failed probe → 137 → none → replaced next to a busy resident.
    for (const exitCode of [128, 137, 143]) {
      const verdict = residentGuard({ exitCode, stdout: "" }, "w");
      expect(verdict.kind).toBe("refuse");
      expect(verdict.kind === "refuse" ? verdict.message : "").toContain(`exit ${exitCode}`);
    }
  });

  test("residentStatusReport: a socket that answers nothing usable → JSON error, exit 1 → the guard refuses", async () => {
    // Mutation: the report lets the error escape (no JSON) → exit≠0, no JSON → guard says none.
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const server: Server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(sockIn(dir), resolve));
    try {
      const report = await residentStatusReport(sockIn(dir));
      expect(report.exitCode).toBe(1);
      expect(JSON.parse(report.line)).toMatchObject({ resident: null });
      expect(residentGuard({ exitCode: report.exitCode, stdout: report.line }, "w").kind).toBe(
        "refuse",
      );
      expect(await residentStatusReport(join(dir, "none.sock"))).toEqual({
        line: JSON.stringify({ resident: false }),
        exitCode: 0,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("parseProcStat: fields 3 and 22 of /proc/<pid>/stat, a `(comm)` with spaces and parens included", () => {
    const stat =
      "1234 (my (odd) cmd) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 4096 10\n";
    expect(parseProcStat(stat)).toEqual({ state: "S", start: "98765" });
    expect(parseProcStat("1 (x) S 1")).toEqual({ state: "S", start: undefined });
    // A real zombie, read in a `sleep infinity` container after a SIGKILL.
    const zombie =
      "13 (sleep) Z 1 7 7 0 -1 4228108 57 0 0 0 0 0 0 0 20 0 1 0 22839674 0 0 18446744073709551615 0 0 0 0 0 0 0 6 0 1 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 9\n";
    expect(parseProcStat(zombie)).toEqual({ state: "Z", start: "22839674" });
  });

  test("residentGuard: busy → refuse; idle → stop; resident:false → none", () => {
    // Mutation: treat `attached > 0` as idle → a run whose TUI is attached gets replaced.
    const ok = (status: object) => ({ exitCode: 0, stdout: `${JSON.stringify(status)}\n` });
    expect(residentGuard(ok({ resident: false }), "w")).toEqual({ kind: "none" });
    expect(residentGuard(ok({ resident: true, running: 0, attached: 0 }), "w")).toEqual({
      kind: "stop",
    });
    for (const busy of [
      { running: 1, attached: 0 },
      { running: 0, attached: 1 },
    ]) {
      expect(
        residentGuard(ok({ resident: true, version: "0.2.0", sessions: 1, ...busy }), "w"),
      ).toEqual({
        kind: "refuse",
        message:
          "a detached run is using tentacle 0.2.0 in w — wait for it, `tentacle rm w`, or attach with tentacle 0.2.0",
        busy: true,
      });
    }
  });

  test("residentSkewWarning: a resident of another or unknown build warns, sanitised; the same build and a failed probe are silent", () => {
    // Mutation: skip `untrustedText` → the pod's ESC reaches the terminal.
    const say = (status: object | null, expected: string | undefined) =>
      residentSkewWarning(
        status === null ? null : { stdout: `${JSON.stringify(status)}\n` },
        "w",
        "/usr/local/bin/tentacle",
        expected,
      );
    expect(say({ resident: true, version: "0.3.0" }, "0.3.0")).toBeUndefined();
    expect(say({ resident: false }, "0.3.0")).toBeUndefined();
    expect(say({ resident: null, error: "boom" }, "0.3.0")).toBeUndefined();
    expect(say(null, "0.3.0")).toBeUndefined();
    expect(residentSkewWarning({ stdout: "not json" }, "w", "/b", "0.3.0")).toBeUndefined();

    expect(say({ resident: true, version: "0.2.0" }, "0.3.0")).toContain(
      "w already runs a tentacle resident 0.2.0, this laptop 0.3.0",
    );
    expect(say({ resident: true }, "0.3.0")).toContain("resident of an unknown version");
    expect(say({ resident: true, version: 7 }, "0.3.0")).toContain("of an unknown version");
    const hostile = say({ resident: true, version: "0.2\u001b[2J" }, "0.3.0");
    expect(hostile).toContain("0.2 [2J");
    expect(hostile).not.toContain("\u001b");
    // From source there is no fixed answer: a resident up is still said.
    expect(say({ resident: true, version: "dev" }, undefined)).toContain("resident dev:");
  });

  test("residentCommand / selfCommand: the resident inherits the bridge's model flags; from source it is `bun <script>`", () => {
    expect(
      residentCommand(["/usr/local/bin/tentacle"], {
        modelProxy: true,
        contextWindow: 1000,
        autoTitle: true,
      }),
    ).toEqual([
      "/usr/local/bin/tentacle",
      "serve",
      "--resident",
      "--model-proxy",
      "--context-window",
      "1000",
      "--auto-title",
    ]);
    expect(residentCommand(["t"], { socket: "/s" })).toEqual([
      "t",
      "serve",
      "--resident",
      "--socket",
      "/s",
    ]);
    expect(selfCommand("/usr/local/bin/tentacle", "/$bunfs/root/x")).toEqual([
      "/usr/local/bin/tentacle",
    ]);
    expect(selfCommand("/opt/bun/bin/bun", "/repo/packages/cli/src/main.ts")).toEqual([
      "/opt/bun/bin/bun",
      "/repo/packages/cli/src/main.ts",
    ]);
  });
});
