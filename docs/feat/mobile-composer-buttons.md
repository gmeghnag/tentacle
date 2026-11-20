# feat/mobile-composer-buttons — The composer's mic, `+` and send, per mockup B + S2

> **Status:** execution
> **Branch:** `feat/mobile-composer-buttons`
> **Type:** feat · **Size:** S–M · **Blast:** contained · **Suited:** Opus exec + simulator screenshots, standard Review
> **Changelog:** `changelog.d/mobile-composer-buttons.changed.md`

## Context

*— claude-opus-5-5, 2026-11-20*

The owner asked (TODO row `feat/mobile-composer-buttons`, 2026-11-20) to restyle
the iPhone composer's round buttons per the approved mockup
<https://claude.ai/artifact/HVjKHhCNJ2aGRVVjnLg9e1> (local copy
`.tentacle/mockups/mobile-mic-button/final-2026-11-20-B-S2.html`). Owner choices,
final (20/11):

- **Mic, variant B**: SF Symbol `mic`, 22 pt, weight light, accent, inside a 32 pt
  circle of the accent at 10 % (light) / 14 % (dark), in a 44×44 pressable.
  Recording: circle at 20 % / 26 %, a filled 11 pt stop square (radius 2.5), a
  pulsing halo (32 → 42 pt, accent 25 % → 0, 1.2 s) and a timer. Transcribing: a
  spinning arc (20 pt, stroke 1.3, `sec`) and "…"; tap disabled. Preparing: the
  10 % circle, glyph `sec`.
- **Send, S2**: ready = 36 pt circle accent 20 % / 26 % + `arrow.up` accent;
  empty = no circle, `arrow.up` `sec` at 50 %. No solid `accentFill` any more.
- **`+`** in the same tinted circle as the mic (32 pt, 10 % / 14 %).
- **No separate photo button**: the `+` sheet already has photos.
- **The text field's border never changes colour** (stays `sep`), not even while
  recording.
- The owner is colour-blind: **no state by hue alone** (recording = ■ + halo +
  timer; transcribing = arc + "…"). **Reduce Motion stops the animations.**
  Touch targets ≥ 44 pt.

**What is there today (evidence, `main` @ 3a48d4d5):**

- `micButtonOf` folds `finalizing` into `listening`
  (`apps/mobile/src/dictation.ts:181-195` on main: `case "listening": case
  "finalizing": return "listening";`), so the composer cannot draw
  "transcribing" differently from "recording" — the mockup's row "0 — oggi"
  calls this out ("«Trascrive» non si distingue da «registra»").
- `Composer.tsx` (main) draws the mic as a 19 pt glyph in a 32×36 pressable with
  `hitSlop={6}`, and listening as a `waveform` whose opacity is the level — a
  state told almost only by colour/opacity; the field's border turns
  `palette.accent` while listening (`borderColor: listening ? palette.accent :
  palette.sep`); the send slot is a solid `accentFill` circle with an `onAccent`
  ↑; the `+` is a bare 19 pt `label` glyph.

**Repro (feat: the capability is missing), 2026-11-20, on `main`:** the new
`micButtonOf` / view-model tests run on the unchanged sources:

```
$ bun test apps/mobile/test/voice-view.test.ts apps/mobile/test/dictation.test.ts
(fail) composer > recording: the caption is the elapsed time m:ss, tabular, from the start
(fail) composer > transcribing: mic 'finalizing', caption '…', the placeholder stays, level 0
(fail) micButtonOf: finalizing is not listening > listening → listening; a tap stop → finalizing; the native end → idle
 64 pass
 3 fail
```

## Implementation

*— claude-opus-5-5, 2026-11-20*

### Load-bearing assumption

