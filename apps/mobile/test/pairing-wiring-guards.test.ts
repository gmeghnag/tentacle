/**
 * The wiring `App.tsx` must not lose (fix round 1 findings 1 and 2;
 * docs/feat/mobile-pairing-screen.md F-L1/F11).
 *
 * `App.tsx` imports React Native, whose sources are Flow, so no test can import
 * it — Bun cannot even parse it. The DECISIONS behind these two lines are
 * therefore tested in pure modules (`computer-memory.test.ts`,
 * `connection.test.ts`); what is left here is the one thing only the wiring can
 * get wrong: not calling it at all, or calling it after the re-read.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const app = readFileSync(join(APP, "App.tsx"), "utf8");

/** The body of one `App.tsx` block, from `from` to the first `}` at its indent. */
function body(from: string): string {
  const start = app.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  return app.slice(start, app.indexOf("\n              }", start));
}

describe("a successful pairing forgets what the app remembered about that computer", () => {
  test("`onDone` forgets the link and the diagnosis BEFORE reloading (mutation: drop the call → red)", () => {
    const onDone = body("onDone={(computerId, superseded) => {");
    // The id comes from the OUTCOME, not from the `again` route param: a fresh
    // pairing has no route param, and it needs forgetting all the same.
    expect(onDone).toContain("withForgottenRecord(MEMORY, computerId");
    // Order: the forget must run before the reload that re-dials the computer.
    expect(onDone.indexOf("withForgottenRecord")).toBeLessThan(onDone.indexOf("reload()"));
    // And `reload()` must be the step INSIDE it, not a loose call before it.
    expect(onDone.slice(onDone.indexOf("withForgottenRecord"))).toContain("await reload()");
  });

  test("Remove goes through the same one step (mutation: back to a bare LINKS.release → red)", () => {
    const onRemove = body("onRemove={async (row) => {");
    expect(onRemove).toContain("withForgottenRecord(MEMORY, row.id");
    // No second, hand-rolled teardown: one place decides what is forgotten.
    expect(onRemove).not.toContain("LINKS.release");
    expect(onRemove).not.toContain("DIAGNOSES.delete");
    expect(onRemove).not.toContain("RECORDS.delete");
  });

  test("`MEMORY` is the app's real registry, diagnosis map and record cache", () => {
    expect(app).toContain("links: LINKS,");
    expect(app).toContain("diagnoses: DIAGNOSES,");
    expect(app).toContain("records: RECORDS,");
  });
});
