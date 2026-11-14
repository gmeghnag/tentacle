- **The TUI's turn driver moved out of `App.tsx` into one hook.** `run`, the
  single `streamTurn` loop, its settle, the send-now chord, Enter's `submit`,
  the warm-chunked history commit and `/compact` now execute through
  `packages/tui/src/useTurnDriver.ts`, which owns only its own latches: every
  ref another driver also reads or writes (`sendNowRef`, `streamCtrlRef`,
  `warmingRef`, `wakeRef`, `exitPendingRef`, the clear's arm, …) still lives in
  `App` and is passed in, so each read keeps its source and two keys with no
  render between them behave as before. The decisions remain the existing pure
  modules' (`planSendNow`, `planTurnStart`, `submitPlan`, `afterOldTurn`,
  `onCompactionSettled`, the queue's and `state.ts`'s), and `runRef` keeps its
  late binding. `App.tsx` loses 674 lines. No user-visible behaviour changes.