**`finalizing` is a distinct, observable dictation state whose tap does
nothing**, so a separate face with a disabled tap is honest. Proof:
`DictationState` has `kind: "finalizing"` (`apps/mobile/src/dictation.ts:72-80`),
entered by a stop tap (`finalize`, the `tap` branch of `active`,
`dictation.ts:582-586`), and a tap while finalizing returns `none`
(`dictation.ts:583-584`; pinned by the existing test "a second tap while
finalizing does nothing", `test/dictation.test.ts:659`).

### Preconditions

- The timer needs a clock and a re-render: `listening` carries `startedAt`
  (`dictation.ts:65-71`), set from the controller's `now: () => Date.now()`
  (`screens/SessionScreen.tsx:290`); while listening/finalizing the controller
  ticks every `TICK_MS = 250` (`voice-controller.ts:39`, `syncTicker`) and every
  `dictate` call `emit()`s a fresh state object (`voice-controller.ts:150`), so
  the screen re-renders ≥ 4×/s while recording. `Date.now()` at render is the
  same clock as `startedAt`.
- AGENTS §7 "logic in pure modules": which face, the caption text and the
  elapsed formatting are decided in `dictation.ts` / `voice-view.ts`
  (React-free, unit-tested); `Composer.tsx` only maps them to elements.
- The only consumers of `MicButton` are `voice-view.ts` and `Composer.tsx`
  (`rg micButtonOf|MicButton apps/mobile`); no Maestro flow reads the mic ids
  (`rg composer-mic apps/mobile/e2e` → none).
- Reduce Motion: the shared hook `useReduceMotion` (`ui/chart/ChartAppear.tsx:15`)
  reads it live; `null` until answered — treated as "reduce" (no animation
  starts before the answer).
- Palette has no "accent at N %" token; `tint` is an opaque colour, not 10 %
  (`theme.ts` `tint: "#E0F4F8"`), so two tokens are added from the accent
  (`#0E7490` / `#22D3EE`).

### Design

1. `dictation.ts`: `MicButton` gains `"finalizing"`; `micButtonOf` returns it for
   `kind: "finalizing"` (was `"listening"`).
2. `voice-view.ts`: `voiceComposerView(state, locale, settings, now)` — `now` is
   new and required; the view gains `caption`: `recordingClock(now − startedAt)`
   ("0:07", m:ss, clamped at 0) while listening, `"…"` while finalizing, else
   `undefined`. The "Listening…" placeholder keeps showing while finalizing (as
   before, when finalizing mapped to listening); `level` stays listening-only.
3. `theme.ts`: `accentSoft` (10 % / 14 %) and `accentSoftStrong` (20 % / 26 %),
   `rgba` of the palette's own accent.
4. `Composer.tsx` (render only): `+` and mic in a 32 pt `accentSoft` circle in a
   44×44 pressable (`marginVertical: -4` so the 36 pt row keeps its height, no
   `hitSlop`); recording = `accentSoftStrong` + `Halo` (native-driver scale /
   opacity loop) + 11 pt ■; finalizing = `Spinner` (an arc: a 20 pt ring with one
   transparent side, rotating), pressable disabled with `accessibilityState`;
   the caption (`composer-mic-caption`, caption type, `sec`, tabular digits) left
   of the mic. Send slot: `up` = `accentSoftStrong` + accent ↑; `up-dim` =
   transparent + `sec` ↑ at opacity 0.5; `stop` / `clock` unchanged. Field
   border always `palette.sep`. The `level` prop is dropped (no waveform).
   Halo/Spinner each read Reduce Motion and start no loop when on (static halo
   at scale 1.2 / opacity 0.18, the mockup's reduce rule; static arc).
5. `SessionScreen.tsx`: passes `Date.now()` and `micCaption={voiceView.caption}`.

### Files

`apps/mobile/src/dictation.ts` · `apps/mobile/src/voice-view.ts` ·
`apps/mobile/src/theme.ts` · `apps/mobile/src/ui/Composer.tsx` ·
`apps/mobile/src/screens/SessionScreen.tsx` · tests:
`apps/mobile/test/dictation.test.ts`, `apps/mobile/test/voice-view.test.ts`,
`apps/mobile/test/composer-field-layout.test.ts` ·
`changelog.d/mobile-composer-buttons.changed.md`.

### Failure modes

- **Clock skew / render before `startedAt`** → negative span: `recordingClock`
  clamps to `0:00` (tested).
- **Long dictation**: capped at 10 min by `HARD_CAP_MS`; `10:00` formats (tested).
- **Tap while transcribing**: the reducer ignores it; the button is now
  `disabled` and says so to VoiceOver (`accessibilityState.disabled`), instead
  of a silent no-op.
- **Reduce Motion unknown at mount** (`null`): treated as on — no loop starts; a
  later `false` starts it (effect dep).
- **Mic hidden** (Beta off / not editable): no caption either (the caption is
  gated on `mic !== "hidden"` as well as on its value).
- **Dark/light switch mid-recording**: colours come from `palette` each render;
  the animated values are colour-free.

### Tests

- `dictation.test.ts` — `micButtonOf`: listening → `listening`, a stop tap →
  `finalizing`, the native `ended` → `idle`; unsupported hides finalizing.
- `voice-view.test.ts` — caption: `0:00`, `0:07` (7.4 s floors), `1:05`,
  `10:00`, negative → `0:00`; finalizing → `{ mic: "finalizing", caption: "…",
  placeholder: "Listening…", level: 0 }`; idle → no caption.
- `composer-field-layout.test.ts` (source-structure, as this file already does:
  Bun cannot load RN) — border always `sep` and never `accent`; 44×44 `hit` +
  32 pt `circle`, both `+` and mic use them with the soft tokens; no `photo`
  button; ■ 11 pt + `Halo`, `Spinner` while finalizing, disabled tap, no
  `waveform`; caption wired from the screen; both animations gated by Reduce
  Motion; S2 send (no `accentFill`/`onAccent`, transparent `up-dim`, 0.5 dim);
  tokens are the accent at 10/20 % and 14/26 %.
- Red before green: the view-model/`micButtonOf` tests on `main`'s sources (the
  Repro above, 3 fail); the structure tests on `main`'s `Composer.tsx` (7 fail).
  Mutation: `micButtonOf` `finalizing → "listening"` turns 2 tests red.
- Simulator screenshots, light + dark, of the 4 states.

## Execution

*— claude-opus-5-5, 2026-11-20*

1. **Tests first (red)** — `dictation.test.ts` (2 new), `voice-view.test.ts`
   (3 new; the existing calls gained `now` and `caption: undefined`): 3 fail on
   `main`'s sources (Context, Repro).
2. **Pure modules** — `dictation.ts` (`MicButton` + `"finalizing"`,
   `micButtonOf`), `voice-view.ts` (`now`, `caption`, `recordingClock`),
   `theme.ts` (`accentSoft`, `accentSoftStrong`): green. **Mutation**: put back
   `case "finalizing": return "listening"` → 2 fail (`voice-view` transcribing,
   `micButtonOf` finalizing); reverted.
3. **Render** — `Composer.tsx`, `SessionScreen.tsx` as designed;
   `composer-field-layout.test.ts`: the old "mic keeps both states" (the
   `listening ? … : …` ternary) is now the `MIC_ID` map test, plus a new
   "round buttons (mockup B + S2)" block. Red on `main`'s `Composer.tsx` (copied
   in, then restored): **7 fail**. Two of the new tests pass on `main` as well
   and are guards only (no `photo` button; the theme token values).
