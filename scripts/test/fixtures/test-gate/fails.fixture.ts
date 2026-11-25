/**
 * T1's failing fixture (`scripts/test/test-gate.test.ts`): a plain failing
 * test, which both runners count as a failure. It pins that the gate names the
 * file and the failing test, not only that it exits non-zero.
 */
import { expect, test } from "bun:test";

test("the failing fixture fails", () => {
  expect("actual").toBe("expected");
});
