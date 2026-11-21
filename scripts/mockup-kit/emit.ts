import { type Unresolved, type Value, extractStyles } from "./extract-styles.ts";
/**
 * The mockup kit's emitter (docs/feat/mobile-mockup-kit.md Slice 1c): source
 * values in (`GenInput`, gathered by `sources.ts`), the three generated files
 * out, as strings. Pure and deterministic, so the drift test regenerates in
 * memory and compares bytes with the committed `tools/mockup-kit/generated/*`.
 * Every table below that turns a source value into CSS is explicit, and an
 * unknown key THROWS (no fallback value).
 */
import { MANIFEST, type ManifestEntry } from "./manifest.ts";

type Rec = Readonly<Record<string, unknown>>;

export interface GenInput {
  readonly palettes: { readonly light: Rec; readonly dark: Rec; readonly petrol: Rec };
  readonly chart: { readonly light: Rec; readonly dark: Rec; readonly petrol: Rec };
  readonly typography: Readonly<Record<string, Rec>>;
  readonly radius: Readonly<Record<string, number>>;
  readonly size: Readonly<Record<string, number>>;
  readonly space: Readonly<Record<string, number>>;
  readonly shadow: Readonly<Record<string, Rec>>;
  /** `theme-beta.ts` `FIGTREE_FACES` and the face each weight × style resolves to. */
  readonly figtree: {
    readonly faces: Readonly<Record<string, string>>;
    readonly face: (weight: number, style: "normal" | "italic") => string;
  };
  readonly tui: { readonly dark: Rec; readonly light: Rec };
  /** Name → ms, already in kebab-ready camelCase (`stepSpinnerTurn`). */
  readonly timings: Readonly<Record<string, number>>;
  /** Other motion numbers (`HEADER_DOT_LOW_OPACITY`), unitless: `--n-<name>`. */
  readonly numbers: Readonly<Record<string, number>>;
  /** Name → source easing (`inOut(ease)`), mapped through `EASING_CSS`. */
  readonly easing: Readonly<Record<string, string>>;
  readonly glyphs: Readonly<Record<string, Value>>;
  /** Pure view-model functions evaluated over canonical inputs. */
  readonly viewModels: Readonly<Record<string, Value>>;
  /** Modules the style folder may resolve imports against (repo path → exports). */
  readonly modules: Readonly<Record<string, Rec>>;
  /** Repo path → source text: every manifest file, plus every file hashed in `source`. */
  readonly files: Readonly<Record<string, string>>;
  readonly manifest?: readonly ManifestEntry[];
}

export interface Generated {
  readonly "tokens.css": string;
  readonly "tui-tokens.css": string;
  readonly "kit-data.json": string;
}

/** `accentSoftStrong` → `accent-soft-strong`; `STEP_SPINNER_TURN` → `step-spinner-turn`. */
export function kebab(name: string): string {
  if (/^[A-Z0-9_]+$/.test(name)) {
    return name.toLowerCase().replaceAll("_", "-");
  }
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/** RN font families → CSS stacks. `undefined` = RN's system font = the kit's `--font-ui`. */
export const FONT_STACK: Readonly<Record<string, string>> = {
  "ui-monospace": 'ui-monospace, "SF Mono", Menlo, monospace',
};
/** The system face on the phone (SF Pro); swapped for Figtree by `[data-font="figtree"]`. */
export const SYSTEM_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

/**
 * RN `Easing` → CSS. `inOut(ease)` is RN's mirrored `bezier(0.42, 0, 1, 1)`;
 * CSS `ease-in-out` (`0.42, 0, 0.58, 1`) is its closest cubic — the one
 * approximation here, named.
 */
export const EASING_CSS: Readonly<Record<string, string>> = {
  linear: "linear",
  "inOut(ease)": "cubic-bezier(0.42, 0, 0.58, 1)",
  "out(ease)": "cubic-bezier(0, 0, 0.58, 1)",
};

/**
 * Named chalk colours (the TUI's dark-mode "named chalk colour", `theme.ts`
 * `Color`) → hex: the xterm defaults. TERMINAL-DEPENDENT — a real terminal's
 * profile may differ. `dim` and `hidden` are SGR attributes, not colours.
 */
export const CHALK_CSS: Readonly<Record<string, string>> = {
  black: "#000000",
  red: "#cd0000",
  green: "#00cd00",
  yellow: "#cdcd00",
  blue: "#0000ee",
  magenta: "#cd00cd",
  cyan: "#00cdcd",
  white: "#e5e5e5",
  gray: "#7f7f7f",
  grey: "#7f7f7f",
  dim: "color-mix(in srgb, currentColor 55%, transparent)",
  hidden: "transparent",
};

/** RN numeric style props that are unitless in CSS too. */
const UNITLESS = new Set([
  "opacity",
  "flex",
  "flexGrow",
  "flexShrink",
  "zIndex",
  "aspectRatio",
  "shadowOpacity",
]);

/** The theme's glass shadow is CSS `blur = 2 × shadowRadius` (theme.ts `shadow` doc). */
const BLUR_PER_SHADOW_RADIUS = 2;

const num = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));
const px = (n: number): string => (n === 0 ? "0" : `${num(n)}px`);

function rgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) {
    throw new Error(`mockup-kit: shadow colour ${hex} is not #rrggbb`);
  }
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h ?? "0", 16));
  return `rgba(${r}, ${g}, ${b}, ${num(alpha)})`;
}

function cssColor(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new Error(`mockup-kit: ${where} is not a colour string`);
  }
  if (/^#|^rgba?\(/.test(value) || value === "transparent") {
    return value;
  }
  const named = CHALK_CSS[value];
  if (named === undefined) {
    throw new Error(`mockup-kit: ${where}: unknown colour name "${value}" (add it to CHALK_CSS)`);
  }
  return named;
}

const block = (selector: string, lines: readonly string[]): string =>
  `${selector} {\n${lines.map((l) => `  ${l}`).join("\n")}\n}\n`;

function paletteVars(p: Rec, chart: Rec, shadow: Readonly<Record<string, Rec>>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    out.push(
      typeof v === "number"
        ? `--c-${kebab(k)}: ${num(v)};`
        : `--c-${kebab(k)}: ${cssColor(v, `palette.${k}`)};`,
    );
  }
  for (const [k, v] of Object.entries(chart)) {
    out.push(`--chart-${kebab(k)}: ${cssColor(v, `chart.${k}`)};`);
  }
  const opacity = p.shadowOpacity;
  if (typeof opacity !== "number") {
    throw new Error("mockup-kit: palette.shadowOpacity is not a number");
  }
  for (const [k, s] of Object.entries(shadow)) {
    const off = s.shadowOffset as { width: number; height: number } | undefined;
    if (!off || typeof s.shadowRadius !== "number" || typeof s.shadowColor !== "string") {
      throw new Error(`mockup-kit: shadow.${k} lacks shadowOffset/shadowRadius/shadowColor`);
    }
    const blur = s.shadowRadius * BLUR_PER_SHADOW_RADIUS;
    out.push(
      `--shadow-${kebab(k)}: ${px(off.width)} ${px(off.height)} ${px(blur)} ${rgba(s.shadowColor, opacity)};`,
    );
  }
  return out;
}

function family(f: unknown, where: string): string {
  if (f === undefined) {
    return "var(--font-ui)";
  }
  const stack = typeof f === "string" ? FONT_STACK[f] : undefined;
  if (stack === undefined) {
    throw new Error(`mockup-kit: ${where}: unknown fontFamily ${String(f)} (add it to FONT_STACK)`);
  }
  return stack;
}

/** One RN style prop as a CSS value, or null when it has no CSS form (enums, objects). */
function cssValue(prop: string, v: Value, where: string): string | null {
  if (typeof v === "number") {
    return UNITLESS.has(prop) ? num(v) : px(v);
  }
  if (typeof v !== "string") {
    return null;
  }
  if (prop === "fontFamily") {
    return family(v, where);
  }
  if (prop === "fontWeight" || /^-?[0-9.]+%$/.test(v)) {
    return v;
  }
  if (/color$/i.test(prop)) {
    return cssColor(v, where);
  }
  return null;
}

