/**
 * docs/feat/app-decomposition.md S14 (`feat/app-decomp-14-tidy`) — the tidy that
 * makes the decomposition's own pins honest. Three claims, each red on the
 * pre-tidy tree (AGENTS §9):
 *
 *   1. **No dead import.** Every name `App.tsx` imports is bound to a use in
 *      its body or re-exported by name; the slices that moved code out left 32
 *      behind, and `tsc` cannot see them (`noUnusedLocals` is off, `biome.json`
 *      does not enable `noUnusedImports`), so the scan has to. A mention in a
 *      COMMENT is not a use — four of the 32 were only that.
 *   2. **No stale effect count.** `App` declares 22 effects (the original 20 plus
 *      session-hop's two — `targetFeed`'s subscription and the idle
 *      `hopIfQueued`), while the source comments and the structure tests' titles
 *      still said 20. A comment that names the wrong count is how an effect-order
 *      argument goes wrong in the next slice.
 *   3. **No orphaned move-fragment.** One sentence fragment survived a move.
 *
 * Non-vacuity: (1) re-add an unused import → red; (2) write "the 20 below" back
 * → red; (3) restore the fragment → red. Each was checked by mutation. Plus the
 * scan's own control cases (a dead name, a re-export, a comment-only name, a
 * string-only name, an alias, a template expansion), each mutation-checked too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");

/**
 * The names an import statement BINDS: `type` prefix dropped, and for
 * `x as y` only `y` (the local name; `x` is the module's, not ours).
 */
const namesOf = (spec: string): string[] =>
  spec
    .split(",")
    .map((raw) =>
      (
        raw
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop() ?? ""
      ).trim(),
    )
    .filter((name) => name !== "");

/**
 * Imported name → used? The import statements are blanked out first (same
 * length, so positions survive), then the name is looked for in what is left.
 * A `export type { X }` / `export { X }` block counts as a use — it is one — and
 * blanking only the `import …` statements is what keeps them counted. A
 * `export … { X } from "./m.ts"` does NOT (see `blankReexportFrom`).
 *
 * Comments and quoted strings are blanked too, because neither is a use: this
 * file's comments name identifiers everywhere, so a name whose last mention is a
 * comment ("`refreshMs`, `JOB_REFRESH_MS` unless a test shortens it") is dead.
 * Review round 1 finding 1 was exactly that — four names passed only that way.
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
  const code = withoutCommentsAndStrings(blankReexportFrom(blanked));
  return names.filter((name) => !new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code));
}

/**
 * A re-export WITHOUT `from` (`export { X }`, `export type { X }`) USES the
 * local binding; one WITH `from` (`export { X } from "./m.ts"`) publishes the
 * module's own export and leaves our `import` of `X` dead — Biome's
 * `noUnusedImports` caught four of those (`HopFeed`, `HopPlaceView`,
 * `SettingsNoticeLine`, `TargetFeed`) that this scan had cleared. So the
 * `from` form's braces are blanked like an import statement's.
 */
function blankReexportFrom(src: string): string {
  const re = /^export\s+(?:type\s+)?\{[^{}]*\}\s+from\s+"[^"]+";/gm;
  let out = src;
  for (const m of src.matchAll(re)) {
    out = out.slice(0, m.index) + " ".repeat(m[0].length) + out.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * Blank comments and quoted literals (and a regex literal's pattern) to spaces,
 * keeping the length and every newline, so the result can be searched by
 * position. One pass, because a `//` inside a string and an apostrophe inside a
 * comment each defeat doing the two with separate regexes.
 *
 * A template literal's `${…}` is CODE, not string: `\`_${hopFailureText(e)}_\``
 * is a use of `hopFailureText` (blanking it reported a live import as dead —
 * seen while fixing this). So a template's expansions are left uncut and the
 * text between them is blanked.
 */
function withoutCommentsAndStrings(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < src.length; k += 1) {
      if (src[k] !== "\n") out[k] = " ";
    }
  };
  /** Index just past the quote closing the literal opened at `from`. */
  const closeOf = (from: number, quote: string): number => {
    let k = from + 1;
    while (k < src.length && src[k] !== quote) k += src[k] === "\\" ? 2 : 1;
    return k;
  };
  /** Blank a template's literal text up to its closing backtick, expansions kept. */
  const template = (from: number): number => {
    let k = from + 1;
    while (k < src.length && src[k] !== "`") {
      if (src[k] === "\\") {
        blank(k, k + 2);
        k += 2;
      } else if (src[k] === "$" && src[k + 1] === "{") {
        blank(k, k + 2);
        k = expansion(k + 2);
      } else {
        blank(k, k + 1);
        k += 1;
      }
    }
    return k + 1;
  };
  /** Walk an expansion's code to its closing `}`; returns the index past it. */
  const expansion = (from: number): number => {
    let depth = 1;
    let k = from;
    while (k < src.length && depth > 0) {
      const c = src[k];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === "`") {
        k = template(k);
        continue;
      } else if (c === '"' || c === "'") {
        k = closeOf(k, c) + 1;
        continue;
      }
      k += 1;
    }
    return k;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "`") {
      i = template(i);
    } else if (c === '"' || c === "'") {
      const close = closeOf(i, c);
      blank(i + 1, close);
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
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

  // The two ways this scan was fooled once (review round 1, finding 1): a name
  // mentioned only in a COMMENT is dead (a comment is not a use — this file's
  // comments name identifiers everywhere), and a name a `export … { X }` block
  // publishes is used even when it sits among the imports.
  test("the scan is not fooled by a comment-only name, and keeps a re-export", () => {
    const sample = [
      'import { reexported } from "./a.ts";',
      'import { commentOnly } from "./b.ts";',
      'import { reallyDead } from "./c.ts";',
      'import { theirName as ourName } from "./d.ts";',
      'import { inATemplate } from "./e.ts";',
      'import { inAString } from "./f.ts";',
      'import { reexportedFrom } from "./g.ts";',
      "export type { reexported };",
      "// `commentOnly` is named here, and nowhere else.",
      "/* reallyDead is named here too. */",
      "const x = ourName;",
      "const t = `_" + "${inATemplate}" + "_`;",
      'const s = "inAString";',
      'export type { reexportedFrom } from "./g.ts";',
      "",
    ].join("\n");
    // `theirName` is the module's name; only the local `ourName` is bound here,
    // so the alias must not be reported dead (nor mask a dead real name). A
    // template expansion is code, a string literal is not. And a re-export
    // WITH `from` publishes the module's own export, not our import binding
    // (`reexportedFrom` at :106 in App.tsx was dead for exactly that reason),
    // while one WITHOUT `from` does use the local binding.
    expect(unusedImports(sample)).toEqual([
      "commentOnly",
      "reallyDead",
      "inAString",
      "reexportedFrom",
    ]);
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
