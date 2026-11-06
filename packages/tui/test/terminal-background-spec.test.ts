import { describe, expect, test } from "bun:test";
import {
  initialLateFilter,
  initialProbe,
  parseColorSpec,
  restOf,
  stepLateFilter,
  stepProbe,
} from "../src/terminal-background.ts";

/**
 * Fix round 1, LOW 7 (docs/feat/tui-light-theme.md, Review): the byte handling
 * must match what Design §1 and the module's own comments promise.
 *
 * Design §1 lists `#RRRGGGBBB` among the accepted specs, and it was the one form
 * `parseHash` rejected. The driver's latin1 read is pinned where it belongs, in
 * `terminal-background-probe.test.ts`.
 */

describe("parseColorSpec: every `#` width the plan lists", () => {
  test("`#RGB`, `#RRGGBB`, `#RRRGGGBBB` and `#RRRRGGGGBBBB`", () => {
    expect(parseColorSpec("#fff")).toEqual([255, 255, 255]);
    expect(parseColorSpec("#123456")).toEqual([0x12, 0x34, 0x56]);
    // 9 digits: 3 hex digits R, 3 G, 3 B (`#abc123456`), each scaled by its width.
    expect(parseColorSpec("#fff000000")).toEqual([255, 0, 0]);
    expect(parseColorSpec("#800800800")).toEqual([128, 128, 128]);
    expect(parseColorSpec("#123412341234")).toEqual([0x12, 0x12, 0x12]);
  });

  test("a 9-digit spec arrives as a real reply too", () => {
    const state = stepProbe(initialProbe(), "\x1b]11;#fff000000\x07");
    expect(state.color).toEqual([255, 0, 0]);
  });

  test("odd lengths and non-hex are still refused", () => {
    expect(parseColorSpec("#12345")).toBeNull();
    expect(parseColorSpec("#1234567")).toBeNull();
    expect(parseColorSpec("#gggggg")).toBeNull();
  });
});

describe("a garbage spec split across chunks", () => {
  test("is CONSUMED when it is whole, and never silently swallowed when split", () => {
    // Whole, the reply is consumed and nothing leaks (the existing behaviour).
    expect(restOf(stepProbe(initialProbe(), "\x1b]11;rgb:zz/00/00\x1b\\"))).toBe("");
    // Split, the buffer is no longer a valid PREFIX of a spec, so it comes back as
    // input. Accepted in the task doc (Review LOW 7): holding it instead would
    // swallow a keystroke INTERLEAVED into a real reply, which is worse — a
    // garbage line in the editor beats losing what the user typed.
    const state = stepProbe(stepProbe(initialProbe(), "\x1b]11;rgb:zz/"), "00/00\x1b\\");
    expect(restOf(state)).toBe("\x1b]11;rgb:zz/00/00\x1b\\");
    expect(state.color).toBeNull();
  });

  test("a junk reply reaching the late filter is stripped", () => {
    const step = stepLateFilter(initialLateFilter(), "\x1b]11;rgb:zz/00/00\x1b\\a", 0);
    expect(step.pass).toBe("a");
  });
});
