import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_QUERY,
  LATE_GUARD_MS,
  PROBE_TIMEOUT_MS,
  canProbe,
  initialLateFilter,
  initialProbe,
  modeOfBackground,
  modeOfColorFgBg,
  parseColorSpec,
  resolveMode,
  restOf,
  stepLateFilter,
  stepProbe,
} from "../src/terminal-background.ts";

/**
 * The pre-mount background probe's PURE half (docs/feat/tui-light-theme.md S6).
 * No streams, no timers, no Ink: the incremental parsers and the precedence
 * rules. The driver (raw mode, unshift, the guard) is
 * `terminal-background-probe.test.ts`.
 */

const OSC_ST = "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\";
const OSC_BEL = "\x1b]11;rgb:1e1e/1e1e/1e1e\x07";
const DA1 = "\x1b[?1;2c";
const REPLY = OSC_ST + DA1;

/** Run the chunks through `stepProbe` in order. */
const probe = (chunks: readonly string[]) => {
  let state = initialProbe();
  for (const chunk of chunks) {
    state = stepProbe(state, chunk);
  }
  return state;
};

describe("BACKGROUND_QUERY", () => {
  test("is OSC 11 followed by DA1, both ST-terminated", () => {
    expect(BACKGROUND_QUERY).toBe("\x1b]11;?\x1b\\\x1b[c");
  });

  test("the 200 ms timeout is the accepted value (Q7)", () => {
    expect(PROBE_TIMEOUT_MS).toBe(200);
    expect(LATE_GUARD_MS).toBe(5_000);
  });
});

describe("parseColorSpec", () => {
  test("rgb: with every channel width, scaled by that width", () => {
    expect(parseColorSpec("rgb:ff/ff/ff")).toEqual([255, 255, 255]);
    expect(parseColorSpec("rgb:00/00/00")).toEqual([0, 0, 0]);
    // 1 digit: x → x*17 (0xf → 255)
    expect(parseColorSpec("rgb:f/0/8")).toEqual([255, 0, 136]);
    // 2 digits
    expect(parseColorSpec("rgb:80/40/20")).toEqual([128, 64, 32]);
    // 3 digits: 800 → 128
    expect(parseColorSpec("rgb:800/400/200")).toEqual([128, 64, 32]);
    // 4 digits: 8000 → 128, ffff → 255
    expect(parseColorSpec("rgb:ffff/8000/0000")).toEqual([255, 128, 0]);
  });

  test("mixed channel widths are accepted per channel", () => {
    expect(parseColorSpec("rgb:f/80/800")).toEqual([255, 128, 128]);
  });

  test("is case-insensitive", () => {
    expect(parseColorSpec("RGB:FF/FF/FF")).toEqual([255, 255, 255]);
    expect(parseColorSpec("rgb:FF/80/Ab")).toEqual([255, 128, 171]);
  });

  test("rgba: ignores the alpha channel", () => {
    expect(parseColorSpec("rgba:ff/00/00/80")).toEqual([255, 0, 0]);
    expect(parseColorSpec("rgba:12/34/56")).toEqual([0x12, 0x34, 0x56]);
  });

  test("# forms", () => {
    expect(parseColorSpec("#fff")).toEqual([255, 255, 255]);
    expect(parseColorSpec("#123456")).toEqual([0x12, 0x34, 0x56]);
    // X11's 12-digit form is RRRR/GGGG/BBBB (4 digits per channel), NOT rrggbbaa.
    expect(parseColorSpec("#123412341234")).toEqual([0x12, 0x12, 0x12]);
  });

  test("rejects anything it cannot read exactly", () => {
    // Mutation: a lenient regex (any hex run) → "rgb:ff/ff" would half-parse.
    expect(parseColorSpec("rgb:ff/ff")).toBeNull();
    expect(parseColorSpec("rgb:gg/00/00")).toBeNull();
    expect(parseColorSpec("cmy:00/00/00")).toBeNull();
    expect(parseColorSpec("rgb:12345/00/00")).toBeNull();
    expect(parseColorSpec("")).toBeNull();
    expect(parseColorSpec("rgb:")).toBeNull();
    expect(parseColorSpec("garbage")).toBeNull();
  });
});

