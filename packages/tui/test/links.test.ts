import { describe, expect, test } from "bun:test";
import {
  findUrls,
  linkOpenError,
  linkOpenStep,
  linkRows,
  normalizeUrl,
  sourceUrls,
  underlineRow,
} from "../src/links.ts";
import { stripAnsi, wrapLines } from "../src/render-lines.ts";
import type { DisplayItem } from "../src/state.ts";

const urls = (s: string): string[] => findUrls(s).map((m) => m.url);
/** The raw text each match covers. */
const raws = (s: string): string[] => findUrls(s).map((m) => s.slice(m.start, m.end));

describe("findUrls", () => {
  test("a bare URL", () => {
    expect(raws("go https://e.com/a/b now")).toEqual(["https://e.com/a/b"]);
    expect(urls("go https://e.com/a/b now")).toEqual(["https://e.com/a/b"]);
    expect(urls("HTTP://E.com/A")).toEqual(["http://e.com/A"]);
  });

  test("trailing punctuation is not part of the URL", () => {
    expect(raws("see https://e.com/x, then")).toEqual(["https://e.com/x"]);
    expect(raws("see https://e.com/x.")).toEqual(["https://e.com/x"]);
    expect(raws("**https://e.com/x**")).toEqual(["https://e.com/x"]);
    expect(raws("why https://e.com/x?!")).toEqual(["https://e.com/x"]);
  });

  test("balanced parens stay, unbalanced ones go", () => {
    expect(raws("(see https://e.com/p_(x))")).toEqual(["https://e.com/p_(x)"]);
    expect(raws("[docs](https://e.com/d)")).toEqual(["https://e.com/d"]);
    expect(raws("[https://e.com/d]")).toEqual(["https://e.com/d"]);
  });

  test("angle brackets and quotes end it", () => {
    expect(raws("<https://e.com/a>")).toEqual(["https://e.com/a"]);
    expect(raws('"https://e.com/a" x')).toEqual(["https://e.com/a"]);
  });

  test("a URL cut by an ellipsis is dropped", () => {
    expect(raws("https://e.com/x…")).toEqual([]);
    expect(raws("https://e.com/x.… and https://f.com/")).toEqual(["https://f.com/"]);
  });

  test("other schemes and glued words are not links", () => {
    expect(raws("ftp://e.com/a file:///etc/passwd javascript:alert(1) vscode://cmd")).toEqual([]);
    expect(raws("xhttps://e.com/a")).toEqual([]);
    expect(raws("https:// and http://")).toEqual([]);
  });

  test("an over-long URL is dropped", () => {
    const base = "https://e.com/";
    expect(raws(`${base}${"a".repeat(2048 - base.length)}`)).toHaveLength(1);
    expect(raws(`${base}${"a".repeat(2049 - base.length)}`)).toEqual([]);
  });

  test("query and fragment are kept whole; an IDN host is normalised", () => {
    expect(raws("x https://e.com/s?a=1&b=2#f y")).toEqual(["https://e.com/s?a=1&b=2#f"]);
    expect(urls("https://例え.jp/a")).toEqual([new URL("https://例え.jp/a").href]);
    expect(urls("https://例え.jp/a")[0]).toStartWith("https://xn--");
  });
});

describe("normalizeUrl", () => {
  test("accepts http(s) and returns the WHATWG serialisation", () => {
    expect(normalizeUrl("https://e.com")).toBe("https://e.com/");
    expect(normalizeUrl("http://e.com/a")).toBe("http://e.com/a");
  });

  test("refuses everything else", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://",
      "not a url",
      "https://e.com/a b",
      "https://e.com/\x07",
      "https://e.com/\x7f",
      "-https://e.com",
    ]) {
      expect(normalizeUrl(bad)).toBeNull();
    }
  });
});

describe("sourceUrls", () => {
  test("collects the raw URL text of every string in the item", () => {
    const item: DisplayItem = {
      kind: "tool",
      id: "c1",
      name: "web_fetch",
      args: '{"url":"https://a.com/x"}',
      status: "ok",
      resultText: "see https://b.com/y, ok",
      sub: undefined,
    };
    expect([...sourceUrls(item)].sort()).toEqual(["https://a.com/x", "https://b.com/y"]);
  });

  test("scans at most 1 MiB, and never keeps a URL cut at that edge", () => {
    const pad = "a ".repeat((1 << 19) - 10);
    const text = `${pad}https://e.com/abcdefghijklmnopqrstuvwxyz https://late.com/`;
    const found = sourceUrls({ kind: "assistant", text } as DisplayItem);
    expect([...found]).toEqual([]);
  });
});

