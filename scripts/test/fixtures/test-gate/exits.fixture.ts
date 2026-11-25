/**
 * T1's crashing fixture (`scripts/test/test-gate.test.ts`): a file that ends
 * its own process with status 0 before its test can be reported.
 *
 * This is the whole point of running the suite with `--parallel`: the SERIAL
 * runner dies with this file and still exits 0, silently losing the file AND
 * its verdict; the parallel runner reports
 * `✗ exits.fixture.ts (worker crashed: exit code 0)`, counts it as a fail and
 * exits 1.
 */
import { test } from "bun:test";

test("the crashing fixture never gets to report", () => {
  process.exit(0);
});
