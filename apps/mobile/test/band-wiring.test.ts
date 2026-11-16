/**
 * S3 of docs/feat/mobile-chrome.md — the band primitives (E2): `BandSection`,
 * the E2 `Row`, the restyled `Sheet`, and the `row-value.ts` seam they read.
 *
 * The primitives are `.tsx` (unimportable from Bun: React Native's sources are
 * Flow), so this pins the look contract from the source, like
 * `header-wiring.test.ts`. Every assertion is a property of Design 4 / the
 * mockup's `infoE2` (`index.html:386-402`), not a formatting detail:
 *  - ONE full-width band per section, square, hairline top AND bottom, no margin;
 *  - a small uppercase 12 pt label, inset to the row's own gutter, `sectionTop`
 *    above and 6 pt below, an optional footnote under the band;
 *  - the row is full-width with a 20 pt gutter, `size.rowList` tall, a hairline
 *    BETWEEN rows (never after the last one), the label never truncated
 *    (`flexShrink: 0`), the value right-aligned with the per-kind ellipsis;
 *  - the status dot comes BEFORE the label, a description UNDER it, a switch
 *    top-aligned (it must not float mid-paragraph at large type);
 *  - the sheet: 14 pt corners, the `bandOnSheet` ground, an 18 pt close glyph;
 *  - no colour is hard-coded: every surface comes from the palette (AGENTS §6).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rowLayout, valueEllipsis } from "../src/row-value.ts";

const APP = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(APP, ...p), "utf8");

const BAND = read("src", "ui", "BandSection.tsx");
const ROW = read("src", "ui", "Row.tsx");
const SHEET = read("src", "ui", "Sheet.tsx");
const THEME = read("src", "theme.ts");

/** A source with its comment lines removed (prose names things the code must not). */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

describe("S3 · `BandSection`: one full-width band per section (E2)", () => {
  test("the band is full-width: no horizontal margin, no side inset", () => {
    const band = code(BAND);
    // E2's whole point vs the old card: the surface reaches both screen edges.
    expect(band).not.toMatch(/marginHorizontal/);
    expect(band).not.toMatch(/marginLeft|marginRight/);
  });

  test("square corners come from `radius.card`, not from a number in the component", () => {
    // `radius.card` is 0 since S1; reading the token (not writing 0) is what keeps
    // the band and `theme.test.ts`'s "only band primitives read it" guard agreeing.
    const band = code(BAND);
    expect(band).toMatch(/radius\.card/);
    expect(band).not.toMatch(/borderRadius:\s*\d/);
  });

  test("a hairline on the band's top AND bottom edges, from the palette", () => {
    const band = code(BAND);
    expect(band).toMatch(/borderTopWidth/);
    expect(band).toMatch(/borderBottomWidth/);
    expect(band).toMatch(/hairlineWidth/);
    // The sheet's edge colour on a sheet, the list's otherwise (Design 4).
    expect(band).toMatch(/palette\.sepSheet/);
    expect(band).toMatch(/palette\.sep\b/);
  });

  test("the label is small, uppercase, tracked, and inset to the row gutter", () => {
    const band = code(BAND);
    expect(band).toMatch(/smallLabel|typography\.caption/);
    expect(band).toMatch(/textTransform: "uppercase"/);
    expect(band).toMatch(/letterSpacing/);
    // 12 pt (Design 4) and the row's own 20 pt gutter — the label aligns with the
    // labels below it, which is the mockup's `q()` (`padding: … 20px`).
    const label = band.slice(band.indexOf("label"), band.indexOf("label") + 900);
    expect(label).toMatch(/space\.rowX/);
    expect(label).toMatch(/space\.sectionTop/);
    expect(label).toMatch(/paddingBottom: 6|marginBottom: 6/);
  });

  test("a section's footnote is drawn under the band, in `sec`", () => {
    const band = code(BAND);
    expect(band).toMatch(/footnote\?:/);
    expect(band).toMatch(/palette\.sec/);
  });

  test("the sheet variant swaps BOTH surfaces: the ground and the band", () => {
    // Design 4: inside a sheet the ground becomes `page` and the band
    // `bandOnSheet`, so the band still reads one step above what it sits on.
    // `Sheet` owns the ground; `BandSection` owns the band — both must switch.
    const band = code(BAND);
    expect(band).toMatch(/bandOnSheet/);
    expect(band).toMatch(/onSheet/);
  });
});

