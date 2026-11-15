- **The TUI's "in-process fallback" branches are gone with it.** A session's
  `/clear` is always an in-place reset (no more close-and-replace), `Ctrl+X
  Ctrl+S` only ever falls back when the daemon has no `sendNow` (not when the
  session has none), and images are off through the session's own answer rather
  than a missing seam — so those controller members are required instead of
  optional, and a controller that omits one no longer compiles.
