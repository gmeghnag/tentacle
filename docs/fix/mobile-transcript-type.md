# fix/mobile-transcript-type — fuller transcript text, quieter tool rows (iPhone)

> Type: fix · Size: S · Blast: contained · Suited: DeepSeek executes, Opus review (one round)
> **Branch:** `fix/mobile-transcript-type` · **Changelog:** `changelog.d/mobile-transcript-type.changed.md`

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-22 — owner decision, verbatim intent*

The owner compared the Claude iOS app with tentacle (dark theme): Claude's prose reads fuller and
easier; tentacle's is thin and **the tool rows blend into the prose**. Mockup (open it, it is the
spec): `docs/fix/mobile-transcript-type-mockup.html`, variant **A · Figtree medio** (chosen 22/11).

Verified cause (orchestrator): `apps/mobile/assets/fonts/` bundles only `Figtree-Regular`,
`-Italic`, `-Bold`, `-BoldItalic`. Tokens ask for `fontWeight: "500"` / `"600"`
(`apps/mobile/src/theme.ts:308,314,323`, e.g. `step`), which iOS cannot find in a custom family,
so they render at 400: the step title has the same weight, size and grey as the prose.

## Owner decisions (final)

1. **Bundle Figtree Medium (500) and SemiBold (600)** (+ their italics if the app uses italic at
   those weights, e.g. the «Thinking»/«Thought» label). Figtree is OFL: take the official static
   files from the Figtree release (or Google Fonts), add them to `OFL.txt`/`README.md` in
   `assets/fonts/`. Make every `fontWeight` token actually resolve to its file — check how the
   app maps weight → font file today (Expo font loading / a family helper) and fix it at that ONE
   place, not per component.
2. **Transcript prose (assistant text, lists) at 500 in the DARK theme; stays 400 in the light
   theme** (dark-on-light already reads heavy). Bold inside prose stays 700.
3. **Tool step rows quieter:** title 14 pt, `sec` grey, weight 400; duration 13 pt `sec`;
   «Thought · N s» label 14 pt `sec`. Separation is by size + lightness, never by hue alone
   (owner colour-blind). Do not change the dots/rail (that is `fix/mobile-step-rail`, already
   on main when you start).
4. Nothing else changes: same sizes for prose (16/23), same colours for prose.

## Implementation

*(executor: write it, source-verified per AGENTS §8, before coding — cite file:line)*

## Tests (minimum)

- A unit test that every typography token's `fontWeight` maps to a bundled font file (fails on
  today's tree for 500/600 — red first).
- The prose style resolves to 500 in dark and 400 in light (pure token function, unit-tested).
- Step-row title style = 14 / sec / 400.

## Validation (mandatory, report in Execution)

Simulator screenshots, dark AND light, of a transcript with prose + a Bash step + Thought + a
bold list (like the mockup), plus one before-shot from main. Save under
`docs/fix/mobile-transcript-type/`. End with `SCREENSHOTS: <paths>` and `READY` or
`NOT READY: <why>`.

## Execution

## Review