describe("S3 · the E2 `Row` (Design 4)", () => {
  test("full-width, 20 pt gutter, `size.rowList` —— no card radius left", () => {
    const row = code(ROW);
    expect(row).toMatch(/space\.rowX/);
    expect(row).toMatch(/size\.rowList|SIZE\.rowList/);
    // The old row was inset by the card and separated at 16/60 pt.
    expect(row).not.toMatch(/space\.cardInner/);
    expect(row).not.toMatch(/space\.separatorPlain|space\.separatorAfterTile/);
  });

  test("the hairline sits BETWEEN rows, inset to the gutter, and never after the last", () => {
    const row = code(ROW);
    // The separator is the row's TOP edge, suppressed on the first row of a band;
    // that is what makes it a line BETWEEN rows and leaves the last row (and the
    // band's own bottom hairline) as the section's only closing edge.
    expect(row).toMatch(/{first \? null : \(/);
    expect(row).toMatch(/hairlineWidth/);
    const separator = row.slice(row.indexOf("separator"), row.indexOf("separator") + 600);
    expect(separator).toMatch(/space\.rowX/);
    // No bottom-edge separator: `last` needs no prop at all, which is the point.
    expect(row).not.toMatch(/last\?:/);
  });

  test("the label never truncates; the value does (its own ellipsis)", () => {
    const row = code(ROW);
    // Design 4 / F10: the label WRAPS (it never truncates), the value ellipsises.
    // "Never truncated" is achieved by not capping its lines — NOT by refusing to
    // shrink: a label column with `flexShrink: 0` takes its measured width and
    // pushes the chevron/switch past the row's edge (fix round 1, finding 1:
    // Yoga, 390 pt row, 80-char title, chevron right edge 396).
    expect(row).not.toMatch(/numberOfLines=\{2\}/);
    expect(row).not.toMatch(/flexShrink: 0/);
    // The label's own <Text> carries no line cap at all (the value's `{1}` is its
    // ellipsis, and it renders exactly once — pinned by the test below).
    const labelText = row.slice(row.indexOf("{title}") - 400, row.indexOf("{title}"));
    expect(labelText).toContain("maxFontSizeMultiplier");
    expect(labelText).not.toContain("numberOfLines");
    // The value's ellipsis is decided by the pure helper, per kind.
    expect(row).toMatch(/valueEllipsis\(/);
    expect(row).toMatch(/ellipsizeMode=/);
    expect(row).toMatch(/numberOfLines=\{1\}/);
    // Every kind the helper knows renders (a kind with no mode would throw at
    // runtime, in a file Bun cannot import — so the mapping is asserted here).
    expect(valueEllipsis("path")).toBe("head");
  });

  test("the label is capped ONLY while a value shares the row", () => {
    // A `maxWidth: "70%"` on the label's base style would hold a value-less row's
    // label to 70% of the band for no reason — the cap exists to give the VALUE
    // room, so it is applied on that branch alone. Since fix round 1 the branch is
    // the pure `labelSizing`, so the component maps the three cases and the cap
    // style itself carries no `flex` that would re-take the row.
    const row = code(ROW);
    expect(row).toMatch(/layout\.labelSizing === "capped" \? styles\.textCapped : null/);
    expect(row).toMatch(/layout\.labelSizing === "fill" \? styles\.textFill : null/);
    expect(row).toMatch(/layout\.labelSizing === "stacked" \? styles\.textStacked : null/);
    const base = row.split("\n").find((line) => line.trimStart().startsWith("text: {")) ?? "";
    expect(base).not.toBe("");
    expect(base).not.toMatch(/maxWidth/);
    expect(base).not.toMatch(/flex: 1/);
    // The three sizing styles must carry the actual geometry: mutation M2 (a
    // `textFill` that exists but does not `flex: 1`) left every test green, and
    // Yoga then leaves the value-less label at its MEASURED width — the overflow
    // again, just spelled differently.
    expect(row).toMatch(/textFill: \{ flex: 1 \}/);
    expect(row).toMatch(/textCapped: \{ flexShrink: 1, maxWidth: "70%" \}/);
    // Stacked, the label owns the row: a 70% cap left over from the beside case
    // would squeeze it while the value sits under it (mutation M8).
    expect(row).toMatch(/textStacked: \{ flex: 1, maxWidth: "100%" \}/);
  });

  test("the value is drawn EXACTLY once, and on the line `rowLayout` chose", () => {
    // F10's whole payoff is the second line: the value must move between the label
    // column and the row's trailing edge, not merely be allowed to. Both branches
    // are pinned as a pair, so dropping either loses the value (mutation 16) or
    // draws it twice.
    const row = code(ROW);
    expect(row).toMatch(/\{layout\.valueFullWidth \? valueText : null\}/);
    expect(row).toMatch(/\{layout\.valueFullWidth \? null : valueText\}/);
    // One element definition, two placements: a second `<Text>` copy would drift.
    expect(row.split("ellipsizeMode").length - 1).toBe(1);
  });

  test("the value right-aligns, and follows `rowLayout` at large type (F10)", () => {
    const row = code(ROW);
    expect(row).toMatch(/textAlign: layout\.valueAlign/);
    // The alignment itself is the pure decision, so it is asserted there (the
    // component can only pass it through).
    expect(rowLayout(1).valueAlign).toBe("right");
    expect(rowLayout(2).valueAlign).toBe("right");
    // Design 4's wrap rule is the pure module's, not a constant in the component.
    expect(row).toMatch(/rowLayout\(/);
    expect(row).toMatch(/useWindowDimensions\(\)/);
    expect(row).toMatch(/fontScale/);
    // The font scale decides it, and nothing in the component re-derives it.
    expect(row).not.toMatch(/1\.4/);
  });

  test("the status dot comes BEFORE the label, a description UNDER it", () => {
    // Scoped to the returned JSX: the import line mentions `StatusDot` too, so a
    // whole-file `indexOf` would pass with the dot moved anywhere (found by
    // mutation 11). The mockup's `r()` puts the dot inside the label's own run,
    // which in this horizontal row means "before it" (Design 4).
    const jsx = code(ROW).slice(code(ROW).indexOf("return ("), code(ROW).indexOf("const styles"));
    const dotAt = jsx.indexOf("<StatusDot");
    const titleAt = jsx.indexOf("{title}");
    expect(dotAt).toBeGreaterThan(-1);
    expect(titleAt).toBeGreaterThan(-1);
    expect(dotAt).toBeLessThan(titleAt);
    // `StatusDot` is the one dot primitive; a row that drew its own would drift
    // from the Computers/Session-info look.
    expect(jsx).toContain("<StatusDot palette={palette} tone={dot} size={7} />");
    // The description (Auto-accept's subtitle) is inside the label's own column,
    // i.e. under the title rather than beside it (Design 4).
    const subtitleAt = jsx.indexOf("{subtitle}");
    expect(subtitleAt).toBeGreaterThan(titleAt);
  });

  test("a switch is top-aligned so it never floats mid-paragraph at large type", () => {
    const row = code(ROW);
    // The alignment is the pure decision (`controlAlign`), applied to the row.
    expect(row).toMatch(/layout\.controlAlign/);
    expect(row).toMatch(/flex-start/);
    // And the decision itself top-aligns a described row at any size (F10).
    expect(rowLayout(1, { description: true }).controlAlign).toBe("top");
    expect(rowLayout(1, { description: false }).controlAlign).toBe("center");
  });

  test("no colour is hard-coded in the row (tokens are the single source)", () => {
    expect(code(ROW)).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(code(BAND)).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });
});

describe("S3 · the restyled `Sheet` (Design 4)", () => {
  test("14 pt corners from `radius.sheet`, the `bandOnSheet` ground", () => {
    const sheet = code(SHEET);
    expect(sheet).toMatch(/radius\.sheet/);
    // A FULL sheet is the banded ground (`bg`); a floating one is a card
    // (`sheet`), so both tokens appear and neither is a hard-coded colour.
    expect(sheet).toMatch(/palette\.bg/);
    expect(sheet).toMatch(/palette\.sheet/);
    // No numeric radius at all: a `radius: 38` (or a `borderTopLeftRadius: 38`)
    // would slip past a `toMatch(/radius:\s*\d/)` (mutation 14).
    expect(sheet).not.toMatch(/[Rr]adius:\s*\d/);
    expect(sheet).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  test("an 18 pt close glyph, labelled, drawn only when a close handler is given", () => {
    const sheet = code(SHEET);
    // Invariant props would be invisible to a `toMatch(/accessibilityLabel/)`
    // (mutation 13), so the guard, the size and a NON-EMPTY label are pinned.
    expect(sheet).toMatch(/onClose === undefined \? null : \(/);
    expect(sheet).toMatch(/onClose\?:/);
    expect(sheet).toMatch(/name="xmark"/);
    expect(sheet).toMatch(/size=\{18\}/);
    expect(sheet).toMatch(/accessibilityLabel="Close"/);
    expect(sheet).toMatch(/accessibilityRole="button"/);
  });
});

describe("S3 · the row tokens the primitives read exist (S1 landed them)", () => {
  test("`rowX`, `sectionTop`, `rowList`, `band`, `bandOnSheet`, `radius.sheet`", () => {
    expect(THEME).toMatch(/rowX: 20/);
    expect(THEME).toMatch(/sectionTop: 22/);
    expect(THEME).toMatch(/rowList: 50/);
    expect(THEME).toMatch(/readonly band: string/);
    expect(THEME).toMatch(/readonly bandOnSheet: string/);
    expect(THEME).toMatch(/sheet: 14/);
  });
});
