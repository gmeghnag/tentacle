import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Thinking } from "../src/components/Thinking.tsx";

/**
 * The frame-level half of docs/feat/tui-thinking-shimmer.md: whatever the sweep
 * paints, the ROW must not change. `ink-testing-library` strips SGR, so this can
 * see exactly the thing that matters for layout — the text — over a full period,
 * with the spinner glyph normalised and the timer's own digits excluded.
 *
 * The colour half lives in `thinking-shimmer-sgr.test.ts` (a child process with
 * colour on) and the sweep itself in `shimmer.test.ts`.
 */
const PERIOD_FRAMES = 18; // > one full period of "Working…" (15 ticks at 80 ms)

describe("Thinking renders a shimmering label without moving it", () => {
  test("the label's text is identical on every tick of a full period", async () => {
    const label = "Working…";
    const { lastFrame, unmount } = render(<Thinking since={Date.now()} label={label} />);
    const seen: string[] = [];
    for (let i = 0; i < PERIOD_FRAMES; i++) {
      // The glyph is one char + one space, then the label — cut before the timer,
      // whose digits tick on `useElapsed`'s own clock (not this feature's).
      const frame = (lastFrame() ?? "").slice(0, 2 + label.length);
      seen.push(frame.replace(/^[\u2800-\u28ff]/, "⠿"));
      await Bun.sleep(20);
    }
    unmount();
    // One distinct label text across the whole period — the words never move.
    expect([...new Set(seen)]).toEqual([`⠿ ${label}`]);
  });

  test("the label still carries the spinner and the timer/hint", () => {
    const { lastFrame, unmount } = render(<Thinking since={Date.now()} label="Thinking…" />);
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toMatch(/^[\u2800-\u28ff] Thinking…/);
    expect(frame).toContain(" · ");
    expect(frame).toContain("esc/ctrl+c to stop");
  });

  // Ink gotcha (AGENTS §6): a wide-glyph label must not change the row's height
  // or shift the row below it — the sweep's spans are inline, not blocks.
  test("a wide-character label renders on one line, unwrapped", () => {
    const { lastFrame, unmount } = render(<Thinking since={Date.now()} label="思考…" />);
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame.replace(/^[\u2800-\u28ff]/, "")).toContain("思考…");
  });
});
