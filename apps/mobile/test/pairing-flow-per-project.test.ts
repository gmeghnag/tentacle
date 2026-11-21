/**
 * `runPairing` asks for a PER-PROJECT pairing (docs/feat/mobile-projects.md,
 * Owner decision on F2, option (i′)).
 *
 * The daemon refuses a `device/pair` that does not say `perProject` (`update_app`,
 * `pairing-handler.ts`): an app filing per computer would overwrite the record —
 * and the device key — of the project it already used. The end-to-end proof is
 * `pairing-e2e.test.ts` (7 tests, all `update_app` before this change); this file
 * pins the ONE line they hinge on, cheaply, so a future edit of the runner cannot
 * drop it while `pairing-e2e` is skipped.
 *
 * Why a SOURCE guard rather than a stubbed `pairDevice`: `pairing-flow.ts` imports
 * `pairDevice` as an ES binding, so the only way to observe the argument without a
 * socket is `mock.module` — which is process-wide in Bun and leaves the seven
 * real-daemon pairing tests above reading a fake (measured: 6 of them fail when
 * this file shares the run). Reading the call is the honest seam here; the socket
 * proof stays in `pairing-e2e.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PairDeviceResult } from "@tentacle/client/pairing";
import type { PairingPayload } from "@tentacle/protocol";
import { projectRecordId } from "../src/computer-store.ts";
import { projectMismatch, recordFor } from "../src/pairing-flow.ts";

const APP = join(import.meta.dir, "..");
const flow = readFileSync(join(APP, "src", "pairing-flow.ts"), "utf8");

/** The `pairDevice({ … })` call's argument block, from its `(` to the closing `});`. */
function pairDeviceArgs(): string {
  const start = flow.indexOf("await pairDevice({");
  expect(start).toBeGreaterThan(-1);
  return flow.slice(start, flow.indexOf("\n    });", start));
}

describe("runPairing pairs PER PROJECT (owner decision (i′))", () => {
  test("the `pairDevice` call says `perProject: true` (mutation: drop it → red, and the daemon answers `update_app`)", () => {
    const args = pairDeviceArgs();
    // Positive control: it really is the pairing call we think it is.
    expect(args).toContain("deviceKey: keypair.privateKey");
    expect(args).toContain("name: deviceName");
    // The property: an app that does not say this is refused outright.
    expect(args).toContain("perProject: true,");
  });
});

// Slice (b): the record is filed PER PROJECT (§6), which retires (i′)'s
// transitional "stored under `result.computer.id`" pin above.
const result = (project?: { key: string; cwd: string; label: string }): PairDeviceResult => ({
  deviceId: "phone-id",
  computer: { id: "mac-id", name: "MacBook" },
  ...(project === undefined ? {} : { project }),
});
const payload = (project?: string): PairingPayload => ({
  v: 1,
  computer: "MacBook",
  key: new Uint8Array(32).fill(7),
  addresses: ["ws://192.168.1.20:4000/s/AAAAAAAAAAAAAAAAAAAAAA/e2e"],
  code: "c",
  ...(project === undefined ? {} : { project }),
});
const P = { key: "tentacle-aaaaaaaaaaaa", cwd: "/u/tentacle", label: "tentacle" };

describe("recordFor: where a pairing is filed (§6)", () => {
  test("a per-project result → projectRecordId, with computerId + project (mutation: id = computer id → red)", () => {
    const record = recordFor(result(P), payload("tentacle"), "iPhone", 5);
    expect(record.id).toBe(projectRecordId("mac-id", P.key));
    expect(record.computerId).toBe("mac-id");
    expect(record.project).toEqual(P);
    expect(record.thisDeviceName).toBe("iPhone");
  });

  test("an older daemon's result (no project, F8) → the computer id, as before", () => {
    const record = recordFor(result(), payload(), "iPhone", 5);
    expect(record.id).toBe("mac-id");
    expect(record.computerId).toBeUndefined();
    expect(record.project).toBeUndefined();
  });
});

describe("projectMismatch (F17)", () => {
  test("p= names another project than the daemon's → a failure naming both", () => {
    const failure = projectMismatch(result(P), payload("assistant"));
    expect(failure?.reason).toBe("project-mismatch");
    expect(failure?.message).toContain("'assistant'");
    expect(failure?.message).toContain("'tentacle'");
  });

  test("same label, no p=, or no project in the result → no failure", () => {
    expect(projectMismatch(result(P), payload("tentacle"))).toBeUndefined();
    expect(projectMismatch(result(P), payload())).toBeUndefined();
    expect(projectMismatch(result(), payload("tentacle"))).toBeUndefined();
  });
});
