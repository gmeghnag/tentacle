# feat/mobile-chart-labels — Series labels on phone charts (C inside the plot, A legend as a setting)

> **Status:** implemented — awaiting Review
> **Branch:** `feat/mobile-chart-labels`
> **Size:** M · **Blast:** contained · **Suited:** Opus plan + DeepSeek exec; standard in-context Review
> **Changelog:** `changelog.d/mobile-chart-labels.changed.md`

## Context

*— claude-opus-5-5, 2026-11-17*

**Problem.** On a phone, a multi-series line/area chart spends a third of its
width on a right-hand "gutter" of line-end labels (`name value unit`), so the
plot is squeezed; the top y guide reads below the highest line (looks like the
line overshoots the scale); and the hero compares one series against a
DIFFERENT series ("Nov 16 storage · vs Nov 16 auth"). The owner reviewed
mockups (`.tentacle/mockups/mobile-chart-labels/index.html`, gitignored) and
picked (README "CHOSEN", 17/11 ~23:40):

- **Default C** — labels INSIDE the plot: the series name just above each
  line's end (stacked area: inside its own band), haloed in the page colour,
  with the series marker; collisions resolved vertically; plot full width.
- **Setting → A** — a compact legend ABOVE the plot (glyph · name · last value,
  wraps, max ~2 rows); tapping an item highlights that series (others grey),
  moves the hero to it; a second tap returns to rest.

The mockup's lead also applies three things to *every* variant: a y ceiling
that includes the stacked total, a hero that compares a series with its own
previous point, and a distinct stroke + marker per series (solid ●, dashed ■,
dotted ▲) for colour-blind reading. Whether those are in scope is Owner
question 2–3.

**Repro** (2026-11-17, current `feat/mobile-chart-labels` = `main` @ `083a1379`;
the mockup's two real charts through today's `chartLayout`, width 393 − 32):

```ts
// .tentacle/tmp/mobile-chart-labels/repro.ts
import { chartLayout } from "../../worktrees/mobile-chart-labels/apps/mobile/src/chart-layout.ts";

const W = 393 - 32;
const traffic = {
  type: "area", stacked: true, title: "Composizione traffico per canale", y: { unit: "k req" },
  labels: ["settimana 1", "settimana 2", "settimana 3", "settimana 4", "settimana 5", "settimana 6"],
  datasets: [
    { label: "web", data: [380, 400, 420, 440, 452, 455] },
    { label: "mobile", data: [350, 370, 395, 410, 433, 430] },
    { label: "api", data: [110, 120, 130, 140, 152, 148] },
  ],
};
const latency = {
  type: "line", title: "Latenza p95 per endpoint", y: { unit: "ms" },
  labels: ["Nov 10", "Nov 11", "Nov 12", "Nov 13", "Nov 14", "Nov 15", "Nov 16"],
  datasets: [
    { label: "storage", data: [120, 115, 130, 125, 140, 135, 128] },
    { label: "auth", data: [85, 90, null, null, 78, 82, 90] },
    { label: "api", data: [70, 75, 82, 88, 95, 90, 49] },
  ],
};
for (const [name, s] of [["traffic", traffic], ["latency", latency]] as const) {
  const l = chartLayout(s, { width: W, locale: "en" });
  if (!l) throw new Error(`${name}: null layout`);
  const direct = l.texts.filter((t) => t.role === "direct").map((t) => `${t.text}@x${Math.round(t.x)}`);
  const guides = l.texts.filter((t) => t.role === "guide").map((t) => t.text);
  const maxY = Math.min(...l.paths.filter((p) => p.role === "line").map((p) => Number(p.d.match(/[\d.]+,([\d.]+)/g)?.map((m) => Number(m.split(",")[1])).reduce((a, b) => Math.min(a, b)))));
  const topGuideY = Math.min(...l.guides.map((g) => g.y));
  console.log(`${name}: width=${W} plot.right=${Math.round(l.plot.right)} (${Math.round((100 * (W - l.plot.right)) / W)}% gutter) legend=${l.legend === null ? "null" : l.legend.length}`);
  console.log(`  direct=${JSON.stringify(direct)} guideLabels=${JSON.stringify(guides)}`);
  console.log(`  topGuideY=${topGuideY.toFixed(1)} highestLineY=${maxY.toFixed(1)} (line above top guide: ${maxY < topGuideY})`);
  console.log(`  hero=${l.hero.num} ${l.hero.unit} ${l.hero.delta?.text ?? ""} context="${l.hero.context}"`);
}
```