/** Figtree's @font-face rules: each face's weight range, read off `figtreeFace`. */
function figtreeFaces(input: GenInput): string {
  const out: string[] = [];
  for (const [key, name] of Object.entries(input.figtree.faces)) {
    for (const style of ["normal", "italic"] as const) {
      const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900].filter(
        (w) => input.figtree.face(w, style) === name,
      );
      if (weights.length === 0) {
        continue;
      }
      out.push(
        block("@font-face", [
          'font-family: "Figtree";',
          `src: url("../../../apps/mobile/assets/fonts/${name}.ttf") format("truetype");`,
          `font-weight: ${weights[0]} ${weights[weights.length - 1]};`,
          `font-style: ${style};`,
          `/* ${key} */`,
        ]),
      );
    }
  }
  return out.join("\n");
}

export interface Metrics {
  readonly metrics: Record<
    string,
    { file: string; styles: Record<string, Record<string, Value>>; consts: Record<string, Value> }
  >;
  readonly unresolved: Unresolved[];
}

export function extractAll(input: GenInput): Metrics {
  const metrics: Metrics["metrics"] = {};
  const unresolved: Unresolved[] = [];
  for (const entry of input.manifest ?? MANIFEST) {
    const source = input.files[entry.file];
    if (source === undefined) {
      throw new Error(`manifest: ${entry.id} → ${entry.file}: file not found`);
    }
    const x = extractStyles({
      id: entry.id,
      file: entry.file,
      source,
      modules: input.modules,
      requireStyles: entry.styles,
    });
    metrics[entry.id] = { file: entry.file, styles: x.styles, consts: x.consts };
    unresolved.push(...x.unresolved);
  }
  return { metrics, unresolved };
}

function tokensCss(input: GenInput, m: Metrics): string {
  const head = "/* GENERATED by `bun run mockup-kit` from apps/mobile/src — do not edit. */\n";
  const themes = [
    block(
      ':root,\n[data-theme="light"]',
      paletteVars(input.palettes.light, input.chart.light, input.shadow),
    ),
    block('[data-theme="dark"]', paletteVars(input.palettes.dark, input.chart.dark, input.shadow)),
    block(
      '[data-theme="petrol"]',
      paletteVars(input.palettes.petrol, input.chart.petrol, input.shadow),
    ),
  ];
  const root: string[] = [`--font-ui: ${SYSTEM_STACK};`];
  for (const [name, t] of Object.entries(input.typography)) {
    const k = kebab(name);
    root.push(
      `--t-${k}-size: ${px(Number(t.fontSize))};`,
      `--t-${k}-lh: ${px(Number(t.lineHeight))};`,
    );
    if (t.fontWeight !== undefined) root.push(`--t-${k}-weight: ${String(t.fontWeight)};`);
    if (typeof t.letterSpacing === "number")
      root.push(`--t-${k}-tracking: ${px(t.letterSpacing)};`);
    root.push(`--t-${k}-family: ${family(t.fontFamily, `typography.${name}`)};`);
  }
  for (const [prefix, rec] of [
    ["r", input.radius],
    ["s", input.size],
    ["sp", input.space],
  ] as const) {
    for (const [k, v] of Object.entries(rec)) root.push(`--${prefix}-${kebab(k)}: ${px(v)};`);
  }
  for (const [k, v] of Object.entries(input.timings)) root.push(`--ms-${kebab(k)}: ${num(v)}ms;`);
  for (const [k, v] of Object.entries(input.numbers)) root.push(`--n-${kebab(k)}: ${num(v)};`);
  for (const [k, v] of Object.entries(input.easing)) {
    const css = EASING_CSS[v];
    if (css === undefined)
      throw new Error(`mockup-kit: easing ${k} = "${v}" has no CSS form (add it to EASING_CSS)`);
    root.push(`--ease-${kebab(k)}: ${css};`);
  }
  for (const [id, c] of Object.entries(m.metrics)) {
    for (const [style, props] of Object.entries(c.styles)) {
      for (const [prop, v] of Object.entries(props)) {
        const css = cssValue(prop, v, `${id}.${style}.${prop}`);
        if (css !== null) root.push(`--m-${id}-${kebab(style)}-${kebab(prop)}: ${css};`);
      }
    }
    // A module const has no unit of its own (a size, a scale…): unitless, `calc(var() * 1px)`.
    for (const [name, v] of Object.entries(c.consts)) {
      if (typeof v === "number") root.push(`--m-${id}-k-${kebab(name)}: ${num(v)};`);
    }
  }
  const figtree = block('[data-font="figtree"]', ['--font-ui: "Figtree", sans-serif;']);
  return [head, ...themes, block(":root", root), figtree, figtreeFaces(input)].join("\n");
}