4. **Drift from Implementation**:
   - The send slot is 36 pt with no hit slop on `main` (< 44 pt): added
     `hitSlop={4}` (36 + 2·4 = 44) and a test for it. Not in the TODO row, but
     the brief requires ≥ 44 pt targets.
   - `Composer`'s `level` prop was dropped (the waveform was its only use); the
     view-model keeps `level` unchanged.
5. **Simulator** — the simulator has no speech engine (flow
   `34-hub-dictate.yaml`: a tap there ends on the voice card), so recording and
   transcribing cannot be reached in the real app. The four states were shot with
   a THROWAWAY entry (`apps/mobile/ComposerShowcase.tsx` + `index.ts` pointing at
   it, both removed/restored before the gate; `git status` shows neither) that
   mounts the real `Composer` four times with fixed props, in a Release build
   (`expo prebuild` + `expo run:ios --configuration Release --no-bundler`) on an
   own iPhone 17 / iOS 26.5 simulator, created for this task, then shut down and
   deleted. Light, then `simctl ui appearance dark`:
   - `.tentacle/tmp/mobile-composer-buttons/screens/composer-4-states-light.png`
   - `.tentacle/tmp/mobile-composer-buttons/screens/composer-4-states-dark.png`
   (each: 1 empty · 2 recording · 3 transcribing · 4 ready, top to bottom; the
   files are gitignored). What they show: `+` and mic in the soft circle; empty
   = bare ↑ dimmed; recording = stronger circle, ■, `0:07`; transcribing = arc +
   "…"; ready = soft circle ↑ in accent; the field border `sep` in all four. The
   halo is animated and was caught near the end of its fade, so it is barely
   visible in the still.
