- **The phone's session link: an ask waits for a person, and leaving never ends
  a session.** The mobile app now builds its single permission broker *held*
  (no requester until the permission sheet is up) instead of denying, so a
  daemon-side ask is never answered on the user's behalf; quitting or losing the
  app detaches (`drain()` + `close()`) instead of sending `session/close`, so a
  session keeps running for every device; and a new pure foreground gate drops
  the socket when iOS backgrounds the app and holds the redial until it is
  active, so returning re-attaches instead of leaving a ghost attachment for up
  to a minute. A new pure session controller owns open/leave (never create,
  never close), serialises a fast back-then-forward per session id, and turns a
  failed attach into a typed reason (`archived` / `deleted` / `gone` /
  `too-many` / `timeout` / `link`) decided by error class, never message text.
  No protocol change. The session screen itself is 12c.