describe("modeOfBackground", () => {
  test("the 0.179 luminance point picks the readable side", () => {
    // An exact-grey ramp: find the first that goes light.
    const light = (grey: number): boolean => modeOfBackground([grey, grey, grey]) === "light";
    expect(light(0x75)).toBe(false);
    expect(light(0x77)).toBe(true);
  });

  test("white and Solarized Light are light; a dark terminal is dark", () => {
    expect(modeOfBackground([255, 255, 255])).toBe("light");
    expect(modeOfBackground([0xfd, 0xf6, 0xe3])).toBe("light");
    expect(modeOfBackground([0x00, 0x2b, 0x36])).toBe("dark");
    expect(modeOfBackground([0x1e, 0x1e, 0x1e])).toBe("dark");
  });
});

describe("modeOfColorFgBg", () => {
  test("reads the last field", () => {
    // COLORFGBG is "foreground;background": the BACKGROUND is the last field.
    expect(modeOfColorFgBg("0;15")).toBe("light");
    expect(modeOfColorFgBg("15;0")).toBe("dark");
    expect(modeOfColorFgBg("0;default;15")).toBe("light");
    expect(modeOfColorFgBg("15;0;default")).toBeNull();
    expect(modeOfColorFgBg("0;7")).toBe("light");
    expect(modeOfColorFgBg("0;8")).toBe("dark");
    expect(modeOfColorFgBg("0;9")).toBe("light");
    expect(modeOfColorFgBg("12;8")).toBe("dark");
    expect(modeOfColorFgBg("0;6")).toBe("dark");
  });

  test("unknown values are null, never a guess", () => {
    // Mutation: default to dark → "abc" and "0;16" would answer.
    expect(modeOfColorFgBg("default")).toBeNull();
    expect(modeOfColorFgBg("")).toBeNull();
    expect(modeOfColorFgBg("abc")).toBeNull();
    expect(modeOfColorFgBg("0;16")).toBeNull();
    expect(modeOfColorFgBg("0;-1")).toBeNull();
    expect(modeOfColorFgBg(undefined)).toBeNull();
  });
});

describe("canProbe", () => {
  const ok = { stdinTty: true, stdoutTty: true, term: "xterm-256color", chalkLevel: 3 };

  test("both TTYs, a real TERM and colour", () => {
    expect(canProbe(ok)).toBe(true);
  });

  test("each input off refuses", () => {
    // Mutation: drop the TERM check → `dumb` still queries.
    expect(canProbe({ ...ok, stdinTty: false })).toBe(false);
    expect(canProbe({ ...ok, stdoutTty: false })).toBe(false);
    expect(canProbe({ ...ok, term: "dumb" })).toBe(false);
    expect(canProbe({ ...ok, term: undefined })).toBe(true);
    expect(canProbe({ ...ok, chalkLevel: 0 })).toBe(false);
  });
});

describe("resolveMode", () => {
  test("a forced setting wins with no probe", () => {
    expect(resolveMode("dark", [255, 255, 255], "15;0")).toBe("dark");
    expect(resolveMode("light", [0, 0, 0], "15;0")).toBe("light");
  });

  test("auto: probed colour, then COLORFGBG, then dark", () => {
    expect(resolveMode("auto", [255, 255, 255], "15;0")).toBe("light");
    expect(resolveMode("auto", [0, 0, 0], "0;15")).toBe("dark");
    // Mutation: COLORFGBG before the probe → the first case would be dark.
    expect(resolveMode("auto", null, "0;15")).toBe("light");
    expect(resolveMode("auto", null, "15;0")).toBe("dark");
    expect(resolveMode("auto", null, undefined)).toBe("dark");
    expect(resolveMode("auto", null, "garbage")).toBe("dark");
  });
});

