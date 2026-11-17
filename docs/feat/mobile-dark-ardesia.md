# feat/mobile-dark-ardesia — the dark theme becomes "Ardesia neutra" (B3)

> **Status:** implementation approved (owner 17/11)
> Type: feat · Size: S · Blast: contained · Suited: DeepSeek exec + standard review

## Context
*— claude-opus-5-5, 2026-11-17*

Owner 17/11: "per lo sfondo dell'app mobile metti default page #1E1F21 card #28292C fill #313236 label #EDEEF0 sec #A0A3A8 sep #37383C — B3 · Ardesia neutra #1E1F21 — grigio freddo, si sposa con l'accento ciano; meno «caldo» del riferimento."
Source of the full B3 token set: `.tentacle/mockups/mobile-chrome/index.html:181-186` (`const darkB3`). Today's dark palette is warm (`apps/mobile/src/theme.ts:127-170`, page `#1F1F1E`). Light theme unchanged.

## Implementation
*— claude-opus-5-5, 2026-11-17*

- Load-bearing assumption: every dark surface colour comes from the dark palette object in `apps/mobile/src/theme.ts` (no hard-coded warm greys elsewhere). Verify: `rg -n -i "#1F1F1E|#2A2A28|#33332F|#F2F1EC|#A3A19B|#3A3936|#1A1A19|#403F3B|#33322F|#45443F" apps/mobile/src apps/mobile/app.json apps/mobile/app.config.*` — every hit outside theme.ts (splash/background colour in app config, native status bar, a test) must follow.
- Design: in the dark palette set exactly (owner's six + the B3 companions from the mockup):
  page/bg `#1E1F21` · card/sheet `#28292C` · fill `#313236` · code `#28292C` · codeOnSheet `#313236` · band `#242528` · bandOnSheet `#28292C` · drawer `#19191B` · label `#EDEEF0` · sec `#A0A3A8` · sep `#37383C` · sepChat `#313236` · sepSheet `#3D3E42` · glass `rgba(40,41,44,0.86)` · glassBorder unchanged · shadowOpacity 0.35 · scrim `rgba(0,0,0,0.45)` · switchOff `#434448` · sheetBehind (if the key exists) `#131315`.
  Everything else (accent cyan, green, orange, red, warn, diff, syntax, camera, dash) unchanged.
- Files: `apps/mobile/src/theme.ts`; any hit of the rg above; tests pinning the old values (contrast tests must still pass — if a contrast test fails, report the pair, don't weaken the threshold).
- Failure modes: a contrast test failing for `sec` on `card` → report; app.json `backgroundColor`/splash still warm → update it too (it flashes on launch).
- Tests: a theme test pinning the six owner values (red on main → green); existing contrast tests green.
- Changelog: `changelog.d/mobile-dark-ardesia.changed.md` — one bullet.

## Execution

## Review
