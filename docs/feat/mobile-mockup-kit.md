# feat/mobile-mockup-kit — A mockup kit that is faithful by construction

> **Status:** implementation
> **Branch:** `feat/mobile-mockup-kit`
> **Size:** L · **Blast:** cross-module · **Suited:** strong model (opus) executes; mandatory fresh-context Review (L)
> **Changelog:** `none` (internal/dev tooling: no user-visible change in the app or the TUI)


## Context

*— claude-opus-5-5, 2026-11-21*

**Problem (owner, 2026-11-21).** The HTML mockups that agents draw for the iPhone
app (and the Mac TUI) often show things done badly, or differently from the real
current UI. Each agent redraws the app from memory, or from an older mockup.
The owner then judges a design against a picture that is not the app, and the
executor has to choose between the picture and the code.

**Evidence.**
- Owner's example: shell-intent-line mockup v1 had the running-tool blink at
  480 ms and the spinner ring at 0.8 s. The code says 500 ms
  (`packages/tui/src/blink.ts:31` `BLINK_HALF_MS = 500`) and 900 ms
  (`apps/mobile/src/ui/StepNode.tsx:73`, `duration: 900`).
- `mobile-header-status/index.html` pulses the header dot at `1.8s ease-in-out`.
  The real dot pulses at 2 × 700 ms = 1.4 s (`apps/mobile/src/ui/HeaderDot.tsx:40`).
