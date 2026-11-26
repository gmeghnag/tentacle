/**
 * The mockup kit's generator (docs/feat/mobile-mockup-kit.md Slice 1): static
 * style folding, token emission, the drift test against the committed
 * `tools/mockup-kit/generated/*`, and the kit's reference/no-literal rules.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lightPalette } from "../../apps/mobile/src/theme.ts";
import { type Generated, firstDiff, generate, kebab } from "../mockup-kit/emit.ts";
import { extractStyles } from "../mockup-kit/extract-styles.ts";
import { formatAll } from "../mockup-kit/format.ts";
import { inlineHtml } from "../mockup-kit/inline.ts";
import {
  APPROXIMATIONS,
  dataRefs,
  definedVars,
  literalViolations,
  missingDataRefs,
  missingVars,
} from "../mockup-kit/kit-rules.ts";
import { ROOT, loadInput } from "../mockup-kit/sources.ts";

const KIT_DIR = join(ROOT, "tools/mockup-kit");
const kitIndex = readFileSync(join(KIT_DIR, "index.html"), "utf8");
const kitFile = (name: string): Promise<string> => Bun.file(join(KIT_DIR, name)).text();
const kit = {
  "kit.css": await kitFile("kit.css"),
  "tui.css": await kitFile("tui.css"),
  "frame.css": await kitFile("frame.css"),
  "kit.js": await kitFile("kit.js"),
};

const GEN = join(ROOT, "tools/mockup-kit/generated");
const input = await loadInput();
const fresh = formatAll(generate(input));
const committed: Generated = {
  "tokens.css": await Bun.file(join(GEN, "tokens.css")).text(),
  "tui-tokens.css": await Bun.file(join(GEN, "tui-tokens.css")).text(),
  "kit-data.json": await Bun.file(join(GEN, "kit-data.json")).text(),
};

/** The body of the first rule whose selector starts with `selector`. */
function rule(css: string, selector: string): Map<string, string> {
  const at = css.indexOf(`${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return new Map(
    body
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.startsWith("--"))
      .map(
        (d) => [d.slice(0, d.indexOf(":")), d.slice(d.indexOf(":") + 1).trim()] as [string, string],
      ),
  );
}

const FILE = "apps/mobile/src/ui/Fixture.tsx";
const THEME = {
  size: { touch: 44 },
  typography: { step: { fontSize: 14, lineHeight: 20 } },
  MONO: "ui-monospace",
};
const MODULES = { "apps/mobile/src/theme.ts": THEME };

const fixture = (body: string, head = ""): string =>
  [
    'import { StyleSheet } from "react-native";',
    'import { MONO, size as SIZE, typography } from "../theme.ts";',
    head,
    "const styles = StyleSheet.create({",
    body,
    "});",
  ].join("\n");

const run = (source: string, requireStyles = true) =>
  extractStyles({ id: "fx", file: FILE, source, modules: MODULES, requireStyles });

describe("extractStyles: constant folding", () => {
  test("literals, a const chain, theme members, arithmetic and hairlineWidth fold", () => {
    const out = run(
      fixture(
        [
          "  a: { width: 13, borderRadius: 6.5, left: -2, flexDirection: 'row' },",
          "  b: { top: NODE_Y - 7, left: GUTTER / 2 - 0.5, marginTop: (19 - 13) / 2 },",
          "  c: { borderTopWidth: StyleSheet.hairlineWidth, fontFamily: MONO },",
          "  d: { ...typography.step, minHeight: SIZE.touch },",
        ].join("\n"),
        "const GUTTER = 10;\nconst NODE_Y = SIZE.touch / 2;",
      ),
    );
    expect(out.unresolved).toEqual([]);
    expect(out.styles).toEqual({
      a: { width: 13, borderRadius: 6.5, left: -2, flexDirection: "row" },
      b: { top: 15, left: 4.5, marginTop: 3 },
      c: { borderTopWidth: 1 / 3, fontFamily: "ui-monospace" },
      d: { fontSize: 14, lineHeight: 20, minHeight: 44 },
    });
    expect(out.consts).toEqual({ GUTTER: 10, NODE_Y: 22 });
  });

  test("a call or a conditional is unresolved at its line, never defaulted", () => {
    const out = run(
      fixture(
        [
          "  a: { width: 10,",
          "    height: Platform.select({ ios: 4 }),",
          "    opacity: dense ? 1 : 0.5 },",
        ].join("\n"),
      ),
    );
    expect(out.styles.a).toEqual({ width: 10 });
    expect(out.unresolved.map((u) => [u.style, u.prop, u.line])).toEqual([
      ["a", "height", 6],
      ["a", "opacity", 7],
    ]);
    expect(out.unresolved[0]?.file).toBe(FILE);
    expect(out.unresolved[0]?.source).toBe("height: Platform.select({ ios: 4 })");
  });

  test("an identifier the file does not bind, or a module not handed in, is unresolved", () => {
    const out = run(
      fixture(
        "  a: { width: W, left: DRAWER_WIDTH },",
        'import { DRAWER_WIDTH } from "../drawer-nav.ts";',
      ),
    );
    expect(out.unresolved.map((u) => u.prop)).toEqual(["width", "left"]);
  });

  test("a file without StyleSheet.create throws, naming the manifest entry", () => {
    expect(() => run("const SIZE = 6;\nexport const X = 1;\n")).toThrow(
      `manifest: fx → ${FILE}: no StyleSheet.create`,
    );
    expect(run("const SIZE = 6;\n", false).consts).toEqual({ SIZE: 6 });
  });
});

describe("emission", () => {
  test("camelCase and SCREAMING_CASE become kebab-case, mechanically", () => {
    expect(kebab("accentSoftStrong")).toBe("accent-soft-strong");
    expect(kebab("delWordBg")).toBe("del-word-bg");
    expect(kebab("title2")).toBe("title2");
    expect(kebab("STEP_SPINNER_TURN")).toBe("step-spinner-turn");
  });

  test("each theme block holds exactly the Palette keys", () => {
    const keys = Object.keys(lightPalette).map((k) => `--c-${kebab(k)}`);
    for (const sel of [
      ':root,\n[data-theme="light"]',
      '[data-theme="dark"]',
      '[data-theme="petrol"]',
    ]) {
      const vars = [...rule(fresh["tokens.css"], sel).keys()].filter((k) => k.startsWith("--c-"));
      expect(vars).toEqual(keys);
    }
  });

  test("petrol inherits dark's semantic colours (--c-red) and has its own page", () => {
    const dark = rule(fresh["tokens.css"], '[data-theme="dark"]');
    const petrol = rule(fresh["tokens.css"], '[data-theme="petrol"]');
    expect(dark.get("--c-red")).toBeDefined();
    expect(petrol.get("--c-red")).toBe(dark.get("--c-red") ?? "");
    expect(petrol.get("--c-page")).toBe("#151b1d");
    expect(petrol.get("--c-page")).not.toBe(dark.get("--c-page") ?? "");
  });

  test("timings and style metrics come from source", () => {
    const root = rule(fresh["tokens.css"], ":root {");
    expect(root.get("--ms-step-blink-half")).toBe("500ms");
    expect(root.get("--ms-header-dot-half")).toBe("700ms");
    expect(root.get("--ms-tui-blink-half")).toBe("500ms");
    expect(root.get("--m-step-dot-border-radius")).toBe("6.5px");
    expect(root.get("--m-step-node-box-top")).toBe("15px");
    expect(root.get("--m-step-body-border-top-width")).toBe("0.3333px");
  });

  test("the mascot's nine palettes are TUI tokens, its `names` list is metadata", () => {
    const dark = rule(fresh["tui-tokens.css"], '[data-tui="dark"]');
    const light = rule(fresh["tui-tokens.css"], '[data-tui="light"]');
    // Every palette × tone is a colour the kit can paint the mascot with.
    for (const p of ["soft", "logo", "glow", "cyan", "teal", "coral", "mint", "amber", "sky"]) {
      for (const tone of ["k", "e", "f", "s", "b"]) {
        expect(dark.get(`--tui-mascot-tones-${p}-${tone}`)).toMatch(/^#[0-9a-f]{6}$/i);
        expect(light.get(`--tui-mascot-tones-${p}-${tone}`)).toBe(
          dark.get(`--tui-mascot-tones-${p}-${tone}`) ?? "",
        );
      }
    }
    expect(dark.get("--tui-mascot-tones-soft-k")?.toLowerCase()).toBe("#7b3fc0");
    // The order list is read by JS, painted by nothing: no token, no colour parse.
    expect([...dark.keys()].filter((k) => k.startsWith("--tui-mascot-names"))).toEqual([]);
  });

  test("non-vacuity: an unknown colour name still throws, in a palette and in an array", () => {
    const inTone = {
      ...input,
      tui: {
        ...input.tui,
        dark: {
          ...input.tui.dark,
          mascot: {
            ...(input.tui.dark.mascot as Record<string, unknown>),
            tones: {
              ...((input.tui.dark.mascot as { tones: Record<string, unknown> }).tones ?? {}),
              soft: { K: "chartreuse" },
            },
          },
        },
      },
    };
    expect(() => generate(inTone)).toThrow(
      'tui.dark.mascot.tones.soft.K: unknown colour name "chartreuse"',
    );
    const inArray = {
      ...input,
      tui: { ...input.tui, dark: { ...input.tui.dark, chart: { series: ["chartreuse"] } } },
    };
    expect(() => generate(inArray)).toThrow(
      'tui.dark.chart.series[0]: unknown colour name "chartreuse"',
    );
  });

  test("an unknown chalk colour name or easing throws (explicit tables, no fallback)", () => {
    const badTui = {
      ...input,
      tui: { ...input.tui, dark: { ...input.tui.dark, accent: "chartreuse" } },
    };
    expect(() => generate(badTui)).toThrow('unknown colour name "chartreuse"');
    expect(() => generate({ ...input, easing: { X: "bounce" } })).toThrow('easing X = "bounce"');
  });

  test("a moved manifest component throws, naming it", () => {
    const manifest = [{ id: "ghost", file: "apps/mobile/src/ui/Ghost.tsx", styles: true }];
    expect(() => generate({ ...input, manifest })).toThrow(
      "manifest: ghost → apps/mobile/src/ui/Ghost.tsx",
    );
  });

  test("the real manifest folds with nothing unresolved", () => {
    expect(JSON.parse(fresh["kit-data.json"]).unresolved).toEqual([]);
  });
});

describe("references: the kit asks only for what the generator defines", () => {
  const defined = new Set([
    ...definedVars(committed["tokens.css"]),
    ...definedVars(committed["tui-tokens.css"]),
    ...definedVars(kit["frame.css"]),
  ]);

  test("every var(--…) in kit.css, tui.css, frame.css and kit.js is defined", () => {
    expect(missingVars(kit, defined)).toEqual({});
  });

  test("the 16-colour names fromAnsi builds at runtime (--tui-ansi-*) are defined", () => {
    for (const name of [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "gray",
    ]) {
      expect(kit["kit.js"]).toContain(name === "gray" ? "--tui-ansi-gray" : `"${name}"`);
      expect(defined.has(`--tui-ansi-${name}`)).toBe(true);
    }
  });

  test("non-vacuity: a renamed token leaves the kit asking for the old name, named", () => {
    const renamed = new Set([...defined].filter((v) => v !== "--m-step-dot-border-radius"));
    renamed.add("--m-step-dot-corner");
    expect(missingVars(kit, renamed)).toEqual({ "kit.css": ["--m-step-dot-border-radius"] });
  });

  test("every KIT.data path kit.js reads exists in kit-data.json", () => {
    const refs = dataRefs(kit["kit.js"]);
    expect(refs).toContain("viewModels.thoughtRow");
    expect(refs).toContain("metrics.step.consts.DOT_AT");
    expect(missingDataRefs(refs, JSON.parse(committed["kit-data.json"]))).toEqual([]);
  });

  test("non-vacuity: a view-model renamed in the data is named", () => {
    const d = JSON.parse(committed["kit-data.json"]);
    d.viewModels.thoughtRows = d.viewModels.thoughtRow;
    d.viewModels.thoughtRow = undefined;
    expect(missingDataRefs(dataRefs(kit["kit.js"]), JSON.parse(JSON.stringify(d)))).toEqual([
      "viewModels.thoughtRow",
    ]);
  });
});

describe("no hand-copied value in kit.css / tui.css", () => {
  test("no literal hex, px (but 0/1px), ms or rgb()", () => {
    expect(literalViolations(kit["kit.css"])).toEqual([]);
    expect(literalViolations(kit["tui.css"])).toEqual([]);
  });

  test("mutation: an inserted color:#000, a 13px and a 900ms are each caught", () => {
    expect(
      literalViolations(
        `${kit["kit.css"]}\n.x { color:#000; width: 13px; transition: opacity 900ms; }`,
      ),
    ).toEqual([
      expect.stringMatching(/: #000$/),
      expect.stringMatching(/: 13px$/),
      expect.stringMatching(/: 900ms$/),
    ]);
  });

  test("a comment may name a value (it is prose, not a style)", () => {
    expect(literalViolations("/* was 480ms and #fff */ .x { color: var(--c-red); }")).toEqual([]);
  });

  test("a hand-picked size dressed as a hairline, calc(N * 1px), is a literal too", () => {
    // The evasion this rule must not allow: `1px` is exempt, so `12 * 1px`
    // smuggles a chosen number past it.
    expect(literalViolations(".x { backdrop-filter: blur(calc(12 * 1px)); }")).toEqual([
      "1: calc(12 * 1px)",
    ]);
    expect(literalViolations(".x { width: calc(13.5 * 1px); }")).toEqual(["1: calc(13.5 * 1px)"]);
    // A TOKEN times 1px is the kit's normal unit conversion (`--m-…-size: 6` → 6px).
    expect(literalViolations(".x { width: calc(var(--m-x) * 1px); }")).toEqual([]);
  });

  test("the kit's approximations are named, narrow, and each is in the CSS", () => {
    // The exemption is a published list, not an inline "it's fine" comment.
    for (const a of APPROXIMATIONS) {
      expect(a.why.length).toBeGreaterThan(0);
      expect(kit["kit.css"]).toContain(`${a.declaration};`);
    }
    // Narrow: the same declaration with a different number is NOT exempt (a
    // prefix/loose match would let the next agent pick any blur).
    expect(literalViolations("  backdrop-filter: blur(calc(14 * 1px)) saturate(1.4);")).toEqual([
      "1: calc(14 * 1px)",
    ]);
    expect(literalViolations("  backdrop-filter: blur(calc(12 * 1px));")).toEqual([
      "1: calc(12 * 1px)",
    ]);
    // And an unused entry is dead weight, so the list stays honest.
    const css = kit["kit.css"];
    expect(APPROXIMATIONS.filter((a) => !css.includes(`${a.declaration};`))).toEqual([]);
  });
});

