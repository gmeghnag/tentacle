- **A permission request nobody answers, or a turn that ends while nobody is
  watching, now reaches your phone — through the relay and Apple, which carry
  only a sealed blob.** A `serve` daemon observes its own sessions (an observer
  that is deliberately *not* an attachment, so it neither counts as a watching
  client nor silences the notifications it exists to send) and, once an ask has
  waited `push.graceSeconds` (default 30, `0`–`3600`, `serve --push-grace <s>`)
  with no client attached to that session, pushes every paired phone that
  registered for notifications: `ask` for the request, `ask_resolved` under the
  same collapse id once it is answered anywhere (so a stale banner is replaced,
  and a folded pair stays actionable until its last ask is answered), `turn_done`
  / `turn_failed` only when nothing at all is attached, and never for a
  cancellation. The exclusion is read at the *deadline*, so a phone locked
  during the grace is pushed to — that needed a real detach on the relay path,
  where a closed leg now drops its connection. Content is sealed per device
  (HPKE Auth, sender = the computer's static key), so Apple and the relay see an
  opaque envelope and can neither read nor forge a notification. New device
  methods `device/push_register` (raw APNs token, environment, per-device push
  key → the grace and an honest `on` / `relay-off` / `relay-no-push` status) and
  `device/push_unregister`; a registration is `<configDir>/devices/push/<id>.json`
  (0600, atomic), `gone` from Apple is a **compare-and-delete** so a phone that
  re-registered is never muted, and a revoked device is filtered at push time
  even if its file survives. The relay link holds a push for up to 60 s while it
  reconnects and drops it (audited) after that, and it never sends a `push` frame
  to a relay that did not announce `"push"` — an older relay closes the control
  socket on an unknown frame. Config: `push.enabled`, `push.graceSeconds`.
  Design: `docs/feat/mobile-push.md` (slices P7, P8).
