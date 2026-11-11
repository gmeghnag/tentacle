/**
 * The plain CLI shows the same two notices as the TUI, with the SAME wording
 * (one pure function, docs/fix/truncated-reply-silent.md; AGENTS §7).
 *
 * The trace goes to stderr so stdout stays clean data (the existing split):
 * a notice is not part of the answer.
 *
 * RED before the fix: `render` had no arm, so neither line was ever written.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@tentacle/agent";
import { describeEmptyTurn, describeTruncation } from "@tentacle/core";
import { AnswerSplit, render } from "../src/render.ts";

describe("cli render: the truncation notices", () => {
  test("a cut reply says so, in the shared wording", () => {
    const out = render({ type: "truncated_reply", reason: "length", retrying: true });
    expect(out).toContain("[truncated]");
    expect(out).toContain(describeTruncation("length", { answered: true, retrying: true }));
    expect(out).toContain("incomplete");
  });

  test("a stream cut outright uses the other sentence", () => {
    const out = render({ type: "truncated_reply", reason: "cut", retrying: false });
    expect(out).toContain(describeTruncation("cut", { answered: true, retrying: false }));
    expect(out).toContain("stream was cut");
  });

  test("an empty turn says so, in the shared wording", () => {
    const out = render({ type: "empty_turn" });
    expect(out).toContain("[empty turn]");
    expect(out).toContain(describeEmptyTurn());
  });

  test("the loop's own nudge is still hidden — only the notice is new", () => {
    expect(
      render({ type: "context_note", text: "Continue with the task.", reason: "continue" }),
    ).toBe("");
  });
});

describe("cli AnswerSplit: the truncation notice is once per FACT, and honest", () => {
  test("the same fact twice shows it ONCE, then a new turn may again", () => {
    const split = new AnswerSplit();
    const cut = (): string => {
      const chunk = split.push({ type: "truncated_reply", reason: "length", retrying: true });
      return `${chunk.out}${chunk.err}`;
    };
    expect(cut()).toContain("[truncated]");
    // The second round of the SAME turn, same fact: quiet.
    expect(cut()).toBe("");
    const end = split.push({ type: "turn_end", reason: "end_turn" });
    expect(`${end.out}${end.err}`).toBe("");
    // A new turn says it again.
    expect(cut()).toContain("[truncated]");
  });

  test("the owner's case: a re-ask that is ALSO cut gets its own line, and never promises another (Review MEDIUM-2)", () => {
    // On the buggy code every `truncated_reply` after the first in a turn was
    // dropped, so the screen ended telling the user a continuation was coming
    // when the budget was already spent. The key is `(reason, retrying)` now.
    const split = new AnswerSplit();
    split.push({ type: "text", delta: "la vera" });
    const first = split.push({ type: "truncated_reply", reason: "length", retrying: true });
    expect(first.err).toContain("asking it to continue");
    const second = split.push({ type: "truncated_reply", reason: "length", retrying: false });
    expect(second.err).toContain("[truncated]");
    expect(second.err).toContain("this answer is incomplete");
    expect(second.err).not.toContain("asking it to continue");
    // And a THIRD with the same fact as the second is a repeat again.
    expect(split.push({ type: "truncated_reply", reason: "length", retrying: false }).err).toBe("");
  });

  test("a `cut` after a `length` is a different fact: shown, never dropped", () => {
    const split = new AnswerSplit();
    split.push({ type: "text", delta: "la vera" });
    expect(split.push({ type: "truncated_reply", reason: "length", retrying: true }).err).toContain(
      "output limit",
    );
    expect(split.push({ type: "truncated_reply", reason: "cut", retrying: false }).err).toContain(
      "stream was cut",
    );
  });

  test("with no answer text on stdout, the line says the model returned nothing", () => {
    const split = new AnswerSplit();
    const chunk = split.push({ type: "truncated_reply", reason: "length", retrying: true });
    expect(chunk.err).toContain("returned nothing");
    expect(chunk.err).not.toContain("this answer is incomplete");
  });

  test("after an answer WAS written, the line says the answer is incomplete", () => {
    const split = new AnswerSplit();
    split.push({ type: "text", delta: "la vera" });
    const chunk = split.push({ type: "truncated_reply", reason: "length", retrying: true });
    expect(chunk.err).toContain("this answer is incomplete");
  });
});