```
$ bun .tentacle/tmp/mobile-chart-labels/repro.ts
traffic: width=361 plot.right=234 (35% gutter) legend=null
  direct=["web 455 k req@x242","mobile 430 k req@x242","api 148 k req@x242"] guideLabels=["0 k req","1,000 k req"]
  topGuideY=33.6 highestLineY=29.1 (line above top guide: true)
  hero=1,033 k req ▼ 0.4% context="settimana 6 · vs settimana 5"
latency: width=361 plot.right=300 (17% gutter) legend=null
  direct=["storage@x308","auth@x308","api@x308"] guideLabels=["50 ms","150 ms"]
  topGuideY=20.1 highestLineY=32.2 (line above top guide: false)
  hero=128 ms ▲ 42.2% context="Nov 16 storage · vs Nov 16 auth"
```

Read: the stacked area loses **35 %** of its width to the gutter; its top
guide is **1,000** while the stack reaches **1,033** (line drawn above the top
guide); the line hero compares **storage vs auth**. The legend path exists
(`legend` non-null) only as a fallback, BELOW the plot.

## Implementation

*— claude-opus-5-5, 2026-11-17*

Scope as planned below assumes the **recommended** answer to every Owner
question (end of this section); a different answer changes the marked steps.

### Load-bearing assumption

**Every label/legend decision for line and area charts is made in ONE pure
function, `lineLayout`, and the component only draws its output** — so C, A,
the fallback and the highlight can all be built and tested in pure modules,
with no layout logic in `.tsx`. Proven:

- `apps/mobile/src/chart-layout.ts:98-370` — `lineLayout` computes the gutter
  (`:136-144`), the direct labels (`:234-272`), the legend fallback (`:143`,
  `:364`) and returns `ChartLayout`.
- `apps/mobile/src/ui/chart/ChartView.tsx:7-10` — "Hook-free on purpose: every
  decision is in `chart-row.ts` / `chart-layout.ts` / `chart-interact.ts`";
  texts are mapped as-is (`:267`), the legend is mapped as-is (`:353-371`).

### Preconditions

- Today's gutter: `gutterW = max(measure(endText)) + 10` (`chart-layout.ts:139-142`);
  the plot's right edge is `width - gutterW` (`:144`); `endText` appends the
  last value for areas (`:125-130`). The gutter may take up to **40 %** of the
  width before the legend fallback (`chart-layout-axis.ts:143-152`).
- The legend is a `readonly LegendItem[] | null` on the layout
  (`chart-layout-kit.ts:107-110`, `:145-146`), drawn BELOW the plot as swatch +
  name, no value, no tap (`ChartView.tsx:114`, `:353-371`).
- `LayoutPath.dash` already exists and is drawn (`chart-layout-kit.ts:41`,
  `ChartView.tsx:232`, `ChartThumbnail.tsx:61`); the appear animation reveals by
  clipping width, not by `strokeDasharray` (`ChartAppear.tsx:102`
  `overflow: "hidden"`), so dashed series do not fight it.
