import { describe, expect, test } from "bun:test";
import {
  APPS_API_VERSION,
  APPS_HEADERS,
  APP_ID_LENGTH,
  AppsErrorSchema,
  AppsLeaseResultSchema,
  appsSigningPayload,
  isAppId,
} from "../src/apps-host.ts";

const BASE = {
  method: "POST",
  domain: "apps.example",
  path: "/v1/apps",
  date: "1790000000000",
  nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  bodySha256Hex: "ab".repeat(32),
} as const;

describe("apps-host contract", () => {
  test("constants: its own version, 16-char ids, the four header names", () => {
    expect(APPS_API_VERSION).toBe(1);
    expect(APP_ID_LENGTH).toBe(16);
    expect(APPS_HEADERS).toEqual({
      key: "Tentacle-Key",
      date: "Tentacle-Date",
      nonce: "Tentacle-Nonce",
      signature: "Tentacle-Signature",
    });
  });

  test("the signing payload is a pinned golden string", () => {
    expect(appsSigningPayload(BASE)).toBe(
      `tentacle-apps/1\nPOST\napps.example\n/v1/apps\n1790000000000\nAAAAAAAAAAAAAAAAAAAAAA\n${"ab".repeat(32)}`,
    );
  });

  test("the method is upper-cased", () => {
    expect(appsSigningPayload({ ...BASE, method: "post" })).toBe(appsSigningPayload(BASE));
  });

  test("changing any part changes the payload", () => {
    const variants = [
      { method: "PUT" },
      { domain: "apps.other" },
      { path: "/v1/apps/abc" },
      { date: "1790000000001" },
      { nonce: "AAAAAAAAAAAAAAAAAAAAAB" },
      { bodySha256Hex: "cd".repeat(32) },
    ];
    const seen = new Set([appsSigningPayload(BASE)]);
    for (const variant of variants) {
      seen.add(appsSigningPayload({ ...BASE, ...variant }));
    }
    expect(seen.size).toBe(variants.length + 1);
  });

  test("isAppId accepts exactly 16 lowercase base32 characters", () => {
    expect(isAppId("abcdefghijklmnop")).toBe(true);
    expect(isAppId("a2b3c4d5e6f7abcd")).toBe(true);
    for (const bad of [
      "",
      "abcdefghijklmno",
      "abcdefghijklmnopq",
      "abcdefghijklmno1",
      "abcdefghijklmno0",
      "abcdefghijklmno8",
      "Abcdefghijklmnop",
      "abcdefghijklmno-",
      "abcdefghijklmnop\n",
    ]) {
      expect(isAppId(bad)).toBe(false);
    }
  });

  test("the lease result strips unknown fields and validates the id", () => {
    const value = {
      id: "abcdefghijklmnop",
      url: "https://abcdefghijklmnop.apps.example/",
      leaseExpiresAt: 1790000300000,
      leaseMs: 300000,
      renewAfterMs: 60000,
    };
    expect(AppsLeaseResultSchema.parse({ ...value, extra: 1 })).toEqual(value);
    expect(AppsLeaseResultSchema.safeParse({ ...value, id: "short" }).success).toBe(false);
  });

  test("errors strip unknown fields and refuse an unknown code", () => {
    const value = {
      error: "clock_skew" as const,
      message: "clock",
      serverTime: 5,
      retryAfterMs: 1,
      reason: "r",
    };
    expect(AppsErrorSchema.parse({ ...value, extra: true })).toEqual(value);
    expect(AppsErrorSchema.safeParse({ error: "nope", message: "x" }).success).toBe(false);
    for (const code of [
      "bad_request",
      "bad_signature",
      "clock_skew",
      "replay",
      "not_found",
      "forbidden",
      "blocked",
      "taken_down",
      "expired",
      "deleted",
      "too_large",
      "unsupported_media",
      "malformed",
      "rate_limited",
      "cap_reached",
      "conflict",
      "storage_full",
      "killed",
      "busy",
      "internal",
    ]) {
      expect(AppsErrorSchema.safeParse({ error: code, message: "m" }).success).toBe(true);
    }
  });
});
