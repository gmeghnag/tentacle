import { describe, expect, test } from "bun:test";
import { sweepIntervalFor } from "../src/session-reaper.ts";

describe("sweepIntervalFor (the reaper's period)", () => {
  test("60 s by default; follows a shorter TTL or cap; never under 1 s", () => {
    // Mutations: drop the floor → 1; drop the cap term → 60_000 on the cap row.
    expect(sweepIntervalFor(24 * 60 * 60 * 1000)).toBe(60_000);
    expect(sweepIntervalFor(5000)).toBe(5000);
    expect(sweepIntervalFor(24 * 60 * 60 * 1000, 3000)).toBe(3000);
    expect(sweepIntervalFor(1)).toBe(1000);
    expect(sweepIntervalFor(24 * 60 * 60 * 1000, 1)).toBe(1000);
  });

  test("never: nothing to sweep without a cap; with a cap, the cap's period", () => {
    // Mutation: `null` falls into the TTL term → NaN / 60_000 instead of null / 3000.
    expect(sweepIntervalFor(null)).toBeNull();
    expect(sweepIntervalFor(null, 3000)).toBe(3000);
    expect(sweepIntervalFor(null, 1)).toBe(1000);
    expect(sweepIntervalFor(null, 24 * 60 * 60 * 1000)).toBe(60_000);
  });
});
