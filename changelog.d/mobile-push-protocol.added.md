- **The wire for push notifications: one sealed plaintext, one envelope, two
  device methods.** `@tentacle/protocol` gains `PushMessageSchema` (the sealed
  plaintext: `v`, a dedupe `id`, `at`, the four kinds `ask` / `ask_resolved` /
  `turn_done` / `turn_failed`, the computer, project and session it belongs to,
  and an ask's options) with `fitPushMessage`, the one producer-side gate that
  clips its text to the 2046 bytes a sealed push can carry — walking code points,
  so a clip never splits a surrogate pair — and `pushCollapseIdOf`, the opaque
  `apns-collapse-id` that lets a resolved ask replace its own banner;
  `PushEnvelopeSchema` / `PushPayloadSchema`, where the payload is `{tp}` and
  nothing else, so the notification's visible `aps` stays the relay's own fixed
  template and no content reaches a banner without the seal being opened. New
  methods `device/push_register` (raw APNs token, environment, per-device X25519
  push key → `{graceSeconds, push}` so Settings can say why notifications will
  not arrive) and `device/push_unregister`, plus `DEFAULT_PUSH_GRACE_SECONDS`
  (30). The relay's control wire gains `push` / `push-result`
  (`RELAY_PROTOCOL_VERSION` unchanged: sending one is gated on the relay
  announcing `"push"` in `ready.features`, which an unknown name never breaks).
  Additive on the wire — an older daemon answers `MethodNotFound` — so no
  `PROTOCOL_VERSION` change.
