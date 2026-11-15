// SpeechCore — the native half of docs/feat/mobile-voice.md Design §1.
//
// Deliberately dumb: it REPORTS facts (capabilities, permissions, voices) and
// RUNS commands (dictate, speak, haptic). Every decision lives in TS
// (`speech-engine.ts`, `dictation.ts`, `read-aloud.ts`). No ExpoModulesCore
// import here, so this file typechecks with plain `swiftc` against the iOS SDK;
// `TentacleSpeechModule.swift` is the Expo glue.
//
// Invariants owned here:
// - NEVER a network recognizer: the recognizer engine refuses to start unless
//   `supportsOnDeviceRecognition` is true, and always sets
//   `requiresOnDeviceRecognition = true` (F1, belt and braces with TS).
// - ONE owner of AVAudioSession: playAndRecord while dictating, playback while
//   speaking, deactivated with notifyOthersOnDeactivation when both are idle.
// - Interruptions and AirPods removal end dictation/speech (F4).

import AVFoundation
import Speech
import UIKit

protocol SpeechCoreDelegate: AnyObject {
  func coreDictation(finalDelta: String, volatile: String)
  func coreLevel(_ rms: Double)
  func coreEnded(reason: String, code: String?)
  func coreSpeech(id: Int, state: String, index: Int?)
  func coreAssetProgress(_ fraction: Double)
}

struct SpeechCoreError: Error {
  let code: String
  let message: String
}

/// A dictation engine (recognizer on iOS 18, analyzer on iOS 26).
protocol DictationEngine: AnyObject {
  func start() async throws
  /// Finalize: flush pending text as final, then report `ended(stopped)`.
  func stop()
  /// Drop pending text, report `ended(cancelled)`.
  func cancel()
  /// Audio is gone (interruption / route): stop without waiting, report `reason`.
  func abort(reason: String)
}

final class SpeechCore: NSObject, AVSpeechSynthesizerDelegate {
  weak var delegate: SpeechCoreDelegate?

  private let synthesizer = AVSpeechSynthesizer()
  private var speechId = 0
  private var utteranceIndex: [ObjectIdentifier: Int] = [:]
  private var utteranceCount = 0
  /// Why the current speech is being cut short (`stopped` by default).
  private var cutReason = "stopped"
  private var speechReported = false

  private var engine: DictationEngine?
  private var observers: [NSObjectProtocol] = []

