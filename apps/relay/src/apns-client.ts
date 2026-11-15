/**
 * The APNs transport: one HTTP/2 session per environment, reconnected when Apple
 * closes it, one request per push with a hard timeout
 * (docs/feat/mobile-push.md Design 4). Every DECISION — the JWT's cache, the
 * request's headers, what a status means — is in `apns.ts`, pure; this file is
 * sockets only, which is why it can be read as plumbing (AGENTS §7).
 *
 * The only thing it can do with content is hand a daemon's SEALED envelope to
 * Apple: the body comes from `apnsPayloadOf`, whose `aps` is the relay's own
 * constant. No daemon text ever reaches a banner (F9's boundary).
 */
import http2 from "node:http2";
import type { PushEnvironment } from "@tentacle/protocol";
import {
  APNS_DEFAULT_ORIGINS,
  APNS_REQUEST_TIMEOUT_MS,
  APNS_TIMEOUT_OUTCOME,
  type ApnsJwtSource,
  type ApnsLiveActivity,
  type ApnsOutcome,
  apnsOutcomeOf,
  apnsPayloadOf,
  apnsRequestOf,
  liveActivityPayloadOf,
  liveActivityRequestOf,
} from "./apns.ts";

/** What the relay asks the client to deliver: one sealed push to one device. */
export interface ApnsSendInput {
  /** The raw APNs device token (lowercase hex; the frame schema validated it). */
  readonly token: string;
  readonly env: PushEnvironment;
  /** The opaque `apns-collapse-id` the daemon chose (≤ 64 header-safe chars). */
  readonly collapse: string;
  /** `apns-expiration` from now, in seconds (≤ 86 400). */
  readonly ttl: number;
  /** `{tp: <sealed envelope>}` — never `aps`. */
  readonly payload: unknown;
}

export interface ApnsClientOptions {
  /** The bundle id and JWT identities (config only, never daemon-supplied). */
  readonly topic: string;
  /** The provider token source (`createApnsJwtSource`, or a fake in a test). */
  readonly jwtSource: ApnsJwtSource;
  /** Injected clock (the `apns-expiration` header is derived from it). */
  readonly now?: () => number;
  /** Per-environment origins: Apple's by default, a local h2c fake in a test. */
  readonly origins?: Partial<Record<PushEnvironment, string>>;
  /** Injected for a test that must not wait 10 s for the timeout path. */
  readonly timeoutMs?: number;
  /** Injected session factory (the tests' fake APNs is a real h2c server). */
  readonly connect?: (origin: string) => http2.ClientHttp2Session;
}

export interface ApnsClient {
  /** Deliver one push. Never throws: every failure is an `ApnsOutcome`. */
  send(input: ApnsSendInput): Promise<ApnsOutcome>;
  /** Deliver one Live Activity push (docs/feat/mobile-live-activity.md L4). Never throws. */
  sendLiveActivity(input: ApnsLiveActivitySendInput): Promise<ApnsOutcome>;
  /** Drop both sessions (the relay's shutdown path). */
  close(): void;
}

/**
 * One activity push to deliver: the update token, its environment, the priority
 * the core decided (already downgraded if the scarce budget was spent) and the
 * clear `la` block. There is no `collapse`/`ttl` — an activity is not a banner.
 */
export interface ApnsLiveActivitySendInput {
  readonly token: string;
  readonly env: PushEnvironment;
  readonly priority: 5 | 10;
  readonly la: ApnsLiveActivity;
}

/** A session's key: the origin it dials (one per environment, per Design 4). */
type Origin = string;

/**
 * Create the client. Sessions are created on first use and kept: APNs multiplexes
 * every push to an environment over one connection, which is the whole reason
 * HTTP/2 is required.
 */