- The halo colour exists: `ChartTokens.surface` (`theme.ts:196`, "dot rings cut
  out of `page`").
- Guides: `guideItems` labels only the top and bottom NICE values INSIDE
  `[lo, hi]` (`chart-layout-axis.ts:108-141`), and `domain(…, zero=true)` adds
  8 % headroom above the max (`chart-geometry.ts:140-152`) — so the top label
  can sit below the max (repro: 1,000 vs 1,033).
- Hero (line/area, not stacked): series 0 vs **series 1 at the same x**
  (`chart-hero.ts:209-226`); stacked: total vs previous total (`:181-191`).
  The two-series case is the model-charts "this year vs last year" pick (series
  1 painted `mutedLine`, `chart-layout.ts:147-148`; fixture `REVENUE`,
  `test/chart-fixtures.ts:26-41`).
- Caps: ≤ 8 datasets, series label ≤ 60 chars (`packages/core/src/chart/spec.ts:84-96`).
- Layouts are cached by a key that does NOT include any label mode
  (`chart-row.ts:81`) — must be extended.
- `chartRowView` callers: inline `TranscriptRow.tsx:348`, full screen
  `ChartFullScreen.tsx:254`, gallery thumbnails via `chartThumbView`
  (`chart-row.ts:131-141`, `ArtifactGallery.tsx:136`).
- A live phone setting with listeners: `activity-settings-store.ts:145-184`
  (versioned Keychain record, `subscribe`), consumed as
  `useState(() => X.current())` + `useEffect(() => X.subscribe(set), [])`
  (`SessionScreen.tsx:709-712`); a multi-choice Settings row:
  `SettingsScreen.tsx:359` ("Activity button"). **Do not edit
  `activity-settings-store.ts`** — `feat/mobile-activity-panel` runs tonight
  and may touch it; this task adds its own store.

### Design

**D1 · Label mode is a layout input.** `LayoutOptions` gains
`labels?: "inside" | "legend"` (default `"inside"`). `ChartRowOptions` gains
the same, and `chart-row.ts:81`'s cache key gets `|${labels}`. Only
`lineLayout` reads it (Q1: bar/scatter/donut unchanged).

**D2 · C — inside (`labels: "inside"`, multi-series only).**
- No gutter: `right = width` (drop `gutterIdx`/`gutterW` and the `reaches`
  split). The `A`-direction guide labels stay at `x2` as today.
- One `LayoutText` per visible series, text = **name only** (no value),
  `role: "direct"`, `anchor: "end"`, `size: dSize`, new field `halo: true`,
  colour `tokens.label` (not the series colour — the marker carries the colour).
  x = `X(lastAt) - 10`, clamped so the text's left edge ≥ 2 (then
  `anchor: "start"` at 2). y target: line → `endY - 8`; stacked area → the
  band's mid at the last point (`(Y(cum_k) + Y(cum_{k-1} or 0)) / 2 + dSize/3`).
- Collisions: the existing `dodge(targets, lineH, top + 2, bottom - 3)`
  (`chart-geometry.ts:259`).
- A marker per label: a `LayoutDot` at `(textLeft - 8, y - dSize/3)`,
  `r ≈ 3.2`, `shape` from D5, paint `{ series: k }`, `ring` in `surface`.
- **Fallback to A** (Q4) for that chart when `n * lineH > bottom - top`
  (cannot dodge) or any name is wider than 45 % of the plot width — the
  decision is a pure `insideFits(...)` in `chart-layout-axis.ts`, replacing
  `labelsFit`'s use in `lineLayout` (keep `labelsFit` for bar/scatter).
- Single series: no labels (as today: `multi` gate, `chart-layout.ts:123`).

**D3 · A — legend above (`labels: "legend"`, or C's fallback).**
- `right = width`; no direct texts.
- `LegendItem` gains `value: string` (last defined value of the RAW series,
  formatted with `yFormat`, as `endText` does today) and `shape` (D5).
- `ChartView` draws the legend ABOVE the plot (between hero and plot), each
  item = glyph (a 24×12 `<Svg>`: a 2 pt line with the series dash + its marker)
  · name · value; `flexWrap`. Names longer than 18 chars are ellipsized by
  `<Text numberOfLines={1}>` with a max width — presentation only.
- Today's below-plot legend is removed (A replaces it everywhere, including the
  bar/scatter fallbacks that already use `layout.legend` → they move above too;
  the item gains `value` only for line/area, `""` elsewhere — the component
  omits an empty value).
- **Tap → highlight** (A only, Q6). State `highlight: number | null` lives in
  `ChartBlock` (inline) and `ChartFullScreen` next to `hidden`. A pure
  `highlightLayout(layout, spec, k, locale)` in `chart-interact.ts` returns a
  layout whose non-`k` line/fill paths and dots get `paint: { token: "mutedLine" }`
  and opacity 0.55 (fills × 0.6), and whose `hero` is series `k` vs its own
  previous defined point (D6). A second tap on `k` → `null`. A scrub hero still
  wins while a finger is down (`scrub?.hero ?? layout.hero`, `ChartView.tsx:96`).
  Legend items become `Pressable`s with `accessibilityRole="button"` and
  `accessibilityState={{ selected }}`. Hiding a series (full screen) that is
  highlighted clears the highlight.

**D4 · Y ceiling (area only, Q2a).** In `lineLayout` when `area`: replace `hi`
with the first nice tick ≥ the max (the `niceTicks` used by `guides`,
`chart-geometry.ts:155-161`), so the top guide IS the ceiling (repro: 1,033 →
top guide ≥ 1,033). `domain()` itself is NOT changed (bars share it).

