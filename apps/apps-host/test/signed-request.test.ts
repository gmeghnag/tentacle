import { describe, expect, test } from "bun:test";
import { APPS_HEADERS } from "@tentacle/protocol";
import { NonceGuard, checkSignedHeaders, verifySignedBody } from "../src/signed-request.ts";
import { type SignInput, createPublisher } from "./support/publisher.ts";

const NOW = 1_790_000_000_000;
const SKEW = 300_000;
const STARTED = NOW - 3_600_000;
const BASE: SignInput = {
  method: "POST",
  path: "/v1/apps",
  domain: "apps.example",
  date: NOW,
  body: new TextEncoder().encode("<p>hi</p>"),
};

const publisher = await createPublisher();

interface Seen {
  method?: string;
  path?: string;
  domain?: string;
  body?: Uint8Array;
}

/** Sign `signed`, then present it as `seen` to the host at `now`. */
async function run(
  options: {
    signed?: Partial<SignInput>;
    seen?: Seen;
    headers?: (h: Record<string, string>) => Record<string, string>;
    guard?: NonceGuard;
    now?: number;
    startedAt?: number;
    sendHeaders?: Record<string, string>;
  } = {},
) {
  const input = { ...BASE, ...options.signed };
  const signed = options.sendHeaders ?? (await publisher.headers(input));
  const headers = new Headers(options.headers === undefined ? signed : options.headers(signed));
  const now = options.now ?? NOW;
  const shape = checkSignedHeaders(headers, {
    now,
    startedAt: options.startedAt ?? STARTED,
    skewMs: SKEW,
  });
  if (!shape.ok) {
    return shape;
  }
  return verifySignedBody(shape.request, {
    method: options.seen?.method ?? input.method,
    path: options.seen?.path ?? input.path,
    domain: options.seen?.domain ?? input.domain,
    body: options.seen?.body ?? input.body ?? new Uint8Array(),
    nonces: options.guard ?? new NonceGuard({ max: 10, skewMs: SKEW }),
    now,
  });
}

describe("signed requests", () => {
  test("a valid request is accepted", async () => {
    expect(await run()).toEqual({ ok: true });
  });

  test("the parsed request names the key", async () => {
    const shape = checkSignedHeaders(new Headers(await publisher.headers(BASE)), {
      now: NOW,
      startedAt: STARTED,
      skewMs: SKEW,
    });
    expect(shape.ok && shape.request.key).toBe(publisher.key);
  });

  test("each tampered part → bad_signature", async () => {
    const tampered: Seen[] = [
      { method: "PUT" },
      { path: "/v1/apps/abcdefghijklmnop" },
      { domain: "apps.other" },
      { body: new TextEncoder().encode("<p>ho</p>") },
    ];
    for (const seen of tampered) {
      expect(await run({ seen })).toMatchObject({ ok: false, error: "bad_signature" });
    }
    for (const [name, value] of [
      [APPS_HEADERS.date, String(NOW + 1)],
      [APPS_HEADERS.nonce, "AAAAAAAAAAAAAAAAAAAAAA"],
      [APPS_HEADERS.signature, `${"A".repeat(85)}A`],
    ] as const) {
      expect(await run({ headers: (h) => ({ ...h, [name]: value }) })).toMatchObject({
        ok: false,
        error: "bad_signature",
      });
    }
  });

  test("another key → bad_signature", async () => {
    const other = await createPublisher();
    expect(await run({ headers: (h) => ({ ...h, [APPS_HEADERS.key]: other.key }) })).toMatchObject({
      ok: false,
      error: "bad_signature",
    });
  });

  test("more than 300 s either way → clock_skew with the host's time", async () => {
    for (const date of [NOW - 301_000, NOW + 301_000]) {
      expect(await run({ signed: { date } })).toMatchObject({
        ok: false,
        error: "clock_skew",
        serverTime: NOW,
      });
    }
    for (const date of [NOW - 300_000, NOW + 300_000]) {
      expect(await run({ signed: { date } })).toEqual({ ok: true });
    }
  });

  test("signed before the process started → replay", async () => {
    expect(await run({ signed: { date: NOW - 1000 }, startedAt: NOW })).toMatchObject({
      ok: false,
      error: "replay",
    });
  });

  test("a second use of a nonce → replay; a bad signature burns nothing", async () => {
    const guard = new NonceGuard({ max: 10, skewMs: SKEW });
    const sendHeaders = await publisher.headers(BASE);
    expect(await run({ guard, sendHeaders, seen: { path: "/x" } })).toMatchObject({
      error: "bad_signature",
    });
    expect(guard.size).toBe(0);
    expect(await run({ guard, sendHeaders })).toEqual({ ok: true });
    expect(await run({ guard, sendHeaders })).toMatchObject({ ok: false, error: "replay" });
    // Still refused at the very end of the window in which its date is accepted.
    expect(await run({ guard, sendHeaders, now: NOW + SKEW })).toMatchObject({ error: "replay" });
  });

  test("a full cache → busy (nothing evicted), accepted again after the window", async () => {
    const guard = new NonceGuard({ max: 2, skewMs: SKEW });
    const first = await publisher.headers(BASE);
    expect(await run({ guard, sendHeaders: first })).toEqual({ ok: true });
    expect(await run({ guard })).toEqual({ ok: true });
    expect(await run({ guard })).toMatchObject({ ok: false, error: "busy" });
    // The oldest in-window nonce is still remembered.
    expect(await run({ guard, sendHeaders: first })).toMatchObject({ error: "replay" });
    const later = NOW + SKEW + 1;
    expect(await run({ guard, now: later, signed: { date: later } })).toEqual({ ok: true });
  });

  test("each malformed header → bad_request", async () => {
    const cases: [string, string | undefined][] = [];
    for (const name of Object.values(APPS_HEADERS)) {
      cases.push([name, undefined], [name, ""], [name, "!!!"]);
    }
    cases.push(
      [APPS_HEADERS.key, "A".repeat(42)],
      [APPS_HEADERS.key, "A".repeat(44)],
      // Non-canonical base64url: trailing bits set.
      [APPS_HEADERS.key, `${"A".repeat(42)}B`],
      [APPS_HEADERS.nonce, "A".repeat(21)],
      [APPS_HEADERS.nonce, `${"A".repeat(21)}B`],
      [APPS_HEADERS.signature, "A".repeat(85)],
      [APPS_HEADERS.date, "01"],
      [APPS_HEADERS.date, "1.5"],
      [APPS_HEADERS.date, "-1"],
      [APPS_HEADERS.date, "1e12"],
      [APPS_HEADERS.date, "9".repeat(20)],
    );
    for (const [name, value] of cases) {
      const result = await run({
        headers: (h) => {
          const next = { ...h };
          if (value === undefined) {
            delete next[name];
          } else {
            next[name] = value;
          }
          return next;
        },
      });
      expect(result).toMatchObject({ ok: false, error: "bad_request" });
    }
  });
});
