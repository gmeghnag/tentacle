import { describe, expect, test } from "bun:test";
import { isAppId } from "@tentacle/protocol";
import { hostRoute, mintAppId } from "../src/app-id.ts";

const DOMAIN = "apps.example.so";
const ID = "abcdefghij234567";

describe("mintAppId", () => {
  test("is 16 base32 characters taken from the 80 random bits", () => {
    expect(mintAppId(() => new Uint8Array(10))).toBe("aaaaaaaaaaaaaaaa");
    expect(mintAppId(() => new Uint8Array(10).fill(0xff))).toBe("7777777777777777");
    // 00001 00010 ... : the bit stream is read MSB first, 5 bits per character.
    const bytes = new Uint8Array(10);
    bytes[0] = 0b00001000;
    bytes[1] = 0b10000000;
    expect(mintAppId(() => bytes)).toBe("bcaaaaaaaaaaaaaa");
  });

  test("asks for exactly ten bytes and yields a valid id for any of them", () => {
    let asked = 0;
    const id = mintAppId((n) => {
      asked = n;
      return crypto.getRandomValues(new Uint8Array(n));
    });
    expect(asked).toBe(10);
    expect(isAppId(id)).toBe(true);
  });
});

describe("hostRoute", () => {
  test("the apex is the control API, any case, with or without a port", () => {
    for (const host of [DOMAIN, "APPS.Example.SO", `${DOMAIN}:443`]) {
      expect(hostRoute(host, DOMAIN)).toEqual({ kind: "control" });
    }
  });

  test("<id>.<domain> is an app, case-folded", () => {
    for (const host of [`${ID}.${DOMAIN}`, `${ID.toUpperCase()}.${DOMAIN}`, `${ID}.${DOMAIN}:80`]) {
      expect(hostRoute(host, DOMAIN)).toEqual({ kind: "app", id: ID });
    }
  });

  test("a label that is no id is an app host with that label (404 'no such app')", () => {
    expect(hostRoute(`nope.${DOMAIN}`, DOMAIN)).toEqual({ kind: "app", id: "nope" });
  });

  test("everything else is unknown", () => {
    for (const host of [
      "",
      null,
      "example.so",
      `a.${ID}.${DOMAIN}`,
      `evil${DOMAIN}`,
      `${DOMAIN}.evil`,
      `.${DOMAIN}`,
      "127.0.0.1:4200",
      "[::1]:4200",
      `${DOMAIN}:abc`,
    ]) {
      expect(hostRoute(host, DOMAIN)).toEqual({ kind: "unknown" });
    }
  });
});
