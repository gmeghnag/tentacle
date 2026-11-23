# fix/tui-running-bullet-grey — a running step's bullet is grey, the outcome colours it

Type: fix · Size: S · Blast: contained (TUI rendering, one line) · Suited: orchestrator

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 23/11 ~13:50: «un comando/intent deve avere il pallino grigio lampeggiante (grigio come il comando riportato sotto l'intent), e cambiare colore a rosso/verde solo in base all'esito». The running bullet was `theme.accent` (cyan) for every tool row (`packages/tui/src/render-lines.ts:702-704`, `bullet()`).

## Implementation

`bullet()` returns `theme.subtle(BULLET)` while running (the grey of the `$ command` line); the blink is unchanged; ok → success, error → error as before. Applied to every running tool row (one shared `bullet()`). Test: `packages/tui/test/shell-intent-rows.test.ts` pins the grey running bullet (red on main, green after). Mobile unchanged.

## Execution

*— claude-opus-5-5 (orchestrator), 2026-11-23* — `bun test packages/tui` 2982 / 0; Biome clean; red shown first.

## Review

*— claude-opus-5-5 (orchestrator), 2026-11-23* — S, contained: in-context review. Note: the reply bullet (`fix/tui-reply-bullet-white`) has no colour, so on a light terminal it is black like the text, automatically.
