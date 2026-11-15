/**
 * Which on-device engine dictates (docs/feat/mobile-voice.md Design §2, F1/F5).
 *
 * Preference: `transcriber` (iOS 26 `SpeechTranscriber`, model installed) →
 * `dictation` (iOS 26 `DictationTranscriber`, model installed) → a download of
 * either model → `recognizer` (`SFSpeechRecognizer`) **only when it runs on
 * device** → unavailable.
 *
 * THE never-cloud rule lives here: a recognizer that is `supported` but not
 * `onDevice` would send audio to Apple's servers, so it is NEVER chosen — the
 * mic says on-device dictation is unavailable instead. Swift refuses too (belt
 * and braces), but this is the test (`speech-engine.test.ts`).
 */
import type { AssetStatus, Capabilities, Engine } from "./speech-native.ts";

export type UnavailableReason = "no-on-device-model" | "locale-unsupported" | "hardware";

export type EngineChoice =
  | { readonly kind: "engine"; readonly engine: Engine; readonly locale: string }
  | {
      readonly kind: "needsDownload";
      readonly engine: "transcriber" | "dictation";
      readonly locale: string;
    }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason; readonly locale: string };

export interface ChooseOptions {
  /**
   * `AssetInventory.reserve(locale:)` refused (the app is at
   * `maximumReservedLocales`, F5): skip both iOS 26 engines and fall through.
   */
  readonly reserveRefused?: boolean;
}

const downloadable = (s: AssetStatus | undefined) => s === "supported" || s === "downloading";

export function chooseEngine(
  caps: Capabilities,
  locale: string,
  options: ChooseOptions = {},
): EngineChoice {
  const analyzer = options.reserveRefused === true ? undefined : caps.analyzer;
  if (analyzer !== undefined) {
    const tAsset = analyzer.assets[locale];
    const dAsset = (analyzer.dictationAssets ?? analyzer.assets)[locale];
    if (analyzer.transcriber && tAsset === "installed") {
      return { kind: "engine", engine: "transcriber", locale };
    }
    if (analyzer.dictation && dAsset === "installed") {
      return { kind: "engine", engine: "dictation", locale };
    }
    if (analyzer.transcriber && downloadable(tAsset)) {
      return { kind: "needsDownload", engine: "transcriber", locale };
    }
    if (analyzer.dictation && downloadable(dAsset)) {
      return { kind: "needsDownload", engine: "dictation", locale };
    }
  }
  const rec = caps.recognizer[locale];
  if (rec?.supported === true && rec.onDevice) {
    return { kind: "engine", engine: "recognizer", locale };
  }
  // Nothing on device. A network recognizer is NEVER a fallback (F1).
  if (rec?.supported === true) {
    return { kind: "unavailable", reason: "no-on-device-model", locale };
  }
  if (caps.analyzer !== undefined && !caps.analyzer.transcriber && !caps.analyzer.dictation) {
    return { kind: "unavailable", reason: "hardware", locale };
  }
  return { kind: "unavailable", reason: "locale-unsupported", locale };
}
