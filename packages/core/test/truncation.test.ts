/**
 * The notices' wording is built in ONE pure function, so the TUI and the plain
 * CLI cannot drift (docs/fix/truncated-reply-silent.md; AGENTS §7: presentation
 * is the components' job, wording is not).
 *
 * RED before the fix: neither function existed.
 */
import { describe, expect, test } from "bun:test";
import { describeEmptyTurn, describeTruncation } from "../src/index.ts";

describe("describeTruncation", () => {
  test("a cut reply that said something: incomplete, and being continued", () => {
    const text = describeTruncation("length", { answered: true, retrying: true });
    expect(text).toContain("cut at the model's output limit");
    expect(text).toContain("incomplete");
    expect(text).toContain("asking it to continue");
  });

  test("a cut reply with nothing said says exactly that", () => {
    const text = describeTruncation("length", { answered: false, retrying: true });
    expect(text).toContain("returned nothing");
    expect(text).toContain("output limit");
  });

  test("a stream cut outright (no stop reason) is distinguished from a limit", () => {
    const text = describeTruncation("cut", { answered: true, retrying: false });
    expect(text).toContain("stream was cut");
    expect(text).not.toContain("output limit");
    expect(text).toContain("incomplete");
  });

  test("no re-ask pending: the text does not promise a continuation", () => {
    const text = describeTruncation("length", { answered: true, retrying: false });
    expect(text).not.toContain("asking it to continue");
    expect(text).toContain("incomplete");
  });
});

describe("describeEmptyTurn", () => {
  test("says the turn produced nothing, and points at what to check", () => {
    const text = describeEmptyTurn();
    expect(text).toContain("empty reply");
    expect(text).toContain("nothing was produced");
    expect(text).toContain("context window");
  });
});
