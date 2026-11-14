- **The TUI's last inline decisions are pure modules with their own tests.** Five
  rules that `App.tsx` decided inside effects and callbacks are now named,
  React-free functions: `anchorOffset` (`scroll.ts`, the rows-changed scroll
  anchor), `pasteTarget` (`paste.ts`, where a paste lands — reply, panel, or an
  attachment), `exitOutcome` and `jobOutputEntry` (`job-drawer.ts`, a job exit's
  dock outcome and the one cache entry a `job_output` read produces, which the
  App had been building in two places), and `tryWake` (`wake-gate.ts`, the
  autonomous-wake gate the App derived twice). The effects and callbacks stay
  where they were, so the effect list keeps its order; only the decisions moved,
  each pinned by its failure modes. No user-visible behaviour changes.
