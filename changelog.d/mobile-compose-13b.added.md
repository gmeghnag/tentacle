- **Mobile offline outbox and drafts (task 13b).** The Expo app now has its own
  pure, React-free model for what the phone wrote while it could not reach the
  daemon: one item per compose tap — a prompt or a steer — carrying the
  idempotency key it will use, minted once and written to a versioned, atomically
  replaced file before the first attempt, so a retry after a drop, an app kill or
  a daemon restart runs exactly once; a re-sync decides what goes out by itself
  (only when nothing changed since the person wrote it), what a person must
  settle, and what belongs back in the field, and a returned steer is given back
  and reclaimed once from a persisted id set. Drafts are kept per
  `(computer, session)`, debounced and flushed on background. No screen changes
  yet: this is the model the compose screen (13d) renders.
