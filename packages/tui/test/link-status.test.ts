import { describe, expect, test } from "bun:test";
import { STOP_NOTICE_MAX, linkIndicator, nextTickMs, stoppedNotice } from "../src/link-status.ts";

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

describe("stoppedNotice (pure: the full reason, once, in the transcript)", () => {
  test("a stop with a reason → the whole reason, untruncated", () => {
    const reason =
      'incompatible daemon: protocol version mismatch: client 10 (tentacle 0.1.0), daemon 11 (tentacle 0.2.0) — update this client: "tentacle update"';
    expect(stoppedNotice({ state: "stopped", reason })).toBe(`Link stopped: ${reason}`);
  });

  test("a hostile daemon's reason: no control characters reach the terminal, and it is capped", () => {
    // The reason embeds a daemon-supplied message (a container is not trusted, AGENTS §7).
    const hostile = "incompatible daemon: \u001b[2J\u001b]0;pwned\u0007ok\r\nnext‮evil";
    const text = stoppedNotice({ state: "stopped", reason: hostile }) ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
    expect(text).toBe("Link stopped: incompatible daemon: [2J ]0;pwned ok nextevil");
    const huge = stoppedNotice({ state: "stopped", reason: "x".repeat(10_240) }) ?? "";
    expect(huge.length).toBeLessThanOrEqual(STOP_NOTICE_MAX + "Link stopped: ".length);
    expect(huge.endsWith("…")).toBe(true);
  });

  test("our own close, a plain disconnect, up and reconnecting → nothing", () => {
    expect(stoppedNotice({ state: "stopped", reason: "closed" })).toBeNull();
    expect(stoppedNotice({ state: "stopped", reason: "disconnected" })).toBeNull();
    expect(stoppedNotice({ state: "up" })).toBeNull();
    expect(
      stoppedNotice({ state: "reconnecting", attempt: 1, nextAtMs: 0, error: "x" }),
    ).toBeNull();
  });
});
