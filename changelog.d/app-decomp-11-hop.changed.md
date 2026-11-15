- **The TUI's `/move` execution left `App.tsx`, and the turn boundary is one
  rule.** `startHop` (the one place the view moves: the switching latch, the
  phase row, the `keepTranscript` swap), `requestHop` (a typed `/move`: the
  grammar, the boundary, then start it or leave it queued) and `hopIfQueued` (the
  queued hop's start at the first true idle) — plus the state they own — are now
  `packages/tui/src/useHop.ts`, a hook that declares no effect, so the App's
  effect list keeps its order, and the idle effect that starts a queued hop stays
  where its trigger is. "May a hop start now?" is ONE named pure rule,
  `hopReady` (`hop-command.ts`), used by both paths: it was written out twice,
  inside `hopStep` and inline in `hopIfQueued`, which is how the typed and queued
  paths drift into disagreeing. `App.tsx` loses 107 lines and no longer reads the
  daemon's queue to decide it. No user-visible behaviour changes.
