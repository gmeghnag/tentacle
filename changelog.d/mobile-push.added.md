- **Push notification content is sealed end-to-end before it leaves the computer,
  and every push is exactly one of three sizes.** `@tentacle/transport/push` gains
  `sealPush` / `openPush` — HPKE (RFC 9180) **Auth mode**, DHKEM(X25519,
  HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305, single shot. The sender key is
  the computer's static key, so a relay or Apple cannot forge a push that opens;
  the recipient key is a per-device push key generated at registration, separate
  from the device's Noise key. The plaintext is padded to the next
  512/1024/2048 bucket behind an explicit `u16` length prefix, so the envelope's
  size says nothing about its kind, and the envelope's key id is the AEAD's
  associated data, so a ciphertext cannot be moved to another paired computer.
  The envelope is a plain HPKE Auth single-shot, so the app can open it with
  CryptoKit's own `HPKE.Recipient(…authenticatedBy:)` and no hand-written Swift
  crypto — the extension that does so is the app-side task, not this one. Pinned
  by RFC 9180 Appendix A.2.3's published vectors plus our own envelope vectors,
  both produced by an implementation independent of the code under test
  (`packages/transport/test/vectors/push-v1.json`).
