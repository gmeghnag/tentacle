import { describe, expect, test } from "bun:test";
import { SPINNER_FRAMES, StatusLine } from "../src/status-line.ts";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
/** Every repaint starts like this: back to column 0, erase the whole line. */
const CLEAR = "\r\x1b[2K";

/** Capture every write from a `StatusLine` into a list (in order). */
function capture() {
  const writes: string[] = [];
  const line = new StatusLine({ write: (t) => writes.push(t) });
  return { writes, line };
}

/** A capture whose terminal is `columns` wide (`undefined`: width unknown). */
function captureAt(columns: number | undefined) {
  const writes: string[] = [];
  const line = new StatusLine({ write: (t) => writes.push(t), columns: () => columns });
  return { writes, line };
}

/** Index into a captured list, throwing if the entry is missing (no `!`). */
function at(list: readonly string[], index: number): string {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`no entry at index ${index} (got ${list.length})`);
  }
  return value;
}

/** The visible text of a paint: the `\r` + erase-line prefix dropped. */
function body(paint: string): string {
  expect(paint.startsWith(CLEAR)).toBe(true);
  return paint.slice(CLEAR.length);
}

/**
 * Capture `process.once`/`process.off` exit handlers without firing the real
 * `exit` event (same monkey-patch pattern as `engine-runtime.test.ts`).
 */
function captureExitHandlers() {
  const captured: Array<(() => void) | string> = [];
  const originalOnce = process.once.bind(process);
  const originalOff = process.off.bind(process);
  process.once = ((event: string, listener: (...args: unknown[]) => void): unknown => {
    if (event === "exit") {
      captured.push(listener);
      return process;
    }
    return originalOnce(event, listener);
  }) as typeof process.once;
  process.off = ((event: string, listener: (...args: unknown[]) => void): unknown => {
    if (event === "exit") {
      const idx = captured.indexOf(listener);
      if (idx >= 0) {
        captured.splice(idx, 1);
      }
      return process;
    }
    return originalOff(event, listener);
  }) as typeof process.off;
  return {
    captured,
    restore: () => {
      process.once = originalOnce;
      process.off = originalOff;
    },
  };
}

describe("StatusLine", () => {
  test("set() hides the cursor once and repaints in place (\\r + erase-line, no newline, no padding)", () => {
    const { writes, line } = capture();
    line.set("creating pod…");
    expect(writes[0]).toBe(HIDE);
    expect(writes[1]).toBe(`${CLEAR}⠋ creating pod…`);
    line.set("waiting…");
    // Never padded: the erase-line sequence clears the old tail.
    expect(writes[2]).toBe(`${CLEAR}⠋ waiting…`);
    expect(writes.filter((w) => w === HIDE)).toHaveLength(1);
    expect(writes.join("")).not.toContain("\n");
  });

  test("a line wider than the terminal never wraps: cut to columns-1 cells; later frames are not padded to it", () => {
    // podman's `creating … in unix:///var/folders/…sock (podman socket (auto-discovered))`
    // is ~210 cells. Padding the next frames up to THAT width wrapped them on an
    // 80-column terminal, and `\r` then returned only to the wrapped row: every
    // frame landed on a new line. Mutation: pad to the previous width / skip the
    // cut → fails.
    for (const columns of [80, 210]) {
      const { writes, line } = captureAt(columns);
      line.set("x".repeat(300));
      line.set("injecting tentacle ▓▓░░ 12% 11.0/89.6 MB");
      for (const paint of writes.filter((w) => w !== HIDE)) {
        const text = body(paint);
        expect(text.length).toBeLessThanOrEqual(columns - 1);
        expect(text).toBe(text.trimEnd());
      }
      expect(body(at(writes, 1))).toBe(`⠋ ${"x".repeat(columns - 3)}`);
      expect(body(at(writes, 2))).toBe("⠋ injecting tentacle ▓▓░░ 12% 11.0/89.6 MB");
    }
  });

  test("the cut counts display cells: a double-width glyph is two", () => {
    const { writes, line } = captureAt(10);
    line.set("日本語日本語日本語");
    // columns-1 = 9 cells: frame + space (2) + 3 wide glyphs (6) = 8; a 4th would make 10.
    expect(body(at(writes, 1))).toBe("⠋ 日本語");
  });

  test("an unknown width leaves the text whole", () => {
    const { writes, line } = captureAt(undefined);
    line.set("y".repeat(300));
    expect(body(at(writes, 1))).toBe(`⠋ ${"y".repeat(300)}`);
  });

  test("a timer tick is the same one-line repaint", async () => {
    const writes: string[] = [];
    const line = new StatusLine({
      write: (t) => writes.push(t),
      intervalMs: 5,
      columns: () => 80,
    });
    line.set("tick");
    await new Promise((r) => setTimeout(r, 60));
    line.finish();
    const paints = writes.filter((w) => w.startsWith(CLEAR) && w !== CLEAR);
    expect(paints.length).toBeGreaterThan(1);
    expect(paints.every((p) => !p.includes("\n") && p.endsWith(" tick"))).toBe(true);
  });

  test("finish() clears the line (erase-line), restores the cursor, and is idempotent", () => {
    const { writes, line } = capture();
    line.set("a longer phase text here…");
    line.set("short…");
    line.finish();
    // writes: [HIDE, paint1, paint2, clear, SHOW]
    expect(writes[3]).toBe(CLEAR);
    expect(writes[4]).toBe(SHOW);
    // Idempotent: a second finish (and a late set) writes nothing.
    line.finish();
    line.set("too late");
    expect(writes).toHaveLength(5);
  });

  test("finish() before any set() writes nothing and registers no exit handler", () => {
    const { writes, line } = capture();
    const handlers = captureExitHandlers();
    try {
      line.finish();
      expect(writes).toHaveLength(0);
      expect(handlers.captured).toHaveLength(0);
    } finally {
      handlers.restore();
    }
  });

  test("set() registers the exit safety net; finish() removes it", () => {
    const { line } = capture();
    const handlers = captureExitHandlers();
    try {
      line.set("creating…");
      expect(handlers.captured).toHaveLength(1);
      line.finish();
      expect(handlers.captured).toHaveLength(0);
    } finally {
      handlers.restore();
    }
  });

  test("the exit safety net restores the cursor if the process exits first", () => {
    const { writes, line } = capture();
    const handlers = captureExitHandlers();
    try {
      line.set("creating…");
      const handler = handlers.captured[0] as () => void;
      handler(); // as a real `process.exit` would fire it
      expect(writes[2]).toBe(SHOW);
      line.finish(); // still clears the line; the handler is already gone
      expect(handlers.captured).toHaveLength(0);
    } finally {
      handlers.restore();
    }
  });

  test("SPINNER_FRAMES are all distinct single-cell braille glyphs", () => {
    expect(new Set(SPINNER_FRAMES).size).toBe(SPINNER_FRAMES.length);
    for (const frame of SPINNER_FRAMES) {
      expect(frame.length).toBe(1);
    }
  });
});
