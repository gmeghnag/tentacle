/**
 * The row bullet must be a glyph EVERY monospace font has as TEXT
 * (docs/fix/tui-bullet-glyph.md).
 *
 * The bug: the bullet was `\u23FA` (U+23FA, "black circle for record"), which is
 * emoji-capable — a terminal whose monospace font has no glyph for it falls back
 * to the OS colour-emoji font (Segoe UI Emoji on Windows Terminal/WSL, Apple
 * Color Emoji on iOS Safari) and draws a "record button" emoji, possibly two
 * cells wide. `\u25CF` (U+25CF BLACK CIRCLE) has no emoji form and is present in
 * practically every monospace font.
 *
 * Two independent assertions, because either one alone is vacuous:
 * - the VALUE is the right glyph and is not emoji-capable (the root cause);
 * - no literal U+23FA is LEFT in a source tree that produces frames — one
 *   forgotten literal keeps the bug alive exactly where it was.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BULLET, toolBullet } from "../src/blink.ts";

/** The offending code point: emoji-capable, so the colour font may claim it. */
const EMOJI_BULLET = "\u{23FA}";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** Every `.ts`/`.tsx` file under the given source roots, skipping tests. */
function sourceFiles(dirs: readonly string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "test") {
          walk(path);
        }
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push(path);
      }
    }
  };
  for (const dir of dirs) {
    walk(join(ROOT, dir));
  }
  return files;
}

describe("the row bullet glyph", () => {
  test('is U+25CF "●" — a text glyph with no emoji variant', () => {
    expect(BULLET).toBe("\u{25CF}");
    // THE root cause, asserted directly: an emoji-capable code point is what let
    // the OS substitute a colour-emoji font. A "pretty" bullet that matches
    // /\p{Emoji}/ would bring the bug back on iOS/WSL.
    expect(/\p{Emoji}/u.test(BULLET)).toBe(false);
  });

  test("the blink's two phases are still the same character (the width rule)", () => {
    expect(toolBullet("running", 500)).toContain(BULLET);
    expect(toolBullet("ok", 0)).toBe(BULLET);
    expect(toolBullet("error", 0)).toBe(BULLET);
  });

  test("no emoji-capable bullet literal is left in any source tree that renders", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(["packages", "apps"])) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (line.includes(EMOJI_BULLET)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    // Empty means no frame can still show the emoji: a literal would bypass
    // BULLET (the notice and assistant bullets did exactly that).
    expect(offenders).toEqual([]);
  });
});
