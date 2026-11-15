- **The relay delivers push to Apple, and only when it holds a key.** `apps/relay`
  gains the APNs path: a pure `apns.ts` (the one fixed banner every push shows, the
  HTTP/2 request, the ES256 provider JWT with its 40-minute cache, and Apple's
  status table — `410` / `400 BadDeviceToken` → `gone`, `429` → `throttled`, a
  `403 ExpiredProviderToken` → a fresh token and exactly one retry) and an
  `apns-client.ts` that keeps one HTTP/2 session per environment, reconnects when
  Apple retires it, and gives every request a 10-second deadline. A daemon's
  `push` frame is answered with `push-result` (`sent` / `gone` / `rejected` /
  `throttled` / `unavailable`); a socket that has not completed `hello` cannot
  push at all, and per-id (120/min) and per-token (30/min) limits refuse the rest
  with a status, never silently. `ready.features` announces `"push"` **only** when
  the relay was started with a readable APNs key (`--apns-key-file`,
  `--apns-key-id`, `--apns-team-id`, `--apns-topic`, or the matching
  `TENTACLE_RELAY_APNS_*` variables), so an unconfigured relay never swallows a
  push; the key is read once, never logged. Design: `docs/feat/mobile-push.md`.
