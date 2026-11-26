// The pure half of `/__status` (docs/feat/relay-status.md): the per-minute ring
// and the request gate. Time is injected; nothing here opens a socket.
import { describe, expect, test } from "bun:test";
import { createMinuteStats, statusResponse } from "../src/status.ts";

const MINUTE = 60_000;
/** A minute boundary, so offsets inside a minute are easy to read. */
const START = 1_000_000 * MINUTE;

function stats() {
  let at = START;
  const instance = createMinuteStats({ now: () => at, counters: ["dials", "bytes"] });
  return {
    stats: instance,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("createMinuteStats", () => {
  test("totals sum every add, zero-filled for a counter never touched", () => {
    const { stats: s, advance } = stats();
    s.add("dials");
    s.add("dials", 2);
    advance(5 * MINUTE);
    s.add("dials");
    expect(s.snapshot().totals).toEqual({ dials: 4, bytes: 0 });
  });

  test("uptime is whole seconds since creation, never negative", () => {
    const { stats: s, advance } = stats();
    advance(90_500);
    expect(s.snapshot().uptimeSeconds).toBe(90);
    advance(-200_000);
    expect(s.snapshot().uptimeSeconds).toBe(0);
  });

  test("a minute rollover opens a new sparse entry, oldest first", () => {
    const { stats: s, advance } = stats();
    s.add("dials");
    advance(MINUTE - 1);
    s.add("bytes", 10);
    advance(1);
    s.add("dials", 3);
    expect(s.snapshot().history).toEqual([
      { at: START, dials: 1, bytes: 10 },
      { at: START + MINUTE, dials: 3 },
    ]);
  });

  test("lastMinute is the previous COMPLETE minute, zero-filled, never the current one", () => {
    const { stats: s, advance } = stats();
    s.add("dials", 2);
    expect(s.snapshot().lastMinute).toEqual({ dials: 0, bytes: 0 });
    advance(MINUTE);
    s.add("dials", 7);
    s.add("bytes", 7);
    expect(s.snapshot().lastMinute).toEqual({ dials: 2, bytes: 0 });
    // A minute with nothing recorded is "no data": all zero, and not in history.
    advance(2 * MINUTE);
    expect(s.snapshot().lastMinute).toEqual({ dials: 0, bytes: 0 });
    expect(s.snapshot().history.map((entry) => entry.at)).toEqual([START, START + MINUTE]);
  });

  test("a gauge keeps the LAST sample of its minute (0 included), and is not a counter", () => {
    const { stats: s, advance } = stats();
    s.set("live", 5);
    s.set("live", 2);
    advance(MINUTE);
    s.set("live", 9);
    s.set("live", 0);
    const snapshot = s.snapshot();
    expect(snapshot.history).toEqual([
      { at: START, live: 2 },
      { at: START + MINUTE, live: 0 },
    ]);
    expect(snapshot.totals).toEqual({ dials: 0, bytes: 0 });
    expect(snapshot.lastMinute).toEqual({ dials: 0, bytes: 0 });
  });

  test("the ring keeps exactly 1440 minutes", () => {
    const { stats: s, advance } = stats();
    for (let i = 0; i < 1445; i += 1) {
      if (i > 0) {
        advance(MINUTE);
      }
      s.add("dials");
    }
    const { history, totals } = s.snapshot();
    expect(history.length).toBe(1440);
    expect(history[0]?.at).toBe(START + 5 * MINUTE);
    expect(history[1439]?.at).toBe(START + 1444 * MINUTE);
    expect(history.every((entry) => entry.dials === 1)).toBe(true);
    expect(totals.dials).toBe(1445);
  });

  test("a gap longer than 24 h leaves no stale entry behind", () => {
    const { stats: s, advance } = stats();
    s.add("dials", 5);
    advance(1441 * MINUTE);
    expect(s.snapshot().history).toEqual([]);
    // The same ring slot, reused a day later: reset, not summed.
    advance(1439 * MINUTE);
    s.add("dials");
    expect(s.snapshot().history).toEqual([{ at: START + 2880 * MINUTE, dials: 1 }]);
  });

  test("an old slot is not read as lastMinute a day later", () => {
    const { stats: s, advance } = stats();
    s.add("dials", 5);
    advance(1441 * MINUTE);
    expect(s.snapshot().lastMinute).toEqual({ dials: 0, bytes: 0 });
  });

  test("after a clock step back, slots from the 'future' are ignored", () => {
    const { stats: s, advance } = stats();
    advance(10 * MINUTE);
    s.add("dials", 4);
    advance(-3 * MINUTE);
    s.add("dials");
    expect(s.snapshot().history).toEqual([{ at: START + 7 * MINUTE, dials: 1 }]);
  });
});

describe("statusResponse — the request gate", () => {
  const ok = {
    method: "GET",
    pathname: "/__status",
    peer: "127.0.0.1",
    headers: { host: "127.0.0.1:4101" } as Record<string, string>,
  };

  async function ask(overrides: Partial<typeof ok> = {}) {
    let calls = 0;
    const input = { ...ok, ...overrides };
    const response = statusResponse({ ...input, headers: new Headers(input.headers) }, () => {
      calls += 1;
      return { service: "x" };
    });
    return { status: response.status, response, calls };
  }

  test("every loopback form gets 200 JSON, not cached", async () => {
    for (const peer of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"]) {
      for (const host of ["127.0.0.1", "127.0.0.1:4101", "localhost:9", "[::1]", "[::1]:4101"]) {
        const { status, response, calls } = await ask({ peer, headers: { host } });
        expect({ peer, host, status, calls }).toEqual({ peer, host, status: 200, calls: 1 });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ service: "x" });
      }
    }
  });

  async function refused(overrides: Partial<typeof ok>) {
    const { status, response, calls } = await ask(overrides);
    expect({ overrides, status, calls }).toEqual({ overrides, status: 404, calls: 0 });
    expect(await response.text()).toBe("not found");
  }

  test("a non-loopback peer is a 404 and the body is never built", async () => {
    for (const peer of ["203.0.113.7", "", "10.0.0.1", "::ffff:10.0.0.1", "128.0.0.1"]) {
      await refused({ peer });
    }
  });

  test("each proxy header ALONE is a 404, even empty", async () => {
    for (const name of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "via",
    ]) {
      await refused({ headers: { host: "127.0.0.1", [name]: "127.0.0.1" } });
      await refused({ headers: { host: "127.0.0.1", [name]: "" } });
    }
  });

  test("a public (or missing) Host is a 404", async () => {
    for (const host of [
      "relay.tentacle.so",
      "127.0.0.1.evil.example",
      "localhost.evil.example:80",
      "evil.example:127.0.0.1",
      "10.0.0.1:4101",
      "::1",
      "",
    ]) {
      await refused({ headers: { host } });
    }
    await refused({ headers: {} });
  });

  test("only GET, only the exact path", async () => {
    for (const method of ["POST", "HEAD", "PUT", "OPTIONS"]) {
      await refused({ method });
    }
    for (const pathname of ["/", "/__status/", "/__STATUS", "/healthz", "//__status"]) {
      await refused({ pathname });
    }
  });
});
