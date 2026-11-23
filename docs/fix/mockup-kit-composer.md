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
