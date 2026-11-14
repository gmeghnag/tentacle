/**
 * docs/feat/app-decomposition.md S14 (`feat/app-decomp-14-tidy`) — the tidy that
 * makes the decomposition's own pins honest. Three claims, each red on the
 * pre-tidy tree (AGENTS §9):
 *
 *   1. **No dead import.** Every name `App.tsx` imports is used in its body or
 *      re-exported by name; the slices that moved code out left 28 behind, and
 *      `tsc` cannot see them (`noUnusedLocals` is off, `biome.json` does not
 *      enable `noUnusedImports`), so the scan has to.
 *   2. **No stale effect count.** `App` declares 22 effects (the original 20 plus
 *      session-hop's two — `targetFeed`'s subscription and the idle
 *      `hopIfQueued`), while the source comments and the structure tests' titles
 *      still said 20. A comment that names the wrong count is how an effect-order
 *      argument goes wrong in the next slice.
 *   3. **No orphaned move-fragment.** One sentence fragment survived a move.
 *
 * Non-vacuity: (1) re-add an unused import → red; (2) write "the 20 below" back
 * → red; (3) restore the fragment → red. Each was checked by mutation.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");

/** The names an import statement brings in (`type` prefix dropped, `as` kept left). */
const namesOf = (spec: string): string[] =>
  spec
    .split(",")
    .map((raw) => raw.trim().replace(/^type\s+/, ""))
    .filter((name) => name !== "");

/**
 * Imported name → used? The import statements are blanked out first (same
 * length, so positions survive), then the name is looked for in what is left.
 * A `export type { X }` / `export { X }` block counts as a use — it is one — and
 * blanking only the `import …` statements is what keeps them counted.
 */
function unusedImports(src: string): string[] {
  const importRe =
    /^import\s+(?:type\s+)?(?:\{[^{}]*\}|\w+(?:\s*,\s*\{[^{}]*\})?)\s+from\s+"[^"]+";/gm;
  const names: string[] = [];
  let blanked = src;
  for (const m of src.matchAll(importRe)) {
    const braces = /\{([^{}]*)\}/.exec(m[0]);
    const solid = /^import\s+(?:type\s+)?(\w+)/.exec(m[0]);
    if (braces?.[1] !== undefined) {
      names.push(...namesOf(braces[1]));
    }
    if (solid?.[1] !== undefined) {
      names.push(solid[1]);
    }
    blanked =
      blanked.slice(0, m.index) + " ".repeat(m[0].length) + blanked.slice(m.index + m[0].length);
  }
  return names.filter((name) => !new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(blanked));
}

describe("S14: App.tsx imports nothing it does not use", () => {
  test("every imported name is used in the body or re-exported by name", () => {
    const app = readSrc("App.tsx");
    expect(unusedImports(app)).toEqual([]);
  });

  // The scan is the only net (`tsc` cannot see it), so prove it can see a dead
  // name at all — a scan that always returns [] would make the pin above empty.
  test("the scan is not vacuous: it finds a dead name it is given", () => {
    const sample = [
      'import { used, dead } from "./x.ts";',
      'import type { AlsoDead } from "./y.ts";',
      'import * as ns from "./z.ts";',
      "const a = used;",
      "export type { AlsoDead };",
      "const b = ns;",
      "",
    ].join("\n");
    // `AlsoDead` is re-exported by name, so it counts as used — one dead name.
    expect(unusedImports(sample)).toEqual(["dead"]);
  });
});

describe("S14: no source or test names the wrong effect count", () => {
  // Effect-count claims only: "the N below", "N effects", "effect 1 of N",
  // "App keeps its N". A stray `delay(20)` or a mouse row's y is not a claim,
  // and a line that ALSO says 22 corrects the N it mentions ("22 = the original
  // N + session-hop's 2"), so it is where the history is written, not stale.
  const CLAIM =
    /(?:effect\s*\d*\s*(?:of|at)\s*20\b)|(?:\b20\s+effects?\b)|(?:(?:its|all|the|has|keeps)\s+20\b)|(?:'s\s+20\b)/i;
  const EFFECTY = /effect/i;
  const CORRECTED = /\b22\b/;

  const files = (dir: string): string[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .map((f) => join(dir, f));

  test("App declares 22 effects, and nothing claims 20", () => {
    const app = readSrc("App.tsx");
    expect([...app.matchAll(/^\s*useEffect\(/gm)].length).toBe(22);

    const offenders: string[] = [];
    for (const path of [...files(SRC), ...files(join(import.meta.dir))]) {
      const lines = readFileSync(path, "utf8").split("\n");
      for (const [i, line] of lines.entries()) {
        if (CLAIM.test(line) && EFFECTY.test(line) && !CORRECTED.test(line)) {
          offenders.push(`${path.split("/").slice(-1)[0]}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("S14: the fragment a move left behind is gone", () => {
  test("App.tsx does not keep the orphaned half-sentence", () => {
    expect(readSrc("App.tsx")).not.toContain("the held ones, and the handler starts streams (C2).");
  });
});
