# feat/model-charts — the model draws charts in the conversation (iPhone native, Mac TUI in braille)

> **Status:** implementation — **plan written, NOT approved**: the owner decides the *Owner questions* after the mockups (`.tentacle/tmp/model-charts/mockups/index.html`).
> **Branch:** `feat/model-charts`
> **Size:** L (split into 8 slices, each S or M) · **Blast:** cross-module (a new model tool with no I/O; no protocol bump, no new update type, no session-log type; one new native module on the phone) · **Suited:** per slice (below): `deepseek` for the pure/contained slices, `opus` for the visual and native ones; mandatory fresh-context Review of the whole branch (L).
> **Changelog:** `changelog.d/model-charts.added.md` (written by C8).

## Context

*— claude-opus-5-5, 2026-11-16*

**The ask (owner, 2026-11-16):** "on mobile, a feature that lets the agent show
statistical CHARTS drawn in the conversation UI — we often talk numbers and stats
with the agent; a native, well-made tool to draw line, bar, etc. charts". For the
Mac: "if we can also do the textual drawing in the TUI, or in general a beautiful
TUI implementation, fluid and coherent with the terminal, good".

**Binding owner decision (2026-11-16 ~11:05) — the data format:** our OWN minimal,
strict schema WITH THE SHAPE OF Chart.js, e.g.
`{"type":"line","title":"Ricavi 2026","labels":["gen","feb","mar"],"datasets":[{"label":"Ricavi","data":[12.5,14.1,13.8]}],"y":{"unit":"€","format":"k"},"x":{"type":"category"}}`.
Additions to Chart.js only where it lacks them (x axis type, unit + number format
per axis, `{x,y}` points). Styling (colours, fonts, widths) is NEVER in the spec:
the clients decide it. Not Vega-Lite / ECharts / Plotly. Every optional field must
earn its place; small models' typical mistakes must produce clear, fixable tool
errors.

**What exists today (evidence, `main` @ 7ca9a280):**

- The model can show the user only text (plus, once merged, `present`ed artifacts —
  `feat/model-artifacts`, in execution at S5 in its worktree). There is no chart
  tool: the built-in set is `fs_*`/`shell*` (`packages/tools/src/builtins.ts:320-328`),
  registered at `packages/cli/src/wiring.ts:456`.
- **A tool call's arguments already reach both clients, live and on reload.** Live:
  the daemon maps `tool_start` to `tool_call{rawInput: safeParseArgs(arguments)}`
  (`packages/daemon/src/mapping.ts:212-221,266-273`; schema `rawInput: z.unknown()`,
  `packages/protocol/src/updates.ts:46-53`), the client re-serialises it into
  `tool_start.arguments` (`packages/client/src/mapping.ts:254-264`), and both
  frontends keep it as the row's `args` string (TUI `packages/tui/src/state.ts:425-429`;
  phone `apps/mobile/src/transcript.ts:353`). Reload: both rebuild rows from
  `ChatMessage.toolCalls[].arguments` (phone `apps/mobile/src/transcript-history.ts:86-95`;
  TUI `packages/tui/src/resume.ts:36`). **This is the seam the chart rides.**
- Neither frontend can draw a chart: `react-native-svg` is not a dependency
  (`apps/mobile/package.json:6-35`) and the TUI has no plotting code (braille is
  used only by the spinner, `packages/tui/src/components/Thinking.tsx:7`).
- Tool-argument validation today returns zod's raw issue dump —
  `invalid arguments for ${name}: ${validation.error.message}`
  (`packages/tools/src/registry.ts:86-91`) — a JSON blob small models fix badly.
  `Tool.jsonSchema` lets a tool advertise a hand-written schema while `inputSchema`
  stays a permissive guard (`packages/core/src/tool.ts:157-165`): our own validator
  can then speak plain sentences.
- `Intl` compact notation is unusable for chart labels in Italian: probe
  (`.tentacle/tmp/model-charts/probe.ts`, bun 2026-11-16) prints
  `it compact 12500: 13K` (precision lost) and `it compact 2.4e6: 2,4 Mln`
  (inconsistent suffixes) → we format ourselves (with `Intl` for separators).

**Repro** (that the capability is missing; run 2026-11-16 in this worktree, `main` @ 7ca9a280):

```
$ rg -n '"chart"|chart_spec|ChartSpec' packages apps --glob '!**/node_modules/**' | wc -l
       0
$ ls apps/mobile/node_modules | rg -c 'react-native-svg'
(no output, exit 1: no match)
$ rg -c '"react-native-svg"' bun.lock
(no output, exit 1: no match)
```

No chart tool, no spec, no SVG module. The executor re-runs these on `main` before C1.

**Constraints that shape the design:** AGENTS §7 — one session path over RPC (a chart
is a tool call like any other: no new transport); logic in pure modules, components
only render; persistence split (nothing new is persisted: the spec IS the tool
call's arguments, already in the log); a pod is not trusted (a pod can forge
`rawInput`, so clients re-validate with the same caps and only ever *draw* — no
effect on the laptop); protocol fields free, update classes/critical log entries
not (none added); never write raw to the terminal (the TUI renders chart lines
through the existing `render-lines` → Ink path).

## Implementation

*— claude-opus-5-5, 2026-11-16*

### Load-bearing assumption

**The chart spec can ride the tool call's own arguments to every client — live and
after reload, on every runtime (worker, pod, `serve`, phone over the relay) — so
inline rendering needs no new method, no new update type, no artifact read and no
`PROTOCOL_VERSION` bump.** Proof chain (all on `main` @ 7ca9a280):

1. The arguments leave the daemon as `tool_call.rawInput` (`daemon/src/mapping.ts:266-273`),
   a free `unknown` field (`protocol/src/updates.ts:52`), class `display`
   (`updates.ts:491`).
2. The shared `RemoteClient` mapping turns it back into `tool_start.arguments`
   (`client/src/mapping.ts:254-264`) — the SAME code for TUI and phone (AGENTS §7
   "one session path").
3. Both frontends store it on the row (`tui/src/state.ts:429`, `mobile/src/transcript.ts:353`)
   and rebuild it from `ChatMessage.toolCalls[].arguments` on reload
   (`mobile/src/transcript-history.ts:93`, `tui/src/resume.ts:36`).
