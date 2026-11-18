- **A chat opens at its end, without scrolling through it.** A long session now
  lands on its newest message on the first frame: the list is laid out and
  scrolled while hidden (never animated on the initial landing), then shown once
  the end stops moving, so a reopen no longer flies through the whole history.
  Coming back to the app also resyncs silently — no spinner, no jump for someone
  reading further up — and pull-to-refresh, Retry and Reopen all re-arm the same
  silent landing.
