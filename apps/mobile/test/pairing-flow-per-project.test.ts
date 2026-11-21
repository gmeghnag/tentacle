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

  test("(i′) keeps the transitional record id: stored under `result.computer.id` until slice (b)", () => {
    // Pairing another project REPLACES the phone's one record per computer, and
    // push routing already matches that id (`push-manager.ts`), so (b) — which
    // keys records per project — is what moves both together.
    expect(flow).toContain("id: result.computer.id,");
    expect(flow).not.toContain("id: result.project");
  });
});
