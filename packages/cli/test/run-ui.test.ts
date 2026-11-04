import { describe, expect, test } from "bun:test";
import { localAutoAccept, styleInfo } from "../src/run-ui.ts";

describe("localAutoAccept", () => {
  test("starts as given; set changes it (Shift+Tab); no one else flips it", () => {
    const on = localAutoAccept(true);
    expect(on.current()).toBe(true);
    on.set(false);
    expect(on.current()).toBe(false);
    expect(localAutoAccept(false).current()).toBe(false);
    expect(typeof on.onChange(() => {})).toBe("function");
  });
});

describe("styleInfo (explicit marking: only what calls it is grey)", () => {
  test("with colour on, the line is grey, whole, and still ends in a newline", () => {
    const line = "[container] resolved ciao → docker, local\n";
    expect(styleInfo(line, true)).toBe(`\x1b[90m${line.slice(0, -1)}\x1b[39m\n`);
    expect(styleInfo("[pod] x still running · tentacle attach x\n", true)).toStartWith("\x1b[90m");
  });

  test("with colour off (no TTY / NO_COLOR) it is byte-identical", () => {
    const line = "[container] resolved ciao → docker, local\n";
    expect(styleInfo(line, false)).toBe(line);
  });

  test("a line with its own escape sequence (a spinner frame) is left alone", () => {
    const frame = "\r\x1b[K[pod] creating x…";
    expect(styleInfo(frame, true)).toBe(frame);
  });
});
