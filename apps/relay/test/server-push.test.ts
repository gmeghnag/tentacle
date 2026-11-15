// The relay's `push` path end to end over a real WebSocket and a real HTTP/2
// fake APNs (docs/feat/mobile-push.md Design 4 + F10/C1): who may push, what the
// caps do, what reaches Apple, and what the daemon is told.
import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import {
  PUSH_ENVELOPE_CIPHERTEXT_LENGTHS,
  RELAY_PUSH_TTL_MAX_SECONDS,
  type RelayFeature,
  encodeBase64Url,
} from "@tentacle/protocol";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { type ApnsClient, createApnsClient } from "../src/apns-client.ts";
import type { ApnsJwtSource } from "../src/apns.ts";
import { APNS_MAX_PAYLOAD_BYTES } from "../src/apns.ts";
import { RELAY_LIMITS, RelayCore, type RelayLimits } from "../src/relay-core.ts";
import { type RunningRelay, loggableApnsReason, startRelay } from "../src/server.ts";

const SECRET_BYTE = 11;
const SECRET = encodeBase64Url(new Uint8Array(32).fill(SECRET_BYTE));
/** A second registered id (its own secret, so its own derived id). */
const OTHER_SECRET = encodeBase64Url(new Uint8Array(32).fill(12));
const ID = relayIdOf(new Uint8Array(32).fill(SECRET_BYTE));
const TOKEN = "a".repeat(64);

/** A JWT source that never signs: the fake APNs does not check the signature. */
const fakeJwt: ApnsJwtSource = {
  jwt: () => Promise.resolve("header.claims.signature"),
  invalidate: () => {},
};

/** What the fake APNs saw for one request. */
interface SeenRequest {
  readonly path: string;
  readonly headers: http2.IncomingHttpHeaders;
  readonly body: string;
}

/** A local h2c APNs: 200 normally, `410` for a token ending in `dead`. */
function fakeApns(): { origin: string; seen: SeenRequest[]; connections(): number; stop(): void } {
  const seen: SeenRequest[] = [];
  let connections = 0;
  const server = http2.createServer();
  server.on("session", () => {
    connections += 1;
  });
  server.on("stream", (stream, headers) => {
    const path = String(headers[":path"]);
    let body = "";
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => {
      seen.push({ path, headers, body });
      if (path.endsWith("dead")) {
        stream.respond({ ":status": 410, "content-type": "application/json" });
        stream.end(JSON.stringify({ reason: "Unregistered" }));
        return;
      }
      // A hex suffix, because the token's schema is lowercase hex: `5eed` routes
      // a push the fake answers late (the out-of-order case).
      if (path.endsWith("5eed")) {
        // Answer after the test's assertions have run: the out-of-order case.
        setTimeout(() => {
          stream.respond({ ":status": 200 });
          stream.end("");
        }, 40);
        return;
      }
      stream.respond({ ":status": 200 });
      stream.end("");
    });
  });
  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    connections: () => connections,
    stop: () => server.close(),
  };
}

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const stop of cleanup.splice(0)) {
    stop();
  }
});

/** A relay with a working fake APNs, so `ready.features` carries `"push"`. */
function pushRelay(options: Parameters<typeof startRelay>[0] = {}): {
  server: RunningRelay;
  apns: ReturnType<typeof fakeApns>;
  lines: string[];
} {
  const apns = fakeApns();
  const lines: string[] = [];
  const client: ApnsClient = createApnsClient({
    topic: "so.tentacle.app",
    jwtSource: fakeJwt,
    origins: { sandbox: apns.origin, production: apns.origin },
  });
  const server = startRelay({
    host: "127.0.0.1",
    port: 0,
    sweepMs: 10,
    onLog: (line) => lines.push(line),
    apns: { client, jwtSource: fakeJwt, topic: "so.tentacle.app" },
    ...options,
  });
  cleanup.push(() => {
    server.stop();
    apns.stop();
  });
  return { server, apns, lines };
}