describe("drift: committed tools/mockup-kit/generated/* === regenerated from source", () => {
  test("no drift", () => {
    expect(firstDiff(committed, fresh)).toBeNull();
  });

  test("non-vacuity: one changed hex in the theme is caught, naming the var and the fix", () => {
    const changed = {
      ...input,
      palettes: { ...input.palettes, light: { ...input.palettes.light, red: "#123456" } },
    };
    const diff = firstDiff(committed, formatAll(generate(changed)));
    expect(diff).toContain("--c-red: #123456");
    expect(diff).toContain("run: bun run mockup-kit");
  });
});

describe("inline: a self-contained, stamped snapshot", () => {
  const read = (p: string) => readFileSync(p);
  const html = inlineHtml(kitIndex, KIT_DIR, read, "abc123");

  test("no href/src/import/url() points outside the file, and the sha is stamped", () => {
    expect(html).toContain('<meta name="mockup-kit" content="abc123">');
    expect(html.match(/(?:href|src)=["'](?!data:|#|https?:)[^"']+["']/g)).toBeNull();
    expect(html.match(/\bfrom\s*["'](?!data:)[^"']+["']/g)).toBeNull();
    expect(html.match(/url\(\s*["']?(?!data:)[^"')]+/g)).toBeNull();
    expect(html).toContain("font/ttf;base64,");
  });

  test("the inlined kit module carries its data (no JSON import left)", () => {
    const mod = /from "data:text\/javascript;base64,([^"]+)"/.exec(html)?.[1] ?? "";
    const js = Buffer.from(mod, "base64").toString("utf8");
    expect(js).toContain("const data = {");
    expect(js).not.toContain("kit-data.json");
  });

  test("a missing referenced file fails loudly", () => {
    expect(() =>
      inlineHtml('<link rel="stylesheet" href="nope.css">', KIT_DIR, read, "x"),
    ).toThrow();
  });
});

describe("the composer's faces: circles, not bare glyphs (owner 23/11)", () => {
  type Composer = (p?: Record<string, unknown>) => { html: string };
  const row = (html: string): string => html.slice(html.indexOf('<div class="k-composer-row">'));

  test("+ and the mic are filled `k-circle`s holding the SF Symbols", async () => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    const html = row((K.composer as Composer)({ state: "empty" }).html);
    // The defect was exactly this: `<span class="k-hit">+</span>` and a 🎙︎ emoji.
    expect(html).not.toContain("🎙");
    expect(html).toMatch(/<span class="k-hit"><span class="k-circle"><svg class="k-sym"/);
    expect(html.match(/class="k-circle"/g)?.length).toBe(2);
    expect(html).toContain('<path d="M10 2.6v14.8M2.6 10h14.8"'); // plus
    expect(html).toContain('rx="3"'); // the mic capsule
  });

  test("the four slot faces differ: ready, up-dim, stop, clock", async () => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    const composer = K.composer as Composer;
    const face = (p: Record<string, unknown>): string =>
      row(composer(p).html).slice(row(composer(p).html).indexOf('<span class="k-slot"'));
    // ready: the ↑ alone in a soft-strong circle (its `k-slot` carries no data-*).
    expect(face({ state: "ready" })).toMatch(/^<span class="k-slot"><svg class="k-sym" width="18"/);
    // up-dim (empty): the ↑ wrapped in a dimmed `k-dim`, no circle painted.
    expect(face({ state: "empty" })).toContain(
      '<span class="k-slot" data-dim><span class="k-dim">',
    );
    // stop: a square in the slot's own circle.
    expect(face({ state: "draft", slot: "stop" })).toContain('<span class="k-slot" data-stop>');
    // clock (send later): the clock symbol, 17 pt.
    expect(face({ state: "draft", slot: "later" })).toContain('<span class="k-slot" data-clock>');
    expect(face({ state: "draft", slot: "later" })).toMatch(/width="17"/);
  });

  test("listening is a strong circle with a ■, finalizing an arc — no filled disc of text", async () => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    const html = (K.composer as Composer)({ state: "dictating" }).html;
    expect(html).toContain('<span class="k-circle" data-strong>');
    expect(html).toContain('<span class="k-rec-square"></span>');
    expect((K.composer as Composer)({ state: "transcribing" }).html).toContain("k-arc");
  });

  test("the circle is painted `accentSoft`, the symbol `accent` (Composer.tsx:257)", async () => {
    // The markup alone is not the fix: a `k-circle` with no fill is still a bare
    // glyph in a box. The look has to say it too.
    const circle = kit["kit.css"].slice(kit["kit.css"].indexOf(".k-circle {"));
    const body = circle.slice(0, circle.indexOf("}"));
    expect(body).toContain("background: var(--c-accent-soft)");
    expect(body).toContain("color: var(--c-accent)");
    expect(kit["kit.css"]).toContain(
      ".k-circle[data-strong] {\n  background: var(--c-accent-soft-strong);",
    );
    // Both are real tokens (the defined-vars test covers the rest).
    const tokens = committed["tokens.css"];
    expect(tokens).toContain("--c-accent-soft:");
    expect(tokens).toContain("--c-accent-soft-strong:");
  });

  test("`caption` and `K.composerParts` reuse the same markup, and an unknown symbol throws", async () => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    const composer = K.composer as Composer;
    const captioned = composer({ state: "dictating", caption: "0:03" }).html;
    expect(captioned).toContain('<span class="k-mic-caption">0:03</span>');
    const parts = K.composerParts as { plus: string; mic: Record<string, string> };
    expect(parts.plus).toContain('class="k-circle"');
    expect(parts.mic.idle).toContain('class="k-circle"');
    expect(() => (K.icon as (n: string) => unknown)("bogus")).toThrow('K.icon: no symbol "bogus"');
  });
});