- Four past mockups against `theme.ts`: repro below. Every one uses font sizes
  that are not in `typography` (11, 11.5, 13.5, 14.5, 18, 19 px…), and border
  radii that are not in `radius`. Some of those radii are legitimate. They are
  the phone frame (46) or a component-local metric (the step dot's 6.5), and
  the repro over-counts them. That over-count is the point: today there is no
  source a mockup agent *could* read those values from. So it guesses.
- Prior art is the same failure, one level up.
  `.tentacle/site/mockup-generator/gen-v3.ts` draws TUI frames with helpers
  *copied* from `gen.ts` ("helpers + CSS copied"). Its status line, rules and
  input line are re-typed strings (`MODEL`, `⏵⏵ auto-accept on`, `ctx █░░…`),
  not the TUI's code. `docs/feat/session-capabilities.md:452-458` says the
  iPhone tokens came "from `.tentacle/tmp/mobile-chrome/mockups/index.html`",
  which is a mockup copied from a mockup.
- Mockups live in `.tentacle/mockups/<slug>/` (gitignored; `sync.sh` copies
  `.tentacle/tmp/<slug>/mockups*` there and never deletes). Nothing in the repo
  constrains how they are drawn.

**Goal.** A versioned mockup kit, where faithfulness is a property of how the kit
is built, not of the agent's care:
1. **Tokens generated from source.** No hand-copied value: palettes (light, dark,
   petrol + Figtree), type, radii, sizes, spacing, per-component style metrics
   and animation timings for the phone; palette, glyphs and timings for the TUI.
   If the source changes and the kit is not regenerated, the gate fails.
2. **Components.** A vanilla CSS + JS library (no build step) for the screens
   the app actually has, plus the TUI pieces.
3. **Calibration.** Deterministic (no AI): each kit component next to a real
   screenshot of the same state, with a diff score.
4. **Brief.** `docs/MOCKUP-BRIEF.md`: how a mockup agent must use the kit.
5. **Location.** In the repo, outside the app bundle. It must pass the gate.

**Constraints.** The owner is colour-blind: meaning is never carried by hue
alone. Minimal taste: no rounded inset cards, no pure black, thin icons.
Pre-public repo. This changes no wire, persistence or §7 invariant.

**Repro** (2026-11-21, on this branch = `main` @ `b875a12d`;
`.tentacle/tmp/mobile-mockup-kit/drift.ts`, run with `bun drift.ts`):

```ts
import { radius, typography } from "../../../apps/mobile/src/theme.ts";
const BLINK_HALF_MS = Number((await Bun.file("../../../packages/tui/src/blink.ts").text()).match(/BLINK_HALF_MS = (\d+)/)?.[1]);
const M = "/Users/gmeghnag/tentacle/.tentacle/mockups";
const read = (p: string) => Bun.file(`${M}/${p}`).text();
const radii = new Set(Object.values(radius));
const sizes = new Set(Object.values(typography).map((t) => t.fontSize));
console.log(`code: tui blink half ${BLINK_HALF_MS} ms · StepNode spinner 900 ms · HeaderDot pulse 2×700 ms`);
for (const p of ["shell-intent-line/v1-index.html", "mobile-hub-tools/index.html", "mobile-queued-compose/index.html", "mobile-header-status/index.html"]) {
  const s = await read(p);
  const r = [...new Set([...s.matchAll(/border-radius:\s*([0-9.]+)px/g)].map((m) => Number(m[1])))].filter((v) => !radii.has(v as never));
  const f = [...new Set([...s.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1])))].filter((v) => !sizes.has(v as never));
  const a = [...new Set([...s.matchAll(/([0-9]*\.?[0-9]+m?s) (?:linear|steps\(1\)|ease-in-out) infinite/g)].map((m) => m[1]))];
  const ms = [...new Set([...s.matchAll(/(?:setInterval|setTimeout)\([^)]*?,\s*([0-9]+)\)/g)].map((m) => m[1]))];
  console.log(`${p}\n  radii not in theme.radius: ${r.join(", ") || "-"}\n  font sizes not in theme.typography: ${f.join(", ") || "-"}\n  loop animations: ${a.join(", ") || "-"} · timers ms: ${ms.join(", ") || "-"}`);
}
```

```
code: tui blink half 500 ms · StepNode spinner 900 ms · HeaderDot pulse 2×700 ms
shell-intent-line/v1-index.html
  radii not in theme.radius: -
  font sizes not in theme.typography: 18, 11, 7.4
  loop animations: .8s, 2.2s, 1.6s, 2.4s, 1.2s, 1.4s · timers ms: -
mobile-hub-tools/index.html
  radii not in theme.radius: 46, 4, 16, 3, 10, 24, 15, 9, 7, 1
  font sizes not in theme.typography: 18, 11, 10
  loop animations: - · timers ms: -
mobile-queued-compose/index.html
  radii not in theme.radius: 13, 25, 16, 17, 10, 3
  font sizes not in theme.typography: 18, 13.5, 14.5
  loop animations: - · timers ms: -
mobile-header-status/index.html
  radii not in theme.radius: 999, 7, 46, 3
  font sizes not in theme.typography: 19, 13.5, 11.5
  loop animations: 2.8s, 1.8s · timers ms: -
```

The capability check for the executor: `ls tools/mockup-kit scripts/mockup-kit.ts
docs/MOCKUP-BRIEF.md` → all three missing on `main`.

## Implementation

*— claude-opus-5-5, 2026-11-21*

### Load-bearing assumption

**Every value the kit needs can be read by a Bun script, mechanically, from
React-free source. A value that cannot be read must make the script fail
loudly. It must never fall back to a default.** This splits into three source
kinds, and each was checked:

1. **Theme tokens:** importable today. `apps/mobile/src/theme.ts` has no
   imports and no React (header `:1-11`). It exports `lightPalette`,
   `darkPalette`, `petrolPalette` (`:224-226`), `typography` (`:292-318`),
   `radius` (`:323-348`), `size` (`:350-370`), `shadow` (`:376-378`), `space`
   (`:380-388`), `MONO`, `chartTokensFor`. The Figtree faces are
   `FIGTREE_FACES` in the pure `theme-beta.ts:56-61`, and the files are
   `apps/mobile/assets/fonts/Figtree-*.ttf` (OFL). Proven by the repro, which
   imports `theme.ts` from `.tentacle/tmp` and runs.
2. **TUI tokens and glyphs:** importable. `packages/tui/src/theme.ts:267`
   `export const tokens: Record<ThemeMode, Tokens>`. `blink.ts:31,34`
   `BLINK_HALF_MS`, `BULLET`. `spinner.ts:11` `ARC {frames, intervalMs}`.
   `shimmer.ts:31-40` `SHIMMER_WINDOW`, `SHIMMER_PAUSE_TICKS`,
   `SHIMMER_TICK_MS`. The TUI theme imports `chalk` and `@tentacle/core`, so
   the generator needs a `bun install`ed tree. This worktree has none yet: the
   repro had to regex `blink.ts`, and the executor runs `bun install` first.
3. **Component metrics and motion:** NOT importable today. Two cases:
   - **Style metrics** live in a module-private `const styles =
     StyleSheet.create({...})` inside `.tsx` files that import `react-native`
     (e.g. `StepNode.tsx:603-641`: `dot {13, r 6.5, border 3}`, `ring {9, 1.2}`,
     `spinner {10, 1.5}`, `GUTTER = 10`, `NODE_Y = size.touch / 2`,
     `thoughtText {13.5/19}`). Bun cannot load react-native's Flow sources
     (`apps/mobile/test/text-seam-harness.ts:3-8`). But these objects are
     *constant-foldable*: literals, module consts, theme imports, arithmetic,
     and `StyleSheet.hairlineWidth`. So they are read **statically**, with the
     TypeScript compiler API (`typescript` 5.7.2 is a root devDependency,
     `package.json`), and are not imported.
   - **Animation timings** are partly exported from pure modules already:
     `thinking-motion.ts:13,15` `BREATHE_MS`, `SHIMMER_MS`; `hub-flash.ts:15`;
     `floating-button.ts:29`; `follow.ts:111,359`; `chart-interact.ts:226-229`.
     The rest are **inline literals in components**: `StepNode.tsx:73` (900),
     `HeaderDot.tsx:40` (700), `FloatingActivity.tsx:457` (1200),
     `ActivitySheet.tsx:224` (150), `Composer.tsx:98,101` (`HALO_MS`, `SPIN_MS`,
     module-private), `hub-button-motion.ts:72-73` (220/480 inline),
     `drawer-nav.ts:132` (`DRAWER_MS`, private). That is 24
     `Animated.timing|spring|LayoutAnimation` sites across 10 files (`rg`
     count). These get **hoisted** into one pure, exported module (Slice 1).
     That is a refactor that keeps behaviour, and it is the only part of the
     task that touches app code.

If (3) were false, meaning a metric that can only be computed at runtime, the
kit would be hand-copied again. The design handles that case explicitly: such a
value is reported as unresolved, at its `file:line`, never guessed. Calibration
(Slice 3) is the second net for whatever static extraction cannot see (inline
colours chosen in JSX).

### Preconditions

- **Gate discovery** (§6): root `tsconfig.json` `include` covers
  `scripts/**/*.ts` (typechecked). `bun test` discovers every `*.test.ts`
  (bunfig only preloads; `scripts/test/*.test.ts` already runs, e.g.
  `changelog-guard.test.ts`). `biome check .` covers every non-ignored file
  (`biome.json` `files.ignore`: node_modules, dist, stubs, …), with VCS ignore
  on. Biome 1.9.4 also lints and formats **CSS** and JSON, but not HTML.
  Executor: confirm with `bunx biome check tools/mockup-kit` on the first CSS
  file.
- **Generated, committed, drift-tested** has a precedent:
  `packages/protocol/schema/protocol.json` is generated by `schema:export` (and
  then `biome format`) and pinned by `protocol/test/json-schema.test.ts` (§10
  merge step). The kit's generated files follow that pattern.
- **Screenshot harness** (`scripts/e2e-gate.sh` → `apps/mobile/e2e/run.ts`):
  Maestro flows. `flows/_shot.yaml` shoots `${SHOT}-light` and then
  `${SHOT}-dark` (the `appearance.js` hook) after `waitForAnimationToEnd`.
  Results go to `.tentacle/tmp/e2e-mobile/<runId>/ios<major>/<flow>/`
  (`run.ts:838-850`, `--test-output-dir`, `:1777`). `--only a,b` narrows the
  flows (`run.ts:63,106`). There is no status-bar override today (`rg
  status_bar` → none), so the clock and battery differ per run.
- **Mock model states** are deterministic: `TOOLROWS29` (tool rows, a round-3
  thinking window `TOOLROWS_THINK_MS = 2500`, "long enough for a flow to shoot
  the footer", `e2e/mock-model.ts:246-247`) and `THINKHOLD` (`:625-634`).
- **TUI frames** can be rendered for real with `ink-testing-library`
  (`packages/tui/test/app.test.tsx` pattern, AGENTS §1/§6).
- **Owner taste and accessibility rules** already in the code:
  `harness-notices` decision "glyph first, amber only on the glyph" (TUI
  `theme.ts` Tokens doc); E2 bands are square, `radius.card = 0`
  (`theme.ts:325`). The dark ground is `#1E1F21` / petrol `#151B1D`, never
  `#000` (except `camera`).

### Design

Two halves with one contract between them. The **generator**
(`scripts/mockup-kit.ts`, typed, typechecked, tested) reads the source and
writes **generated** files. The **kit** (`tools/mockup-kit/`, vanilla CSS + JS,
no build step) reads only those generated files.

#### Where it lives (justification)

| Option | Verdict |
|---|---|
| **`tools/mockup-kit/` (assets) + `scripts/mockup-kit*.ts` (generator) + `scripts/test/` (tests)** | **Chosen.** It is versioned. It is not a workspace (`workspaces: packages/*, apps/*`), so there is no `bun install` or package semantics. It is outside both tsconfigs (`tools/` holds no `.ts`) and outside Metro's graph (nothing in `apps/mobile` imports it). The generator sits where `scripts/**/*.ts` is already typechecked, and its tests sit where `scripts/test` is already discovered. The CSS/JS/JSON pass Biome like any other source. |
| `packages/mockup-kit` | A workspace implies a runtime package, a `package.json` and install. It is overkill for static assets. |
| `apps/mobile/mockup-kit/` | `apps/mobile/tsconfig.json` includes `**/*.ts`. It sits next to Metro's root, and it mixes dev tooling into the app's tree, which `--filter '!@tentacle/mobile'` CI skips. |
| `.tentacle/…` (today) | It is gitignored: not versioned, not reviewed, not drift-tested. That is the problem being solved. |
| `docs/mockup-kit/` | `docs/` is prose. Executable CSS/JS there would be linted anyway, and it confuses the docs carve-out (§10). |

#### Slice 1 — tokens + generator

**1a. Motion hoist (app code; behaviour unchanged).** A new pure
`apps/mobile/src/motion.ts`: one exported, documented `const` per timing, named
for what it animates. Examples: `STEP_SPINNER_TURN_MS = 900`,
`HEADER_DOT_HALF_MS = 700`, `COMPOSER_HALO_MS = 1200`,
`COMPOSER_TRANSCRIBE_TURN_MS = 900`, `FLOATING_GLOW_MS = 1200`,
`ACTIVITY_SHEET_RESIZE_MS = 150`, `HUB_BUTTON_PRESS_IN_MS = 220`,
`HUB_BUTTON_RELEASE_MS = 480`, `DRAWER_MS = 220`, `STEP_ELAPSED_TICK_MS = 1000`.
The executor names all 24 sites from the `rg` list. Each component imports the
constant instead of the literal. Constants already exported from a pure module
(`BREATHE_MS`, `SHIMMER_MS`, `FLASH_MS`, `floating-button` `FADE_MS`, `SETTLE_MS`,
`DRAW_MS`…) stay where they are. The generator imports them by name. **Easing
curves** go into the same module as data (e.g. `HEADER_DOT_EASING =
"inOut(ease)"`) only where the kit needs to name them, and each maps to a CSS
`cubic-bezier` through one table in the generator.

Guard (pure test): no `duration:` / `setInterval(…, <n>)` / `delay:` with a
**numeric literal** may remain in `apps/mobile/src/{ui,screens}/**/*.tsx`. The
check is AST-based (TS compiler API), so a comment or a string does not trip it.
Otherwise a new animation could bypass the kit silently.

**1b. Style-metric extraction (static, no app change).**
`scripts/mockup-kit/extract-styles.ts`: for a fixed **component manifest**
(`scripts/mockup-kit/manifest.ts`: `{ id: "step", file:
"apps/mobile/src/ui/StepNode.tsx" }`, plus Composer, Sheet, HubFan, Pill,
PillButton, Banner, Row, BandSection, ScreenHeader, GlassButton, EmptyState,
HeaderDot, `screens/transcript/TranscriptRow.tsx`, `Markdown.tsx`,
`PermissionSheet.tsx`, `ComputersScreen.tsx`, `SessionsDrawer.tsx`; the executor
confirms each has a `StyleSheet.create`), it parses the file and finds the
top-level `StyleSheet.create({…})`. It then **constant-folds** every property
value through a small evaluator:
- numeric/string literals and unary minus;
- `+ - * /`;
- identifiers bound to a module-level `const` in the same file (folded
  recursively);
- imported theme members (`size.touch`, `space.inset`, `typography.step`,
  `radius.bubble`, `MONO`), resolved against the *imported* `theme.ts` module
  object, so they are not parsed twice;
- `StyleSheet.hairlineWidth` → the iOS @3x value `1/3`, from one named table.

Anything else (a call, a conditional, a spread of a non-theme value) is
**unresolved**. It is recorded as `{component, style, prop, file:line, source}`,
printed to stderr, and written to the JSON's `unresolved` list. It never gets a
default value.

**1c. Emitted artefacts** (written by `bun scripts/mockup-kit.ts gen`, then
`biome format --write` on them, like `schema:export`):
- `tools/mockup-kit/generated/tokens.css`:
  - `:root, [data-theme="light"]`, `[data-theme="dark"]` and
    `[data-theme="petrol"]` blocks of `--c-<paletteKey>` (camelCase →
    kebab-case, mechanically: `accentSoftStrong` → `--c-accent-soft-strong`),
    plus `--chart-<key>` from `chartTokensFor`;
  - `--t-<style>-size|lh|weight|tracking|family` from `typography`;
  - `--r-<key>`, `--s-<key>`, `--sp-<key>`, `--shadow-glass`;
  - `--m-<component>-<style>-<prop>` from 1b (numbers in `px`; 1 pt = 1 CSS px
    at the frame's 393×852 pt viewport);
  - `--ms-<name>` for every timing;
  - `[data-font="figtree"]` with `@font-face` pointing at
    `../../../apps/mobile/assets/fonts/Figtree-*.ttf` (relative; inlined as
    base64 by `inline`, below), face names from `FIGTREE_FACES`.
- `tools/mockup-kit/generated/tui-tokens.css`:
  - `[data-tui="dark|light"]` `--tui-<token>` from `tokens.dark|light`
    (nested groups flattened: `diff.addBg` → `--tui-diff-add-bg`);
  - dark-mode **named chalk colours** (the "named chalk colour in dark mode"
    case, `theme.ts` `Color` doc) map to hex through one table in the
    generator (the xterm defaults). The table is documented as
    terminal-dependent. An unknown name fails.
- `tools/mockup-kit/generated/kit-data.json`: the same values typed for JS.
  `{ source: {file → git blob sha}, timings: {name: ms}, easing: {…}, glyphs:
  { bullet, spinner: {frames, intervalMs}, shimmer: {window, pauseTicks,
  tickMs}, blinkHalfMs, therefore: "∴", wake: "◷" }, typography, palettes,
  metrics, unresolved: [...] }`.
  - The glyphs come from the TUI modules and from the pure mobile modules
    (`thinking-motion.ts` `DOT_ORDER`, `breatheCurve` sampled at its key
    points, and `thinkingLook(false|true)`).
  - **View-model tables:** where a pure module already decides a visual state,
    the generator evaluates it over canonical inputs and stores the result, so
    the kit never re-derives it. Examples: `thoughtRowView`, `thinkingLabel` at
    0 / 3 s / 65 s, `stepRowView` over the four `StepDot`s. The executor lists
    the exported pure functions it can call without React (`tool-steps.ts:121-394`
    and `thinking-motion.ts:55-127` are the first candidates).
  - The `source` shas let the calibration page say "generated from blob X".

**1d. Loud failure on rename.** Three nets:
1. *Typecheck:* the generator imports named members (`lightPalette`, `radius`,
   `BLINK_HALF_MS`…). Renaming one in source breaks `tsc --noEmit` (root
   tsconfig includes `scripts/**`).
2. *Drift test:* `scripts/test/mockup-kit.test.ts` regenerates in memory and
   compares byte-for-byte with the committed `generated/*`. A changed hex,
   timing or style metric with no `bun run mockup-kit` fails `bun test` with a
   diff of the first mismatching var and the hint `run: bun run mockup-kit`.
3. *Reference test:* every `var(--…)` used in `tools/mockup-kit/kit.css`,
   `kit.js` and `tui.css` must exist in the generated CSS, and every
   `KIT.data.<path>` the JS reads must exist in `kit-data.json`. A
   theme/style-key rename produces a new name, the kit still asks for the old
   one, and the test names it. Also: no `unresolved` entry may be referenced.

`package.json` gains `"mockup-kit": "bun scripts/mockup-kit.ts gen"`.

#### Slice 2 — components (vanilla CSS + JS, no build)

`tools/mockup-kit/`:
- `kit.css` — layout and look only. **Every number and colour is a `var()`
  from generated CSS.** A literal hex, `px` (other than 0/1px hairlines) or
  `ms` in `kit.css` / `tui.css` is a test failure (the "no hand-copied value"
  rule, enforced by the same reference test, with an explicit allowlist for
  frame-only values such as the phone corner radius, held in `frame.css`).
- `frame.css` — the device frame (393×852 pt viewport, iPhone 15/16 class, the
  same model the e2e simulator runs; the executor reads the UDID's device type
  from the gate config). It holds the frame metrics that do not come from the
  app (corner radius, status-bar height 54 / home indicator) and labels them
  as such.
- `kit.js` — an ES module with no dependencies, in two layers:
  - **pure builders** (no DOM): `K.<component>(props) → {html, a11y}` strings,
    runnable under Bun (used by tests and calibration);
  - **a mount helper** `K.screen(el, {theme: "light"|"dark"|"petrol", font:
    "system"|"figtree", reduceMotion}, children)`.

  It loads `generated/kit-data.json` via `import … with { type: "json" }` in
  dev. The `inline` command embeds it.
- iPhone components, each with its states named after the code's own names:
  - `phone` (frame + status bar 9:41)
  - `sessionHeader` (title, model subtitle, `HeaderDot` idle/running/pulse, the
    `…` menu glyph)
  - `userBubble`
  - `assistantText` (markdown subset: p, strong/em, inline code, code block,
    list, link; `Markdown.tsx` metrics)
  - `stepRail` + `stepNode` (states `running` / `ok` / `error` / `pending`
    ring / `thought` ∴ / `thinking` live ∴ with breathe + shimmer / `wake` ◷;
    thread up/down per `ThreadPos`; the 1 s elapsed clock simulated)
  - `thoughtRow` (folded, open)
  - `stepBody` (mono lines, diff via `addBg`/`delBg`…, error text)
  - `composer` (empty, draft, ready-to-send, dictating halo, transcribing arc,
    queued chips)
  - `permissionSheet` (approval, diff)
  - `sheet` (grabber, `radius.sheet`, scrim)
  - `pill` / `toast` / `banner`
  - `hubButton` (opacity levels, running glow) + `hubFan` + `hubMore` (modal)
  - `emptyAction` (the `EmptyState` standard)
  - `band` / `row` (E2 bands, square)
  - `computersList`, `projectsList`, `sessionsDrawer`
- Each component's states that depend on a decision read the **view-model
  tables** from `kit-data.json` (Slice 1c), so the kit does not re-implement
  the app's logic.
- `«nuovo»` support: `K.extend(name, builder)` registers a new component. It
  renders with a visible dashed outline and a `«nuovo»` tag in a mode the
  reviewer can switch on (`?nuovo=1`). The brief makes this mandatory for
  anything not in the kit.
- **TUI:**
  - `tui.css` + `K.tui.*`: `transcriptRow` (user, assistant, tool row with the
    blinking `●` at `blinkHalfMs`, ok/error bullet, `◇`/`▲` harness notices),
    `slot` (thinking shimmer at `SHIMMER_TICK_MS` / window / pause; spinner
    `ARC` frames at `intervalMs`), `inputBox` (`❯` prompt, placeholder,
    cursor), `statusLine`;
  - a monospace cell grid. Each builder also returns `cells: string[]` (the
    plain text per row), for calibration.
  - `K.tui.fromAnsi(text)` converts a **real** frame (SGR kept) into the same
    grid with `--tui-*` colours. That is the recommended way to show an
    *existing* TUI screen: render it, do not redraw it (see the brief).
- `tools/mockup-kit/index.html` — the catalogue: every component × every state
  × light/dark/petrol, the motion running, and a Reduce Motion toggle. It is
  also the brief's "look here first" page.
- `bun scripts/mockup-kit.ts inline <in.html> [out.html]` — produces a
  self-contained snapshot. It inlines `kit.css`, `frame.css`, `tui.css`,
  generated CSS, `kit.js`, `kit-data.json` and the Figtree faces (base64), and
  stamps `<meta name="mockup-kit" content="<git sha of tools/mockup-kit>">`.
  Mockups shown to the owner are **inlined**, so `sync.sh`'s copy in
  `.tentacle/mockups/` stays frozen and still opens after the kit changes.
  With a relative link it would break or silently re-style old proposals.

#### Slice 3 — calibration (deterministic)

`bun scripts/mockup-kit.ts calibrate [--run <e2e runDir>] [--udid <udid>]`
writes `.tentacle/tmp/mockup-kit/calibration/index.html` + `report.json`.

1. **Real side.** By default, the screenshots of the **latest gate run**
   (`.tentacle/tmp/e2e-mobile/<newest runId>/ios<major>/<flow>/<SHOT>-{light,dark}.png`).
   With `--udid`, a narrow run of only the calibration flows (`run.ts --only …`).
   Determinism:
   - a new `run.ts` step (behind `E2E_CALIBRATION=1`, so the normal gate is
     unchanged) sets `xcrun simctl status_bar <udid> override --time 9:41
     --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3`
     and clears it after;
   - Reduce Motion is ON for the calibration run, so the spinner, the ∴ and
     the halo sit at their still frames (the code's `still` paths). The kit
     renders the same still state. How to set Reduce Motion in the simulator
     is to be verified by the executor: the accessibility defaults domain, or
     Maestro's `setAccessibility…`; if neither works, mask those nodes.
2. **Kit side.** `tools/mockup-kit/calibration/cases.json`: one case per
   (component, state, theme). Each case gives a SHOT name, a **crop rect** in
   screenshot pixels (@3x), the kit builder call reproducing that state with
   the same text content as the mock model's turn, and the mask rects
   (status-bar clock if not overridden, a caret). It is rendered by **headless
   Chrome via its CLI** (`--headless=new --screenshot --window-size=393,852
   --force-device-scale-factor=3 --hide-scrollbars`). No npm dependency. The
   binary is found at the standard macOS path or `$CHROME`. If it is missing,
   the command exits 2 with a clear message.
3. **Score.** `scripts/mockup-kit/png.ts` is a minimal PNG decoder (8-bit
   RGB/RGBA, non-interlaced, `node:zlib` `inflateSync`; it refuses anything
   else loudly) plus a pixel diff. A pixel counts as different when a channel
   is > 24/255 away **and** no pixel within 1 px of it in the other image
   matches (anti-aliasing tolerance). `score = 1 − differing / cropArea`. Bands:
   ≥ 0.98 green · ≥ 0.92 amber · below red. The bands are shown as **text and
   a glyph** (`✓` / `≈` / `✗`), not only as colour. The page shows: real crop ·
   kit crop · diff heat-map · score, per case. It is informational and NOT a
   gate (fonts and rasteriser differ: Chrome vs UIKit). Its job is to make
   drift *visible*, and to give a number a reviewer can compare run to run.
4. **TUI calibration is a text diff, not an image diff.** For `statusLine`,
   `inputBox`, a tool `transcriptRow` and `slot`, the case renders the real Ink
   component with `ink-testing-library` (the `app.test.tsx` pattern) and the
   kit builder with the same props, then compares `cells` row by row after
   `trimEnd`. It is deterministic and cell-exact. It runs in `calibrate` and,
   since it needs no simulator, also as a **gate test**
   (`packages/tui/test/mockup-kit-calibration.test.tsx`: it lives in the tui
   package because React/Ink resolve only there, §6). A drift between
   `kit.js`'s TUI builders and the real components fails `bun test`.

**Screens the harness reaches today** (existing `_shot` names → kit
components):

| Kit component / state | Existing SHOT (light+dark) |
|---|---|
| phone, sessionHeader, userBubble, assistantText | `24-conversation`, `36-{on,off}-chat-markdown` (petrol = `36-on-*` dark) |
| stepRail running / collapsed / open / error, stepBody | `29-tool-rows-running`, `-collapsed`, `-open`, `-error-open`; `36-{on,off}-chat-tools` |
| composer (closed/keyboard, queued, outbox) | `23-keyboard-closed`, `23-keyboard-open`, `12-queue`, `16-outbox`, `16-offline` |
| permissionSheet approval / diff | `08-approval`, `08-diff` |
| hubButton opacity / running, hubFan | `33-hub-opacity-band(-80)`, `33-hub-opacity-20(-running)`, `33-hub-fan(-running)` |
| computersList / projectsList | `24-computers`, `05-computers-offline`, `36-*-computers`, `37-a1-two-projects`, `37-a4-project-sheet`, `37-a3-stopped`, `37-a5-revoked-one` |
| sessionsDrawer, session menu, settings bands | `24-drawer`, `26-drawer`, `05-drawer-offline`, `24-session-menu`, `24-settings`, `25-session-info-*` |
| empty state (search) | `24-sessions-no-match` |

**New e2e states needed** (each is a `_shot` added to an **existing** flow, so
no new flow and no new session):
1. `29-tool-rows-thinking`: the live ∴ footer. The state exists (round-3
   `TOOLROWS_THINK_MS` window); only the shot is missing.
2. `29-thought-row` folded + open: if `TOOLROWS29` emits reasoning, add the
   shot; else extend the mock turn with one reasoning block. The executor
   checks `mock-model.ts:343`.
3. `33-hub-more`: the hub More modal (`_hub-more.yaml` reaches it in the 34-*
   flows; no shot today).
4. `33-empty-activity`: the "Nothing running" empty-action (33 already taps
   it; no shot).
5. `pill/toast`: a transient one (e.g. "Copied", or the compact slot's
   `Compacted ✓` for `COMPACTED_SHOWN_MS = 3000`). The shot must land inside
   the window. If no flow reaches one reliably, it is **deferred**. The case
   is then listed as "no real reference" on the page, never scored against
   nothing.

#### Slice 4 — `docs/MOCKUP-BRIEF.md`

It has the shape of `EXECUTOR-BRIEF.md` (≲ one screen):
- Read `tools/mockup-kit/index.html` first.
- Every mockup `<link>`s and `import`s the kit by relative path from
  `.tentacle/tmp/<slug>/mockups/`. It composes **only** `K.*` components.
  Anything new is built with `K.extend` and marked `«nuovo»`. No new hex, size
  or timing literal outside an extension, and an extension uses `var(--…)`
  tokens too, or justifies the new value in its `«nuovo»` note.
- An existing TUI screen is **rendered, not drawn**: ink-testing-library frame
  → `K.tui.fromAnsi`.
- Every frame is shown in **light and dark** (petrol when the Figtree beta is
  in scope).
- Meaning is **never carried by hue alone**: glyph, shape, text or position
  first; colour only reinforces. (Owner colour-blind.)
- Minimal taste: no rounded inset cards (E2 bands are square), no pure black,
  thin icons (SF Symbols weight light/regular, never bold glyph icons).
- Before handing over: `bun scripts/mockup-kit.ts inline` → the owner gets the
  inlined file. A mockup that shows a **current** screen must match the kit. If
  the agent believes the kit is wrong, it reports it, and does not patch around
  it in the mockup.
- `AGENTS.md`: one line in §10 "Agent briefs" naming `MOCKUP-BRIEF.md`. That is
  a rule addition riding this feat branch (§10 carve-out (c): it rides the code
  task, it is not direct-to-main).

### Files

In dependency order:

1. `apps/mobile/src/motion.ts` (new, pure).
   `apps/mobile/src/ui/{StepNode,HeaderDot,Composer,FloatingActivity,HubFan}.tsx`,
   `ui/chart/ChartAppear.tsx`, `screens/{ActivitySheet,SessionsDrawer}.tsx`,
   `screens/transcript/SwipeTime.tsx`, `ui/animate.ts`,
   `hub-button-motion.ts`, `drawer-nav.ts`: literal → import (only those lines).
2. `apps/mobile/test/motion-literals.test.ts` (new): the AST guard of 1a.
3. `scripts/mockup-kit.ts` (CLI: `gen` | `inline` | `calibrate`).
   `scripts/mockup-kit/{manifest,extract-styles,emit,png,diff,calibrate,inline}.ts`.
4. `scripts/test/mockup-kit.test.ts`, `scripts/test/mockup-kit-png.test.ts`.
5. `tools/mockup-kit/generated/{tokens.css,tui-tokens.css,kit-data.json}`
   (generated, committed).
6. `tools/mockup-kit/{kit.css,frame.css,tui.css,kit.js,index.html,README.md}`.
   `tools/mockup-kit/calibration/{cases.json,page.html}`.
7. `packages/tui/test/mockup-kit-calibration.test.tsx`.
8. `apps/mobile/e2e/run.ts` (calibration mode: status-bar override, Reduce
   Motion). `apps/mobile/e2e/flows/{29-tool-rows,33-hub}.yaml` (new `_shot`s);
   `mock-model.ts` only if item 2 needs it.
9. `docs/MOCKUP-BRIEF.md`; `AGENTS.md` §10 (one line); `package.json`
   (`mockup-kit` script).
10. `TODO.md`: index line (`Type: feat · Size: L · Blast: cross-module ·
    Suited: opus + fresh-context review`), added on `main` by the orchestrator
    (carve-out).

### Failure modes

| Failure | Behaviour / convergence |
|---|---|
| Token renamed or removed in `theme.ts` / TUI `theme.ts` | Generator's named import → `tsc` fails. If it is iterated generically (palette keys), the CSS var name changes → the reference test names the missing `var(--c-old)`. Loud either way. |
| Token **value** changed, kit not regenerated | Drift test fails with the first differing var and `run: bun run mockup-kit`. |
| A new palette key added | Emitted automatically (generic iteration). Not used by the kit until a component asks for it. No failure, and none is needed. |
| Style key renamed in `StepNode.tsx` | `--m-step-<old>-*` disappears → reference test fails. |
| A style becomes non-foldable (a call, a conditional) | Listed in `unresolved` with `file:line`. If the kit references it, the test fails; else the generator only warns. Never a default value. |
| A component in the manifest is moved or renamed, or loses its `StyleSheet.create` | The generator throws `manifest: <id> → <file>: no StyleSheet.create`. |
| A new animation with a literal duration | The motion-literal guard test fails at its `file:line`. |
| An unknown chalk colour name, or easing | The generator throws (explicit tables, no fallback). |
| Biome rejects generated output | The generator runs `biome format --write` on what it writes; the drift test compares the formatted bytes. |
| Calibration: Chrome missing / no gate run / UDID missing | Exit 2 with what is missing. Never an empty "all green" page. |
| Calibration: a SHOT missing from the run (flow failed, quarantined) | That case shows "no reference (flow X did not run)" and is not scored. The page counts unscored cases. |
| Calibration: crop rect stale after a real layout change | The score drops → red. That is the intended signal. The fix is to update the crop in `cases.json` *or* the kit, and the page says which: the kit and real crops are shown side by side. |
| PNG with an unsupported format (16-bit, interlaced, palette) | The decoder throws with the PNG header fields, and the case is reported as an error. It is not skipped. |
| Status bar / animation nondeterminism | Status-bar override + Reduce Motion in calibration mode. Residual differences are masked by explicit rects in `cases.json`, so a reader can see them. |
| Old mockups after a kit change | Inlined snapshots are frozen (sha stamped), so they are not affected. A mockup left with a relative link re-styles: the brief forbids handing those over. |
| The kit reaches the app bundle | Nothing under `apps/mobile` imports `tools/`. The executor checks with `rg "mockup-kit" apps/mobile/src apps/mobile/App.tsx` → empty. |

### Tests

Red first for every generator unit (§9). Each test pins the exact property:
- **Folding** (`mockup-kit.test.ts`), on fixture sources written as strings:
  literal, const chain, `size.touch / 2`, `StyleSheet.hairlineWidth`, an
  imported theme member → the expected value. A call or conditional → in
  `unresolved` with the right line. A file without `StyleSheet.create` →
  throws.
- **Emission:** camelCase → kebab-case; three theme blocks hold exactly the
  `Palette` keys (count = `Object.keys(lightPalette).length`); petrol inherits
  dark's semantic colours. Pinned on one value (`--c-red` petrol = dark).
- **Drift:** generated-in-memory === committed bytes. *Non-vacuity:* change
  one hex in a temporary copy of the theme, passed through the generator's
  injectable source map. The test must fail, and the failure is shown in
  Execution.
- **Reference:** every `var(--x)` and `KIT.data.<path>` in the kit resolves.
  *Non-vacuity:* rename one key in a fixture token set → fails, naming it.
- **No literals in `kit.css` / `tui.css`** outside the allowlist. *Mutation:*
  insert `color:#000` → fails.
- **Motion guard:** a fixture `.tsx` with `duration: 900` → flagged at its line.
  The same with `duration: STEP_SPINNER_TURN_MS` → clean. The real tree →
  clean after 1a, and RED on the tree before 1a (shown in Execution).
- **Motion hoist preserves values:** `motion.ts` constants equal the literals
  they replaced (a table test, written from the pre-hoist `rg` output pasted
  in Execution).
- **PNG/diff** (`mockup-kit-png.test.ts`): decode a tiny fixture PNG generated
  in-test (`zlib.deflateSync` of known rows) and assert the pixels. Identical
  → score 1. A 1-px shift of an edge → still ≥ 0.98 (AA tolerance). One flipped
  solid block → the exact expected ratio. An interlaced header → throws.
- **Inline:** the output has no `href=`/`src=`/`import` pointing outside
  itself (regex over the result), and it carries the sha meta.
- **TUI calibration** (gate): for each TUI builder, the kit `cells` equal the
  real Ink frame. *Mutation:* change `BULLET` in the kit builder → red.
- The full gate before done: `bun run check` (lint baseline clean, §6).

### Notes / debt (deliberate)

- Inline colours chosen in JSX (`StepNode.tsx:285` `kind === "ok" ? palette.green
  : palette.red`) are **not** statically extracted. The kit maps them by hand
  in `kit.js`, and calibration is the net. The proper fix is to move such
  branching into pure modules (AGENTS §7), which would make them view-model
  tables. That is out of scope here; it is a follow-up per component.
- **Found while planning:** a step node's ok vs error is a **dot of the same
  shape, green vs red** (`StepNode.tsx:285`). The error also turns the
  trailing text red (`:433`), but the node itself differs by hue only, against
  the owner's colour-blind rule. The kit will reproduce it faithfully. A
  separate `fix/` is recommended (Q6).
- The calibration score is not a gate: different rasterisers. The TUI text
  calibration is a gate.

### Questions

1. **Gate-enforce the generated tokens** (drift test, like `protocol.json`)?
   Then any `theme.ts` / timing change also needs `bun run mockup-kit` on its
   branch. **Rec: yes.** This is the only thing that makes "faithful" hold over
   time. The cost is one command, and the failing test prints it.
2. **The motion hoist touches ~10 mobile UI files** (behaviour unchanged,
   literals → named constants, plus a guard test). The alternative is to
   AST-scan inline `duration:` literals without touching app code, but those
   cannot be named reliably. **Rec: hoist.** It also follows §7 (values in
   pure modules).
3. **Calibration renderer: headless Chrome CLI** (no npm dependency; needs
   Chrome installed; opt-in, outside the gate). The alternatives are adding
   Playwright (a heavy dependency) or rendering the kit in simulator Safari
   (same WebKit, but its own chrome, scrolling and URL plumbing). **Rec:
   Chrome CLI.** Revisit Safari only if the scores prove too noisy.
4. **New `_shot`s in flows 29 and 33** (thinking footer, Thought row, hub More,
   empty action; a toast if reachable) plus a `E2E_CALIBRATION` mode in
   `run.ts`. This adds a few seconds to the gate. **Rec: yes**, with no new
   flow and no new session.
5. **Mockups handed to the owner are inlined snapshots** (frozen, sha-stamped),
   not relative links. **Rec: yes.** `sync.sh` keeps old proposals forever, and
   they must not re-style when the kit changes.
6. **Open a separate `fix/` for the step node's ok/error differing by hue
   only?** **Rec: yes**, a small contained fix. The shape option to decide in
   that task is ✓ / ✕ glyph nodes vs a hollow error node.

## Execution

_(empty — filled by the executor)_

## Review

_(empty — filled by a fresh-context reviewer)_
