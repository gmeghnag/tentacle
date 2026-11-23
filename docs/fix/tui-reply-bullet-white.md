# fix/tui-reply-bullet-white — the TUI reply's bullet has the reply text's colour

Type: fix · Size: S · Blast: contained (TUI rendering, one line) · Suited: orchestrator (owner: «si può fare al volo?»)

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 23/11 ~13:45: «sul TUI il pallino della risposta del modello deve essere bianco come il suo testo». The reply's first row was `theme.accent(BULLET) + text` (`packages/tui/src/render-lines.ts:159`), so the dot was the brand accent (cyan) while the text is the terminal's default foreground.

## Implementation

The bullet is printed without colour, like the text (`render-lines.ts:159`). Tool rows keep their outcome bullets (accent while running, success/error after) — unchanged. Test: `packages/tui/test/render-lines.test.ts` «the reply's bullet has the reply text's colour…» (red on main: the row started with the accent SGR; green after).

## Execution

*— claude-opus-5-5 (orchestrator), 2026-11-23* — done as above; `bun test packages/tui` 2982 pass / 0 fail; `tsc --noEmit` clean; Biome clean on the two files. Red shown before the fix.

## Review

*— claude-opus-5-5 (orchestrator), 2026-11-23* — S, contained, one line + one test: in-context review per AGENTS §10 (contained, S). Non-vacuity: the test failed on the unchanged code. Mobile has no reply bullet (no parity change).
