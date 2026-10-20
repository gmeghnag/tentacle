import { describe, expect, test } from "bun:test";
import { linkIndicator, nextTickMs } from "../src/link-status.ts";

describe("linkIndicator (pure)", () => {
  test("up, none and our own close show nothing", () => {
    expect(linkIndicator(null, 0)).toBeNull();
    expect(linkIndicator({ state: "up" }, 0)).toBeNull();
    expect(linkIndicator({ state: "stopped", reason: "closed" }, 0)).toBeNull();
  });

  test("reconnecting: attempt + countdown (rounded up), the dial error when known", () => {
    const s = { state: "reconnecting", attempt: 2, nextAtMs: 10_000 } as const;
    expect(linkIndicator(s, 5_500)).toEqual({
      text: "reconnecting… (attempt 2, retry in 5s)",
      tone: "warn",
    });
    expect(linkIndicator(s, 9_001)?.text).toBe("reconnecting… (attempt 2, retry in 1s)");
    expect(linkIndicator(s, 10_000)?.text).toBe("reconnecting… (attempt 2, retrying now)");
    expect(
      linkIndicator({ ...s, error: "the daemon refused the upgrade (HTTP 502)" }, 5_500)?.text,
    ).toBe("reconnecting… (attempt 2, retry in 5s) — the daemon refused the upgrade (HTTP 502)");
  });

  test("stopped for another reason: disconnected, in the error tone", () => {
    expect(
      linkIndicator(
        { state: "stopped", reason: 'the connection target is gone: pod "p" is Failed' },
        0,
      ),
    ).toEqual({
      text: 'disconnected: the connection target is gone: pod "p" is Failed',
      tone: "error",
    });
    expect(linkIndicator({ state: "stopped", reason: "disconnected" }, 0)?.text).toBe(
      "disconnected",
    );
  });

  test("nextTickMs: when the countdown text changes next; null when nothing ticks", () => {
    const s = { state: "reconnecting", attempt: 1, nextAtMs: 10_000 } as const;
    expect(nextTickMs(s, 5_500)).toBe(500); // 5s → 4s at 6_000
    expect(nextTickMs(s, 6_000)).toBe(1000);
    expect(nextTickMs(s, 9_999)).toBe(1); // 1s → "retrying now"
    expect(nextTickMs(s, 10_000)).toBeNull();
    expect(nextTickMs({ state: "up" }, 0)).toBeNull();
    expect(nextTickMs({ state: "stopped", reason: "x" }, 0)).toBeNull();
    expect(nextTickMs(null, 0)).toBeNull();
  });
});
