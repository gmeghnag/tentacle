# feat/app-icon-polpetto — the iPhone app icon is Polpetto (light + dark + tinted)

Type: feat · Size: S · Blast: contained (app assets + `app.json`) · Suited: orchestrator (owner: «velocemente, senza troppi workflow, lasciando tutto pulito»)

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 23/11: liked mockup variants **A** (graphite, mint Polpetto) and **G** (light background, mint Polpetto) — https://claude.ai/artifact/D48dfz4Q6bjsJiutY5XQQW — → G as the light/default icon, A as the iOS 18+ dark icon, plus the tinted (monochrome) variant. «Mi cambi il logo dell'app e mi ribuildi l'app?»

## Implementation · Execution

Three 1024 px PNGs rendered pixel-exact (no blur) from the owner's 9×9 bitmap (`packages/tui/src/mascot.ts` `MASCOT_BITMAP`) and the mint palette (`tokens.dark.mascot.tones.mint`), sprite = 62 % of the canvas (70 px per pixel), centred: `apps/mobile/assets/icon-ios-light.png` (#EEF2F1, opaque), `icon-ios-dark.png` (#151A1D, opaque), `icon-ios-tinted.png` (luminance grey on transparent). `apps/mobile/app.json` gains `expo.ios.icon: {light, dark, tinted}` (Expo 58); `expo.icon` (`assets/icon.png`, the vector logo) stays for any other platform. `bun test apps/mobile/test`: 4612 pass / 0 fail.

## Review

*— claude-opus-5-5 (orchestrator), 2026-11-23* — assets + config only, no code path; the device check is the owner's (home screen light/dark/tinted).
