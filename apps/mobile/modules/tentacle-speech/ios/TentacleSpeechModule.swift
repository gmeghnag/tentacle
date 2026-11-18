// The Expo glue over SpeechCore (docs/feat/mobile-voice.md Design §1): the JS
// surface `speech-native-expo.ts` adapts to the `SpeechPort`. No logic here —
// argument passing, events, and error codes only.

import ExpoModulesCore

public class TentacleSpeechModule: Module, SpeechCoreDelegate {
  private let core = SpeechCore()

  public func definition() -> ModuleDefinition {
    Name("TentacleSpeech")

    Events("dictation", "level", "ended", "speech", "assetProgress")

    AsyncFunction("capabilities") { (locales: [String]) async -> [String: Any] in
      await self.core.capabilities(locales: locales)
    }

    AsyncFunction("requestPermissions") { () async -> [String: String] in
      await self.core.requestPermissions()
    }

    AsyncFunction("reserveLocale") { (locale: String) async throws -> Bool in
      try await Self.coded { try await self.core.reserveLocale(locale) }
    }

    AsyncFunction("installAsset") { (engine: String, locale: String) async throws in
      try await Self.coded { try await self.core.installAsset(engine: engine, locale: locale) }
    }

    AsyncFunction("startDictation") { (engine: String, locale: String, attempt: Int) async throws in
      try await Self.coded {
        try await self.core.startDictation(engine: engine, locale: locale, attempt: attempt)
      }
    }

    // Commands touch main-thread state (the engine, the synthesizer, UIKit haptics).
    Function("stopDictation") { DispatchQueue.main.async { self.core.stopDictation() } }
    Function("cancelDictation") { (attempt: Int) in
      DispatchQueue.main.async { self.core.cancelDictation(attempt: attempt) }
    }

    AsyncFunction("voices") { () -> [[String: Any]] in
      self.core.voices()
    }.runOnQueue(.main)

    Function("speak") {
      (id: Int, utterances: [String], voiceId: String?, language: String, rate: String) in
      DispatchQueue.main.async {
        self.core.speak(
          id: id, utterances: utterances, voiceId: voiceId, language: language,
          fast: rate == "fast")
      }
    }

    Function("stopSpeaking") { DispatchQueue.main.async { self.core.stopSpeaking() } }

    Function("haptic") { (kind: String) in DispatchQueue.main.async { self.core.haptic(kind) } }

    OnCreate { self.core.delegate = self }
    OnDestroy { DispatchQueue.main.async { self.core.shutdown() } }
  }

  /// A SpeechCoreError reaches JS with its `code` (e.g. `not-on-device`, F1).
  private static func coded<T>(_ body: () async throws -> T) async throws -> T {
    do {
      return try await body()
    } catch let e as SpeechCoreError {
      throw Exception(name: "SpeechCoreError", description: e.message, code: e.code)
    }
  }

  func coreDictation(finalDelta: String, volatile: String) {
    sendEvent("dictation", ["finalDelta": finalDelta, "volatile": volatile])
  }

  func coreLevel(_ rms: Double) {
    sendEvent("level", ["rms": rms])
  }

  func coreEnded(reason: String, code: String?, attempt: Int) {
    var body: [String: Any] = ["reason": reason, "attempt": attempt]
    if let code { body["code"] = code }
    sendEvent("ended", body)
  }

  func coreSpeech(id: Int, state: String, index: Int?) {
    var body: [String: Any] = ["id": id, "state": state]
    if let index { body["index"] = index }
    sendEvent("speech", body)
  }

  func coreAssetProgress(_ fraction: Double) {
    sendEvent("assetProgress", ["fraction": fraction])
  }
}