4. The relay leg carries `rawInput` today for every tool (the phone's tool subtitles
   are parsed from it, `apps/mobile/src/tool-summary.ts:36-60`).

**First step of C2 (proves it before anything else):** a repro in
`.tentacle/tmp/model-charts/args-roundtrip.ts` — a real `SessionHost` + `Connection`
+ `RemoteClient` over `createChannelPair`, a scripted model that calls `chart` with a
40 KiB spec: assert the client's `tool_start.arguments` parses to a spec deep-equal
to the one sent, and that after `session/open{messages}` the rebuilt TUI items and
phone rows carry the same string. If it fails, STOP and report (AGENTS §0).

### Preconditions

- **P1 — the args seam** (above).
- **P2 — a tool may validate itself.** `registry.execute` runs `inputSchema.safeParse`
  then `tool.execute` (`tools/src/registry.ts:73-98`); with a permissive `inputSchema`
  (`z.record(z.unknown())`) and a hand-written `jsonSchema` (`core/src/tool.ts:157-165`)
  the chart tool owns every error message.
- **P3 — tool-specific bodies in the TUI** branch in `plainToolBody`
  (`tui/src/render-lines.ts:460-462`: `detail.kind === "diff"` → `diffBody`); the
  sub-agent tree is already exempt from the generic cut (`render-lines.ts:466-472`,
  `:697-701`) — a chart body takes the same exemption. Expansion: `Ctrl+O` =
  `expandAll`, a click on a header = per-id `expandedIds` (`render-lines.ts:681`,
  `docs/feat/tui-tool-expand.md`).
- **P4 — the TUI paints through one token table** (`tui/src/theme.ts:1-20,82-104`):
  a `chart` token group is added to `Tokens` for both modes; light/dark is decided
  once per launch.
- **P5 — the phone renders a tool row in one place** (`screens/transcript/TranscriptRow.tsx:172-186,274`
  → `ui/ToolRow.tsx`); a chart row is a branch there, its geometry a pure module.
- **P6 — haptics have one owner** (`apps/mobile/src/haptics.ts:9-20`, kinds in
  `haptic-rules.ts:8`): a `"tick"` kind (`Haptics.selectionAsync`) is added there.
  Reduce Motion is already read by the drawer (`drawer-nav.ts`, `SessionsDrawer.tsx`).
- **P7 — display labels** come from `core/src/tool-labels.ts:7-18`; the phone's
  subtitle mirrors the TUI's case for case (`apps/mobile/src/tool-summary.ts:9,36`).
- **P8 — the artifact store (feat/model-artifacts, not on `main` yet).** In its
  worktree: `ArtifactStore.present({title, bytes, mimeType, kind, callId, …})`
  (`packages/daemon/src/artifact-store.ts:131`), `ToolContext.artifacts?` (doc D4),
  a FREE wire `kind` with a client-side closed list `ARTIFACT_KINDS` +
  `artifactKindOf` (unknown → `"other"`, `packages/protocol/src/artifact.ts:55,97`),
  gallery entry `openArtifactGallery` + `unseenArtifacts` (doc D9). C8 depends on it
  being merged; C1–C7 do not.
- **P9 — the app can rotate.** `apps/mobile/app.json` sets no `orientation`
  (Expo default: all), so a full-screen modal with
  `supportedOrientations={["portrait","landscape"]}` can go landscape. *Unverified on
  device* — C7's first check.

### Design

