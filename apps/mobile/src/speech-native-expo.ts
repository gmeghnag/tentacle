/**
 * `SpeechPort` over the local native module `TentacleSpeech`
 * (`modules/tentacle-speech/`, docs/feat/mobile-voice.md Design §4): the ONE
 * native import of the voice feature, kept to wiring. Every rule lives in the
 * pure modules (`dictation.ts`, `read-aloud.ts`, `speech-engine.ts`).
 *
 * `requireOptionalNativeModule`: on Android (the module is iOS-only) or a build
 * without it, `SPEECH_PORT` is null and the mic / speaker buttons are hidden
 * (Notes: Android is out of scope).
 */
import { type EventSubscription, requireOptionalNativeModule } from "expo";
import type { VoiceInfo } from "./speech-language.ts";
import type { Capabilities, Permissions, SpeechPort, SpeechPortEvent } from "./speech-native.ts";

type Events = {
  dictation(body: { finalDelta: string; volatile: string }): void;
  level(body: { rms: number }): void;
  ended(body: { reason: string; code?: string; attempt?: number }): void;
  speech(body: { id: number; state: string; index?: number }): void;
  assetProgress(body: { fraction: number }): void;
};

interface Native {
  addListener<E extends keyof Events>(event: E, listener: Events[E]): EventSubscription;
  capabilities(locales: readonly string[]): Promise<Capabilities>;
  requestPermissions(): Promise<Permissions>;
  reserveLocale(locale: string): Promise<boolean>;
  installAsset(engine: string, locale: string): Promise<void>;
  startDictation(engine: string, locale: string, attempt: number): Promise<void>;
  stopDictation(): void;
  cancelDictation(attempt: number): void;
  voices(): Promise<readonly VoiceInfo[]>;
  speak(
    id: number,
    utterances: readonly string[],
    voiceId: string | null,
    language: string,
    rate: string,
  ): void;
  stopSpeaking(): void;
  haptic(kind: string): void;
}

function portOver(native: Native): SpeechPort {
  return {
    capabilities: (locales) => native.capabilities(locales),
    requestPermissions: () => native.requestPermissions(),
    reserveLocale: (locale) => native.reserveLocale(locale),
    installAsset: (engine, locale) => native.installAsset(engine, locale),
    startDictation: (o) => native.startDictation(o.engine, o.locale, o.attempt),
    stopDictation: () => native.stopDictation(),
    cancelDictation: (attempt) => native.cancelDictation(attempt),
    voices: () => native.voices(),
    speak: (o) => native.speak(o.id, o.utterances, o.voiceId ?? null, o.language, o.rate),
    stopSpeaking: () => native.stopSpeaking(),
    haptic: (kind) => native.haptic(kind),
    addListener(listener) {
      // The native side sends closed string unions; the port's types are the contract.
      const forward = (type: SpeechPortEvent["type"]) => (body: object) =>
        listener({ type, ...body } as SpeechPortEvent);
      const subs: EventSubscription[] = [
        native.addListener("dictation", forward("dictation")),
        native.addListener("level", forward("level")),
        native.addListener("ended", forward("ended")),
        native.addListener("speech", forward("speech")),
        native.addListener("assetProgress", forward("assetProgress")),
      ];
      return () => {
        for (const s of subs) {
          s.remove();
        }
      };
    },
  };
}

const native = requireOptionalNativeModule<Native>("TentacleSpeech");

/** The app's ONE speech port, or null where the native module is absent. */
export const SPEECH_PORT: SpeechPort | null = native === null ? null : portOver(native);
