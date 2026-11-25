/**
 * The link's diagnosis (docs/feat/mobile-pairing-screen.md 11b.1, Tests): an
 * authenticated `unauthorized` is `revoked`; three opened-but-unconfirmed
 * handshakes are `maybe-reset`; a dial that never opened is `unreachable` and
 * must not count toward the reset hint.
 */
import { describe, expect, test } from "bun:test";
import { ChannelError } from "@tentacle/client";
import {
  MAYBE_RESET_STREAK,
  createLinkDiagnoser,
  diagnosisMessage,
} from "../src/link-diagnosis.ts";

const denied = () => new ChannelError("unauthorized", "the daemon refused this device");
const unreachable = () => new ChannelError("unreachable", "secure channel: closed");
const neverOpened = () => new ChannelError("unreachable", "connect failed");

describe("createLinkDiagnoser", () => {
  test("unauthorized → revoked", () => {
    const diagnoser = createLinkDiagnoser();
    expect(diagnoser.observe({ opened: true, error: denied() })).toBe("revoked");
    expect(diagnoser.current()).toBe("revoked");
  });

  test("3 opened-but-closed handshakes → maybe-reset; 2 are still unreachable", () => {
    const diagnoser = createLinkDiagnoser();
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
    // Two attempts have proven nothing yet: the row must not claim a reset.
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("maybe-reset");
    expect(MAYBE_RESET_STREAK).toBe(3);
  });

  test("a dial that never opened does not count (mutation: count every failure → red)", () => {
    const diagnoser = createLinkDiagnoser();
    for (let i = 0; i < 5; i += 1) {
      expect(diagnoser.observe({ opened: false, error: neverOpened() })).toBe("unreachable");
    }
    // One opened-but-failed attempt after five unopened ones is only the FIRST
    // that proves the path works — it must not jump to maybe-reset.
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
  });

  test("success resets the count, so the streak is CONSECUTIVE", () => {
    const diagnoser = createLinkDiagnoser();
    diagnoser.observe({ opened: true, error: unreachable() });
    diagnoser.observe({ opened: true, error: unreachable() });
    expect(diagnoser.ok()).toBe("ok");
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("maybe-reset");
  });

  test("a revoked computer does not drag a later reset hint with it", () => {
    const diagnoser = createLinkDiagnoser();
    diagnoser.observe({ opened: true, error: unreachable() });
    diagnoser.observe({ opened: true, error: unreachable() });
    // The authenticated verdict is terminal: the count starts over.
    expect(diagnoser.observe({ opened: true, error: denied() })).toBe("revoked");
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
  });

  test("diagnosisMessage names the computer and never says 'reset' for an outage", () => {
    expect(diagnosisMessage("ok", "MacBook")).toBe("");
    expect(diagnosisMessage("revoked", "MacBook")).toContain("MacBook");
    expect(diagnosisMessage("revoked", "MacBook")).toContain("pair again");
    expect(diagnosisMessage("maybe-reset", "MacBook")).toContain("reset");
    const unreachableText = diagnosisMessage("unreachable", "MacBook");
    expect(unreachableText).toContain("MacBook");
    expect(unreachableText).not.toContain("reset");
    // F23: an older tentacle has no `/e2e`, so the wording must offer "update".
    expect(unreachableText).toContain("up to date");
  });

  test("R6: the unreachable sentence names the RELAY as a path (mutation: drop the word → red)", () => {
    // "Nowhere to go" is not the only cause any more: with a phone paired, the
    // relay is a path (docs/feat/mobile-relay.md R6), and a daemon whose relay is
    // off (`serve --no-relay`, an unreadable `relay.json`) is the usual reason it
    // was not taken. Naming it is what makes the sentence actionable.
    expect(diagnosisMessage("unreachable", "MacBook").toLowerCase()).toContain("relay");
    // The other verdicts are unchanged: a revoke or a reset is not about paths.
    expect(diagnosisMessage("revoked", "MacBook")).not.toContain("relay");
    expect(diagnosisMessage("maybe-reset", "MacBook")).not.toContain("relay");
  });
});

describe("the relay's 4404 = `absent` (docs/feat/mobile-projects.md §6)", () => {
  test("three 4404s → still unreachable + absent, never maybe-reset (mutation: count `absent` → red)", () => {
    const diagnoser = createLinkDiagnoser();
    for (let i = 0; i < MAYBE_RESET_STREAK + 1; i += 1) {
      expect(diagnoser.observe({ opened: true, error: unreachable(), absent: true })).toBe(
        "unreachable",
      );
      expect(diagnoser.absent()).toBe(true);
    }
  });

  test("a non-4404 failure or a success clears `absent`; an authenticated deny still wins", () => {
    const diagnoser = createLinkDiagnoser();
    diagnoser.observe({ opened: true, error: unreachable(), absent: true });
    diagnoser.observe({ opened: false, error: neverOpened() });
    expect(diagnoser.absent()).toBe(false);
    diagnoser.observe({ opened: true, error: unreachable(), absent: true });
    diagnoser.ok();
    expect(diagnoser.absent()).toBe(false);
    expect(diagnoser.observe({ opened: true, error: denied(), absent: true })).toBe("revoked");
  });
});

describe("an e2e version skew names the side to update (docs/feat/noise-binary-carrier.md)", () => {
  const skew = (remote: number) =>
    new ChannelError("rejected", "secure channel: version mismatch", undefined, remote);

  test("T-M1: remote 3 → update-app; remote 1 → update-computer; the reset streak is untouched", () => {
    const diagnoser = createLinkDiagnoser();
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
    // Skews in between say nothing about our key: they neither count nor reset the streak.
    expect(diagnoser.observe({ opened: true, error: skew(3) })).toBe("update-app");
    expect(diagnoser.observe({ opened: true, error: skew(1) })).toBe("update-computer");
    expect(diagnoser.current()).toBe("update-computer");
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("maybe-reset");
  });

  test("T-M1: skews do not COUNT toward the streak (a forged byte cannot hasten maybe-reset)", () => {
    const diagnoser = createLinkDiagnoser();
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
    expect(diagnoser.observe({ opened: true, error: skew(3) })).toBe("update-app");
    expect(diagnoser.observe({ opened: true, error: skew(1) })).toBe("update-computer");
    // One real failure after one before it: 2 — still below the reset threshold.
    expect(diagnoser.observe({ opened: true, error: unreachable() })).toBe("unreachable");
  });

  test("T-M1: the sentences — and maybe-reset now names an older tentacle (a v1 daemon just closes)", () => {
    expect(diagnosisMessage("update-app", "MacBook")).toContain("update the app");
    expect(diagnosisMessage("update-computer", "MacBook")).toContain("older than this app");
    expect(diagnosisMessage("maybe-reset", "MacBook")).toContain("older than this app");
  });
});
