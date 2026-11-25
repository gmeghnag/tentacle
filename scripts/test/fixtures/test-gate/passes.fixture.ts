/**
 * T1's control fixture (`scripts/test/test-gate.test.ts`): a file that PASSES,
 * so the assertion "the gate exits non-zero" cannot pass merely because the
 * runner is always red. Named `*.fixture.ts` on purpose: Bun's discovery picks
 * `*.test.ts` only, so the suite never runs this file on its own.
 */
import { expect, test } from "bun:test";

test("the control fixture passes", () => {
  expect(1 + 1).toBe(2);
});
