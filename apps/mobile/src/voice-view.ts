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
import type { VoiceSettings } from "./voice-settings-store.ts";

export interface VoiceComposerView {
  readonly mic: MicButton;
  readonly level: number;
  /** Replaces the field's placeholder while listening / downloading. */
  readonly placeholder: string | undefined;
  /** The card above the composer (denied / restricted / unavailable / failed). */
  readonly card: MicView | undefined;
  /** A one-line notice under the composer ("dictation stopped after 20 s…"). */
  readonly notice: string | undefined;
  /**
   * The caption beside the mic (docs/feat/mobile-composer-buttons.md): the
   * elapsed time "0:07" while recording, "…" while transcribing, else none —
   * so neither state is told by colour alone.
   */
  readonly caption: string | undefined;
}

const HIDDEN: VoiceComposerView = {
  mic: "hidden",
  level: 0,
  placeholder: undefined,
  card: undefined,
  notice: undefined,
  caption: undefined,
};

/** Elapsed recording time as m:ss ("0:07", "10:00"); a negative span reads 0:00. */
export function recordingClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${seconds < 10 ? "0" : ""}${seconds}`;
}

export function voiceComposerView(
  state: VoiceState | null,
  locale: DictationLocale,
  settings: VoiceSettings,
  /** The render's clock (ms, the dictation's own clock): the recording timer. */
  now: number,
): VoiceComposerView {
  // The Beta switch is the first gate (docs/feat/mobile-voice-hidden.md): with
  // Dictation off nothing of it renders, whatever the controller state says.
  if (state === null || !settings.dictation) {
    return HIDDEN;
  }
  const mic = micButtonOf(state.dictation, true);
  const download = downloadLine(state.dictation);
  const placeholder =
    download ??
    (mic === "listening" || mic === "finalizing"
      ? locale === "it-IT"
        ? "Sto ascoltando…"
        : "Listening…"
      : undefined);
  return {
    mic,
    level: mic === "listening" ? state.level : 0,
    placeholder,
    card: dictationCard(state.dictation),
    notice: dictationNotice(state.dictation),
    caption:
      state.dictation.kind === "listening"
        ? recordingClock(now - state.dictation.startedAt)
        : mic === "finalizing"
          ? "…"
          : undefined,
  };
}

/** The speaker button for one row: offered, speaking, or none. */
export function speakButtonOf(
  state: VoiceState | null,
  row: { readonly kind: string; readonly key: string; readonly text?: string },
  rows: readonly { readonly kind: string; readonly key: string }[],
  running: boolean,
  settings: VoiceSettings,
): "offered" | "speaking" | undefined {
  // The Beta switch gates the whole surface, `speaking` included: with Read aloud
  // off a row shows neither the speaker nor the stop (docs/feat/mobile-voice-hidden.md).
  if (state === null || row.kind !== "assistant" || !settings.readAloudButton) {
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
