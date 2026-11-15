- **Pairing from a phone off the computer's network works.** The app races the
  pairing QR's addresses like it already races a paired computer's, so a dead LAN
  or Tailscale address no longer leaves pairing on "Connecting…" before the relay
  is ever tried. The race lives in `@tentacle/client` now (the mobile app imports
  `firstAnswering` from there), and it gained two options the link never needed:
  a caller-supplied "this failure is the computer's verdict" rule (pairing's
  refusal, so a spent code is never re-tried on another address) and an
  open-only deadline (15 s, after which "nothing answered" is an honest
  `unreachable` instead of a hang — the exchange itself still waits on a human).
  Cancel now closes every socket the race opened, not just the last one.
