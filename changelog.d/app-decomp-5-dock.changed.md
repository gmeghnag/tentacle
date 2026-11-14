- **The TUI's background dock is a module of its own.** The sub-agent and shell-job
  rows, the dock's focus/drafts/sent state, the per-job output cache and the four
  dock actions (`killChild`, `killJob`, `toggleAgents`, `submitToTarget`) moved
  out of `packages/tui/src/App.tsx` into `packages/tui/src/useDock.ts`, so a
  change to the background dock no longer collides with every other TUI feature
  in one file. Every decision still lives in the pure modules it already lived in
  (`background-focus.ts`, `background-list.ts`, `job-drawer.ts`), and the four
  dock effects stay in `App` in their original order — no user-visible behaviour
  changes.
