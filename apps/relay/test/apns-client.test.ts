// The APNs transport against a local h2c fake (the Repro's shape, Design 4's
// "overridable for tests"): real HTTP/2 streams, real GOAWAY, real timeouts.
import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import { PUSH_ENVELOPE_CIPHERTEXT_LENGTHS } from "@tentacle/protocol";
import { createApnsClient } from "../src/apns-client.ts";
import { type ApnsJwtSource, createApnsJwtSource } from "../src/apns.ts";

/** What the fake APNs saw for one request (the relay's own headers, asserted). */
interface Seen {
  readonly path: string;
  readonly headers: http2.IncomingHttpHeaders;
  readonly body: string;
}

interface FakeApns {
  readonly origin: string;
  readonly seen: Seen[];
  /** Answer the NEXT request with this status/reason instead of the route's rule. */
  next(status: number, reason?: string): void;
  /** Stop answering anything: the timeout path. */
  hang(): void;
  /** Answer again (the connection is still open unless it was retired). */
  resume(): void;
  /**
   * Make every session open RIGHT NOW deaf: it keeps accepting streams and never
   * answers them, which is what a half-open connection (a NAT drop with no
   * GOAWAY and no error) looks like. A NEW session still answers, so a client
   * that retires the dead one recovers and one that reuses it times out again.
   */
  deafNow(): void;
  /** Retire the connection Apple-style (the client must dial again). */
  goaway(): void;
  readonly connections: number;
  stop(): void;
}

const running: FakeApns[] = [];

/**
 * A fake APNs: `/dead` answers 410, `/stale` answers 403 `ExpiredProviderToken`
 * ONCE (then 200, so a test can see the retry succeed), anything else 200.
 */
function fakeApns(): FakeApns {
  const seen: Seen[] = [];
  const server = http2.createServer();
  /** Explicit answers, in the order they were queued (a script for one test). */
  const queued: { status: number; reason?: string }[] = [];
  let hanging = false;
  /** Sessions that accept streams and never answer (a half-open connection). */
  const deaf = new WeakSet<http2.ServerHttp2Session>();
  let connections = 0;
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    connections += 1;
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const path = String(headers[":path"]);
    let body = "";
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => {
      seen.push({ path, headers, body });
      if (hanging) {
        return; // never answers: the client's deadline must fire
      }
      if (stream.session !== undefined && deaf.has(stream.session as http2.ServerHttp2Session)) {
        return; // a half-open connection: this one is dead, a new session is not
      }
      const answer = queued.shift() ?? ruleFor(path);
      stream.respond({
        ":status": answer.status,
        "content-type": "application/json",
        "apns-id": "00000000-0000-0000-0000-000000000000",
      });
      stream.end(answer.reason === undefined ? "" : JSON.stringify({ reason: answer.reason }));
    });
  });
  const stale = new Set<string>();
  const ruleFor = (path: string): { status: number; reason?: string } => {
    // A token whose hex ENDS in `dead` / `stale` picks these routes (the path is
    // `/3/device/<token>`, so the marker is a suffix of the path).
    if (path.endsWith("dead")) {
      return { status: 410, reason: "Unregistered" };
    }
    if (path.endsWith("stale") && !stale.has(path)) {
      stale.add(path);
      return { status: 403, reason: "ExpiredProviderToken" };
    }
    return { status: 200 };
  };
  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  const fake: FakeApns = {
    origin: `http://127.0.0.1:${port}`,
    seen,
    next(status, reason) {
      queued.push(reason === undefined ? { status } : { status, reason });
    },
    hang() {
      hanging = true;
    },
    resume() {
      hanging = false;
    },
    deafNow() {
      for (const session of sessions) {
        deaf.add(session);
      }
    },
    goaway() {
      for (const session of sessions) {
        session.goaway(http2.constants.NGHTTP2_NO_ERROR);
      }
    },
    get connections() {
      return connections;
    },
    stop() {
      server.close();
    },
  };
  running.push(fake);
  return fake;
}

afterEach(() => {
  for (const fake of running.splice(0)) {
    fake.stop();
  }
});

