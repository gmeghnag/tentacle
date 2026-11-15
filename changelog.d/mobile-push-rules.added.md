- **A phone's push registration is stored, revoked and shown, and the daemon's
  push rules are pure.** `<configDir>/devices/push/<id>.json` holds one device's
  APNs token, environment and per-device push key (mode 0600, written through a
  temp file); an unreadable or unknown-version record is skipped with one audit
  line and left byte-for-byte alone, and a `gone` from Apple is a
  **compare-and-delete** — a phone that re-registered in the meantime keeps its
  fresh token instead of being silently muted. `tentacle devices revoke` and
  `devices reset` remove the file with the device, and `tentacle devices` gains a
  `PUSH` column (`on` / `off`) that reports what the daemon will do rather than
  what the phone believes. The when-to-buzz decisions are a pure, clock-injected
  module (`push-rules.ts`): a grace before an unanswered permission is pushed, no
  push to the device already showing the sheet (as it is showing it at the
  deadline — a phone locked mid-grace still gets the buzz), an `ask_resolved`
  under the same collapse id to replace the banner once the last ask sharing that
  banner is answered elsewhere (an earlier settle of a folded pair stays silent,
  so the banner never claims a still-blocking turn is answered), turn-end
  notifications only when nobody is watching (and never for a cancellation), and
  a per-session ask window plus a 60/minute cap that fold extra asks into "+N
  more waiting" instead of a storm — every refusal audited, never silent.
  Design: `docs/feat/mobile-push.md` (slices P5, P6).
