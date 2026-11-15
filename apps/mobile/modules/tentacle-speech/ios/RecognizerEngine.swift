// The iOS 18 engine: SFSpeechRecognizer, ON DEVICE ONLY (docs/feat/mobile-voice.md
// Design §1, F1, F7).
//
// - Refuses to exist unless `supportsOnDeviceRecognition` is true (`not-on-device`),
//   and every request sets `requiresOnDeviceRecognition = true`. Never a network
//   recognizer: the header says a recognizer without on-device support "requires
//   a network", so it is not an option at all.
// - Segment rollover: every 50 s (or on a final mid-stream) a NEW request takes
//   the same audio tap; the old one is ended and its final text goes out as
//   `finalDelta`, so the stream stays append-only.

import AVFoundation
import Speech

final class RecognizerEngine: DictationEngine {
  private final class Segment {
    let request: SFSpeechAudioBufferRecognitionRequest
    var task: SFSpeechRecognitionTask?
    var partial = ""
    var done = false
    init(request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
  }

  private let recognizer: SFSpeechRecognizer
  private let sink: EngineSink
  private let audio = AVAudioEngine()
  private let lock = NSLock()
  /// The request the audio tap feeds (read on the audio thread, under `lock`).
  private var live: SFSpeechAudioBufferRecognitionRequest?
  /// Main thread only from here down.
  private var segments: [Segment] = []
  private var rollover: Timer?
  private var stopping = false
  private var finished = false

  init(locale: String, sink: EngineSink) throws {
    guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
      throw SpeechCoreError(code: "locale-unsupported", message: locale)
    }
    // F1: never a network recognizer.
    guard r.supportsOnDeviceRecognition else {
      throw SpeechCoreError(code: "not-on-device", message: "no on-device model for \(locale)")
    }
    recognizer = r
    self.sink = sink
  }

  func start() async throws {
    try await MainActor.run { try self.begin() }
  }

  private func begin() throws {
    newSegment()
    let input = audio.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      guard let self else { return }
      self.lock.lock()
      let request = self.live
      self.lock.unlock()
      request?.append(buffer)
      self.sink.level(from: buffer)
    }
    audio.prepare()
    do {
      try audio.start()
    } catch {
      input.removeTap(onBus: 0)
      segments.forEach { $0.task?.cancel() }
      throw error
    }
    rollover = Timer.scheduledTimer(withTimeInterval: 50, repeats: true) { [weak self] _ in
      self?.roll()
    }
  }

  private func newSegment() {
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true  // F1
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    let segment = Segment(request: request)
    segments.append(segment)
    lock.lock()
    live = request
    lock.unlock()
    segment.task = recognizer.recognitionTask(with: request) { [weak self, weak segment] result, error in
      DispatchQueue.main.async {
        guard let self, let segment else { return }
        self.onResult(segment, result: result, error: error)
      }
    }
  }

  /// End the current request (its final arrives later) and feed a new one.
  private func roll() {
    guard !stopping, let current = segments.last, !current.done else { return }
    current.request.endAudio()
    newSegment()
  }

  /// Text of every unfinished segment, oldest first: what the field shows as volatile.
  private func pendingVolatile() -> String {
    segments.filter { !$0.done && !$0.partial.isEmpty }.map(\.partial).joined(separator: " ")
  }

  private func onResult(_ segment: Segment, result: SFSpeechRecognitionResult?, error: Error?) {
    guard !finished, !segment.done else { return }
    if let result {
      let text = result.bestTranscription.formattedString
      if result.isFinal {
        segment.done = true
        segment.partial = ""
        sink.text(finalDelta: text, volatile: pendingVolatile())
        if !stopping && segment === segments.last {
          // The request hit its own limit mid-stream: keep listening on a new one.
          newSegment()
        }
      } else {
        segment.partial = text
        sink.text(finalDelta: "", volatile: pendingVolatile())
      }
    }
    if let error, !segment.done {
      segment.done = true
      // Flush what was shown as final: nothing the person saw is lost.
      let flushed = segment.partial
      segment.partial = ""
      if !flushed.isEmpty {
        sink.text(finalDelta: flushed, volatile: pendingVolatile())
      }
      if !stopping {
        let code = (error as NSError).code
        // 1110 = "no speech detected": a quiet end, not a failure.
        finish(reason: code == 1110 ? "stopped" : "error", code: "recognizer-\(code)")
        return
      }
    }
    segments.removeAll { $0.done }
    if stopping && segments.isEmpty {
      finish(reason: "stopped", code: nil)
    }
  }

  private func stopAudio() {
    rollover?.invalidate()
    rollover = nil
    if audio.isRunning { audio.stop() }
    audio.inputNode.removeTap(onBus: 0)
    lock.lock()
    live = nil
    lock.unlock()
  }

  func stop() {
    DispatchQueue.main.async {
      guard !self.stopping else { return }
      self.stopping = true
      self.stopAudio()
      self.segments.removeAll { $0.done }
      if self.segments.isEmpty {
        self.finish(reason: "stopped", code: nil)
      } else {
        // Each pending request delivers its final; the last one ends us.
        self.segments.forEach { $0.request.endAudio() }
      }
    }
  }

  func cancel() { abort(reason: "cancelled") }

  func abort(reason: String) {
    DispatchQueue.main.async {
      self.stopping = true
      self.stopAudio()
      self.segments.forEach { $0.task?.cancel() }
      self.segments.removeAll()
      self.finish(reason: reason, code: nil)
    }
  }

  private func finish(reason: String, code: String?) {
    guard !finished else { return }
    finished = true
    stopping = true
    stopAudio()
    segments.forEach { $0.task?.cancel() }
    segments.removeAll()
    sink.ended(self, reason: reason, code: code)
  }
}
