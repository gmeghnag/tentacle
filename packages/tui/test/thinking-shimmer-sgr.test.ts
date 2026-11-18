import { beforeAll, describe, expect, test } from "bun:test";

/**
 * The shimmer as the TERMINAL sees it (docs/feat/tui-thinking-shimmer.md).
 *
 * `ink-testing-library` strips SGR, so the pure suite and the frame test can
 * only see the text; the point of this feature is the COLOUR, which lives in the
 * escape codes and nowhere else. So a child process renders with colour on
 * (`FORCE_COLOR=3`, the pattern of `thinking-color.test.ts`) and we assert on its
 * frames directly: the TEXT must never move, the SGR must.
 */
const ACCENT = "\u001b[38;2;6;182;212m"; // dark accent #06b6d4 (base)
const MID = "\u001b[38;2;34;211;238m"; // dark shimmer.mid #22d3ee
const PEAK = "\u001b[38;2;103;232;249m"; // dark shimmer.peak #67e8f9

let frames: string[] = [];
beforeAll(async () => {
  const child = Bun.spawn(
    ["bun", new URL("./thinking-shimmer-probe.tsx", import.meta.url).pathname],
    { env: { ...process.env, FORCE_COLOR: "3" }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(child.stdout).text();
  await child.exited;
  frames = (JSON.parse(out) as { frames: string[] }).frames;
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
const SGR = /\x1b\[[0-9;]*m/g;
/** The frame with every escape removed: what the user reads, character for character. */
const plain = (frame: string): string => frame.replace(SGR, "");
/** The label part only (before the dimmed timer/hint), escapes kept. */
const labelOf = (frame: string): string => {
  const dim = frame.indexOf("\u001b[2m");
  return dim < 0 ? frame : frame.slice(0, dim);
};
/** The label's (text, colour) runs, e.g. [["⠋ ", accent], ["W", mid], …]. */
function runs(frame: string): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  let color = "";
  let text = "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
  const re = /\x1b\[([0-9;]*)m|([^\x1b]+)/g;
  for (const m of labelOf(frame).matchAll(re)) {
    if (m[1] !== undefined) {
      if (text !== "") {
        out.push({ text, color });
        text = "";
      }
      const code = m[1];
      // A foreground colour sets the run; 39 resets it.
      color =
        code === "39" || code === "" ? "" : code.startsWith("38;") ? `\u001b[${code}m` : color;
    } else if (m[2] !== undefined) {
      text += m[2];
    }
  }
  if (text !== "") {
    out.push({ text, color });
  }
  return out;
}

describe("the shimmer is visible and the text never moves", () => {
  test("the probe produced a full period of frames", () => {
    expect(frames.length).toBe(18);
  });

  // The load-bearing property: 80 ms re-renders must never shift a cell. The
  // timer's digits are excluded — `useElapsed` ticks 0s → 1s on its own clock and
  // is not part of this feature.
  test("the label's plain text is identical on every frame, spinner glyph apart", () => {
    const bodies = new Set(frames.map((f) => plain(labelOf(f)).replace(/^[\u2800-\u28ff]/, "⠿")));
    expect([...bodies]).toEqual(["⠿ Working…"]);
  });

  test("the label is one flat accent run on no frame: the sweep repaints it", () => {
    // Before the feature every frame was 1 run (the whole label in ACCENT). Now at
    // least one frame shows three tones — that is the capability existing at all.
    const widest = Math.max(...frames.map((f) => runs(f).length));
    expect(widest).toBeGreaterThanOrEqual(3);
  });

  test("the three tones are the palette's accent / shimmer.mid / shimmer.peak", () => {
    const colours = new Set(frames.flatMap((f) => runs(f).map((r) => r.color)));
    expect(colours.has(ACCENT)).toBe(true);
    expect(colours.has(MID)).toBe(true);
    expect(colours.has(PEAK)).toBe(true);
    // Nothing off-palette leaked in (a 3-tone sweep plus the spinner's accent).
    expect([...colours].sort()).toEqual([ACCENT, MID, PEAK].sort());
  });

  // Mutation: swap the two tokens (peak painted `mid`) → two PEAK runs, one MID.
  test("mid flanks peak: one peak run, up to two mid runs, peak exactly one cell", () => {
    for (const f of frames) {
      const list = runs(f);
      const peaks = list.filter((r) => r.color === PEAK);
      const mids = list.filter((r) => r.color === MID);
      expect(peaks.length).toBeLessThanOrEqual(1);
      expect(mids.length).toBeLessThanOrEqual(2);
      // The peak is the window's CENTRE: a single cell, never a run of cells.
      for (const p of peaks) {
        expect(p.text).toHaveLength(1);
      }
      // When both are lit, every mid cell sits beside the peak (it is the window).
      if (peaks.length === 1 && mids.length > 0) {
        const index = list.findIndex((r) => r.color === PEAK);
        for (const m of mids) {
          const at = list.indexOf(m);
          expect(Math.abs(at - index)).toBe(1);
          expect(m.text).toHaveLength(1);
        }
      }
    }
  });

  // Mutation: a fixed peak cell (no `frame` input) → one position on every frame.
  test("the peak moves: its cell index differs between frames", () => {
    const peakCells = frames
      .map((f) => runs(f).findIndex((r) => r.color === PEAK))
      .filter((i) => i >= 0);
    expect(peakCells.length).toBeGreaterThan(0);
    expect(new Set(peakCells).size).toBeGreaterThan(1);
  });

  // Mutation: sweep not clipped to the label → the glyph or the " 0s" hint tints.
  test("the spinner glyph and the timer/hint are never shimmered", () => {
    for (const f of frames) {
      const first = runs(f)[0];
      // The glyph is the first cell of the first run and is always base accent.
      expect(first?.color).toBe(ACCENT);
      expect(first?.text.slice(0, 1)).toMatch(/[\u2800-\u28ff]/);
      // The row starts with exactly glyph + space, so nothing precedes the label.
      expect(plain(f).slice(0, 2)).toBe(`${plain(f).slice(0, 1)} `);
    }
    // The timer is the dimmed part, untouched by the sweep (its digits tick on
    // their own clock, so the seconds are matched, not pinned).
    for (const f of frames) {
      expect(f).toContain("\u001b[2m ");
      expect(labelOf(f)).not.toContain("esc/ctrl+c");
      expect(f).toContain(" · esc/ctrl+c to stop");
    }
    // And no shimmer tone ever appears past the label.
    for (const f of frames) {
      const tail = f.slice(f.indexOf("\u001b[2m"));
      expect(tail).not.toContain(MID);
      expect(tail).not.toContain(PEAK);
    }
  });
});
