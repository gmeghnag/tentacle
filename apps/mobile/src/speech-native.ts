/**
 * The native speech module as a STRUCTURAL port (docs/feat/mobile-voice.md
 * Design §1/§4): no native import, so the reducers and `voice-controller.ts` are
 * tested with a fake (`FakeSpeechPort`). The one implementation over
 * `requireNativeModule("TentacleSpeech")` is `speech-native-expo.ts`.
 *
 * The surface is deliberately dumb: it REPORTS facts and RUNS commands. Every
 * decision (which engine, whether to ask, what to say) lives in TS.
 */
import type { VoiceInfo } from "./speech-language.ts";

export type AssetStatus = "installed" | "supported" | "downloading" | "unsupported";
export type MicPermission = "granted" | "denied" | "undetermined" | "restricted";
export type SpeechPermission = "authorized" | "denied" | "notDetermined" | "restricted";
export type Engine = "transcriber" | "dictation" | "recognizer";

export interface Permissions {
  readonly mic: MicPermission;
  readonly speech: SpeechPermission;
}

export interface Capabilities {
  /** The iOS major version. */
  readonly os: number;
  /** iOS 26+ `SpeechAnalyzer` facts; absent below 26. */
  readonly analyzer?: {
    /** `SpeechTranscriber.isAvailable` (the hardware gate). */
    readonly transcriber: boolean;
    /** `DictationTranscriber` usable at all. */
    readonly dictation: boolean;
    /** Per locale, for the transcriber's model. */
    readonly assets: Readonly<Record<string, AssetStatus>>;
    /** Per locale, for the dictation transcriber's model (falls back to `assets`). */
    readonly dictationAssets?: Readonly<Record<string, AssetStatus>>;
  };
  /** iOS 18 `SFSpeechRecognizer` facts, per locale. */
  readonly recognizer: Readonly<
    Record<string, { readonly supported: boolean; readonly onDevice: boolean }>
  >;
  readonly permissions: Permissions;
}

export type EndedReason = "stopped" | "cancelled" | "interrupted" | "route" | "error";

export type SpeechPortEvent =
  | { readonly type: "dictation"; readonly finalDelta: string; readonly volatile: string }
  | { readonly type: "level"; readonly rms: number }
  | { readonly type: "ended"; readonly reason: EndedReason; readonly code?: string }
  | {
      readonly type: "speech";
      readonly id: number;
      readonly state: "started" | "utterance" | "finished" | "stopped" | "interrupted";
      readonly index?: number;
    }
  | { readonly type: "assetProgress"; readonly fraction: number };

export type HapticKind = "start" | "stop" | "error";

export interface SpeechPort {
  capabilities(locales: readonly string[]): Promise<Capabilities>;
  /** Mic first, then speech recognition (one tap). Resolves the states, never rejects on a denial. */
  requestPermissions(): Promise<Permissions>;
  /** iOS 26: download the model for `locale`; resolves on install, rejects on failure. */
  installAsset(engine: Engine, locale: string): Promise<void>;
  /** iOS 26: `AssetInventory.reserve(locale:)` — false at the reserved-locale cap (F5). */
  reserveLocale(locale: string): Promise<boolean>;
  startDictation(options: { readonly engine: Engine; readonly locale: string }): Promise<void>;
  stopDictation(): void;
  cancelDictation(): void;
  voices(): Promise<readonly VoiceInfo[]>;
  speak(options: {
    readonly id: number;
    readonly utterances: readonly string[];
    readonly voiceId: string | undefined;
    /** BCP-47 (`it-IT` / `en-US`): the system default voice when `voiceId` is undefined. */
    readonly language: string;
    readonly rate: "normal" | "fast";
  }): void;
  stopSpeaking(): void;
  haptic(kind: HapticKind): void;
  /** Subscribe to every event; returns the unsubscribe. */
  addListener(listener: (event: SpeechPortEvent) => void): () => void;
}
