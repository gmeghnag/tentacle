/**
 * docs/fix/tui-line-diff-render.md — unit tests of the pure frame diff and of the
 * `lineDiffStdout` shell's fallbacks (T2–T5). The real-Ink tests (T1, T6) are in
 * `line-diff-render.test.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import {
  FULL_REDRAW_ENV,
  diffFrame,
  eraseLines,
  lineDiffEnabled,
  lineDiffStdout,
  parseFrameWrite,
  sgrOpenAtEnd,
} from "../src/line-diff.ts";

const count = (s: string, needle: string): number => s.split(needle).length - 1;
/** Ink's frame write for `rows` (rows without the trailing empty piece). */
const inkWrite = (erase: number, rows: string[]) => `${eraseLines(erase)}${rows.join("\n")}\n`;

class FakeTty extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  seen: unknown[][] = [];
  write = (chunk: unknown, ...rest: unknown[]): boolean => {
    this.seen.push([chunk, ...rest]);
    return true;
  };
  get chunks(): unknown[] {
    return this.seen.map((s) => s[0]);
  }
}

// The `ansi-escapes` that Ink itself resolves (not whatever copy the workspace hoists).
const inkAnsi: { eraseLines: (n: number) => string } = await import(
  Bun.resolveSync("ansi-escapes", dirname(Bun.resolveSync("ink", import.meta.dir)))
);
const inkEraseLines = inkAnsi.eraseLines;

describe("T5: eraseLines is ansi-escapes' (the copy Ink resolves)", () => {
  test.each([0, 1, 2, 30])("n = %d", (n) => {
    expect(eraseLines(n)).toBe(inkEraseLines(n));
  });
});

describe("parseFrameWrite", () => {
  test("recognizes eraseLines(n) + body and splits the rows", () => {
    expect(parseFrameWrite(inkWrite(3, ["a", "\x1b[1mb\x1b[22m"]))).toEqual({
      erased: 3,
      rows: ["a", "\x1b[1mb\x1b[22m", ""],
    });
    expect(parseFrameWrite("x\n")).toEqual({ erased: 0, rows: ["x", ""] });
  });

  test("rejects anything else", () => {
    expect(parseFrameWrite("\x1b[2J\x1b[3J\x1b[Hx\n")).toBeNull(); // clearTerminal
    expect(parseFrameWrite(eraseLines(4))).toBeNull(); // log.clear()
    expect(parseFrameWrite(`${eraseLines(2)}a`)).toBeNull(); // no trailing "\n"
    expect(parseFrameWrite("a\x1b[2Ab\n")).toBeNull(); // a cursor CSI in the body
    expect(parseFrameWrite("\x1b]8;;u\x07l\x1b]8;;\x07\n")).toBeNull(); // OSC 8
    expect(parseFrameWrite("a\rb\n")).toBeNull(); // a control byte
    expect(parseFrameWrite("\x1b[2K\x1b[1Ax\n")).toBeNull(); // a truncated erase prefix
  });
});

describe("T2: diffFrame", () => {
  const prev = ["r0", "r1", "r2", "r3", ""];
  const L = prev.length - 1;

  test("one changed row ⇒ one erase, relative up-move, back to column 1 of the last line", () => {
    const next = ["r0", "r1", "X2", "r3", ""];
    expect(diffFrame(prev, next)).toBe(`\x1b[${L - 2}A\r\x1b[2KX2\x1b[${L - 2}B\r`);
  });

  test("first and last row", () => {
    expect(diffFrame(prev, ["X0", "r1", "r2", "r3", ""])).toBe(`\x1b[${L}A\r\x1b[2KX0\x1b[${L}B\r`);
    expect(diffFrame(prev, ["r0", "r1", "r2", "X3", ""])).toBe("\x1b[1A\r\x1b[2KX3\x1b[1B\r");
  });

  test("several rows, ascending, each move relative to the previous row", () => {
    const d = diffFrame(prev, ["X0", "r1", "X2", "X3", ""]);
    expect(d).toBe(`\x1b[${L}A\r\x1b[2KX0\x1b[2B\r\x1b[2KX2\x1b[1B\r\x1b[2KX3\x1b[1B\r`);
    expect(count(d ?? "", "\x1b[2K")).toBe(3);
  });

  test("a row cleared to empty is erased", () => {
    expect(diffFrame(prev, ["r0", "", "r2", "r3", ""])).toBe(
      `\x1b[${L - 1}A\r\x1b[2K\x1b[${L - 1}B\r`,
    );
  });

  test("no change ⇒ empty string; height change ⇒ null", () => {
    expect(diffFrame(prev, [...prev])).toBe("");
    expect(diffFrame(prev, ["r0", "r1", "r2", ""])).toBeNull();
    expect(diffFrame(prev, [...prev, "r4"])).toBeNull();
  });
});

