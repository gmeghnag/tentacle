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
    expect(root.get("--ms-step-spinner-turn")).toBe("900ms");
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