describe("Polpetto is the app's own frame, not a redrawing", () => {
  type Polpetto = (p?: { frame?: string; inset?: number }) => { html: string };
  const rectsIn = (html: string) =>
    [
      ...html.matchAll(
        /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)" fill="([^"]+)" opacity="([\d.]+)"/g,
      ),
    ].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
      w: Number(m[3]),
      h: Number(m[4]),
      color: m[5],
      alpha: Number(m[6]),
    }));

  test("the still frame's rects are `pixels(stillFrame())` in the `mint` palette", async () => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    const { HOME_INSET_PT, SPRITE_PT, colorsFor, pixels, stillFrame } = await import(
      "../../apps/mobile/src/mascot-scenes.ts"
    );
    const geometry = { width: SPRITE_PT, height: SPRITE_PT + HOME_INSET_PT };
    const app = pixels(stillFrame(), geometry, colorsFor("mint"));
    const kit = rectsIn((K.polpetto as Polpetto)({ frame: "still" }).html);
    // Same rects, same order, same colours: `K.polpetto` only shifts x by the
    // frame's own left overhang (the geometry's home is (0, 0), so x0 is 0 here).
    expect(kit).toEqual(app.map((r) => ({ ...r })));
    expect(kit.length).toBe(34);
  });

  test("every frame sits `HOME_INSET_PT` above the band's bottom, nothing clipped", async () => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    const { HOME_INSET_PT, SPRITE_PT } = await import("../../apps/mobile/src/mascot-scenes.ts");
    for (const frame of ["still", "skate"]) {
      const html = (K.polpetto as Polpetto)({ frame }).html;
      const [, w, h] = /<svg width="([\d.]+)" height="([\d.]+)"/.exec(html) ?? [];
      const rects = rectsIn(html);
      expect(rects.length).toBeGreaterThan(0);
      // Nothing is cut off: each rect lies inside the box the svg declares.
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(Number(w));
        expect(r.y + r.h).toBeLessThanOrEqual(Number(h));
      }
      // A sprite taller than the box (a prop above the head) is lifted by exactly
      // its overhang, so the sprite's own bottom stays on the inset.
      expect(Number(h)).toBeGreaterThanOrEqual(SPRITE_PT);
      const bottom = Number(/bottom:([\d.-]+)px/.exec(html)?.[1]);
      expect(bottom + (Number(h) - SPRITE_PT)).toBe(HOME_INSET_PT);
    }
  });

  test("an unknown frame throws, naming the two that exist", async () => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    expect(() => (K.polpetto as Polpetto)({ frame: "swim" })).toThrow(
      'K.polpetto: no frame "swim" (still | skate)',
    );
  });
});

