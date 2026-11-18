Pod::Spec.new do |s|
  s.name           = 'TentacleSpeech'
  s.version        = '1.0.0'
  s.summary        = 'On-device dictation and read-aloud for the tentacle iPhone app'
  s.description    = 'SFSpeechRecognizer (on device only), SpeechAnalyzer, AVSpeechSynthesizer and one AVAudioSession owner.'
  s.author         = 'tentacle'
  s.homepage       = 'https://github.com/tentacle'
  s.license        = 'Apache-2.0'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'Speech', 'AVFoundation', 'UIKit'
  s.source_files = '**/*.{h,m,swift}'
end
