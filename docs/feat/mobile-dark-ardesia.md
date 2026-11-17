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
*— claude (executor; exact model id not exposed by this harness), 2026-11-17*

Followed the Implementation, no drift.

1. **Verified the load-bearing assumption** with the plan's own `rg`: the only
   dark-ramp hexes live in `apps/mobile/src/theme.ts`; the other hits were
   `src/screens/artifacts/ImageViewer.tsx:10` (`const GROUND = "#1F1F1E"`), two
   doc comments (`src/ui/Sheet.tsx:12-13`, `ImageViewer.tsx:4`), and test pins
   (`test/theme.test.ts`, `test/artifact-viewers-wiring.test.ts:138`).
   `apps/mobile/app.json` has no `backgroundColor`/splash colour and there is no
   `app.config.*`, so no launch-flash colour to follow.
2. **`apps/mobile/src/theme.ts`** — the `dark` palette is B3 exactly: `bg`/`page`
   `#1E1F21`, `card`/`sheet`/`code` `#28292C`, `bandOnSheet` `#28292C`, `fill`/
   `codeOnSheet`/`sepChat` `#313236`, `band` `#242528`, `drawer` `#19191B`,
   `label` `#EDEEF0`, `sec` `#A0A3A8`, `sep` `#37383C`, `sepSheet` `#3D3E42`,
   `glass` `rgba(40,41,44,0.86)`, `switchOff` `#434448`. `glassBorder`,
   `shadowOpacity` 0.35, `scrim` `rgba(0,0,0,0.45)` were already the B3 values.
   No `sheetBehind` key exists in `Palette`, so nothing to set. Accent, green,
   orange, red, warn, diff, syntax, camera and dash tokens are untouched; the
   light palette is untouched.
3. **The one hard-coded surface** — `ImageViewer.tsx`'s `GROUND` is the page
   ground, so it moved to `#1E1F21` (with its two comments). `Sheet.tsx`'s
   comment now names `#1E1F21`/`#28292C`.
4. **Tests.** `test/theme.test.ts`: the pinned ramp block is now `B3` (renamed
   describe, the same `satisfies Partial<Palette>` shape, added the owner's six
   as an explicit test and a cool-neutral assertion — blue channel largest —
   that fails on B1's warm ramp), plus the `band`/`bandOnSheet` pins and the two
   ground comments. `test/artifact-viewers-wiring.test.ts:138` pins the new
   ground. Colour still comes from `darkPalette`, so every behavioural test
   (`band-screens`, `chart-row`, `band-wiring`) is unchanged and green.
5. **Red before green:** with the new tests in place and `src/theme.ts` stashed
   back to B1, `bun test test/theme.test.ts` → **4 fail / 101 pass**; with the
   implementation → **105 pass / 0 fail**.
6. **Gate (touched surface only, per the owner's budget):**
   `bunx tsc -p apps/mobile` clean, `bunx biome check apps/mobile` clean (552
   files, no fixes), `bun test test/theme.test.ts test/artifact-viewers-wiring.test.ts
   test/band-screens.test.ts` → 150 pass / 0 fail. No contrast threshold was
   weakened and no contrast test failed: B3's `fill` is *lighter* than B1's, so
   the dark `red` (#FF6D65) keeps its ≥4.5:1 margin, and `sec` on `card` is
   fine (the whole existing contrast block passes unchanged).
7. **Changelog:** `changelog.d/mobile-dark-ardesia.changed.md`, one bullet.
   `CHANGELOG.md` untouched. Not committed (per the brief).

## Review
