import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import chalk from "chalk";
import * as clih from "cli-highlight";
import * as rh from "../src/read-highlight.ts";
import { highlightRead, languageForPath, pathOfArgs } from "../src/read-highlight.ts";
import { carryColor, itemLines, wrapLines } from "../src/render-lines.ts";
import type { ToolItem } from "../src/state.ts";
import { theme } from "../src/theme.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// The harness has no TTY, so chalk is off; the colours are the property under test.
const level = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = level;
});

const GO = ["package main", "", "// hi", 'func main() { println("x", 42) }'].join("\n");

function readTool(path: string, text: string, extra: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "r",
    name: "fs_read",
    args: JSON.stringify({ path }),
    status: "ok",
    startedAt: 0,
    endedAt: 1,
    resultText: text,
    ...extra,
  } as ToolItem;
}

describe("languageForPath", () => {
  test("by extension, case-insensitively, ignoring a :start:end range", () => {
    expect(languageForPath("a/b/main.go")).toBe("go");
    expect(languageForPath("X.PY")).toBe("python");
    expect(languageForPath("src/a.tsx:10:20")).toBe("typescript");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
  });

  test("unknown or missing extension → undefined", () => {
    expect(languageForPath("notes.xyz")).toBeUndefined();
    expect(languageForPath("LICENSE")).toBeUndefined();
    expect(languageForPath(".gitignore")).toBeUndefined();
  });

  test("pathOfArgs reads the path, tolerates junk", () => {
    expect(pathOfArgs('{"path":"a.go"}')).toBe("a.go");
    expect(pathOfArgs("not json")).toBeUndefined();
    expect(pathOfArgs('{"path":3}')).toBeUndefined();
  });
});

describe("highlightRead", () => {
  test("a known extension is coloured and the visible text is unchanged", () => {
    const lines = highlightRead(GO, "main.go");
    expect(lines?.join("\n")).toContain("\x1b[");
    expect(lines?.map(strip).join("\n")).toBe(GO);
  });

  test("an unknown extension is left to the plain path", () => {
    expect(highlightRead(GO, "main.unknown")).toBeUndefined();
  });

  test("dark and light palettes differ", () => {
    expect(highlightRead(GO, "main.go", "dark")).not.toEqual(highlightRead(GO, "main.go", "light"));
  });

  test("a ranged-read header stays plain grey, code after it is coloured", () => {
    const header = "[main.go lines 1-4 of 9]";
    const lines = highlightRead(`${header}\n${GO}`, "main.go:1:4");
    expect(lines?.[0]).toBe(theme.subtle(header));
    expect(lines?.slice(1).join("\n")).toContain("\x1b[");
  });

  test("limit colours only the head; the tail is plain grey", () => {
    const lines = highlightRead(GO, "main.go", "dark", 2);
    expect(lines?.length).toBe(4);
    expect(lines?.[3]).toBe(theme.subtle('func main() { println("x", 42) }'));
  });

  test("a multi-line comment is coloured on every line", () => {
    const lines = highlightRead("/* a\nb\nc */", "x.js") ?? [];
    expect(lines.length).toBe(3);
    for (const l of lines) {
      expect(l).toContain("\x1b[");
    }
  });
});

