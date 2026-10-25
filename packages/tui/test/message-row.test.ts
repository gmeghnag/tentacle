import { describe, expect, test } from "bun:test";
import { Chalk } from "chalk";
import stringWidth from "string-width";
import { messageRows, queuedRows } from "../src/message-row.ts";
import { itemLines, transcriptRows, wrapLines } from "../src/render-lines.ts";
import { type MessageStyle, messageRgb, theme } from "../src/theme.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const cells = (s: string): number => [...strip(s)].length;

// The harness is not a TTY, so the shared chalk may be colourless: dress rows
// with a forced truecolor chalk built from the SAME rgb triples as the theme,
// so the SGR codes exist whatever the environment.
const forced = new Chalk({ level: 3 });
const styleOf = (mode: keyof typeof messageRgb): MessageStyle => {
  const [br, bg, bb] = messageRgb[mode].bg;
  const [fr, fg, fb] = messageRgb[mode].queuedFg;
  return { bg: forced.bgRgb(br, bg, bb), queuedFg: forced.rgb(fr, fg, fb) };
};
const dark = styleOf("dark");
const light = styleOf("light");
const bgCode = (mode: keyof typeof messageRgb): string =>
  `\x1b[48;2;${messageRgb[mode].bg.join(";")}m`;
const fgCode = (mode: keyof typeof messageRgb): string =>
  `\x1b[38;2;${messageRgb[mode].queuedFg.join(";")}m`;

describe("sent user message", () => {
  test("every row — wrapped and blank ones included — is width cells wide", () => {
    const width = 20;
    const item = { kind: "user", text: "a long first line that must wrap\n\nlast" } as const;
    const rows = transcriptRows([item], { expandAll: false, width });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(cells(row)).toBe(width);
    }
    expect(strip(rows[0] ?? "").startsWith("› ")).toBe(true);
    // the blank line inside the message is a padded row, not ""
    expect(rows.some((r) => strip(r).trim() === "")).toBe(true);
    // the transcript path is exactly the pure builder's rows
    expect(rows).toEqual(messageRows(item.text, width));
  });

  test("the tint wraps the whole row, so it reaches both edges", () => {
    const rows = messageRows("a long first line that must wrap\n\nlast", 20, "sent", dark);
    for (const row of rows) {
      expect(row.startsWith(bgCode("dark"))).toBe(true);
      expect(row.endsWith("\x1b[49m")).toBe(true);
      expect(cells(row)).toBe(20);
    }
  });

  test("a resize re-lays-out to the new width", () => {
    const item = { kind: "user", text: "hello" } as const;
    for (const width of [24, 40]) {
      const rows = transcriptRows([item], { expandAll: false, width });
      expect(rows.map(cells)).toEqual([width]);
    }
  });

  test("wrapLines leaves the prepared rows alone", () => {
    const rows = itemLines({ kind: "user", text: "x".repeat(50) }, { expandAll: false, width: 20 });
    expect(wrapLines(rows, 20)).toEqual(rows);
  });

  test("wide characters still fill the row exactly", () => {
    const [row] = messageRows("日本語", 12);
    // 2 prefix + 3 wide chars (6 cells) + 4 pad = 12 cells
    expect(strip(row ?? "")).toBe("› 日本語    ");
  });
});

describe("queued message rows", () => {
  test("same tint and shape as a sent one; only the text is grey", () => {
    const [sent] = messageRows("later", 30, "sent", dark);
    const [queued] = queuedRows(["later"], 30, undefined, dark);
    expect(strip(queued ?? "")).toBe(strip(sent ?? ""));
    expect(queued?.startsWith(bgCode("dark"))).toBe(true);
    expect(queued).toContain(`${fgCode("dark")}later`);
    expect(sent).not.toContain(`${fgCode("dark")}later`);
  });

  test("one row each, long text cut with …, the hint on its own grey row under the last", () => {
    const rows = queuedRows(["one", "x".repeat(200), "multi\nline"], 40, "send now");
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 3).map(cells)).toEqual([40, 40, 40]);
    expect(strip(rows[0] ?? "").trim()).toBe("› one");
    expect(strip(rows[1] ?? "")).toContain("…");
    expect(strip(rows[1] ?? "")).not.toContain("send now");
    expect(strip(rows[2] ?? "").trim()).toBe("› multi line");
    expect(strip(rows[3] ?? "")).toBe("  send now");
    expect(rows[3]).toBe(theme.subtle("  send now"));
    const [only] = queuedRows(["y".repeat(200)], 40, "send now");
    expect(strip(only ?? "")).toBe(`› ${"y".repeat(40 - 2 - 1)}…`);
    expect(queuedRows([], 40, "send now")).toEqual([]);
  });
});

describe("theme", () => {
  test("dark and light each give a tint and a grey, and they differ", () => {
    const d = queuedRows(["hi"], 10, undefined, dark)[0] ?? "";
    const l = queuedRows(["hi"], 10, undefined, light)[0] ?? "";
    expect(d.startsWith(bgCode("dark"))).toBe(true);
    expect(d).toContain(fgCode("dark"));
    expect(l.startsWith(bgCode("light"))).toBe(true);
    expect(l).toContain(fgCode("light"));
    expect(bgCode("light")).not.toBe(bgCode("dark"));
    expect(fgCode("light")).not.toBe(fgCode("dark"));
  });
});

describe("cell widths match string-width (what wrap-ansi and Ink measure)", () => {
  const samples = [
    "done ✅ ok",
    "tea ☕ time",
    "love ❤️ it",
    "warn ⚠️ now",
    "star ⭐ star",
    "你好世界你好世界",
  ];
  for (const text of samples) {
    test(`"${text}" at 20 columns: one row per line, each exactly 20 cells`, () => {
      const rows = messageRows(text, 20, "sent", dark);
      expect(rows.length).toBe(1);
      for (const row of rows) {
        expect(stringWidth(strip(row))).toBe(20);
      }
      const queued = queuedRows([text], 20, undefined, dark);
      expect(queued.length).toBe(1);
      expect(stringWidth(strip(queued[0] ?? ""))).toBe(20);
    });
  }

  test("a queued message is cut by cells, never past the width", () => {
    const rows = queuedRows(["✅✅✅✅✅✅✅✅✅✅✅✅"], 11, undefined, dark);
    expect(rows.length).toBe(1);
    expect(stringWidth(strip(rows[0] ?? ""))).toBe(11);
  });
});

describe("queued marker", () => {
  test("the queued › is the sent one (accent, bold): only the text differs", () => {
    const sent = messageRows("hi", 20, "sent", dark)[0] ?? "";
    const queued = queuedRows(["hi"], 20, undefined, dark)[0] ?? "";
    const marker = (row: string): string => row.slice(0, row.indexOf("›") + 1);
    expect(marker(queued)).toBe(marker(sent));
  });
});