describe("kit.js pure builders run without a DOM", () => {
  test("states come from the generated view-models; unknown states throw", async () => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    const thought = (K.thoughtRow as (p: { ms: number }) => { html: string })({ ms: 12000 });
    expect(thought.html).toContain("· 12 s");
    expect(() => (K.stepNode as (p: { node: string }) => unknown)({ node: "bogus" })).toThrow(
      "unknown node",
    );
    const nuovo = K.extend("chip", () => ({ html: "<b>x</b>", a11y: "x" }))({});
    expect(nuovo.html).toContain('data-nuovo="chip"');
  });
});

/**
 * docs/feat/mobile-composer-compact.md (owner OD1–OD3, D3/D4): the app's resting
 * composer is ONE row, so the kit must be able to draw it — same body, the input
 * first, the `+` out of flow, no dead ↑, and no hint beside the ⇥ pill.
 */
describe("the composer's compact (resting) shape", () => {
  type Composer = (p?: Record<string, unknown>) => { html: string };
  const body = async (p: Record<string, unknown>): Promise<string> => {
    const { K } = await import("../../tools/mockup-kit/kit.js");
    const html = (K.composer as Composer)(p).html;
    return html.slice(html.indexOf('<div class="k-composer-row"'));
  };

  test("one row: the input is the body's FIRST child, `+` absolute, no dead ↑ (OD2)", async () => {
    const rest = await body({ compact: true });
    expect(rest).toContain('<div class="k-composer-row" data-compact>');
    expect(rest.indexOf('<div class="k-input"')).toBeLessThan(rest.indexOf('<span class="k-hit"'));
    expect(rest).toContain('<span class="k-hit" data-abs>');
    // The dimmed ↑ that did nothing is simply not drawn.
    expect(rest).not.toContain("k-slot");
  });

  test("■ Stop is an ACTION: it sits on the closed row (D3), ↑ and the clock too", async () => {
    expect(await body({ compact: true, slot: "stop" })).toContain(
      '<span class="k-slot" data-stop>',
    );
    expect(await body({ compact: true, slot: "later" })).toContain(
      '<span class="k-slot" data-clock>',
    );
  });

  test("the ⇥ pill keeps the right side and the hint goes (D4)", async () => {
    const pill = await body({ compact: true, sendNow: true });
    expect(pill).toContain('class="k-send-now"');
    expect(pill).toContain('<div class="k-input" data-empty></div>');
    // Without the pill the hint stays: the resting row says what the field is for.
    expect(await body({ compact: true })).toContain(
      '<div class="k-input" data-empty>Message tentacle</div>',
    );
  });

  test("the open shape is untouched: hint, dimmed ↑, the `+` in flow", async () => {
    const open = await body({ state: "empty" });
    expect(open).not.toContain("data-compact");
    expect(open).not.toContain("data-abs");
    expect(open).toContain('<div class="k-input" data-empty>Message tentacle</div>');
    expect(open).toContain('<span class="k-slot" data-dim>');
  });

  test("the body's CSS is the app's: column gap only, the compact line, the absolute `+`", async () => {
    const css = kit["kit.css"];
    const rule = (sel: string): string => {
      const at = css.indexOf(`${sel} {`);
      expect(at).toBeGreaterThan(0);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".k-composer-row")).toContain("flex-wrap: wrap");
    expect(rule(".k-composer-row")).toContain("gap: 0 var(--m-composer-row-gap)");
    expect(rule(".k-composer-row[data-compact]")).toContain("height: var(--m-composer-row-height)");
    expect(rule(".k-composer-row[data-compact] .k-input")).toContain(
      "margin-left: var(--m-composer-input-compact-margin-left)",
    );
    expect(rule(".k-composer-row[data-compact] .k-hit[data-abs]")).toContain("position: absolute");
    // The two drifts the mockup reported: `palette.tint` and `typography.caption`.
    const pill = rule(".k-send-now");
    expect(pill).toContain("background: var(--c-tint)");
    expect(pill).toContain("var(--t-caption-size)");
    expect(pill).not.toContain("--c-accent-soft");
    expect(pill).not.toContain("--t-footnote-size");
  });
});