6. **Gate** — `bun run check`: typecheck (root + mobile + relay) clean;
   `biome check .` 2160 files, no fixes; `bun test` **15955 pass · 5 skip ·
   0 fail** (15960 tests, 1133 files; the 5 skips are the pre-existing opt-in
   live/slow tests).

Unverified: on a physical iPhone, the halo/arc motion and Reduce Motion were not
watched (stills only; verify with Settings → Accessibility → Reduce Motion on a
device or `simctl` recording); VoiceOver reading of the disabled mic while
transcribing.

## Review

*— claude-opus-5-5, 2026-11-20* (fresh context; same model as the executor, so shared blind spots are possible)

**Verdict: APPROVE-WITH-NITS** — no HIGH/MEDIUM findings.

**Gate (narrow, as briefed):** touched tests `voice-view`, `dictation`,
`composer-field-layout`, `voice-wiring`: 104 pass · 0 fail. `bun run lint`:
2160 files, clean. `bun run typecheck`: clean (root + mobile + relay). Full
`bun test` not re-run here; Execution reports 15955 pass · 5 skip · 0 fail.

**Premises:** `micButtonOf` folded `finalizing` into `listening` on main — TRUE
(diff). `finalizing` taps return `none` and finalizing has a timeout
(`dictation.ts:583-584`, `:591-595`) — TRUE, so the disabled mic can't stick.
The only consumers of `MicButton`/`voiceComposerView` are `voice-view.ts`,
`Composer.tsx`, `SessionScreen.tsx` — TRUE (rg). No e2e flow reads
`composer-mic*` — TRUE.

**Mutations on `Composer.tsx` (script in `.tentacle/tmp/…/mut.ts`; file restored,
`git status` clean):** border→accent while listening: 1 fail ✓ · Reduce Motion
ignored in `Halo`: 1 fail ✓ · finalizing tap enabled: 1 fail ✓ · send
`hitSlop` 0: 1 fail ✓ · explicit `accessibilityState` dropped: 0 fail · caption
`mic === "hidden"` gate dropped: 0 fail · halo scale 1: 0 fail.

**Nits (LOW):**
1. `Composer.tsx:286` — the caption's `mic === "hidden"` gate is unpinned
   (Failure modes lists it). Scenario: view turns non-editable mid-recording →
   `mic="hidden"` but `micCaption="0:07"`; without the gate an orphan timer would
   show and no test catches it. Add a structure assertion.
2. `Composer.tsx:299` — the explicit `accessibilityState` is redundant with
   `disabled` (RN Pressable derives it) and unpinned; harmless.

**Attacks tried:** other readers of `mic === "listening"` that would change
meaning now that finalizing is separate (none); stuck disabled mic if `ended`
never arrives (`FINALIZE_TIMEOUT_MS` settles it); caption when Beta off /
unsupported (HIDDEN has `caption: undefined`; Composer also gates on hidden);
non-vacuity by mutation (above). §7 invariants: render-only changes; the
decisions (face, caption, clock) live in the pure modules — holds.

**Executor behaviour:** honest Execution, drift (send `hitSlop`) declared and
tested; red-before-green recorded; device-only items listed as unverified.
