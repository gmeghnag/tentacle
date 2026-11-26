// `/__status` over real sockets (docs/feat/relay-status.md): the separate
// loopback listener, the counters the live relay feeds, and what it must never say.
import { afterEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { encodeBase64Url } from "@tentacle/protocol";
import { relayIdOf } from "@tentacle/transport/relay-id";
import type { ApnsClient } from "../src/apns-client.ts";
import type { ApnsJwtSource, ApnsOutcome } from "../src/apns.ts";
import { type RunningRelay, startRelay } from "../src/server.ts";

const SECRET = encodeBase64Url(new Uint8Array(32).fill(21));
const ID = relayIdOf(new Uint8Array(32).fill(21));
const TOKEN = "b".repeat(64);
const CLIENT_IP = "203.0.113.77";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const stop of cleanup.splice(0)) {
    stop();
  }
});

function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const lines: string[] = [];
  const server = startRelay({
    host: "127.0.0.1",
    port: 0,
    statusPort: 0,
    sweepMs: 10,
    onLog: (line) => lines.push(line),
    ...options,
  });
  cleanup.push(() => server.stop());
  return { server, lines };
}

interface StatusBody {
  service: string;
  uptimeSeconds: number;
  memory: { rssBytes: number; heapUsedBytes: number };
  now: Record<string, number>;
  totals: Record<string, number>;
  lastMinute: Record<string, number>;
  history: Record<string, number>[];
}

function statusUrl(server: RunningRelay): string {
  if (server.statusPort === undefined) {
    throw new Error("the status listener is not up");
  }
  return `http://127.0.0.1:${server.statusPort}/__status`;
}

async function status(server: RunningRelay): Promise<StatusBody> {
  const response = await fetch(statusUrl(server));
  expect(response.status).toBe(200);
  return (await response.json()) as StatusBody;
}

