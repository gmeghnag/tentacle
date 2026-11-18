/**
 * Spoken language (docs/feat/voice-conversation.md §3): the language a reply is
 * SPOKEN in. Resolution order is the design's, exactly: the last utterance's
 * detected/selected language, else the edge's setting, else `en`.
 *
 * A tag we do not speak is `null`, never a guess: P-F6 forbids a network
 * recogniser, and a reply read in the wrong language is worse than the default.
 */

/** The languages either edge can speak on device. */
export type SpeechLang = "it" | "en";

/** Last resort, and the language of a session with no setting (§3). */
export const DEFAULT_SPEECH_LANG: SpeechLang = "en";

/** The spoken languages, in the order the settings list them. */
export const SPEECH_LANGS: readonly SpeechLang[] = ["it", "en"];

/**
 * A BCP-47-ish tag (`it`, `it-IT`, `en_US`, `EN-gb`) → the spoken language, or
 * `null` when neither the primary subtag nor the tag as a whole is one we speak.
 * Case- and separator-insensitive, because the two edges' recognisers disagree
 * on the shape (`SFSpeechRecognizer` gives `it-IT`, the helper `it`).
 */
export function toSpeechLang(tag: string | null | undefined): SpeechLang | null {
  if (tag === null || tag === undefined) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return (SPEECH_LANGS as readonly string[]).includes(primary) ? (primary as SpeechLang) : null;
}

/** What the edge knows when it must pick a language to speak in. */
export interface LangChoice {
  /** The last utterance's detected/selected language tag, if any. */
  readonly utterance?: string | null;
  /** The edge's own voice setting (`auto`, `it`, `en`). */
  readonly setting?: string | null;
}

/** The last utterance's language, else the setting, else `en`. */
export function spokenLang(choice: LangChoice): SpeechLang {
  return toSpeechLang(choice.utterance) ?? toSpeechLang(choice.setting) ?? DEFAULT_SPEECH_LANG;
}
