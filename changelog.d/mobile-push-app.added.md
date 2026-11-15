- **The app side of notifications: a phone registers itself with the computer it
  is paired to, and its push key is the one secret the future Notification
  Service Extension will read.** A paired iPhone now asks for notification
  permission **once**, right after its first successful pairing, with an
  explanatory line — never at launch, never again after a denial — and from then
  on registers itself on every successful connect through a new
  `RemoteClient.pushRegister` / `pushUnregister` (the same Noise channel as
  everything else, so no new transport and no second session path). Registration
  is decided by a fingerprint of `(raw APNs token, environment, push key)` kept
  in the computer's own Keychain record: a reconnect, a remount, an app relaunch
  or a daemon restart sends **nothing**, while a token iOS rotated or a
  regenerated push key sends exactly one — and a status the daemon refused
  (`off` / `relay-off` / `relay-no-push`) is deliberately *not* remembered, so a
  relay that later gets its APNs key starts working on the next connect. The
  raw APNs token comes from `expo-notifications`' `getDevicePushTokenAsync`
  (never Expo's push service, decision 19), the environment (`sandbox` /
  `production`) follows the build, and an older computer's `MethodNotFound` is
  terminal: Settings says "update tentacle on <computer>" instead of retrying in
  a loop. The per-device X25519 push key is generated once, stored
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` in the **shared Keychain access group**
  (so task 17's extension can open a push while the phone is locked) and is a
  separate secret from the Noise device key, so an extension that reads
  notifications still cannot act as the phone. Settings gains one
  "Notifications" row for the phone — the toggle reaches every paired computer,
  and its detail line is the most informative status among them (a computer
  whose relay cannot deliver is the reason nothing arrives) — and `app.json`
  gains the `expo-notifications` plugin, the time-sensitive entitlement and the
  keychain access group. No notification UI beyond the OS's own placeholder
  banner: the extension, actions and Face ID are task 17. Design:
  `docs/feat/mobile-push.md` (slice P9).
