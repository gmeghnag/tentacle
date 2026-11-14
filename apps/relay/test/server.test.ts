import { afterEach, describe, expect, test } from "bun:test";
import {
  RELAY_CLOSE_UNREGISTERED,
  RELAY_CONTROL_LIMITS,
  RELAY_STREAM_EXPIRY_MS,
  RELAY_STREAM_TEXT_LENGTH,
  encodeBase64Url,
} from "@tentacle/protocol";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { RELAY_CLOSE_REFUSED } from "../src/relay-core.ts";
import {
  type RunningRelay,
  limitsFromFlags,
  logPrefix,
  relayRoute,
  relaySocketOptions,
  startRelay,
} from "../src/server.ts";

const SECRET_BYTE = 7;
const SECRET = encodeBase64Url(new Uint8Array(32).fill(SECRET_BYTE));
const ID = relayIdOf(new Uint8Array(32).fill(SECRET_BYTE));

const running: RunningRelay[] = [];

/** Start a relay on an ephemeral port, with a captured log, and clean it up after the test. */
function relay(options: Parameters<typeof startRelay>[0] = {}): {
  server: RunningRelay;
  lines: string[];
} {
  const lines: string[] = [];
  const server = startRelay({
    host: "127.0.0.1",
    port: 0,
    // A tiny sweep tick so a held-dial test does not wait 250 ms for one tick.
    sweepMs: 10,
    onLog: (line) => lines.push(line),
    ...options,
  });
  running.push(server);
  return { server, lines };
}

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop();
  }
});

/** A WebSocket that records every frame and close it sees, and can await one. */
interface TestSocket {
  readonly ws: WebSocket;
  /** Every frame received, in order (for a "was one ever sent" assertion). */
  readonly received: string[];
  send(frame: unknown): void;
  /** Wait for the next frame (or a frame already received). */
  next(timeoutMs?: number): Promise<string>;
  /** Wait for the socket to close. */
  closed(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  close(): void;
}

function open(url: string, protocols?: string[]): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    const received: string[] = [];
    /** Frames nobody has awaited yet — the queue `next()` drains. */
    const pending: string[] = [];
    const waiters: ((frame: string) => void)[] = [];
    const closes: { code: number; reason: string }[] = [];
    const closeWaiters: ((close: { code: number; reason: string }) => void)[] = [];
    ws.onmessage = (event) => {
      const text = String(event.data);
      received.push(text);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(text);
      } else {
        pending.push(text);
      }
    };
    ws.onclose = (event) => {
      const close = { code: event.code, reason: event.reason };
      closes.push(close);
      const waiter = closeWaiters.shift();
      if (waiter) {
        waiter(close);
      }
      // A frame will never arrive: release anyone waiting on one.
      for (const frameWaiter of waiters.splice(0)) {
        frameWaiter("");
      }
    };
    ws.onerror = () => reject(new Error(`socket error: ${url}`));
    ws.onopen = () =>
      resolve({
        ws,
        received,
        send(frame) {
          ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
        },
        next(timeoutMs = 2_000) {
          const buffered = pending.shift();
          if (buffered !== undefined) {
            return Promise.resolve(buffered);
          }
          return new Promise<string>((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("timed out waiting for a frame")),
              timeoutMs,
            );
            waiters.push((frame) => {
              clearTimeout(timer);
              res(frame);
            });
          });
        },
        closed(timeoutMs = 2_000) {
          const buffered = closes.shift();
          if (buffered !== undefined) {
            return Promise.resolve(buffered);
          }
          return new Promise<{ code: number; reason: string }>((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("timed out waiting for a close")),
              timeoutMs,
            );
            closeWaiters.push((close) => {
              clearTimeout(timer);
              res(close);
            });
          });
        },
        close() {
          ws.close();
        },
      });
  });
}

/** A daemon's control socket: connect and register, returning the `ready` frame. */
async function register(base: string, secret = SECRET): Promise<TestSocket> {
  const control = await open(`${base}/v1/daemon`);
  control.send({ t: "hello", v: 1, secret });
  const ready = JSON.parse(await control.next()) as { t: string; id: string };
  expect(ready.t).toBe("ready");
  return control;
}

