/**
 * Fix round 1, finding 1 (docs/fix/prompt-current-date.md): a stamp whose `at`
 * is outside the JS Date range must never throw out of a render (one such
 * history entry used to make every later turn of the session fail).
 */
import { describe, expect, test } from "bun:test";
import {
  DATE_STAMP_MAX_AT_MS,
  type DateStamp,
  dateStampPrefix,
  dateStampText,
  nextDateStamp,
} from "../src/current-date.ts";

const ROME = "Europe/Rome";
const BAD = DATE_STAMP_MAX_AT_MS + 1;

/** One history entry, as in `current-date.test.ts`: the role is irrelevant here. */
type Entry = { readonly role: string; readonly dateStamp?: DateStamp };

describe("an unrenderable `at` degrades, never throws", () => {
  test("dateStampText / dateStampPrefix yield NOTHING for it", () => {
    // RED before the fix: RangeError out of `partsOf`'s formatToParts, on every
    // request (renderForModel) and every prompt (nextDateStamp).
    // Mutation: drop the `renderable` guard in dateStampText → RangeError.
    expect(dateStampText({ at: BAD, zone: ROME })).toBe("");
    expect(dateStampPrefix({ at: BAD, zone: ROME })).toBe("");
    expect(dateStampText({ at: Number.NaN, zone: ROME })).toBe("");
  });

  test("a history whose last stamp is unrenderable is stamped AGAIN, from `now`", () => {
    // Mutation: compare days with the raw `partsOf` → RangeError instead.
    const now = Date.UTC(2026, 10, 20, 12, 0);
    const history: Entry[] = [{ role: "user", dateStamp: { at: BAD, zone: ROME } }];
    expect(nextDateStamp(history, now, ROME)).toEqual({ at: now, zone: ROME });
  });

  test("a `now` outside the range stamps nothing (never a nonsense line)", () => {
    expect(nextDateStamp([], BAD, ROME)).toBeNull();
  });
});
