/**
 * S4 of docs/feat/mobile-chrome.md — the five screens move to E2 bands
 * (`BandSection`) and the two old primitives (`GroupedCard`, `SectionHeader`) are
 * DELETED.
 *
 * Every screen is `.tsx` (unimportable from Bun: React Native's sources are Flow),
 * so — like `band-wiring.test.ts` / `header-wiring.test.ts` — this pins the
 * source's structure. Each assertion is a property of Design 4 or of the slice's
 * `done when` ("no import of the two deleted files; flows 24/25 green"), not a
 * formatting detail:
 *  - the two files are gone and nothing under `src` names them;
 *  - every section of the five screens is ONE `<BandSection>`, the section's note
 *    is the band's `footnote` (so it aligns to the band's 20 pt gutter), and no
 *    band gets a side margin back;
 *  - a band inside a sheet says so (`onSheet`) AND so does every row in it, so the
 *    hairline is the sheet's token (`sepSheet`), not the list's;
 *  - the trailing action rows ("Load more", the pair card) are standalone bands:
 *    their heading is the screen's own ("Pair a computer", nothing);
 *  - Session info's Auto-accept is the LAST ROW of the Session band (the mockup's
 *    `infoE2`, `index.html:394-397`), not a second band;
 *  - every testID a flow asserts survives the swap (`flows 24/25`, and the ids the
 *    other flows tap: `lock-delay-*`, `export-logs`, `computers-pair-card`, …).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(APP, ...parts), "utf8");

const SCREENS = [
  "SessionInfoSheet",
  "SettingsScreen",
  "ComputersScreen",
  "SessionsScreen",
  "PairScreen",
] as const;
const src = (name: string): string => read("src", "screens", `${name}.tsx`);
const ROW = read("src", "ui", "Row.tsx");
const BAND = read("src", "ui", "BandSection.tsx");
const THEME = read("src", "theme.ts");

/**
 * The JSX opening tags of `name` in `source`. Arrow functions are flattened first,
 * because `=>` contains the `>` a tag scan would otherwise stop at; that makes the
 * match the tag's real extent instead of a one-line window (a window would let a
 * neighbouring tag's prop answer for this one).
 */
const tags = (source: string, name: string): string[] =>
  [...source.replace(/=>/g, "⟶").matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);

