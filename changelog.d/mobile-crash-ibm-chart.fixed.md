- **One chat item that cannot be drawn no longer crashes the iPhone app.** A
  transcript row that fails while rendering is replaced by a small "couldn't
  display this item" note and the failure's error class is written to the app
  log, instead of aborting the app — which, since a session reopens on the same
  rows, used to crash it again on every launch.
