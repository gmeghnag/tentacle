/**
 * The third shape of a cut reply (docs/feat/harness-notices.md S2.6): the loop
 * asked it to continue and it was cut AGAIN. Before, the TUI printed two near
 * identical lines (`…incomplete; asking it to continue` then `…incomplete`),
 * because the second sentence had to be different to pass the text-keyed
 * dedupe. One sentence says both facts now:
 *
 *   the reply was cut at the model's output limit — asked it to continue, cut
 *   again; this answer is incomplete
 *
 * RED before the fix: `again` did not exist, so this wording was unreachable.
 */
import { describe, expect, test } from "bun:test";
import { describeTruncation } from "../src/index.ts";

describe("describeTruncation with `again`", () => {
  test("a re-ask that was cut again says so, in ONE sentence", () => {
    const text = describeTruncation("length", { answered: true, retrying: false, again: true });
    expect(text).toBe(
      "the reply was cut at the model's output limit — asked it to continue, cut again; this answer is incomplete",
    );
    // The two facts the old pair of lines carried: the continuation was tried,
    // and the answer is still incomplete.
    expect(text).not.toContain("asking it to continue");
  });

  test("`again` with nothing said names the empty first reply", () => {
    const text = describeTruncation("length", { answered: false, retrying: false, again: true });
    expect(text).toContain("cut again");
    // Nothing reached the screen, so there is no answer to call incomplete: it
    // says nothing was produced, like the unanswered base sentence.
    expect(text).toContain("nothing was produced");
  });

  test("a stream cut outright is never 'asked again' — no re-ask follows a cut", () => {
    // The loop yields `cut` with `retrying: false` and never re-asks it, so an
    // `again` reaching here must not invent a continuation.
    const text = describeTruncation("cut", { answered: true, retrying: false, again: true });
    expect(text).not.toContain("asked it to continue");
    expect(text).toContain("stream was cut");
  });

  test("absent `again` keeps every existing sentence byte-identical", () => {
    // Mutation: fold `again` into the base sentence → one of these changes.
    expect(describeTruncation("length", { answered: true, retrying: true })).toBe(
      "the reply was cut at the model's output limit — this answer is incomplete; asking it to continue",
    );
    expect(describeTruncation("length", { answered: true, retrying: false })).toBe(
      "the reply was cut at the model's output limit — this answer is incomplete",
    );
  });
});