/** A JWT source that counts mints, so "retried once with a fresh token" is visible. */
function fakeJwt(
  onMint?: () => void,
): ApnsJwtSource & { mints: number; invalidations: number; invalidated: (string | undefined)[] } {
  const source = {
    mints: 0,
    invalidations: 0,
    invalidated: [] as (string | undefined)[],
    jwt() {
      source.mints += 1;
      onMint?.();
      return Promise.resolve(`jwt-${source.mints}`);
    },
    invalidate(jwt?: string) {
      source.invalidations += 1;
      source.invalidated.push(jwt);
    },
  };
  return source;
}

function envelope(): unknown {
  return {
    v: 1,
    k: "A".repeat(12),
    e: "B".repeat(43),
    c: "C".repeat(PUSH_ENVELOPE_CIPHERTEXT_LENGTHS[0] ?? 704),
  };
}

const TOKEN = "a".repeat(64);

function client(fake: FakeApns, jwtSource: ApnsJwtSource, timeoutMs = 1_000) {
  return createApnsClient({
    topic: "so.tentacle.app",
    jwtSource,
    now: () => 1_700_000_000_000,
    timeoutMs,
    origins: { sandbox: fake.origin, production: fake.origin },
  });
}

function push(token = TOKEN, env: "sandbox" | "production" = "sandbox") {
  return { token, env, collapse: "collapse-1", ttl: 3600, payload: { tp: envelope() } };
}

