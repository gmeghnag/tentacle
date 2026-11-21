/**
 * The model's `now` (docs/fix/prompt-current-date.md): when a stamp is due, and
 * the exact text it renders in the user's zone. Pure, fake clock, no real dates
 * (every instant is built in UTC and rendered through `timeZone`, so the test
 * holds on any host).
 */
import { describe, expect, test } from "bun:test";
import {
  DATE_STAMP_MAX_AGE_MS,
  type DateStamp,
  dateStampPrefix,
  dateStampText,
  lastDateStamp,
  nextDateStamp,
  zoneOrDefault,
} from "../src/current-date.ts";

const ROME = "Europe/Rome";
const NY = "America/New_York";

/** A stamped history of one user message. */
const stamped = (stamp: DateStamp): { readonly dateStamp?: DateStamp }[] => [
  { role: "user", dateStamp: stamp },
];

describe("dateStampText: the line the model reads", () => {
  test("the owner's example, in the laptop's zone (CET in November)", () => {
    // 2026-11-20T12:42Z = 13:42 in Rome (CET, UTC+1).
    const at = Date.UTC(2026, 10, 20, 12, 42);
    expect(dateStampText({ at, zone: ROME })).toBe("[Fri 2026-11-20 13:42 CET]");
  });

  test("a summer instant shows the DST abbreviation (CEST) and the shifted clock", () => {
    // 2026-07-01T10:00Z = 12:00 in Rome (CEST, UTC+2).
    expect(dateStampText({ at: Date.UTC(2026, 6, 1, 10, 0), zone: ROME })).toBe(
      "[Wed 2026-07-01 12:00 CEST]",
    );
  });

  test("a numeric offset zone is spelled out, never guessed", () => {
    // 2026-11-20T12:42Z = 07:42 in New York (EST, UTC-5).
    expect(dateStampText({ at: Date.UTC(2026, 10, 20, 12, 42), zone: NY })).toBe(
      "[Fri 2026-11-20 07:42 GMT-5]",
    );
    expect(dateStampText({ at: Date.UTC(2026, 10, 20, 12, 42), zone: "UTC" })).toBe(
      "[Fri 2026-11-20 12:42 UTC]",
    );
  });

  test("a half-hour offset keeps its minutes", () => {
    expect(dateStampText({ at: Date.UTC(2026, 10, 20, 12, 42), zone: "Asia/Kolkata" })).toBe(
      "[Fri 2026-11-20 18:12 GMT+5:30]",
    );
  });

  test("the prefix is the line plus ONE newline (a cache-stable prefix, not a suffix)", () => {
    const stamp = { at: Date.UTC(2026, 10, 20, 12, 42), zone: ROME };
    expect(dateStampPrefix(stamp)).toBe("[Fri 2026-11-20 13:42 CET]\n");
  });
});

describe("zoneOrDefault: an unknown zone never breaks a turn", () => {
  test("a known zone is kept as given", () => {
    expect(zoneOrDefault(ROME)).toBe(ROME);
  });

  test("an unknown zone falls back to the host's own", () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Mutation: drop the try/catch → this THROWS RangeError instead.
    expect(zoneOrDefault("Mars/Olympus_Mons")).toBe(host);
    expect(zoneOrDefault("")).toBe(host);
    expect(zoneOrDefault(undefined)).toBe(host);
  });

  test("rendering a fallback zone never throws", () => {
    expect(() =>
      dateStampText({ at: Date.UTC(2026, 10, 20, 12, 42), zone: "Mars/Base" }),
    ).not.toThrow();
  });
});

describe("nextDateStamp: when the model's now must be refreshed", () => {
  const t0 = Date.UTC(2026, 10, 20, 12, 0); // 13:00 in Rome

  test("the FIRST message of a session is stamped", () => {
    // Mutation: seed-demand "always stamp" → the burst tests below go red.
    expect(nextDateStamp([], t0, ROME)).toEqual({ at: t0, zone: ROME });
  });

  test("a resume whose history has no stamp is stamped (an old log, an older build)", () => {
    expect(nextDateStamp([{ role: "user" }, { role: "assistant" }], t0, ROME)).toEqual({
      at: t0,
      zone: ROME,
    });
  });

  test("a resume whose history already carries a fresh stamp is NOT re-stamped", () => {
    const history = [...stamped({ at: t0 - 60_000, zone: ROME }), { role: "assistant" }];
    expect(nextDateStamp(history, t0, ROME)).toBeNull();
  });

  test("a same-day burst within 30 min is not re-stamped", () => {
    const history = stamped({ at: t0, zone: ROME });
    expect(nextDateStamp(history, t0 + DATE_STAMP_MAX_AGE_MS, ROME)).toBeNull();
  });

  test("more than 30 min since the LAST STAMP re-stamps, even with a message a minute ago", () => {
    // The whole point of stamping against the STAMP, not the last message: a
    // long burst of rapid turns must not leave the model an hour behind.
    const stampAt = t0;
    const history = [...stamped({ at: stampAt, zone: ROME }), { role: "assistant" }];
    const now = stampAt + DATE_STAMP_MAX_AGE_MS + 60_000;
    // Mutation: compare `now` with the last MESSAGE's time → null here.
    expect(nextDateStamp(history, now, ROME)).toEqual({ at: now, zone: ROME });
  });

  test("a midnight crossing re-stamps the same day-boundary instant, in the ZONE not UTC", () => {
    // 2026-11-20T23:10Z is 00:10 on the 21st in Rome but still the 20th in UTC.
    const before = Date.UTC(2026, 10, 20, 22, 50); // 23:50 Rome, 22:50 UTC
    const after = Date.UTC(2026, 10, 20, 23, 10); // 00:10 Rome on the 21st, 23:10 UTC on the 20th
    // Mutation: compare UTC days (`toISOString().slice(0,10)`) → null here.
    expect(nextDateStamp(stamped({ at: before, zone: ROME }), after, ROME)).toEqual({
      at: after,
      zone: ROME,
    });
    // The other way: in UTC those two instants ARE the same day, so no stamp.
    expect(nextDateStamp(stamped({ at: before, zone: "UTC" }), after, "UTC")).toBeNull();
  });

  test("a clock that went BACKWARDS re-stamps only on a day change, never a negative age", () => {
    const last = stamped({ at: t0, zone: ROME });
    // An hour earlier, same day: no stamp (a negative age is not "> 30 min").
    expect(nextDateStamp(last, t0 - 3_600_000, ROME)).toBeNull();
    // An earlier DAY: stamped, from `now` (never the future stamp).
    const earlier = t0 - 24 * 3_600_000;
    expect(nextDateStamp(last, earlier, ROME)).toEqual({ at: earlier, zone: ROME });
  });

  test("the last stamp is the LAST one in the history, not the first", () => {
    const history = [
      ...stamped({ at: t0 - 3 * 3_600_000, zone: ROME }),
      { role: "assistant" },
      ...stamped({ at: t0, zone: ROME }),
      { role: "assistant" },
    ];
    expect(lastDateStamp(history)).toEqual({ at: t0, zone: ROME });
    expect(nextDateStamp(history, t0 + 60_000, ROME)).toBeNull();
  });

  test("an unknown zone is resolved BEFORE it is stored on the stamp", () => {
    const stamp = nextDateStamp([], t0, "Mars/Base");
    expect(stamp?.zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
