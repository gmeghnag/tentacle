// The iOS 26 engines: SpeechAnalyzer + SpeechTranscriber ("transcriber") or
// DictationTranscriber ("dictation") (docs/feat/mobile-voice.md Design §1).
// On device by design: the models are local assets (AssetInventory), there is
// no server mode to opt out of.

import AVFoundation
import Speech

@available(iOS 26.0, *)
final class AnalyzerEngine: DictationEngine {
  private let kind: String
  private let localeId: String
  private let sink: EngineSink
  private let audio = AVAudioEngine()
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var resultsTask: Task<Void, Never>?
  /// Main thread only.
  private var finished = false

  init(kind: String, locale: String, sink: EngineSink) {
    self.kind = kind
    self.localeId = locale
    self.sink = sink
  }

  // MARK: static facts (capabilities, reserve, install)

  static func module(kind: String, locale: Locale) -> any SpeechModule {
    kind == "dictation"
      ? DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
      : SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
  }

  static func resolvedLocale(kind: String, id: String) async -> Locale? {
    let locale = Locale(identifier: id)
    return kind == "dictation"
      ? await DictationTranscriber.supportedLocale(equivalentTo: locale)
      : await SpeechTranscriber.supportedLocale(equivalentTo: locale)
  }

  static func status(kind: String, id: String) async -> String {
    guard let locale = await resolvedLocale(kind: kind, id: id) else { return "unsupported" }
    switch await AssetInventory.status(forModules: [module(kind: kind, locale: locale)]) {
    case .installed: return "installed"
    case .supported: return "supported"
    case .downloading: return "downloading"
    default: return "unsupported"
    }
  }

  static func facts(locales: [String]) async -> [String: Any] {
    var assets: [String: String] = [:]
    var dictationAssets: [String: String] = [:]
    for id in locales {
      assets[id] = await status(kind: "transcriber", id: id)
      dictationAssets[id] = await status(kind: "dictation", id: id)
    }
    return [
      "transcriber": SpeechTranscriber.isAvailable,
      "dictation": true,
      "assets": assets,
      "dictationAssets": dictationAssets,
    ]
  }

  /// False at `maximumReservedLocales` (F5: TS falls back to the next engine).
  static func reserve(locale id: String) async throws -> Bool {
    var resolved = await resolvedLocale(kind: "transcriber", id: id)
    if resolved == nil {
      resolved = await resolvedLocale(kind: "dictation", id: id)
    }
    guard let locale = resolved else { return false }
    if await AssetInventory.reservedLocales.contains(locale) { return true }
    return try await AssetInventory.reserve(locale: locale)
  }

  static func install(kind: String, locale id: String, progress: @escaping (Double) -> Void) async throws {
    guard let locale = await resolvedLocale(kind: kind, id: id) else {
      throw SpeechCoreError(code: "locale-unsupported", message: id)
    }
    if let request = try await AssetInventory.assetInstallationRequest(
      supporting: [module(kind: kind, locale: locale)]) {
      let observation = request.progress.observe(\.fractionCompleted) { p, _ in
        progress(p.fractionCompleted)
      }
      defer { observation.invalidate() }
      try await request.downloadAndInstall()
    }
    progress(1)
  }

  // MARK: a dictation

  func start() async throws {
    guard let locale = await Self.resolvedLocale(kind: kind, id: localeId) else {
      throw SpeechCoreError(code: "locale-unsupported", message: localeId)
    }
    let module = Self.module(kind: kind, locale: locale)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
      throw SpeechCoreError(code: "no-format", message: "no audio format for the analyzer")
    }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: [module])
    try await analyzer.prepareToAnalyze(in: format)
    self.analyzer = analyzer
    self.input = continuation
    resultsTask = Task { [weak self] in await self?.consume(module) }
    try await analyzer.start(inputSequence: stream)
    try await MainActor.run { try self.startAudio(format: format, continuation: continuation) }
  }

  private func consume(_ module: any SpeechModule) async {
    do {
      if let transcriber = module as? SpeechTranscriber {
        for try await r in transcriber.results {
          report(String(r.text.characters), isFinal: r.isFinal)
        }
      } else if let dictation = module as? DictationTranscriber {
        for try await r in dictation.results {
          report(String(r.text.characters), isFinal: r.isFinal)
        }
      }
      await MainActor.run { self.finish(reason: "stopped", code: nil) }
    } catch {
      await MainActor.run { self.finish(reason: "error", code: "analyzer") }
    }
  }

  /// A final replaces nothing (it is appended); a volatile replaces the last volatile.
  private func report(_ text: String, isFinal: Bool) {
    if isFinal {
      sink.text(finalDelta: text, volatile: "")
    } else {
      sink.text(finalDelta: "", volatile: text)
    }
  }

  private func startAudio(
    format: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation
  ) throws {
    let node = audio.inputNode
    let natural = node.outputFormat(forBus: 0)
    let converter = natural == format ? nil : AVAudioConverter(from: natural, to: format)
    node.installTap(onBus: 0, bufferSize: 4096, format: natural) { [sink] buffer, _ in
      sink.level(from: buffer)
      if let converted = Self.convert(buffer, with: converter, to: format) {
        continuation.yield(AnalyzerInput(buffer: converted))
      }
    }
    audio.prepare()
    try audio.start()
  }

  private static func convert(
    _ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter?, to format: AVAudioFormat
  ) -> AVAudioPCMBuffer? {
    guard let converter else { return buffer }
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var consumed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    return error == nil ? out : nil
  }

  private func stopAudio() {
    if audio.isRunning { audio.stop() }
    audio.inputNode.removeTap(onBus: 0)
    input?.finish()
    input = nil
  }

  func stop() {
    DispatchQueue.main.async {
      guard !self.finished else { return }
      self.stopAudio()
      let analyzer = self.analyzer
      // Finalize flushes the volatile range as final; the results loop then ends us.
      Task { try? await analyzer?.finalizeAndFinishThroughEndOfInput() }
    }
  }

  func cancel() { abort(reason: "cancelled") }

  func abort(reason: String) {
    DispatchQueue.main.async {
      self.finish(reason: reason, code: nil)
    }
  }

  private func finish(reason: String, code: String?) {
    guard !finished else { return }
    finished = true
    stopAudio()
    resultsTask?.cancel()
    let analyzer = self.analyzer
    self.analyzer = nil
    Task { await analyzer?.cancelAndFinishNow() }
    sink.ended(self, reason: reason, code: code)
  }
}
