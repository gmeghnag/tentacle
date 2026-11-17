import { beforeAll, describe, expect, test } from "bun:test";
import { HARNESS_GLYPHS } from "../src/render-lines.ts";
import { appendNotice, initialState } from "../src/state.ts";

// The escape codes are the property, and chalk bakes its colour level in when a
// styler is created: so they are read from a child process that starts with
// colour on (the probe prints the rendered lines as JSON).
//
// docs/feat/harness-notices.md S2 REPLACED this module's original property: a
// notice used to be `●` + text in the periwinkle `notice` token. It is now ONE
// harness line — `◇`/`▲` and the text in the harness grey, the hint and the
// separator rule in `subtle`. The hint-is-a-separate-field pins carry over
// unchanged (that field is still never parsed out of the text).
const GREY = "\u001b[38;2;178;178;178m"; // tokens.dark.harness #b2b2b2
const SUBTLE = "\u001b[38;2;140;140;140m"; // theme.subtle
const CLOSE = "\u001b[39m";

interface Probe {
  tokens: { harnessHex: string; harnessHexLight: string; warnHex: string; notice: string };
  hinted: string[];
  plain: string[];
  multi: string[];
  separator: string[];
}
let probe: Probe;
beforeAll(async () => {
  const child = Bun.spawn(["bun", new URL("./notice-palette-probe.ts", import.meta.url).pathname], {
    env: { ...process.env, FORCE_COLOR: "3" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  await child.exited;
  probe = JSON.parse(out) as Probe;
});

describe("harness colours: one grey, the hint grey", () => {
  test("tokens: the harness grey in both modes, the old notice blue gone from the path", () => {
    // Mutation: point `harness` at the old periwinkle → `harnessHex` here.
    expect(probe.tokens).toEqual({
      harnessHex: "#b2b2b2",
      harnessHexLight: "#4e4e4e",
      warnHex: "#e0af4a",
      notice: "function",
    });
  });

  test("glyph and text are the harness grey, the hint is subtle, separately", () => {
    // Mutation: leave noticeLines on theme.subtle for the text → no distinct
    // grey; on theme.notice (the old token) → no GREY at all.
    expect(probe.hinted).toEqual([
      `${GREY}${HARNESS_GLYPHS.info}${CLOSE} ${GREY}Session settings: {}${CLOSE} ${SUBTLE}(/clear to reset)${CLOSE}`,
    ]);
  });

  test("no hint: no subtle run, no trailing space", () => {
    expect(probe.plain).toEqual([
      `${GREY}${HARNESS_GLYPHS.info}${CLOSE} ${GREY}Container config: {}${CLOSE}`,
    ]);
  });

  test("a multi-line notice: the hint ends the last line, text lines stay grey", () => {
    expect(probe.multi).toEqual([
      `${GREY}${HARNESS_GLYPHS.info}${CLOSE} ${GREY}a${CLOSE}`,
      `  ${GREY}b${CLOSE} ${SUBTLE}(h)${CLOSE}`,
    ]);
  });

  test("the separator keeps its grey rule, with no harness glyph", () => {
    const [line] = probe.separator;
    expect(line?.startsWith(SUBTLE)).toBe(true);
    expect(line).not.toContain(HARNESS_GLYPHS.info);
    expect(line).not.toContain(HARNESS_GLYPHS.warn);
  });
});

describe("appendNotice: the hint is a separate field", () => {
  test("kept beside the text, never parsed out of it", () => {
    const s = appendNotice(initialState, "auto-accept on (not a hint)", { hint: "(h)" });
    expect(s.items.at(-1)).toEqual({
      kind: "notice",
      text: "auto-accept on (not a hint)",
      hint: "(h)",
    });
    expect(appendNotice(initialState, "t").items.at(-1)).toEqual({ kind: "notice", text: "t" });
    const hosted = appendNotice(initialState, "t", { host: true, hint: "(h)" });
    expect(hosted.items.at(-1)).toEqual({ kind: "notice", text: "t", host: true, hint: "(h)" });
  });

  test("a level is carried when given, absent otherwise", () => {
    expect(appendNotice(initialState, "t", { level: "warn" }).items.at(-1)).toEqual({
      kind: "notice",
      text: "t",
      level: "warn",
    });
    expect(appendNotice(initialState, "t").items.at(-1)).not.toHaveProperty("level");
  });
});
