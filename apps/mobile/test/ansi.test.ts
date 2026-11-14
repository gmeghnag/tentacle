/**
 * `stripAnsi` (B3): tool output and arguments are shown as plain `Text` on the
 * phone, which never interprets a terminal escape — so every CSI and OSC
 * sequence goes, and nothing else does.
 */
import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../src/ansi.ts";

const ESC = "\u001b";
const BEL = "\u0007";

describe("stripAnsi", () => {
  test("SGR colour codes are removed", () => {
    expect(stripAnsi(`${ESC}[32mPASS${ESC}[0m 3 tests`)).toBe("PASS 3 tests");
    expect(stripAnsi(`${ESC}[1;38;5;208mwarn${ESC}[m`)).toBe("warn");
  });

  test("CSI cursor / erase codes are removed", () => {
    expect(stripAnsi(`a${ESC}[2K${ESC}[1G${ESC}[?25lb${ESC}[3A`)).toBe("ab");
  });

  test("OSC hyperlinks are removed, BEL- and ST-terminated, keeping the label", () => {
    expect(stripAnsi(`${ESC}]8;;https://x.test${BEL}label${ESC}]8;;${BEL}`)).toBe("label");
    expect(stripAnsi(`${ESC}]8;;https://x.test${ESC}\\label${ESC}]8;;${ESC}\\`)).toBe("label");
  });

  test("plain text is untouched (same string back)", () => {
    const plain = "no escapes here [32m, ] or ; at all";
    expect(stripAnsi(plain)).toBe(plain);
  });

  test("a lone ESC (no sequence after it) is kept as is — no over-strip", () => {
    expect(stripAnsi(`a${ESC}b`)).toBe(`a${ESC}b`);
    expect(stripAnsi(`end${ESC}`)).toBe(`end${ESC}`);
  });
});
