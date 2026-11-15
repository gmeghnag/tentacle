// swift-tools-version:5.9
import PackageDescription

// The voice helper (docs/feat/voice-dictation.md §2). One executable, no
// third-party dependency: the default engine is Apple's own on-device
// `SpeechTranscriber`, whose assets already live on the Mac. The Parakeet
// engine (an opt-in, `voice.engine: parakeet`) is not wired here yet — see the
// task doc's Execution: S1 measured Apple at WER 0.082 / 79 ms p50, better than
// V0's endpointed Parakeet, so the default is what V1 ships.
let package = Package(
    name: "TentacleVoice",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "tentacle-voice",
            path: "Sources/TentacleVoice"
        ),
        .testTarget(
            name: "TentacleVoiceTests",
            dependencies: ["tentacle-voice"],
            path: "Tests/TentacleVoiceTests"
        ),
    ]
)
