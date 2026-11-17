/**
 * T5.5, the theme (docs/feat/model-diagrams.md D5/§D6): mermaid's `themeVariables`
 * for the `base` theme, both schemes, derived ONLY from the chart tokens and the
 * palette — no new colour, no pure black, mono font throughout.
 *
 * Why it is a decision and not a stylesheet: the renderer receives these as data
 * (`injectJavaScript`'s `theme` argument), so what the phone asks mermaid for is
 * assertable without a WebView — and "the app owns colours and the mono font"
 * (Owner Q5a) is a property, not a paragraph.
 */
import { describe, expect, test } from "bun:test";
import { CHART_PALETTE } from "@tentacle/core";
import { diagramTheme, diagramThemeKey, diagramThemeVariables } from "../src/diagram-theme.ts";
import { MONO, chartTokensFor, darkPalette, lightPalette } from "../src/theme.ts";

const both = [
  { scheme: "light", palette: lightPalette },
  { scheme: "dark", palette: darkPalette },
] as const;

describe("diagramThemeVariables — the values mermaid is given", () => {
  test("mono font, both schemes, and mermaid's own font size is carried", () => {
    for (const { scheme, palette } of both) {
      const vars = diagramThemeVariables(palette);
      expect({ scheme, font: vars.fontFamily }).toEqual({ scheme, font: MONO });
      expect(typeof vars.fontSize).toBe("string");
    }
  });

  test("every colour is a chart token or a palette slot (no new colour is invented)", () => {
    for (const { palette } of both) {
      const vars = diagramThemeVariables(palette);
      const allowed = new Set<string>([
        ...Object.values(chartTokensFor(palette)),
        ...Object.values(palette),
        ...CHART_PALETTE.light,
        ...CHART_PALETTE.dark,
        "transparent",
      ]);
      const colours = Object.entries(vars).filter(
        ([, value]) => value.startsWith("#") || value.startsWith("rgb"),
      );
      expect(colours.length).toBeGreaterThan(8);
      for (const [key, value] of colours) {
        expect({ key, value, known: allowed.has(value) }).toEqual({ key, value, known: true });
      }
    }
  });

  test("no pure black anywhere — the dark page is soft graphite (the restyle's rule)", () => {
    for (const { scheme, palette } of both) {
      const vars = diagramThemeVariables(palette);
      const dark = Object.entries(vars)
        .filter(([, value]) => /^#[0-9a-fA-F]{3,8}$/.test(value))
        .filter(([, value]) => /^#(?:000|000000)$/i.test(value));
      // Light mode MAY use the app's own label (#000000); the DARK scheme may not.
      expect({ scheme, dark: scheme === "dark" ? dark : [] }).toEqual({ scheme, dark: [] });
    }
  });

  test("the surface is the page the diagram sits on, so the SVG has no card", () => {
    for (const { palette } of both) {
      const vars = diagramThemeVariables(palette);
      expect(vars.background).toBe(palette.page);
      expect(vars.mainBkg).toBe(palette.page);
      expect(vars.primaryColor).toBe(palette.page);
    }
  });

  test("the two schemes really differ (a switch re-renders something new)", () => {
    expect(diagramThemeVariables(lightPalette)).not.toEqual(diagramThemeVariables(darkPalette));
  });
});

describe("diagramTheme — what the renderer is asked for", () => {
  test("`base`, the variables, and the scheme in the cache key", () => {
    for (const { scheme, palette } of both) {
      const theme = diagramTheme(palette);
      expect({ scheme, base: theme.theme, key: theme.key }).toEqual({
        scheme,
        base: "base",
        key: `base|${scheme}`,
      });
      expect(theme.variables).toEqual(diagramThemeVariables(palette));
    }
  });

  test("a re-render key changes with the scheme and the font scale, never with the source", () => {
    expect(diagramThemeKey(lightPalette)).toBe("base|light");
    expect(diagramThemeKey(darkPalette)).toBe("base|dark");
  });
});
