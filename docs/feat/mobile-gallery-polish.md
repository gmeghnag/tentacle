# feat/mobile-gallery-polish — Artifacts gallery: clipped chart thumbnails, bigger tiles, grid ↔ list

> **Status:** review
> **Branch:** `feat/mobile-gallery-polish`
> **Size:** M · **Blast:** contained · **Suited:** Opus plans + executes (owner asked for one pass); standard Review
> **Changelog:** `changelog.d/mobile-gallery-polish.changed.md`

## Context

*— claude-opus-5-5, 2026-11-20*

Owner, 2026-11-20, with a phone screenshot of the Artifacts gallery ("così è
orrenda"):

1. **Bug** — chart thumbnails overflow their 40 pt tile: bars and the coloured
   legend chips spill outside the tile and stack down the list, even below the
   last row.
2. Icons/thumbnails "un filino più grandi".
3. A switch between GRID and LIST.

Design source (approved 2026-11-16): `.tentacle/mockups/model-artifacts/index.html`
section 7 — list **A** (chosen then) and grid **B** (3 columns, square cells, title
label at the bottom, new-dot top-right, 2 pt gaps), a toggle icon in the gallery
header. Owner UI rules: minimal, no rounded inset cards, no pure black, thin SF
Symbols (`weight: light`), colour-blind (never hue alone), hit areas ≥ 44 pt.

**Approved:** the owner asked for the work itself; no product decision was left
open by the plan below (grid = mockup B as approved; the list stays the default).

### Repro (2026-11-20, on `main` 3628eb28)

`.tentacle/tmp/mobile-gallery-polish/repro.ts` — the gallery's thumbnail exactly
as `main` computes it (`chartThumbView(meta, bytes, {width: 40, height: 32, …})`,
`ArtifactGallery.tsx:137-139`), six chart kinds (the owner's screenshot as
fixtures: scatter, pie, doughnut, stacked area, bar, a 180-point line), printing
the layout's size, its plot rect and the extent of what `ChartThumbnail` draws:

```ts
const v = chartThumbView(meta, bytes, { width: 40, height: 32, fontScale: 1, locale: "it", palette: lightPalette });
// bbox of every number in every path `d` + every dot ± r
console.log(name, L.kind, `layout ${L.width}x${L.height}`, `plot t.. b.. l.. r..`, `geom x[..] y[..]`, counts);
```

```
scatter  scatter  layout 40x32  plot t19 b11 l0 r40    geom x[24,36] y[7,23]     paths 1 dots 8 texts 3 legend 2
pie      donut    layout 40x32  plot t0 b32 l0 r40     geom x[-44,158] y[-44,104] paths 11 dots 0 texts 14 legend 0
doughnut donut    layout 40x32  plot t0 b32 l0 r40     geom x[-46,158] y[-48,80]  paths 14 dots 0 texts 17 legend 0
area     area     layout 40x32  plot t19 b11 l0 r40    geom x[0,41] y[11,18]      paths 7 dots 1 texts 3 legend 3
bar      bars     layout 40x128 plot t0 b128 l23 r40   geom x[0,120] y[0,123]     paths 12 dots 0 texts 4 legend 2
stress   line     layout 40x32  plot t19 b11 l0 r40    geom x[2,42] y[11,21]      paths 2 dots 1 texts 3 legend 0
```

Path roles at 40×32: `pie: sector:4 swatch:4 baseline:3`, `bar: track:4 bar:8`.

Reading it:
- **Pie/doughnut** draw 4× outside the box: the donut has a FIXED ring
  (`DONUT = { ri: 47, ro: 60 }`, `chart-layout-shapes.ts:418`, centre
  `cx = ro + 6`, `:429`) and its legend chips (`swatch` paths) at
  `x0 = cx + ro + 24` (`:475`) — the coloured chips in the screenshot.
- **Bars** ignore the height they are given (`const height = n * rowH`, `:160`):
  a 40×128 drawing in a 40 pt tile.
- **Line/area/scatter** reserve axis chrome, so a 32 pt plot is INVERTED (top 19 >
  bottom 11): the drawing is squashed into a few points.
- `ChartThumbnail` sizes its `Svg` to the LAYOUT (`ChartThumbnail.tsx:35`,
  `width={layout.width} height={layout.height}`), and the tile has no clip
  (`ArtifactGallery.tsx:364` `tile` style: no `overflow`) — so the bar drawing's
  128 pt and the donut's legend paint over the rows below.

**Root cause (one sentence):** the gallery tile reused the TRANSCRIPT chart layout
at 40×32 — whose donut ring, legend chips and bar rows have fixed sizes and whose
axis chrome inverts a tiny plot — and drew it in an unclipped tile sized to that
layout, not to the tile.

**Before screenshots:** see Execution (flow 35 on `main`'s bundle).

## Implementation

*— claude-opus-5-5, 2026-11-20*

### Load-bearing assumption

A chart's MARKS (paths of role `line | fill | bar | sector | trend`, and a
scatter's dots) lie inside a computable box of the layout — the plot rect for
every axis kind, the disc for a donut — so one layout at a reference size can be
scaled into any tile through an SVG `viewBox` with nothing outside it. Verified
on the six kinds by the repro at 160×120 (roles: `chart-layout-kit.ts:34`; the
donut's centre: `chart-layout-shapes.ts:429-430`; `plot` is part of every
`ChartLayout`, `chart-layout-kit.ts:147-152`) and pinned by
`test/chart-thumb.test.ts` ("every drawn point is inside the view box").

### Preconditions

- `chartThumbView` already re-validates the artifact's bytes through the
  transcript's `chartRowView` (`chart-row.ts:139-149`): a forged spec lays out
  nothing. The new module goes through it, never around it (AGENTS §7: a pod is
  not trusted).
- The gallery fetches bytes only for `wantsChartThumbnail` (`chart-row.ts:127`),
  unchanged.
- `react-native-svg`'s `Svg` takes `viewBox` + `preserveAspectRatio` and clips to
  its viewport.
- Settings records follow `chart-settings-store.ts` (`{v:1,…}` behind
  `SecureKV`, fail-safe on unknown versions); only `*-expo.ts` files import the
  Keychain (`test/pairing-guards.test.ts`).

### Design

- **`src/chart-thumb.ts` (new, pure).** `chartThumbGeometry(meta, bytes, opts)`
  lays the chart out ONCE at `THUMB_LAYOUT = 160×120` through `chartThumbView`,
  keeps only the marks (drops `swatch` = legend chips, `baseline`, `track`,
  every text and guide, and a line/area's annotation dots), and computes the
  `viewBox`: the donut's disc (`donutDisc`, now exported from
  `chart-layout-shapes.ts` and used by `donutLayout` itself — one source of
  truth), else the plot rect grown by the largest dot/stroke reach.
  `chartThumbAt(geometry, box)` gives one tile's drawing — or `null` when the
  chart is not legible there (its thinnest mark — a bar's thickness, a ring's
  depth — under `MIN_MARK = 1.5` pt at that scale), widening strokes and scatter
  dots so they keep `MIN_STROKE`/`MIN_DOT` on screen.
- **`ChartThumbnail.tsx`** draws a `ChartThumbView`: `Svg` at the TILE's size
  with the `viewBox`, `xMidYMid meet`, root `overflow: hidden`. No guides.
- **`src/gallery-layout.ts` (new, pure):** `GalleryLayout = "list" | "grid"`,
  `otherLayout`, `layoutToggle` (icon + VoiceOver label of the look a tap
  switches TO: `square.grid.2x2` / `list.bullet`), `LIST_TILE = 52`,
  `LIST_ROW_PADDING = 8`, `gridCell(width)` (3 columns, 2 pt gaps, whole points),
  `gridRows`, `kindSymbol(kind)` (one distinct thin SF Symbol per kind, replacing
  the text glyph in tiles) and `kindSymbolSize(tile)`.
- **`src/gallery-settings-store.ts` (new, pure) + `gallery-settings-expo.ts`
  (wiring):** `tentacle.gallery = {v:1, layout}`, the Charts setting's rules; the
  holder loads once per run, a pick wins over a read still in flight, a failed or
  refused save still switches the look for this run.
- **`ArtifactGallery.tsx`** renders: header `right` = the toggle (light, hitSlop
  12 → ≥ 44 pt); list rows with a fixed 52 pt clipped tile (`minHeight` 68, so a
  thumbnail arriving never moves the row); grid = per day, rows of 3 square
  cells, the chart drawn at `cell − 28` × `cell − 46` above a one-line title, the
  new-dot top-right. Thumbnails keyed by scheme + sha256, so a light/dark switch
  redraws (before: keyed by sha only, a tile kept the old scheme).

### Files

`apps/mobile/src/chart-layout-shapes.ts` (export `donutDisc`) ·
`src/chart-thumb.ts` (new) · `src/gallery-layout.ts` (new) ·
`src/gallery-settings-store.ts` + `src/gallery-settings-expo.ts` (new) ·
`src/ui/Icon.tsx` (9 symbol names) · `src/ui/chart/ChartThumbnail.tsx` ·
`src/screens/ArtifactGallery.tsx` · tests: `test/chart-thumb.test.ts`,
`test/gallery-layout.test.ts`, `test/gallery-settings-store.test.ts` (new),
`test/chart-thumbnail-render.test.ts`, `test/artifact-gallery-wiring.test.ts`,
`test/pairing-guards.test.ts` · e2e: `e2e/flows/35-gallery-shots.yaml` +
`35-gallery-laptop.js` (new), `e2e/run.ts` (flow + its session var) ·
`changelog.d/mobile-gallery-polish.changed.md`. No protocol, daemon or core change.

### Failure modes

- **Spec not re-validatable** (pod forgery, newer spec) → `chartThumbGeometry`
  `null` → kind symbol. Unchanged rule, still tested.
- **Chart too dense for a tile** (40 bars in 52 pt) → `chartThumbAt` `null` →
  chart symbol; a bigger box may still draw it (tested both ways).
- **A mark outside the view box** (a future layout change) → still clipped twice
  (Svg viewport + `overflow: hidden`); the fit test fails first.
- **Bytes unreadable** → the symbol stays (unchanged).
- **Unmeasured width** → `gridCell(0) = 0`, `chartThumbAt` refuses an empty box.
- **Settings:** unknown/newer record → list, never written over; Keychain error →
  list, writes refused; write error → look switched for this run only; a pick
  during the first read is not undone by it.
- **Light ↔ dark while open** → new scheme key → re-read and redraw.

### Tests

- `chart-thumb.test.ts` — per kind: every drawn end point (and dot ± r) inside
  the view box; no `swatch`/`baseline`/`track`; donut view box = its disc, centred;
  legible in the 52 pt tile and a grid cell at exactly that size; 40 bars →
  symbol at 52 pt, drawn at 600; strokes/dots keep their on-screen minimum.
  RED on `main`: the module does not exist, and the repro above is the same
  property failing on `main`'s thumbnail.
- `gallery-layout.test.ts`, `gallery-settings-store.test.ts` — the toggle, sizes,
  grid maths, symbols; the store's fail-safe rules and the holder's races.
- `chart-thumbnail-render.test.ts` — Svg = tile size + `viewBox`, root clips, no
  text/guide, doughnut draws sectors only.
- Mutation per guard (Execution).
- e2e flow 35: the gallery with the six charts + an HTML page, list and grid,
  light and dark (screenshots).

## Execution

*— claude-opus-5-5, 2026-11-20*

1. **Evidence first.** The pure repro above (Context), then e2e flow
   `35-gallery-shots` (new; its world is `35-gallery-laptop.js`: one laptop turn
   with the six `chart` calls + a `present` HTML page) on `main`'s build —
   BEFORE screenshots, which show the bar chart's rows painted down over the
   neighbouring rows and the donuts cut to a coloured arc.
2. **RED** (`bun test apps/mobile/test/chart-thumb.test.ts` on `main`):
   ```
   error: Cannot find module '../src/chart-thumb.ts' from '.../apps/mobile/test/chart-thumb.test.ts'
    0 pass
    1 fail
    1 error
   ```
   The property it pins (every drawn point inside the box) is the repro's, which
   fails on `main`'s thumbnail: pie `x[-44,158]` in a 40 pt box, bar 40×128.
3. **GREEN**: `chart-thumb.ts`, `donutDisc`, `ChartThumbnail` on the thumb view,
   `gallery-layout.ts`, `gallery-settings-store.ts` + `-expo.ts`, the screen.
   `bun test` of the six touched/new test files: green.
4. **Drift from Implementation (after the first AFTER screenshots):**
   - a **scatter**'s view box is its cloud of points (`scatterBox`), not its plot:
     the axes started at 0 and the dots were a thin streak in a corner; the box is
     never thinner than `SCATTER_ASPECT = 0.6` of its long side;
   - a **line** chart drops its `fill` (the gradient under the line, drawn flat at
     tile size it was a solid block); an area keeps its fills.
   Both pinned by new tests in `chart-thumb.test.ts`.
   - The kind **symbols** replaced the text glyph in every tile (thin SF Symbols,
     one distinct per kind) — the Implementation said so; noting it is a visible
     change for non-chart rows too (HTML → `globe`).
5. **Mutation per guard** (each applied, the named test file run, reverted):
   ```
   MARK_ROLES + "swatch"                         chart-thumb        16 pass 5 fail
   donut view box → plot rect                    chart-thumb        20 pass 1 fail
   no reach on the plot box (w)                  chart-thumb        19 pass 2 fail
   no MIN_MARK legibility check                  chart-thumb        19 pass 1 fail
   no stroke widening (MIN_STROKE)               chart-thumb        19 pass 1 fail
   keep dots for every kind                      chart-thumb        19 pass 1 fail
   no scatterBox                                 chart-thumb        22 pass 1 fail
   no SCATTER_ASPECT floor                       chart-thumb        22 pass 1 fail
   keep a line chart's fill                      chart-thumb        22 pass 1 fail
   ChartThumbnail overflow → visible             thumbnail-render    4 pass 1 fail
   ChartThumbnail without viewBox                thumbnail-render    4 pass 1 fail
   holder: read overrides an in-flight pick      gallery-settings   13 pass 1 fail
   holder: load re-reads every time              gallery-settings   13 pass 1 fail
   store: accept any layout value                gallery-settings   13 pass 1 fail
   gridCell without floor                        gallery-layout      9 pass 1 fail
   toggle shows the current look                 gallery-layout      9 pass 1 fail
   LIST_TILE 40                                  gallery-layout      8 pass 2 fail
   ```
   (The first donut mutation SURVIVED the first test set — the plot rect also
   contains the disc — so the "view box IS its disc, centred" test was added.)
6. **Simulator** (own device, iOS 26.5 iPhone 17 Pro, created for this task and
   deleted at the end), `bun apps/mobile/e2e/run.ts --udid … --only 35-gallery-shots`:
   - BEFORE (`main`'s bundle — verified: the Hermes bundle has no
     `Show as grid` string): list light + dark shot; the flow then fails at the
     toggle tap, which `main` does not have (expected).
   - AFTER (final code): `GATE PASS — 1 passed (64 s)`; list + grid, light + dark.
   - Screens: `.tentacle/tmp/mobile-gallery-polish/screens/`
     `before-list-{light,dark}.png`, `after-list-{light,dark}.png`,
     `after-grid-{light,dark}.png` (gitignored).
   - Harness note: two attempts ended on the iOS LOCK SCREEN mid-flow (the
     headless simulator locked itself during `_pair`); the third, unchanged, passed.
     Not an app issue; not investigated further (the shared gate has not shown it).
   - Process note: an Expo Release build bundles the JS in the Xcode phase near
     the END of the build, not at the "Writing bundle output" line printed at the
     start — a first "BEFORE" build had picked up the edited sources and was used
     as an AFTER build instead.
7. **Gate** — `bun run check`: typecheck (root + mobile + relay) clean;
   `biome check .` 2153 files, no issues; `bun test` **15914 pass · 5 skip ·
   0 fail** (the 5 skips are the pre-existing opt-in live/slow tests:
   docker, k8s, exec confinement, cli docker/k8s, daemon ws keepalive — none in
   `apps/mobile`).

Unverified: on a physical iPhone (only the simulator was driven); the grid with
image artifacts (they show the `photo` symbol, as before they showed a glyph — a
real image thumbnail in the gallery is out of scope).

## Review

*— pending*