const span = (s: { row: number; col: number; width: number; url: string }) => ({
  row: s.row,
  col: s.col,
  width: s.width,
  url: s.url,
});

describe("linkRows", () => {
  const url = "https://example.com/a/very/long/path/that/wraps";

  test("one span per wrapped row, with exact cells", () => {
    const line = `see ${url} ok`;
    const rows = wrapLines([line], 20);
    expect(rows.map(stripAnsi)).toEqual([
      "see https://example.",
      "com/a/very/long/path",
      "/that/wraps ok",
    ]);
    expect(linkRows(line, rows, new Set([url]), 0, 0).map(span)).toEqual([
      { row: 0, col: 4, width: 16, url },
      { row: 1, col: 0, width: 20, url },
      { row: 2, col: 0, width: 11, url },
    ]);
    expect(linkRows(line, rows, new Set([url]), 5, 0).map((s) => s.row)).toEqual([5, 6, 7]);
  });

  test("a CJK prefix moves the column by two cells a character", () => {
    const line = "中文 https://e.com/x";
    const spans = linkRows(line, wrapLines([line], 40), new Set(["https://e.com/x"]), 0, 0);
    expect(spans.map(span)).toEqual([{ row: 0, col: 5, width: 15, url: "https://e.com/x" }]);
  });

  test("a candidate that is not in the source set has no span", () => {
    const line = "see https://e.com/frag";
    expect(linkRows(line, [line], new Set(["https://e.com/fragment"]), 0, 0)).toEqual([]);
  });

  test("rows below skipRows have no span", () => {
    const line = "https://e.com/x";
    const allowed = new Set([line]);
    expect(linkRows(line, [line], allowed, 0, 1)).toEqual([]);
    expect(linkRows(line, [line], allowed, 1, 1)).toHaveLength(1);
  });

  test("rows that do not concatenate to the line give no link at all", () => {
    const line = "https://e.com/x tail";
    expect(linkRows(line, ["https://e.com/x", "tail"], new Set(["https://e.com/x"]), 0, 0)).toEqual(
      [],
    );
  });
});

describe("underlineRow", () => {
  test("wraps each segment, in plain offsets, across SGR codes", () => {
    const row = "\x1b[34mab cd\x1b[39m ef";
    expect(underlineRow(row, [{ from: 3, to: 5 }])).toBe("\x1b[34mab \x1b[4mcd\x1b[24m\x1b[39m ef");
    expect(underlineRow("abc", [])).toBe("abc");
  });

  test("re-opens the underline after a code that drops it, not after a colour", () => {
    const row = "a\x1b[24mb\x1b[0mc\x1b[md\x1b[38;2;0;0;0me";
    expect(underlineRow(row, [{ from: 0, to: 5 }])).toBe(
      "\x1b[4ma\x1b[24m\x1b[4mb\x1b[0m\x1b[4mc\x1b[m\x1b[4md\x1b[38;2;0;0;0me\x1b[24m",
    );
  });
});

describe("linkOpenStep / linkOpenError", () => {
  const url = "https://e.com/x";

  test("opens locally", () => {
    expect(linkOpenStep(url, { ssh: false })).toEqual({ kind: "open", url });
  });

  test("says why it does not open", () => {
    expect(linkOpenStep(url, undefined)).toEqual({
      kind: "notice",
      text: "No link opener in this session.",
    });
    expect(linkOpenStep(url, { ssh: true })).toEqual({
      kind: "notice",
      text: `Not opened: this TUI runs over SSH, so a browser would open on the remote host — ${url}`,
    });
  });

  test("the failure notice", () => {
    expect(linkOpenError(url, new Error("open exited with code 3"))).toBe(
      `Couldn't open ${url}: open exited with code 3`,
    );
    const enoent = Object.assign(new Error("boom"), { code: "ENOENT", path: "xdg-open" });
    expect(linkOpenError(url, enoent)).toBe(`Couldn't open ${url}: no xdg-open on this machine`);
  });

  test("the failure notice is bounded", () => {
    const long = `https://e.com/${"a".repeat(500)}`;
    const text = linkOpenError(long, new Error("r".repeat(500)));
    const [head = "", reason = ""] = text.split(": r");
    expect(head.length).toBe("Couldn't open ".length + 120);
    expect(head).toContain("…");
    expect(reason.length + 1).toBe(200);
  });
});
