import { describe, expect, test } from "bun:test";
import { NOT_A_TERMINAL, dimIf, termOf } from "../src/streams.ts";

// docs/fix/cli-output-streams.md: a line's style follows the stream it is
// written to; `termOf` is the one place that reads a stream's terminal facts.
describe("termOf", () => {
  test("colour = a terminal AND no NO_COLOR; tty alone ignores NO_COLOR", () => {
    // Mutation: ignore NO_COLOR, or colour a non-terminal → red.
    expect(termOf({ isTTY: true }, {})).toMatchObject({ tty: true, colour: true });
    expect(termOf({ isTTY: true }, { NO_COLOR: "1" })).toMatchObject({ tty: true, colour: false });
    expect(termOf({ isTTY: false }, {})).toMatchObject({ tty: false, colour: false });
    expect(termOf({}, {})).toMatchObject({ tty: false, colour: false });
  });

  test("columns are read at each call (a resize), from that stream", () => {
    const stream: { isTTY: boolean; columns: number } = { isTTY: true, columns: 80 };
    const term = termOf(stream, {});
    expect(term.columns()).toBe(80);
    stream.columns = 120;
    expect(term.columns()).toBe(120);
  });

  test("an injected sink is never a terminal", () => {
    expect(NOT_A_TERMINAL).toMatchObject({ tty: false, colour: false });
    expect(NOT_A_TERMINAL.columns()).toBeUndefined();
  });

  test("dimIf marks only with colour on", () => {
    expect(dimIf("x", true)).toBe("\x1b[2mx\x1b[22m");
    expect(dimIf("x", false)).toBe("x");
  });
});