/** Poll the status body until `check` holds (the server applies a frame on its own turn). */
async function statusWhen(
  server: RunningRelay,
  check: (body: StatusBody) => boolean,
  what: string,
): Promise<StatusBody> {
  const deadline = Date.now() + 3_000;
  let body = await status(server);
  while (!check(body)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(body.totals)}`);
    }
    await Bun.sleep(5);
    body = await status(server);
  }
  return body;
}

interface TestSocket {
  send(frame: unknown): void;
  /** The next frame, as it came. */
  next(): Promise<string | Uint8Array>;
  readonly closed: Promise<number>;
}

function open(url: string, headers?: Record<string, string>): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws =
      headers === undefined ? new WebSocket(url) : new WebSocket(url, { headers } as never);
    ws.binaryType = "arraybuffer";
    const pending: (string | Uint8Array)[] = [];
    const waiters: ((frame: string | Uint8Array) => void)[] = [];
    const closed = new Promise<number>((done) => {
      ws.onclose = (event) => done(event.code);
    });
    ws.onmessage = (event) => {
      const data = event.data as string | ArrayBuffer;
      const frame = typeof data === "string" ? data : new Uint8Array(data);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        pending.push(frame);
      }
    };
    ws.onerror = () => reject(new Error(`socket error: ${url}`));
    ws.onopen = () => {
      cleanup.unshift(() => ws.close());
      resolve({
        closed,
        send(frame) {
          ws.send(
            typeof frame === "string" || frame instanceof Uint8Array
              ? frame
              : JSON.stringify(frame),
          );
        },
        next() {
          const buffered = pending.shift();
          if (buffered !== undefined) {
            return Promise.resolve(buffered);
          }
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error("timed out waiting for a frame")), 2_000);
            waiters.push((frame) => {
              clearTimeout(timer);
              done(frame);
            });
          });
        },
      });
    };
  });
}

async function register(server: RunningRelay, headers?: Record<string, string>) {
  const control = await open(`${server.url}/v1/daemon`, headers);
  control.send({ t: "hello", v: 1, secret: SECRET });
  expect(JSON.parse(String(await control.next())).t).toBe("ready");
  return control;
}

/** Every leaf of a JSON value, with its dotted path. */
function leaves(value: unknown, path = ""): [string, unknown][] {
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      leaves(child, path === "" ? key : `${path}.${key}`),
    );
  }
  return [[path, value]];
}

describe("the status listener", () => {
  test("off by default for the library", () => {
    const server = startRelay({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => server.stop());
    expect(server.statusPort).toBeUndefined();
  });

  test("answers 200 on its own port, whatever `--host` binds", async () => {
    const { server } = relay({ host: "0.0.0.0" });
    expect(server.statusPort).not.toBe(server.port);
    const body = await status(server);
    expect(body.service).toBe("relay");
    expect(body.now).toEqual({ registeredDaemons: 0, deviceLegs: 0, splicedPairs: 0 });
    expect(body.memory.rssBytes).toBeGreaterThan(0);
    expect(body.totals.dials).toBe(0);
    expect(body.lastMinute.bytesRelayed).toBe(0);
    // Not merely refused by the gate: nothing listens there off loopback. (A
    // host with no non-loopback address has nothing to try.)
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (lan !== undefined) {
      await expect(
        fetch(`http://${lan}:${server.statusPort}/__status`, {
          signal: AbortSignal.timeout(2_000),
        }),
      ).rejects.toThrow();
    }
  });

  test("the PUBLIC port still 404s /__status, even dressed as a local request", async () => {
    const { server } = relay({ trustProxy: true });
    const url = `http://127.0.0.1:${server.port}/__status`;
    expect((await fetch(url)).status).toBe(404);
    const forged = await fetch(url, {
      headers: { "X-Forwarded-For": "127.0.0.1", Host: "127.0.0.1" },
    });
    expect(forged.status).toBe(404);
    expect(await forged.text()).toBe("not found");
  });

  test("a proxied-shaped request on the status port is a 404", async () => {
    const { server } = relay();
    const forwarded = await fetch(statusUrl(server), {
      headers: { "X-Forwarded-For": CLIENT_IP },
    });
    expect(forwarded.status).toBe(404);
    const named = await fetch(statusUrl(server), { headers: { Host: "relay.tentacle.so" } });
    expect(named.status).toBe(404);
  });

  test("a busy status port: the relay serves without it, and says so", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    cleanup.push(() => holder.stop(true));
    const { server, lines } = relay({ statusPort: holder.port });
    expect(server.statusPort).toBeUndefined();
    expect(lines).toContain("status-off EADDRINUSE");
    expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);
    await register(server);
  });

  test("stop() closes it: the port can be bound again", () => {
    // A port to be REBOUND is picked outside the ephemeral range (AGENTS §9).
    let server: RunningRelay | undefined;
    let port = 0;
    for (let attempt = 0; attempt < 50 && server?.statusPort === undefined; attempt += 1) {
      server?.stop();
      port = 20_000 + Math.floor(Math.random() * 10_000);
      server = startRelay({ host: "127.0.0.1", port: 0, statusPort: port });
    }
    expect(server?.statusPort).toBe(port);
    server?.stop();
    const again = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    again.stop(true);
  });
});

