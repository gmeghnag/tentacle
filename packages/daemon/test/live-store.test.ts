/**
 * The Live Activity registration store — `<configDir>/devices/live/<id>.json`
 * (docs/feat/mobile-live-activity.md Design 4, L5).
 *
 * It is task 16's push store with a different record, and it must hold the SAME
 * properties, each with the mutation that would fake it:
 *
 *  - **0600, tmp + rename**: a start token is a bearer credential for a phone's
 *    lock screen; a world-readable or half-written one is worse than none.
 *  - **An unknown `v` / bad field is SKIPPED and the bytes LEFT ALONE** (AGENTS
 *    §7's on-disk rule, F22): a newer daemon's record is not this build's to
 *    destroy, and that device is simply not started this time.
 *  - **Compare-and-delete** (F13): a `gone` from APNs names the token that
 *    failed; if the file already holds a fresh one, the delete is a no-op.
 *  - **A revoke / reset removes it**, next to `push/<id>.json` (F11/F12).
 *
 * The one thing this store does NOT hold is an activity's UPDATE token: those
 * live in daemon memory only (Owner Q8), because an activity lives ≤ 12 h and a
 * restart's activities go stale anyway.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_RECORD_VERSION,
  clearLiveRegistrations,
  deleteLiveRegistration,
  forgetLiveRegistration,
  liveDir,
  livePathOf,
  readLiveRegistration,
  readLiveRegistrations,
  writeLiveRegistration,
} from "../src/live-store.ts";

let configDir: string;
const DEVICE = "0123456789abcdef";
const OTHER = "fedcba9876543210";

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "tentacle-live-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** A registration as the store reads it back (the switch defaults to ON: opt-out). */
const registration = (over: Record<string, unknown> = {}) => ({
  deviceId: DEVICE,
  startToken: "a".repeat(64),
  env: "sandbox" as const,
  enabled: true,
  registeredAt: 1_731_000_000_000,
  ...over,
});

describe("the record on disk", () => {
  test("a write round-trips, at 0600, under devices/live", () => {
    const written = writeLiveRegistration(configDir, registration());
    expect(written.ok).toBe(true);
    expect(written.path).toBe(livePathOf(configDir, DEVICE));
    expect(written.path).toContain(join("devices", "live"));
    // 0600: the token is a credential, and the file is the only place it rests.
    expect(statSync(written.path).mode & 0o777).toBe(0o600);

    const read = readLiveRegistration(configDir, DEVICE);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.registration).toEqual(registration());
    }
  });

  test("the file carries its own version, apart from PROTOCOL_VERSION", () => {
    const written = writeLiveRegistration(configDir, registration());
    expect(written.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(written.path, "utf8")) as { v: number };
    expect(onDisk.v).toBe(LIVE_RECORD_VERSION);
  });

  test("a missing file is `missing`, not an error (a fresh device)", () => {
    const read = readLiveRegistration(configDir, OTHER);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.missing).toBe(true);
    }
  });

  test("the wire's schema is the gate: a bad token or env is refused, nothing written", () => {
    expect(writeLiveRegistration(configDir, registration({ startToken: "zz" })).ok).toBe(false);
    expect(writeLiveRegistration(configDir, registration({ env: "moon" })).ok).toBe(false);
    expect(writeLiveRegistration(configDir, registration({ deviceId: "nope" })).ok).toBe(false);
    expect(readLiveRegistration(configDir, DEVICE).ok).toBe(false);
  });

  test("`enabled` is part of the record: the person's switch survives a restart", () => {
    const written = writeLiveRegistration(configDir, { ...registration(), enabled: false });
    expect(written.ok).toBe(true);
    const read = readLiveRegistration(configDir, DEVICE);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.registration.enabled).toBe(false);
    }
  });
});

