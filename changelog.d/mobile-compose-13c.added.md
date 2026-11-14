- **One image sniffer, and the phone can now upload a photo.** The rule that an
  image's type comes from its BYTES rather than its name or the picker's claim
  moved from the TUI into `@tentacle/core` (the TUI file is a re-export, so its
  behaviour and tests are unchanged), and the Expo app gained the pure photo
  pipeline that uses it: a HEIC is converted to JPEG once and re-sniffed, a
  photo over the 15 MiB cap is shrunk once (a GIF over it is refused, never
  re-encoded), the 5-photo limit and an attachment name's control characters are
  enforced before a single byte goes out, and the app now supplies the binary
  sha-256 the client needs — without it every upload from the phone threw, since
  Bun's hasher is absent under Hermes. The composer itself is task 13d.
