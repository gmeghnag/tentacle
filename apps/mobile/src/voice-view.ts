/**
 * The session screen's voice VIEW-MODEL (docs/feat/mobile-voice.md Design §5,
 * AGENTS §7): everything the composer, the cards and the row buttons show,
 * projected from `VoiceState`, so `SessionScreen.tsx` only maps values to
 * elements.
 */
import {
  type MicButton,
  dictationCard,
  dictationNotice,
  downloadLine,
  micButtonOf,
} from "./dictation.ts";
import { readAloudOffered, speakingRowKey, streamingRowKey } from "./read-aloud.ts";
import type { DictationLocale } from "./speech-locale.ts";
import type { VoiceState } from "./voice-controller.ts";
import type { MicView } from "./voice-permission.ts";

export interface VoiceComposerView {
  readonly mic: MicButton;
  readonly level: number;
  /** Replaces the field's placeholder while listening / downloading. */
  readonly placeholder: string | undefined;
  /** The card above the composer (denied / restricted / unavailable / failed). */
  readonly card: MicView | undefined;
  /** A one-line notice under the composer ("dictation stopped after 20 s…"). */
  readonly notice: string | undefined;
}

const HIDDEN: VoiceComposerView = {
  mic: "hidden",
  level: 0,
  placeholder: undefined,
  card: undefined,
  notice: undefined,
};

export function voiceComposerView(
  state: VoiceState | null,
  locale: DictationLocale,
): VoiceComposerView {
  if (state === null) {
    return HIDDEN;
  }
  const mic = micButtonOf(state.dictation, true);
  const download = downloadLine(state.dictation);
  const placeholder =
    download ??
    (mic === "listening" ? (locale === "it-IT" ? "Sto ascoltando…" : "Listening…") : undefined);
  return {
    mic,
    level: mic === "listening" ? state.level : 0,
    placeholder,
    card: dictationCard(state.dictation),
    notice: dictationNotice(state.dictation),
  };
}

/** The speaker button for one row: offered, speaking, or none. */
export function speakButtonOf(
  state: VoiceState | null,
  row: { readonly kind: string; readonly key: string; readonly text?: string },
  rows: readonly { readonly kind: string; readonly key: string }[],
  running: boolean,
): "offered" | "speaking" | undefined {
  if (state === null || row.kind !== "assistant") {
    return undefined;
  }
  if (speakingRowKey(state.readAloud) === row.key) {
    return "speaking";
  }
  return readAloudOffered({ key: row.key, text: row.text ?? "" }, streamingRowKey(rows, running))
    ? "offered"
    : undefined;
}

/** A running turn just ended: whether it was this phone's own (auto-read gate), else undefined. */
export function endedTurn(
  previous: { readonly turnId: string; readonly own: boolean } | null,
  next: { readonly turnId: string } | null,
): { readonly own: boolean } | undefined {
  if (previous === null) {
    return undefined;
  }
  return next === null || next.turnId !== previous.turnId ? { own: previous.own } : undefined;
}
