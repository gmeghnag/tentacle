/**
 * `ask-speech.ts` — a permission ask as ONE spoken line
 * (docs/feat/voice-conversation.md §3 and §6.1, C2).
 *
 * §6.1's rule, without exception: the ask's text is the **answering device's own
 * broker request** (the Mac's laptop broker, the phone's `serve` sheet),
 * rendered by this deterministic template and spoken by local TTS. It never
 * passes through a model, and a spoken "yes" is never an approval (F6) — which
 * is why every line ends with "answer on screen".
 *
 * Two shapes only:
 * - the ask is ≤ `maxVerbatimChars` and ONE line → read it verbatim, so the
 *   person can decide without looking;
 * - anything else → a template that names no detail and points at the screen.
 *
 * Never a truncation: a cut command is a DIFFERENT command, and approving it by
 * ear would approve something the person never heard (§6.1 rule 4).
 */
import type { SpeechLang } from "./voice-lang.ts";

/** The ask-speech tunables (§3). */
export const ASK_SPEECH_DEFAULTS = {
  /** Above this many characters the ask is not read out at all. */
  maxVerbatimChars: 120,
} as const;

/** What a caller may pass: the ask's OWN fields, and nothing else. */
export interface AskForSpeech {
  /** The tool's name (display only: never spoken as an argument would be). */
  readonly tool: string;
  /** The broker's title: the command or path the person is approving. */
  readonly title: string;
  /**
   * The broker's explanation. Accepted and IGNORED: it is longer prose, and on a
   * pod session it can carry pod-supplied text (F7). The template never reads it.
   */
  readonly explanation?: string;
}

const TEMPLATES = {
  en: {
    /** The verbatim wrapper: `<title>. Answer on screen.` */
    suffix: "Answer on screen.",
    generic: "A command needs approval. Answer on screen.",
  },
  it: {
    suffix: "Rispondi sullo schermo.",
    generic: "Un comando richiede approvazione. Rispondi sullo schermo.",
  },
} as const;

/**
 * The one line to speak for this ask. Total: any title (empty, multi-line, huge,
 * hostile) yields a speakable line, never a throw and never a truncated detail.
 */
export function askSpeech(ask: AskForSpeech, lang: SpeechLang = "en"): string {
  const words = TEMPLATES[lang];
  const title = ask.title.trim();
  const oneLine = !/[\r\n]/.test(title);
  if (title === "" || !oneLine || title.length > ASK_SPEECH_DEFAULTS.maxVerbatimChars) {
    return words.generic;
  }
  // A title that already ends in terminal punctuation gets no second full stop.
  const body = /[.!?…]$/.test(title) ? title : `${title}.`;
  return `${body} ${words.suffix}`;
}