/** Poll until `check()` is true (the server applies a close on its own turn). */
async function waitFor(check: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("relayRoute — the routing table", () => {
  test("the three wire routes and healthz", () => {
    expect(relayRoute("/healthz")).toEqual({ kind: "health" });
    expect(relayRoute("/v1/daemon")).toEqual({ kind: "control" });
    expect(relayRoute("/v1/accept")).toEqual({ kind: "accept" });
    expect(relayRoute(`/d/${ID}/e2e`)).toEqual({ kind: "phone", id: ID });
  });

  test("the phone path is matched EXACTLY (it is frozen: an installed app dials it)", () => {
    expect(relayRoute(`/d/${ID}/e2e/x`)).toEqual({ kind: "notfound" });
    expect(relayRoute(`/d/${ID}`)).toEqual({ kind: "notfound" });
    expect(relayRoute(`/d/${ID}/e2`)).toEqual({ kind: "notfound" });
    // A non-id segment is not a phone: the address shape is 22 base64url chars.
    expect(relayRoute("/d/x/e2e")).toEqual({ kind: "notfound" });
    expect(relayRoute(`/d/${ID}!/e2e`)).toEqual({ kind: "notfound" });
    expect(relayRoute("/")).toEqual({ kind: "notfound" });
    expect(relayRoute("/v1/daemon/x")).toEqual({ kind: "notfound" });
  });
});

describe("relaySocketOptions / limitsFromFlags", () => {
  test("the backpressure and keepalive policy is `serve`'s, not Bun's defaults", () => {
    const options = relaySocketOptions({});
    expect(options.closeOnBackpressureLimit).toBe(true);
    expect(options.sendPings).toBe(true);
    expect(options.backpressureLimit).toBe(RELAY_CONTROL_LIMITS.backpressureBytes);
    expect(options.idleTimeout).toBe(60);
    expect(relaySocketOptions({ idleTimeoutSec: 5 }).idleTimeout).toBe(5);
  });

  test("each limit flag maps onto exactly one limit", () => {
    expect(
      limitsFromFlags({
        "max-dials-per-minute": 5,
        "max-streams-per-ip": 6,
        "max-streams-per-id": 7,
        "max-ids": 8,
        "max-hellos-per-minute": 9,
      }),
    ).toEqual({
      dialsPerMinutePerIp: 5,
      concurrentPerIp: 6,
      streamsPerId: 7,
      registeredIds: 8,
      hellosPerMinutePerIp: 9,
    });
    expect(limitsFromFlags({})).toEqual({});
  });

  test("logPrefix never carries more than 8 chars of a token or an id", () => {
    expect(logPrefix(ID)).toBe(ID.slice(0, 8));
    expect(logPrefix("short")).toBe("short");
  });
});

describe("startRelay — control socket", () => {
  test("/healthz answers 200 with the relay version and NO counters", async () => {
    const { server } = relay();
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, v: 1 });
  });

  test("an unknown route is a 404", async () => {
    const { server } = relay();
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/d/${ID}/e2e/x`)).status).toBe(404);
  });

  test("hello registers, ready carries the id its own secret derives", async () => {
    const { server } = relay();
    const control = await register(server.url);
    expect(JSON.parse(control.received[0] ?? "{}")).toEqual({
      t: "ready",
      v: 1,
      id: ID,
      features: [],
    });
    expect(server.core.registeredCount).toBe(1);
    control.close();
  });

  test("a wrong version is refused `version` and closed", async () => {
    const { server } = relay();
    const control = await open(`${server.url}/v1/daemon`);
    control.send({ t: "hello", v: 99, secret: SECRET });
    expect(JSON.parse(await control.next())).toEqual({
      t: "error",
      code: "version",
      supported: [1],
    });
    expect((await control.closed()).code).toBe(1000);
  });

  test("a malformed control frame closes the socket instead of being guessed at", async () => {
    const { server } = relay();
    const control = await open(`${server.url}/v1/daemon`);
    control.send("{not json");
    expect((await control.closed()).code).toBe(1008);
  });

  test("an unknown frame TYPE closes too (a control socket has no other business)", async () => {
    const { server } = relay();
    const control = await register(server.url);
    control.send({ t: "open", stream: "x", ip: "1.2.3.4" });
    expect((await control.closed()).code).toBe(1008);
  });

  test("ping is answered pong (R0(c): a Bun client cannot see a dead TCP path itself)", async () => {
    const { server } = relay();
    const control = await register(server.url);
    control.send({ t: "ping" });
    expect(JSON.parse(await control.next())).toEqual({ t: "pong" });
    control.close();
  });

  test("a second hello on one control socket, with a different secret, is refused", async () => {
    const { server } = relay();
    const control = await open(`${server.url}/v1/daemon`);
    control.send({ t: "hello", v: 1, secret: SECRET });
    expect((JSON.parse(await control.next()) as { t: string }).t).toBe("ready");
    // A second registration on the same socket would register a second id that
    // nothing ever unregisters (close only removes the first): the relay says no
    // rather than leak it until a restart.
    control.send({ t: "hello", v: 1, secret: encodeBase64Url(new Uint8Array(32).fill(8)) });
    expect(JSON.parse(await control.next())).toEqual({
      t: "error",
      code: "invalid",
      supported: [1],
    });
    expect((await control.closed()).code).toBe(1000);
    await waitFor(() => server.core.registeredCount === 0, "the first id to be unregistered");
  });

  test("a second hello for one id replaces the first socket and TELLS it", async () => {
    const { server } = relay();
    const first = await register(server.url);
    const second = await register(server.url);
    expect(JSON.parse(await first.next())).toEqual({ t: "replaced" });
    expect((await first.closed()).code).toBe(1000);
    // The new socket is live: it still answers.
    second.send({ t: "ping" });
    expect(JSON.parse(await second.next())).toEqual({ t: "pong" });
    expect(server.core.registeredCount).toBe(1);
    second.close();
  });
});

describe("startRelay — splice (R0(a) made a claim about the real service)", () => {
  test("frames cross 1:1 both ways, an 87 KiB frame included", async () => {
    const { server } = relay();
    const control = await register(server.url);
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    const openFrame = JSON.parse(await control.next()) as { t: string; stream: string };
    expect(openFrame.t).toBe("open");

    const daemon = await open(`${server.url}/v1/accept`);
    daemon.send({ t: "accept", v: 1, stream: openFrame.stream });
    // No accept ACK in the protocol: the leg is raw from here, so the proof is
    // that a frame the phone sends arrives at the daemon.
    const big = "x".repeat(87 * 1024);
    phone.send("hello");
    phone.send(big);
    expect(await daemon.next()).toBe("hello");
    expect((await daemon.next()).length).toBe(big.length);
    // And back the other way.
    daemon.send("down");
    expect(await phone.next()).toBe("down");
    // A stream token is never logged whole (a log is not a wire).
    expect(server.core.streamCount).toBe(1);

    phone.close();
    daemon.close();
    control.close();
  });

  test("a 97 KiB frame closes BOTH legs (the plan's number: past the 96 Ki cap)", async () => {
    const { server, lines } = relay();
    const control = await register(server.url);
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    const openFrame = JSON.parse(await control.next()) as { stream: string };
    const daemon = await open(`${server.url}/v1/accept`);
    daemon.send({ t: "accept", v: 1, stream: openFrame.stream });
    phone.send("first");
    expect(await daemon.next()).toBe("first");

    phone.send("y".repeat(97 * 1024));
    expect((await phone.closed()).code).toBe(RELAY_CLOSE_UNREGISTERED);
    expect((await daemon.closed()).code).toBe(RELAY_CLOSE_UNREGISTERED);
    expect(lines.some((line) => line.startsWith("frame-oversize"))).toBe(true);
    control.close();
  });

  test("one leg closing closes the other", async () => {
    const { server } = relay();
    const control = await register(server.url);
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    const openFrame = JSON.parse(await control.next()) as { stream: string };
    const daemon = await open(`${server.url}/v1/accept`);
    daemon.send({ t: "accept", v: 1, stream: openFrame.stream });
    phone.send("ping");
    expect(await daemon.next()).toBe("ping");

    daemon.close();
    await daemon.closed();
    // The phone sees its leg go, so the app detaches and resyncs on the next dial.
    await phone.closed();
    expect(server.core.streamCount).toBe(0);
    control.close();
  });

  test("a binary frame is not guessed at: both legs close 1003", async () => {
    const { server } = relay();
    const control = await register(server.url);
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    const openFrame = JSON.parse(await control.next()) as { stream: string };
    const daemon = await open(`${server.url}/v1/accept`);
    daemon.send({ t: "accept", v: 1, stream: openFrame.stream });
    phone.ws.send(new Uint8Array([1, 2, 3]));
    expect((await phone.closed()).code).toBe(1003);
    expect((await daemon.closed()).code).toBe(1003);
    control.close();
  });
});

describe("startRelay — phone dial, hold and pre-accept buffering", () => {
  test("an accept for an expired stream closes the phone too (not just the accept leg)", async () => {
    // A long sweep tick, so the accept is what discovers the expiry — the path
    // `sweep()` would otherwise cover first.
    const { server, lines } = relay({ sweepMs: 60_000 });
    const control = await register(server.url);
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    const openFrame = JSON.parse(await control.next()) as { stream: string };
    // The token expires at 10 s; the daemon accepts late (or its open is replayed).
    await Bun.sleep(RELAY_STREAM_EXPIRY_MS + 200);
    const daemon = await open(`${server.url}/v1/accept`);
    daemon.send({ t: "accept", v: 1, stream: openFrame.stream });
    expect((await daemon.closed()).code).toBe(RELAY_CLOSE_UNREGISTERED);
    // The phone is closed 4404 rather than left waiting on a stream nobody can
    // serve: the app then tries its next address (F2/F7).
    expect((await phone.closed()).code).toBe(RELAY_CLOSE_UNREGISTERED);
    expect(lines.some((line) => line.startsWith("accept-refused expired"))).toBe(true);
    control.close();
  }, 20_000);

  // 5 s of real hold + the close: this test owns its timeout, not Bun's 5 s default.
  test("a dial for an unregistered id is held, then closed 4404 at 5 s", async () => {
    const { server } = relay();
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    // Nothing is sent to a held phone: it simply waits for a registration.
    expect(server.core.heldCount).toBe(1);
    const close = await phone.closed(8_000);
    expect(close.code).toBe(RELAY_CLOSE_UNREGISTERED);
    expect(server.core.heldCount).toBe(0);
  }, 10_000);

  test("a held phone's early frames are delivered once the daemon accepts", async () => {
    const { server } = relay();
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    // A Noise message 1 goes out before the daemon has even registered (the
    // pairing race, F17): the relay buffers it and replays it on the join.
    phone.send("early-1");
    phone.send("early-2");
    const control = await register(server.url);
    const openFrame = JSON.parse(await control.next()) as { stream: string };
    const daemon = await open(`${server.url}/v1/accept`);
    daemon.send({ t: "accept", v: 1, stream: openFrame.stream });
    expect(await daemon.next()).toBe("early-1");
    expect(await daemon.next()).toBe("early-2");
    phone.close();
    daemon.close();
    control.close();
  });

  test("the pre-accept buffer is capped: more than 64 KiB closes the phone", async () => {
    const { server, lines } = relay();
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    // Each frame is under the splice cap, but their SUM is over the buffer cap.
    const chunk = "z".repeat(RELAY_CONTROL_LIMITS.preAcceptBytes / 2 + 1);
    phone.send(chunk);
    phone.send(chunk);
    expect((await phone.closed()).code).toBe(RELAY_CLOSE_UNREGISTERED);
    expect(lines.some((line) => line.startsWith("phone-oversize-drop"))).toBe(true);
  });

  test("an accept for a token nobody minted is refused and closed", async () => {
    const { server, lines } = relay();
    const daemon = await open(`${server.url}/v1/accept`);
    daemon.send({ t: "accept", v: 1, stream: "t00xxxxxxxxxxxxxxxxxxx" });
    expect((await daemon.closed()).code).toBe(RELAY_CLOSE_UNREGISTERED);
    expect(lines.some((line) => line.startsWith("accept-refused unknown"))).toBe(true);
  });

  test("a stream token is single-use: a replayed accept is refused", async () => {
    const { server, lines } = relay();
    const control = await register(server.url);
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    const openFrame = JSON.parse(await control.next()) as { stream: string };
    const first = await open(`${server.url}/v1/accept`);
    first.send({ t: "accept", v: 1, stream: openFrame.stream });
    phone.send("x");
    expect(await first.next()).toBe("x");

    const replay = await open(`${server.url}/v1/accept`);
    replay.send({ t: "accept", v: 1, stream: openFrame.stream });
    expect((await replay.closed()).code).toBe(RELAY_CLOSE_UNREGISTERED);
    expect(lines.some((line) => line.startsWith("accept-refused used"))).toBe(true);
    // The real stream is untouched by the replay.
    phone.send("still here");
    expect(await first.next()).toBe("still here");
    first.close();
    phone.close();
    control.close();
  });

  test("a dial refused at the per-ip concurrency cap closes 4429", async () => {
    const { server } = relay({ limits: { concurrentPerIp: 1, dialsPerMinutePerIp: 99 } });
    const first = await open(`${server.url}/d/${ID}/e2e`);
    const second = await open(`${server.url}/d/${ID}/e2e`);
    expect((await second.closed()).code).toBe(RELAY_CLOSE_REFUSED);
    // A refused dial keeps nothing: the first phone still holds its slot.
    expect(server.core.heldCount).toBe(1);
    first.close();
  });

  test("a closed phone gives its per-ip slot back (N+1 sequential dials at cap N)", async () => {
    const { server } = relay({ limits: { concurrentPerIp: 2, dialsPerMinutePerIp: 99 } });
    // Each phone dials, is held and leaves. Without the close releasing the slot
    // the third dial meets an exhausted per-ip cap and is refused `4429` — a
    // leak that after 16 dials locks the address out entirely.
    for (let i = 0; i < 3; i++) {
      const phone = await open(`${server.url}/d/${ID}/e2e`);
      expect(server.core.heldCount).toBe(1);
      phone.close();
      await waitFor(() => server.core.heldCount === 0, "the held dial to be released");
    }
  });

  test("every stream token the relay mints is well-formed and unguessable-looking", async () => {
    const { server } = relay();
    const control = await register(server.url);
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    const openFrame = JSON.parse(await control.next()) as { stream: string };
    expect(openFrame.stream).toHaveLength(RELAY_STREAM_TEXT_LENGTH);
    expect(openFrame.stream).toMatch(/^[A-Za-z0-9_-]{22}$/);
    phone.close();
    control.close();
  });
});

describe("startRelay — logging never leaks a secret, a payload or a whole token", () => {
  test("the captured log has no secret, no stream token and no frame payload", async () => {
    const { server, lines } = relay();
    const control = await register(server.url);
    const phone = await open(`${server.url}/d/${ID}/e2e`);
    const openFrame = JSON.parse(await control.next()) as { stream: string };
    const daemon = await open(`${server.url}/v1/accept`);
    daemon.send({ t: "accept", v: 1, stream: openFrame.stream });
    phone.send("A-THING-NOBODY-LOGS");
    expect(await daemon.next()).toBe("A-THING-NOBODY-LOGS");
    phone.close();
    daemon.close();
    control.close();
    await Bun.sleep(20);

    const joined = lines.join("\n");
    expect(joined.length).toBeGreaterThan(0);
    // The SECRET (the one thing that must never reach a log) — not even a prefix.
    expect(joined.includes(SECRET)).toBe(false);
    expect(joined.includes(SECRET.slice(0, 8))).toBe(false);
    // A stream token is single-use and short-lived, but a log is long-lived.
    expect(joined.includes(openFrame.stream)).toBe(false);
    expect(joined.includes("A-THING-NOBODY-LOGS")).toBe(false);
    // The id IS public (it is in QRs): a short prefix of it is what identifies
    // the line for an operator.
    expect(joined.includes(logPrefix(ID))).toBe(true);
  });
});
