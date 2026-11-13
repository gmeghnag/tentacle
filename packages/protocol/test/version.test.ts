/**
 * The ONE place the exact wire version is asserted
 * (docs/feat/protocol-version-at-merge.md).
 *
 * `PROTOCOL_VERSION` is assigned at MERGE time by `bun run protocol:bump`, from
 * the `protocol.d/<slug>.md` notes the branches left behind — so a task never
 * edits the number, and two parallel breaking changes never conflict. That only
 * works if a bump is TWO hunks: `version.ts` (a note + the number) and the single
 * line below. Every other test asserts a FLOOR
 * (`toBeGreaterThanOrEqual(<n>)`), the property it actually needs — "this kind
 * or field landed no earlier than the number that existed when it was added" —
 * so it never has to move again.
 *
 * The two guards below are what keep the pin honest: a number with no matching
 * reason comment, or a reason block edited out of order, is red here rather than
 * silently shipped in a version whose comment block lies.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBumps, readVersion } from "../../../scripts/protocol-bump.ts";
import { PROTOCOL_VERSION } from "../src/index.ts";

const VERSION_TS = join(import.meta.dir, "..", "src", "version.ts");

describe("the wire version", () => {
  test("PROTOCOL_VERSION is the number this build speaks", () => {
    // THE pin. A bump edits this line and `version.ts`; nothing else.
    // Mutation: change `version.ts:32` alone → red.
    expect(PROTOCOL_VERSION).toBe(24);
  });

  test("the newest reason comment names the number the file exports", () => {
    // A hand-bump that skips the reason (or an edit to one and not the other):
    // `version.ts` would claim a number its own block does not explain.
    const text = readFileSync(VERSION_TS, "utf8");
    const bumps = readBumps(text);
    expect(bumps.length).toBeGreaterThan(0);
    expect(bumps[bumps.length - 1]?.number).toBe(readVersion(text));
  });

  test("the reason block numbers are consecutive (a fold that mis-numbers is red)", () => {
    const numbers = readBumps(readFileSync(VERSION_TS, "utf8")).map((b) => b.number);
    const first = numbers[0] ?? 0;
    expect(numbers).toEqual(numbers.map((_n, i) => first + i));
    // And it holds the current number: a reader that silently stopped at a blank
    // or a wrapped line would pass the check above over a truncated block.
    expect(numbers.length).toBe(readVersion(readFileSync(VERSION_TS, "utf8")) - first + 1);
  });
});
