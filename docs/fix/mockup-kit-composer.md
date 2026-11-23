# fix/mockup-kit-composer — the mockup kit's composer, hub and Polpetto match the app

Type: fix · Size: S · Blast: contained (`tools/mockup-kit/`, `scripts/mockup-kit/` only — never shipped in the app or the CLI) · Suited: Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 23/11 ~11:25 on the composer-hub mockup v1: «si vede malissimo, renderizzato brutto». Cause (verified with headless screenshots against the owner's real-app screenshot): the kit's `composer` drew + / mic as bare glyphs and ↑ as a light disc while the app puts + and mic in filled `accentSoft` circles (`apps/mobile/src/ui/Composer.tsx:257`); the hub button and Polpetto's palette diverged too. The mockup redo (Opus, 23/11 11:29–11:41) fixed the KIT at the source instead of drawing around it, so every future mockup inherits it. Owner 23/11 ~12:15: «fallo partire ora in parallelo» (review + merge).

## Implementation

Already executed by the mockup agent (commits on this branch): `tools/mockup-kit/kit.js` (composer: accentSoft circles, slot rules; hub glass + cyan dots; new `K.polpetto`), `tools/mockup-kit/kit.css` (`:691,704,723` hub; composer styles), `scripts/mockup-kit/sources.ts:~258` (Polpetto generated from the app's mascot source). The agent reported: kit tests 27/27, lint clean, typecheck clean. Known approximations left: icon glyphs (+ / mic / ↑ / clock), hub blur strength, fan shows letters.

## Execution

*— claude-opus-5-5 (mockup designer), 2026-11-23 — see the commits; no separate executor run.*

## Review

**Verdict: REQUEST-CHANGES.**

Gate (touched files): `bun test scripts/test/mockup-kit.test.ts scripts/test/mockup-kit-png.test.ts` 34 pass / 0 fail; `bun run lint` clean; `bun run typecheck` clean. Full `bun test` not re-run (contained, kit-only diff).

Findings:
1. **MEDIUM — no regression test for the fix (AGENTS §4/§9).** `git diff main...HEAD` touches no test; nothing references `K.polpetto`, `K.icon`, `composerParts`, `caption`, `.k-circle`'s `accentSoft` or the new slot faces. Failure scenario: reverting `tools/mockup-kit/kit.js:213-290` to the old bare `+`/🎙︎/light-disc markup (the exact owner-reported defect) keeps all 34 tests green. Needed: a test that pins the composer's + / mic in a `k-circle`, the four slot faces, `polpetto` rects = `pixels(stillFrame())` and its unknown-frame throw — shown red on `main`.
2. **MEDIUM — `tools/mockup-kit/kit.css:691` `blur(calc(12 * 1px)) saturate(1.4)` evades the kit's no-literal-px rule** (`scripts/mockup-kit/kit-rules.ts:51-56` exempts `1px`, so `12 * 1px` passes). A hand-picked number enters the "generated from source" kit disguised as a hairline; the next agent copies the trick. Either extract/declare it as a named, documented approximation token, or extend `literalViolations` to catch `calc(N * 1px)` and allowlist this one line explicitly.

Attacks tried: (a) every new `var(--…)` (`c-sep`, `c-fill`, `c-accent-soft[-strong]`, `c-page`, `m-composer-flex-flex`, `m-composer-rec-square-*`, `m-composer-caption-min-width`) exists in `generated/tokens.css` — holds (also the existing defined-vars test). (b) e2e trace (scratch `r.ts`): `polpetto` still = 34 rects 54×54, bottom 76 = `HOME_INSET_PT`; skate has `minX −6` handled by `x0`, `minY 0` so the un-handled negative-y case is latent only; geometry `{SPRITE, SPRITE+INSET}` gives home (0,0) per `mascot-scenes.ts:113-118` — holds. (c) TDZ: `composer()` reads `composerParts` declared after it, but only at call time; `SLOT`/`MIC` call hoisted `icon()` after `ICON`/`WEIGHT` — holds. (d) `kit-data.json` drift vs source — "no drift" test green. (e) `kit.d.ts` not updated, but `[component: string]: unknown` covers new builders — no type break.

Premises: `Composer.tsx:257` accentSoft circles — not opened (style claim, see finding 1: nothing pins it). Mutation: not run for new tests (none exist); finding 1 is the vacuity.

Executor behaviour: fixed the kit at the source (good), honest about approximations in the doc, but shipped without a test and bypassed a kit rule rather than surfacing it. Reviewer is the same model family as the executor (fresh context only).

*— claude-opus-5-5, 2026-11-23*
