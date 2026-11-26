/**
 * The publisher's client over a fake `fetch` (docs/feat/session-apps-publish.md):
 * what is signed, the `Host`, one re-sign on `clock_skew`, the URL check and the
 * timeouts. The byte-for-byte agreement with the real host is
 * `apps/apps-host/test/publisher-compat.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appsSigningPayload, decodeBase64Url } from "@tentacle/protocol";
import { AppsClient, type AppsClientOptions } from "../src/apps-client.ts";
import type { AppsKey } from "../src/apps-key.ts";

const DOMAIN = "apps.example.so";
const ID = "abcdefghijklmnop";
const LEASE = {
  id: ID,
  url: `https://${ID}.${DOMAIN}/`,
  leaseExpiresAt: 5,
  leaseMs: 300_000,
  renewAfterMs: 60_000,
};
const PAGE = new TextEncoder().encode("<p>hi</p>");

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
}

function rig(answers: (() => Response)[], over: Partial<AppsClientOptions> = {}) {
  const seen: Seen[] = [];
  const signed: string[] = [];
  const key: AppsKey = {
    publicKey: "K".repeat(43),
    sign: async (bytes) => {
      signed.push(new TextDecoder().decode(bytes));
      return new Uint8Array(64).fill(signed.length);
    },
  };
  let nonce = 0;
  const client = new AppsClient({
    domain: DOMAIN,
    key,
    now: () => 1000,
    random: (n) => new Uint8Array(n).fill(++nonce),
    fetch: async (url, init) => {
      seen.push({
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body as Uint8Array | undefined,
      });
      const next = answers.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    },
    ...over,
  });
  return { client, seen, signed };
}

const ok =
  (body: unknown = LEASE, status = 200) =>
  () =>
    Response.json(body, { status });
const err =
  (error: string, status: number, extra: Record<string, unknown> = {}) =>
  () =>
    Response.json({ error, message: `${error}!`, ...extra }, { status });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("AppsClient signing", () => {
  test("create: the headers, the Host and the payload the contract builds", async () => {
    const { client, seen, signed } = rig([ok(LEASE, 201)]);
    expect(await client.create(PAGE)).toEqual({ ok: true, lease: LEASE });
    const request = seen[0] as Seen;
    expect(request.url).toBe(`https://${DOMAIN}/v1/apps`);
    expect(request.method).toBe("POST");
    expect(request.headers.host).toBe(DOMAIN);
    expect(request.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(request.headers["Tentacle-Key"]).toBe("K".repeat(43));
    expect(request.headers["Tentacle-Date"]).toBe("1000");
    expect(decodeBase64Url(request.headers["Tentacle-Signature"] as string)).toHaveLength(64);
    expect(request.body).toEqual(PAGE);
    expect(signed[0]).toBe(
      appsSigningPayload({
        method: "POST",
        domain: DOMAIN,
        path: "/v1/apps",
        date: "1000",
        nonce: request.headers["Tentacle-Nonce"] as string,
        bodySha256Hex: sha(PAGE),
      }),
    );
  });

  test("update, renew, remove: their routes; a bodiless call signs the empty hash", async () => {
    const { client, seen, signed } = rig([ok(), ok(), () => new Response(null, { status: 204 })]);
    expect((await client.update(ID, PAGE)).ok).toBe(true);
    expect((await client.renew(ID)).ok).toBe(true);
    expect(await client.remove(ID)).toEqual({ ok: true });
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      `PUT /v1/apps/${ID}`,
      `POST /v1/apps/${ID}/lease`,
      `DELETE /v1/apps/${ID}`,
    ]);
    expect(signed[1]?.endsWith(sha(new Uint8Array()))).toBe(true);
    expect(seen[1]?.headers["content-type"]).toBeUndefined();
  });

  test("every retry signs anew: a fresh nonce and signature", async () => {
    const { client, seen } = rig([err("busy", 503), ok()]);
    await client.renew(ID);
    await client.renew(ID);
    const nonces = seen.map((s) => s.headers["Tentacle-Nonce"]);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(seen[0]?.headers["Tentacle-Signature"]).not.toBe(seen[1]?.headers["Tentacle-Signature"]);
  });

  test("clock_skew: one re-sign with the host's date, and the offset is kept", async () => {
    const skew = err("clock_skew", 401, { serverTime: 900_000 });
    const { client, seen } = rig([skew, ok(), ok()]);
    expect((await client.renew(ID)).ok).toBe(true);
    await client.renew(ID);
    expect(seen.map((s) => s.headers["Tentacle-Date"])).toEqual(["1000", "900000", "900000"]);
    expect(seen[0]?.headers["Tentacle-Nonce"]).not.toBe(seen[1]?.headers["Tentacle-Nonce"]);
  });

  test("a second clock_skew is an error, never a loop", async () => {
    const skew = err("clock_skew", 401, { serverTime: 900_000 });
    const { client, seen } = rig([skew, skew, skew]);
    const outcome = await client.renew(ID);
    expect(outcome).toMatchObject({ ok: false, code: "clock_skew", transient: true });
    expect(seen).toHaveLength(2);
  });
});

describe("AppsClient answers", () => {
  test("errors keep their code, reason, retry hint and whether they are transient", async () => {
    const { client } = rig([
      err("taken_down", 403, { reason: "phishing" }),
      err("rate_limited", 429, { retryAfterMs: 7000 }),
      err("cap_reached", 409),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ]);
    expect(await client.renew(ID)).toMatchObject({
      code: "taken_down",
      reason: "phishing",
      transient: false,
    });
    expect(await client.renew(ID)).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 7000,
      transient: true,
    });
    expect(await client.create(PAGE)).toMatchObject({ code: "cap_reached", transient: false });
    expect(await client.renew(ID)).toMatchObject({ code: "internal", transient: true });
  });

  for (const [name, lease] of [
    ["a url outside the domain", { ...LEASE, url: `https://${ID}.evil.example/` }],
    ["a url naming another app", { ...LEASE, url: `https://aaaaaaaaaaaaaaaa.${DOMAIN}/` }],
    ["a shape the schema refuses", { ...LEASE, leaseMs: -1 }],
  ] as const) {
    test(`create answered with ${name}: internal, and the new id is deleted`, async () => {
      const { client, seen } = rig([ok(lease, 201), () => new Response(null, { status: 204 })]);
      expect(await client.create(PAGE)).toMatchObject({ ok: false, code: "internal" });
      expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
        "POST /v1/apps",
        `DELETE /v1/apps/${ID}`,
      ]);
    });
  }

  test("a renew answered for ANOTHER id is refused and deletes nothing", async () => {
    const other = "bbbbbbbbbbbbbbbb";
    const { client, seen } = rig([ok({ ...LEASE, id: other, url: `https://${other}.${DOMAIN}/` })]);
    expect(await client.renew(ID)).toMatchObject({ ok: false, code: "internal" });
    expect(seen).toHaveLength(1);
  });

  const hang = (_url: string, init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

  test("a call that is not answered times out (upload and short timeouts are separate)", async () => {
    const { client } = rig([], { fetch: hang, requestTimeoutMs: 5, uploadTimeoutMs: 60_000 });
    expect(await client.renew(ID)).toMatchObject({ code: "timeout", transient: true });
    const upload = rig([], { fetch: hang, requestTimeoutMs: 60_000, uploadTimeoutMs: 5 });
    expect(await upload.client.create(PAGE)).toMatchObject({ code: "timeout" });
  });

  test("an aborted call settles; a network failure is transient", async () => {
    const abort = new AbortController();
    const { client } = rig([], { fetch: hang });
    const pending = client.renew(ID, abort.signal);
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, transient: true });
    const down = rig([], {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await down.client.renew(ID)).toMatchObject({ code: "network", transient: true });
  });
});