describe("T3: SGR guard (a row that leaves an attribute open is not repainted on its own)", () => {
  test("sgrOpenAtEnd", () => {
    expect(sgrOpenAtEnd("plain")).toBe(false);
    expect(sgrOpenAtEnd("\x1b[31mred\x1b[39m")).toBe(false);
    expect(sgrOpenAtEnd("\x1b[1m\x1b[38;2;1;2;3mx\x1b[39m\x1b[22m")).toBe(false);
    expect(sgrOpenAtEnd("\x1b[48;5;236mx\x1b[0m")).toBe(false);
    expect(sgrOpenAtEnd("\x1b[1;31mx\x1b[m")).toBe(false);
    expect(sgrOpenAtEnd("\x1b[4:3mx\x1b[4:0m")).toBe(false);
    expect(sgrOpenAtEnd("\x1b[31mred")).toBe(true);
    expect(sgrOpenAtEnd("\x1b[1m\x1b[31mx\x1b[39m")).toBe(true); // bold still open
    expect(sgrOpenAtEnd("\x1b[38;5;1mx\x1b[22m")).toBe(true); // 1 is the colour index, not bold
    expect(sgrOpenAtEnd("\x1b[73mx")).toBe(true); // unknown ⇒ conservative
  });

  test("an open row in next or prev ⇒ null (Ink's full write); closed ⇒ diffed, no extra reset", () => {
    const prev = ["a", "b", ""];
    expect(diffFrame(prev, ["\x1b[44ma", "b", ""])).toBeNull();
    expect(diffFrame(["\x1b[44ma", "b", ""], ["a", "c", ""])).toBeNull();
    const d = diffFrame(prev, ["\x1b[44ma\x1b[49m", "b", ""]);
    expect(d).toBe("\x1b[2A\r\x1b[2K\x1b[44ma\x1b[49m\x1b[2B\r");
    expect(d).not.toContain("\x1b[0m");
  });
});

describe("T4: lineDiffStdout fallbacks", () => {
  const A = ["a0", "a1", "a2"];
  const B = ["a0", "B1", "a2"];

  test("first frame verbatim, the next one diffed", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    w.write(inkWrite(0, A));
    w.write(inkWrite(4, B));
    expect(tty.chunks).toEqual([inkWrite(0, A), "\x1b[2A\r\x1b[2KB1\x1b[2B\r"]);
  });

  test("an unknown write passes verbatim and the next frame too", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    w.write(inkWrite(0, A));
    w.write("hello");
    w.write(inkWrite(4, B));
    expect(tty.chunks).toEqual([inkWrite(0, A), "hello", inkWrite(4, B)]);
  });

  test("clearTerminal frame verbatim, the next frame verbatim (Ink's stale count), then diffed", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    const clear = "\x1b[2J\x1b[3J\x1b[Ha0\na1";
    w.write(inkWrite(0, A));
    w.write(clear);
    w.write(inkWrite(4, B));
    w.write(inkWrite(4, A));
    expect(tty.chunks).toEqual([
      inkWrite(0, A),
      clear,
      inkWrite(4, B),
      "\x1b[2A\r\x1b[2Ka1\x1b[2B\r",
    ]);
  });

  test("log.clear() (bare eraseLines) verbatim; the following eraseLines(0)+body is recognized", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    w.write(inkWrite(0, A));
    w.write(eraseLines(4));
    w.write(inkWrite(0, A));
    w.write(inkWrite(4, B));
    expect(tty.chunks).toEqual([
      inkWrite(0, A),
      eraseLines(4),
      inkWrite(0, A),
      "\x1b[2A\r\x1b[2KB1\x1b[2B\r",
    ]);
  });

  test("an erase count that is not the recorded frame's height ⇒ verbatim", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    w.write(inkWrite(0, A));
    w.write(inkWrite(3, B));
    expect(tty.chunks).toEqual([inkWrite(0, A), inkWrite(3, B)]);
  });

  test("a height change ⇒ verbatim, then diffed against the new frame", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    const C = ["a0", "B1"];
    w.write(inkWrite(0, A));
    w.write(inkWrite(4, C));
    w.write(inkWrite(3, ["a0", "C1"]));
    expect(tty.chunks).toEqual([inkWrite(0, A), inkWrite(4, C), "\x1b[1A\r\x1b[2KC1\x1b[1B\r"]);
  });

  test("a size change (read live, at write time) ⇒ verbatim", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    w.write(inkWrite(0, A));
    tty.columns = 80;
    w.write(inkWrite(4, B));
    w.write(inkWrite(4, A));
    expect(tty.chunks).toEqual([inkWrite(0, A), inkWrite(4, B), "\x1b[2A\r\x1b[2Ka1\x1b[2B\r"]);
  });

  test("a non-string or an empty string passes through and forgets the frame", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    const buf = Buffer.from("x");
    w.write(inkWrite(0, A));
    w.write(buf);
    w.write(inkWrite(4, B));
    w.write("");
    w.write(inkWrite(4, A));
    expect(tty.chunks).toEqual([inkWrite(0, A), buf, inkWrite(4, B), "", inkWrite(4, A)]);
  });

  test("encoding and callback are forwarded on both paths", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    const cb = () => {};
    w.write(inkWrite(0, A), "utf8", cb);
    w.write(inkWrite(4, B), "utf8", cb);
    expect(tty.seen.map((s) => s.slice(1))).toEqual([
      ["utf8", cb],
      ["utf8", cb],
    ]);
  });

  test("live getters and listeners on the real stream", () => {
    const tty = new FakeTty();
    const w = lineDiffStdout(tty);
    tty.rows = 12;
    tty.columns = 34;
    expect([w.rows, w.columns, w.isTTY]).toEqual([12, 34, true]);
    let hits = 0;
    const l = () => {
      hits++;
    };
    expect(w.on("resize", l)).toBe(w);
    tty.emit("resize");
    w.off("resize", l);
    tty.emit("resize");
    w.once("resize", l);
    tty.emit("resize");
    tty.emit("resize");
    w.addListener("resize", l);
    w.removeListener("resize", l);
    tty.emit("resize");
    expect(hits).toBe(2);
  });
});

describe("kill switch", () => {
  test(`${FULL_REDRAW_ENV}=1 turns the row diff off; anything else keeps it`, () => {
    expect(lineDiffEnabled({})).toBe(true);
    expect(lineDiffEnabled({ [FULL_REDRAW_ENV]: "0" })).toBe(true);
    expect(lineDiffEnabled({ [FULL_REDRAW_ENV]: "1" })).toBe(false);
  });
});
