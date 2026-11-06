import { beforeAll, describe, expect, test } from "bun:test";
import { appendNotice, initialState } from "../src/state.ts";

// The escape codes are the property, and chalk bakes its colour level in when a
// styler is created: so they are read from a child process that starts with
// colour on (the probe prints the rendered lines as JSON).
const BLUE = "\u001b[38;2;140;170;238m"; // noticeHex #8caaee
const GREY = "\u001b[38;2;140;140;140m"; // theme.subtle
const CLOSE = "\u001b[39m";

interface Probe {
  tokens: { noticeHex: string; noticeHexLight: string; notice: string };
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

describe("notice colours: one soft blue, the hint grey", () => {
  test("tokens: dark in use, the light value now owned by the token table", () => {
    // `feat/tui-notice-palette` pre-chose `#3b5bdb` for a task that had not run;
    // that task moved the token into the table and the owner answered Q-B there
    // (fix round 1): `#2f4ba8`, which clears the 256 gate (5.61) where `#3b5bdb`
    // measured 3.54. Dark keeps the soft blue, byte-identical.
    expect(probe.tokens).toEqual({
      noticeHex: "#8caaee",
      noticeHexLight: "#2f4ba8",
      notice: "function",
    });
  });

  test("bullet and text are blue, the hint is grey, separately", () => {
    // Mutation: leave noticeLines on theme.subtle → no BLUE anywhere.
    expect(probe.hinted).toEqual([
      `${BLUE}⏺${CLOSE} ${BLUE}Session settings: {}${CLOSE} ${GREY}(/clear to reset)${CLOSE}`,
    ]);
  });

  test("no hint: no grey, no trailing space", () => {
    expect(probe.plain).toEqual([`${BLUE}⏺${CLOSE} ${BLUE}Container config: {}${CLOSE}`]);
  });

  test("a multi-line notice: the hint ends the last line, text lines stay blue", () => {
    expect(probe.multi).toEqual([
      `${BLUE}⏺${CLOSE} ${BLUE}a${CLOSE}`,
      `  ${BLUE}b${CLOSE} ${GREY}(h)${CLOSE}`,
    ]);
  });

  test("the separator keeps its grey rule", () => {
    const [line] = probe.separator;
    expect(line?.startsWith(GREY)).toBe(true);
    expect(line).not.toContain(BLUE);
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
});
