import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * "No stray colour" (docs/feat/tui-light-theme.md S2), made permanent.
 *
 * With one token table, a colour written anywhere else escapes the light palette:
 * it stays dark-mode-legible on a light terminal, and no test notices. The
 * inventory grew FOUR sites between the plan and its execution (the auto-accept
 * gold, the notice blue, the badge accent, the meter's named colours), so the
 * rule is enforced by a scan rather than by review.
 *
 * `theme.ts` is the one file allowed to name a colour.
 */
const SRC = join(import.meta.dir, "../src");

function sources(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sources(path));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push({ path, text: readFileSync(path, "utf8") });
    }
  }
  return out;
}

/** The files that may name a colour (the table itself). */
const ALLOWED = new Set(["theme.ts"]);

const files = sources(SRC).filter((f) => !ALLOWED.has(f.path.slice(SRC.length + 1)));

/** Report `file:line: text` for each match, so a failure names the offender. */
function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    for (const [i, line] of text.split("\n").entries()) {
      // A comment may explain a colour; only code counts.
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (pattern.test(code)) {
        hits.push(`${path.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return hits;
}

describe("no colour outside the token table", () => {
  test("no hex literal", () => {
    // Mutation: `const ACCENT = "#0e7490"` in a component → one line here.
    expect(offenders(/#[0-9a-fA-F]{3,8}\b/)).toEqual([]);
  });

  test("no `color=`/`borderColor=` string literal", () => {
    // The `"gray"`/`"yellow"` props Ink accepts: dark-only, invisible to the table.
    // Both forms count: `color="gray"` and `color={"gray"}`; `{palette().accent}`
    // is a token read, not a literal.
    // Mutation: `color={"gray"}` in a component → one line here.
    expect(offenders(/\b(color|borderColor)=\s*\{?\s*["'`]/)).toEqual([]);
  });

  test('no `color: "x"` object literal (a palette passed by hand)', () => {
    // Mutation: `{ color: "yellow" }` in a style object → one line here.
    expect(offenders(/\b(color|borderColor|backgroundColor):\s*["'`]/)).toEqual([]);
  });

  test("no bare `dimColor` prop (light needs a measurable grey there)", () => {
    // SGR 2 is terminal-defined; in light mode the dim rows get `tokens.dim`.
    // Mutation: revert one component to `dimColor` → one line here.
    expect(offenders(/\bdimColor\b/)).toEqual([]);
  });

  test("no chalk colour call with a literal colour", () => {
    // `chalk.rgb(...)` fed FROM the table is the one legal form (`read-highlight.ts`
    // styles cli-highlight's theme); a literal argument is not.
    expect(
      offenders(
        /\bchalk\.(rgb|hex|bgRgb|bgHex|red|green|yellow|blue|magenta|cyan|white|black|gray|grey|ansi256|bgAnsi256|keyword)\(\s*["'0-9]/,
      ),
    ).toEqual([]);
    expect(
      offenders(
        /\bchalk\.(red|green|yellow|blue|magenta|cyan|white|black|gray|grey|keyword)(?!\()\b/,
      ),
    ).toEqual([]);
  });

  test("no module-level constant captured from the palette", () => {
    // `const ACCENT = accentHex` froze the colour at import; the same trap is
    // what `blink.ts:37` warns about for `chalk.level`.
    expect(offenders(/^const [A-Z_]+ = (theme\.|palette\(\))/)).toEqual([]);
    expect(offenders(/^const [A-Z_]+ = accentHex$/)).toEqual([]);
  });

  test("the scan actually looks at the components (non-vacuity)", () => {
    // A scan that silently matched nothing would pass forever.
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.path.endsWith("StatusBar.tsx"))).toBe(true);
  });
});
