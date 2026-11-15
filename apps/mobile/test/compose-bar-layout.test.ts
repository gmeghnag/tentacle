/**
 * The photo chips' row must not grow (slice 6 walk, flow 18 on iOS 26: two
 * refused chips were drawn ~380 pt tall). RN's `ScrollView` base style carries
 * `flexGrow: 1`, so a horizontal one in the screen's column takes half the free
 * height from the transcript. `ComposeBar.tsx` imports React Native (Flow
 * sources Bun cannot parse), so this reads the source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dir, "..", "src", "screens", "compose", "ComposeBar.tsx"),
  "utf8",
);

describe("ComposeBar's horizontal rows", () => {
  test("every horizontal ScrollView sets a style that does not grow", () => {
    const opens = [...SRC.matchAll(/<ScrollView\b[^>]*>/g)].map((m) => m[0]);
    const horizontal = opens.filter((tag) => /\bhorizontal\b/.test(tag));
    expect(horizontal.length).toBeGreaterThan(0);
    for (const tag of horizontal) {
      expect(tag).toMatch(/\bstyle=\{styles\.(\w+)\}/);
      const name = /\bstyle=\{styles\.(\w+)\}/.exec(tag)?.[1] ?? "";
      expect(SRC).toMatch(new RegExp(`\\n  ${name}: \\{[^}]*flexGrow: 0`));
    }
  });
});
