/**
 * Where an incoming pairing link goes while the navigator may not exist yet
 * (docs/feat/mobile-pairing-screen.md 11b.2, F-P17; AGENTS §7).
 *
 * The defect these tests pin: `App` shows a spinner while it reads the store and
 * mounts `NavigationContainer` only afterwards, so `navigationRef.navigate(...)`
 * from a COLD-start `Linking.getInitialURL()` (which resolves first, on the slow
 * path) was a silent NO-OP — the app stayed on the intake. Flow `19-deep-link`
 * sat there for its whole timeout.
 */
import { describe, expect, test } from "bun:test";
import { handlePairingText, takePendingLink } from "../src/pending-link.ts";

const TEXT = "tentacle://pair?v=1&k=AAA&n=MacBook&c=ABCDEFGHJK&a=ws%3A%2F%2Fh%3A1%2Fe2e";

describe("handlePairingText: a link is routed now, or parked", () => {
  test("navigator ready → route it now", () => {
    expect(handlePairingText(TEXT, true)).toEqual({ action: "route", text: TEXT });
  });

  test("navigator NOT ready (cold start) → HOLD it, never drop it (mutation: always route → red)", () => {
    // Dropping it is the bug: the link arrived, and nothing happens.
    expect(handlePairingText(TEXT, false)).toEqual({ action: "hold", text: TEXT });
  });

  test("no link at all → ignore (and no hold is created)", () => {
    expect(handlePairingText(undefined, true)).toEqual({ action: "ignore" });
    expect(handlePairingText(undefined, false)).toEqual({ action: "ignore" });
  });
});

describe("takePendingLink: the parked link is replayed exactly once", () => {
  test("a parked link is returned when the navigator becomes ready", () => {
    expect(takePendingLink(TEXT, true)).toBe(TEXT);
  });

  test("nothing parked → nothing to route", () => {
    expect(takePendingLink(undefined, true)).toBeUndefined();
  });

  test("not ready yet → still nothing (the link stays parked) (mutation: drain early → red)", () => {
    // Draining before the navigator exists would throw the link away — the same
    // silent drop, one layer down.
    expect(takePendingLink(TEXT, false)).toBeUndefined();
  });
});
