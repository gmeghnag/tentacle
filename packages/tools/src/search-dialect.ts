/**
 * The regex dialect of `search` (docs/feat/explore-search.md, Design 3c, H1/Q7):
 * which patterns the fallback `grep -E` can be trusted with, and what a pattern
 * it cannot express becomes.
 *
 * Measured 2026-11-11 on BSD grep 2.6.0, busybox 1.38.0/1.36.1 and GNU grep 3.8
 * (`\d+` matched every line holding a `d` on BSD and nothing on GNU/busybox, so
 * "let the engine decide" is a silent wrong answer on three of them). Three
 * classes, decided on strings with no I/O:
 *
 * - **translated** — `\d \D \w \W \s \S` and `[:word:]` become POSIX classes;
 * - **refused** — a construct whose MEANING differs between greps, with a
 *   message naming the construct and the two ways forward;
 * - **passed through** — the rest, which is ERE on every engine (`\b`/`\B`
 *   measured working on all three, so they are NOT refused).
 */

/** Shorthands that translate to a POSIX class, identically on every grep. */
const TRANSLATIONS: Readonly<Record<string, string>> = {
  d: "[0-9]",
  D: "[^0-9]",
  w: "[[:alnum:]_]",
  W: "[^[:alnum:]_]",
  s: "[[:space:]]",
  S: "[^[:space:]]",
};

/** The two ways forward every refusal names. */
const ADVICE =
  "Retry with `fixed_strings: true` for a literal search, or spell it with POSIX classes ([0-9], [[:alpha:]], [^[:space:]]).";

/** A construct no fallback grep agrees on: how it is recognised, and why. */
interface Refusal {
  readonly test: (pattern: string) => boolean;
  readonly reason: string;
}

/**
 * Bracket expressions are found so a shorthand INSIDE one is refused: `[\d]`
 * would translate to `[[0-9]]`, a class holding literal `[`, `0`, `-`, `9`, `]`.
 */
function bracketSpans(pattern: string): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  let index = 0;
  while (index < pattern.length) {
    if (pattern[index] !== "[" || pattern[index - 1] === "\\") {
      index += 1;
      continue;
    }
    // A leading `^` and a `]` as the first member do not close the expression.
    let cursor = index + 1;
    if (pattern[cursor] === "^") {
      cursor += 1;
    }
    if (pattern[cursor] === "]") {
      cursor += 1;
    }
    while (cursor < pattern.length && pattern[cursor] !== "]") {
      cursor += pattern[cursor] === "\\" ? 2 : 1;
    }
    spans.push([index, Math.min(cursor, pattern.length - 1)]);
    index = cursor + 1;
  }
  return spans;
}

/** `a*?` / `a+?` / `a??` / `a{2}?`: a lazy quantifier is a literal `?` on busybox/GNU. */
function hasLazyQuantifier(pattern: string): boolean {
  return /(?:[*+?]|\{\d+(?:,\d*)?\})\?/.test(pattern);
}

/** True when `pattern` holds an unescaped `(?`: a flag, a group-kind or `(?:`. */
function hasGroupSyntax(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "\\") {
      if (pattern[index] === "(" && pattern[index + 1] === "?") {
        return true;
      }
      continue;
    }
    index += 1;
  }
  return false;
}

const REFUSALS: readonly Refusal[] = [
  {
    // `(?…` flags/groups (an escaped `\(?` is an optional literal paren).
    test: hasGroupSyntax,
    reason:
      "`(?…)` flags and non-capturing groups are not ERE: busybox grep errors, GNU grep warns on stderr and matches nothing, and `(?:ab)` matches the literal text on GNU.",
  },
  {
    test: (p) => /\\[pP]\{/.test(p),
    reason:
      "`\\p{…}` Unicode properties exist only in ripgrep: both greps answer no match, silently.",
  },
  {
    test: (p) => /\\[xu]/.test(p),
    reason:
      "`\\x41`/`\\u…` mean a hex escape on BSD grep and the literal text `\\x41` on GNU and busybox — two meanings, both silent.",
  },
  {
    test: hasLazyQuantifier,
    reason:
      "a lazy quantifier (`*?`, `+?`, `??`, `{n,m}?`) is a literal `?` on busybox and GNU, so the match text silently changes.",
  },
  {
    test: (p) => /(?<!\\)\{[\d,]+\}/.test(p),
    reason: "`{n,m}` repetition matches nothing on BSD, GNU and busybox grep (ripgrep honours it).",
  },
  {
    // A shorthand INSIDE a bracket expression (`[\d]`): `[[:word:]]` is a POSIX
    // class, not a shorthand in brackets, so it is translated, not refused.
    test: (p) => bracketSpans(p).some(([start, end]) => /\\[dDwWsS]/.test(p.slice(start, end + 1))),
    reason:
      "a shorthand class inside a bracket expression (`[\\d]`) has no POSIX spelling: write `[0-9]` inside the brackets instead.",
  },
];

/** What `classifyPattern` decided. */
export type PatternClassification =
  | { readonly kind: "ere" }
  | { readonly kind: "translated"; readonly text: string; readonly notes: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Classify `pattern` for the fallback grep. `fixedStrings` skips the whole
 * table: `-F` is literal on every engine (measured on all three).
 */
export function classifyPattern(pattern: string, fixedStrings: boolean): PatternClassification {
  if (fixedStrings) {
    return { kind: "ere" };
  }
  for (const refusal of REFUSALS) {
    if (refusal.test(pattern)) {
      return { kind: "refused", reason: `${refusal.reason} ${ADVICE}` };
    }
  }
  const notes: string[] = [];
  let text = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] as string;
    if (char === "\\" && index + 1 < pattern.length) {
      const next = pattern[index + 1] as string;
      const translated = TRANSLATIONS[next];
      if (translated !== undefined) {
        text += translated;
        const note = `\\${next} → ${translated}`;
        if (!notes.includes(note)) {
          notes.push(note);
        }
        index += 2;
        continue;
      }
      // An escaped backslash, `\b`, `\.`, `\1` …: passed through untouched.
      text += char + next;
      index += 2;
      continue;
    }
    text += char;
    index += 1;
  }
  if (text.includes("[:word:]")) {
    text = text.replaceAll("[:word:]", "[:alnum:]");
    const note = "[:word:] → [:alnum:]";
    if (!notes.includes(note)) {
      notes.push(note);
    }
  }
  if (notes.length === 0) {
    return { kind: "ere" };
  }
  return { kind: "translated", text, notes };
}
