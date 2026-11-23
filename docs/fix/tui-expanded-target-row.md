# fix/tui-expanded-target-row — one expanded shape for every tool row

Type: fix · Size: S · Blast: contained (TUI rendering) · Suited: orchestrator (owner: «fixiamo al volo la vista espansa»)

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-24*

Owner 24/11 ~00:25 (screenshot): in the expanded view (ctrl+o / a clicked row) Edit/Read rows still drew the target on an `  │ <path>` row above `⎿ edited …` — the old, misaligned shape `fix/tui-shell-row-collapsed` removed for shell rows only (`packages/tui/src/render-lines.ts` generic branch, `commandRows`). Diffs missing after a resync are a separate, known limit (rebuilt rows carry no `detail`, `state.ts:835`) — owner: NOT now (no extra weight in the session history).

## Implementation · Execution

Expanded non-shell rows: `● <Label> <dur>` / `⎿ <whole target, wrapped>` / body at col 2 — the shape of a shell row's `⎿ $ cmd`. New `targetRows()` next to `commandRows()`; the generic branch uses it when expanded. Tests: `render-lines.test.ts` (an Edit's expanded rows; a sub-agent's description `⎿ find bug`) red first; two test helpers that skipped the old `│` rows now also skip the `⎿ <path>` target row (`render-lines.test.ts` spilled body, `read-highlight.test.ts`). `bun test packages/tui` 3005/0, `tsc --noEmit` clean, Biome clean.

## Review

*— claude-opus-5-5 (orchestrator), 2026-11-24* — S, contained: in-context review. Collapsed rows unchanged; only the header stays a click target (as today).