describe("what the relay counts", () => {
  test("register + dial + accept + frames both ways: gauges, dials, exact bytes", async () => {
    const { server } = relay({ trustProxy: true });
    const headers = { "X-Forwarded-For": CLIENT_IP };
    const control = await register(server, headers);
    const phone = await open(`${server.url}/d/${ID}/e2e`, headers);
    const opened = JSON.parse(String(await control.next())) as { t: string; stream: string };
    expect(opened.t).toBe("open");
    // Sent BEFORE the accept leg exists: buffered, counted at the flush. Non-ASCII,
    // so bytes (6) and characters (5) differ.
    phone.send("héllo");
    const waiting = await statusWhen(server, (b) => b.now.deviceLegs === 1, "a waiting phone");
    expect(waiting.now.splicedPairs).toBe(0);
    expect(waiting.totals.bytesRelayed).toBe(0);
    const accept = await open(`${server.url}/v1/accept`, headers);
    accept.send({ t: "accept", v: 1, stream: opened.stream });
    expect(await accept.next()).toBe("héllo");
    accept.send(new Uint8Array(7));
    expect(((await phone.next()) as Uint8Array).byteLength).toBe(7);
    phone.send(new Uint8Array(11));
    expect(((await accept.next()) as Uint8Array).byteLength).toBe(11);
    accept.send("€");
    expect(await phone.next()).toBe("€");

    const body = await status(server);
    expect(body.now).toEqual({ registeredDaemons: 1, deviceLegs: 1, splicedPairs: 1 });
    expect(body.totals.registrations).toBe(1);
    expect(body.totals.dials).toBe(1);
    expect(body.totals.bytesRelayed).toBe(6 + 7 + 11 + 3);

    // The history carries the gauges and the same sums (it may span two minutes).
    const sum = (name: string) => body.history.reduce((n, entry) => n + (entry[name] ?? 0), 0);
    expect(sum("bytesRelayed")).toBe(27);
    expect(body.history.at(-1)).toHaveProperty("registeredDaemons");

    // Privacy: numbers only, and none of the things the relay knows by name.
    for (const [path, value] of leaves(body)) {
      if (path !== "service") {
        expect({ path, type: typeof value }).toEqual({ path, type: "number" });
      }
    }
    const text = await (await fetch(statusUrl(server))).text();
    for (const secret of [ID, ID.slice(0, 8), SECRET, opened.stream, CLIENT_IP, "127.0.0.1"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("the tick samples gauges into the history without anyone asking", async () => {
    let at = 1_000_000 * 60_000;
    const { server } = relay({ now: () => at, sweepMs: 60_000 });
    await register(server);
    server.sweep();
    at += 60_000;
    const body = await status(server);
    expect(body.history[0]?.registeredDaemons).toBe(1);
    expect(body.history[0]?.registrations).toBe(1);
    expect(body.lastMinute.registrations).toBe(1);
  });

  test("more refused dials than the log admits are ALL counted", async () => {
    const { server, lines } = relay({ limits: { dialsPerMinutePerIp: 1 } });
    await open(`${server.url}/d/${ID}/e2e`);
    const refused = await Promise.all(
      Array.from({ length: 30 }, () => open(`${server.url}/d/${ID}/e2e`)),
    );
    await Promise.all(refused.map((socket) => socket.closed));
    const body = await statusWhen(server, (b) => b.totals.refusedRate === 30, "30 refusals");
    expect(body.totals.dials).toBe(1);
    expect(lines.filter((line) => line.startsWith("dial-refused")).length).toBeLessThan(30);
  });

  test("a ping flood that closes the socket is `refusedPing`", async () => {
    const { server } = relay({ limits: { pingsPerMinute: 1 } });
    const control = await register(server);
    control.send({ t: "ping" });
    expect(JSON.parse(String(await control.next())).t).toBe("pong");
    expect((await status(server)).totals.refusedPing).toBe(0);
    control.send({ t: "ping" });
    expect(await control.closed).toBe(1008);
    await statusWhen(server, (b) => b.totals.refusedPing === 1, "the ping refusal");
  });

  test("APNs outcomes are pushesSent / pushesFailed", async () => {
    const answer = (token: string): Promise<ApnsOutcome> =>
      Promise.resolve(
        token.startsWith("b") ? { status: "sent" } : { status: "gone", reason: "Unregistered" },
      );
    const client: ApnsClient = {
      send: (input) => answer(input.token),
      sendLiveActivity: (input) => answer(input.token),
      close: () => {},
    };
    const jwtSource: ApnsJwtSource = { jwt: () => Promise.resolve("j"), invalidate: () => {} };
    const { server } = relay({ apns: { client, jwtSource, topic: "so.tentacle.app" } });
    const control = await register(server);
    const tokens = [TOKEN, TOKEN, "c".repeat(64)];
    for (const [index, token] of tokens.entries()) {
      control.send({
        t: "push",
        n: index + 1,
        token,
        env: "sandbox",
        collapse: "collapse-1",
        ttl: 3600,
        payload: { tp: { v: 1, k: "A".repeat(12), e: "B".repeat(43), c: "C".repeat(704) } },
      });
      expect(JSON.parse(String(await control.next())).t).toBe("push-result");
    }
    const body = await status(server);
    expect(body.totals.pushesSent).toBe(2);
    expect(body.totals.pushesFailed).toBe(1);
    expect(await (await fetch(statusUrl(server))).text()).not.toContain("bbbbbbbb");
  });
});
