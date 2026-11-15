// The tentacle-speech config plugin (docs/feat/mobile-voice.md Design §6): writes
// the speech-recognition usage string into the static config's Info.plist.
// `NSMicrophoneUsageDescription` is NOT written here: expo-camera and
// expo-image-picker both own that key, and both carry the same dictation string
// in app.json (P4 — two writers must agree, never race a delete).
const SPEECH_RECOGNITION_USAGE =
  "tentacle turns your speech into text on this iPhone, for the message you are writing";

function withTentacleSpeech(config) {
  config.ios = config.ios ?? {};
  config.ios.infoPlist = {
    ...(config.ios.infoPlist ?? {}),
    NSSpeechRecognitionUsageDescription: SPEECH_RECOGNITION_USAGE,
  };
  return config;
}

module.exports = withTentacleSpeech;
module.exports.SPEECH_RECOGNITION_USAGE = SPEECH_RECOGNITION_USAGE;
