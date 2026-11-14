- **The TUI's `App.tsx` no longer carries dead imports, and its effect count reads
  22 everywhere.** The decomposition's moves left 28 names imported that no line
  used (`attachErrorText`, `applySessionEvent`, `startTurn`, `failTurn`,
  `SLOT_LOST_NOTICE`, the send-now constants, `dockKindOf`, `modelErrorNotice`, the
  queue's writers, …) — invisible to `tsc` (`noUnusedLocals` is off) and to Biome,
  so nothing was catching them; they are gone, along with one sentence fragment a
  move left behind. The structure comments and test titles that quoted "20
  effects" now say 22 and name where the extra two came from (session-hop's
  `targetFeed` subscription and its idle `hopIfQueued`), and the plan records the
  measured shape of the file (1,942 lines: 22 effect bodies, 60 hook calls, no
  feature logic) instead of a size target it does not meet. No user-visible
  behaviour changes.
