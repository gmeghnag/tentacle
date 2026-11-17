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

### Load-bearing assumption (verified)

The shimmer costs no new timer and needs no App change: `Thinking.tsx:19-22` already
re-renders every 80 ms on its own interval (`FRAME_MS`), and `AppView.tsx:160-167`
mounts `<Thinking>` with `label` = `"Thinking…"` / `"Working…"`. **Evidence** (repro,
`.tentacle/tmp/tui-thinking-shimmer/probe.tsx`, `FORCE_COLOR=3`, 5 frames at 90 ms):
5 distinct frame texts (spinner), **1 distinct SGR sequence set** — the label is one
flat `#06b6d4` run today, so the capability is genuinely missing and only the
component's colour mapping has to change.

### Preconditions

- `packages/tui/src/cells.ts:14` `cellWidth` (string-width) is the repo's cell
  measure; its grapheme splitter (`cells.ts:11-21`) is private — it is exported
  (`graphemes`) so the sweep can be cell-aware without a second `Intl.Segmenter`.
- `theme.ts:351` `palette()` is the component colour path; `theme.ts:236` `tokens`
  carries BOTH modes and `theme.test.ts:139-152` requires identical key sets, so a
  new token goes into `Tokens` + `DARK` + `LIGHT` or the gate fails.
- `test/theme-contrast.test.ts:121` `TEXT_ROWS` is the light-mode readability gate
  (4.5:1 truecolor AND as chalk actually paints at 256) — the two new light tokens
  join it.
- `Thinking.tsx:11` `FRAME_MS = 80` is the only clock; the sweep steps once per
  tick, so the period must land in 1.2–1.6 s for `Thinking…`/`Working…`.
- Ink supports nested `<Text color>` inside a `<Text>`; per-span SGR is asserted by
  the child-process probe (ink-testing-library's `lastFrame()` strips SGR).

### Design

`shimmerSpans(label, tick, opts)` — pure, cell-based:

- Split `label` into graphemes with their cell start/width (`graphemes` + `cellWidth`).
- `total = cellWidth(label)`; `sweep = total + SHIMMER_WINDOW - 1` (the 3-cell window
  slides from fully left to fully right); `period = sweep + pauseTicks`.
- `phase = tick mod period`; `peakCell = phase - 1` (window = `peakCell-1 … peakCell+1`),
  so `phase 0` is the entry (leftmost cell is `mid`), `phase 1..total` puts the peak on
  every cell in turn, `phase total+1` is the exit, and the remaining `pauseTicks`
  phases paint the whole label `base`.
- A grapheme whose cell range contains `peakCell` → `peak`; else overlapping the
  window → `mid`; else `base` (a 2-cell grapheme the window only clips stays `mid`,
  never half-painted). Adjacent equal tones merge, so the common case is 1–3 spans.
- `opts.color === false` (or an empty label) → `[{ text: label, tone: "base" }]`: no
  sweep at all, which is also the "no animation" contract.
- Invariant: `spans.map(s => s.text).join("") === label`, always.

Period at one step per 80 ms tick: `Thinking…` = 9 cells → sweep 11 + pause 5 = 16
ticks = **1.28 s**; `Working…` = 8 cells → 15 ticks = **1.20 s**. In budget.

`theme.ts`: `Tokens.shimmer = { mid, peak }` (nested like `status`/`meter`).
Dark `mid #22d3ee` / `peak #67e8f9` (brighter cyan on the dark terminal — the light
gate does not police dark). Light `mid #0b4a57` / `peak #083344` (darker = "brighter"
on paper; measured 9.85 / 13.40 truecolor and 7.03 / 7.49 at chalk-256, both ≥ 4.5).
`base` stays `accent`, so nothing re-paints where the label sits today.

`Thinking.tsx`: unchanged spinner glyph, `useElapsed` and single 80 ms interval
(now reading `SHIMMER_TICK_MS` from the module so there is one constant). It maps
`tone → palette().shimmer.{mid,peak} | palette().accent` and renders the spans as
nested `<Text>`s inside the existing accent `<Text>`; `chalk.level > 0` decides
`opts.color`. No stdout writes, no new timers.

### Files

1. `packages/tui/src/cells.ts` — export the existing `graphemes` (+1 word).
2. `packages/tui/src/shimmer.ts` — **new** pure module (tone/span types, `SHIMMER_WINDOW`,
   `SHIMMER_PAUSE_TICKS`, `SHIMMER_TICK_MS`, `shimmerSpans`, `shimmerPeriod`).
3. `packages/tui/src/theme.ts` — `Tokens.shimmer` + dark/light values.
4. `packages/tui/src/components/Thinking.tsx` — span → colour mapping.
5. `packages/tui/test/shimmer.test.ts` — **new** pure suite.
6. `packages/tui/test/thinking-shimmer-frames.test.tsx` — **new** ink-testing-library
   frame test: stripped-text identical across ~15 ticks (a full period).
7. `packages/tui/test/thinking-shimmer-probe.tsx` + `test/thinking-shimmer-sgr.test.ts`
   — **new** child-process (FORCE_COLOR=3) probe: same text, different SGR, peak
   moves left → right, pause frames are all-base.
8. `packages/tui/test/theme-contrast.test.ts` — two light rows.
9. `changelog.d/tui-thinking-shimmer.changed.md`.

### Failure modes

- **Text drift** (a span boundary adding/dropping a space or cell) → the pure
  invariant + the frame test (text identical across a whole period) + the probe's
  identical-text assertion across ticks.
- **Wide/ambiguous cells** (`…`, CJK, emoji) → pure tests over a 2-cell label: the
  sweep still visits every cell, text unchanged, and no span splits a grapheme.
- **Empty label** / paused tick / `pauseTicks: 0` → one `base` span; no `phase % 0`.
- **Non-positive tick** — not reachable from the component, but `tick mod period`
  is taken modulo-safe so it cannot throw.
- **Colour off** (`NO_COLOR`, non-TTY: `chalk.level === 0`) → single base span, i.e.
  byte-identical to today's label; the component still adds no colour of its own.
- **Light theme unreadable** → the contrast gate rows.
- **Extra timers / stdout writes** → grep-guard: `Thinking.tsx` keeps exactly one
  `setInterval`, and the module imports nothing from `process`.

### Tests (red first)

Pure: window sequence over one period (peak visits each cell 0..total-1 once, in
order), pause frames all-base, wrap (`tick = period` == `tick = 0`), `…` and a
2-cell CJK label, text invariance for every tick of a period, `color:false` shape,
perf/period budget (1.2–1.6 s at 80 ms).
Frame: text identical every tick of a period; probe: SGR differs, text identical.

## Execution

## Review
