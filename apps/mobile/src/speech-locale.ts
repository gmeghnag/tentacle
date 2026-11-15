/**
 * The dictation locale (docs/feat/mobile-voice.md Design §2, Owner Q3):
 * Settings "Language: Auto / Italiano / English". `auto` follows the iPhone's
 * own language order (first `it` or `en`), else `en-US`.
 */
import type { SpeechLang } from "./speakable.ts";

export type DictationLocale = "it-IT" | "en-US";
export type LanguageSetting = "auto" | DictationLocale;

/** Every locale this build dictates in: what `capabilities` is asked about. */
export const SPEECH_LOCALE_CANDIDATES: readonly DictationLocale[] = ["it-IT", "en-US"];

export function dictationLocale(
  setting: LanguageSetting,
  deviceLocales: readonly string[],
): DictationLocale {
  if (setting !== "auto") {
    return setting;
  }
  for (const tag of deviceLocales) {
    const lang = tag.toLowerCase().split(/[-_]/)[0];
    if (lang === "it") {
      return "it-IT";
    }
    if (lang === "en") {
      return "en-US";
    }
  }
  return "en-US";
}

/** The locale list sent to `capabilities` (the chosen one first). */
export function speechLocaleCandidates(chosen: DictationLocale): readonly DictationLocale[] {
  return [chosen, ...SPEECH_LOCALE_CANDIDATES.filter((l) => l !== chosen)];
}

/** The read-aloud fallback language for a dictation locale. */
export function langOf(locale: DictationLocale): SpeechLang {
  return locale === "it-IT" ? "it" : "en";
}
