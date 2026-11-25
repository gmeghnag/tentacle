/**
 * The kit's faithfulness rules (docs/feat/mobile-mockup-kit.md Slice 1d/2), as
 * pure checks the test runs over the real kit files:
 * - every `var(--x)` the kit uses is DEFINED (generated tokens or frame.css) —
 *   a renamed theme/style key leaves the kit asking for the old name;
 * - every `KIT.data` path `kit.js` reads EXISTS in kit-data.json;
 * - `kit.css` / `tui.css` carry no literal hex / px (but 0 and 1px) / ms /
 *   rgb() — the "no hand-copied value" rule (device values: frame.css).
 */

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The custom properties a stylesheet declares (`--x:`). */
export function definedVars(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? ""));
}

/**
 * The custom properties a file reads (`var(--x)`), comments aside. A name built
 * at runtime (`var(--tui-ansi-${…})`) ends in `-` and is checked by its own test.
 */
export function usedVars(text: string): Set<string> {
  return new Set(
    [...stripComments(text).matchAll(/var\(\s*(--[a-z0-9-]+)/g)]
      .map((m) => m[1] ?? "")
      .filter((v) => !v.endsWith("-")),
  );
}

/** `{file: used vars no stylesheet defines}`; empty when all resolve. */
export function missingVars(
  users: Readonly<Record<string, string>>,
  defined: ReadonlySet<string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [file, text] of Object.entries(users)) {
    const miss = [...usedVars(text)].filter((v) => !defined.has(v));
    if (miss.length > 0) out[file] = miss;
  }
  return out;
}

/**
 * The kit's hand-mapped approximations: a declaration that carries a chosen
 * number because the app's value cannot be extracted (an inline-JSX prop, a
 * native blur with no CSS equivalent). Each names WHY, and `literalViolations`
 * exempts that exact declaration — a second number needs a second entry, so a
 * copied trick is a reviewable diff, never a silent pass. Pinned by
 * `scripts/test/mockup-kit.test.ts` ("the kit's approximations are named").
 */
export const APPROXIMATIONS: readonly { readonly declaration: string; readonly why: string }[] = [
  {
    // The hub's glass: FloatingActivity.tsx:563 `BlurView intensity={60}
    // tint="systemUltraThinMaterial"` — an inline JSX prop (no stylesheet to
    // extract) over a native material CSS cannot express; 12 px of backdrop
    // blur is the hand-mapped stand-in, and calibration is its net.
    declaration: "backdrop-filter: blur(calc(12 * 1px)) saturate(1.4)",
    why: "FloatingActivity.tsx:563 BlurView intensity 60, native material",
  },
];

/** Hand-copied values in a kit stylesheet: `line: token`. */
export function literalViolations(css: string): string[] {
  const out: string[] = [];
  stripComments(css)
    .split("\n")
    .forEach((line, i) => {
      const hits = [
        // `calc(12 * 1px)`: a chosen number riding the `1px` exemption. A token
        // times 1px (`calc(var(--m-x) * 1px)`) is the kit's unit conversion, not
        // a literal, and does not match (`\d` is not `v`).
        ...line.matchAll(/calc\(\s*\d*\.?\d+\s*\*\s*1px\s*\)/g),
        ...line.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
        ...line.matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g),
        ...line.matchAll(/(?<![\w.-])\d*\.?\d+ms\b/g),
        ...line.matchAll(/\brgba?\(/g),
      ]
        .map((m) => m[0])
        .filter((t) => t !== "0px" && t !== "1px");
      const declaration = line.trim().replace(/;$/, "");
      const approved = APPROXIMATIONS.some((a) => a.declaration === declaration);
      for (const h of hits) if (!approved) out.push(`${i + 1}: ${h}`);
    });
  return out;
}

/** Aliases kit.js uses for `KIT.data` sub-trees. */
const ALIASES: Readonly<Record<string, string>> = {
  data: "",
  vm: "viewModels",
  tvm: "viewModels.tui",
  glyphs: "glyphs",
};

/** The `KIT.data` paths kit.js reads (`vm.thoughtRow` → `viewModels.thoughtRow`). */
export function dataRefs(js: string): string[] {
  const out = new Set<string>();
  const re = /(?<![\w.$-])(data|vm|tvm|glyphs)\.([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)/g;
  for (const m of js.matchAll(re)) {
    const base = ALIASES[m[1] ?? ""];
    const rest = (m[2] ?? "").split(".");
    // Stop at a method call on a value (`.map`, `.length`): only data keys are paths.
    const keys: string[] = [];
    for (const k of rest) {
      if (["map", "length", "slice", "join", "filter", "get"].includes(k)) break;
      keys.push(k);
    }
    if (keys.length > 0) out.add([base, ...keys].filter(Boolean).join("."));
  }
  return [...out].sort();
}

/** The paths of `refs` that do not exist in `data`. */
export function missingDataRefs(refs: readonly string[], data: unknown): string[] {
  return refs.filter((path) => {
    let at: unknown = data;
    for (const k of path.split(".")) {
      if (typeof at !== "object" || at === null || !Object.hasOwn(at, k)) return true;
      at = (at as Record<string, unknown>)[k];
    }
    return false;
  });
}
