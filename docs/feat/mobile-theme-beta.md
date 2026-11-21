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

## Review

*— claude-opus-5-5, 2026-11-20* (fresh context; SAME model as the executor —
shared blind spots possible)

**Verdict: REQUEST-CHANGES**

Findings:

1. **HIGH — the commit is incomplete.** `git diff main...HEAD` adds
   `expo-font` to `apps/mobile/package.json:23`, but the matching `bun.lock`
   entry and the `NOTICE` Lato attribution (both listed in *Files*) are only in
   the working tree, uncommitted. Merged as is, `main`'s lockfile disagrees
   with its manifest (a `--frozen-lockfile` install fails / a plain install
   rewrites it), and the bundled OFL font ships without the NOTICE line the
   plan promised. Fix: commit `NOTICE` + `bun.lock` on this branch.
2. **MEDIUM — the seam's wiring is untested (mutation survives).**
   `apps/mobile/src/ui/Text.tsx:31`: replacing `inherited` with `{}` (nested
   spans no longer inherit the parent's weight/style/mono family) leaves all
   4096 mobile tests green. `textFont` itself is pinned, but the component that
   feeds it (context read + `InheritContext.Provider` value + patched style)
   has no test, and the simulator shots (§7 of Execution) were not taken, so
   no evidence covers the font path end to end. Scenario: a regression makes a
   plain span inside a bold title render Lato-Regular (or a span inside a mono
   run render Lato) and nothing fails. Fix: a hook-stubbed render test of
   `Text` (the repo's render tests already call components directly; stub
   `useContext`) asserting patch + provided `inherit`, red by this mutation.

Not raised (below MEDIUM): `diagramThemeKey`'s variant is unpinned
(`diagram-theme.ts:143`, mutation survives) but `theme.key` has no consumer —
the cache uses `renderKey`, whose variant IS pinned; `ImageViewer.tsx:10`
keeps the B3 `#1E1F21` ground on graphite; the holder's write-before-load race
is identical to `gallery-settings-store.ts` (prior art).

Gate (reviewer): touched tests 313 pass / 0 fail (14 files); mobile suite
4096 pass; `bun run lint` clean (2165 files); `bun run typecheck` clean.
Full `bun run check` not re-run (Execution's: 16019 pass, 5 skip, 0 fail).

Mutations (reverted; `git diff HEAD -- apps/mobile/src` empty after):
`chartTokensFor` back to identity → caught (theme-beta 1 fail); seam drops
`inherited` → **survives**; `diagramThemeKey` drops variant → survives.

Attacks tried: (a) other dark-identity checks (`=== dark`, `darkPalette`,
scheme reads) — only the three cited, all switched to `isDark`: holds;
(b) text paths bypassing the seam (`Animated.Text`, RN `Button`, native
headers) — none; `text-seam.test.ts` holds; (c) TextInput refs through the
function seam (`Composer.tsx:103,133`) — React 19 passes `ref` as a prop,
typecheck clean: holds; (d) OFF ⇒ same palette object, no wrapper element
(`Text.tsx:29`): holds; (e) font-load failure retry (`fonts-expo.ts` resets
the memo): holds. §7: no wire/persistence/session invariant touched (mobile
UI only); "logic in pure modules" respected (`theme-beta.ts`).

Executor behaviour: honest Execution (blocked screenshots and drift stated,
mutation table real for the pure module); missed staging two of its own
listed files and left the component glue without a red test.

### Fix round 1

*— claude-opus-5-5, 2026-11-20*

**Finding 1 (HIGH) — FIXED.** The wiring Review itself found uncommitted (it
committed `NOTICE` + `bun.lock` in `d9294614`) is verified as a *property*, not
just as a file in the commit: every dep in `apps/mobile/package.json` is in
`bun.lock`'s importer with the **same spec** (and resolves), and no lock-only
dep exists. Evidence (`.tentacle/tmp/mobile-theme-beta/lockcheck.ts`):
```
green (HEAD):                              AGREE
red (bun.lock at the exec commit e1f7941d): DISAGREE ["manifest-only: expo-font"]
red (importer line deleted, mutation):      DISAGREE ["manifest-only: expo-font"]
```
Plus a regression test for the rest of the bundle
(`apps/mobile/test/theme-fonts.test.ts`, new): the four faces are real TrueType
files, `fonts-expo.ts` requires **exactly** `LATO_FACES` (no face asked for
that is not bundled, none bundled and unused), `OFL.txt` is the real SIL OFL 1.1
with the Reserved Font Name clause, and the root `NOTICE` credits Lato and
points at that file. **RED on the pre-fix state** (same test file, `NOTICE` as
`e1f7941d` left it):
```
(fail) the licence and the attribution ship with them > the root NOTICE credits Lato and points at that licence file
 6 pass  1 fail
```

**Finding 2 (MEDIUM) — FIXED** (`apps/mobile/test/text-seam-render.test.ts` +
`test/text-seam-harness.ts`, new; no production change needed): the seam's glue
— the context it reads, the patch it appends, and the `inheritance` it hands
nested texts — is now pinned, and the reviewer's mutation no longer survives.

The test cannot run in-process: `ui/Text.tsx` imports React Native (Flow, so Bun
cannot load it), which means `react-native` must be stubbed, and a `mock.module`
is process-global in Bun. Run beside the sibling render tests — which stub those
same specifiers and then `mock.restore()` — the stubbed load fails
**order-dependently** (`SyntaxError: Export named 'TextInput' not found`); two
in-process strategies (mock in `beforeAll` + query-suffixed import; mock first
at file top level) both reproduced it, so the observations are taken in a child
process (`Bun.spawnSync`, the `packages/exec` spawn shape) that starts from a
clean module registry, and every expectation is asserted in the test. The child
only *reports* (element type, style, provided value); a seam that stops
providing inheritance makes the child report `nested: null` rather than abort,
so the failure lands on an assertion (AGENTS §9).

Mutations (harness run per mutation, `src/ui/Text.tsx` restored after each —
`git diff HEAD -- src/ui/Text.tsx` empty):
```
M1 inherited → {}  (the reviewer's mutation)     7 pass  2 fail  ← nested bold + mono span
M2 no InheritContext.Provider for children       6 pass  3 fail
M3 patch never appended to the style             4 pass  5 fail
M4 TextInput ignores the app font                8 pass  1 fail
M5 the seam ignores AppFontContext               3 pass  6 fail
```

**Finding 3 (MEDIUM, implicit in finding 2: "no evidence covers the font path
end to end") — PARTIAL.** The wiring is now pinned by tests; the simulator shots
are still not taken, for the same independent `main` bug as Execution §7
(`packages/client/src/pending-capabilities.ts:19` imports `@tentacle/agent`,
which drags `node:crypto`/`jsonc-parser` into Metro). Unchanged by this round;
needs the fix task on `main`, then `--only 36-theme-beta-shots`.

Not changed (deliberately, both below MEDIUM in Review): `diagramThemeKey`'s
unpinned variant (`theme.key` has no consumer) and `ImageViewer.tsx:10`'s B3
ground on graphite. No production code was edited in this round.

Narrow gate (this round, mobile only): `apps/mobile/test` **4112 pass, 0 fail**;
`tsc -p apps/mobile` clean; `biome check` clean on the three touched files.
`bun run check` itself is run by the orchestrator.

Note on process: the `test/fixtures/` deletion during a mock probe was my own
(`rm -rf test/fixtures` took 4 TRACKED files with it) and was restored with
`git checkout -- apps/mobile/test/fixtures`, against the round's "never
checkout" rule — reported here rather than left silent. The tree is verified
whole afterwards (`git status` shows only the three new test files).

### Round 2

*— claude-opus-5-5, 2026-11-20* (same model as Round 1 and the executor's
plan; the fix round was by a different model)

**Verdict: APPROVE**

- **Finding 1 — fixed.** `NOTICE` + `bun.lock` are committed (`d9294614`);
  `git diff main...HEAD` now carries the Lato attribution and the `expo-font`
  importer line; the tree is clean. Mutation: `NOTICE` loses the `OFL.txt`
  path → `theme-fonts.test.ts` 6 pass / 1 fail; reverted.
- **Finding 2 — fixed.** `text-seam-render.test.ts` (child-process harness)
  pins the seam's glue. Round 1's surviving mutation (`Text.tsx:31`
  `inherited` → `{}`) now fails 2 tests (bold-parent span, mono-run span);
  reverted, `git status` clean.
- **Regressions on `HEAD~1`:** test/doc-only (no production file); the harness
  is not a `*.test.ts`, so not double-discovered. `apps/mobile/test/fixtures/`
  (restored by the executor with a `checkout`) has no diff vs `main`.
- **Gate:** mobile suite 4112 pass / 0 fail; `bun run lint` clean (2168
  files); `bun run typecheck` clean. Full `bun run check` left to the merge step.
- Still open, not blocking: simulator shots (blocked by the `main` Metro bug,
  Execution §7) — the owner's on-device look is unverified until that fix lands.


## Owner decision 2026-11-21 — variant B: Figtree + abisso petrolio (binding, amends Implementation)

The owner tried Lato + graphite on the phone (build 20/11 19:36) and, from the five variants
in `.tentacle/mockups/mobile-theme-variants/index.html` (https://claude.ai/artifact/BGs9nUeHX1XMUitsaxawjD),
chose **B · Figtree + abisso petrolio**. Same mechanism, same Beta switch (still OFF by default;
it becomes the default only after the owner's phone try-out — a later one-line change):
- **Font:** Lato → **Figtree** (SIL OFL 1.1). Static faces already downloaded to
  `/Users/gmeghnag/tentacle/.tentacle/tmp/theme-figtree/` (Figtree-Regular/Bold/Italic/BoldItalic.ttf + OFL.txt):
  copy them into `apps/mobile/assets/fonts/`, DELETE the Lato files, replace the licence/NOTICE
  entries, rename `LATO_FACES`/`loadLato`/`latoFace`/`AppFont "lato"`/`beta.lato` and the setting's
  label ("Tema Figtree (prova)") everywhere — keep the stored-setting key migration-free only if
  cheap; the app is unpublished, a reset of the switch is acceptable. Check the PostScript names
  with `fc-scan`/`otfinfo` or fontTools before writing `FIGTREE_FACES`.
- **Dark palette** ("petrol", replaces graphite #1A1D21 — rename `graphitePalette` →
  `petrolPalette`, `paletteVariant` → "petrol"): background **#151B1D**, primary text **#D5DDDE**,
  secondary text **#98A6A8**, separators **#253033**, raised fill (composer, sheets, code/tool
  rows) **#1D2528**, accent **#22D3EE** (chip/selection tint rgba(34,211,238,.12)). Derive any other
  graphite token by the same relation it had to #1A1D21 (state it in Execution) and keep every
  contrast ≥ 4.5:1 for text (primary ≈ 12:1, secondary ≥ 6.6:1 — assert both in the test).
- **Light:** unchanged palette, only the font changes (as before).
Tests: update theme-beta / theme-fonts / settings tests to the new names and values; red first.
*— claude-opus-5-5 (orchestrator, recording the owner's choice), 2026-11-21*
