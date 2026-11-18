/**
 * `liveActivity` config (docs/feat/mobile-live-activity.md Design 3/8, slice L8):
 * the two keys, their bounds, and the fact that they are read through ONE place.
 *
 * `@tentacle/config` depends on zod alone, so it cannot import
 * `@tentacle/daemon`'s `DEFAULT_LA_START_AFTER_SECONDS` — it declares its own
 * copy, and the agreement is PINNED here (this package sees both) rather than
 * left to drift: a `startAfterSeconds` the FILE accepts but the rules module
 * treats differently would be a setting that silently does not do what it says.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIVE_ACTIVITY_START_AFTER_SECONDS,
  LIVE_ACTIVITY_START_AFTER_MAX_SECONDS,
} from "@tentacle/config";
import { DEFAULT_LA_START_AFTER_SECONDS as DAEMON_DEFAULT } from "@tentacle/daemon";
import { FileConfigSchema } from "../../config/src/schema.ts";

describe("the start threshold agrees with the rules module (one truth, two packages)", () => {
  test("the default and the maximum are the same numbers on both sides", () => {
    // Mutation: change either constant → red, and the plan's "20 s" would be a
    // claim about a number nothing reads.
    expect(DEFAULT_LIVE_ACTIVITY_START_AFTER_SECONDS).toBe(DAEMON_DEFAULT);
    expect(DAEMON_DEFAULT).toBe(20);
    expect(LIVE_ACTIVITY_START_AFTER_MAX_SECONDS).toBe(3600);
  });
});

describe("`liveActivity` is a valid, bounded section", () => {
  const parse = (liveActivity: unknown) => FileConfigSchema.safeParse({ liveActivity });

  test("the defaults and every in-range value parse", () => {
    expect(parse(undefined).success).toBe(true);
    expect(parse({}).success).toBe(true);
    expect(parse({ enabled: true }).success).toBe(true);
    expect(parse({ enabled: false }).success).toBe(true);
    expect(parse({ startAfterSeconds: 0 }).success).toBe(true);
    expect(parse({ startAfterSeconds: 20 }).success).toBe(true);
    expect(parse({ startAfterSeconds: LIVE_ACTIVITY_START_AFTER_MAX_SECONDS }).success).toBe(true);
  });

  test("-1 and 3601 are REFUSED (the plan's own boundary test)", () => {
    // Mutation: drop the `.min(0).max(3600)` → both accepted, and a `serve` would
    // either start an activity for every trivial turn (0) or never at all (a value
    // past any turn's length).
    expect(parse({ startAfterSeconds: -1 }).success).toBe(false);
    expect(parse({ startAfterSeconds: LIVE_ACTIVITY_START_AFTER_MAX_SECONDS + 1 }).success).toBe(
      false,
    );
  });

  test("a fractional or non-numeric threshold is refused, and an unknown key too", () => {
    expect(parse({ startAfterSeconds: 1.5 }).success).toBe(false);
    expect(parse({ startAfterSeconds: "20" }).success).toBe(false);
    expect(parse({ startAfterSecond: 20 }).success).toBe(false);
  });
});
