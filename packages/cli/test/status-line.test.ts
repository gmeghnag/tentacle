import { describe, expect, test } from "bun:test";
import { SPINNER_FRAMES, StatusLine } from "../src/status-line.ts";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

/** Capture every write from a `StatusLine` into a list (in order). */
function capture() {
  const writes: string[] = [];
  const line = new StatusLine({ write: (t) => writes.push(t) });
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
  test("set() hides the cursor once and repaints in place (\\r-prefixed, no newline)", () => {
    const { writes, line } = capture();
    line.set("creating pod…");
    expect(writes[0]).toBe(HIDE);
    expect(writes[1]).toBe("\r⠋ creating pod…");
    // A second phase repaints the same line (same frame — the timer only
    // ticks asynchronously — no newline, no second hide). The shorter line is
    // padded to the previous (wider) width so the old tail is erased.
    line.set("waiting…");
    const newLine = "⠋ waiting…";
    expect(writes[2]).toBe(`\r${newLine}${" ".repeat(at(writes, 1).length - 1 - newLine.length)}`);
    expect(writes.filter((w) => w === HIDE)).toHaveLength(1);
    expect(writes.join("")).not.toContain("\n");
  });

  test("a shorter repaint pads to the previous (longer) width so the tail is erased", () => {
    const { writes, line } = capture();
    line.set("a longer phase text here…");
    const firstWidth = at(writes, 1).slice(1).length; // "⠋ a longer phase text here…"
    line.set("short…");
    const body = at(writes, 2).slice(1);
    expect(body.startsWith("⠋ short…")).toBe(true);
    // Padded with spaces up to (at least) the first, wider width.
    expect(body.length).toBeGreaterThanOrEqual(firstWidth);
    expect(body.slice("⠋ short…".length)).toBe(" ".repeat(body.length - "⠋ short…".length));
  });

  test("finish() clears the whole covered width, restores the cursor, and is idempotent", () => {
    const { writes, line } = capture();
    line.set("a longer phase text here…");
    const width = at(writes, 1).slice(1).length;
    line.set("short…");
    line.finish();
    // writes: [HIDE, paint1, paint2, clear, SHOW]
    expect(writes[3]).toBe(`\r${" ".repeat(width)}\r`);
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