describe("fs_read body", () => {
  const opts = { expandAll: false };

  test("a Go read renders coloured; a .txt read renders as before", () => {
    const go = itemLines(readTool("main.go", GO), opts);
    const txt = itemLines(readTool("notes.txt", GO), opts);
    expect(go.slice(1).map(strip)).toEqual(txt.slice(1).map(strip));
    expect(go.slice(1).join("")).not.toBe(txt.slice(1).join(""));
    expect(txt[1]).toContain(theme.subtle("package main"));
  });

  test("an error result is never highlighted", () => {
    const body = itemLines(readTool("main.go", GO, { status: "error" }), opts);
    expect(body[1]).toContain(theme.error("package main"));
  });

  test("wrapped rows keep the same visible text and width as the plain render", () => {
    const long = `const x = "${"a".repeat(80)}"; // trailing comment that wraps`;
    const hl = wrapLines(itemLines(readTool("a.ts", long), opts), 30);
    const plain = wrapLines(itemLines(readTool("a.txt", long), opts), 30);
    expect(hl.length).toBeGreaterThan(3);
    expect(hl.slice(1).map(strip)).toEqual(plain.slice(1).map(strip));
  });

  test("preview highlights only the head; ctrl+o highlights it all", () => {
    const text = Array.from({ length: 50 }, (_, i) => `x${i} = ${i}`).join("\n");
    const spy = spyOn(rh, "highlightRead");
    const tool = readTool("a.py", text);
    itemLines(tool, opts);
    expect(spy.mock.calls.at(-1)?.[3]).toBe(8);
    itemLines(tool, { expandAll: true });
    expect(spy.mock.calls.at(-1)?.[3]).toBeUndefined();
    spy.mockRestore();
  });

  test("cache: the same tool item is not re-highlighted", () => {
    const spy = spyOn(rh, "highlightRead");
    const tool = readTool("a.go", GO);
    itemLines(tool, opts);
    itemLines(tool, opts);
    itemLines(tool, opts);
    expect(spy).toHaveBeenCalledTimes(1);
    itemLines({ ...tool }, opts); // a new identity (an updated item) is recomputed
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

// --- review round 1 ---------------------------------------------------------

/** Is a foreground colour still open after this row's last SGR? */
function fgOpenAtEnd(row: string): boolean {
  let open = false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
  for (const m of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const p = m[1] ?? "";
    if (p === "39" || p === "0" || p === "") {
      open = false;
    } else if (p.startsWith("38;")) {
      open = true;
    }
  }
  return open;
}

/** Is a foreground colour open when the row's first visible character is reached? */
function fgOpenAtFirstChar(row: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
  return fgOpenAtEnd(row.match(/^((?:\x1b\[[0-9;]*m)*)/)?.[1] ?? "");
}

describe("wrapped rows (review 1)", () => {
  const opts = { expandAll: false };
  const long = `const x = "${"a".repeat(70)}"; // c`;

  test("every row of a wrapped token carries its colour and ends with nothing open", () => {
    const rows = wrapLines(itemLines(readTool("a.ts", long), opts), 30).slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(fgOpenAtEnd(r)).toBe(false);
    }
    // rows made only of the string's `aaaa…` carry the string colour from their first char
    const mid = rows.filter((r) => strip(r).startsWith("aaaa"));
    expect(mid.length).toBe(2);
    for (const r of mid) {
      expect(fgOpenAtFirstChar(r)).toBe(true);
    }
  });

  test("wrap points are those of the plain path", () => {
    const hl = wrapLines(itemLines(readTool("a.ts", long), opts), 30).slice(1);
    const plain = wrapLines(itemLines(readTool("a.txt", long), opts), 30).slice(1);
    expect(hl.map(strip)).toEqual(plain.map(strip));
  });

  test("no row of a highlighted read leaves an SGR open", () => {
    const text = ["/* a long", "block comment", 'that spans */ const s = "x";'].join("\n");
    for (const r of wrapLines(itemLines(readTool("a.ts", text), opts), 12)) {
      expect(fgOpenAtEnd(r)).toBe(false);
    }
  });
});

describe("cache, caps, normalisation (review 1)", () => {
  const opts = { expandAll: false };
  const many = Array.from({ length: 50 }, (_, i) => `x${i} = ${i}`).join("\n");

  test("toggling ctrl+o N times highlights each view at most once", () => {
    const spy = spyOn(rh, "highlightRead");
    const tool = readTool("a.py", many);
    for (let i = 0; i < 6; i++) {
      itemLines(tool, { expandAll: i % 2 === 1 });
    }
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test("above the size cap a read stays plain", () => {
    const ok = Array.from({ length: rh.READ_HIGHLIGHT_CAP.lines }, () => "x = 1").join("\n");
    expect(highlightRead(ok, "a.py")).toBeDefined();
    expect(highlightRead(`${ok}\nx = 2`, "a.py")).toBeUndefined();
    expect(
      highlightRead(`x = "${"a".repeat(rh.READ_HIGHLIGHT_CAP.bytes)}"`, "a.py"),
    ).toBeUndefined();
  });

  test("CRLF / CR / NUL: coloured and plain paths show the same text and rows", () => {
    const dirty = 'package main\r\n// a\r\nfunc f() {\0}\r\nvar s = "x\ry"\r\n';
    const hl = itemLines(readTool("a.go", dirty), opts).slice(1);
    const plain = itemLines(readTool("a.txt", dirty), opts).slice(1);
    expect(hl.map(strip)).toEqual(plain.map(strip));
    expect(hl.join("")).not.toContain("\r");
    expect(hl.join("")).not.toContain("\0");
    expect(hl.join("")).toContain("\x1b[38;2");
  });

  test("if the highlighter alters the visible text, the read stays plain", () => {
    expect(highlightRead("a = 1\r\nb = 2", "a.py")).toBeUndefined();
  });

  test("html and xml are not highlighted (their <script>/<style> sub-language auto-detects)", () => {
    expect(languageForPath("index.html")).toBeUndefined();
    expect(languageForPath("a.xml")).toBeUndefined();
  });

  test("a highlighter failure falls back to plain without throwing", () => {
    const spy = spyOn(clih, "highlight").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => highlightRead(GO, "main.go")).not.toThrow();
    expect(highlightRead(GO, "main.go")).toBeUndefined();
    spy.mockRestore();
  });
});

describe("review round 2", () => {
  test("the cap also holds on the preview path (a call with a limit)", () => {
    const { lines, bytes } = rh.READ_HIGHLIGHT_CAP;
    const tooLong = Array.from({ length: lines + 1 }, () => "x = 1").join("\n");
    expect(highlightRead(tooLong, "a.py", "dark", 8)).toBeUndefined();
    expect(highlightRead(`x = "${"a".repeat(bytes)}"`, "a.py", "dark", 8)).toBeUndefined();
    // and just under the cap a preview is still coloured
    const ok = Array.from({ length: lines }, () => "x = 1").join("\n");
    expect(highlightRead(ok, "a.py", "dark", 8)).toBeDefined();
  });

  test("carryColor stops carrying after an SGR reset (\\x1b[0m and \\x1b[m)", () => {
    const open = "\x1b[38;2;1;2;3m";
    for (const reset of ["\x1b[0m", "\x1b[m", "\x1b[39m"]) {
      const rows = carryColor([`${open}ab`, `cd${reset}ef`, "gh"]);
      expect(rows[1]).toBe(`${open}cd${reset}ef`);
      expect(rows[2]).toBe("gh");
    }
  });
});
