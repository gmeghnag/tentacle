# fix/tui-click-dollar-row — the `⎿ $ cmd` row of a shell tool toggles it like the header

> **Status:** context
> **Branch:** `fix/tui-click-dollar-row`
> **Size:** S · **Blast:** contained · **Suited:** Sonnet plan+exec (self-approve for S), Opus review
> **Changelog:** `changelog.d/tui-click-dollar-row.fixed.md`

## Context

Owner 23/11 ~17:45: in the TUI only a tool row's HEADER (the intent sentence / title) is a click target. Since `fix/tui-shell-row-collapsed` the command sits on the `⎿ $ cmd  exit=N` row, which is where one naturally clicks to see the whole command, and that row does nothing (repro 23/11 on main: a click on head+1 leaves the block closed). Fix: for shell rows the `$` row (and its continuation rows when expanded) toggles too; output rows stay plain text (selection). Likely files: `packages/tui/src/tool-hit.ts` + `packages/tui/test/app-shell-row-collapsed.test.tsx` (SGR mouse helpers in `packages/tui/test/app.test.tsx`). Red first via a real-App frame test (AGENTS §1, §9).

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

## Execution

## Review