**D1 — one data path: the spec is the tool call (args-inline), the artifact is the index.**
The model calls `chart(spec)`. Clients render INLINE from the row's `args` (P1) —
no fetch, instant, works on reload, on old daemons, in pods. Additionally, where a
session has an artifact sink (P8), the tool registers the canonical spec as an
artifact version of kind `"chart"` (bytes = canonical JSON, `mimeType
application/vnd.tentacle.chart+json`), so the chart appears in the gallery and the
hub badge and **survives compaction** (the artifact manifest is independent of log
segments, model-artifacts D5; the transcript row of a compacted segment is gone on
reload unless `keepSuperseded`). Why not artifact-only (the orchestrator's sketch):
every inline chart would wait on an `artifact/read` round trip, nothing renders
where artifacts are absent (sub-agent-less builds, an older daemon), and C1–C7 would
be blocked on model-artifacts. Why not args-only: no gallery, no hub entry, charts
vanish from history at compaction. (Owner Q1.)

**D2 — the schema (`packages/core/src/chart/spec.ts`, pure, React-free; imported by
tools, TUI and the app — the app already depends on `@tentacle/core`,
`apps/mobile/package.json:12`).** Not a wire schema (it rides `rawInput: unknown`),
so it lives in `core`, not `protocol`.

```ts
type ChartSpec = {
  type: "line" | "bar" | "area" | "pie" | "doughnut" | "scatter";   // required
  title: string;                       // required, 1..120
  subtitle?: string;                   // ≤ 160
  labels?: (string | number)[];        // ≤ 1000; x categories / dates / numbers, or slice names
  datasets: {                          // 1..8 (pie/doughnut: exactly 1)
    label: string;                     // 1..60
    data: (number | null)[] | { x: number | string; y: number | null }[];   // ≤ 1000
  }[];
  stacked?: boolean;                   // bar | area only
  x?: { type?: "category" | "number" | "date"; title?: string; unit?: string; format?: "compact" | "full"; decimals?: number };
  y?: {                                  title?: string; unit?: string; format?: "compact" | "full"; decimals?: number };
};
```

| Field | Chart.js? | Why it earns its place |
|---|---|---|
| `type` | yes (`type`) | Required. Chart.js names (`pie`, `doughnut`, `scatter`) so models write them naturally. **Added:** `area` — Chart.js expresses area as `line` + `fill`, and `fill` is styling we refuse. Left out: `bubble`, `radar`, `polarArea`, mixed per-dataset types (rare in conversation; a later field). |
| `title` | `plugins.title.text` (flattened) | Required: it is the transcript header, the gallery name, the VoiceOver opener, the TUI header. A chart without a title is unreadable out of context. |
| `subtitle` | `plugins.subtitle.text` (flattened) | Period / source ("€ · 2026 fino a ottobre") — the one line of context models always want to add; without it they stuff the title. |
| `labels` | yes | Category/date/number positions for `line`/`bar`/`area`, slice names for `pie`/`doughnut`. Optional only when every dataset uses `{x,y}`. |
| `datasets[].label` | yes | Series name: legend, direct labels, callout, table header. Required (a nameless series is the #1 legend bug). |
| `datasets[].data` | yes | Numbers or `null` (gap). `{x,y}` points for scatter and number/date x (Chart.js' own point form). |
| `stacked` | `options.scales.*.stacked` (flattened to top level) | Changes the meaning (sum vs overlap), so it is data, not style. Top level, because "which axis" is a Chart.js internal small models misplace. |
| `x.type` | `scales.x.type` (`category`/`linear`/`time`) | **Added vocabulary:** `number` / `date` instead of `linear` / `time` (plainer). Default `category`; `scatter` defaults to `number`. No inference from label shape (predictable). |
| `x/y.unit` | no | **Added.** "€", "ms", "%", "GB" — the one thing that makes a number a quantity. One unit per axis. |
| `x/y.format` | no | **Added.** `compact` (12,5k) or `full` (12.500); absent = auto (compact when max \|v\| ≥ 10 000). Two values instead of a format-string language. |
| `x/y.decimals` | no | **Added.** 0..6. Models know their data's precision (61,20 € vs 61 €); a client cannot guess it. |
| `x/y.title` | `scales.*.title.text` (flattened) | Needed for scatter/number axes ("righe modificate"), where the unit alone does not name the quantity. ≤ 40. |

**Deliberately absent:** colours, line widths, fonts, `tension`, `fill`, point styles
(clients decide: owner rule); `indexAxis` (bar orientation is presentation: the client
picks horizontal for long or many labels — Owner Q6); `min`/`max`/`beginAtZero` (bars
and areas always include 0, lines use nice padding; a later field if missed); log
scale; annotations; a second y axis (never: dual axes are the classic chart lie —
mixed units ⇒ two charts, said in the tool description); locale (each client formats
with its own locale); an `id` for versioning (a later field when live-updating charts
are wanted).

**Validation (`validateChartSpec(raw) → { ok: true; spec; notes } | { ok: false; errors }`),
plain-sentence errors with the fix, every error at once (≤ 8, by path):**

| Typical small-model mistake | Error the model gets |
|---|---|
| `"data": ["12.5", "14,1"]` | `datasets[0].data[0] is the string "12.5" — write the number 12.5 (no quotes)`; `"14,1"` → `… write 14.1 (dot as decimal separator, no thousands separator)` |
| `"1.234,5"`, `"12k"`, `"€12"` | `… is a string — write the plain number 1234.5 and put "€"/"k" in y.unit / y.format` |
| labels 12, data 10 | `datasets[1].data has 10 values but labels has 12 — give one value per label (null for a gap)` |
| no `labels`, plain-number data | `labels is missing — line charts need one label per value (or use {x, y} points with x.type "number" or "date")` |
| `"type": "donut"` / `"column"` / `"histogram"` / `"lines"` | `unknown type "donut" — did you mean "doughnut"? Allowed: line, bar, area, pie, doughnut, scatter` (Levenshtein + an alias table: column→bar, histogram→bar, spline→line) |
| `"options": {...}` (Chart.js habit) | `"options" is not used — put stacked at the top level and axis settings in "x"/"y" (unit, format, decimals, title)` |
| `backgroundColor`, `borderColor`, `fill`, `tension`, `borderWidth`, `pointRadius`, `color(s)` | **not an error** (Owner Q2): dropped, and the result says `ignored: backgroundColor, tension — the app chooses colours and styling` |
| any other unknown key | `unknown field "foo" at datasets[0] — allowed: label, data` |
| `NaN`/`Infinity` (not JSON) | caught by JSON parse → the registry's existing `invalid JSON arguments for chart` (`registry.ts:83`); we add the hint `NaN/Infinity are not JSON — use null for a missing value` by checking the raw text |
| \|v\| > 1e15 | `… is too large to chart exactly — scale it (e.g. millions) and say so in y.unit` |
| pie with negative / all zero | `pie values must be ≥ 0 and not all 0 — use a bar chart for signed values` |
| pie with 2 datasets | `pie/doughnut take exactly one dataset — make one chart per series` |
| `stacked` on a line | `stacked works with bar and area only — use type "area" with stacked: true` |
| date not ISO (`"03/01/2026"`) | `labels[0] "03/01/2026" is not an ISO date — write 2026-03-01 (or 2026-03, or 2026-03-01T14:00:00Z)` |
| `x.type:"date"` mixing date-only and timestamps | `labels mix dates and times — use one form` |
| over a cap | `datasets has 11 series (max 8) — keep the 7 largest and fold the rest into "Other"`; `1 800 points (max 1000 per series) — aggregate (e.g. per hour) or sample` ; spec > 64 KiB → `the chart is too large (71 KiB > 64 KiB)` |
| empty `datasets` / empty `data` | `datasets is empty — give at least one series with at least one value` |
| 1 point | **valid** (drawn as a single marked point / bar) |
| all `null` | `datasets[0].data has no values (all null)` |

The same validator runs **daemon-side** (the tool's error) **and client-side** before
drawing (a pod can forge `rawInput`; an old row may predate a cap change): an invalid
spec on a client draws nothing and the row falls back to the generic tool row.

**D3 — the tool (`packages/tools/src/chart.ts`).** `name: "chart"`, `permission:
"none"` (it shows, never acts), `concurrency: { keys: [] }` (no conflicts),
`inputSchema: z.record(z.unknown())`, `jsonSchema: CHART_JSON_SCHEMA` (hand-written,
mirrors D2, with `description`s carrying the rules). Description (≈ 900 chars): when
to use (numbers the user will compare: trends, shares, rankings), when not (one or
two numbers → say them; a table of exact values → Markdown table), the shape with a
one-line example, "one unit per chart — mixed units ⇒ two charts", "aggregate to ≤
200 points when you can", "never colours". `execute`: validate → on error `isError`
with the sentences; on success, if `ctx.artifacts` (P8) → `present({ title, bytes:
canonical JSON, kind: "chart", mimeType, callId })` (a store failure is a NOTE in the
result, never an error: the inline chart is still shown); result text (model-facing
and the old-client fallback):
`Chart shown to the user: line "Ricavi mensili 2025 vs 2026" · 2 series × 12 · y 11.8k–20.8k € [· ignored: tension — the app chooses styling]`.
Registered beside `createContextResetTool` (`wiring.ts:667`) in every session-hosting
build; **not offered to sub-agents** (their steps are not transcript rows; the
parent can chart the report) — filtered like `present`. Label `chart → "Chart"`
(`tool-labels.ts`), subtitle = `title` (TUI `toolSubtitle` + phone `subtitleOf`,
parity test).

**D4 — shared pure math (`packages/core/src/chart/`, React-free, unit-tested; used by
the TUI renderer, the phone layout and the tool's result text):**
- `scale.ts` — `niceTicks(min, max, maxTicks, {zero})` (Heckbert nice numbers; bars/areas
  include 0; `min === max` → ±10 % or [0,1]); `dateTicks(t0, t1, maxTicks)` (round
  steps: 1/5/15/30 min, 1/3/6/12 h, 1 d, 1 w, 1 mo, 1 q, 1 y); `thinLabels(widths,
  positions, gap)` (greedy, never overlapping, first and last preferred);
  `downsample(ys, target)` = LTTB for line/area (keeps peaks: the mockup script keeps
  a 1-point spike out of 1 000 → 200, *Mockups*), bucket-mean for sparklines.
- `format.ts` — `formatNumber(v, {unit, format, decimals, locale})`: own compact
  (k/M/G/T, ≤ 1 decimal under 100) because CLDR `it` has no thousands abbreviation
  (Context); separators from `Intl.NumberFormat(locale)`; currency symbols (€ $ £ ¥ CHF)
  placed per locale (`it`: `12,5k €`, `en`: `€12.5k`), `%` glued, other units after a
  space. `formatDate(t, granularity, {locale, zone})`.
- `dates.ts` — ISO parsing with three honest kinds: **calendar** (`2026-03`,
  `2026-03-01`: no time zone, never shifted), **instant** (`…Z` / `…+01:00`: shown in
  the viewer's local zone, the zone named in the axis caption when it differs from
  UTC), **floating** (`2026-03-01T14:00` without offset: shown exactly as written).
  Mixing kinds in one chart → validation error.
- `palette.ts` — 8 categorical slots, light + dark, **validated** (Owner Q3): colour
  follows the dataset INDEX (never rank, never re-assigned when a series is hidden).
- `summary.ts` — the VoiceOver / table summary and the tool's result line from the
  same numbers (min, max, first → last, % change, argmax label).

**D5 — TUI (Mac): `packages/tui/src/chart-lines.ts` (pure: `(spec, width, mode,
glyphs, expanded) → string[]` of chalk-styled rows) + one branch in `render-lines.ts`.**
- **Line / area / scatter: braille** (U+2800–28FF, 2×4 dots per cell: 2× horizontal
  and 4× vertical resolution). Bresenham between consecutive non-null points
  (`null` = a break); area = the line + a 50 % dot fill below; scatter = 2×2 dot
  marks. A cell shared by two series takes the later series' colour (one foreground
  per cell). y gutter with nice ticks (`┤` at tick rows, `│` between), `└───` axis,
  x labels thinned by `thinLabels`. Legend line `━━ 2026   ━━ 2025` — glyph in the
  series colour, text in `subtle` (text wears text tokens).
- **Bar: horizontal by default** with ⅛-cell precision (`▏▎▍▌▋▊▉█`), value at the
  end; vertical columns (`▁▂▃▄▅▆▇█`) only when the client decides it (≤ 6 short
  labels). **Stacked:** whole-cell segments by largest remainder (the row's length is
  exact; a cell cannot hold two foregrounds). **Pie/doughnut:** a 100 % bar + legend
  with value and % (a character pie is unreadable).
- **Forms by width:** ≥ 60 cols → the mini plot (8 rows compact, 16 expanded); 40–59
  → one sparkline row per series (`▁▂▃▄▅▆▇█`, bucket means) with first → last and
  % change; < 40 → the data table only. Recomputed on resize (the renderer is a pure
  function of width; `render-lines` already re-lays out on resize).
- **Compact vs expanded:** compact = mini plot + legend + axes (≈ 11 rows), exempt
  from the generic tool-body cut (P3). Expanded (Ctrl+O, or a click on the chart's
  header — the per-id expand also expands a chart body, Owner Q6) = 16-row plot +
  per-series min/max/last + the data table (≤ 50 rows, then `… +N righe`).
- **Glyph fallback:** a new config key `tui.chartGlyphs: "braille" | "blocks"`
  (default `braille`; `blocks` = quadrant blocks `▘▝▀▖▌▞▛▗▚▐▜▄▙▟█`, 2×2 per cell, for
  fonts without braille — a terminal cannot report missing glyphs, so it is a
  setting, documented in `key-docs.ts` beside `tui.theme`).
- **Monochrome / NO_COLOR** (chalk level 0): series ≥ 2 are drawn dotted (every 3rd
  dot dropped) and the legend shows `━━` / `┅┅`; bars/stacks keep the legend order;
  the data table is the faithful fallback.
- **Width:** every measure is `string-width` (CJK labels count 2; cut with `…` by
  width). Box-drawing and block glyphs are East-Asian *ambiguous*: same exposure as
  the TUI's existing `─` rules and `⎿` connector, so no new risk.
- **Glyph audit:** every glyph above checked with `\p{Emoji}` → none (probe +
  render-check, *Mockups*); no `⏺`/`▶`/`◀`/`▪`-class code points.
- **Colours:** the shared palette (D4) as `tokens.chart.series[8]` in both modes
  (P4); the 256-colour downgrade is pinned by the existing `theme-contrast.test.ts`
  style (chart glyph contrast ≥ 3:1 on the light and dark backgrounds, relief = the
  legend + table, per the validator).
- No raw terminal writes: lines go through the same `render-lines` → Ink path as
  diffs (AGENTS §7).

**D6 — iPhone: `react-native-svg`, a pure layout module, a dumb renderer.**
- **Library (Owner Q8):** `react-native-svg` (pinned exact) — vector, crisp at every
  Dynamic Type size, path + text + gradients, mature with RN 0.88 / Expo 58. A native
  module ⇒ a new dev build — the SAME rebuild model-artifacts S8 needs for
  `react-native-webview`, so batch them. Skia (`@shopify/react-native-skia`) is
  heavier (≈ +6 MB) and buys GPU animation we do not need; pure RN Views cannot draw
  diagonal lines or arcs. Scrub interactions use RN core `PanResponder` (no
  `react-native-gesture-handler` dependency).
- **`apps/mobile/src/chart-layout.ts` (pure):** `chartLayout(spec, {width, height,
  fontScale, scheme, style}) → { paths: [{d, series, kind}], marks, gridY, yLabels,
  xLabels, legend, directLabels, hit: (x) → index, summary, table }` — ticks, label
  thinning by measured width (×`fontScale`), orientation choice for bars, donut arcs
  with 2 pt surface gaps, slices > 6 folded into "Altro", downsampling to ~2 points
  per pt of width.
- **`apps/mobile/src/chart-scrub.ts` (pure):** the press-and-hold machine (250 ms hold
  → scrubbing; `index` changes → `{ haptic: "tick" }`; release → idle; a vertical pan
  before the hold → scroll, never scrub).
- **`ui/chart/ChartView.tsx` (render only):** maps the layout to `<Svg>`; style A
  (recommended): no frame, hairline horizontal grid, y labels inside the plot, names
  at the line ends, last point marked; B: axes + full grid + legend chips. Full-width
  band, no rounded inset card, no pure black (owner taste; mockups).
- **Interactions:** tap → full-screen modal (landscape-capable, P9) with legend chips
  as series toggles (colours do not move: D4), a `Tabella` toggle, Share → CSV text
  via RN core `Share` (a PNG export needs `react-native-view-shot`: a follow-up, not
  v1); press-and-hold → scrub with a floating callout (A) + selection haptic per
  category; Reduce Motion → no transitions; Dynamic Type → `fontScale` drives label
  thinning; VoiceOver → the chart is ONE element with `accessibilityLabel` = the
  computed summary and an `accessibilityActions` "Show data table"; the table view
  exists for everyone (A: in-place `Grafico | Tabella` toggle).
- **Gallery / hub (C8):** `"chart"` joins `ARTIFACT_KINDS` (client list only — the wire
  `kind` is already free, P8); the gallery row thumbnail is drawn from the spec bytes
  (≤ 64 KiB, fetched like a ≤ 1 MiB image thumbnail); a `Grafici` filter chip; opening
  a chart artifact opens the same full-screen chart. The hub needs nothing new (it
  opens the gallery and badges `unseenArtifacts`, mobile-hub H4).

**D7 — old clients and versions.** No `PROTOCOL_VERSION` bump, no `protocol.d/` note:
no wire change at all (a new tool name and its arguments are data). Old TUI / old app
→ the generic tool row: header `chart` + its subtitle + the result text "Chart shown to
the user: …" (mockup `t-old`). New client, daemon without the tool → nothing to draw.
New client, old row with an invalid spec → generic row. Old app reading a `"chart"`
artifact → `artifactKindOf` → `"other"` card ("Share…"), never a crash.

### Files

Dependency order (slice in brackets):

1. `packages/core/src/chart/spec.ts` · `json-schema.ts` · `scale.ts` · `format.ts` ·
   `dates.ts` · `palette.ts` · `summary.ts` · `index.ts` · `core/src/index.ts` (export) [C1]
2. `packages/tools/src/chart.ts` (new) · `tools/src/index.ts` · `packages/core/src/tool-labels.ts`
   · `packages/cli/src/wiring.ts` (register; sub-agent filter) · the TUI `toolSubtitle`
   case + `apps/mobile/src/tool-summary.ts` `subtitleOf` case [C2]
3. `packages/tui/src/chart-lines.ts` (new) · `tui/src/theme.ts` (`chart` tokens) [C3]
4. `packages/tui/src/render-lines.ts` (branch + cut exemption + expand) ·
   `packages/config/src/defaults.ts` + `key-docs.ts` + `config-keys.ts`
   (`tui.chartGlyphs`) · its plumbing to the renderer [C4]
5. `apps/mobile/src/chart-layout.ts` · `chart-scrub.ts` (new, pure) [C5]
6. `apps/mobile/package.json` (`react-native-svg`, exact) · `ui/chart/ChartView.tsx` ·
   `screens/transcript/TranscriptRow.tsx` (branch) [C6]
7. `ui/chart/ChartFullScreen.tsx` · `ui/chart/ChartTable.tsx` · `haptic-rules.ts` +
   `haptics.ts` (`tick`) · a11y wiring [C7]
8. `packages/protocol/src/artifact.ts` (`"chart"` in `ARTIFACT_KINDS`) ·
   `apps/mobile/src/artifact-gallery.ts` (filter + thumbnail) · TUI artifacts panel
   (a chart artifact opens as an expanded chart in the panel) ·
   `changelog.d/model-charts.added.md` · this doc's Execution [C8]

### Failure modes

| Mode | What happens | Converges how | Pinned by |
|---|---|---|---|
| Strings for numbers (`"12.5"`, `"14,1"`, `"1.234,5"`) | validation error naming the path and the exact fix | model retries with numbers | T1.2 |
| Lengths mismatch / missing `labels` | error with both counts | model retries | T1.3 |
| Unknown / misspelled `type` | error with "did you mean" | model retries | T1.4 |
| Chart.js `options` / styling keys | `options` → error with the mapping; styling keys dropped + noted (Q2) | chart drawn; model learns from the note | T1.5 |
| NaN / Infinity in the JSON | registry's JSON error + our hint | model retries with `null` | T2.2 |
| Huge (\|v\| > 1e15) | error "scale it" | — | T1.6 |
| Tiny / negative values | nice ticks across 0; bars grow from the 0 baseline both ways; compact never rounds to "0k" (falls back to full below 1 000) | — | T1.7, T3.4 |
| All values equal / 1 point | ±10 % (or [0,1]) range; one marked point / one bar | — | T1.8, T3.5 |
| Empty / all-null | error | — | T1.3 |
| Mixed units | not detectable; the description says "two charts"; one unit per axis is all the schema allows | — | (description) |
| Dates: non-ISO, mixed kinds, DST | errors for the first two; instants plotted on real elapsed time (a DST day has 23/25 hours, ticks stay on local round hours), calendar dates never shifted | — | T1.9, T1.10 |
| 1000 points on 80 cols | LTTB to ~2 points per dot column; spikes kept | — | T1.11, T3.6 |
| > caps (8 series, 1000/series, 64 KiB) | error with the folding/aggregation advice | — | T1.12 |
| Long labels / CJK | width-aware cut with `…`; bars switch to horizontal; label thinning by measured width | — | T3.7, T5.3 |
| Terminal < 60 / < 40 cols; resize | sparkline rows / table; pure function of width → re-render | — | T3.8, T4.2 |
| Font without braille | `tui.chartGlyphs: blocks` | user sets it once | T3.9 |
| NO_COLOR / chalk level 0 | dotted series ≥ 2, legend `┅┅`, table | — | T3.10 |
| Old TUI / old app | generic tool row + result text | — | T2.4 (result text) |
| Pod forges `rawInput` | client re-validates with the same caps; draws only; nothing leaves the screen | — | T4.3, T5.5 |
| Spec valid on the daemon, invalid on a newer client (cap lowered) | generic row, never a crash | — | T4.3 |
| Artifact store absent / full / failing | inline chart still shown; result notes "not added to the gallery" | — | T2.3 |
| Compaction / `context_reset` | the inline row may leave the reloaded transcript; the gallery keeps the artifact (manifest) | — | T8.2 |
| `/clear` | model-artifacts D5c semantics (fork gets its callIds) | — | (model-artifacts T4.8) |
| Sub-agent tries `chart` | not in its registry | — | T2.5 |
| Scrub vs scroll conflict | vertical pan before the 250 ms hold scrolls; scrub only after the hold | — | T5.6 |
| Series hidden in full screen | colours stay on their index; ticks recomputed on visible series | — | T5.4 |

### Tests

Red first: each test is written and shown FAILING (module missing / wrong output)
before its code; one mutation per slice applied and reverted (§9). Fakes: the
`RpcPeer`/`createChannelPair` harness (C2 repro), ink-testing-library frames (C4),
pure fixtures elsewhere.

- **T1 (spec, C1)** 1 the owner's example + one valid spec per type pass; 2 strings
  for numbers (`"12.5"`, `"14,1"`, `"1.234,5"`, `"12k"`, `"€12"`) → one error each,
  the message contains the corrected literal; 3 length mismatch, missing labels, empty,
  all-null; 4 `donut`/`column`/`histogram`/`lines` → "did you mean"; 5 `options` →
  error with the mapping, `backgroundColor`/`tension` → `notes`, `foo` → error; 6 1e16 →
  error; 7 negative bars accepted, negative pie refused; 8 single point and equal values
  valid; 9 `03/01/2026` refused, `2026-03`/`2026-03-01`/`…Z`/`…+01:00` accepted, kinds
  mixed refused; 10 instants across a DST change produce monotone x; 11 `downsample`
  keeps a 1-in-1000 spike; 12 every cap at N passes and N+1 fails with its advice; 13
  `formatNumber` table (it/en: 12 500 → `12,5k €`/`€12.5k`, 999 → `999`, 0.0042 with
  decimals 4, −1 250 000 → `−1,3M`); 14 `niceTicks` fixtures incl. min = max and
  crossing 0; 15 palette: the validator's checks re-run as a test (light/dark, adjacent
  8 and first-3 all-pairs) — the slots never drift unvalidated.
- **T2 (tool, C2)** 0 **the args round-trip repro as a test** (load-bearing); 1 valid →
  result line exact; 2 NaN in raw args → JSON error + hint; 3 with an artifact sink:
  one `present` call with kind `chart` and canonical bytes; sink throwing → still
  success + note; 4 old-client fallback = result text is self-explanatory (snapshot);
  5 sub-agent registry has no `chart`; 6 label/subtitle parity TUI ↔ phone.
- **T3 (TUI renderer, C3)** snapshots (colour off and on) for: line compact 120/80,
  expanded 120/80, latency (date x, 96 pts), hbar, vbar, stacked rows, pie bar,
  scatter; properties: 1 no line wider than `width` (fuzz widths 20..200); 2 every
  braille cell's dots lie on the Bresenham path of its series (decode the bits back);
  3 x labels never overlap; 4 bar lengths in ⅛ cells = round(v/max·cells·8);
  5 1-point / equal values; 6 1000 points at 80 cols renders ≤ 2 dots per column per
  series; 7 CJK labels measured at width 2; 8 width tiers ≥60/40–59/<40; 9 `blocks`
  uses only `QUAD` glyphs; 10 level-0 colour: series 2 dotted, legend `┅┅`; 11 no glyph
  matches `\p{Emoji}`.
- **T4 (TUI wiring, C4)** ink frames: 1 a `chart` tool row live and after resume shows
  the compact chart, not the generic body, and is exempt from the cut; Ctrl+O and a
  header click expand it; 2 resize 120 → 50 → 120 re-lays out (no stale rows); 3 an
  invalid spec (forged) → generic row; 4 nothing written to `process.stdout` (spy).
- **T5 (phone pure, C5)** 1 `chartLayout` paths/ticks fixtures per type and style;
  2 `hit(x)` returns the nearest index, clamps at the edges; 3 label thinning with
  `fontScale` 1 and 2.35 (AX5) never overlaps; 4 hiding a series keeps the others'
  colours; 5 forged spec → `null` layout; 6 `chart-scrub`: hold < 250 ms + vertical
  pan → scroll; hold then horizontal → scrub with one `tick` per index change, none
  when the index repeats; release → idle; 7 summary strings (it/en).
- **T6 (phone render, C6)** a render test of `ChartView` with a mocked
  `react-native-svg` (element tree has the layout's paths); e2e flow
  `31-chart-inline.yaml`: the mock model calls `chart` → a chart row is visible;
  reopen the session → still visible.
- **T7 (phone interactions, C7)** e2e: tap → full screen, toggle a series, table
  toggle, back; VoiceOver label equals `summary`; Reduce Motion on → no animation
  (prop check); haptic port spy receives `tick` per category.
- **T8 (gallery, C8)** 1 a chart artifact appears with the `Grafici` filter and a
  thumbnail; old-kind mapping: an app build without `"chart"` maps it to `"other"`;
  2 after compaction the gallery still lists it; 3 the TUI artifacts panel opens a chart
  as an expanded render.

### Slices

| # | Slice | Size · Blast · Executor | Files item | Done when |
|---|---|---|---|---|
| C1 | Spec + validator + shared math + palette | M · contained · **deepseek** | 1 | T1 green + mutation (accept `"12.5"`) |
| C2 | `chart` tool, registration, labels (repro FIRST) | S · cross-module · **deepseek** | 2 | T2 green incl. T2.0 |
| C3 | TUI renderer (braille, blocks, bars, stacks, sparklines, table) | M · contained · **opus** (visual quality bar) | 3 | T3 green; frames compared to the mockup A variants |
| C4 | TUI wiring (row branch, cut exemption, expand, `tui.chartGlyphs`) | S · cross-module · **deepseek** | 4 | T4 green |
| C5 | Phone pure layout + scrub machine | M · contained · **deepseek** | 5 | T5 green |
| C6 | `react-native-svg` + `ChartView` + transcript branch | M · cross-module (**new native module ⇒ dev build**, batch with model-artifacts S8) · **opus** | 6 | T6 green on the simulator; if the build machine cannot build, unit tests + the honest "pixels unverified" line |
| C7 | Full screen, scrub, table, a11y, haptics | M · cross-module · **opus** | 7 | T7 green; P9 checked on device |
| C8 | Gallery / hub / artifact kind + changelog | S · cross-module · **deepseek** | 8 (after model-artifacts S9 + mobile-hub H4 are on `main`; else C8 waits and the branch merges without it) | T8 green |

Order: C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8. One merge after the fresh-context Review.

### Owner questions

Each with the recommendation. Mockups: `.tentacle/tmp/model-charts/mockups/index.html`
(section numbers in brackets).

1. **Data path.** (a) render inline from the tool call's args + register the spec as
   a `"chart"` artifact for gallery/hub/compaction; (b) artifact only (every inline
   chart fetched with `artifact/read`); (c) args only, no gallery. **Recommendation:
   (a)** — instant, works on old daemons and before model-artifacts lands, and the
   gallery still gets it (D1).
2. **Chart.js styling keys the model adds out of habit** (`backgroundColor`, `tension`,
   `fill`…): (a) drop them and say so in the result; (b) refuse the call.
   **Recommendation: (a)** for that closed list (a refusal costs a whole retry for
   nothing drawn differently); every other unknown key is an error, so the schema stays
   strict.
3. **Palette.** (A) Tentacle: slot 1 = a saturated teal near the app accent, then
   orange, violet, yellow, magenta, green, blue, red; (B) the dataviz reference
   (blue first). Both validated in light (`#FFFFFF`) and dark (`#1F1F1E`), *Palette
   validation*. Same palette in the TUI. **Recommendation: A** (brand-coherent; for
   scatter with ≥ 3 series it is in the 6–8 CVD band in dark, so scatter keeps a
   secondary encoding: shapes, mockup 6B).
4. **iPhone look** [1–10]: minimal (A) vs classic (B) for line, bars (horizontal vs
   columns), stacked (columns vs rows), area (gradient vs flat), pie (donut + legend vs
   pie), scatter (ringed dots vs shapes), scrub (floating callout vs header readout),
   full screen (chart + chips vs chart + side table), gallery (filter in the artifacts
   list vs a charts grid), data table (in-place toggle vs sheet). **Recommendation: all A.**
5. **TUI look** [11–17]: compact (8-row braille mini plot vs sparkline rows), expanded
   (16 rows + stats + table vs boxed), bars (horizontal ⅛ vs columns), stacked (rows vs
   columns), sparkline for 40–59 cols (one row per series vs inline in the header), pie
   (100 % bar vs one bar per slice). **Recommendation: all A** (sparkline: B, one row per
   series — it works for any number of series).
6. **Who decides orientation and expansion.** Bar orientation chosen by the client
   (no `indexAxis` in the spec); a TUI chart expands on Ctrl+O AND on a click on its
   header. **Recommendation: as stated** (orientation is presentation; one click is the
   natural "show me this chart").
7. **Caps and scope.** 8 series, 1000 points per series, 64 KiB per spec, 60 bar
   categories, pie folded to 6 + "Altro" by the client; no `chart` for sub-agents.
   **Recommendation: as stated.**
8. **Phone drawing library.** `react-native-svg` (needs the dev build model-artifacts
   already needs) vs Skia vs pure Views. **Recommendation: `react-native-svg`.**

### Mockups

`.tentacle/tmp/model-charts/mockups/index.html` — self-contained, light/dark toggle;
generated by `.tentacle/tmp/model-charts/gen.ts` from `chartlib.ts` (a prototype of
the C1/C3 math: nice ticks, own compact formatting, LTTB, Bresenham-on-braille,
quadrant blocks, ⅛ bars, largest-remainder stacks): **every braille dot, block and
SVG path is computed from the datasets in the script, not hand-drawn.** Tokens:
mobile-chrome light + B1 dark (`apps/mobile/src/theme.ts:84-164`), TUI `theme.ts`.
Sections: iPhone line / bar / stacked / area / pie / scatter (A and B each, inline in
a conversation), scrubbing (A/B), full screen landscape (A/B), gallery/hub (A/B),
table + VoiceOver (A/B); TUI at 120 and 80 cols: braille line compact (A/B) and
expanded (A/B), bars (A/B), stacked (A/B), sparkline (A/B) + the same data as a
date-x braille plot, pie (A/B), scatter, fallbacks (blocks, NO_COLOR), < 40 cols table,
old TUI. 37 frames, 16 recommended/alternative pairs, 20 iPhone frames.

**Render-check** (`bun .tentacle/tmp/model-charts/render-check.ts`, 2026-11-16: runs the
page's `<script>` against a stub `document`, light, then the toggle, then dark):

```
PASS [light] body theme class
PASS [light] 37 frames, all 37 expected present
PASS [light] 16/16 choices drawn as recommended + alternative
PASS [light] 32 TUI frames, 352 lines, none wider than its frame
PASS [light] no Emoji-property glyph in TUI frames
PASS [light] no "undefined"/"NaN"/"Infinity" in 170850 chars
PASS [light] 20 iPhone frames
PASS [light] no pure black in the light (n/a) tokens
PASS [dark] body theme class
PASS [dark] 37 frames, all 37 expected present
PASS [dark] 16/16 choices drawn as recommended + alternative
PASS [dark] 32 TUI frames, 352 lines, none wider than its frame
PASS [dark] no Emoji-property glyph in TUI frames
PASS [dark] no "undefined"/"NaN"/"Infinity" in 170852 chars
PASS [dark] 20 iPhone frames
PASS [dark] no pure black in the dark tokens
ALL PASS
```

Also printed by `gen.ts`: `lttb 1000 → 200 points; spike at 613 kept: true`.
**Unverified:** the pixels were not looked at by the planner (no browser screenshot
was available in this session); the check is structural. The owner's look at the page
is the visual check.

Sample (TUI compact A, 80 cols, colour stripped):

```
● Chart Ricavi mensili 2025 vs 2026
⎿ ━━ 2026   ━━ 2025
  25k € ┤
        │
  20k € ┤                                               ⢀⣀⡠⠤⠤⠔⠒⠒⠊⠉⠁          ⢀⣀
        │                        ⢀⣀⣀⣀⡠⠤⠤⠤⠤⠔⠒⠒⠊⠉⠉⠉⠉⠒⠒⠒⠒⠊⠉⠁       ⢀⣀⣀⣀⣀⠤⠤⠤⠤⠔⠒⠊⠉⠁
  15k € ┤              ⢀⣀⣀⡠⠤⠤⠔⠒⠊⠉⢁⣀⣀⣀⡠⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⢄⣀⣀⡀  ⢀⣀⡠⠤⠔⠒⠒⠊⠉⠉⠁
        │⣀⡠⠤⢔⣒⣊⣉⣉⠭⠭⠭⠛⠛⠛⠓⠒⠤⠤⠤⠤⠔⠒⠊⠉⠁                 ⠈⠉⠉⠁
  10k € ┤⠉⠉⠉⠁
        └──────────────────────────────────────────────────────────────────────
         gen  feb   mar    apr   mag   giu    lug   ago   set    ott   nov  dic
```

### Palette validation

`bun .tentacle/tmp/model-charts/palette/check.ts` (the dataviz validator, 2026-11-16;
surfaces `#FFFFFF` light, `#1F1F1E` dark):

- **A (recommended)** light `#0786a6 #eb6834 #6250d6 #eda100 #e87ba4 #008300 #2a78d6 #e34948`,
  dark `#0fa0bd #d95926 #9085e9 #c98500 #d55181 #0ca30c #3987e5 #e66767`:
  8 adjacent → **OK** both modes (worst adjacent CVD ΔE 16.1 light / 9.9 dark; normal
  19.6 / 19.3); first-3 all-pairs → OK light, dark CVD **6.6 (warn band)** → scatter
  keeps shapes. Light relief: yellow 2.17:1 and magenta 2.69:1 on white → legend +
  table always present (they are).
- The app accent itself (`#0E7490`) FAILS the chroma floor (0.094) and the dark accent
  `#22b8d4`-class teal falls outside the dark lightness band — hence the saturated
  `#0786a6` / `#0fa0bd` slot 1, not the accent token.
- **B (reference)**: OK in both modes on every check (relief in light for aqua/yellow/magenta).
- The TUI's own syntax colours as series (tried) FAIL dark first-3 all-pairs (CVD 2.7)
  → the TUI uses palette A too.

### Notes / debt

- PNG export of a chart (needs `react-native-view-shot` or Skia snapshot): follow-up.
- Live-updating charts (an `id` to version a chart in place): later field; the artifact
  versioning already supports it.
- Vega-Lite export: possible later from the canonical spec (owner note).
- `min`/`max`, log scale, annotations, mixed bar+line, bubble/radar: out of v1 until a
  real conversation needs them.

#### Owner requirements (2026-11-16 ~11:20, binding — add to docs/feat/model-charts.md before approval)
- The chart is drawn IN the conversation, at the point the model creates it, directly ON the conversation background: full width, centred, NO card / bubble / rounded box around it (owner taste). The artifact exists behind the scenes (save, gallery, full screen), never as a "tap to open" card.
- It must read as a natural part of the reply: the model can write text BEFORE and AFTER it in the same turn (text → chart → text, several charts in one reply). So the `chart` tool call does NOT render as a tool row ("● Chart …"): the chart itself takes the row's place, with at most a discreet caption (title/subtitle) — no tool chrome. Same in the TUI: the braille/block chart inline between the paragraphs, centred to the transcript width.
- "Deve essere una cosa fatta bene." Opus executes the rendering slices.


#### Owner answers (2026-11-16 ~11:40, binding)

*— recorded by claude-opus-5-5 (orchestrator), 2026-11-16*

"Ok a tutte le consigliate." Q1–Q8 = the recommendations. Mockup choices (sections 1–16, chosen on `.tentacle/mockups/model-charts/scegli.html`): iPhone 1–10 **A**; TUI 11–14 **A**, 15 **B** (one sparkline row per series), 16 **A**. **Implementation APPROVED.**

## Execution

*(empty — starts after the owner approves the Implementation)*

## Review

*(empty — mandatory fresh-context review after C8)*