describe("stepProbe", () => {
  test("one chunk: colour parsed, sentinel seen, nothing left over", () => {
    const state = probe([REPLY]);
    expect(state.color).toEqual([30, 30, 30]);
    expect(state.sentinel).toBe(true);
    expect(restOf(state)).toBe("");
  });

  test("EVERY split point gives the same answer", () => {
    // Mutation: a regex that assumes the whole reply in one chunk → most splits fail.
    for (let i = 1; i < REPLY.length; i++) {
      const state = probe([REPLY.slice(0, i), REPLY.slice(i)]);
      expect({ i, color: state.color, sentinel: state.sentinel }).toEqual({
        i,
        color: [30, 30, 30],
        sentinel: true,
      });
      expect({ i, rest: restOf(state) }).toEqual({ i, rest: "" });
    }
  });

  test("byte by byte gives the same answer", () => {
    const state = probe([...REPLY]);
    expect(state.color).toEqual([30, 30, 30]);
    expect(state.sentinel).toBe(true);
  });

  test("the BEL terminator and the 8-bit forms are replies too", () => {
    expect(probe([OSC_BEL]).color).toEqual([30, 30, 30]);
    expect(probe(["\x9d11;rgb:1e1e/1e1e/1e1e\x9c"]).color).toEqual([30, 30, 30]);
  });

  test("type-ahead before and after the reply is preserved in order", () => {
    const state = probe(["a", "bc", OSC_ST, "de", DA1, "fg"]);
    expect(state.color).toEqual([30, 30, 30]);
    expect(restOf(state)).toBe("abcdefg");
  });

  test("type-ahead landing INSIDE the reply abandons it and loses nothing", () => {
    // A real tty can interleave a keystroke into the reply. The reply is then not
    // a reply; every byte it had must come back as input, in order, and the mode
    // falls back — losing a keystroke would be worse than a wrong palette.
    // Mutation: keep a partial reply in `rest` (or in the held tail) → a byte vanishes.
    const state = probe(["a", OSC_ST.slice(0, 7), "bc", OSC_ST.slice(7), "de", DA1, "fg"]);
    expect(state.color).toBeNull();
    expect(state.sentinel).toBe(true);
    expect(restOf(state)).toBe(`a${OSC_ST.slice(0, 7)}bc${OSC_ST.slice(7)}defg`);
  });

  test("a lone ESC is HELD (it may begin a reply), and comes back if it was not one", () => {
    // The probe cannot tell the Esc key from the start of a reply until the next
    // byte arrives, so it holds it. A byte that ends the possibility returns it.
    const held = probe(["\x1b"]);
    expect(held.sentinel).toBe(false);
    expect(held.pending).toBe("\x1b");
    const given = probe(["\x1b", "q"]);
    expect(restOf(given)).toBe("\x1bq");
    expect(given.color).toBeNull();
  });

  test("a DA1 alone ends it with no colour", () => {
    const state = probe([DA1]);
    expect(state.color).toBeNull();
    expect(state.sentinel).toBe(true);
    expect(restOf(state)).toBe("");
  });

  test("a garbage colour spec is consumed, not leaked, and leaves no colour", () => {
    // Mutation: pass the whole OSC to `restOf` when the spec is bad → "…]" here.
    const state = probe(["\x1b]11;rgb:zz/00/00\x1b\\", DA1]);
    expect(state.color).toBeNull();
    expect(state.sentinel).toBe(true);
    expect(restOf(state)).toBe("");
  });

  test("an overlong never-terminated OSC stops being a reply and is returned", () => {
    const huge = `\x1b]11;${"f".repeat(400)}`;
    const state = probe([huge]);
    expect(state.color).toBeNull();
    expect(state.sentinel).toBe(false);
    // The bytes are returned whole — a garbage line beats losing the user's input.
    expect(restOf(state).length).toBe(huge.length);
  });
});

