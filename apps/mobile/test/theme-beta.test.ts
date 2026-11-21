/**
 * The Figtree try-out theme (docs/feat/mobile-theme-beta.md): which palette and
 * which font a Beta switch + a colour scheme give, and how a text's own style
 * becomes a Figtree face. Pure — `theme-beta.ts` decides, the components consume.
 */
import { describe, expect, test } from "bun:test";
import { chartScheme } from "../src/chart-row.ts";
import { diagramCacheKey } from "../src/diagram-cache.ts";
import {
  DEFAULT_THEME_BETA,
  FIGTREE_FACES,
  figtreeFace,
  paletteVariant,
  textFont,
  themeFor,
} from "../src/theme-beta.ts";
import {
  MONO,
  chartTokensFor,
  darkPalette,
  isDark,
  lightPalette,
  paletteFor,
  petrolPalette,
} from "../src/theme.ts";

const OFF = { figtree: false } as const;
const ON = { figtree: true } as const;

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
  test("dark: the petrol palette; light: today's light palette", () => {
    expect(themeFor("dark", ON, true).palette).toBe(petrolPalette);
    expect(themeFor("light", ON, true).palette).toBe(lightPalette);
    expect(themeFor(null, ON, true).palette).toBe(lightPalette);
  });

  test("the font is Figtree only once the faces are loaded (never an unregistered family)", () => {
    expect(themeFor("dark", ON, false).font).toBeNull();
    expect(themeFor("dark", ON, true).font).toBe("figtree");
    expect(themeFor("light", ON, true).font).toBe("figtree");
  });

  test("the owner's variant B hexes (Owner decision 2026-11-21)", () => {
    expect(petrolPalette.page).toBe("#151B1D");
    expect(petrolPalette.bg).toBe("#151B1D");
    expect(petrolPalette.label).toBe("#D5DDDE");
    expect(petrolPalette.sec).toBe("#98A6A8");
    expect(petrolPalette.sepChat).toBe("#253033");
    // The raised fill: composer, sheets, code/tool rows.
    for (const key of ["card", "sheet", "bandOnSheet", "code"] as const) {
      expect(petrolPalette[key]).toBe("#1D2528");
    }
    expect(petrolPalette.accent).toBe("#22D3EE");
    // The chip/selection tint: rgba(34,211,238,.12) composited on the page.
    expect(petrolPalette.tint).toBe("#173136");
  });

  test("accents and semantic colours are unchanged", () => {
    const keep = [
      "accent",
      "accentFill",
      "onAccent",
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
      expect(petrolPalette[key]).toBe(darkPalette[key]);
    }
  });

  test("petrol is a dark palette everywhere a component asks", () => {
    expect(isDark(petrolPalette)).toBe(true);
    expect(chartScheme(petrolPalette)).toBe("dark");
    expect(chartTokensFor(petrolPalette).guide).toBe(chartTokensFor(darkPalette).guide);
    expect(chartTokensFor(petrolPalette).surface).toBe("#151B1D");
  });

  test("a diagram rendered on petrol never reuses a render made for today's dark page", () => {
    expect(paletteVariant(darkPalette)).toBeUndefined();
    expect(paletteVariant(lightPalette)).toBeUndefined();
    expect(paletteVariant(petrolPalette)).toBe("petrol");
    const today = diagramCacheKey("graph TD; A-->B", "dark", 1, "outline");
    const petrol = diagramCacheKey("graph TD; A-->B", "dark", 1, "outline", "petrol");
    expect(petrol).not.toBe(today);
    // `undefined` keeps the key every existing render was stored under.
    expect(diagramCacheKey("graph TD; A-->B", "dark", 1, "outline", undefined)).toBe(today);
  });
});

describe("figtreeFace: a weight + style → one of the four bundled faces", () => {
  test("the faces are the files' own PostScript names (read from their name tables)", () => {
    expect(FIGTREE_FACES).toEqual({
      regular: "Figtree-Regular",
      bold: "Figtree-Bold",
      italic: "Figtree-Italic",
      boldItalic: "Figtree-BoldItalic",
    });
  });

  test("regular, bold, italic, bold italic", () => {
    expect(figtreeFace(undefined, undefined)).toBe(FIGTREE_FACES.regular);
    expect(figtreeFace("700", undefined)).toBe(FIGTREE_FACES.bold);
    expect(figtreeFace(undefined, "italic")).toBe(FIGTREE_FACES.italic);
    expect(figtreeFace("bold", "italic")).toBe(FIGTREE_FACES.boldItalic);
  });

  test("600 and up is Bold; 500 and below is Regular (no Medium/Semibold bundled)", () => {
    for (const w of ["600", "700", "800", "900", 600, 700, "bold", "semibold", "heavy", "black"]) {
      expect(figtreeFace(w, "normal")).toBe("Figtree-Bold");
    }
    for (const w of ["100", "300", "400", "500", 400, 500, "normal", "medium", "light"]) {
      expect(figtreeFace(w, "normal")).toBe("Figtree-Regular");
    }
  });
});

describe("textFont: a text's own style + what it inherits → its Figtree patch", () => {
  test("font OFF: no patch, ever (today's text untouched)", () => {
    expect(textFont({ fontWeight: "700" }, {}, null).patch).toBeNull();
    expect(textFont({}, {}, null).patch).toBeNull();
  });

  test("a plain text gets Figtree Regular, with a weight/style that resolves to that face", () => {
    expect(textFont({}, {}, "figtree").patch).toEqual({
      fontFamily: "Figtree-Regular",
      fontWeight: "400",
      fontStyle: "normal",
    });
    expect(textFont({ fontWeight: "600" }, {}, "figtree").patch).toEqual({
      fontFamily: "Figtree-Bold",
      fontWeight: "700",
      fontStyle: "normal",
    });
  });

  test("monospace (or any explicit family) is kept as it is", () => {
    expect(textFont({ fontFamily: MONO }, {}, "figtree").patch).toBeNull();
    expect(textFont({ fontFamily: "Menlo", fontWeight: "700" }, {}, "figtree").patch).toBeNull();
  });

  test("a nested span inherits its parent's weight, style and family (as RN Text does)", () => {
    const parent = textFont({ fontWeight: "700" }, {}, "figtree");
    // A plain coloured span inside a bold title stays bold.
    expect(textFont({}, parent.inherit, "figtree").patch?.fontFamily).toBe("Figtree-Bold");
    // An italic span inside it: bold italic.
    expect(textFont({ fontStyle: "italic" }, parent.inherit, "figtree").patch?.fontFamily).toBe(
      "Figtree-BoldItalic",
    );
    // A span that sets its own weight back down wins over the parent.
    expect(textFont({ fontWeight: "400" }, parent.inherit, "figtree").patch?.fontFamily).toBe(
      "Figtree-Regular",
    );
    // Inside a monospace parent a plain span stays monospace (no Figtree patch).
    const mono = textFont({ fontFamily: MONO }, {}, "figtree");
    expect(textFont({}, mono.inherit, "figtree").patch).toBeNull();
    // ...and a monospace span inside a Figtree parent is monospace too.
    expect(textFont({ fontFamily: MONO }, parent.inherit, "figtree").patch).toBeNull();
  });
});
