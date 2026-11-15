import { describe, expect, test } from "bun:test";
import { createLogLimiter } from "../src/log-limit.ts";

/**
 * The relay's log flood bound (fix/relay-hardening M4): every refusal writes a
 * line, so a flood fills the journal — and journald's own rate limit then drops
 * lines WITHOUT choosing, `ready` ones included, which makes an incident
 * undiagnosable exactly when it matters.
 *
 * The property pinned: the first `perWindow` lines of each KIND always pass (an
 * operator never loses the start of an incident, and never a first-ever error),
 * the rest of the window is counted, and ONE summary line per kind reports the
 * count once the window has ended.
 *
 * Mutations that must turn these red:
 *  - count all kinds in one bucket → "each kind has its own budget"
 *  - drop the summary line → "one summary line carries the exact count"
 *  - never roll the window over → "a new window admits again"
 */

describe("createLogLimiter — a per-kind fixed window, with an honest summary", () => {
  test("the first 20 lines of a kind pass, the next ones are suppressed", () => {
    const limiter = createLogLimiter({ now: () => 0 });
    const admitted = Array.from({ length: 30 }, () => limiter.admit("dial-refused"));
    expect(admitted.filter(Boolean)).toHaveLength(20);
    expect(admitted.slice(20).some(Boolean)).toBe(false);
  });

  test("each kind has its own budget (a `ready` is never hidden by a dial flood)", () => {
    const limiter = createLogLimiter({ now: () => 0 });
    for (let i = 0; i < 40; i++) {
      limiter.admit("dial-refused");
    }
    expect(limiter.admit("ready")).toBe(true);
    expect(limiter.admit("dial-open")).toBe(true);
  });

  test("nothing is summarised while the window is still open", () => {
    const limiter = createLogLimiter({ now: () => 0 });
    for (let i = 0; i < 25; i++) {
      limiter.admit("dial-refused");
    }
    expect(limiter.flush()).toEqual([]);
  });

  test("after the window, one summary line carries the exact count it hid", () => {
    let at = 0;
    const limiter = createLogLimiter({ now: () => at });
    for (let i = 0; i < 25; i++) {
      limiter.admit("dial-refused");
    }
    for (let i = 0; i < 22; i++) {
      limiter.admit("hello-refused");
    }
    at = 10_000;
    // One line per kind, in a stable order (first suppressed first).
    expect(limiter.flush()).toEqual([
      "log-suppressed dial-refused 5",
      "log-suppressed hello-refused 2",
    ]);
    // Flushing again does not repeat them (the count is consumed).
    expect(limiter.flush()).toEqual([]);
  });

  test("a new window admits again, and the old count is still reported once", () => {
    let at = 0;
    const limiter = createLogLimiter({ now: () => at });
    for (let i = 0; i < 25; i++) {
      limiter.admit("dial-refused");
    }
    at = 10_000;
    // A line in the new window is admitted (fresh budget) and does NOT wipe the
    // owed summary of the window before it.
    expect(limiter.admit("dial-refused")).toBe(true);
    expect(limiter.flush()).toEqual(["log-suppressed dial-refused 5"]);
  });

  test("a suppressed count survives several ended windows", () => {
    let at = 0;
    const limiter = createLogLimiter({ now: () => at });
    for (let i = 0; i < 25; i++) {
      limiter.admit("dial-refused");
    }
    at = 10_000;
    for (let i = 0; i < 25; i++) {
      limiter.admit("dial-refused");
    }
    at = 20_000;
    expect(limiter.flush()).toEqual(["log-suppressed dial-refused 10"]);
  });

  test("the kind is the line's first word, and only the first word", () => {
    const limiter = createLogLimiter({ now: () => 0, perWindow: 1 });
    expect(limiter.admit("dial-refused rate gzu4Za9r")).toBe(true);
    expect(limiter.admit("dial-refused concurrency gzu4Za9r")).toBe(false);
  });

  test("the limits are injectable (a test does not wait 10 s)", () => {
    let at = 0;
    const limiter = createLogLimiter({ now: () => at, perWindow: 2, windowMs: 1_000 });
    expect(limiter.admit("ready")).toBe(true);
    expect(limiter.admit("ready")).toBe(true);
    expect(limiter.admit("ready")).toBe(false);
    at = 1_000;
    expect(limiter.admit("ready")).toBe(true);
    expect(limiter.flush()).toEqual(["log-suppressed ready 1"]);
  });
});