describe("stepLateFilter", () => {
  test("an armed filter removes the whole reply and keeps the keys around it", () => {
    const step = stepLateFilter(initialLateFilter(), `a${REPLY}b`, 0);
    // Mutation: disarm after the OSC only → the `[?1;2c` sentinel shows up here.
    expect(step.pass).toBe("ab");
    expect(step.filter.armed).toBe(false);
  });

  test("a reply whose ESC already passed is stripped too", () => {
    // The ESC is optional in the pattern: a reply split right after it arrives as
    // `]11;…`, which is still recognised and dropped.
    const step = stepLateFilter(initialLateFilter(), REPLY.slice(1), 0);
    expect(step.pass).toBe("");
  });

  test("EVERY split point of the reply is removed", () => {
    for (let i = 1; i < REPLY.length; i++) {
      let filter = initialLateFilter();
      let pass = "";
      for (const chunk of ["x", REPLY.slice(0, i), REPLY.slice(i), "y"]) {
        const step = stepLateFilter(filter, chunk, 0);
        filter = step.filter;
        pass += step.pass;
      }
      // A lone ESC chunk PASSES at once (the Esc key — the plan's documented
      // trade-off), so a reply split exactly after its ESC leaves that one ESC on
      // screen. Every other split leaks nothing at all.
      expect({ i, pass }).toEqual({ i, pass: i === 1 ? "x\x1by" : "xy" });
    }
  });

  test("a lone ESC passes at once (it is the Esc key)", () => {
    const step = stepLateFilter(initialLateFilter(), "\x1b", 0);
    expect(step.pass).toBe("\x1b");
    expect(step.filter.pending).toBe("");
  });

  test("a typed `]` held at the deadline reaches the prompt (LOW 6)", () => {
    // A bare `]` is a key a person types (a regex, an index). Holding it while it
    // could still become a reply is right, but the deadline used to DROP it
    // silently; only reply RESIDUE may be dropped.
    // Mutation: drop `pending` unconditionally at the deadline → "" here.
    const held = stepLateFilter(initialLateFilter(), "]", 0);
    expect(held.pass).toBe("");
    const late = stepLateFilter(held.filter, "", LATE_GUARD_MS + 1);
    expect(late.pass).toBe("]");
    expect(late.filter.armed).toBe(false);
  });

  test("reply residue held at the deadline is still DROPPED (it is not the user's)", () => {
    // The other side of the rule: a half reply can only be residue, whichever way
    // its ESC went.
    for (const residue of ["\x1b]11;rgb:1e", "]11;rgb:1e", "\x9d11;rgb:1e"]) {
      const held = stepLateFilter(initialLateFilter(), residue, 0);
      expect({ residue, pass: stepLateFilter(held.filter, "x", LATE_GUARD_MS + 1).pass }).toEqual({
        residue,
        pass: "x",
      });
    }
  });

  test("the residue rule needs the `11;` selector — a held `]` or `]1` is typing", () => {
    // Mutation: loosen `isReplyResidue` to a bare introducer → these vanish.
    for (const typed of ["]", "]1"]) {
      const held = stepLateFilter(initialLateFilter(), typed, 0);
      expect({ typed, held: held.filter.pending }).toEqual({ typed, held: typed });
      // The deadline hands it back instead of dropping it.
      expect({ typed, pass: stepLateFilter(held.filter, "", LATE_GUARD_MS + 1).pass }).toEqual({
        typed,
        pass: typed,
      });
    }
  });

  test("normal typing while armed is untouched", () => {
    // Mutation: strip anything ESC-ish → "hello" would lose nothing, but "a]b" must survive.
    const step = stepLateFilter(initialLateFilter(), "hello a]b 11; rgb:", 0);
    expect(step.pass).toBe("hello a]b 11; rgb:");
  });

  test("disarms at the deadline and passes everything after it", () => {
    let filter = initialLateFilter();
    filter = stepLateFilter(filter, "\x1b]11;rgb:1e", 0).filter;
    const step = stepLateFilter(filter, "more keys", LATE_GUARD_MS + 1);
    // The held partial is dropped (it can only be reply residue).
    expect(step.pass).toBe("more keys");
    expect(step.filter.armed).toBe(false);
  });

  test("an unarmed filter passes bytes through unchanged", () => {
    const filter = { ...initialLateFilter(), armed: false };
    expect(stepLateFilter(filter, REPLY, 0).pass).toBe(REPLY);
  });
});
