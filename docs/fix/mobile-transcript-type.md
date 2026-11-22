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

*— deepseek-v4-pro (executor), 2026-11-22*

### Load-bearing assumption (proved first)

**A `fontWeight` token that no bundled face carries is a no-op: `figtreeFace` silently
rounds it to the nearest bundled face.** Proved by execution, not by reading:
`.tentacle/tmp/mobile-transcript-type/repro-weights.ts` walked every `typography` token
through `figtreeFace` and the shipped files — on today's tree 4 token weights are lost:
`step` 500 → `Figtree-Regular`, `headline`/`subheadStrong`/`sas` 600 → `Figtree-Bold`.
`theme-beta.ts:69-85` (`isBold`: ≥600 is bold, everything else Regular) is the ONE place that
decision is made, so it is the one place to fix. The whole task stands or falls on it.

### Preconditions (verified, `file:line`)

- The bundle holds exactly four faces and the loader registers exactly those
  (`assets/fonts/README.md`'s table, `fonts-expo.ts:18-21`); `FIGTREE_FACES`
  (`theme-beta.ts:57-62`) is keyed by PostScript name, which is also the `loadAsync` name.
- Upstream static faces exist and are OFL-licensed, same family: fetched
  `raw.githubusercontent.com/erikdkennedy/figtree/master/fonts/ttf/Figtree-{Medium,MediumItalic,
  SemiBold,SemiBoldItalic}.ttf` (200, 57 316 / 56 868 / 57 584 / 57 168 B). Their `name` tables
  read `ps=Figtree-Medium usWeightClass=500`, `Figtree-MediumItalic 500`,
  `Figtree-SemiBold 600`, `Figtree-SemiBoldItalic 600`; `fsSelection` italic bit set on the two
  italics only. The four already-bundled files fetched from the same URL are **byte-identical**
  to the tree's (`sha256` of `Figtree-Regular/Bold/Italic/BoldItalic.ttf` match
  `assets/fonts/README.md`), so the source is the one the owner's originals came from.
  Note: Medium/SemiBold declare their **own** family names (`Figtree Medium`,
  `Figtree SemiBold`), so each of those families has exactly one normal face.
- Which weight a text asks is ONE decision (`theme-beta.ts:80-85`); the patch's own
  `fontWeight`/`fontStyle` are the FACE's (`theme-beta.ts:106-110`), which is why widening the
  map is the whole fix at that layer.
- The app renders style through ONE seam (`ui/Text.tsx:39-50`), so nothing per-component has to
  know a weight became a face.
- Tokens that ask 500/600: `typography.step` 500 (`theme.ts:333`); `headline`, `subheadStrong`,
  `sas` 600 (`theme.ts:318,324,335`). Italic at those weights is real: `ThinkingWord` draws
  `typography.step` italic (`ui/StepNode.tsx:275,300` — `shimmerFont(font,
  typography.step.fontWeight)`), the finished thought's subtitle is `typography.step` +
  `styles.thoughtLine` italic (`ui/StepNode.tsx:531,798`), and dark-theme prose at 500 with an
  `em` span is italic-500 too (`screens/transcript/Markdown.tsx:87-91`).
- Prose and lists are drawn by `Markdown` (`Markdown.tsx:274` `paragraph`, `:294` `bullet`),
  reached from the assistant row (`screens/transcript/TranscriptRow.tsx:410`) and the user
  bubble (`:392`): one style object to make palette-dependent.
- Dark-ness is one predicate, `isDark` (`theme.ts:238`: `dark` or `petrol`), so "dark theme"
  covers the Beta petrol palette as well — as it must, it is a dark ground.
- A step row's parts: the name Text coloured `palette.label` (`ui/StepNode.tsx:516`), the
  trailing duration `typography.caption` 12 pt (`:544`), the thought's `· N s` subtitle at
  `typography.step` 14 (`:531`); the rail's geometry reads `typography.step.lineHeight` and
  `typography.stepMono.lineHeight` (`step-rail.ts:44-45`) — so `step`'s lineHeight must stay 20
  or the branch off the rail changes with it.
- Bold inside prose is its own style (`Markdown.tsx:275` `bold: { fontWeight: "600" }`), which
  under a real SemiBold would get *lighter*: it has to be pinned to 700 (owner decision 2).

### Design

