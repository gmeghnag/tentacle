# fix/tui-click-dollar-row — the `⎿ $ cmd` row of a shell tool toggles it like the header

> **Status:** context
> **Branch:** `fix/tui-click-dollar-row`
> **Size:** S · **Blast:** contained · **Suited:** Sonnet plan+exec (self-approve for S), Opus review
> **Changelog:** `changelog.d/tui-click-dollar-row.fixed.md`

## Context

Owner 23/11 ~17:45: in the TUI only a tool row's HEADER (the intent sentence / title) is a click target. Since `fix/tui-shell-row-collapsed` the command sits on the `⎿ $ cmd  exit=N` row, which is where one naturally clicks to see the whole command, and that row does nothing (repro 23/11 on main: a click on head+1 leaves the block closed). Fix: for shell rows the `$` row (and its continuation rows when expanded) toggles too; output rows stay plain text (selection). Likely files: `packages/tui/src/tool-hit.ts` + `packages/tui/test/app-shell-row-collapsed.test.tsx` (SGR mouse helpers in `packages/tui/test/app.test.tsx`). Red first via a real-App frame test (AGENTS §1, §9).

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

**APPROVED (self, S, orchestrator rule)** — no owner-visible choice: a click target, no new glyph/layout.

**Load-bearing assumption (proved by reading):** a click is resolved ONLY against `LaidItem.start` — `toolCallAt` returns the id iff `absRow === item.start` (`tool-hit.ts:62`), and `LaidItem` carries no per-row info (`render-lines.ts:1613-1629`, built at `:1669`). The `$` row of a shell block is row 1 (described, `shellIntentLines` `:1101`) or, expanded plain shell, row 1+ (`:1122`); collapsed plain shell has `$` ON the header (`:1126`, already a hit). So nothing but a row count is missing. To be confirmed red-first by the real-App frame test (§1).

**Preconditions:** `dollarRows` (`:1185`) is the single source of the `$`/continuation/exit-spill rows and they are already width-fit (`wrapLines(room)`), so no re-wrap shifts them; `showDollar` is true in every `shellBlock` call except collapsed plain shell (`:1127`) where there are none; output/body rows follow `dollar` (`:1166`), so "first N rows after header" = the `$` rows.

**Design:** add `toggleRows: number` to `LaidItem` (rows from `start` that toggle; 1 for non-shell tools). Pure helper `shellToggleRows(tool, opts)` next to `shellIntentLines`/`plainShellLines`: `0` extra for non-shell, queued, or plain-collapsed; else `1 + dollarRows(row, cols, expanded).length` (header + `$` rows; empty-command case yields 0 or the exit-only row — both fine). `layoutTranscript` fills it for `tool` items named `shell`. `toolCallAt` returns id when `start <= absRow < start + toggleRows`. Output rows (after the `$` rows), body, blanks stay text/selection.

**Files:** `packages/tui/src/render-lines.ts` (LaidItem field, helper, `layoutTranscript`), `packages/tui/src/tool-hit.ts` (range test + header doc comment), `packages/tui/test/tool-hit.test.ts`, `packages/tui/test/app-shell-row-collapsed.test.tsx`, `changelog.d/tui-click-dollar-row.fixed.md`. Fix any other `LaidItem` literals (tests) for the new required field.

**Failure modes:** non-shell tool → 1 (unchanged); shell with long command expanded → every continuation + exit-spill row toggles; click on first output row → no toggle (boundary); running/queued shell (no body) → `$` row toggles, harmless; scrolled-up/out-of-viewport clicks still bounded by `toolCallAtViewport`; expanded↔collapsed changes the count, but layout is rebuilt from `expandedIds` per click so it is never stale (cache is per-slot rows only; count computed from the same opts).

**Tests (red first on current code):** (1) real-App frame test in `app-shell-row-collapsed.test.tsx`, copying the SGR helpers of `app.test.tsx`: click head+1 of a described shell → block expands (red: stays closed); click again → collapses; click on an output row → unchanged. (2) `tool-hit.test.ts`: `$` row, continuation rows and the exit-spill row of an expanded multi-line command hit; first output row → null; non-shell second row → null. (3) mutation: set `toggleRows` to 1 → tests fail.

*— claude-sonnet-5-5, 2026-11-24*

## Execution

## Review
