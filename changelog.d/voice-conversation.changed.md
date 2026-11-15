- **The voice conversation core, shared by the Mac and the iPhone
  (`@tentacle/core`'s `voice/`).** Both edges of hands-free voice mode now run
  the same pure, React-free modules instead of each growing its own loop: the
  end-of-turn fold (a comma-safe silence floor, Smart Turn on the Mac, "no new
  recognised text" on the phone, an injected audio clock so every trace is
  testable), the conversation reducer (states and the ordered `speak`/`hush`/
  `listen`/`prompt`/`enqueue` commands; an ask pending suspends every send, a
  phone call never re-opens the mic by itself, a link drop hushes and pauses,
  barge-in stops speech and steers but never cancels, and only the edge that
  started or steered a turn speaks it), the streaming chunker (a ≤ 4-word first
  chunk so speech starts fast, never a cut inside a word or a number, identical
  chunks at any delta split), speakable text (code fences, tables and hrefs
  never read out), tool narration from the tool name only, the ask template,
  and spoken-language resolution. Nothing is user-visible yet: the Mac TUI and
  the iPhone app are wired to these modules in later slices of the same task.
