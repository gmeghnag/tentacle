/**
 * `voice-lang.ts` — the language a reply is spoken in
 * (docs/feat/voice-conversation.md §3, C2). Mutation target: `spokenLang`
 * ignoring the last utterance (always the setting) must fail the first block.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPEECH_LANG,
  SPEECH_LANGS,
  spokenLang,
  toSpeechLang,
} from "../../src/voice/index.ts";

describe("T-voice-lang: a tag normalises to a spoken language", () => {
  test("bare and region/underscore tags map to their language", () => {
    expect(toSpeechLang("it")).toBe("it");
    expect(toSpeechLang("it-IT")).toBe("it");
    expect(toSpeechLang("it_CH")).toBe("it");
    expect(toSpeechLang("en")).toBe("en");
    expect(toSpeechLang("en-US")).toBe("en");
    expect(toSpeechLang("EN_gb")).toBe("en");
  });

  test("a language we do not speak is null, so the setting decides", () => {
    // P-F6: never a cloud recogniser, never a guessed language.
    expect(toSpeechLang("fr")).toBeNull();
    expect(toSpeechLang("de-DE")).toBeNull();
    expect(toSpeechLang("")).toBeNull();
    expect(toSpeechLang(null)).toBeNull();
    expect(toSpeechLang(undefined)).toBeNull();
  });

  test("the shipped language set and default", () => {
    expect([...SPEECH_LANGS]).toEqual(["it", "en"]);
    expect(DEFAULT_SPEECH_LANG).toBe("en");
  });
});

describe("T-voice-lang: resolution order is utterance → setting → en", () => {
  test("the last utterance wins over the setting", () => {
    expect(spokenLang({ utterance: "en-US", setting: "it" })).toBe("en");
    expect(spokenLang({ utterance: "it-IT", setting: "en" })).toBe("it");
  });

  test("an unknown or missing utterance falls back to the setting", () => {
    expect(spokenLang({ utterance: "fr-FR", setting: "it" })).toBe("it");
    expect(spokenLang({ utterance: null, setting: "it-IT" })).toBe("it");
    expect(spokenLang({ setting: "en-GB" })).toBe("en");
  });

  test("nothing known at all is en", () => {
    expect(spokenLang({})).toBe("en");
    expect(spokenLang({ utterance: null, setting: null })).toBe("en");
    expect(spokenLang({ utterance: "fr", setting: "auto" })).toBe("en");
  });
});