export function createApnsClient(options: ApnsClientOptions): ApnsClient {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? APNS_REQUEST_TIMEOUT_MS;
  const connect = options.connect ?? ((origin: string) => http2.connect(origin));
  const origins: Record<PushEnvironment, string> = {
    ...APNS_DEFAULT_ORIGINS,
    ...options.origins,
  };
  const sessions = new Map<Origin, http2.ClientHttp2Session>();

  /** The live session for an origin, dialing one if there is none or it is dead. */
  const sessionFor = (origin: Origin): http2.ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing !== undefined && !existing.closed && !existing.destroyed) {
      return existing;
    }
    const session = connect(origin);
    sessions.set(origin, session);
    // A GOAWAY means Apple is retiring this connection: forget it so the next
    // push dials a fresh one. Requests already in flight keep their own answer
    // (Apple finishes them), so nothing is lost or duplicated.
    session.on("goaway", () => retire(origin, session));
    session.on("close", () => retire(origin, session));
    // Without a listener an H2 session's error is an unhandled event, i.e. a
    // relay crash. It only ever costs the pushes in flight on that session.
    session.on("error", () => retire(origin, session));
    return session;
  };

  const retire = (origin: Origin, session: http2.ClientHttp2Session): void => {
    if (sessions.get(origin) === session) {
      sessions.delete(origin);
    }
  };

  /**
   * One HTTP/2 request, or a timeout. The promise settles exactly once: a
   * response, a stream error, or the deadline — whichever comes first.
   */
  const requestOnce = (
    origin: Origin,
    headers: Record<string, string>,
    body: string,
  ): Promise<ApnsOutcome> =>
    new Promise<ApnsOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ApnsOutcome): void => {
        if (!settled) {
          settled = true;
          resolve(outcome);
        }
      };
      const session = sessionFor(origin);
      let req: http2.ClientHttp2Stream;
      try {
        req = session.request(headers);
      } catch {
        // Bun: "New streams cannot be created after receiving a GOAWAY". The
        // session is already retired by the handler above; this push reports
        // `unavailable` and the next one dials fresh (a reconnect, never a loop).
        retire(origin, session);
        finish({ status: "unavailable", reason: "session" });
        return;
      }
      const timer = setTimeout(() => {
        // Apple did not answer within the ceiling: close the stream so it cannot
        // deliver a banner after the daemon has already recorded a failure, and
        // DROP the whole session. A half-open connection (an idle NAT drop sends
        // no GOAWAY and no error) would otherwise make every later push
        // `unavailable` until the kernel gives up on the socket — minutes of
        // silently dead pushes from a relay that looks healthy. In-flight
        // siblings on it are dead anyway: each settles on its own timer.
        req.close();
        retire(origin, session);
        try {
          session.destroy();
        } catch {
          // Already gone: the outcome is the same either way.
        }
        finish(APNS_TIMEOUT_OUTCOME);
      }, timeoutMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref(): void }).unref();
      }

      // Headers arrive first and the error body after them, so the outcome is
      // resolved on the stream's END, not on `response`: reading the body at
      // header time would classify every failure as a reasonless one.
      let status = 0;
      let chunks = "";
      req.setEncoding("utf8");
      req.on(
        "response",
        (responseHeaders: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader) => {
          status = Number(responseHeaders[":status"] ?? 0);
        },
      );
      req.on("data", (chunk: string) => {
        // APNs's error body is tiny (`{"reason":"BadDeviceToken"}`), so the read
        // is bounded: a body that keeps coming is not an APNs error.
        if (chunks.length < 1_024) {
          chunks += chunk;
        }
      });
      req.on("end", () => {
        clearTimeout(timer);
        finish(apnsOutcomeOf({ status, reason: responseReason(chunks) }));
      });
      req.on("error", () => {
        clearTimeout(timer);
        finish({ status: "unavailable", reason: "stream" });
      });
      req.end(body);
    });

  const attempt = async (input: ApnsSendInput): Promise<ApnsOutcome> => {
    const origin = origins[input.env];
    const jwt = await options.jwtSource.jwt();
    let body: string;
    try {
      body = apnsPayloadOf(input.payload);
    } catch {
      // A payload the strip schema refuses (a daemon bug, or a hostile one):
      // nothing is sent, and the daemon is told the push was rejected.
      return { status: "rejected", reason: "payload" };
    }
    const request = apnsRequestOf({
      token: input.token,
      collapse: input.collapse,
      ttl: input.ttl,
      topic: options.topic,
      jwt,
      now: now(),
    });
    const first = await requestOnce(origin, request.headers, body);
    if (first.retry !== true) {
      return first;
    }
    // `ExpiredProviderToken` (403): mint a new token and retry ONCE, as Apple
    // instructs. Not retried further — a bad key must not become a request storm.
    // The FAILED token is named, so a sibling push that already replaced it does
    // not make this one wipe the fresh token and mint again (F15: never a storm).
    options.jwtSource.invalidate(jwt);
    const fresh = await options.jwtSource.jwt();
    const retried = apnsRequestOf({
      token: input.token,
      collapse: input.collapse,
      ttl: input.ttl,
      topic: options.topic,
      jwt: fresh,
      now: now(),
    });
    const outcome = await requestOnce(origin, retried.headers, body);
    return outcome.retry === true
      ? { status: "rejected", reason: "ExpiredProviderToken" }
      : outcome;
  };

  /**
   * One activity push. The same session, the same JWT and the same single retry
   * as `attempt`, because it is the same Apple endpoint — only the request
   * builder and the body differ. The body is built HERE so an unbounded date (a
   * daemon bug, or a hostile one) becomes a `rejected` result instead of a
   * request Apple would 400 with no explanation to the daemon.
   */
  const attemptLiveActivity = async (input: ApnsLiveActivitySendInput): Promise<ApnsOutcome> => {
    const origin = origins[input.env];
    const jwt = await options.jwtSource.jwt();
    let body: string;
    try {
      body = liveActivityPayloadOf(input.la, now());
    } catch {
      return { status: "rejected", reason: "payload" };
    }
    const request = liveActivityRequestOf({
      token: input.token,
      topic: options.topic,
      jwt,
      priority: input.priority,
      now: now(),
      la: input.la,
    });
    const first = await requestOnce(origin, request.headers, body);
    if (first.retry !== true) {
      return first;
    }
    // The 403 `ExpiredProviderToken` path, exactly as the banner push handles it.
    options.jwtSource.invalidate(jwt);
    const fresh = await options.jwtSource.jwt();
    const retried = liveActivityRequestOf({
      token: input.token,
      topic: options.topic,
      jwt: fresh,
      priority: input.priority,
      now: now(),
      la: input.la,
    });
    const outcome = await requestOnce(origin, retried.headers, body);
    return outcome.retry === true
      ? { status: "rejected", reason: "ExpiredProviderToken" }
      : outcome;
  };

  return {
    async send(input: ApnsSendInput): Promise<ApnsOutcome> {
      try {
        return await attempt(input);
      } catch {
        // Nothing here may throw into the frame loop: a relay that crashes on
        // one push loses every daemon on it (F2's convergence, not a silent drop).
        return { status: "unavailable" };
      }
    },
    async sendLiveActivity(input: ApnsLiveActivitySendInput): Promise<ApnsOutcome> {
      try {
        return await attemptLiveActivity(input);
      } catch {
        // Same rule as `send`: one bad activity must not take the relay down.
        return { status: "unavailable" };
      }
    },
    close() {
      for (const [origin, session] of sessions) {
        sessions.delete(origin);
        try {
          session.close();
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/**
 * The `reason` field of APNs's error body, if there is one. Apple answers a
 * failure with `{"reason":"…"}`, and nothing else is read: the body is not a
 * place to trust beyond that one bounded word.
 */
function responseReason(body: string): string | undefined {
  const text = body.trim();
  if (text.length === 0) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const reason = (raw as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}