/**
 * TUI token leaves that are NOT colours, named one by one (a by-type rule —
 * "skip the arrays" — would swallow a genuinely unknown colour name too, which
 * must keep throwing): `tokens.mascot.names` is the palettes' ORDER
 * (`mascot.ts` `PALETTE_NAMES`), a list the JS reads and nothing paints. The
 * palettes themselves ARE colours and emit normally
 * (`mascot.tones.soft.K` → `--tui-mascot-tones-soft-k`).
 */
const TUI_METADATA: ReadonlySet<string> = new Set(["mascot.names"]);

/** Flatten one token subtree into `--tui-*` lines; `path` is the key path *under* `tui.<mode>`. */
function flatten(prefix: string, v: unknown, out: string[], where: string, path = ""): void {
  if (typeof v === "boolean") return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => flatten(`${prefix}-${i}`, x, out, `${where}[${i}]`, `${path}[${i}]`));
    return;
  }
  if (typeof v === "object" && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      const sub = path === "" ? k : `${path}.${k}`;
      if (TUI_METADATA.has(sub)) continue;
      flatten(`${prefix}-${kebab(k)}`, x, out, `${where}.${k}`, sub);
    }
    return;
  }
  out.push(`${prefix}: ${cssColor(v, where)};`);
}

function tuiCss(input: GenInput): string {
  const head = "/* GENERATED by `bun run mockup-kit` from packages/tui/src — do not edit. */\n";
  const out = [head];
  for (const mode of ["dark", "light"] as const) {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(input.tui[mode]))
      flatten(`--tui-${kebab(k)}`, v, lines, `tui.${mode}.${k}`, k);
    out.push(block(`[data-tui="${mode}"]`, lines));
  }
  // The 16-colour SGR codes a real frame may carry (`K.tui.fromAnsi`): CHALK_CSS's names.
  const ansi = Object.entries(CHALK_CSS)
    .filter(([k]) => k !== "dim" && k !== "hidden")
    .map(([k, v]) => `--tui-ansi-${k}: ${v};`);
  out.push(block(":root", ansi));
  return out.join("\n");
}

/** Git's blob id of a text (what `git hash-object` prints), so the page can say "from blob X". */
export function blobSha(text: string): string {
  const body = new TextEncoder().encode(text);
  const h = new Bun.CryptoHasher("sha1");
  h.update(`blob ${body.length}\0`);
  h.update(body);
  return h.digest("hex");
}

/** The first line where committed and fresh output differ, with the fix; null when equal. */
export function firstDiff(committed: Generated, fresh: Generated): string | null {
  for (const name of Object.keys(fresh) as (keyof Generated)[]) {
    const a = (committed[name] ?? "").split("\n");
    const b = (fresh[name] ?? "").split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        return `${name}:${i + 1}: committed «${(a[i] ?? "").trim()}» ≠ source «${(b[i] ?? "").trim()}» — run: bun run mockup-kit`;
      }
    }
  }
  return null;
}

export function generate(input: GenInput): Generated {
  const m = extractAll(input);
  for (const u of m.unresolved) {
    process.stderr.write(
      `mockup-kit: unresolved ${u.component}.${u.style}.${u.prop} at ${u.file}:${u.line}: ${u.source}\n`,
    );
  }
  const source = Object.fromEntries(
    Object.keys(input.files)
      .sort()
      .map((f) => [f, blobSha(input.files[f] ?? "")]),
  );
  const data = {
    source,
    timings: input.timings,
    numbers: input.numbers,
    easing: Object.fromEntries(
      Object.entries(input.easing).map(([k, v]) => [k, { source: v, css: EASING_CSS[v] }]),
    ),
    glyphs: input.glyphs,
    typography: input.typography,
    palettes: input.palettes,
    tui: input.tui,
    metrics: m.metrics,
    viewModels: input.viewModels,
    unresolved: m.unresolved,
  };
  return {
    "tokens.css": tokensCss(input, m),
    "tui-tokens.css": tuiCss(input),
    "kit-data.json": `${JSON.stringify(data, null, 2)}\n`,
  };
}
