# feat/tui-thinking-shimmer — a light sweep across "Thinking…" / "Working…" in the TUI

> **Status:** implementation pre-approved (orchestrator 2026-11-17; owner decided the look) — executor writes the short plan, then implements
> **Branch:** `feat/tui-thinking-shimmer`
> **Size:** S · **Blast:** contained (one TUI component + a pure module) · **Suited:** DeepSeek exec + Opus review
> **Changelog:** `changelog.d/tui-thinking-shimmer.changed.md`

## Context

Owner 2026-11-17: "Il riflesso sulla parola Thinking e Working mettiamolo nella TUI". Today `packages/tui/src/components/Thinking.tsx` shows `⠙ Thinking…` (or `Working…`, `AppView.tsx:166`) in the flat accent colour; the braille spinner already re-renders every 80 ms. The owner wants the same "shimmer" as mobile mockup variant D: a soft highlight that sweeps across the WORD, left to right, then a short pause, repeating.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Pre-approved shape (AGENTS §7 "logic in pure modules"):
- New pure module `packages/tui/src/shimmer.ts`: `shimmerSpans(label, tick, opts?) → { text, tone }[]` where tone ∈ `base | mid | peak`; a 3-cell window (mid · peak · mid) moves one cell per tick across the label, then `pauseTicks` ticks with no highlight; cell-aware (`…` and wide chars count as their terminal width — reuse the repo's width helper); concatenated text === label always (no layout shift, ever).
- `Thinking.tsx` only maps spans to `<Text>` colours: base = today's accent, peak = a brighter tone, mid = between — derived from the theme palette for BOTH dark and light themes (add tokens to `theme.ts` if needed; contrast checked). Keep the spinner and the timer as they are; reuse the existing 80 ms interval (a sweep step every 1–2 ticks — pick so one sweep ≈ 1.2–1.6 s incl. pause).
- No colour (NO_COLOR / no-colour theme / non-TTY) → plain label, no animation.
- Tests: pure (sequence of windows over a full period, pause, wraps, `…`/wide char widths, text invariance), and an ink-testing-library frame test that the rendered line's TEXT is identical across ticks (only colours change — use the repo's SGR-preserving capture if one exists, else assert spans).
- Never write to stdout directly; no new timers.

## Execution

## Review
