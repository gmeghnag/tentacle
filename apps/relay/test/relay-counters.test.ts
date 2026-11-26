// Log line → counter (docs/feat/relay-status.md): the lines are the ones
// `server.ts` writes; `server-status.test.ts` pins the coupling over sockets.
import { describe, expect, test } from "bun:test";
import { RELAY_COUNTERS, type RelayCounter, counterOfLogLine } from "../src/relay-counters.ts";

const TABLE: readonly (readonly [string, RelayCounter | undefined])[] = [
  ["dial-open abcdefgh", "dials"],
  ["dial-held abcdefgh", "dials"],
  ["ready abcdefgh", "registrations"],
  ["dial-refused rate abcdefgh", "refusedRate"],
  ["dial-refused concurrency abcdefgh", "refusedConcurrency"],
  ["pending-refused s1", "refusedPending"],
  ["hello-refused s1", "refusedHello"],
  ["accept-refused unknown", "refusedAccept"],
  ["accept-refused expired", "refusedAccept"],
  ["phone-oversize-drop s1", "refusedOversize"],
  ["frame-oversize s1", "refusedOversize"],
  ["control-oversize s1", "refusedOversize"],
  ["accept-oversize s1", "refusedOversize"],
  ["push-refused s1 throttled rate", "refusedThrottled"],
  ["push-refused s1 rejected unregistered", "pushesRejected"],
  ["push-refused s1 unavailable no-push", "pushesRejected"],
  ["liveactivity-refused s1 throttled rate", "refusedThrottled"],
  ["liveactivity-refused s1 rejected payload", "pushesRejected"],
  ["push-rejected s1 payload", "pushesRejected"],
  ["liveactivity-rejected s1 payload", "pushesRejected"],
  ["push aaaaaaaa sent", "pushesSent"],
  ["push aaaaaaaa gone Unregistered", "pushesFailed"],
  ["push aaaaaaaa unavailable timeout", "pushesFailed"],
  ["liveactivity aaaaaaaa sent", "pushesSent"],
  ["liveactivity aaaaaaaa rejected other", "pushesFailed"],
  // Not counted.
  ["log-suppressed dial-refused 40", undefined],
  ["accept abcdefgh", undefined],
  ["binary-frame s1", undefined],
  ["control-malformed s1", undefined],
  ["control-unexpected s1 ping", undefined],
  ["accept-malformed s1", undefined],
  ["push on: topic x key y", undefined],
  ["push off: no key", undefined],
  ["status-off EADDRINUSE", undefined],
  ["constructor", undefined],
  ["", undefined],
];

describe("counterOfLogLine", () => {
  test("the mapping table", () => {
    for (const [line, counter] of TABLE) {
      expect({ line, counter: counterOfLogLine(line) }).toEqual({ line, counter });
    }
  });

  test("every counter it returns is declared", () => {
    for (const [, counter] of TABLE) {
      if (counter !== undefined) {
        expect(RELAY_COUNTERS).toContain(counter);
      }
    }
    expect(RELAY_COUNTERS).toContain("bytesRelayed");
    expect(RELAY_COUNTERS).toContain("refusedPing");
  });
});
