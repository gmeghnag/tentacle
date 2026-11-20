/**
 * Settings → Beta (docs/feat/mobile-voice-hidden.md): the two switches, off by
 * default, and the rows they reveal.
 *
 * The DECISION is pure and tested (`voice-beta.test.ts`: `voiceRows`); React
 * Native's sources are Flow, so Bun cannot render `SettingsScreen.tsx`. What is
 * left is "is the right thing rendered, gated on the right value" — the same
 * shape as `push-wiring-guards.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const settings = readFileSync(join(APP, "src", "screens", "SettingsScreen.tsx"), "utf8");
const app = readFileSync(join(APP, "App.tsx"), "utf8");

describe("the Beta section", () => {
  test("its header says Beta, not Voice", () => {
    expect(settings).toContain('title="Beta"');
    expect(settings).not.toContain('title="Voice"');
  });

  test("two switches with the testIDs a flow can assert", () => {
    expect(settings).toContain('testID="beta-dictation"');
    expect(settings).toContain('testID="beta-read-aloud"');
  });

  test("each switch writes ITS own field and nothing else", () => {
    // Mutation: wiring both to one field would make one of these two fail.
    expect(settings).toContain("onValueChange={(dictation) => onVoice({ ...voice, dictation })}");
    expect(settings).toContain(
      "onValueChange={(readAloudButton) => onVoice({ ...voice, readAloudButton })}",
    );
  });

  test("they render the stored value, so a fresh install shows them OFF", () => {
    expect(settings).toContain("value={voice.dictation}");
    expect(settings).toContain("value={voice.readAloudButton}");
  });

  test("the footnote says what Beta means", () => {
    expect(settings).toContain("Experimental features. They may not work well yet.");
  });
});

describe("the rows a switch reveals", () => {
  test("Language, auto-read and the rate are each gated on the pure predicate", () => {
    expect(settings).toContain("{rows.language ? (");
    expect(settings).toContain("{rows.autoRead ? (");
    expect(settings).toContain("{rows.rate ? (");
    expect(settings).toContain("voiceRows(voice ?? DEFAULT_VOICE_SETTINGS)");
  });

  test("the auto-read row and the rate stay inside their gates (no unconditional copy)", () => {
    // The pre-Beta screen rendered all three ALWAYS; the switch rows must not.
    // Order in the rendered output: Beta switches, then auto-read, then Language,
    // then the rate, then the footnote that always shows.
    const auto = settings.indexOf("rows.autoRead ? (");
    const language = settings.indexOf("rows.language ? (");
    const rate = settings.indexOf("rows.rate ? (");
    expect(auto).toBeGreaterThan(-1);
    expect(language).toBeGreaterThan(auto);
    expect(rate).toBeGreaterThan(language);
    expect(settings.indexOf('testID="voice-read-aloud"')).toBeGreaterThan(auto);
    expect(settings.indexOf('testID="voice-read-aloud"')).toBeLessThan(language);
    expect(settings.indexOf('LANGUAGE_ROWS, voice.language, "voice-language"')).toBeGreaterThan(
      language,
    );
    expect(settings.indexOf('RATE_ROWS, voice.rate, "voice-rate"')).toBeGreaterThan(rate);
    // The privacy footer is outside every gate: it is always shown.
    expect(settings.indexOf("Audio never leaves it and is never saved")).toBeGreaterThan(rate);
  });
});

describe("App hands Settings the stored record and its writer", () => {
  test("the props are wired (mutation: drop `voice=` → red)", () => {
    expect(app).toContain("voice={voiceSettings}");
    expect(app).toContain("onVoice={selectVoice}");
  });
});

/** docs/feat/mobile-theme-beta.md: the Lato try-out switch, wired end to end. */
describe("Beta → Tema Lato (prova)", () => {
  test("a third switch, named as the owner asked, rendering the stored value", () => {
    expect(settings).toContain('title="Tema Lato (prova)"');
    expect(settings).toContain('testID="beta-theme-lato"');
    expect(settings).toContain("value={themeBeta.lato}");
    expect(settings).toContain("onValueChange={(lato) => onThemeBeta({ ...themeBeta, lato })}");
  });

  test("App feeds it the remembered switch and writes through the holder", () => {
    expect(app).toContain("themeBeta={theme.settings}");
    expect(app).toContain("onThemeBeta={theme.select}");
    expect(app).toContain("THEME_SETTINGS.set(next)");
    expect(app).toContain("THEME_SETTINGS.subscribe(setThemeSettings)");
  });

  test("the app's ONE palette and font come from themeFor, live (no restart)", () => {
    // Mutation: a `paletteFor(useColorScheme())` left in place would ignore the switch.
    expect(app).not.toContain("paletteFor(");
    expect(app).toContain("themeFor(useColorScheme(), themeSettings, latoReady)");
    expect(app).toContain("const palette = theme.palette;");
    // ONE provider, at the root: every screen (and the lock) is inside it.
    expect(app).toContain(
      "<SafeAreaProvider>\n      <AppFontContext.Provider value={theme.font}>\n        <AppShell theme={theme} />",
    );
  });

  test("the faces load only when the switch is on", () => {
    expect(app).toContain("if (!themeSettings.lato || latoReady) return;");
  });
});
