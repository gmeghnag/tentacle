/**
 * `speech-locale.ts` — the dictation locale (docs/feat/mobile-voice.md Design §2).
 */
import { describe, expect, test } from "bun:test";
import { dictationLocale, langOf, speechLocaleCandidates } from "../src/speech-locale.ts";

describe("dictationLocale", () => {
  test("an explicit setting wins over the device", () => {
    expect(dictationLocale("it-IT", ["en-US"])).toBe("it-IT");
    expect(dictationLocale("en-US", ["it-IT"])).toBe("en-US");
  });

  test("auto picks the first device locale that is it or en", () => {
    expect(dictationLocale("auto", ["it-IT", "en-US"])).toBe("it-IT");
    expect(dictationLocale("auto", ["de-DE", "en-GB", "it-IT"])).toBe("en-US");
    expect(dictationLocale("auto", ["fr-FR", "it_CH"])).toBe("it-IT");
  });

  test("auto with neither language, or no locales → en-US", () => {
    expect(dictationLocale("auto", ["de-DE", "fr-FR"])).toBe("en-US");
    expect(dictationLocale("auto", [])).toBe("en-US");
  });
});

describe("candidates and lang", () => {
  test("the chosen locale first, each once", () => {
    expect(speechLocaleCandidates("en-US")).toEqual(["en-US", "it-IT"]);
    expect(speechLocaleCandidates("it-IT")).toEqual(["it-IT", "en-US"]);
  });

  test("langOf", () => {
    expect(langOf("it-IT")).toBe("it");
    expect(langOf("en-US")).toBe("en");
  });
});