1. **Bundle eight faces, one per (weight, style) the app can ask**: Regular/Italic (400),
   Medium/MediumItalic (500), SemiBold/SemiBoldItalic (600), Bold/BoldItalic (700). The italics
   are not decoration: weight and style combine in the inheritance model (`textFont`,
   `theme-beta.ts:115-139`), so leaving 500/600 italic unbundled only moves the lossy rounding
   into the italic corner (a dark-theme `em` would lose its 500). `FIGTREE_FACES` grows four
   keys (`medium`, `mediumItalic`, `semiBold`, `semiBoldItalic`) beside the existing four, and
   `fonts-expo.ts` requires exactly them.
2. **`figtreeFace` becomes exact for 400/500/600/700 and nearest-bounded outside**:
   a weight is resolved to a number (`medium` 500, `semibold` 600, names and numeric strings
   alike), then 400→Regular, 500→Medium, 600→SemiBold, ≥700→Bold, ≤400→Regular. `FigtreePatch`
   widens to `"400" | "500" | "600" | "700"` — the face's own class, exactly as today's
   400/700 were.
3. **Prose weight is a pure function of the palette** (AGENTS §7 — `Markdown.tsx` stays a dumb
   renderer): new module `apps/mobile/src/transcript-type.ts`, `proseFontWeight(palette)` =
   `"500"` when `isDark(palette)` else `"400"`, plus `proseStyle(palette)` = `typography.transcript`
   + that weight (size and line height untouched: 16/23, owner decision 4).
   `Markdown` spells paragraphs, headings, list-item bodies and quotes through it; the
   `[+N more characters]` notice keeps the plain token (it is meta, not prose).