  override init() {
    super.init()
    synthesizer.delegate = self
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] note in self?.onInterruption(note) })
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] note in self?.onRouteChange(note) })
  }

  deinit {
    for o in observers { NotificationCenter.default.removeObserver(o) }
  }

  func shutdown() {
    engine?.cancel()
    engine = nil
    if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
    deactivateIfIdle()
  }

  // MARK: facts

  func permissions() -> [String: String] {
    let mic: String
    switch AVAudioApplication.shared.recordPermission {
    case .granted: mic = "granted"
    case .denied: mic = "denied"
    default: mic = "undetermined"
    }
    let speech: String
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: speech = "authorized"
    case .denied: speech = "denied"
    case .restricted: speech = "restricted"
    default: speech = "notDetermined"
    }
    return ["mic": mic, "speech": speech]
  }

  /// Mic first, then speech recognition: one tap, two OS prompts at most.
  func requestPermissions() async -> [String: String] {
    if AVAudioApplication.shared.recordPermission == .undetermined {
      _ = await AVAudioApplication.requestRecordPermission()
    }
    if AVAudioApplication.shared.recordPermission == .granted,
       SFSpeechRecognizer.authorizationStatus() == .notDetermined {
      await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        SFSpeechRecognizer.requestAuthorization { _ in done.resume() }
      }
    }
    return permissions()
  }

  func capabilities(locales: [String]) async -> [String: Any] {
    var out: [String: Any] = [
      "os": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
      "permissions": permissions(),
    ]
    var recognizer: [String: Any] = [:]
    for id in locales {
      if let r = SFSpeechRecognizer(locale: Locale(identifier: id)) {
        recognizer[id] = ["supported": true, "onDevice": r.supportsOnDeviceRecognition]
      } else {
        recognizer[id] = ["supported": false, "onDevice": false]
      }
    }
    out["recognizer"] = recognizer
    if #available(iOS 26.0, *) {
      out["analyzer"] = await AnalyzerEngine.facts(locales: locales)
    }
    return out
  }

  // MARK: dictation

  func reserveLocale(_ id: String) async throws -> Bool {
    if #available(iOS 26.0, *) {
      return try await AnalyzerEngine.reserve(locale: id)
    }
    return true
  }

  func installAsset(engine kind: String, locale id: String) async throws {
    guard #available(iOS 26.0, *) else {
      throw SpeechCoreError(code: "unsupported", message: "model downloads need iOS 26")
    }
    try await AnalyzerEngine.install(kind: kind, locale: id) { [weak self] fraction in
      DispatchQueue.main.async { self?.delegate?.coreAssetProgress(fraction) }
    }
  }

  @MainActor
  func startDictation(engine kind: String, locale id: String) async throws {
    engine?.cancel()
    engine = nil
    if synthesizer.isSpeaking { stopSpeaking() }
    let sink = EngineSink(core: self)
    let next: DictationEngine
    switch kind {
    case "recognizer":
      next = try RecognizerEngine(locale: id, sink: sink)
    case "transcriber", "dictation":
      guard #available(iOS 26.0, *) else {
        throw SpeechCoreError(code: "unsupported", message: "\(kind) needs iOS 26")
      }
      next = AnalyzerEngine(kind: kind, locale: id, sink: sink)
    default:
      throw SpeechCoreError(code: "bad-engine", message: kind)
    }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord, mode: .default,
      options: [.duckOthers, .allowBluetoothHFP, .defaultToSpeaker])
    try session.setActive(true)
    engine = next
    do {
      try await next.start()
    } catch {
      engine = nil
      deactivateIfIdle()
      throw error
    }
  }

  func stopDictation() { engine?.stop() }
  func cancelDictation() { engine?.cancel() }

  /// Called by an engine (main thread) once it has fully ended.
  fileprivate func engineEnded(_ ended: DictationEngine, reason: String, code: String?) {
    if engine === ended { engine = nil }
    deactivateIfIdle()
    delegate?.coreEnded(reason: reason, code: code)
  }

  // MARK: speech

  func voices() -> [[String: Any]] {
    AVSpeechSynthesisVoice.speechVoices().map { v in
      let quality: String
      switch v.quality {
      case .premium: quality = "premium"
      case .enhanced: quality = "enhanced"
      default: quality = "default"
      }
      return [
        "id": v.identifier, "language": v.language, "name": v.name, "quality": quality,
        "novelty": v.voiceTraits.contains(.isNoveltyVoice),
      ]
    }
  }

  func speak(id: Int, utterances: [String], voiceId: String?, language: String, fast: Bool) {
    if synthesizer.isSpeaking { stopSpeaking() }
    engine?.stop()
    do {
      let session = AVAudioSession.sharedInstance()
      // `.playback`: audible with the silent switch on (that is the point of a tap).
      try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try session.setActive(true)
    } catch {
      delegate?.coreSpeech(id: id, state: "interrupted", index: nil)
      return
    }
    speechId = id
    speechReported = false
    cutReason = "stopped"
    utteranceIndex = [:]
    utteranceCount = utterances.count
    let voice = voiceId.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
      ?? AVSpeechSynthesisVoice(language: language)
    let rate = fast
      ? min(AVSpeechUtteranceDefaultSpeechRate * 1.15, AVSpeechUtteranceMaximumSpeechRate)
      : AVSpeechUtteranceDefaultSpeechRate
    for (i, text) in utterances.enumerated() {
      let u = AVSpeechUtterance(string: text)
      u.voice = voice
      u.rate = rate
      u.postUtteranceDelay = 0.15
      utteranceIndex[ObjectIdentifier(u)] = i
      synthesizer.speak(u)
    }
  }

  func stopSpeaking(reason: String = "stopped") {
    cutReason = reason
    synthesizer.stopSpeaking(at: .immediate)
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
    guard let i = utteranceIndex[ObjectIdentifier(u)] else { return }
    delegate?.coreSpeech(id: speechId, state: i == 0 ? "started" : "utterance", index: i)
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
    guard let i = utteranceIndex[ObjectIdentifier(u)], i == utteranceCount - 1 else { return }
    reportSpeechEnd("finished")
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
    guard utteranceIndex[ObjectIdentifier(u)] != nil else { return }
    reportSpeechEnd(cutReason)
  }

  private func reportSpeechEnd(_ state: String) {
    guard !speechReported else { return }
    speechReported = true
    utteranceIndex = [:]
    delegate?.coreSpeech(id: speechId, state: state, index: nil)
    deactivateIfIdle()
  }

  // MARK: session + haptics

  private func deactivateIfIdle() {
    guard engine == nil, !synthesizer.isSpeaking else { return }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func onInterruption(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
    engine?.abort(reason: "interrupted")
    if synthesizer.isSpeaking { stopSpeaking(reason: "interrupted") }
  }

  private func onRouteChange(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
    engine?.abort(reason: "route")
    if synthesizer.isSpeaking { stopSpeaking(reason: "interrupted") }
  }

  func haptic(_ kind: String) {
    switch kind {
    case "start": UIImpactFeedbackGenerator(style: .light).impactOccurred()
    case "stop": UIImpactFeedbackGenerator(style: .soft).impactOccurred()
    default: UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
  }

  fileprivate func level(_ rms: Double) { delegate?.coreLevel(rms) }
  fileprivate func text(finalDelta: String, volatile: String) {
    delegate?.coreDictation(finalDelta: finalDelta, volatile: volatile)
  }
}

/// What an engine reports into; every call hops to the main thread.
final class EngineSink {
  private weak var core: SpeechCore?
  private var lastLevelAt = Date.distantPast

  init(core: SpeechCore) { self.core = core }

  func text(finalDelta: String, volatile: String) {
    DispatchQueue.main.async { self.core?.text(finalDelta: finalDelta, volatile: volatile) }
  }

  func ended(_ engine: DictationEngine, reason: String, code: String? = nil) {
    DispatchQueue.main.async { self.core?.engineEnded(engine, reason: reason, code: code) }
  }

  /// RMS of a buffer → 0..1 (−50 dB…0 dB), throttled to ~10 Hz. Audio thread.
  func level(from buffer: AVAudioPCMBuffer) {
    let now = Date()
    guard now.timeIntervalSince(lastLevelAt) >= 0.1,
          let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    lastLevelAt = now
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
    let rms = sqrt(sum / Float(buffer.frameLength))
    let db = 20 * log10(max(rms, 1e-7))
    let value = Double(max(0, min(1, (db + 50) / 50)))
    DispatchQueue.main.async { self.core?.level(value) }
  }
}
