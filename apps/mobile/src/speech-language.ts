/**
 * Which language a reply is in, and which system voice reads it
 * (docs/feat/mobile-voice.md Design §3). Pure: the voice list comes from the
 * native module (`SpeechPort.voices()`), the choice is made here.
 */
import type { SpeechLang } from "./speakable.ts";

/** A closed stopword list per language (≈30 each): frequent, short, unambiguous. */
const STOPWORDS: Readonly<Record<SpeechLang, ReadonlySet<string>>> = {
  it: new Set([
    "il",
    "lo",
    "gli",
    "della",
    "delle",
    "dei",
    "degli",
    "che",
    "non",
    "per",
    "una",
    "sono",
    "questo",
    "questa",
    "come",
    "anche",
    "più",
    "ma",
    "nel",
    "nella",
    "alla",
    "del",
    "con",
    "ho",
    "hai",
    "è",
    "perché",
    "quando",
    "dove",
    "allora",
    "ecco",
    "puoi",
  ]),
  en: new Set([
    "the",
    "and",
    "is",
    "are",
    "of",
    "to",
    "that",
    "this",
    "with",
    "for",
    "not",
    "you",
    "it",
    "was",
    "be",
    "have",
    "has",
    "but",
    "what",
    "which",
    "from",
    "will",
    "would",
    "can",
    "there",
    "they",
    "your",
    "we",
    "an",
    "on",
    "at",
    "if",
  ]),
};

/** Stopword hits one language needs OVER the other to win (else: the fallback). */
export const LANGUAGE_MARGIN = 2;

/** Count stopword hits per language; a margin of `LANGUAGE_MARGIN` decides, else `fallback`. */
export function detectLanguage(text: string, fallback: SpeechLang): SpeechLang {
  let it = 0;
  let en = 0;
  for (const word of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (STOPWORDS.it.has(word)) {
      it += 1;
    }
    if (STOPWORDS.en.has(word)) {
      en += 1;
    }
  }
  if (it - en >= LANGUAGE_MARGIN) {
    return "it";
  }
  if (en - it >= LANGUAGE_MARGIN) {
    return "en";
  }
  return fallback;
}

/** One system voice, as the native module reports it (structural). */
export interface VoiceInfo {
  readonly id: string;
  /** BCP-47, e.g. `it-IT`, `en-GB`. */
  readonly language: string;
  readonly name: string;
  readonly quality: "default" | "enhanced" | "premium";
  /** Apple's novelty voices (Bells, Bubbles, …): never chosen. */
  readonly novelty: boolean;
}

const QUALITY_RANK = { premium: 0, enhanced: 1, default: 2 } as const;
const HOME_REGION: Readonly<Record<SpeechLang, string>> = { it: "it-IT", en: "en-US" };

/**
 * The best voice for `lang`: premium > enhanced > default, then the home region
 * (`it-IT` / `en-US`) over others, then by name (determinism). `undefined` means
 * "the system default for the language" (AVSpeech picks one).
 */
export function pickVoice(voices: readonly VoiceInfo[], lang: SpeechLang): string | undefined {
  const candidates = voices.filter(
    (v) => !v.novelty && v.language.toLowerCase().split(/[-_]/)[0] === lang,
  );
  candidates.sort((a, b) => {
    const q = QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality];
    if (q !== 0) {
      return q;
    }
    const home = HOME_REGION[lang];
    const r = (a.language === home ? 0 : 1) - (b.language === home ? 0 : 1);
    if (r !== 0) {
      return r;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;
  });
  return candidates[0]?.id;
}