describe("createApnsClient — the real HTTP/2 path", () => {
  test("one push becomes one APNs request with the headers Design 4 names", async () => {
    const fake = fakeApns();
    const jwt = fakeJwt();
    const apns = client(fake, jwt);
    expect(await apns.send(push())).toEqual({ status: "sent" });
    expect(fake.seen).toHaveLength(1);
    const [seen] = fake.seen;
    if (seen === undefined) {
      throw new Error("no request reached the fake APNs");
    }
    expect(seen.path).toBe(`/3/device/${TOKEN}`);
    expect(seen.headers[":method"]).toBe("POST");
    expect(seen.headers["apns-push-type"]).toBe("alert");
    expect(seen.headers["apns-priority"]).toBe("10");
    expect(seen.headers["apns-topic"]).toBe("so.tentacle.app");
    expect(seen.headers["apns-expiration"]).toBe(String(1_700_000_000 + 3600));
    expect(seen.headers["apns-collapse-id"]).toBe("collapse-1");
    expect(seen.headers.authorization).toBe("bearer jwt-1");
    apns.close();
  });

  test("the body is the relay's aps plus the sealed envelope, in BYTES ≤ 4096", async () => {
    const fake = fakeApns();
    const apns = client(fake, fakeJwt());
    await apns.send(push());
    const body = fake.seen[0]?.body ?? "";
    const parsed = JSON.parse(body) as { aps: unknown; tp: unknown };
    expect(parsed.aps).toEqual({
      alert: { title: "tentacle", body: "Open tentacle to see what's new" },
      "mutable-content": 1,
      sound: "default",
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4096);
    apns.close();
  });

  test("concurrent streams on ONE session (HTTP/2 multiplexing is the point)", async () => {
    // Three pushes in flight at once must share the connection: a client that
    // dialed per push would open three sessions and, in production, hit Apple's
    // connection limits instead of its own throughput.
    const fake = fakeApns();
    const apns = client(fake, fakeJwt());
    const outcomes = await Promise.all([
      apns.send(push("1".repeat(64))),
      apns.send(push("2".repeat(64))),
      apns.send(push("3".repeat(64))),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "sent")).toBe(true);
    expect(fake.seen).toHaveLength(3);
    expect(fake.connections).toBe(1);
    apns.close();
  });

  test("one session per ENVIRONMENT (sandbox and production never mix)", async () => {
    const sandbox = fakeApns();
    const production = fakeApns();
    const apns = createApnsClient({
      topic: "so.tentacle.app",
      jwtSource: fakeJwt(),
      origins: { sandbox: sandbox.origin, production: production.origin },
    });
    await apns.send(push(TOKEN, "sandbox"));
    await apns.send(push(TOKEN, "production"));
    expect(sandbox.seen).toHaveLength(1);
    expect(production.seen).toHaveLength(1);
    apns.close();
  });

  test("410 → gone, and 400 BadDeviceToken → gone (the daemon deletes it)", async () => {
    const fake = fakeApns();
    const apns = client(fake, fakeJwt());
    expect(await apns.send(push(`${"a".repeat(63)}0`))).toEqual({ status: "sent" });
    fake.next(400, "BadDeviceToken");
    expect(await apns.send(push())).toEqual({ status: "gone", reason: "BadDeviceToken" });
    apns.close();
  });

  test("410's own body reaches the outcome as `gone`", async () => {
    const fake = fakeApns();
    const apns = client(fake, fakeJwt());
    const outcome = await apns.send({ ...push(), token: `${"e".repeat(60)}dead` });
    expect(outcome).toEqual({ status: "gone" });
    apns.close();
  });

  test("403 ExpiredProviderToken → a fresh JWT and exactly ONE retry", async () => {
    const fake = fakeApns();
    const jwt = fakeJwt();
    const apns = client(fake, jwt);
    const outcome = await apns.send({ ...push(), token: `${"f".repeat(60)}stale` });
    expect(outcome).toEqual({ status: "sent" });
    // Two requests: the rejected one and the retry, each with its own token.
    expect(fake.seen).toHaveLength(2);
    expect(fake.seen[0]?.headers.authorization).toBe("bearer jwt-1");
    expect(fake.seen[1]?.headers.authorization).toBe("bearer jwt-2");
    expect(jwt.invalidations).toBe(1);
    apns.close();
  });

  test("a persistent ExpiredProviderToken does not retry a third time", async () => {
    const fake = fakeApns();
    fake.next(403, "ExpiredProviderToken");
    fake.next(403, "ExpiredProviderToken");
    const apns = client(fake, fakeJwt());
    const outcome = await apns.send(push());
    expect(outcome).toEqual({ status: "rejected", reason: "ExpiredProviderToken" });
    expect(fake.seen).toHaveLength(2);
    apns.close();
  });

  test("429 → throttled, 500 → unavailable", async () => {
    const fake = fakeApns();
    const apns = client(fake, fakeJwt());
    fake.next(429);
    expect((await apns.send(push())).status).toBe("throttled");
    fake.next(500, "ServiceUnavailable");
    expect(await apns.send(push())).toEqual({
      status: "unavailable",
      reason: "ServiceUnavailable",
    });
    apns.close();
  });

  test("a hung request times out → unavailable, and never throws", async () => {
    const fake = fakeApns();
    fake.hang();
    const apns = client(fake, fakeJwt(), 100);
    const started = Date.now();
    expect(await apns.send(push())).toEqual({ status: "unavailable", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    apns.close();
  });

  test("a timeout RETIRES the session, so a half-open connection costs one push", async () => {
    // Finding 3 of the P4 review: `req.close()` alone leaves a session that never
    // answered (an idle NAT drop sends no GOAWAY and no error) in the map, so
    // every later push would be `unavailable/timeout` until the kernel gives up
    // on the socket — minutes of silently dead pushes from a relay that looks
    // healthy. The fake makes the session deaf AFTER it is dialed: a client that
    // retires it dials a fresh, working one; a client that reuses it times out
    // again.
    const fake = fakeApns();
    const apns = client(fake, fakeJwt(), 100);
    // One working push first, so exactly ONE session exists and it can go deaf.
    expect(await apns.send(push())).toEqual({ status: "sent" });
    fake.deafNow();
    expect(await apns.send(push())).toEqual({ status: "unavailable", reason: "timeout" });
    expect(fake.connections).toBe(1);
    // The property: the same client recovers with NO restart and NO second wait.
    expect(await apns.send(push())).toEqual({ status: "sent" });
    expect(fake.connections).toBe(2);
    apns.close();
  });

  test("an ExpiredProviderToken retry names the FAILED token, so a sibling's fresh one survives", async () => {
    // Finding 2's second half. Apple answers a token that changes too often with
    // a 429 `TooManyProviderTokenUpdates`, throttling the real pushes: so an
    // `ExpiredProviderToken` must invalidate the token THAT failed, not whatever
    // a sibling push already replaced it with. The source (tested in
    // `apns.test.ts`) ignores an invalidation of a token it no longer holds.
    const fake = fakeApns();
    fake.next(403, "ExpiredProviderToken");
    const jwt = fakeJwt();
    const apns = client(fake, jwt);
    expect(await apns.send(push())).toEqual({ status: "sent" });
    expect(jwt.invalidated).toEqual(["jwt-1"]);
    // The retry really went out on the fresh token.
    expect(String(fake.seen[1]?.headers.authorization)).toBe("bearer jwt-2");
    apns.close();
  });

  test("GOAWAY → the next push dials a fresh session (reconnect, not a loop)", async () => {
    const fake = fakeApns();
    const apns = client(fake, fakeJwt());
    expect((await apns.send(push())).status).toBe("sent");
    expect(fake.connections).toBe(1);
    fake.goaway();
    // Let the client observe the GOAWAY before the next push.
    await Bun.sleep(50);
    // Two layers answer a retired connection, and BOTH are pinned here: the
    // `goaway` handler retires the session, and `sessionFor` re-checks the
    // session's own state. Either alone reconnects, so neither is asserted by
    // the connection count — the property is that after a GOAWAY the push still
    // SUCCEEDS on a new session, which a client with no recovery at all fails.
    expect((await apns.send(push())).status).toBe("sent");
    expect(fake.connections).toBe(2);
    apns.close();
  });

  test("a request on an already-GOAWAY'd session is `unavailable`, never a throw", async () => {
    // The other half of the recovery: a push that races the GOAWAY must be a
    // status the daemon audits, not an exception out of the frame loop. This is
    // the path `sessionFor`'s `request()` try/catch exists for.
    const fake = fakeApns();
    const apns = client(fake, fakeJwt());
    expect((await apns.send(push())).status).toBe("sent");
    // Retire the session WITHOUT letting the client's listener drop it first: a
    // client whose factory hands the same dead session back must still answer.
    let dead: http2.ClientHttp2Session | undefined;
    const one = createApnsClient({
      topic: "so.tentacle.app",
      jwtSource: fakeJwt(),
      timeoutMs: 500,
      origins: { sandbox: fake.origin, production: fake.origin },
      connect: (origin) => {
        dead = http2.connect(origin);
        return dead;
      },
    });
    expect((await one.send(push())).status).toBe("sent");
    const session = dead;
    if (session === undefined) {
      throw new Error("no session was created");
    }
    session.goaway(http2.constants.NGHTTP2_NO_ERROR);
    session.destroy();
    const outcome = await one.send(push());
    // Whatever the socket layer says, it is an outcome: no rejection escapes.
    expect(["unavailable", "sent"]).toContain(outcome.status);
    one.close();
    apns.close();
  });

  test("an unreachable APNs is `unavailable`, never a throw into the frame loop", async () => {
    // A port nobody listens on: the socket error must become an outcome, because
    // a relay that throws here loses every daemon on it.
    const apns = createApnsClient({
      topic: "so.tentacle.app",
      jwtSource: fakeJwt(),
      timeoutMs: 300,
      origins: { sandbox: "http://127.0.0.1:1", production: "http://127.0.0.1:1" },
    });
    const outcome = await apns.send(push());
    expect(["unavailable", "rejected"]).toContain(outcome.status);
    apns.close();
  });

  test("a payload the schema refuses is `rejected` and sends nothing", async () => {
    const fake = fakeApns();
    const apns = client(fake, fakeJwt());
    const outcome = await apns.send({ ...push(), payload: { aps: { alert: "text" } } });
    expect(outcome).toEqual({ status: "rejected", reason: "payload" });
    expect(fake.seen).toHaveLength(0);
    apns.close();
  });

  test("a real JWT source signs every request it makes (the two layers fit)", async () => {
    // The client takes any `ApnsJwtSource`; this pins that the REAL one works
    // through it, so a signature/format mismatch cannot hide behind a fake.
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const jwtSource = createApnsJwtSource({
      config: { keyId: "ABC123DEFG", teamId: "TEAM123456", topic: "so.tentacle.app" },
      key: privateKey,
      now: () => 1_700_000_000_000,
    });
    const fake = fakeApns();
    const apns = client(fake, jwtSource);
    expect((await apns.send(push())).status).toBe("sent");
    const authorization = String(fake.seen[0]?.headers.authorization ?? "");
    expect(authorization.startsWith("bearer ")).toBe(true);
    expect(authorization.split(".")).toHaveLength(3);
    apns.close();
  });
});
