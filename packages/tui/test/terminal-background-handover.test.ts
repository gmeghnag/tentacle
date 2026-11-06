import { describe, expect, test } from "bun:test";
import {
  initialLateFilter,
  initialProbe,
  residueOf,
  restOf,
  stepLateFilter,
  stepProbe,
} from "../src/terminal-background.ts";

/**
 * Fix round 1 (docs/feat/tui-light-theme.md, Review MEDIUM 3 and 4): the two
 * holes in the hand-over between the probe and Ink.
 *
 *  MEDIUM 3  a DA1 that arrives with NO OSC before it (`ESC[?1;2c` — a terminal
 *            that ignores OSC 11 on a slow link) reached Ink as typed text.
 *  MEDIUM 4  `restOf` ignored the bytes `stepProbe` had held: an Esc pressed in
 *            a mute window vanished, and a reply cut by the timeout lost its
 *            head, so its tail (`e/1e/1e…`) leaked into the prompt.
 *
 * These are the EXISTING rules, restated as tests: Design §4 ("removes one OSC 11
 * reply and one DA1 reply"), §2 ("non-reply bytes are never dropped, including a
 * lone `ESC`") and the SSH failure row ("no garbage").
 */

const REPLY = "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\";
const DA1 = "\x1b[?1;2c";

describe("MEDIUM 3: a DA1 with no OSC before it never reaches the prompt", () => {
  test("a lone DA1 chunk is removed", () => {
    // Mutation: only `FULL_REPLY` is stripped → the whole `ESC[?1;2c` is passed.
    const step = stepLateFilter(initialLateFilter(), DA1, 0);
    expect(step.pass).toBe("");
  });

  test("eveRY split point of a lone DA1 removes it whole", () => {
    for (let i = 1; i < DA1.length; i++) {
      let filter = initialLateFilter();
      let pass = "";
      for (const chunk of ["x", DA1.slice(0, i), DA1.slice(i), "y"]) {
        const step = stepLateFilter(filter, chunk, 0);
        filter = step.filter;
        pass += step.pass;
      }
      // The Esc key still passes AT ONCE (the documented trade-off), so a split
      // right after the ESC leaves that one ESC on screen. Nothing else leaks.
      expect({ i, pass }).toEqual({ i, pass: i === 1 ? "x\x1by" : "xy" });
    }
  });

  test("the OSC reply and its DA1 in ONE chunk are both removed", () => {
    expect(stepLateFilter(initialLateFilter(), `${REPLY}${DA1}`, 0).pass).toBe("");
  });

  test("the 8-bit CSI form of a lone DA1 is removed too", () => {
    expect(stepLateFilter(initialLateFilter(), "\x9b?1;2c", 0).pass).toBe("");
  });

  test("typing that merely contains brackets is untouched", () => {
    // The guard must not eat a `[`/`]` pair typed while armed.
    const step = stepLateFilter(initialLateFilter(), "string[] = a[0];", 0);
    expect(step.pass).toBe("string[] = a[0];");
  });

  test("a chunk that ENDS in a bare `[` is not swallowed", () => {
    // `[` alone is far more often typing than half a DA1, so it passes; the
    // `?` that would make it a sentinel comes with the next chunk.
    expect(stepLateFilter(initialLateFilter(), "a[", 0).pass).toBe("a[");
  });
});

describe("MEDIUM 4: held bytes are not lost at the hand-over", () => {
  /** The state `stepProbe` reaches after a mute window that saw only `chunk`. */
  const held = (chunk: string) => stepProbe(initialProbe(), chunk);

  test("an Esc held during the window comes back (it is the Esc key)", () => {
    // Mutation: `restOf` returns only `rest` → the Esc vanishes.
    expect(held("\x1b").pending).toBe("\x1b");
    expect(restOf(held("\x1b"))).toBe("\x1b");
    expect(residueOf(held("\x1b"))).toBe("");
  });

  test("type-ahead after a seen sentinel comes back, held prefix included", () => {
    // Nothing more of the reply can arrive once DA1 has, so the tail is the user's.
    const state = held(`${REPLY}${DA1}ab\x1b[`);
    expect(state.sentinel).toBe(true);
    expect(restOf(state)).toBe("ab\x1b[");
  });

  test("a reply CUT by the timeout is handed to the guard, not to the prompt", () => {
    // A slow link: the OSC's head is still in the buffer when the timer fires.
    const cut = held("\x1b]11;rgb:1e");
    expect(cut.sentinel).toBe(false);
    expect(residueOf(cut)).toBe("\x1b]11;rgb:1e");
    // The head is NOT unshifted (Ink would show it as typed text) …
    expect(restOf(cut)).toBe("");
    // … and the guard, seeded with it, strips the rest of the same reply.
    const step = stepLateFilter(
      { ...initialLateFilter(), pending: residueOf(cut) },
      "1e/1e/1e\x07x",
      0,
    );
    expect(step.pass).toBe("x");
  });

  test("a partial sentinel is handed to the guard as well", () => {
    const cut = held("\x1b[?1;");
    expect(residueOf(cut)).toBe("\x1b[?1;");
    expect(restOf(cut)).toBe("");
    expect(stepLateFilter({ ...initialLateFilter(), pending: residueOf(cut) }, "2cz", 0).pass).toBe(
      "z",
    );
  });

  test("a lone ESC is the only held prefix given back to the terminal", () => {
    expect(restOf(held("\x1b"))).toBe("\x1b");
    expect(restOf(held("\x1b]11;"))).toBe("");
  });
});
