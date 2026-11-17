/**
 * S2 (feat/harness-notices): harness lines render as ONE grey block — `◇`/`▲`
 * at the head, a two-space hang for the rest, no blank rows between — and the
 * two layout paths agree row for row.
 *
 * The escape codes are read from a CHILD process with FORCE_COLOR=3 (chalk bakes
 * its colour level in when a styler is built; the pattern of
 * `notice-palette-probe.ts`).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  type RenderOptions,
  layoutTranscript,
  sliceLaid,
  transcriptLines,
  wrapLines,
} from "../src/render-lines.ts";
import type { DisplayItem } from "../src/state.ts";

const GREY = "\u001b[38;2;178;178;178m"; // tokens.dark.harness #b2b2b2
const AMBER = "\u001b[38;2;224;175;74m"; // tokens.dark.warn #e0af4a
const SUBTLE = "\u001b[38;2;140;140;140m"; // tokens.dark.subtle #8c8c8c
const CYAN = "\u001b[38;2;6;182;212m"; // tokens.dark.accent (the model's bullet)
const CLOSE = "\u001b[39m";

interface Probe {
  single: string[];
  two: string[];
  levels: string[];
  hint: string[];
  separator: string[];
}
let probe: Probe;
beforeAll(async () => {
  const child = Bun.spawn(["bun", new URL("./harness-lines-probe.ts", import.meta.url).pathname], {
    env: { ...process.env, FORCE_COLOR: "3" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  await child.exited;
  probe = JSON.parse(out) as Probe;
});

describe("noticeLines: one grey voice, a glyph by kind", () => {
  test("an info line: `◇` and its text in the harness grey, no `●`", () => {
    // Mutation: leave noticeLines on theme.notice/`BULLET` → no GREY, and CYAN+
    // `●` here (today's rendering).
    expect(probe.single).toEqual([`${GREY}◇${CLOSE} ${GREY}a job finished${CLOSE}`]);
    expect(probe.single.join("")).not.toContain("●");
    expect(probe.single.join("")).not.toContain(CYAN);
  });

  test("a warn line: `▲` painted amber, its text still the harness grey", () => {
    expect(probe.levels).toEqual([
      `${AMBER}▲${CLOSE} ${GREY}it went wrong${CLOSE}`,
      `${GREY}◇${CLOSE} ${GREY}and then fine${CLOSE}`,
    ]);
  });

  test("a multi-line notice hangs under the glyph, two spaces, still grey", () => {
    expect(probe.two).toEqual([`${GREY}◇${CLOSE} ${GREY}a${CLOSE}`, `  ${GREY}b${CLOSE}`]);
  });

  test("the hint stays `subtle`, beside the grey text", () => {
    // Mutation: paint the hint with the harness grey → no SUBTLE here.
    expect(probe.hint).toEqual([`${GREY}◇${CLOSE} ${GREY}text${CLOSE} ${SUBTLE}(/clear)${CLOSE}`]);
  });

  test("the separator keeps its own subtle rule, with no glyph", () => {
    const [line] = probe.separator;
    expect(line?.startsWith(SUBTLE)).toBe(true);
    expect(line).not.toContain("◇");
    expect(line).not.toContain("▲");
  });
});

const info = (text: string): DisplayItem => ({ kind: "notice", text });
const warn = (text: string): DisplayItem => ({ kind: "notice", text, level: "warn" });
const reply = (text: string): DisplayItem => ({ kind: "assistant", text });
const user = (text: string): DisplayItem => ({ kind: "user", text });

/** The plain text of the rows (SGR stripped), for structural assertions. */
const plain = (rows: readonly string[]): string[] =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
  rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));

describe("grouping: consecutive harness lines are one block", () => {
  const opts: RenderOptions = { expandAll: false, width: 40 };

  test("three harness lines: no blank row between, one glyph, then hangs", () => {
    // Mutation: keep `transcriptLines`' unconditional blank row → 5 rows here.
    const rows = plain(transcriptLines([info("one"), info("two"), info("three")], opts));
    expect(rows).toEqual(["◇ one", "  two", "  three"]);
  });

  test("a level change re-opens the glyph; the blank row comes back only around non-harness items", () => {
    const rows = plain(
      transcriptLines(
        [reply("the answer"), info("one"), info("two"), warn("bad"), info("three")],
        opts,
      ),
    );
    expect(rows).toEqual(["● the answer", "", "◇ one", "  two", "▲ bad", "◇ three"]);
  });

  test("a separator is its own item: blank rows around it, and the block restarts", () => {
    const rows = plain(
      transcriptLines([info("a"), { kind: "notice", text: "x", separator: true }, info("b")], {
        ...opts,
        width: 20,
      }),
    );
    expect(rows[1]).toBe("");
    expect(rows[2]?.startsWith("──")).toBe(true);
    expect(rows[3]).toBe("");
    expect(rows[4]).toBe("◇ b");
  });

  test("two user messages keep their blank row (grouping is harness-only)", () => {
    const rows = plain(transcriptLines([user("a"), user("b")], opts));
    expect(rows.length).toBe(3);
    expect(rows[1]).toBe("");
    expect(rows[0]?.startsWith("›")).toBe(true);
  });

  test("PARITY: layoutTranscript lays out exactly what transcriptLines makes", () => {
    // Mutation: apply the gap rule in `transcriptLines` only (the classic
    // off-by-N scroll bug, AGENTS §6) → the totals differ.
    const items: DisplayItem[] = [
      reply("a reply that is long enough to wrap at a narrow width for sure"),
      info("one"),
      info("two"),
      warn("bad"),
      info("three"),
      { kind: "notice", text: "rule", separator: true },
      info("four"),
      user("a prompt"),
      info("five"),
    ];
    for (const width of [12, 20, 40, 80]) {
      const o = { expandAll: false, width };
      const logical = wrapLines(transcriptLines(items, o), width);
      const laid = layoutTranscript(items, o);
      expect(laid.total).toBe(logical.length);
      expect(sliceLaid(laid.laid, 0, laid.total)).toEqual(logical);
    }
  });
});
