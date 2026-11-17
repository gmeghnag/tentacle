# feat/mobile-chart-labels — Series labels on phone charts (C inside the plot, A legend as a setting)

> **Status:** implementation (awaiting owner answers + approval — NOT approved)
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

*— (pending)*

## Review

*— (pending)*
