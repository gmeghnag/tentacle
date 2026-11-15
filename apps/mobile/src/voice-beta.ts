/**
 * The BETA gate (docs/feat/mobile-voice-hidden.md): the voice features are opt-in
 * switches in Settings → Beta, OFF by default, and every surface obeys them.
 *
 * Pure and React-free (AGENTS §7): what a switch allows, and what turning it OFF
 * must stop, decided in one place and tested on its own. `voice-view.ts` and
 * `voice-controller.ts` only ask.
 */
import type { VoiceSettings } from "./voice-settings-store.ts";

/** Settings → Beta → Dictation: the composer's mic button. */
export function dictationOn(settings: VoiceSettings): boolean {
  return settings.dictation;
}

/** Settings → Beta → Read aloud: the speaker button on assistant rows. */
export function readAloudButtonOn(settings: VoiceSettings): boolean {
  return settings.readAloudButton;
}

/**
 * Auto read-aloud needs BOTH switches: the Beta one turns the feature on, the
 * older "Read replies aloud" row then says whether it should speak on its own.
 * One switch is enough to keep the phone silent.
 */
export function autoReadOn(settings: VoiceSettings): boolean {
  return settings.readAloudButton && settings.readAloud;
}

/** Which Settings rows a switch reveals (Settings → Beta, minimal on purpose). */
export interface VoiceRows {
  /** Language is shared: dictation and read-aloud both use it. */
  readonly language: boolean;
  /** "Read replies aloud": the auto-read switch, part of the Read aloud Beta. */
  readonly autoRead: boolean;
  /** Speaking rate: Read aloud only. */
  readonly rate: boolean;
}

/**
 * A row shows only when a switch that USES it is on: with everything off the Beta
 * section is the two switches and a footnote, nothing else.
 */
export function voiceRows(settings: VoiceSettings): VoiceRows {
  return {
    language: settings.dictation || settings.readAloudButton,
    autoRead: settings.readAloudButton,
    rate: settings.readAloudButton,
  };
}

/** Which running voices a settings change must stop, because their switch went off. */
export interface VoiceStops {
  /** Dictation was turned off: end what is listening (never send it). */
  readonly dictation: boolean;
  /** Read aloud was turned off: stop what is speaking. */
  readonly readAloud: boolean;
}

/**
 * The switches that went from on to off. Turning Dictation off subsumes the
 * composer; turning EITHER read-aloud switch off silences the phone, because
 * both are needed for speech to happen at all (`autoReadOn`) and the speaker
 * button itself belongs to `readAloudButton`.
 */
export function voiceStops(previous: VoiceSettings, next: VoiceSettings): VoiceStops {
  return {
    dictation: previous.dictation && !next.dictation,
    readAloud:
      (previous.readAloudButton && !next.readAloudButton) ||
      (previous.readAloud && !next.readAloud),
  };
}
