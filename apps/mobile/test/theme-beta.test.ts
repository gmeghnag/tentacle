/**
 * The Lato try-out theme (docs/feat/mobile-theme-beta.md): which palette and
 * which font a Beta switch + a colour scheme give, and how a text's own style
 * becomes a Lato face. Pure — `theme-beta.ts` decides, the components consume.
 */
import { describe, expect, test } from "bun:test";
import { chartScheme } from "../src/chart-row.ts";
import { diagramCacheKey } from "../src/diagram-cache.ts";
import {
  DEFAULT_THEME_BETA,
  LATO_FACES,
  latoFace,
  paletteVariant,
  textFont,
  themeFor,
} from "../src/theme-beta.ts";
import {
  MONO,
  chartTokensFor,
  darkPalette,
  graphitePalette,
  isDark,
  lightPalette,
  paletteFor,
} from "../src/theme.ts";

const OFF = { lato: false } as const;
const ON = { lato: true } as const;

describe("switch OFF = exactly today's look", () => {
  test("the default is OFF", () => {
    expect(DEFAULT_THEME_BETA).toEqual(OFF);
  });

  test("every scheme gets today's palette — the same object, every token equal — and no font", () => {
    for (const scheme of ["light", "dark", null, undefined] as const) {
      for (const ready of [false, true]) {
        const theme = themeFor(scheme, OFF, ready);
        expect(theme.palette).toBe(paletteFor(scheme));
        expect({ ...theme.palette }).toEqual({ ...paletteFor(scheme) });
        expect(theme.font).toBeNull();
      }
    }
  });
});

describe("switch ON", () => {
  test("dark: the graphite palette; light: today's light palette", () => {
    expect(themeFor("dark", ON, true).palette).toBe(graphitePalette);
    expect(themeFor("light", ON, true).palette).toBe(lightPalette);
    expect(themeFor(null, ON, true).palette).toBe(lightPalette);
  });

  test("the font is Lato only once the faces are loaded (never an unregistered family)", () => {
    expect(themeFor("dark", ON, false).font).toBeNull();
    expect(themeFor("dark", ON, true).font).toBe("lato");
    expect(themeFor("light", ON, true).font).toBe("lato");
  });

  test("the owner's reference hexes: page #1A1D21, text #D1D2D3, secondary #ABABAD", () => {
    expect(graphitePalette.page).toBe("#1A1D21");
    expect(graphitePalette.bg).toBe("#1A1D21");
    expect(graphitePalette.label).toBe("#D1D2D3");
    expect(graphitePalette.sec).toBe("#ABABAD");
    expect(graphitePalette.sepChat).toBe("#2C2D30");
  });

  test("accents and semantic colours are unchanged", () => {
    const keep = [
      "accent",
      "accentFill",
      "onAccent",
      "tint",
      "green",
      "orange",
      "red",
      "warnBg",
      "warnText",
      "kw",
      "addBg",
      "addStrong",
      "addText",
      "delBg",
      "delStrong",
      "delText",
      "camera",
      "cameraAccent",
      "shadowOpacity",
    ] as const;
    for (const key of keep) {
      expect(graphitePalette[key]).toBe(darkPalette[key]);
    }
  });

  test("graphite is a dark palette everywhere a component asks", () => {
    expect(isDark(graphitePalette)).toBe(true);
    expect(chartScheme(graphitePalette)).toBe("dark");
    expect(chartTokensFor(graphitePalette).guide).toBe(chartTokensFor(darkPalette).guide);
    expect(chartTokensFor(graphitePalette).surface).toBe("#1A1D21");
  });

  test("a diagram rendered on graphite never reuses a render made for today's dark page", () => {
    expect(paletteVariant(darkPalette)).toBeUndefined();
    expect(paletteVariant(lightPalette)).toBeUndefined();
    expect(paletteVariant(graphitePalette)).toBe("graphite");
    const today = diagramCacheKey("graph TD; A-->B", "dark", 1, "outline");
    const graphite = diagramCacheKey("graph TD; A-->B", "dark", 1, "outline", "graphite");
    expect(graphite).not.toBe(today);
    // `undefined` keeps the key every existing render was stored under.
    expect(diagramCacheKey("graph TD; A-->B", "dark", 1, "outline", undefined)).toBe(today);
  });
});

describe("latoFace: a weight + style → one of the four bundled faces", () => {
  test("regular, bold, italic, bold italic", () => {
    expect(latoFace(undefined, undefined)).toBe(LATO_FACES.regular);
    expect(latoFace("700", undefined)).toBe(LATO_FACES.bold);
    expect(latoFace(undefined, "italic")).toBe(LATO_FACES.italic);
    expect(latoFace("bold", "italic")).toBe(LATO_FACES.boldItalic);
  });

  test("600 and up is Bold; 500 and below is Regular (Lato has no Medium/Semibold here)", () => {
    for (const w of ["600", "700", "800", "900", 600, 700, "bold", "semibold", "heavy", "black"]) {
      expect(latoFace(w, "normal")).toBe("Lato-Bold");
    }
    for (const w of ["100", "300", "400", "500", 400, 500, "normal", "medium", "light"]) {
      expect(latoFace(w, "normal")).toBe("Lato-Regular");
    }
  });
});

describe("textFont: a text's own style + what it inherits → its Lato patch", () => {
  test("font OFF: no patch, ever (today's text untouched)", () => {
    expect(textFont({ fontWeight: "700" }, {}, null).patch).toBeNull();
    expect(textFont({}, {}, null).patch).toBeNull();
  });

  test("a plain text gets Lato Regular, with a weight/style that resolves to that face", () => {
    expect(textFont({}, {}, "lato").patch).toEqual({
      fontFamily: "Lato-Regular",
      fontWeight: "400",
      fontStyle: "normal",
    });
    expect(textFont({ fontWeight: "600" }, {}, "lato").patch).toEqual({
      fontFamily: "Lato-Bold",
      fontWeight: "700",
      fontStyle: "normal",
    });
  });

  test("monospace (or any explicit family) is kept as it is", () => {
    expect(textFont({ fontFamily: MONO }, {}, "lato").patch).toBeNull();
    expect(textFont({ fontFamily: "Menlo", fontWeight: "700" }, {}, "lato").patch).toBeNull();
  });

  test("a nested span inherits its parent's weight, style and family (as RN Text does)", () => {
    const parent = textFont({ fontWeight: "700" }, {}, "lato");
    // A plain coloured span inside a bold title stays bold.
    expect(textFont({}, parent.inherit, "lato").patch?.fontFamily).toBe("Lato-Bold");
    // An italic span inside it: bold italic.
    expect(textFont({ fontStyle: "italic" }, parent.inherit, "lato").patch?.fontFamily).toBe(
      "Lato-BoldItalic",
    );
    // A span that sets its own weight back down wins over the parent.
    expect(textFont({ fontWeight: "400" }, parent.inherit, "lato").patch?.fontFamily).toBe(
      "Lato-Regular",
    );
    // Inside a monospace parent a plain span stays monospace (no Lato patch).
    const mono = textFont({ fontFamily: MONO }, {}, "lato");
    expect(textFont({}, mono.inherit, "lato").patch).toBeNull();
    // ...and a monospace span inside a Lato parent is monospace too.
    expect(textFont({ fontFamily: MONO }, parent.inherit, "lato").patch).toBeNull();
  });
});
