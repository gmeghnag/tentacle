# fix/mobile-running-row — the iPhone's running row: whole label, blinking dot, no reasoning in the detail

> **Status:** execution
> **Branch:** `fix/mobile-running-row`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** Opus exec; standard Review + simulator screenshot pass
> **Changelog:** `changelog.d/mobile-running-row.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-22*

Owner screenshots from the real phone (build 21/11 22:58, main `e0c0fda2`),
`.tentacle/tmp/orchestration/prompts/mobile-running-row-{dns,thinking}.png`:
«la frase che risulta tagliata (succede anche con thinking con la variante del
tema) e lo spinner ancora circolare invece del puntino che lampeggia». Plus
(22/11, beta `compactShell` on): the tap detail of a tool still shows the
model's reasoning, against the owner decision of 21/11
(`docs/feat/shell-intent-line.md`, «Tap detail: no reasoning»). Three defects:

1. **Clipped running label.** «Test DNS 50 query con l» stops mid-word, with no
   `…`, at about half the row; «Thinkinɡ» loses its last glyph. Both are the
   italic shimmer label `ThinkingWord` (`apps/mobile/src/ui/StepNode.tsx` on
   main, `:190-271`). It draws the text TWICE: a transparent RN `Text`
   (`numberOfLines={1}`) that only lays out, and an svg `<SvgText>` that is
   what you see, in a canvas the size of the RN text's box
   (`<Svg width={width} height={height}>`, `:239`, `width =
   Math.round(layout.width)`, `:232`). Causes, all in that pairing:
   - **(a) the svg draws the WHOLE text into a box the RN text ellipsized.**
     The wrapper is `styles.name` (`:221`) = `maxWidth: "45%"` (`:660`) even
     when nothing sits beside the label (a described shell step has
     `subtitle: ""`; the plain label switches to `nameWide` then, `:418`, the
     shimmer did not). The RN text ellipsizes at 45 %, but the svg cannot
     ellipsize: it writes the whole sentence and the canvas edge cuts it —
     mid-word, no `…`. Measured on the owner's shot: the cut is at x≈445 of a
     row from x≈85 to x≈885 → 45 %.
   - **(b) the svg has no font family** (`glyph`, `:209-215`: size, weight,
     style only). react-native-svg then resolves the system font
     (`RNSVGGlyphContext.mm` `getGlyphFont`, family `nil` → `RCTFont` default),
     while under the beta theme the RN text — whose box is the canvas — is
     Figtree (`ui/Text.tsx` patches every text through `textFont`). The svg
     draws a wider face into a box measured in a narrower one: the last glyph
     is cut. Both owner shots are in the beta theme (the petrol dark palette,
     `theme.ts:184-195`, exists only with the Figtree switch on).
   - **(c) the canvas is the advance width, rounded.** An italic glyph's ink
     leans past its advance (the g/f/y tail), and `Math.round` can shave
     another half point. The default-theme simulator «Thinking» was intact
     (before shot below), so (c) is a margin, not the owner's bug; it is fixed
     with the same change at no cost.
2. **Running node = turning ring.** `Node` → `case "running"` → `Spinner`
   (`StepNode.tsx` main `:64-95`, `:292-293`), a 10 pt arc turning every
   `STEP_SPINNER_TURN_MS` = 900 ms. Owner decision 21/11 (shell-intent-line
   mockup section C, recorded in `docs/feat/shell-intent-line.md` «Owner
   decisions 2026-11-21»): the iPhone's running tool = the TUI's blinking ●
   (500/500 ms, shared phase, `packages/tui/src/blink.ts` `BLINK_HALF_MS`).
3. **Reasoning in the tool detail.** `stepRowView` (`apps/mobile/src/tool-steps.ts`
   main `:315-363`) copies the reasoning folded into the step (`stepLayout`'s
   cell `thought`) into its view (`thought,` `:349`, and `thought !== null ||`
   makes it tappable, `:353`); `ToolRowView` passes `thought={view.thought}` to
   `StepBody` (`TranscriptRow.tsx` main `:664`), which draws it first, with a ∴.
   Independent of `compactShell` and of the tool (any tool with a thought
   before it). **Mac TUI:** not affected — `packages/tui/src/state.ts:567-572`
   keeps only `reasoning: true` + a start time, never the text, so no TUI tool
   detail can show it.

**Repro** (2026-11-22, simulator iPhone 17 Pro `0FA4B51F-…`, main `1791d22b` +
the new e2e flow only): `scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D
--only 38-running-row`. A new mock-model turn `RUNROW38`
(`apps/mobile/e2e/mock-model.ts`): a thought, then ONE described `shell` call
(«Test DNS con 50 query e latenze misurate per ogni risolutore», `sleep`), then a
slow thought; flow 38 shoots the running row, the Thinking footer and the tap
detail, light + dark, default theme then Figtree + `compactShell` on. Result on
main:

```
✗ 38-running-row (iOS 26) fail
[Failed] 38-running-row (1m 32s) (Assertion is false: ".*Measure the resolver latency.*" is not visible)
```

Shots (`.tentacle/tmp/mobile-running-row/`): `before-default-running-light.png`
— «*Test DNS con 50 query*» cut at 45 %, no `…`, the turning arc as node;
`before-default-detail-{light,dark}.png` — the open detail starts with
«∴ *Measure the resolver latency with fifty queries.*» (the folded thought),
then the command and the output; `before-default-thinking-light.png` —
«Thinking» intact (default theme). Beta theme on main (`before-beta-*.png`,
run with the detail assertion lifted so the beta phase is reached):
`before-beta-thinking-dark.png` shows «Thinkinɡ» exactly as on the owner's
phone, and `before-beta-running-light.png` the sentence drawn in the SYSTEM
italic (not Figtree) and cut at 45 % — cause (b) and (a) on screen.
`compare-beta-before-after.png`: the running row before, the Thinking row
before and after.

## Implementation

*— claude-opus-5-5, 2026-11-22*

### Load-bearing assumption

The svg layer can be told what to draw from the RN text's own layout: an RN
`Text` WITHOUT `numberOfLines`, laid out at the label's real width, reports its
wrapped lines through `onTextLayout` (`RCTTextLayoutManager.mm`
`getLinesForAttributedString`: one entry per line fragment, its `text` the
characters of that fragment). A single-line truncated text would NOT do: the
fragment of a tail-truncated line is the whole remaining string, so
`numberOfLines={1}` cannot say where the `…` falls. Proven on the simulator by
the after shots (the svg text ends exactly where the done row's does).

### Preconditions

- The shimmer must stay glyph-clipped (no moving window): the window was the
  visible-rectangle bug (`docs/feat/mobile-thinking-images.md` §Context 1);
  pinned by `test/tool-rows-wiring.test.ts` "the shimmer is CLIPPED…".
- The face comes from one seam: `textFont` (`theme-beta.ts:117`) via
  `AppFontContext` (`ui/Text.tsx`).
- Timings are named constants in `motion.ts`, read by the mockup kit by name
  (`test/motion-literals.test.ts`, `scripts/mockup-kit/sources.ts`).

### Design

Pure first (AGENTS §7):
- `thinking-motion.ts`: `shimmerLine(lines)` — one line → as is; more → the
  first line cut at a word (at least the last word goes, so the `…` fits in its
  room), or two characters when one word is wider than the row; `shimmerFont(font,
  weight)` — the RN label's face through `textFont` (Figtree under the beta, no
  family otherwise); `shimmerCanvas(w, h, size)` — whole points + a 0.3 × size
  margin right and below.
- `step-blink.ts` (new): `runningDotLook(reduceMotion)` = accent dot, blinks
  unless Reduce Motion; `STEP_BLINK_CURVE` (1 for the first half of the loop, 0
  for the second); `STEP_BLINK_LOOP_MS = 2 × STEP_BLINK_HALF_MS`. `motion.ts`:
  `STEP_BLINK_HALF_MS = 500` replaces `STEP_SPINNER_TURN_MS`.
- `tool-steps.ts`: `StepRowView` loses `thought`; a thought no longer makes a
  step tappable. The `thought` argument only feeds the default of
  `thoughtFirst` (VoiceOver «thought first» — a fact, not the text).

Components (render only): `ThinkingWord` takes `wide` (= `subtitle === ""`,
the plain label's rule), a never-seen measuring copy of the text at the label's
width feeds `shimmerLine`, the svg gets `shimmerFont` and `shimmerCanvas`.
`Node` `case "running"` → `BlinkingDot` (`styles.dot`, the done dot's style, in
`palette.accent`, opacity on ONE module-level native-driver clock shared by
every running dot, refcounted). `ToolRowView` passes `thought={null}`.
`AppFontContext` moves to `ui/app-font.ts` (re-exported by `Text.tsx`) so
`StepNode` reads it without importing the seam that ~10 tests mock. The
header spinner, the FAB ring and the Thinking ∴ are untouched.

### Files

`apps/mobile/src/{motion.ts, step-blink.ts (new), thinking-motion.ts,
tool-steps.ts, ui/app-font.ts (new), ui/Text.tsx, ui/StepNode.tsx,
screens/transcript/TranscriptRow.tsx}`; tests `apps/mobile/test/{step-blink
(new), thinking-motion, tool-step-view, step-thought-marker, tool-rows-wiring,
motion-literals}.test.ts`; e2e `apps/mobile/e2e/{mock-model.ts, run.ts,
flows/38-running-row.yaml, flows/_runrow-turn.yaml}`; mockup kit
`tools/mockup-kit/{kit.css, kit.js, generated/*}` (regenerated),
`scripts/test/mockup-kit.test.ts`.

### Failure modes

- Not measured yet / Reduce Motion: no clock → plain grey RN text (ellipsized
  by RN), no svg — as before.
- `onTextLayout` not fired yet: `line === ""` → no svg, the grey RN text shows.
- Label fits: the measuring copy at the box's width (RN ceils text sizes)
  lays out one line → the whole text.
- Dynamic Type: both copies share `maxFontSizeMultiplier`; svg size follows
  `fontScale` capped like the RN text (unchanged).
- Several running steps: one shared clock → in phase; the last unmount stops it.
- A thought with nothing else to open: not tappable (was: a body with only the
  thought).

### Tests

Red before green: `tool-step-view.test.ts` "the tap detail carries NO
reasoning, for every tool" (shell, described shell running/done, `fs_read`,
MCP; `compactShell` off and on) — 13 red on main; `step-thought-marker.test.ts`
(the rendered `StepBody` of a step with a folded thought contains no thought);
`thinking-motion.test.ts` (`shimmerLine`, `shimmerFont`, `shimmerCanvas`) and
`step-blink.test.ts` (TUI-equal half period, look, curve) — red (missing
exports) before the code; `tool-rows-wiring.test.ts` "running row wiring". E2E:
flow 38 (asserts the running sentence and the detail without the thought).

## Execution

*— claude-opus-5-5, 2026-11-22*

1. Branch `fix/mobile-running-row` created off `main` `1791d22b` (it did not
   exist; the brief said it was checked out).
2. Repro first: mock turn `RUNROW38` + flow 38 (+ registered in `run.ts`),
   run on the clean source (the `src/` edits stashed so the Release bundle was
   main's) → the failure and shots in Context. A first launch was killed and
   restarted because its build would have bundled half-done `src/` edits.
3. Cause 3: tests red (13), then `tool-steps.ts` / `TranscriptRow.tsx` → green.
   The StepNode a11y hint «Shows the thought, command and result» became
   «Shows the details» (it is also the Thinking row's hint).
4. Causes 1–2: tests red, then the pure functions, `ThinkingWord`,
   `BlinkingDot`; `AppFontContext` moved to `ui/app-font.ts` (drift from the
   first idea of importing it from `Text.tsx`: ten tests mock `Text.tsx`
   without it). Mockup kit: the running node is the accent dot blinking
   `step-end` on `--ms-step-blink-half`, steady under `prefers-reduced-motion`;
   `bun run mockup-kit` regenerated `generated/*`.
5. Mutation (§9), each reverted: `shimmerLine` keeps the last word → 3 fail;
   canvas margin 0 → 1 fail; blink under Reduce Motion → 1 fail; `thought`
   back in the view and in `tappable` → 12 fail; svg ignoring Figtree → 1 fail.
6. Simulator, after (`scripts/e2e-gate.sh … --only 38-running-row,29-tool-rows`):
   `GATE PASS — 2 passed`. Flow 29 (asserts the tool-row ids, shoots running
   rows) unchanged and green; no flow asserted the old spinner. The mock shell
   was then lengthened 12 → 20 s so the beta DARK running shot is taken while
   it still runs (it had ended by then), and flow 38 re-run: `GATE PASS`.
   The beta before shots were taken last: `src/` stashed again, the detail
   assertion lifted for that one run, both restored after (verified by
   `git status` and the assertion back in `_runrow-turn.yaml`).
7. Gate: narrow tests (above files + `shell-intent-step`, `text-seam`,
   `settings-beta`, `scripts/test/mockup-kit`, `packages/tui/test/mockup-kit-calibration`)
   green; `bun run typecheck` clean; `bun run lint` clean (baseline 0/0). Full
   `bun test` not run (per brief).

Screenshots: see the list at the end of the report /
`.tentacle/tmp/mobile-running-row/` (`before-*`, `after-*`).

Not done / open: the reasoning folded into a step is now shown nowhere after
the fact on the phone (the owner's decision: the orphan Thought row shows only
its duration, docs/fix/thought-placeholder.md); a folded thought is not turned
into its own `Thought · N s` row — a separate owner call if wanted.

## Review

*— pending (fresh context)*
