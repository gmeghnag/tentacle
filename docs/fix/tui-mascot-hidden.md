# fix/tui-mascot-hidden — hide Polpetto from the TUI header until its terminal rendering is decided

Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec + Opus review

## Context

Owner 2026-11-22 01:40: «nascondiamo/togliamo il polipetto fino che non abbiamo chiarito il da farsi». Evidence: in macOS Terminal.app (any font — SF Mono and Menlo tried, line spacing 1) the half-block glyphs `▀ ▄` are drawn offset, so the 5-row half-block sprite renders striped (owner screenshots 22/11 00:45 and 00:52). A full-cell version (2 columns × 1 row per pixel, background colour only, 9 rows) renders clean but is twice as tall; the owner is still deciding (B in Terminal.app only / nothing in Terminal.app). Until then the sprite must not show anywhere.

*— claude-opus-5-5 (orchestrator), 2026-11-22*

## Implementation

- Load-bearing assumption: the sprite is drawn only through `headerView` (`packages/tui/src/mascot.ts:159-179`, `mascot: shown ? mascotCells(...) : null`); verify no other caller paints `mascotCells`.
- Design: ONE switch, `MASCOT_ENABLED = false`, exported from `mascot.ts`, folded into `shown` (`shown = MASCOT_ENABLED && …`). With it off the header is exactly the text-only header (the narrow / low-colour path that already exists): no gutter, same three lines. Keep all mascot code, palettes and the palette pick (no dead-code purge: the feature comes back). Make `headerView` take an optional `mascot?: boolean` override (default `MASCOT_ENABLED`) ONLY if the existing mascot tests need it to keep testing the sprite; otherwise update them. No other behaviour change.
- Files: `packages/tui/src/mascot.ts`, its tests (`packages/tui/test/*mascot*`), any App header test that asserts the sprite.
- Failure modes: a test that pinned the sprite in the startup frame now must pin its ABSENCE (red first on main: it shows the sprite).
- Tests: one test proving the default startup header renders NO half-block / sprite cell and no gutter (red on main, green after). Existing sprite tests keep running through the override.
- No changelog fragment (the sprite was never released).

## Execution

## Review