**D5 · Stroke + marker per series (Q2b).** For multi-series line/area, slot
`s = k % 3`: dash `["", "6 4", "0.1 4"][s]` on `role: "line"` paths (round
caps — `ChartView` sets `strokeLinecap="round"` when `dash` is present, so
`0.1 4` reads as dots), `LayoutDot.shape?: "circle" | "square" | "triangle"`
(default circle) for end/label/legend markers. `ChartView`/`ChartThumbnail`
draw square as `<Rect>`, triangle as `<Path>`. The single-series and the
2-series YoY look stay exactly as today except series 1 becomes dashed.

**D6 · Hero (Q3).** `heroOf(spec, at, locale, series?)`:
- `series` given (highlight) → that series at `at ?? last defined`, vs its own
  previous defined point; context `"<x> <name> · vs <prev x>"`.
- not given, exactly 2 datasets → unchanged (YoY: series 0 vs series 1).
- not given, ≥ 3 datasets, not stacked → series 0 vs its own previous point.
- stacked → unchanged (total vs previous total).

**D7 · The setting.** New `chart-settings-store.ts` (copy of the activity
store's shape: record `{ v: 1, labels: "inside" | "legend" }`, key
`tentacle.charts`, unknown/garbage → default `"inside"` and never
overwritten, write rejects on error, holder with `subscribe`) +
`chart-settings-expo.ts` singleton `CHART_SETTINGS` (Keychain wiring as
`activity-settings-expo.ts`). Loaded at launch where `ACTIVITY_SETTINGS` is
(`App.tsx:1620-1626` region). Settings screen: a "Charts" section with two
choice rows — "Labels on the lines" (default) / "Legend above the chart" —
the "Activity button" row pattern (`SettingsScreen.tsx:359`). Consumers
(`TranscriptRow` `ChartRowView`, `ChartFullScreen`) read it via
`useState + subscribe` and pass `labels` into `chartRowView`. Gallery
thumbnails pass nothing (they draw no texts that matter at tile size; keep
today's behaviour).

### Files

In dependency order (mobile app only; no protocol, daemon, client, core change):

1. `apps/mobile/src/chart-layout-kit.ts` — `LayoutOptions.labels`,
   `LayoutText.halo?`, `LayoutDot.shape?`, `LegendItem.value` + `shape`.
2. `apps/mobile/src/chart-layout-axis.ts` — `insideFits`; `legendOf` takes the
   value/shape.
3. `apps/mobile/src/chart-hero.ts` — `heroOf(…, series?)` (D6).
4. `apps/mobile/src/chart-layout.ts` — `lineLayout`: D2, D3, D4, D5.
5. `apps/mobile/src/chart-layout-shapes.ts` — only the `legendOf` call sites
   (value `""`), nothing else.
6. `apps/mobile/src/chart-interact.ts` — `highlightLayout`, `toggleHighlight`.
7. `apps/mobile/src/chart-row.ts` — option + cache key.
8. `apps/mobile/src/chart-settings-store.ts`, `chart-settings-expo.ts` (new).
9. `apps/mobile/src/ui/chart/ChartView.tsx` — halo text, shapes, legend above
   with glyph/value/press; `ChartThumbnail.tsx` — shapes.
10. `apps/mobile/src/ui/chart/ChartBlock.tsx`, `ChartFullScreen.tsx` — highlight
    state; `screens/transcript/TranscriptRow.tsx` — read the setting.
11. `apps/mobile/src/screens/SettingsScreen.tsx`, `apps/mobile/App.tsx` — the
    row; load at launch.
12. `changelog.d/mobile-chart-labels.changed.md`.

### Failure modes

- **Many / long series names** (8 × 60 chars): C's `insideFits` fails → A for
  that chart; A wraps and ellipsizes. Never a label off-plot (clamp, D2).
- **Series ending early / gaps** (`auth` with nulls): label at its own last
  defined point (`lastDefined`), not at the last x.
- **Thin stacked band**: band-mid targets collide → `dodge` separates them;
  labels may leave their band — accepted (mockup caveat "si accalcano").
- **Labels cover the last data**: accepted cost of C (owner chose it knowing
  it, README); the halo keeps both readable.
- **Hidden series** (full screen): labels/legend only for `visible`; a
  highlighted series that gets hidden → highlight cleared.
- **Highlight + scrub**: scrub hero wins while scrubbing; release → highlight
  hero again.
- **Setting record unreadable / newer `v`**: default `"inside"`, the record is
  left untouched, Settings shows the row disabled with a note (activity-store
  rule); a write error keeps the choice in memory for the run.
- **Setting changed while a chart is on screen**: `subscribe` → re-render with
  the new key (cache miss, one re-layout).
- **Single series / empty data**: no labels, no legend (unchanged).
- **Large text (fontScale)**: `dSize` scales; `insideFits` uses the scaled
  size, so big text falls back to A rather than overlapping.

### Tests

All in `apps/mobile/test/`, the existing fixture style (`chart-fixtures.ts`),
`monoWidth` measure. Each NEW behaviour test is shown failing on today's code
first (§9 red-before-green; for a feat: the assertion fails because the
capability is absent).

- `chart-layout.test.ts`:
  - C, the repro's `traffic` and `latency` at 361: `plot.right === width`;
    exactly one `direct` text per series, text = name only, `halo: true`, each
    inside `[0, width]` and between `top` and `bottom`, no two overlapping
    (`textBox`); `legend === null`.
  - C fallback: 8 series with 60-char names → `legend !== null`, no `direct`.
  - A: `labels: "legend"` → no `direct`, `legend` items carry
    `value` = formatted last value (`"148 k req"`-shape per `yFormat`).
  - D4: stacked area top guide value ≥ max stack total (1,033).
  - D5: series 1 line path has `dash === "6 4"`, series 2 `"0.1 4"`; a
    single-series chart has no `dash`.
  - Non-regression: bar/scatter/donut layouts unchanged by `labels`
    (deep-equal with and without the option).
- `chart-hero.test.ts`: 2 datasets → unchanged YoY context; 3 datasets →
  series 0 vs its previous point; `series: 2` on `latency` → `"49 ms"`,
  `vs Nov 15`, ▼; series with a gap compares with the previous DEFINED point.
- `chart-interact.test.ts`: `highlightLayout` mutes every non-`k` path/dot,
  keeps `k`'s paint, swaps the hero; `toggleHighlight(k, k) → null`.
- `chart-row.test.ts`: two `labels` values → two distinct cached layouts.
- `chart-settings-store.test.ts` (new, mirror the activity store's tests):
  absent → inside; garbage / unknown `v` → inside and never overwritten; write
  error rejects; `subscribe` fires on `set`.
- `chart-view.test.ts` (render walk): halo text has `stroke` = `surface`;
  legend renders ABOVE the plot (index order in the tree), item press calls
  the highlight handler.
- Non-vacuity: mutate `right = width` back to `width - gutterW` → the C test
  fails; mutate the cache key → the chart-row test fails.

### Owner questions

1. **Which chart types?** Plan: line + area only (what the mockup shows); stacked
   bar and scatter keep today's gutter labels, legend just moves above.
   *Rec: yes — line/area now, stacked-bar labels as a follow-up if wanted.*
2. **Include the mockup's "all variants" fixes?** (a) area y ceiling = nice
   value ≥ stacked total; (b) per-series dash + marker (●/■/▲).
   *Rec: yes to both — small, same function, and the markers are what ties a
   C label / A glyph to its line.*
3. **Hero rule.** Mockup: a series vs its own previous point. Today: series 0
   vs series 1 at the same x (the YoY pick).
   *Rec: keep YoY for exactly 2 series; ≥ 3 series → series 0 vs its previous
   point; a highlighted series (A) → itself vs its previous point.*
4. **C auto-fallback to A** when labels can't fit (too many for the height, or
   a name > 45 % of the plot width). *Rec: yes, per chart, silently.*
5. **Setting shape and reach.** One "Charts" section, two choices
   ("Labels on the lines" default / "Legend above the chart"); applies inline
   and full screen; gallery thumbnails untouched. *Rec: yes.*
6. **Tap-to-highlight only in A?** (C labels sit in the plot, where a touch is
   the scrub.) *Rec: A only; C has the scrub.*

## Execution

*— claude-opus-5-5, 2026-11-18*

As built, in dependency order; the two plan drifts first, because they changed
what the later slices draw.

**Plan drift 1 — D4 as written cannot satisfy its own test.** D4 said "replace
`hi` with the first nice tick ≥ the max (the `niceTicks` used by `guides`)".
`guides` keeps only the ticks INSIDE the domain it is handed
(`chart-geometry.ts:157`: `v <= hi + 1e-9`), and the domain's own `hi` is what
the plan left alone — so nothing could reach above it and the top guide stayed
at 1,000 while the repro's 1,033 still overshot, the very bug D4 exists to kill.
Built instead: the mockup's ceiling ladder (`niceCeiling`, `chart-layout.ts:105`:
2 × the first nice half-step ≥ `max/2`, so 1,033 → 1,200 and 455 → 500) becomes
the area's `hi`, and `guideItems` was given a `ceiling` so its top hairline IS
that value (`chart-layout-axis.ts:110`). `domain()` is untouched, so bars keep
their axis (pinned by the deep-equal test).