/** A relay with NO APNs key: it must announce no features and refuse a push. */
function bareRelay(options: Parameters<typeof startRelay>[0] = {}): {
  server: RunningRelay;
  lines: string[];
} {
  const lines: string[] = [];
  const server = startRelay({
    host: "127.0.0.1",
    port: 0,
    sweepMs: 10,
    onLog: (line) => lines.push(line),
    ...options,
  });
  cleanup.push(() => server.stop());
  return { server, lines };
}

interface TestSocket {
  readonly received: string[];
  send(frame: unknown): void;
  next(timeoutMs?: number): Promise<string>;
  closed(timeoutMs?: number): Promise<{ code: number }>;
  close(): void;
}

function open(url: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received: string[] = [];
    const pending: string[] = [];
    const waiters: ((frame: string) => void)[] = [];
    const closeWaiters: ((close: { code: number }) => void)[] = [];
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
      for (const waiter of closeWaiters.splice(0)) {
        waiter({ code: event.code });
      }
      for (const waiter of waiters.splice(0)) {
        waiter("");
      }
    };
    ws.onerror = () => reject(new Error(`socket error: ${url}`));
    ws.onopen = () =>
      resolve({
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
            const timer = setTimeout(() => rej(new Error("no frame")), timeoutMs);
            waiters.push((frame) => {
              clearTimeout(timer);
              res(frame);
            });
          });
        },
        closed(timeoutMs = 2_000) {
          return new Promise<{ code: number }>((res, rej) => {
            const timer = setTimeout(() => rej(new Error("no close")), timeoutMs);
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

/** A registered control socket, with `ready` consumed. */
async function control(base: string): Promise<TestSocket> {
  const socket = await open(`${base}/v1/daemon`);
  socket.send({ t: "hello", v: 1, secret: SECRET });
  const ready = JSON.parse(await socket.next()) as { t: string };
  expect(ready.t).toBe("ready");
  return socket;
}

function envelope(): unknown {
  return {
    v: 1,
    k: "A".repeat(12),
    e: "B".repeat(43),
    c: "C".repeat(PUSH_ENVELOPE_CIPHERTEXT_LENGTHS[0] ?? 704),
  };
}

function pushFrame(n = 1, token = TOKEN) {
  return {
    t: "push",
    n,
    token,
    env: "sandbox",
    collapse: "collapse-1",
    ttl: 3600,
    payload: { tp: envelope() },
  };
}

/** Poll until `check()` is true. */
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

describe("ready.features — `push` only when this relay can deliver", () => {
  test("with a working APNs path, ready announces exactly `push`", async () => {
    const { server } = pushRelay();
    const socket = await open(`${server.url}/v1/daemon`);
    socket.send({ t: "hello", v: 1, secret: SECRET });
    expect(JSON.parse(await socket.next())).toEqual({
      t: "ready",
      v: 1,
      id: ID,
      features: ["push"],
    });
    socket.close();
  });

  test("with no key, ready announces NO features (a daemon must never send a push)", async () => {
    // F4/C1: a relay without an APNs key that claimed `push` would swallow every
    // push silently, and the phone would show nothing with no error anywhere.
    const { server } = bareRelay();
    const socket = await open(`${server.url}/v1/daemon`);
    socket.send({ t: "hello", v: 1, secret: SECRET });
    expect((JSON.parse(await socket.next()) as { features: string[] }).features).toEqual([]);
    socket.close();
  });
});

describe("RelayCore.push — the decision, in isolation", () => {
  /** A core with an injected clock, so "the window rolled over" is not a 60 s wait. */
  function core(limits: Partial<RelayLimits> = {}, features: RelayFeature[] = ["push"]) {
    let at = 1_000_000;
    const instance = new RelayCore({
      now: () => at,
      features,
      ...(Object.keys(limits).length === 0 ? {} : { limits }),
    });
    return {
      core: instance,
      advance: (ms: number) => {
        at += ms;
      },
    };
  }

  function hello(instance: RelayCore): void {
    instance.hello({ socket: "d1", ip: "203.0.113.9", v: 1, secret: SECRET });
  }

  function frame(overrides: Partial<Parameters<RelayCore["push"]>[0]> = {}) {
    return {
      socket: "d1",
      n: 1,
      token: TOKEN,
      env: "sandbox" as const,
      collapse: "c",
      ttl: 3600,
      payload: { tp: envelope() },
      payloadBytes: 900,
      ...overrides,
    };
  }

  test("a registered socket's push is handed on with the request intact", () => {
    const { core: instance } = core();
    hello(instance);
    const decision = instance.push(frame({ n: 4 }));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.request).toMatchObject({ socket: "d1", n: 4, token: TOKEN });
    }
  });

  test("a socket that has not completed hello is refused AND closed", () => {
    const { core: instance } = core();
    const decision = instance.push(frame());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("unregistered");
      expect(decision.effects).toContainEqual({ kind: "close", target: "d1", code: 1008 });
    }
  });

  test("a relay with no `push` feature refuses instead of pretending", () => {
    // Defence in depth: a correct daemon never sends one (it checks `features`),
    // so this is the hand-written-frame case, and it must be a status.
    const { core: instance } = core({}, []);
    hello(instance);
    const decision = instance.push(frame());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("no-push");
    }
  });

  test("the body's byte bound is enforced by the core, not only the schema", () => {
    // Unreachable through a validated frame (the three ciphertext sizes fit), and
    // kept as the relay's own ceiling on what it will hand Apple: an
    // oversized body is `rejected`, never truncated and never sent.
    const { core: instance } = core();
    hello(instance);
    const decision = instance.push(frame({ payloadBytes: APNS_MAX_PAYLOAD_BYTES + 1 }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("payload");
    }
  });

  test("the window rolls over after a minute (the cap is not permanent)", () => {
    const { core: instance, advance } = core({
      pushesPerMinutePerId: 1,
      pushesPerMinutePerToken: 1,
    });
    hello(instance);
    expect(instance.push(frame({ n: 1 })).ok).toBe(true);
    expect(instance.push(frame({ n: 2 })).ok).toBe(false);
    advance(60_000);
    expect(instance.push(frame({ n: 3 })).ok).toBe(true);
  });

  test("a reconnect of the SAME id does not launder its per-ID window (F10)", () => {
    // A `controlClosed` that also dropped the windows let a daemon bounce its
    // control socket for a fresh 120/min per id (and a fresh 30/min per token)
    // inside one minute. The windows are keyed by the ID and the TOKEN, and
    // neither is a property of the socket. The token cap is set high here, so the
    // refusal below can only be the per-ID one.
    const { core: instance } = core({ pushesPerMinutePerId: 1, pushesPerMinutePerToken: 100 });
    hello(instance);
    expect(instance.push(frame({ n: 1 })).ok).toBe(true);
    expect(instance.push(frame({ n: 2 })).ok).toBe(false);
    instance.controlClosed("d1");
    hello(instance);
    // The same id, back on a NEW socket, is still capped for the rest of the
    // minute: the per-id window survived the reconnect.
    const decision = instance.push(frame({ n: 3 }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("capped");
    }
    // And the per-token budget is not double-charged by it either: the refused
    // push charged nothing.
    const { core: fresh } = core({ pushesPerMinutePerId: 100, pushesPerMinutePerToken: 1 });
    hello(fresh);
    expect(fresh.push(frame({ n: 1 })).ok).toBe(true);
    fresh.controlClosed("d1");
    hello(fresh);
    expect(fresh.push(frame({ n: 2 })).ok).toBe(false);
  });

  test("the relay-wide token windows are bounded too (a token flood evicts the oldest)", () => {
    // The per-token map is fed by anything a daemon names, so it needs the same
    // bound the per-id map has. Past `maxTrackedPushTokens` the oldest entry is
    // dropped and that token starts a fresh window: a fairness reset that bypasses
    // nothing, because the per-ID window still bounds each daemon's total.
    const { core: instance } = core({
      pushesPerMinutePerId: 1_000,
      pushesPerMinutePerToken: 1,
      maxTrackedPushTokens: 2,
    });
    hello(instance);
    expect(instance.push(frame({ n: 1, token: "a".repeat(64) })).ok).toBe(true);
    expect(instance.push(frame({ n: 2, token: "b".repeat(64) })).ok).toBe(true);
    expect(instance.push(frame({ n: 3, token: "c".repeat(64) })).ok).toBe(true);
    // Three tokens through a two-entry map: the FIRST was evicted, so it is
    // admitted again, while the newest is still capped.
    expect(instance.push(frame({ n: 4, token: "a".repeat(64) })).ok).toBe(true);
    expect(instance.push(frame({ n: 5, token: "c".repeat(64) })).ok).toBe(false);
  });

  test("the per-id push windows are bounded, so an id flood cannot grow them forever", () => {
    // Keeping the windows across reconnects must not make the map an unbounded
    // per-id store. Past `maxTrackedPushIds` the oldest entry is dropped and that
    // id starts a fresh window — a fairness reset, since the relay-wide per-token
    // window still bounds any real spray.
    const { core: instance } = core({
      pushesPerMinutePerId: 1,
      pushesPerMinutePerToken: 1_000,
      maxTrackedPushIds: 2,
    });
    const register = (socket: string, fill: number): void => {
      instance.hello({
        socket,
        ip: "203.0.113.9",
        v: 1,
        secret: encodeBase64Url(new Uint8Array(32).fill(fill)),
      });
    };
    register("d1", 11);
    expect(instance.push(frame({ n: 1, socket: "d1" })).ok).toBe(true);
    register("d2", 12);
    expect(instance.push(frame({ n: 1, socket: "d2" })).ok).toBe(true);
    register("d3", 13);
    expect(instance.push(frame({ n: 1, socket: "d3" })).ok).toBe(true);
    // Three windows through a two-entry map: the FIRST id's was evicted, so it is
    // admitted again on a reconnect, while the newest is still capped.
    register("d1b", 11);
    expect(instance.push(frame({ n: 2, socket: "d1b" })).ok).toBe(true);
    expect(instance.push(frame({ n: 2, socket: "d3" })).ok).toBe(false);
  });

  test("the per-TOKEN cap is relay-wide: a second id gets no extra token budget (F10)", () => {
    // `pushesPerMinutePerToken` bounds what one DEVICE can be sprayed with. Scoping
    // it inside one id's bookkeeping made the real bound `30 × ids`, and any
    // secret is an id — the one bound F10 is about would have been unenforceable.
    const { core: instance } = core({ pushesPerMinutePerId: 100, pushesPerMinutePerToken: 2 });
    hello(instance);
    expect(instance.push(frame({ n: 1 })).ok).toBe(true);
    expect(instance.push(frame({ n: 2 })).ok).toBe(true);
    instance.hello({ socket: "d2", ip: "203.0.113.10", v: 1, secret: OTHER_SECRET });
    const decision = instance.push(frame({ n: 3, socket: "d2" }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("capped");
    }
  });

  test("a refusal's `push-result` echoes `n`, so the daemon can correlate it", () => {
    const { core: instance } = core({}, []);
    hello(instance);
    const decision = instance.push(frame({ n: 41 }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.effects).toContainEqual({
        kind: "send",
        target: "d1",
        frame: { t: "push-result", n: 41, status: "rejected", reason: "no-push" },
      });
    }
  });
});

describe("a `push` frame — who may send one, and what it becomes", () => {
  test("a registered daemon's push reaches APNs and answers `push-result` sent", async () => {
    const { server, apns } = pushRelay();
    const socket = await control(server.url);
    socket.send(pushFrame(7));
    expect(JSON.parse(await socket.next())).toEqual({ t: "push-result", n: 7, status: "sent" });
    await waitFor(() => apns.seen.length === 1, "the APNs request");
    const [seen] = apns.seen;
    expect(seen?.path).toBe(`/3/device/${TOKEN}`);
    const body = JSON.parse(seen?.body ?? "{}") as {
      aps: { alert: { title: string } };
      tp: unknown;
    };
    expect(body.aps.alert.title).toBe("tentacle");
    expect(body).toHaveProperty("tp");
    socket.close();
  });

  test("a push BEFORE hello is refused and closes the socket (only a registered id pushes)", async () => {
    // The one property that keeps a stranger's socket from becoming a spamming
    // gateway. Mutation: drop the `idOfControl` check in the core → this passes a
    // push straight through and the test fails.
    const { server, apns } = pushRelay();
    const socket = await open(`${server.url}/v1/daemon`);
    socket.send(pushFrame(3));
    expect(JSON.parse(await socket.next())).toEqual({
      t: "push-result",
      n: 3,
      status: "rejected",
      reason: "unregistered",
    });
    expect((await socket.closed()).code).toBe(1008);
    // Nothing was delivered.
    expect(apns.seen).toHaveLength(0);
    expect(server.core.registeredCount).toBe(0);
  });

  test("a relay with no APNs key refuses the frame rather than dropping it", async () => {
    const { server, lines } = bareRelay();
    const socket = await control(server.url);
    socket.send(pushFrame(4));
    expect(JSON.parse(await socket.next())).toEqual({
      t: "push-result",
      n: 4,
      status: "rejected",
      reason: "no-push",
    });
    // The socket survives: one bad frame must not cost the daemon reachability.
    socket.send({ t: "ping" });
    expect(JSON.parse(await socket.next())).toEqual({ t: "pong" });
    expect(lines.some((line) => line.includes("push-refused"))).toBe(true);
    socket.close();
  });

  test("an APNs reason with a newline is logged as `other`, never at its own length (L1)", async () => {
    // `reason` is REMOTE input (Apple's error body) and the log is long-lived: a
    // raw value could carry a newline (forging a second line) or a kilobyte of
    // junk into the journal. The bound lives in `loggableApnsReason`.
    expect(loggableApnsReason("BadDeviceToken")).toBe("BadDeviceToken");
    expect(loggableApnsReason("ExpiredProviderToken")).toBe("ExpiredProviderToken");
    expect(loggableApnsReason("timeout")).toBe("timeout");
    expect(loggableApnsReason("Bad\nToken")).toBe("other");
    expect(loggableApnsReason("x".repeat(200))).toBe("other");
    expect(loggableApnsReason("")).toBe("other");
    // And end to end: a frame that is refused logs only a bounded word.
    const { server, lines } = bareRelay();
    const socket = await control(server.url);
    socket.send(pushFrame(6));
    await socket.next();
    socket.close();
    await Bun.sleep(20);
    for (const line of lines) {
      expect(line).not.toMatch(/[\n\r]/);
    }
  });

  test("410 from APNs reaches the daemon as `gone` (it deletes that registration)", async () => {
    const { server } = pushRelay();
    const socket = await control(server.url);
    socket.send(pushFrame(5, `${"e".repeat(60)}dead`));
    expect(JSON.parse(await socket.next())).toEqual({ t: "push-result", n: 5, status: "gone" });
    socket.close();
  });

  test("answers can arrive OUT OF ORDER (a slow push does not block a fast one)", async () => {
    // Design 3: `n` correlates, and nothing may assume a reply follows its
    // request. If pushes were serialized, the fast one would have to wait.
    const { server } = pushRelay();
    const socket = await control(server.url);
    socket.send(pushFrame(1, `${"f".repeat(60)}5eed`));
    socket.send(pushFrame(2));
    const first = JSON.parse(await socket.next()) as { n: number };
    const second = JSON.parse(await socket.next()) as { n: number };
    expect([first.n, second.n]).toEqual([2, 1]);
    socket.close();
  });

  test("the per-TOKEN limit is 30/min: the 31st is `throttled`, never silent (F10)", async () => {
    const { server, apns } = pushRelay();
    const socket = await control(server.url);
    const limit = RELAY_LIMITS.pushesPerMinutePerToken;
    for (let n = 0; n < limit; n++) {
      socket.send(pushFrame(n));
    }
    const answers: { status: string }[] = [];
    for (let n = 0; n < limit; n++) {
      answers.push(JSON.parse(await socket.next()) as { status: string });
    }
    expect(answers.every((answer) => answer.status === "sent")).toBe(true);
    socket.send(pushFrame(limit));
    expect(JSON.parse(await socket.next())).toEqual({
      t: "push-result",
      n: limit,
      status: "throttled",
      reason: "capped",
    });
    await waitFor(() => apns.seen.length === limit, "exactly the admitted pushes");
    // The refusal really delivered nothing.
    expect(apns.seen).toHaveLength(limit);
    socket.close();
  });

  test("a SECOND token still gets its own budget (the cap is per token, not global)", async () => {
    const { server } = pushRelay({ limits: { pushesPerMinutePerToken: 1 } });
    const socket = await control(server.url);
    socket.send(pushFrame(1, "a".repeat(64)));
    expect((JSON.parse(await socket.next()) as { status: string }).status).toBe("sent");
    socket.send(pushFrame(2, "a".repeat(64)));
    expect((JSON.parse(await socket.next()) as { status: string }).status).toBe("throttled");
    socket.send(pushFrame(3, "b".repeat(64)));
    expect((JSON.parse(await socket.next()) as { status: string }).status).toBe("sent");
    socket.close();
  });

  test("the per-ID limit refuses the 121st push of one minute (F10's id bound)", async () => {
    const { server } = pushRelay({
      limits: { pushesPerMinutePerId: 2, pushesPerMinutePerToken: 100 },
    });
    const socket = await control(server.url);
    socket.send(pushFrame(1, "a".repeat(64)));
    expect((JSON.parse(await socket.next()) as { status: string }).status).toBe("sent");
    socket.send(pushFrame(2, "b".repeat(64)));
    expect((JSON.parse(await socket.next()) as { status: string }).status).toBe("sent");
    socket.send(pushFrame(3, "c".repeat(64)));
    expect(JSON.parse(await socket.next())).toEqual({
      t: "push-result",
      n: 3,
      status: "throttled",
      reason: "capped",
    });
    socket.close();
  });

  test("the caps are per registered ID: a second daemon has its own budget", async () => {
    const { server } = pushRelay({
      limits: { pushesPerMinutePerId: 1, pushesPerMinutePerToken: 100 },
    });
    const first = await control(server.url);
    first.send(pushFrame(1, "a".repeat(64)));
    expect((JSON.parse(await first.next()) as { status: string }).status).toBe("sent");
    first.send(pushFrame(2, "b".repeat(64)));
    expect((JSON.parse(await first.next()) as { status: string }).status).toBe("throttled");
    const other = await open(`${server.url}/v1/daemon`);
    other.send({ t: "hello", v: 1, secret: encodeBase64Url(new Uint8Array(32).fill(12)) });
    await other.next();
    other.send(pushFrame(1, "c".repeat(64)));
    expect((JSON.parse(await other.next()) as { status: string }).status).toBe("sent");
    first.close();
    other.close();
  });

  test("a second ID does NOT get its own per-token budget (F10's bound is per device)", async () => {
    // The end-to-end half of the core test: over real sockets, two registered ids
    // pushing to the SAME device token share one 30/min budget. With the window
    // scoped per id, a third party registered here could spray 30 × ids.
    const { server } = pushRelay({
      limits: { pushesPerMinutePerId: 100, pushesPerMinutePerToken: 1 },
    });
    const first = await control(server.url);
    first.send(pushFrame(1, "a".repeat(64)));
    expect((JSON.parse(await first.next()) as { status: string }).status).toBe("sent");
    const other = await open(`${server.url}/v1/daemon`);
    other.send({ t: "hello", v: 1, secret: encodeBase64Url(new Uint8Array(32).fill(12)) });
    await other.next();
    other.send(pushFrame(2, "a".repeat(64)));
    expect(JSON.parse(await other.next())).toEqual({
      t: "push-result",
      n: 2,
      status: "throttled",
      reason: "capped",
    });
    // A different token from that same second id is still admitted: the cap is
    // per DEVICE, not per relay.
    other.send(pushFrame(3, "b".repeat(64)));
    expect((JSON.parse(await other.next()) as { status: string }).status).toBe("sent");
    first.close();
    other.close();
  });

  test("a malformed push is a close (the frame schema), not a guess", async () => {
    const { server } = pushRelay();
    const socket = await control(server.url);
    // A token that is not lowercase hex: the schema refuses the whole frame.
    socket.send({ ...pushFrame(9), token: "NOT-A-TOKEN" });
    expect((await socket.closed()).code).toBe(1008);
  });

  test("a ttl past Apple's maximum is refused by the schema (never a header Apple rejects)", async () => {
    const { server } = pushRelay();
    const socket = await control(server.url);
    socket.send({ ...pushFrame(9), ttl: RELAY_PUSH_TTL_MAX_SECONDS + 1 });
    expect((await socket.closed()).code).toBe(1008);
  });

  test("an `aps` a daemon slips into the payload never reaches Apple's body", async () => {
    // The schema strips it (P2) and the body builder strips it again (P4): the
    // banner text iOS shows can only ever be the relay's constant.
    const { server, apns } = pushRelay();
    const socket = await control(server.url);
    socket.send({
      ...pushFrame(1),
      payload: { tp: envelope(), aps: { alert: { title: "rm -rf /", body: "tap" } } },
    });
    expect((JSON.parse(await socket.next()) as { status: string }).status).toBe("sent");
    await waitFor(() => apns.seen.length === 1, "the APNs request");
    const body = apns.seen[0]?.body ?? "";
    expect(body).not.toContain("rm -rf");
    expect((JSON.parse(body) as { aps: { alert: { title: string } } }).aps.alert.title).toBe(
      "tentacle",
    );
    socket.close();
  });

  test("no log line carries the key, the JWT, the sealed payload, or more than 8 chars of the token", async () => {
    const { server, lines } = pushRelay();
    const socket = await control(server.url);
    socket.send(pushFrame(1));
    await socket.next();
    await waitFor(() => lines.some((line) => line.startsWith("push ")), "the delivery log line");
    const joined = lines.join("\n");
    expect(joined).not.toContain(TOKEN);
    expect(joined).toContain(TOKEN.slice(0, 8));
    expect(joined).not.toContain("header.claims.signature");
    expect(joined).not.toContain("PRIVATE KEY");
    // The sealed envelope's ciphertext is content-adjacent metadata: a log line
    // that carried it would archive every push's bytes on the relay host.
    const ciphertext = (envelope() as { c: string }).c;
    expect(joined).not.toContain(ciphertext);
    socket.close();
  });

  test("a push frame on a /v1/accept leg is still malformed there (routes stay separate)", async () => {
    const { server } = pushRelay();
    const leg = await open(`${server.url}/v1/accept`);
    leg.send(pushFrame(1));
    expect((await leg.closed()).code).toBe(1008);
  });
});
