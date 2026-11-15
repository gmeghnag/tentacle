/**
 * `push` config (docs/feat/mobile-push.md Design 6, slice P8): the two keys, their
 * bounds, and the ONE number repeated across a package boundary.
 *
 * `@tentacle/config` depends on zod alone, so it cannot import
 * `@tentacle/protocol`'s `PUSH_GRACE_MAX_SECONDS` — it declares its own copy.
 * The agreement is PINNED here (this package sees both) rather than left to
 * drift: a `push.graceSeconds` the FILE accepts but the RPC's result schema
 * refuses would be a setting that cannot be used.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PUSH_GRACE_SECONDS, PUSH_GRACE_MAX_SECONDS } from "@tentacle/config";
import {
  DEFAULT_PUSH_GRACE_SECONDS as PROTOCOL_DEFAULT,
  PUSH_GRACE_MAX_SECONDS as PROTOCOL_MAX,
} from "@tentacle/protocol";
import { FileConfigSchema } from "../../config/src/schema.ts";

describe("the grace numbers agree with the protocol's (one truth, two packages)", () => {
  test("the maximum and the default are the same number on both sides", () => {
    // Mutation: change either constant in `packages/config/src/schema.ts` → red.
    expect(PUSH_GRACE_MAX_SECONDS).toBe(PROTOCOL_MAX);
    expect(DEFAULT_PUSH_GRACE_SECONDS).toBe(PROTOCOL_DEFAULT);
    expect(PROTOCOL_DEFAULT).toBe(30);
  });
});

describe("`push` is a valid, bounded section", () => {
  const parse = (push: unknown) => FileConfigSchema.safeParse({ push });

  test("the defaults and every in-range value parse", () => {
    expect(parse(undefined).success).toBe(true);
    expect(parse({}).success).toBe(true);
    expect(parse({ enabled: true }).success).toBe(true);
    expect(parse({ enabled: false }).success).toBe(true);
    expect(parse({ graceSeconds: 0 }).success).toBe(true);
    expect(parse({ graceSeconds: 30 }).success).toBe(true);
    expect(parse({ graceSeconds: PUSH_GRACE_MAX_SECONDS }).success).toBe(true);
  });

  test("-1 and 3601 are REFUSED (the plan's own boundary test)", () => {
    // Mutation: drop the `.min(0).max(3600)` → both accepted, and a `serve`
    // would then wait forever (or schedule a negative timer, which fires at once).
    expect(parse({ graceSeconds: -1 }).success).toBe(false);
    expect(parse({ graceSeconds: PUSH_GRACE_MAX_SECONDS + 1 }).success).toBe(false);
  });

  test("a fractional or non-numeric grace is refused, and an unknown key too", () => {
    expect(parse({ graceSeconds: 1.5 }).success).toBe(false);
    expect(parse({ graceSeconds: "30" }).success).toBe(false);
    // `.strict()`: a typo is a refusal, never a silently ignored setting.
    expect(parse({ graceSecond: 30 }).success).toBe(false);
  });
});