**Plan drift 2 — D2 put C's label exactly where the top guide label sits.** D2
kept the guide labels at `x2` (the right edge) while C's label anchors `end` at
`X(lastAt) - 10`; with no gutter, the two overlap and `guideItems`' collision
test dropped the top guide label entirely — the chart lost its ceiling reading.
Built instead: with C on, guide labels anchor `start` at the left edge
(`chart-layout.ts:337`), which is where nothing else is drawn. No visible
regression on the plot: the right edge is now the series' end.

**1. Pure layer** (already landed before this session's remaining slices):
`chart-layout-kit.ts` (`LayoutOptions.labels`, `LabelMode`, `Ctx.labels`,
`LayoutText.halo`/`.shape`, `LayoutDot.shape`, `DotShape`, `LegendItem.value`/
`.shape`); `chart-layout-axis.ts` (`markShape`, `markDash`, `insideFits`,
`legendOf` emitting value + shape, `guideItems(…, avoid, ceiling?)`);
`chart-hero.ts` (`heroOf(…, series?)` + `ownSeriesHero`); `chart-layout.ts`
(no gutter, the `inside` gate, C's name-only haloed labels dodged by `dodge`,
one marker `LayoutDot` per label, `useLegend`, D4's ceiling, D5's dashes,
`start`-anchored guides under C); `chart-row.ts` (`labels` + cache key).

**2. `chart-interact.ts`** — `toggleHighlight`, `highlightLayout` (a projection
of the same layout: non-`k` line/fill/dot paints → `mutedLine` at ×0.55/×0.6,
hero → `heroOf(spec, …, k)`, `scrubAt` re-reads the hero for `k`).

**3. `chart-settings-store.ts` / `chart-settings-expo.ts`** — `tentacle.charts`
behind `SecureKV`, `{v:1, labels}`, unreadable/unknown-`v` → `inside` and never
overwritten (`ChartSettingsPreserved`), holder with `subscribe`.

**4. Renderer.** New `ui/chart/SeriesGlyph.tsx`: ● `<Circle>`, ■ `<Rect>`,
▲ `<Path>`, from `DotShape` alone. `ChartView.tsx` draws a haloed text twice —
a surface-coloured copy (fill AND stroke, `strokeWidth` 3, round joins) then the
readable one, because **`react-native-svg` 15.16 has no `paint-order`** (checked:
no `paintOrder` anywhere in its `src/`), so the halo cannot be a stroke on the
same node. Dots go through `SeriesGlyph`; the legend moved ABOVE the plot
(`ChartLegend`, between `<ChartHero>` and the plot view), each item a 24×12
`<Svg>` glyph (line at 2 pt with the series' dash + its marker) · name
(`numberOfLines={1}`, max width) · value (omitted when `""`), and an item is a
`Pressable` with `accessibilityRole="button"` + `accessibilityState={{selected}}`
ONLY when `onHighlight` is passed — otherwise a plain `View`, so a tile, the
gallery and table mode are unchanged. The old below-plot legend is gone.
`ChartThumbnail.tsx` shares `SeriesGlyph` (hollow markers stay hollow).

**5. State.** `ChartBlock` holds `highlight` and applies `highlightLayout` only
when the layout HAS a legend (C has no item to tap — the scrub is its gesture);
the scrub reads the shown layout, so a scrubbed hero is `k`'s too.
`ChartFullScreen` gains `labels`, its own `highlight`, `toggleHighlight` on an
item, and clears the highlight when that series is hidden. Both take `labels`
from the screen rather than reading the Keychain themselves.

**6. The setting's consumers.** The subscription is owned ONE level up so one
listener serves a screen of charts — `SessionScreen` (`ChartSettings` state +
`subscribe`, `chartLabels={chartSettings.labels}` into every `TranscriptRow`,
whose `ChartRowView` passes it to `chartRowView` and `ChartBlock`), and
`ArtifactGallery` (`useChartLabels`, a new `ui/chart/useChartLabels.ts`) →
`ArtifactViewerModal.chartLabels` → the artifact's `ChartFullScreen`. **Drift
from Files 10-11:** the plan said the chart row itself would `useState` +
`subscribe`; that is one listener per chart in a transcript, so the screen owns
it and the row takes a prop (default `inside`). `ChartFullScreen`'s own default
is `inside` too, which keeps its dumb half walkable by the render test.

**7. Settings + launch.** `SettingsScreen`: a "Charts" `BandSection`
(`CHART_LABEL_ROWS`: "Labels on the lines" / "Legend above the chart"), rows
`chart-labels-inside` / `chart-labels-legend`, `dimmed` when not writable (a
newer build's record), a `Banner` for a failed write. `App.tsx` loads
`CHART_SETTINGS` next to `ACTIVITY_SETTINGS` and passes
`chartLabels`/`chartWritable`/`chartError`/`onChartLabels`.

**Tests.** Pure: `chart-labels.test.ts` (17), `chart-hero-labels.test.ts` (7),
`chart-highlight.test.ts` (8), `chart-settings-store.test.ts` (12), a
`labels` cache-key case in `chart-row.test.ts`. Render: new
`chart-labels-render.test.ts` (10: the halo pair and its surface stroke, the
marker shapes, the legend's position in the tree, glyph dash/value, pressability
with and without a handler, `selected`, and the full screen's own three).
Wiring-as-source: new `chart-labels-wiring.test.ts` (6 — who subscribes, who
passes the mode, the full screen's two taps, the Settings rows, the launch
load). Edited pre-existing tests, each because this task changes the behaviour
they pin: `chart-layout.test.ts` (guide labels `start` under C, name-only direct
texts, 3 dots on its line fixture, `Ctx.labels` in a hand-built ctx),
`chart-view.test.ts` (a marker is a small `<Rect>` now, so "no card" means
"no big rectangle"; a haloed text appears twice), `chart-thumbnail-render.test.ts`
(+`Rect` in its svg mock), `band-screens.test.ts` (ten bands), `pairing-guards`
(a seventh Keychain wiring file).

**Mutation results** (§9 non-vacuity; every mutation reverted, file restored and
re-run green afterwards):

| mutation | test | result |
| --- | --- | --- |
| `const right = width` → `width - 40` (the gutter back) | `chart-labels` | 5 fail |
| the cache key loses `\|${labels}` | `chart-row` | 1 fail |
| the area ceiling → `undefined` (back to `domain()`) | `chart-labels` | 1 fail |
| `insideFits` → always `true` (no fallback to A) | `chart-labels` | 2 fail |
| `if (t.halo !== true)` → `if (true)` (no halo copy) | `chart-labels-render` | 1 fail |
| legend moved back below the plot | `chart-labels-render` | 1 fail |
| every marker drawn as a circle (shape ignored) | `chart-labels-render` | 1 fail |
| legend items never `Pressable` | `chart-labels-render` | 3 fail |
| `SessionScreen` stops passing `chartLabels` | `chart-labels-wiring` | 1 fail |
| full screen's `onHighlight` removed | `chart-labels-wiring` | 1 fail |

The two wiring mutations failed as source assertions, not runtime ones — that is
the intended shape for a listener the render walk cannot mount (no React
renderer in this harness); the pure and render mutations above fail at the
behaviour, and every file was restored and re-run green after each.

**Still unverified (by nature, not by omission):** how the halo, `Rect`/`Path`
markers and the legend's wrapping actually LOOK on a device — this repo's mobile
tests stub the host components, so nothing here proves pixels. The design is the
mockup's; a simulator pass is the remaining check.

### Fix round 1

*— claude-opus-5-5, 2026-11-18*

Both Review findings fixed, red before green (§9), each mutation-checked.

**1 (MEDIUM) — point-form highlight read series k at series 0's index.** Root
cause: a scrub index is an index into series 0's points (`chart-layout.ts`
`pos0`), but `ownSeriesHero` used it raw on `datasetValues(spec, k)`. Fix:
`chart-hero.ts:137` new `pointIndexAt(spec, series, at)` — the index at which
series `series` has the x of series 0's point `at` (`-1` when it has none) — and
`ownSeriesHero` (`chart-hero.ts:167-169`) maps through it when
`usesPoints(spec)`, returning `EMPTY` (`—`) when k has no point at that x.
Series-1-only and dense/shared-x specs are unchanged (the mapping is the
identity there). Regression test: `chart-highlight.test.ts:66` — `b`'s two-point
series, scrubs at every index of `a`: x=3 → `300 · "3 b"`, x=4 → `400 · "4 b ·
vs 3"`, x=1/2 → `—`. RED on the old code ("400" at index 2);
mutation (`pointIndexAt` bypassed, `at` passed raw) → 1 fail.

**2 (MEDIUM) — stacked band-mid was untested.** No production change: the code
was right, the coverage was not. Regression test: `chart-labels.test.ts:54` —
`TRAFFIC` (stacked area), each direct label's `y` must be strictly below its own
band's ceiling `Y(cum_k)` and not below its floor `Y(cum_{k-1})`, with `Y`
recovered from two of the layout's own guides. Mutation — Review's exact one,
`chart-layout.ts` stacked target → `end - 8` → 1 fail (`Expected > 103.43,
Received 95.43`, on `web`); reverted, re-run green.

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean ·
`bun run lint` clean (2057 files) · `bun test apps/mobile/test/chart-*` 189 pass /
0 fail (15 files).

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context; same model family as the plan
author — shared blind spots possible; executor was DeepSeek)

**Verdict: REQUEST-CHANGES** (2 × MEDIUM, no HIGH).

**Gate:** `bun test apps/mobile/test` 3288 pass / 0 fail (233 files);
`bun run lint` clean; `bun run typecheck` clean (root + mobile + relay).

**Findings**

1. **MEDIUM — highlight + scrub shows another x's value on point-form lines.**
   `apps/mobile/src/chart-interact.ts:461` passes the scrub index `i` (an index
   into series 0's points, `chart-layout.ts:386` `pos0[i]`) to
   `heroOf(spec, i, locale, k)`, and `ownSeriesHero`
   (`apps/mobile/src/chart-hero.ts:144`) reads `datasetValues(spec, k)[i]` —
   series k's i-th point, not its point at that x. The pre-existing YoY path
   matches by label for `usesPoints` (`chart-hero.ts:261`); the new path does
   not. Repro (`.tentacle/tmp/mobile-chart-labels/rev.ts`): line, `x:{type:"number"}`,
   a = x 1..4, b = x 3..4; legend mode, highlight b, scrub at x=1 → hero
   `300 · "3 b"` (b's value at x=3, while the finger is on x=1). Fix: map `i`
   to series k by x (as the YoY branch does) and return EMPTY/no-hero when k
   has no point there; add a test.
2. **MEDIUM — stacked band-mid placement is untested (§9 non-vacuity).**
   Mutation `chart-layout.ts:283` stacked target → `end - 8` (top of the
   stack, D2's "inside its own band" gone): `chart-labels`, `chart-layout`,
   `chart-labels-render` stay 52/52 green. Add an assertion that each stacked
   label's target lies between `Y(cum_k)` and `Y(cum_{k-1})` before dodge
   (e.g. a two-band chart with wide bands so dodge does not move them).

**Mutations re-run by Review:** scrub hero for `k` dropped in
`highlightLayout` → `chart-highlight` 1 fail (good); band-mid → 0 fail
(finding 2). Both reverted; `git status` clean.

**Attacks tried:** (a) stacked + hidden series — `ys` accumulates over
`visible` only and `cumBelow` uses the previous visible series: holds.
(b) `highlightLayout` builds a new layout each render fed to `useChartScrub`
— the hook reads it via a ref, no identity-keyed effect: holds. (c) D4
ceiling on the traffic stack → guides `0 … 1,200`, top hairline = ceiling,
bars untouched (deep-equal test): holds. (d) point-form highlight scrub:
finding 1. §7: mobile-only, no protocol/persistence/terminal path touched;
"logic in pure modules" respected (decisions in `chart-layout`/`chart-interact`,
components map). Executor's two plan drifts are documented and justified.

### Round 2

*— claude-opus-5-5, 2026-11-18*

**Verdict: APPROVE.** Reviewed `git diff HEAD~1` (c1d76c73).

- **Finding 1 — fixed.** `pointIndexAt` (`chart-hero.ts:137`) maps series 0's
  scrub index to series k by x; no point there → empty hero. Review repro
  (`rev.ts`) now: x=1,2 → `—`; x=3 → `300 "3 b"`; x=4 → `400 "4 b · vs 3"`.
  Mutation (`usesPoints(spec)` → `false`): new `chart-highlight` test fails.
- **Finding 2 — fixed.** New `chart-labels` band test; mutation (stacked
  target → `end - 8`) now fails it.
- Both mutations reverted; `git status` clean.
- Gate: `bun test apps/mobile/test` 3290 pass / 0 fail; `bun run lint` clean;
  `bun run typecheck` clean. No regression found in the diff (category-x and
  non-highlight paths untouched: `at0 === at` unless `usesPoints`).
