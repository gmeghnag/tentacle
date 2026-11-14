/**
 * `serve --address <url>` (docs/feat/sibling-discovery.md owner Q3): repeatable,
 * validated at PARSE time so `serve` fails before it binds — a typo silently
 * missing from the announcement would be a project the phone can never reach.
 * And `serve` naming the flag in its help.
 */
import { describe, expect, test } from "bun:test";
import { MAX_PAIRING_ADDRESSES } from "@tentacle/protocol";
import { ARGS, parseArgs, parseServeLimits } from "../src/flags.ts";

function limitsFor(argv: string[]) {
  const parsed = parseArgs(argv, ARGS.serve);
  if (!parsed.ok) {
    throw new Error(`parse failed: ${parsed.error}`);
  }
  return parseServeLimits(parsed);
}

describe("serve --address", () => {
  test("collects every occurrence, in the order given", () => {
    const limits = limitsFor([
      "--address",
      "ws://192.168.1.5:4000/e2e",
      "--address",
      "wss://mac.tailnet.ts.net/e2e",
    ]);
    expect(limits.addresses).toEqual(["ws://192.168.1.5:4000/e2e", "wss://mac.tailnet.ts.net/e2e"]);
  });

  test("absent → no `addresses` at all (the record stays byte-identical to an older build's)", () => {
    expect("addresses" in limitsFor([])).toBe(false);
  });

  test("a URL a phone cannot dial is REFUSED, before binding", () => {
    for (const bad of ["http://host:4000/e2e", "ws://host:4000", "ws://host:4000/other"]) {
      expect(() => limitsFor(["--address", bad])).toThrow(/--address/);
    }
  });

  test("more than a QR can hold is refused", () => {
    const many = Array.from({ length: MAX_PAIRING_ADDRESSES + 1 }, (_, i) => [
      "--address",
      `ws://10.0.0.${i}:4000/e2e`,
    ]).flat();
    expect(() => limitsFor(many)).toThrow(/--address/);
  });

  test("`--address` without a value is an error, not an empty address", () => {
    expect(() => limitsFor(["--address"])).toThrow();
  });
});