describe("an unreadable record is SKIPPED and left byte-identical (F22)", () => {
  test("an unknown version is not rewritten", () => {
    mkdirSync(liveDir(configDir), { recursive: true });
    const path = livePathOf(configDir, DEVICE);
    // A record that is valid in EVERY field but its version, so the version guard
    // is the only thing that can make it unusable (mutation: drop the `v` check →
    // this record parses, and the test fails).
    const future = JSON.stringify({
      v: 99,
      startToken: "a".repeat(64),
      env: "sandbox",
      enabled: true,
      registeredAt: 1_731_000_000_000,
    });
    writeFileSync(path, future, { mode: 0o600 });

    const read = readLiveRegistration(configDir, DEVICE);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toContain("unsupported");
    }
    // The bytes are EXACTLY as found: a newer build's record is not ours to fix.
    expect(readFileSync(path, "utf8")).toBe(future);

    // And the bulk read reports it as a skip, with no registration for it.
    const { registrations, skipped } = readLiveRegistrations(configDir);
    expect(registrations.size).toBe(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.path).toBe(path);
  });

  test("a malformed JSON file is also left alone", () => {
    mkdirSync(liveDir(configDir), { recursive: true });
    const path = livePathOf(configDir, DEVICE);
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(readLiveRegistration(configDir, DEVICE).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  test("a temp file mid-write is not a record at all", () => {
    mkdirSync(liveDir(configDir), { recursive: true });
    writeFileSync(join(liveDir(configDir), `${DEVICE}.json.123.abc.tmp`), "{}");
    const { registrations, skipped } = readLiveRegistrations(configDir);
    expect(registrations.size).toBe(0);
    expect(skipped).toHaveLength(0);
  });

  test("the bulk read keys by device id and skips the unusable", () => {
    writeLiveRegistration(configDir, registration());
    writeLiveRegistration(configDir, registration({ deviceId: OTHER, startToken: "b".repeat(64) }));
    const { registrations, skipped } = readLiveRegistrations(configDir);
    expect([...registrations.keys()].sort()).toEqual([DEVICE, OTHER].sort());
    expect(skipped).toHaveLength(0);
  });

  test("no directory at all is empty, not an error", () => {
    const { registrations, skipped } = readLiveRegistrations(configDir);
    expect(registrations.size).toBe(0);
    expect(skipped).toHaveLength(0);
  });
});

describe("deleting", () => {
  test("compare-and-delete removes the file only when the token still matches (F13)", () => {
    writeLiveRegistration(configDir, registration({ startToken: "a".repeat(64) }));
    // A `gone` for an OLDER token: the file holds a newer one, so it stays.
    expect(deleteLiveRegistration(configDir, DEVICE, "c".repeat(64))).toBe("kept-newer-token");
    expect(readLiveRegistration(configDir, DEVICE).ok).toBe(true);
    // A `gone` for the token it holds: removed.
    expect(deleteLiveRegistration(configDir, DEVICE, "a".repeat(64))).toBe("deleted");
    expect(readLiveRegistration(configDir, DEVICE).ok).toBe(false);
  });

  test("deleting an absent registration is `absent`, not a throw", () => {
    expect(deleteLiveRegistration(configDir, DEVICE, "a".repeat(64))).toBe("absent");
  });

  test("a revoke's `forget` removes it whatever token it holds (the person's instruction)", () => {
    writeLiveRegistration(configDir, registration());
    expect(forgetLiveRegistration(configDir, DEVICE)).toBe("deleted");
    expect(readLiveRegistration(configDir, DEVICE).ok).toBe(false);
    // Idempotent: an unregister twice is not an error.
    expect(forgetLiveRegistration(configDir, DEVICE)).toBe("deleted");
  });

  test("`devices reset` clears every record and reports how many went", () => {
    writeLiveRegistration(configDir, registration());
    writeLiveRegistration(configDir, registration({ deviceId: OTHER }));
    expect(clearLiveRegistrations(configDir)).toBe(2);
    expect(readLiveRegistrations(configDir).registrations.size).toBe(0);
    // Nothing to clear is 0, not a throw.
    expect(clearLiveRegistrations(configDir)).toBe(0);
  });
});