4. **`Markdown`'s `bold` becomes 700** so a bold run inside 500 prose still steps up.
5. **Tool rows go quieter by size and lightness** (owner decision 4): `typography.step` becomes
   14/20/**400** (lineHeight kept: the rail's geometry reads it); a new `stepMeta` 13/18/**400**
   carries the duration; the step NAME is drawn `palette.sec` instead of `palette.label`; the thought's
   `Thought · N s` label is already 14 + `sec` (`typography.step` + `styles.thoughtLine`), so it
   needs no change beyond the token's weight. Dots, rail and ring are untouched
   (`fix/mobile-step-rail`'s).

### Files (dependency order)

| File | Change |
|---|---|
| `apps/mobile/assets/fonts/Figtree-{Medium,MediumItalic,SemiBold,SemiBoldItalic}.ttf` | the four fetched faces (OFL, unmodified) |
| `apps/mobile/assets/fonts/README.md` | the four rows (PostScript name + sha256), the "not bundled" paragraph rewritten — the licence file is unchanged (same OFL text) |
| `apps/mobile/src/theme-beta.ts` | `FIGTREE_FACES` +4 keys, `figtreeFace` exact map, `FigtreePatch.fontWeight` widened |
| `apps/mobile/src/fonts-expo.ts` | four more `require`s, registered under their PostScript names |
| `apps/mobile/src/theme.ts` | `step` 500→400, new `stepMeta` 13/18/400 |
| `apps/mobile/src/transcript-type.ts` (new) | `proseFontWeight`, `proseStyle` (pure) |
| `apps/mobile/src/screens/transcript/Markdown.tsx` | prose via `proseStyle(palette)`, `bold` 600→700 |
| `apps/mobile/src/ui/StepNode.tsx` | name `palette.label`→`palette.sec`; duration `typography.caption`→`typography.stepMeta` |
| `apps/mobile/test/theme-fonts.test.ts` | NEW: every token weight resolves to its own bundled face |
| `apps/mobile/test/transcript-type.test.ts` (new) | prose weight dark/light (all three palettes), step-row 14/sec/400 (token + drawn source), bold 700 |
| `apps/mobile/test/theme-beta.test.ts`, `text-seam-render.test.ts`, `thinking-motion.test.ts` | the four-face/500-is-Regular expectations become the new truth |
| `changelog.d/mobile-transcript-type.changed.md` | one bullet |
| `apps/mobile/e2e/flows/41-transcript-type-shots.yaml`, `apps/mobile/e2e/run.ts` | the Validation shots as a flow (+ its own session id) |

No protocol, no persistence, no wire change: `packages/protocol` untouched, so
`protocol.json` needs no regeneration and no `protocol.d/` note.

### Failure modes

- **A token asks a weight no face carries** (today's bug, and the regression risk after adding
  faces): the new test walks EVERY `typography` token weight → `figtreeFace` → the face's own
  weight class → the file on disk. Red on today's tree (4 tokens), green only when the map and
  the bundle agree. An unknown/odd weight (`"light"`, 300, 900) is bounded, never `undefined`:
  a face is always returned, so a text never falls back to the system font.
- **A face is added to the map but not to the loader** (or vice versa): both
  `theme-fonts.test.ts` assertions (the `require` list equals `FIGTREE_FACES`; the folder holds
  exactly those files) fail.
- **Prose weight leaks into the light theme** (the owner's decision is dark-only): the pure
  function is asserted on all three palettes, and `isDark` is the app's one dark predicate, so
  a fourth palette added later cannot silently get 500.
- **`bold` accidentally lightens**: 700 is asserted, and the prose test asserts it is heavier
  than the prose.
- **The step title stops being 14 pt / 400 / `sec`** (the row goes back to blending): token +
  source pins.
- **Rail geometry drifts**: `step.lineHeight` stays 20, and `step-rail.test.ts` (untouched) is
  the guard — it is run in this task's narrow set.
- **Screenshot flow cannot build** (no generated `apps/mobile/ios` in a fresh worktree, one iOS
  runtime installed): reported as `NOT READY` with the reason, never faked.

### Tests

1. `theme-fonts.test.ts` → *every typography token's weight is the bundled face's own weight*
   (the red-first one).
2. `transcript-type.test.ts` → prose 500 on `darkPalette` + `petrolPalette`, 400 on
   `lightPalette`; prose keeps 16/23; `step` = 14/20/400; `stepMeta` = 13; the name is drawn
   `palette.sec` and the duration through `stepMeta` (source pins, the
   `step-rail-render.test.ts` pattern); `bold` 700.
3. The three updated tests above (they are the behavioural red for the map change).

### Validation

`bun test` over exactly these files per slice; `bunx biome check` on the touched files;
`bunx tsc -p apps/mobile` is the orchestrator's gate (this worktree's `node_modules` arrives
from `bun install`). Simulator shots in §Validation above, or an honest `NOT READY`.


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

*— deepseek-v4-pro (executor), 2026-11-22*

**Load-bearing check, re-run first: it FAILED exactly as Context said.** I wrote it as a
repro (`.tentacle/tmp/mobile-transcript-type/repro-weights.ts`, pasted below in summary):
every `typography` token weight → `figtreeFace` → the file on disk. On the untouched tree:

```
bundled: Figtree-Bold.ttf Figtree-Regular.ttf Figtree-BoldItalic.ttf Figtree-Italic.ttf
MISS headline      weight=600 -> Figtree-Bold      <-- asked weight LOST
MISS subheadStrong weight=600 -> Figtree-Bold      <-- asked weight LOST
MISS step          weight=500 -> Figtree-Regular   <-- asked weight LOST
MISS sas           weight=600 -> Figtree-Bold      <-- asked weight LOST
FAIL 4 token weights lost
```

So the failure is not stale: 500 was drawn at 400 (the owner's complaint) and 600 at 700.

**As built, in the Implementation's order.**

1. **Faces.** Fetched the four upstream statics into `apps/mobile/assets/fonts/`
   (`Figtree-{Medium,MediumItalic,SemiBold,SemiBoldItalic}.ttf`; the master-branch `fonts/ttf/`
   URLs). Parsed their `name`/`OS/2` tables: `Figtree-Medium` 500, `Figtree-MediumItalic` 500,
   `Figtree-SemiBold` 600, `Figtree-SemiBoldItalic` 600. Re-fetched the four already-bundled
   files from the same URL: byte-identical to the tree's, so all eight share one source.
   `assets/fonts/README.md` rewritten with the eight-row table (PostScript name + weight +
   sha256) and the "Light/Medium/SemiBold are not bundled" paragraph replaced — `OFL.txt` is
   unchanged (same licence text; `theme-fonts.test.ts` asserts it).
2. **`theme-beta.ts`.** `FIGTREE_FACES` grows `medium`, `semiBold`, `mediumItalic`,
   `semiBoldItalic` (`:57-72`); `FACE_WEIGHT` (`:74-83`) is each face's own `usWeightClass`;
   `weightOf` + `figtreeFace` (`:96-121`) are now EXACT for 400/500/600/700 (CSS names and
   numbers alike) and bounded outside (≥700 bold, <400 regular, unusable → 400), never
   `undefined`; `FigtreePatch.fontWeight` widened to `"400" | "500" | "600" | "700"` and
   `textFont` takes it from `FACE_WEIGHT` (`:160-186`).
3. **`fonts-expo.ts`.** Four more `require`s, registered under their PostScript names; doc
   comment says eight and why.
4. **`theme.ts`.** `step` 500 → **400** (lineHeight kept at 20 — `step-rail.ts:44` measures it);
   new `stepMeta` 13/18/**400** for a step's trailing duration.
5. **`transcript-type.ts` (new, 28 lines).** `proseFontWeight(palette)` = `isDark(palette) ? "500"
   : "400"`; `proseStyle(palette)` = `typography.transcript` (16/23) + that weight.
6. **`Markdown.tsx`.** `Ctx` carries `prose: proseStyle(palette)`; paragraph, heading, list
   bullet and the chunked text are drawn through it (4 sites); `bold` 600 → **700**. The
   `[+N more characters]` notice keeps the plain token (it is meta, not prose).
7. **`StepNode.tsx`.** The name is `palette.sec` (was `palette.label`); the trailing duration
   (live clock included) is `typography.stepMeta` (was `typography.caption`). Dots, rail, ring
   untouched.
8. **Tests.** `theme-fonts.test.ts` gained the weight walk (tokens + prose weights, normal and
   italic + the markdown's bold, each checked against the file's real `OS/2` `usWeightClass`);
   `transcript-type.test.ts` (new, 9 tests) covers prose dark/light/petrol, 16/23, the step
   tokens, the drawn name/duration/subtitle, the 700 bold and the prose plumbing;
   `theme-beta.test.ts`, `text-seam-render.test.ts`, `thinking-motion.test.ts` updated from
   "500 is Regular / 600 is Bold" to the shipped truth (their old assertions were the red).
9. `changelog.d/mobile-transcript-type.changed.md`.
10. **Evidence flow** `apps/mobile/e2e/flows/41-transcript-type-shots.yaml` (+ its
    `41-transcript-type-shots: "TRANSCRIPT_ID"` line in `e2e/run.ts`'s
    `COMPOSE_SESSION_VARS`): `TOOLROWS29` for the steps, `SHOWCASE` for the prose and the
    bold list, each shot dark + light through `_shot.yaml`.

**Red before green (§9).** `theme-fonts.test.ts`'s walk was red on the untouched tree on the 4
named tokens (`Expected 500, Received 400` …), then green once the faces and the map landed.
`transcript-type.test.ts` was red first on 5 of its 9 tests (the token, the `stepMeta`, the drawn
name/duration, the 700 bold, the prose plumbing) and green after step 4-7.

**Mutations (§9 non-vacuity), each reverted; script kept at
`.tentacle/tmp/mobile-transcript-type/mutations.sh`:**

| Mutation (temporary) | Red on |
|---|---|
| M1 `figtreeFace`: drop the `>= 500` → Medium branch (the original bug) | theme-fonts › *transcript prose: 500 resolves to a face that IS 500* |
| M2 `proseFontWeight` always `"400"` | transcript-type › *dark: 500 — today's dark and the Beta petrol page alike* |
| M3 `proseFontWeight` always `"500"` | transcript-type › *light: 400* |
| M4 `step` weight back to `"500"` | transcript-type › *the title token is 14 pt, regular…* |
| M5 step name `palette.sec` → `palette.label` | transcript-type › *the drawn name is `sec`, not `label`…* |
| M6 `Markdown` `bold` back to `600` | transcript-type › *the markdown's bold is 700…* |
| M7 paragraph back to `styles.paragraph` | transcript-type › *paragraphs and list bodies…* |
| M8 loader drops the Medium `require` | theme-fonts › *the loader requires exactly those faces* |

**M1 was NOT caught by my first version of the walk, and that is the honest finding.** After
step 4, no *token* asks 500 any more (prose asks it through `proseStyle`), so the token-only walk
had a blind spot on exactly the weight this task exists to fix. I extended the walk to the
weights the app asks at render time (prose, normal + italic; the markdown's bold) and re-ran M1:
red. Re-ran the whole script afterwards — all eight caught.

**Drift from the Implementation (and why).**

- **The weight walk had to grow past the token table** (above): the plan's test was scoped to
  "every typography token", which stopped being sufficient once prose got its weight outside the
  table. Fixed in the test, and the plan's Tests section is weaker than what shipped.
- **`stepMeta` spells `fontWeight: "400"`** (gate fix after Execution). The token shipped as
  `{ fontSize: 13, lineHeight: 18 }` and the test read `typography.stepMeta.fontWeight ?? "400"`,
  which `tsc` rejects (`TS2339: Property 'fontWeight' does not exist` — the optional property is
  absent from the inferred literal type, unlike `step` which spells it). `step` already states its
  weight explicitly, so `stepMeta` now does too — the token is 13/18/**400** as the plan intended,
  and the test asserts it without a fallback. Files, Tests and Validation above read 13/18/400.
- **Nothing else.** No protocol, persistence or wire change: `packages/protocol` untouched, so
  `protocol.json` was not regenerated and no `protocol.d/` note is needed.

**Screenshots (the doc's mandatory Validation) — NOT produced here.** This worktree has no
generated `apps/mobile/ios` project and the machine has only the iOS 26 runtime (the harness
requires 18 **and** 26 unless narrowed); producing them means a full `expo prebuild` + Release
`xcodebuild`, which is the orchestrator's gate. What I published instead is the e2e flow
`apps/mobile/e2e/flows/41-transcript-type-shots.yaml` (registered in `e2e/run.ts`, validated by
`e2e-flows.test.ts` / `e2e-gate.test.ts`, both green), which shoots the exact transcript the
Validation names (prose + a Bash step + Thought + a bold list) in dark and light — run it with
`bun run e2e:mobile --ios 26 --only 41-transcript-type-shots`. **To verify the visual side:**
build for a simulator, run that flow, and compare `41-transcript-type-steps-dark` against the
mockup's variant A. The before-shot from `main` is the same flow run on `main`.

**Narrow tests run (`| tail`), all green:** `transcript-type`, `theme-fonts`, `theme-beta`,
`thinking-motion`, `text-seam-render`, `step-rail`, `step-rail-render`, `markdown`, `theme`,
`step-thought-marker`, `tool-rows-wiring`, `tool-step-view` — 318 pass / 0 fail. `bunx biome
check` on all 11 touched files: clean. The full gate (`bun run check`) is the orchestrator's
script.

`SCREENSHOTS: none (see above — flow 41 is written, the build is the gate's)`
`NOT READY: simulator shots + the main-branch before-shot need a Release build, not available in
this worktree`

## Review

*— claude-opus-5-5, 2026-11-22* (fresh context; a different model family from the executor, deepseek-v4-pro)

**Verdict: APPROVE (PASS).** No HIGH or MEDIUM code findings. One open gate item, outside the code (below).

- **Gate (this reviewer).** I ran the narrow set: `transcript-type`, `theme-fonts`, `theme-beta`,
  `text-seam-render`, `thinking-motion`, `step-rail`, `e2e-flows` and `e2e-gate`. Result:
  160 pass / 0 fail. `bun run lint`: clean, 2265 files. `bun run typecheck` (root + mobile +
  relay): clean. I did not run the full `bun test`. The diff is mobile-only.
- **Mutations (§9).** I added two of my own beyond the executor's M1–M8:
  (a) the StepNode duration goes back to `typography.caption`;
  (b) the Markdown bullet drops `ctx.prose`, so it loses its 16/23 size, now that `styles.bullet`
  carries no size.
  Each one turns `transcript-type.test.ts` red. I reverted both, and `git status` came back clean.
- **Attacks tried.**
  (1) **Palette identity.** `isDark` compares by reference. I grepped for derived palettes
  (`...palette`, `as Palette`) and found none: every `Markdown` caller passes one of the three
  palette constants. Holds.
  (2) **Heading weight.** `[ctx.prose, styles.bold, …]` puts the 700 last, so it wins. Holds.
  (3) **Italic at 500/600.** `figtreeFace` → MediumItalic/SemiBoldItalic, and `FACE_WEIGHT`
  gives the patch the face's own weight class. Holds.
  (4) **Odd weights.** `"light"`, 900, NaN and `"  Medium "` each resolve to a face, never
  `undefined`. Holds.
  (5) **§7.** The logic sits in the pure `transcript-type.ts`, and the components only apply it.
  No change to protocol, persistence or terminal paths. Holds.
- **Open item (not a code defect; must be closed before merge).** The doc's mandatory Validation
  is `NOT READY`, so nothing has shown on a device that iOS really draws `Figtree-Medium` at
  500. The upstream Medium and SemiBold files declare their own nameID-1 family
  (`Figtree Medium`, `Figtree SemiBold`), so how RN's `RCTFont` resolves the family and weight
  is only proven at runtime. The orchestrator must run
  `bun run e2e:mobile --ios 26 --only 41-transcript-type-shots`, on this branch and on `main`.
- **Nit (owner call).** `proseStyle` also applies in the user bubble, `SubagentDetail` and the
  artifact `MarkdownViewer`, because they share `Markdown`. That reach goes beyond "assistant
  text, lists", but it is consistent.
- **Executor behaviour.** Honest work. Red-first was shown. The executor found and reported a
  blind spot in its own test (M1 was not caught by the token-only walk) and fixed it. It
  reported `NOT READY` rather than faking screenshots.
