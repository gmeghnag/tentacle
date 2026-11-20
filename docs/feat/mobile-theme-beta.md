# feat/mobile-theme-beta — a hidden Lato try-out theme (Settings → Beta)

> **Status:** execution
> **Branch:** `feat/mobile-theme-beta`
> **Size:** M · **Blast:** cross-module · **Suited:** Opus plan+exec; standard Review + simulator screenshots (no §7 invariant touched: mobile-only, no wire/persisted-session change)
> **Changelog:** `changelog.d/mobile-theme-beta.added.md`

## Context

*— claude-opus-5-5, 2026-11-20*

Owner request (2026-11-20): a HIDDEN try-out theme in the iPhone app, behind a
Settings → Beta switch "Tema Lato (prova)" (OFF by default, like the voice Beta
switches), so the owner can judge it on the real phone before applying it to
the whole app. Reference: a Slack dark message — font **Lato**, graphite
background **#1A1D21**, text ≈ #D1D2D3, secondary ≈ #ABABAD, separators ≈
#2C2D30.

Scope, ON: (1) Lato replaces the system font app-wide (code stays monospace);
(2) dark mode moves the background family to graphite, text/secondary to the
reference, accents unchanged; (3) light mode: only the font. OFF = exactly
today's look. Live (no restart), remembered per device. Owner rules: minimal,
no pure black, WCAG AA text contrast on the new ground.

**Repro** (capability missing on `main`, 2026-11-20):

```
$ grep -rn "Lato\|themeFor\|graphite" apps/mobile/src apps/mobile/App.tsx   # → nothing
$ grep -rln 'Text.*from "react-native"' …                                   # 58 files import RN's Text directly
$ bun test apps/mobile/test/theme-beta.test.ts      (on main + the new test)
error: Cannot find module '../src/theme-beta.ts' …
 0 pass  1 fail  1 error
```

There is no font seam today: `typography` (`theme.ts:287`) is static and spread
into `StyleSheet.create` at module load in 56 files, and ~280 `<Text>` styles
(many with raw `fontSize`/`fontWeight`, e.g. `StepNode.tsx:641`) never touch it.
Patching tokens could neither reach every text nor switch live.

## Implementation

*— claude-opus-5-5, 2026-11-20*

### Load-bearing assumption

**The palette has ONE producer.** `paletteFor(useColorScheme())` is called once,
in `AppShell` (`main:App.tsx:1577`), and every screen/primitive receives
`palette` as a prop (`theme.ts:5` "every primitive takes it as a prop"; `grep
paletteFor` hits only `App.tsx` and `theme.ts`). So swapping the producer swaps
the whole app's colours live, with no screen edit. Verified by grep before any
code.

### Preconditions

- Dark-ness was decided by identity against the one `dark` object in three
  places: `isDark` (`main:theme.ts:183`), `chartTokensFor` (`main:theme.ts:230`),
  `chartScheme` (`main:chart-row.ts:46`). A second dark palette must be
  recognised by all three (else charts/diagrams draw light chrome on graphite).
- Diagram renders are cached on disk by `diagramCacheKey(canonical, scheme, …)`
  (`diagram-cache.ts:40`), and the render's colours come from the live palette
  (`DiagramBlock.tsx:62` → `diagramTheme(palette)`): a graphite render must not
  share the dark key, or a #1E1F21 box shows on a #1A1D21 page.
- Every native header is `headerShown: false` (`App.tsx` Stack.Screen options):
  all titles are RN `Text`, none UIKit — so a Text seam reaches every title.
- RN iOS resolves `fontFamily` + `fontWeight` + `fontStyle` by matching the
  font's family members (`RCTFont.mm`): a 500 left on a Lato text would round to
  Bold (only 400/700 are bundled), so the seam must name the face AND give it a
  weight/style that matches it.
- The settings pattern to copy: `gallery-settings-store.ts` (versioned
  `SecureKV` record, fail-safe read, pick holds for the run even on a failed
  write).
- Lato licence: SIL OFL 1.1 (`OFL.txt` from `google/fonts/ofl/lato`); the files
  ship unmodified (Reserved Font Name kept) with the licence text.

### Design

1. **Tokens** (`theme.ts`): a `graphite` palette = `dark` + the background
   family and text overridden — page/bg `#1A1D21`, drawer `#15171A`, band
   `#1F2226`, card/sheet/bandOnSheet/code `#222529`, fill/codeOnSheet `#2B2E33`,
   label `#D1D2D3`, sec `#ABABAD`, sepChat `#2C2D30`, sep `#34363A`, sepSheet
   `#3A3C40`, glass `rgba(34,37,41,0.86)`, switchOff `#3F4247`. Accents and
   semantic colours are `dark`'s. Same layer order as B3 (drawer < page < band <
   card = sheet < fill). `isDark`/`chartTokensFor`/`chartScheme` accept it.
