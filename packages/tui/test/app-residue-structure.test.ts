/**
 * S13 (`feat/app-decomp-13-pure-residue`) — the STRUCTURE pin: the five rules
 * this slice moved out of `App.tsx` are still out, and still `App.tsx`'s only
 * way to make those decisions.
 *
 * A pure module with unit tests proves the rule is right; it does NOT prove the
 * App calls it. Re-inlining a rule (the copy-paste the slice was written for) is
 * exactly how the two halves drift apart, and no render test would notice — the
 * behaviour is identical until the day one copy is edited. So the App's own
 * source is scanned: no helper is dead, and no inlined copy of what it decides
 * survives beside it.
 *
 * Non-vacuity (each checked by mutation, pasted in the slice's Execution): put
 * one of the old inline shapes back and the scan goes red.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const read = (name: string): string => readFileSync(join(SRC, name), "utf8");
const app = (): string => read("App.tsx");

/** Every one of the five, with the module it lives in. */
const HELPERS: readonly { readonly name: string; readonly file: string }[] = [
  { name: "anchorOffset", file: "scroll.ts" },
  { name: "pasteTarget", file: "paste.ts" },
  { name: "exitOutcome", file: "job-drawer.ts" },
  { name: "jobOutputEntry", file: "job-drawer.ts" },
  { name: "tryWake", file: "wake-gate.ts" },
];

describe("S13: the pure residue is OUT of App.tsx and App calls it", () => {
  test("each helper is imported by App and called in its body", () => {
    const src = app();
    for (const helper of HELPERS) {
      // Declared where the slice put it…
      expect(read(helper.file)).toContain(`export function ${helper.name}(`);
      // …imported from that module…
      expect(src).toContain(`from "./${helper.file}"`);
      // …and CALLED (a mention in a comment or a bare import is not a use).
      expect(src).toContain(`${helper.name}(`);
    }
  });

  test("no inlined copy of a moved rule survives in App.tsx", () => {
    const src = app();
    /**
     * Each pattern was a real line of `App.tsx` before this slice; each is what
     * the corresponding helper now decides. (Not a general code scan — five
     * literal shapes, so a false positive is impossible and a revert is caught.)
     */
    const reverted: readonly { readonly what: string; readonly pattern: RegExp }[] = [
      // `anchorOffset`'s rule, inline in the rows-changed effect.
      { what: "the scroll anchor", pattern: /total > prev && \(scrollOffset > 0 \|\| selecting\)/ },
      // `pasteTarget`'s order, inline at both paste sites.
      { what: "the paste destination", pattern: /!insertIntoReply\(clean\) && !panelRef\.current/ },
      // `exitOutcome`'s nested ternary, inline in the exit handler.
      { what: "the exit outcome", pattern: /job\.agent\.stopReason === "end_turn"/ },
      // `jobOutputEntry`'s record, built inline in a read callback.
      { what: "a read's cache entry", pattern: /output: result\.output \?\? \[\],/ },
      // `tryWake`'s gate derivation, spelled out per site.
      {
        what: "the wake gate",
        pattern: /idle: !stateRef\.current\.running|blocked: clearingRef\.current/,
      },
    ];
    for (const { what, pattern } of reverted) {
      expect({ what, everyMatch: [...src.matchAll(new RegExp(pattern, "g"))].length }).toEqual({
        what,
        everyMatch: 0,
      });
    }
  });

  test("`jobOutputEntry` is the ONE record builder: App spreads it, it never rebuilds it", () => {
    const src = app();
    // Both reads (the polling one and the final on-exit one) go through it.
    expect([...src.matchAll(/jobOutputEntry\(/g)].length).toBe(2);
  });
});