/** Every `.tsx` under `src`, with its text (the "nothing names them any more" scan). */
const tsxSources = (): { file: string; text: string }[] =>
  readdirSync(join(APP, "src"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => ({ file: file.replaceAll("\\", "/"), text: read("src", file) }));
describe("S4 · the two old card primitives are deleted", () => {
  test("`GroupedCard.tsx` and `SectionHeader.tsx` no longer exist", () => {
    expect(existsSync(join(APP, "src", "ui", "GroupedCard.tsx"))).toBe(false);
    expect(existsSync(join(APP, "src", "ui", "SectionHeader.tsx"))).toBe(false);
  });

  test("nothing under `src` imports or renders either one", () => {
    // Scoped to CODE: `BandSection`'s own doc says what it replaced, and prose
    // naming a deleted primitive is how the next reader learns why it is gone.
    // An import path or a JSX tag is the real coupling.
    const users = tsxSources()
      .filter(({ text }) =>
        /ui\/(GroupedCard|SectionHeader)\.tsx|<(GroupedCard|SectionHeader)\b/.test(text),
      )
      .map(({ file }) => file);
    // The scan must be able to SEE a band, or a rename of the primitive retires
    // this guard silently (the lesson of mutation 3 in S1's review).
    const bands = tsxSources().filter(({ text }) => text.includes("<BandSection"));
    expect(bands.length).toBeGreaterThanOrEqual(SCREENS.length);
    expect(users).toEqual([]);
  });

  test("the band primitive left behind is the only band surface", () => {
    // `radius.card` is 0: a screen reaching for it would be silently sharpened.
    // `theme.test.ts` owns that scan; here it must still see a consumer.
    expect(tsxSources().filter(({ text }) => text.includes("radius.card")).length).toBeGreaterThan(
      0,
    );
  });
});

describe("S4 · each screen's sections are E2 bands", () => {
  for (const screen of SCREENS) {
    test(`${screen}: uses \`BandSection\`, never the two deleted primitives`, () => {
      const source = src(screen);
      expect(tags(source, "BandSection").length).toBeGreaterThan(0);
      expect(tags(source, "GroupedCard")).toEqual([]);
      expect(tags(source, "SectionHeader")).toEqual([]);
      expect(source).not.toMatch(/\.\.\/ui\/(GroupedCard|SectionHeader)\.tsx/);
    });

    test(`${screen}: every band takes the palette (no colour is hard-coded)`, () => {
      const bands = tags(src(screen), "BandSection");
      expect(bands.length).toBeGreaterThan(0);
      for (const tag of bands) {
        expect(tag).toContain("palette={palette}");
      }
    });
  }
});

describe("S4 · Settings · one band per section, the note under it", () => {
  const settings = src("SettingsScreen");

  test("the ten sections are bands, each with its own small label", () => {
    // S10 adds "Activity button" (docs/feat/mobile-chrome.md Design 6);
    // fix/mobile-media-live item 5 adds "Photos" (the send-at-original-size switch);
    // fix/mobile-qa-1117 adds "Diagrams" (outline | filled).
    const bands = tags(settings, "BandSection");
    expect(bands.length).toBe(10);
    for (const label of [
      "App lock",
      "Notifications",
      "Activity button",
      "Photos",
      "Diagrams",
      "Beta",
      "Read aloud",
      "Language",
      "Speaking rate",
      "Diagnostics",
    ]) {
      expect(bands.some((tag) => tag.includes(`title="${label}"`))).toBe(true);
    }
  });

  test("a section's note is the band's `footnote`, inset to the band's gutter", () => {
    // The band draws its footnote at `space.rowX` (20). A screen's own `<Text>`
    // at `inset + cardInner` (32) would sit 12 pt inside the label it explains.
    // Asserted per SECTION, not "some band has a footnote": with the `some()` this
    // started as, dropping ONE band's note left the other two answering for it
    // (mutation M3 survived).
    const bands = tags(settings, "BandSection");
    for (const note of [
      "How long tentacle may stay in the background",
      "Experimental features. They may not work well yet.",
      "Logs hold connection state, errors and timings",
    ]) {
      expect(bands.some((tag) => tag.includes("footnote=") && tag.includes(note))).toBe(true);
    }
    // And no section's note is a screen-level `<Text>` any more.
    expect(settings).not.toMatch(/styles\.footnote/);
  });

  test("the lock rows keep the testIDs flow 24 and the lock flows tap", () => {
    expect(settings).toContain("testID={`lock-delay-${row.value}`}");
    expect(settings).toContain('testID="lock-notice"');
    expect(settings).toContain('testID="export-logs"');
    expect(settings).toContain('testID="notifications-toggle"');
    expect(settings).toContain('testID="settings-back"');
  });
});

describe("S4 · Sessions · running/idle/archived, and the trailing Load more", () => {
  const sessions = src("SessionsScreen");

  test("a section is a titled band", () => {
    const bands = tags(sessions, "BandSection");
    expect(bands.some((tag) => tag.includes("title={title}"))).toBe(true);
  });

  test("the group wrappers the flows assert keep their testIDs", () => {
    expect(sessions).toContain('testID="section-active"');
    expect(sessions).toContain('testID="section-archived"');
    expect(sessions).toContain("testID={`session-${row.sessionId}`}");
  });

  test("`sessions-more` is a STANDALONE band: it has no label of its own", () => {
    const at = sessions.indexOf('testID="sessions-more"');
    expect(at).toBeGreaterThan(-1);
    // The band that holds it opens before it and must not carry a `title`.
    const before = sessions.slice(0, at);
    const open = before.lastIndexOf("<BandSection");
    expect(open).toBeGreaterThan(-1);
    const tag = before.slice(open, before.indexOf(">", open) + 1);
    expect(tag).toContain("<BandSection");
    expect(tag).not.toContain("title=");
  });
});

describe("S4 · Computers · a computer's own heading, then its band", () => {
  const computers = src("ComputersScreen");

  test("each computer's band stands alone (its name + status line is the heading)", () => {
    const at = computers.indexOf("testID={`computer-${row.id}`}");
    expect(at).toBeGreaterThan(-1);
    const before = computers.slice(0, at);
    const open = before.lastIndexOf("<BandSection");
    expect(open).toBeGreaterThan(-1);
    const tag = before.slice(open, before.indexOf(">", open) + 1);
    expect(tag).not.toContain("title=");
    // The heading itself is still drawn by the screen (the mockup's computer row).
    expect(computers).toContain('accessibilityRole="header"');
  });

  test("the pair card is a band with the hint as its footnote", () => {
    const bands = tags(computers, "BandSection");
    expect(bands.some((tag) => tag.includes("footnote="))).toBe(true);
    expect(computers).toContain('testID="computers-pair-card"');
    expect(computers).toContain('testID="computers-add"');
    expect(computers).toContain('testID="open-settings"');
  });
});

describe("S4 · Pair · the hero and the paste field are bands", () => {
  const pair = src("PairScreen");

  test("the paste section keeps its own label as the band's title", () => {
    const bands = tags(pair, "BandSection");
    expect(bands.length).toBe(2);
    expect(bands.some((tag) => tag.includes('title="Or paste the line it prints"'))).toBe(true);
  });

  test("the hero's band stands alone, and the field's testIDs survive", () => {
    expect(tags(pair, "BandSection").some((tag) => !tag.includes("title="))).toBe(true);
    expect(pair).toContain('testID="pair-paste-input"');
    expect(pair).toContain('testID="pair-paste-submit"');
    expect(pair).toContain('testID="pair-review"');
  });

  test("a band's content sits on the band's own 20 pt gutter", () => {
    // The hero and the paste block are band children now; `cardInner` (16) would
    // put them 4 pt off every row above/below them. Both blocks are pinned: with
    // only the hero asserted, the paste block's padding could drift back (M8).
    expect(pair).not.toMatch(/space\.cardInner/);
    expect(pair).toMatch(/hero: \{[^}]*padding: space\.rowX/);
    expect(pair).toMatch(/paste: \{[^}]*padding: space\.rowX/);
  });
});

describe("S4 · Session info · bands on a sheet, and the sheet's own close glyph", () => {
  const info = src("SessionInfoSheet");

  test("every band says it is on a sheet, and so does every row inside one", () => {
    const bands = tags(info, "BandSection");
    const rows = tags(info, "Row");
    expect(bands.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    for (const tag of bands) {
      expect(tag).toContain("onSheet");
    }
    for (const tag of rows) {
      expect(tag).toContain("onSheet");
    }
  });

  test("the sheet's close glyph is `Sheet`'s (S3's `onClose`), one glyph only", () => {
    // Design 4: `Sheet` draws the 18 pt close glyph. The screen kept its own 32 pt
    // button next to it, two ways out of one sheet, both labelled "Close".
    expect(tags(info, "Sheet").some((tag) => tag.includes("onClose={onClose}"))).toBe(true);
    // Flow 25 taps `session-info-close`; the id rides ALONG to the one glyph that
    // is left (`Sheet`'s `closeTestID`). Dropping it would leave the flow tapping
    // nothing (mutation M10)
    expect(
      tags(info, "Sheet").some((tag) => tag.includes('closeTestID="session-info-close"')),
    ).toBe(true);
    expect(info).not.toContain('testID="session-info-close"');
    expect(tags(info, "Icon").some((tag) => tag.includes('name="xmark"'))).toBe(false);
  });

  test("the sheet's ground is the banded ground (`bg`), not `sheet`", () => {
    // `Sheet` re-grounds a full sheet to `bg` (S3, Design 4): a root still painting
    // `sheet` leaves a lighter strip above it, at the top safe-area inset.
    const root = info.slice(
      info.indexOf("<View style={[styles.root"),
      info.indexOf("<View style={[styles.root") + 200,
    );
    expect(root).toContain("palette.bg");
    expect(root).not.toContain("palette.sheet");
  });

  test("Auto-accept is the LAST ROW of the Session band (the mockup's `infoE2`)", () => {
    // `index.html:394-397`: Project, Devices, then Auto-accept inside the SAME
    // band. A second band for one section would give the sheet two surfaces.
    // The row is handed to `Section` as its `lastRow`, gated on the session
    // section, and the component draws it INSIDE the band, after the view-model's
    // own rows (so it is the last row, and it is not a band of its own).
    const call = info.slice(info.indexOf("view.sections.map("));
    expect(call).toContain('section.id === "session"');
    expect(call).toContain("lastRow: (");
    const section = info.slice(
      info.indexOf("function Section("),
      info.indexOf("export function SessionInfoSheet"),
    );
    const open = section.lastIndexOf("<BandSection");
    const body = section.indexOf("<SectionBody");
    const lastRow = section.indexOf("{lastRow}");
    const close = section.indexOf("</BandSection>");
    expect(open).toBeGreaterThan(-1);
    // Order inside the band: its label/props, the rows, then Auto-accept.
    expect(body).toBeGreaterThan(open);
    expect(lastRow).toBeGreaterThan(body);
    expect(close).toBeGreaterThan(lastRow);
    // And it is the ONLY band in a section: no second surface for one section.
    expect(section.split("<BandSection").length - 1).toBe(1);
    expect(info).toContain('testID="session-info-autoaccept-switch"');
  });

  test("the flow-25 testIDs survive the swap", () => {
    for (const id of [
      "session-info-sheet",
      "session-info-scroll",
      "session-info-refresh",
      "session-info-loading",
    ]) {
      expect(info).toContain(id);
    }
    expect(info).toContain("testID={`session-info-${sectionId}-${rowIdentity(row)}`}");
    expect(info).toContain("testID={`session-info-${sectionId}-${rowIdentity(row)}-switch`}");
  });
});

describe("S4 · `Row` learns the sheet's separator token", () => {
  test("`onSheet` is a prop, and it picks `sepSheet`", () => {
    // S3's fix round 1 left this open: "if S4 mounts banded rows in a sheet, `Row`
    // needs an `onSheet`-equivalent then". S4 does, so the hairline between two
    // rows on a sheet is the sheet's token (`#403F3B` in dark, not `#3A3936`).
    expect(ROW).toMatch(/onSheet\?: boolean/);
    expect(ROW).toMatch(/palette\.sepSheet/);
    expect(ROW).not.toMatch(/backgroundColor: palette\.sep \}/);
    // The choice is the component's ONE branch on it, not a second prop.
    expect(ROW).toMatch(/onSheet \? palette\.sepSheet : palette\.sep/);
  });
});

describe("S4 · `Sheet`'s close id can be the screen's own", () => {
  test("`closeTestID` overrides the derived name", () => {
    // A screen whose flow already taps its close control keeps that id; the
    // override is read (not just declared), which is what a rename would break.
    const sheet = read("src", "ui", "Sheet.tsx");
    expect(sheet).toMatch(/closeTestID\?: string/);
    expect(sheet).toMatch(/closeTestID \?\? \(testID === undefined/);
  });
});

describe("S4 · the band owns the section rhythm (no wrapper gap doubles it)", () => {
  test("every screen leaves the vertical gap to the band's `sectionTop`", () => {
    // `BandSection` brings `space.sectionTop` above every band. A wrapper that ALSO
    // gapped its children would put 44 pt between two sections on Settings and a
    // different number on each screen — the old per-screen rhythm, back again.
    // Asserted on the exact style blocks, so re-adding a gap fails here.
    expect([
      { screen: "SettingsScreen", gap: /body: \{ gap: 0 \}/.test(src("SettingsScreen")) },
      { screen: "SessionsScreen", gap: /sections: \{ gap: 0 \}/.test(src("SessionsScreen")) },
      { screen: "SessionInfoSheet", gap: /content: \{ gap: 0 \}/.test(src("SessionInfoSheet")) },
    ]).toEqual([
      { screen: "SettingsScreen", gap: true },
      { screen: "SessionsScreen", gap: true },
      { screen: "SessionInfoSheet", gap: true },
    ]);
  });

  test("a band is never wrapped in a side margin (E2 is edge to edge)", () => {
    for (const screen of SCREENS) {
      const source = src(screen);
      // The wrapper a band sits in must not reintroduce the old card's inset.
      for (const style of [...source.matchAll(/(\w+): \{[^}]*marginHorizontal: space\.inset/g)]) {
        // The search field and a banner keep their own inset; a BAND's wrapper
        // must not. A `section`/`block` wrapper doing it is the regression.
        expect({ screen, style: style[1] }).not.toEqual({ screen, style: "section" });
        expect({ screen, style: style[1] }).not.toEqual({ screen, style: "block" });
      }
    }
  });
});

describe("S4 · the band primitive's own shape did not regress", () => {
  test("a standalone band (no label) is supported, and still spaced", () => {
    expect(BAND).toMatch(/readonly title\?: string/);
    expect(BAND).toMatch(/title === undefined \? null : \(/);
    // Even a label-less band keeps `sectionTop` above it: no band starts flush
    // against what precedes it.
    expect(BAND).toMatch(/sectionTop/);
  });

  test("the spacing tokens S3 kept for this slice's delete pass are gone", () => {
    // Every one of these was a measure of the OLD insets (a card's 16 pt inner
    // gutter, a separator inset after a tile, a 60 pt project row) or of the
    // pre-band section rhythm. The band owns those now (`space.rowX`,
    // `space.sectionTop`), so a token nothing reads is a trap for the next screen:
    // it looks like the house measure and is not.
    for (const dead of [
      "separatorPlain",
      "separatorAfterTile",
      "rowProject",
      "cardInner",
      "sectionSessions",
      "sectionComputers",
    ]) {
      expect({ dead, inTheme: THEME.includes(`${dead}:`) }).toEqual({ dead, inTheme: false });
      const users = tsxSources()
        .filter(({ text }) => text.includes(`space.${dead}`) || text.includes(`size.${dead}`))
        .map(({ file }) => file);
      expect({ dead, users }).toEqual({ dead, users: [] });
    }
  });
});
