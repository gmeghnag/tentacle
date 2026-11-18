/**
 * The mic button's permission states as a VIEW-MODEL (docs/feat/mobile-voice.md
 * Design §2, F1/F2), modelled on `camera-access.ts`:
 *
 *   undetermined (mic or speech) → the tap ASKS (never before — camera decision 10)
 *   granted + authorized         → the tap starts dictation
 *   denied (mic or speech)       → after a tap, a card + "Open Settings"
 *   restricted (Screen Time/MDM) → after a tap, a card with NO Settings button
 *                                  (our Settings page cannot lift it)
 *   no on-device engine          → its own sentence per reason (F1), no button
 */
import type { UnavailableReason } from "./speech-engine.ts";
import type { Permissions } from "./speech-native.ts";

export type MicAction = "ask" | "start" | "explain" | "none";
export type MicCard = "denied-mic" | "denied-speech" | "restricted" | "unavailable";

export interface MicView {
  readonly action: MicAction;
  readonly card: MicCard | undefined;
  /** The card carries "Open Settings" (`Linking.openSettings()`). */
  readonly settings: boolean;
  readonly message: string | undefined;
}

export const MIC_DENIED_MESSAGE =
  "Microphone access is off — enable it in Settings to dictate a message";
export const SPEECH_DENIED_MESSAGE =
  "Speech recognition is off — enable it in Settings to dictate a message";
export const VOICE_RESTRICTED_MESSAGE =
  "Dictation is restricted on this iPhone (Screen Time or a device profile)";

/** The language's own name, as iOS Settings lists it. */
export function localeName(locale: string): string {
  return locale.startsWith("it") ? "Italiano" : "English";
}

/** One sentence per unavailable reason (F1). */
export function unavailableMessage(reason: UnavailableReason, locale: string): string {
  const name = localeName(locale);
  switch (reason) {
    case "no-on-device-model":
      return `On-device dictation for ${name} isn't available on this iPhone. Turn on Dictation for ${name} in Settings › General › Keyboard, or switch language`;
    case "locale-unsupported":
      return `This iPhone can't dictate ${name} on device — switch language in Settings › Voice`;
    case "hardware":
      return "On-device dictation isn't supported on this iPhone";
  }
}

const NONE = { card: undefined, settings: false, message: undefined } as const;

export interface MicViewInput {
  readonly permissions: Permissions;
  /** The person tapped the mic at least once (a denial is explained only then). */
  readonly tapped: boolean;
  /** `chooseEngine` said there is no on-device engine (known only after a tap). */
  readonly unavailable?: { readonly reason: UnavailableReason; readonly locale: string };
}

export function micViewFor(input: MicViewInput): MicView {
  const { mic, speech } = input.permissions;
  const card = (c: MicCard, settings: boolean, message: string): MicView =>
    input.tapped ? { action: "none", card: c, settings, message } : { action: "explain", ...NONE };
  if (mic === "restricted" || speech === "restricted") {
    return card("restricted", false, VOICE_RESTRICTED_MESSAGE);
  }
  if (mic === "denied") {
    return card("denied-mic", true, MIC_DENIED_MESSAGE);
  }
  if (speech === "denied") {
    return card("denied-speech", true, SPEECH_DENIED_MESSAGE);
  }
  if (mic === "undetermined" || speech === "notDetermined") {
    return { action: "ask", ...NONE };
  }
  if (input.unavailable !== undefined) {
    return {
      action: "none",
      card: "unavailable",
      settings: false,
      message: unavailableMessage(input.unavailable.reason, input.unavailable.locale),
    };
  }
  return { action: "start", ...NONE };
}