2. **Pure logic** (`theme-beta.ts`, React-free): `themeFor(scheme, beta,
   fontReady) → {palette, font}` — OFF returns `paletteFor(scheme)` itself (the
   same objects ⇒ token equality by construction); ON: dark → graphite, light →
   light; font `"lato"` only once the faces are registered. `latoFace(weight,
   style)` (≥600/bold names → Bold; else Regular; italic variants).
   `textFont(own, inherited, font) → {patch, inherit}`: mirrors RN's nested-text
   inheritance (a span inside a bold title stays bold; a span inside a mono run
   stays mono); an explicit family (MONO) is never patched. `paletteVariant`
   names graphite for cache keys.
3. **The seam** (`ui/Text.tsx`): the app's ONE `Text`/`TextInput`. Font `null`
   (OFF) ⇒ renders RN's component with the props untouched. ON ⇒ appends the
   `textFont` patch and passes `inherit` to nested texts by context. All 58
   files' `Text`/`TextInput` imports move to it (a mechanical import swap — no
   screen styling changes); `text-seam.test.ts` refuses any new direct import.
4. **Switch + store**: `theme-settings-store.ts` (`tentacle.theme`, `{v:1,
   lato}`, the gallery store's rules) + `theme-settings-expo.ts`; App holds the
   state, loads Lato lazily (`fonts-expo.ts`, `expo-font` `loadAsync`, faces
   registered under their PostScript names) only when ON, computes
   `themeFor(...)` every render (live), provides `AppFontContext`, and passes
   the switch to Settings → Beta (third row, `beta-theme-lato`).
5. **Diagram key**: `diagramCacheKey(..., variant?)` → `base+graphite|…` for
   graphite; `undefined` keeps every stored key unchanged.

Not done (deliberately): the reference's blue mention chip — the app has no
mentions, and the owner fixed "accents unchanged". SVG text in charts/diagrams
is monospace already and unaffected.

### Files

`apps/mobile/`: `src/theme.ts` · `src/theme-beta.ts` (new) · `src/chart-row.ts`
· `src/diagram-cache.ts` · `src/diagram-row.ts` · `src/diagram-theme.ts` ·
`src/theme-settings-store.ts` + `src/theme-settings-expo.ts` (new) ·
`src/fonts-expo.ts` (new) · `src/ui/Text.tsx` (new) · `App.tsx` ·
`src/screens/SettingsScreen.tsx` · 58 import swaps · `assets/fonts/*` (4 TTF +
`OFL.txt` + `README.md`) · `package.json` (`expo-font ~58.0.9`, already in the
lockfile via `expo`) · `e2e/flows/36-theme-beta-shots.yaml` + `e2e/run.ts`
(flow + session var) · tests. Root: `NOTICE` (Lato attribution), `bun.lock`,
changelog fragment.

### Failure modes

- **Font load fails** → palette still switches, text stays system, Settings
  shows "The Lato font didn't load" (`theme-error`); the next ON retries
  (`loadLato` resets its memo on rejection).
- **Switch ON before faces are registered** (cold launch, first toggle) →
  `themeFor` returns `font: null` until `latoReady`: never a family iOS lacks.
- **Store unreadable / newer version / Keychain error** → OFF (never turned on
  by a broken store), never written over; the switch still works for the run.
- **Write fails** → the pick holds for this run, Settings says it didn't save.
- **Toggle mid-session** → one state change re-renders the tree (palette prop +
  context): live. Diagrams re-key (`+graphite`) and re-render on the new page.
- **A new screen imports RN `Text` directly** → `text-seam.test.ts` fails.
- **Nested text** (bold title + plain span, mono run + plain span) → inheritance
  mirrored in `textFont`, tested.

### Tests

- `theme-beta.test.ts` (new, RED first): OFF ⇒ same palette object and equal
  tokens for every scheme, no font; ON ⇒ graphite/light, font only when ready;
  reference hexes; accents unchanged; graphite is dark for `isDark`/charts;
  diagram key differs for graphite and is unchanged otherwise; `latoFace`
  mapping; `textFont` OFF/plain/mono/nesting.
- `theme.test.ts`: graphite joins the WCAG 4.5:1 loop (every text/surface
  pair), plus no-pure-black, layer order, separators ≥ 1.2:1.
- `theme-settings-store.test.ts` (new): the gallery store's suite, on `lato`.
- `text-seam.test.ts` (new, RED first: 58 offenders): no direct RN Text import.
- `settings-beta.test.ts`: the switch's wiring (label, testID, value, write),
  App's `themeFor` is the only producer, two providers, lazy load.
- Mutation per guard (Execution).

## Execution

*— claude-opus-5-5, 2026-11-20*

1. **RED** — `theme-beta.test.ts` written first:
   ```
   error: Cannot find module '../src/theme-beta.ts' from '.../apps/mobile/test/theme-beta.test.ts'
    0 pass
    1 fail
    1 error
   ```
   `text-seam.test.ts` before the import swap:
   ```
   (fail) every text goes through ui/Text.tsx > no file but the seam imports Text or TextInput from react-native
   - []
   + [ "App.tsx", "src/ui/Banner.tsx", "src/ui/ActionSheet.tsx", … 58 entries ]
    1 pass
    1 fail
   ```
2. **GREEN** — tokens, `theme-beta.ts`, diagram key, `ui/Text.tsx`, import swap
   (a codemod over `import { … } from "react-native"`, then `biome check
   --write`), store, loader, App + Settings wiring, flow 36. `tsc -p apps/mobile`
   clean.
3. **Fonts** — fetched from `github.com/google/fonts` `ofl/lato/` into a scratch
   dir, verified as TrueType and their name tables read (family `Lato`,
   PostScript `Lato-Regular|Bold|Italic|BoldItalic`), copied unmodified with
   `OFL.txt`; sha256 in `assets/fonts/README.md`. ~2.7 MB total (Lato 2.015's
   full glyph set). Light not bundled: no weight below 400 is used.
4. **Graphite contrast** (computed, `.tentacle/tmp/mobile-theme-beta/contrast.ts`):
   ```
   label   page 11.17  band 10.55  card 10.16  fill 9.00  drawer 11.86
   sec     page 7.38  band 6.97  card 6.71  fill 5.94  drawer 7.83
   accent  page 9.36  band 8.84  card 8.52  fill 7.54  drawer 9.94
   red     page 6.14  band 5.80  card 5.59  fill 4.95  drawer 6.52
   green   page 8.37  band 7.90  card 7.61  fill 6.74  drawer 8.88
   sepChat/page 1.23  sep/band 1.32
   ```
5. **Mutation** (each applied, test file run, reverted; all restored):
   ```
   OFF dark → graphite                theme-beta  13 pass  1 fail
   font before faces loaded           theme-beta  13 pass  1 fail
   500 counts as bold                 theme-beta  13 pass  1 fail
   ignore inherited (mono) family     theme-beta  13 pass  1 fail
   ignore inherited weight            theme-beta  13 pass  1 fail
   patch weight off the face          theme-beta  13 pass  1 fail
   no diagram key variant             theme-beta  13 pass  1 fail
   isDark misses graphite             theme-beta  13 pass  1 fail
   graphite sec #77777A               theme       142 pass 10 fail
   graphite drawer #000000            theme       151 pass  1 fail
   ```
6. **Drift from Implementation:**
   - The theme state lives in `App()` (`useAppTheme`), with ONE
     `AppFontContext.Provider` at the root around `AppShell theme={theme}` —
     not inside `AppShell`'s two returns: wrapping those re-indented JSX that
     source-pinned tests (`artifact-gallery-wiring.test.ts`) match verbatim, and
     one root provider is simpler anyway.
   - Ten render tests walk components by calling them without React (no hook
     dispatcher), so `useContext` in the seam threw. Each already stubs
     `react-native`'s `Text`/`TextInput` as host strings; each now stubs
     `../src/ui/Text.tsx` the same way (`band-notes`, `chart-labels-render`,
     `commands-sheet`, `chart-view`, `chart-thumbnail-render`, `notice-row`,
     `row-a11y`, `session-info-schedules-render`, `step-thought-marker`,
     `transcript-row-photos`). `pairing-guards.test.ts` lists the tenth
     Keychain wiring file (`theme-settings-expo.ts`).
7. **Simulator screenshots: NOT taken — blocked by `main`.** Flow
   `36-theme-beta-shots` is written and registered, but the phone bundle does
   not build on current `main` (independent of this branch):
   `packages/client/src/pending-capabilities.ts:19` (feat/caps-before-first-message,
   `80320abe`) imports `@tentacle/agent`, which drags the laptop stack into
   Metro:
   ```
   Unable to resolve module node:crypto from packages/agent/src/session-store.ts:
   No resolver is registered for the 'node:' URI scheme.
   ```
   Two throwaway workarounds (both reverted, nothing left in the tree): (a)
   importing `agent/src/capabilities.ts` directly → the same error from
   `packages/tools/src/workload-shell-frame.ts` (Metro does not tree-shake
   `@tentacle/tools`' index); (b) a temporary `metro.config.js` stubbing
   `node:*` → the build passes but the app dies at launch (blank screen):
   `Unhandled JS Exception: Requiring unknown module "./impl/format"`
   (`jsonc-parser`'s UMD build, via `@tentacle/config`). Stopped there (AGENTS
   §0 two-strike). Needs a fix task on `main` (the client must not import
   `@tentacle/agent`'s index — e.g. a pure capabilities module without the
   tools/config index imports); then run
   `bun run e2e:mobile --ios 26 --udid <own sim> --only 36-theme-beta-shots`,
   shots land in `<runDir>/ios26/36-theme-beta-shots/`. The dedicated simulator
   created for this (`tentacle-theme-beta`) was shut down and deleted.
8. **Gate** — `bun run check` (typecheck → lint → test), 2026-11-20:
   ```
   Checked 2165 files in 623ms. No fixes applied.
    16019 pass
    5 skip
    0 fail
   Ran 16024 tests across 1135 files. [518.13s]
   EXIT 0
   ```
   (5 skips, the same count as the first run on this branch before the fixes;
   AGENTS §6 names three opt-in skips — the other two were not identified in
   this run and are not added by this branch: it adds no `skip`.)
