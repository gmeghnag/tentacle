Pod::Spec.new do |s|
  s.name           = 'TentacleClock'
  s.version        = '1.0.0'
  s.summary        = 'A native elapsed-time label for the tentacle iPhone app'
  s.description    = 'ClockText: a UILabel that counts from an event stamp on the main thread.'
  s.author         = 'tentacle'
  s.homepage       = 'https://github.com/tentacle'
  s.license        = 'Apache-2.0'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'UIKit'
  s.source_files = '**/*.{h,m,swift}'
end
