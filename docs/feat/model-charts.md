# feat/model-charts — the model draws charts in the conversation (iPhone native, Mac TUI in braille)

> **Status:** implementation — **plan APPROVED** (owner answers + rev-2 iPhone picks); **slices C1 (spec + validator + shared math + palette) and C2 (the `chart` tool, registration, labels) EXECUTED** — see *Execution*.
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
| `datasets[].data` | yes | Numbers or `null` (gap). `{x,y}` points for scatter and number/date x (Chart.js' own point form) — never for `pie`/`doughnut`, and a stacked chart's series must all sit on the same `x`. An all-`null` series is an error in both forms. |
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
| `{x,y}` points on a pie/doughnut | `datasets[0].data uses {x, y} points — a pie takes one number per label (put the slice names in labels)` |
| `{x,y}` points with a category x | `datasets[0].data uses {x, y} points — the x axis must be numeric: add x: {"type": "number"} (or "date")` |
| a stacked chart whose series sit on different `x` | `datasets[1].data has different x values from datasets[0].data — a stacked chart sums one column at a time, so every series needs the same x (or use stacked: false)` |
| date not ISO (`"03/01/2026"`) | `labels[0] "03/01/2026" is not an ISO date — write 2026-03-01 (or 2026-03, or 2026-03-01T14:00:00Z)` |
| `x.type:"date"` mixing date-only and timestamps | `labels mix dates and times — use one form` |
| over a cap | `datasets has 11 series (max 8) — keep the 7 largest and fold the rest into "Other"`; `1 800 points (max 1000 per series) — aggregate (e.g. per hour) or sample` ; spec > 64 KiB → `the chart is too large (71 KiB > 64 KiB)` |
| empty `datasets` / empty `data` | `datasets is empty — give at least one series with at least one value` |
| 1 point | **valid** (drawn as a single marked point / bar) |
| all `null` | `datasets[0].data has no values (all null)` — in the plain-value form and in the `{x,y}` point form alike |
| a bar over the 60-category cap, given as `{x,y}` points | `datasets[0].data has 61 points (max 60 categories for a bar chart) — fold the smallest into "Other" or use a line chart`; several series → `datasets have 120 distinct x values (max 60 categories for a bar chart) — …` (the count is the DISTINCT x across every series — a short first series buys no exemption) |

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
- **`ui/chart/ChartView.tsx` (render only):** *(visual language superseded by
  *iPhone visual language (rev 2, modern)* below; the sentence that follows is the rev-1 look)* maps the layout to `<Svg>`; style A
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

### iPhone visual language (rev 2, modern)

*— claude-opus-5-5, 2026-11-16*

**Why.** Owner, 2026-11-16, on iPhone mockups 1–10: "super functional and fine, but
aesthetically very OLD". The TUI mockups 11–17 are loved and are **not touched**. The
owner chose option A (restyle on `react-native-svg`) over Swift Charts (B) and Victory
Native XL (C). So this is a **visual-language redesign only**: same architecture
(`react-native-svg`, pure `chart-layout.ts` + render-only `ChartView.tsx`, spec from the
tool args), same spec, same validator, same palette, no protocol/persistence change.
Everything else in this plan stays approved. **iPhone sections 1–10 are to be re-picked
by the owner on `modern.html`**: the earlier "1–10 A" answer is superseded for the look.
D6's interactions, a11y, full screen, gallery and library choice still hold.

**Mockups:** `.tentacle/tmp/model-charts/mockups/modern.html` (self-contained,
light/dark toggle, "Rianima" button that replays the appear animation). Generated by
`.tentacle/tmp/model-charts/gen-modern.ts` from the same datasets as `index.html`. Every
path is computed: monotone cubic, nice guides, rounded bars, rounded sectors, label
dodging, least-squares fit, hero and delta. The choice bar reuses `choose.js`, re-keyed
to sections 1–10 and to `localStorage["model-charts-modern-choices"]`. Each section
shows A and B side by side, with A pre-selected "· consigliata".

**Shared grammar (both directions).** Neither direction has a card, bubble or box. The
chart sits on the conversation background, full width (16 pt side margins), with the
reply's text before and after it.
- **Hero number** above the plot, in tabular figures, with a **delta pill**. Its values
  come from `heroOf` (below). The pill is tinted with series slot 1 at 12–20 % alpha and
  its text uses the `label` token (text wears text tokens). It is **never green/red**:
  the spec has no polarity, and "▲ latency" is bad news.
- **Almost no chrome:** at most 3 hairline guides, and y labels only on the top and
  bottom guide. There are no axis lines and no vertical grid.
- **Curves:** monotone cubic (never overshoots the data). Strokes are 2–2.5 pt with
  round caps/joins. A gradient fill under the primary series fades to transparent.
  A `null` breaks the line.
- **Bars:** thinner, with generous gaps. Only the data end is rounded and the base is
  flat. One bar is highlighted and the rest are muted.
- **Direct labels** at the series ends instead of a legend (≥ 2 series), dodged so they
  never overlap. If they cannot fit, a legend row is the fallback (below).
- **Donut:** a thick ring made of rounded-corner sectors with small gaps, and the total
  large in the centre.
- **Scrubbing like Stocks:** a vertical rule plus a dot with a soft halo. The hero
  number, pill and context line become the values at the finger. There is **no floating
  tooltip box**, and a haptic tick fires on each index change.

**Direction A · Apple Stocks/Health (recommended, all 10).**
- **Header:** title 15 pt semibold. Hero 34 pt SF Pro Rounded bold, unit 17 pt
  secondary, then a capsule pill (13 pt). Context line 13 pt secondary (e.g. "ottobre
  2026 · vs ottobre 2025").
- **Line:** series 0 in slot 1 at 2.5 pt with a gradient (22 % → 0; area 30 % → 0). With
  exactly 2 series, series 1 is the comparison: `mutedLine` grey at 1.75 pt. With ≥ 3
  series, palette slots by index. Guides are dotted (1 pt, `1 3` dash). y labels sit at
  the right end of the top and bottom guide. x labels: first · middle · last. The last
  point gets a 3.75 pt dot inside a 7.5 pt halo (18 %).
- **Bars:** Screen Time rows. The name is above the bar and the value right-aligned in
  tabular figures. Bars are 7 pt with a fully rounded data end, rows 31 pt. The max bar
  is in slot 1, the others `mutedBar`.
- **Stacked:** columns at 52 % of their slot, 2 pt gaps between segments, top segment
  rounded 5 pt. The latest column is solid and the others are at 42 % (the eye goes to
  "today", which matches the hero).
- **Donut:** ring 25 pt (r 57–82), corner radius 7, gap 3.5 pt. Total 27 pt rounded in
  the centre. Labels sit outside at each slice's mid-angle, as name plus "value · %".
- **Scatter:** filled 9 pt dots with a 1.5 pt surface ring, and a dashed least-squares
  line.
- **Scrub:** the curve to the right of the finger dims to 30 %.
- **Full screen:** the same hero, larger, with text toggles carrying colour dots.
- **Gallery:** a Stocks-style list (title, sparkline, hero value, pill).
- **Table:** a segmented `Grafico | Tabella` control, a Δ column, and VoiceOver as one
  element.

**Direction B · minimal dashboard (Linear / Stripe / Vercel).**
- **Header:** title 13 pt secondary, with a mono meta on the right ("12 mesi"). Hero
  30 pt semibold, tracking −0.035 em, left-aligned. Square-ish mono pill (radius 5).
  Labels, ticks and footers use SF Mono.
- **Line:** every series in its palette colour (2 / 1.5 pt). The line chart has no fill;
  the area chart has a 16 % → 0 fill plus a baseline hairline. Guides are solid 0.6 pt.
  End labels are mono and carry the value ("2025 18,9k").
- **Bars:** a mono name column, a faint track behind each bar, bars 9 pt (radius 2.5).
  The highlighted bar is in slot 1 and the others are slot 1 at 38 %.
- **Stacked:** thin columns (34 % of slot), all solid, with only the max total labelled.
- **Donut:** thin ring (13 pt) on the left, with a mono mini-table (name · value · %) on
  the right.
- **Scatter:** 6.5 pt dots, with series 2 hollow (a secondary encoding without colour).
- **Scrub (justified variant):** a dashed rule plus a month chip pinned at its top. The
  hero is smaller and left-aligned, so the chip ties the rule to it. It is still not a
  tooltip, because the values live in the hero.
- **Full screen:** a strip of 3 KPIs (last · mean · max) above the plot.
- **Gallery:** a 2-column grid.
- **Table:** mini bars inside the cells, plus `csv`.

**Recommendation: A for all ten.** It is the native iOS grammar the app chrome already
speaks: rounded hero, capsules, segmented control, sheet lists. B's mono typography
reads as a web dashboard inside an iOS conversation. B's in-cell table bars (10B) are
the one idea worth borrowing later if the owner wants them.

**Changes in `apps/mobile/src/chart-layout.ts` (pure, React-free).** It returns
everything the component draws. The `style` parameter of D6 goes away: only the variant
the owner picks per section is built (no dead runtime switch).
1. **Curve interpolation:** `monotonePath(points)`.
   - Tangents follow Fritsch–Carlson with Brodlie's weighted harmonic mean
     (`t_i = (w1+w2)/(w1/m_{i-1} + w2/m_i)` with `w1 = 2h_i + h_{i-1}` and
     `w2 = h_i + 2h_{i-1}`). The tangent is 0 at a local extremum or a sign change, and
     the endpoints use their one-sided slope. Each segment becomes one cubic Bézier with
     control points at ±h/3.
   - Guarantee: every segment stays inside its endpoints' y range. The mockup generator
     verifies this on 447 segments (max excess 1.4e-14 px).
   - `null` splits a series into runs. The area path is the run plus the baseline.
   - LTTB downsampling (D4) runs **before** interpolation.
2. **Domain and guides:**
   - Lines use a tight domain padded 12 % each side. Bars and areas use `[min(0,lo),
     max·1.08]`.
   - `guides(lo, hi, 3)` returns ≤ 3 nice values inside the domain (niceTicks with
     decreasing counts). Only the top and bottom guides are labelled.
   - A guide label that collides with a direct label is dropped (the label wins).
3. **Hero + delta:** `heroOf(spec, at?) → { num, unit, unitBefore, delta?: { sign,
   pct, text }, context }`.
   - Line/area: the value of dataset 0 at `at` (default: its last non-null). The delta is
     against dataset 1 at the same x if present, else against dataset 0's first value.
   - Stacked: the latest column total, with the delta against the previous column.
   - Bar: the max value plus "label · il più lento/alto di N", with **no** delta (no
     "before" exists).
   - Donut: the total, drawn in the centre.
   - Scatter: the least-squares slope per a round x step (`10^floor(log10 xMax)`, e.g.
     "+9,0 s ogni 100 righe"), with an `r²` chip. It is shown only with ≥ 8 points and
     r² ≥ 0.5; otherwise the hero is the point count.
   - Formatting: the hero uses the **full** format with the spec's decimals (20.800 €).
     Axes stay compact (20k €). `format.ts` gains `formatParts` (number, unit, side), so
     the unit can be styled smaller.
   - Delta: `(cur − ref)/|ref|` to 1 decimal, shown as `▲`/`▼` plus the locale
     percentage. `ref = 0` gives no pill. The glyphs ▲ U+25B2 / ▼ U+25BC have no Emoji
     property.
4. **Direct labels:**
   - A series that reaches the last x is labelled in a right gutter at its end y. The
     gutter width is the max measured label width × `fontScale` + 10 pt.
   - A series that ends earlier (2026 at October) is labelled above its last point, or
     below it if there is no room.
   - Collision: `dodge(ys, h, lo, hi)` sorts, pushes forward by the line height, clamps
     back from the bottom, then clamps forward from the top. Order is preserved and the
     labels stay inside the plot.
   - If `n·h` exceeds the plot height (many series, or AX5 type), the layout returns a
     legend row instead, so identity never relies on colour alone.
   - The same `dodge` places the stacked labels (segment midpoints of the last column),
     the donut labels (per side, at mid-angles) and the scatter labels (each series'
     rightmost point).
5. **Rounded-bar geometry:**
   - Shapes: `barUp(x, y, w, h, r)` (vertical) and `barRight(x, y, w, h)` (horizontal,
     r = h/2). Only the data end is rounded, with `r = min(r, w/2, h)`. A height ≤ 0.2 pt
     draws no path. Negative bars round the downward end.
   - Thickness: A rows are 7 pt bars on 31 pt rows, B rows 9 pt on 23 pt. Columns take
     52 % (A) or 34 % (B) of their slot.
   - Stacked: a 2 pt gap is taken from each upper segment, so the column height still
     equals the total minus the gaps. Only the top segment is rounded.
   - Highlight: bars highlight their argmax (ties → first); stacked highlights the
     latest column.
6. **Donut gap and corner geometry:** `sector(cx, cy, ri, ro, a0, a1, cr, gap)` is an
   annular sector with 4 tangent corner arcs.
   - The gap is a pad angle of `gap / r_mid`.
   - The corner radius is clamped to `min((ro−ri)/2, ri·sin(s/2)/(1−sin(s/2)))`, so a
     thin slice degrades to sharp corners instead of vanishing.
   - **Why not true round caps:** a round cap eats `(gap + ring)/r` radians per slice.
     With a 25 pt ring at r 70 that is ≈ 23°, which erases any slice under ≈ 6 % (Haiku
     2,3 % would disappear).
   - Slices beyond 6 fold into "Altro" (unchanged).
7. **Scrub → hero binding:** `chart-scrub.ts` (unchanged machine) emits `index`. The
   layout's `scrubAt(index) → { x, dots[{x, y, series}], dimFromX }` places the rule,
   the dots and A's dim clip. The component re-renders the header from
   `heroOf(spec, index)`, which changes only when the index changes (the same moment as
   the haptic tick). Release gives `heroOf(spec)`. VoiceOver does not scrub: it reads
   `summary` and offers the table (unchanged).
8. **Appear animation (descriptor, not code in the layout):** the layout returns each
   path's length (sampled Bézier length), because `react-native-svg` has no reliable
   `pathLength`.
   - Line: draw-in via `strokeDasharray = L` and `strokeDashoffset L → 0`, 900 ms,
     ease-out `(.25,.8,.25,1)`.
   - Fills, end dots and labels: fade in 450 ms after 550 ms.
   - Bars and columns: scale from the baseline with a spring (`Animated.spring`,
     damping ≈ 14, stiffness ≈ 170: a slight overshoot), staggered 35–45 ms.
   - Donut: scale 0.82 → 1 plus opacity, with a spring.
   - **Reduce Motion** (`AccessibilityInfo.isReduceMotionEnabled`): opacity 0 → 1 over
     250–300 ms only.
   - It runs only when a live row first appears. Rows rebuilt from history, and rows
     scrolled back into view, render still.
   - The dash offset is not native-driver capable, so it runs JS-driven for its one
     900 ms; transforms and opacity use the native driver.

**Changes in `ui/chart/ChartView.tsx` (render only).**
- **Header:** title `Text`, then a hero row (`fontVariant: ["tabular-nums"]`, A's rounded
  face), a pill `View`, and the context `Text`, all bound to `heroOf` / `scrubAt`.
- **Plot:** `<Svg>` paths from the layout, `LinearGradient` + `Stop stopOpacity` for the
  fills, `ClipPath` for A's scrub dim, and `Animated` wrappers driven by the
  descriptors. No `Rect` frame and no card container.
- **Tokens:** new chart tokens in `apps/mobile/src/theme.ts`, both modes: `guide`,
  `guideStrong`, `track`, `mutedBar`, `mutedLine`, `seriesSoft` (slot 1 at 12 % light /
  20 % dark). The mockup values are in `modern-manifest.json`.
- **Unverified:** whether RN exposes SF Pro Rounded by name (`fontFamily`) without
  bundling it. Verify on device in C6. The fallback is the system face, bold, with
  tabular figures.
- The mockup uses `#1C1C1E` for light text where the app's `label` is `#000000`. The
  component uses the theme token; the owner can say whether chart text should be softer.

**Tests (added to T5 / T6 / T7; red first, one mutation per item).**
- **T5.8 monotone:** fuzz 1 000 series (plateaus, spikes, sign changes, nulls). Every
  segment, sampled 32×, stays inside its endpoints' range. *Mutation:* Catmull-Rom
  tangents overshoot on the spike and fail.
- **T5.9 guides:** ≤ 3 values, each a nice number, all inside the domain. Labels only on
  the extremes; a guide label is dropped when it collides with a direct label.
- **T5.10 `heroOf` table (it/en):**
  - Two-series line at its last value: `20.800 €`, `▲ 26,8%`, "ottobre 2026 · vs
    ottobre 2025".
  - Single-series area: delta against its first value.
  - `ref = 0`: no pill. A negative delta: `▼`.
  - Stacked: `348.000 token ▼ 15,1%`.
  - Bars: no delta. Donut: the total.
  - Scatter: slope `+9,0`, r² 0,85, and the gate below 8 points or r² < 0.5.
- **T5.11 direct labels:** never overlap, order preserved, inside bounds. At
  `fontScale` 2.35 the overflow returns the legend fallback.
- **T5.12 bars:** only the data end is rounded, a zero-height bar draws no path, r is
  clamped, and stacked segment heights plus gaps equal the column height exactly. Only
  the top segment is rounded.
- **T5.13 donut:** sector areas (numeric integration) are proportional to the values
  within 1 % after the gaps. A 0.5 % slice still yields a non-empty path, and a single
  slice draws a full ring. *Mutation:* round caps make the small slice vanish.
- **T5.14 scrub binding:** `scrubAt(i)` gives `x = X(i)`, one dot per non-null series,
  and a hero equal to `heroOf(spec, i)`. Release returns to the last value.
- **T5.15:** no hero/pill glyph matches `\p{Emoji}`.
- **T6:** the render tree per picked direction has no card container, and the
  gradient/clip are present when the layout asks for them.
- **T7:** Reduce Motion gives opacity-only animation props. A history-rebuilt row has no
  animation.

**Render-check** (`bun .tentacle/tmp/model-charts/render-check-modern.ts`, 2026-11-16:
runs the page script and the reused `choose.js` against a stub `document`, light, then
the toggle, then dark):

```
$ bun gen-modern.ts
wrote mockups/modern.html (128446 chars): 20 iPhone frames, 10 A/B pairs
monotone cubic: 447 segments, overshoot 0 (max excess 1.4e-14 px)
sectors 16, labels moved by dodge 5
fit: slope 8.98 s/100 righe, r² 0.848; guides revenue 15000,20000
hero line: 20.800 € ▲ 26,8% (ottobre 2026 · vs ottobre 2025); scrub ago: 17.600 ▲ 26,6%; stacked: 348.000 ▼ 15,1%
$ bun render-check-modern.ts
PASS 2 scripts (page + choice bar), got 2
PASS [light] body theme class
PASS [light] 20 frames, all 20 expected present
PASS [light] 10/10 sections with A and B side by side, recommended tagged
PASS [light] 18/18 chart frames draw computed SVG geometry
PASS [light] 2/2 table frames: header + 12 month rows + VoiceOver summary
PASS [light] 21 SVG/DOM ids, all unique (gradients and clip paths don't collide)
PASS [light] no "undefined"/"NaN"/"Infinity" in 104766 chars
PASS [light] no pure black in the tokens
PASS [light] 2 landscape frames
PASS [light] no card/box wrapper around any chart
PASS [dark] body theme class
PASS [dark] 20 frames, all 20 expected present
PASS [dark] 10/10 sections with A and B side by side, recommended tagged
PASS [dark] 18/18 chart frames draw computed SVG geometry
PASS [dark] 2/2 table frames: header + 12 month rows + VoiceOver summary
PASS [dark] 21 SVG/DOM ids, all unique (gradients and clip paths don't collide)
PASS [dark] no "undefined"/"NaN"/"Infinity" in 104774 chars
PASS [dark] no pure black in the tokens
PASS [dark] 2 landscape frames
PASS [dark] no card/box wrapper around any chart
PASS monotone cubic: 447 segments, 0 overshoot (max excess 1.4e-14 px)
PASS choice summary = "Grafici moderni: 1A 2A 3A 4A 5A 6A 7A 8A 9A 10A"
PASS sticky summary has Copia + Ripristina consigliate
PASS 10 choice bars, each with the recommended button labelled
PASS reload with a saved pick under "model-charts-modern-choices" → "Grafici moderni: 1A 2A 3A 4A 5A 6A 7B* 8A 9A 10A"
PASS the old index.html choices key is untouched
ALL PASS
```

**Unverified:** I did not look at the pixels (headless Chrome needs an approval this
session did not have), so the check above is structural. The owner's look at
`modern.html` is the visual check.

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
| Empty / all-null | error, in both the values and the `{x,y}` point form | — | T1.3 |
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
| C8 | Gallery / hub / artifact kind + the tool's `present` call (C2's T2.3) + changelog | S · cross-module · **deepseek** | 8 (after model-artifacts S9 + mobile-hub H4 are on `main`; else C8 waits and the branch merges without it) | T8 green, T2.3 green |

Order: C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8. One merge after the fresh-context Review.

**C2 as executed:** T2.3 (the artifact registration, D3's `ctx.artifacts`) moved to
C8 — `ToolContext.artifacts` is feat/model-artifacts' seam and is not on this branch,
so adding it here would define `ArtifactSink` twice (P8 says C1–C7 do not depend on
it). C8 already owns the `"chart"` artifact kind and the gallery, so it adds the
`present` call and T2.3 together. Everything else in C2's row is done; see *Execution*.

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
   *Rev 2: to be re-picked on `modern.html`: A Stocks/Health vs B minimal dashboard;
   recommendation all A.*
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

*iPhone 1–10 of this page are superseded by `mockups/modern.html`; see* iPhone visual
language (rev 2, modern). *The TUI 11–17 below are unchanged.*

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

**2026-11-16 (later), owner on iPhone 1–10:** "super functional and fine, but aesthetically very OLD". The owner chose a restyle on `react-native-svg` (option A). **iPhone sections 1–10 are to be re-picked by the owner on `modern.html`** (*iPhone visual language (rev 2, modern)*). The TUI picks 11–16 and everything else stay approved.

## Execution

### C1 — spec + validator + shared math + palette (slice C1 of 8)

*— claude-opus-5-5 (executor), 2026-11-16*

**Load-bearing check re-run first (before any edit, on this worktree's `feat/model-charts`
tip, which is `main` + the doc).** The assumption is "the spec can ride the tool call's
own arguments — so no new method, no new update type, no `PROTOCOL_VERSION` bump".

```
$ rg -n "rawInput" packages/daemon/src/mapping.ts
272:        rawInput: safeParseArgs(event.arguments),
$ rg -n "rawInput" packages/protocol/src/updates.ts
54:  rawInput: z.unknown().optional(),
$ rg -n "rawInput|arguments" packages/client/src/mapping.ts
268:        arguments:
269:          typeof update.rawInput === "string"
270:            ? update.rawInput
271:            : JSON.stringify(update.rawInput ?? {}),
$ rg -n "args" packages/tui/src/state.ts        → 123 (readonly args), 437 (args: event.arguments)
$ rg -n "arguments" apps/mobile/src/transcript.ts apps/mobile/src/transcript-history.ts packages/tui/src/resume.ts
apps/mobile/src/transcript.ts:357:        args: event.arguments,
apps/mobile/src/transcript-history.ts:93:          args: call.arguments,
packages/tui/src/resume.ts:71:          args: call.arguments,
$ rg -n "tool_call:" packages/protocol/src/updates.ts   (UPDATE_CLASS block)
517:  tool_call: "display",
```
**HOLDS.** `rawInput` is a free `z.unknown()` on a `display`-class update on both
directions of the mapping, and both frontends keep the call's `arguments` string live
and after reload. Nothing C1 adds touches the wire, so no `protocol.d/` note.

**Context repro re-run (the capability is genuinely missing):**

```
$ rg -n '"chart"|chart_spec|ChartSpec' packages apps --glob '!**/node_modules/**' | wc -l
       0
$ ls apps/mobile/node_modules | rg -c 'react-native-svg'
no match
$ rg -c '"react-native-svg"' bun.lock
no match
$ ls packages/core/src/chart
ls: No such file or directory
```

**As built** (dependency order; `packages/core/src/chart/`, all React-free and
re-exported from `packages/core/src/index.ts:13`):

| File | What it is |
|---|---|
| `dates.ts` | `parseIsoDate`/`parseIsoDates`/`mixedDateKinds`/`datePositions`; the three kinds (calendar / instant / floating) and the four accepted forms, with impossible dates refused. |
| `spec.ts` | `ChartSpec` + `validateChartSpec` (the one reader of `unknown`), `CHART_CAPS`, `CHART_MAX_ABS_VALUE`, `canonicalChartJson`/`chartSpecBytes`, `effectiveXType`/`usesPoints`/`specDates`/`specXPositions`. |
| `scale.ts` | `niceTicks` (Heckbert + a count-fitting step-up), `dateTicks` (incl. month/quarter/year), `thinLabels`, `downsampleLttb`, `bucketMeans`, `finiteValues`. |
| `format.ts` | `formatNumber` (own `k`/`M`/`G`/`T`, `Intl` separators, locale-driven currency placement), `autoFormat`, `formatDate`, `formatPercent`. |
| `palette.ts` | palette A (8 slots × light/dark), `seriesColor(index, scheme)`, and the dataviz validator's five checks as code (`validatePalette`, `contrastRatio`, `oklch`). |
| `summary.ts` | `summarizeChart` → the tool's result line + the per-series facts VoiceOver reads; `chartExtent`, `yFormat`, `datasetValues`. |
| `json-schema.ts` | `CHART_JSON_SCHEMA`, hand-written and closed, its caps read from `CHART_CAPS` so they cannot drift. |

Tests (red first — see the mutation block): `packages/core/test/chart-spec.test.ts`
(T1.1–T1.9, T1.12), `chart-math.test.ts` (T1.10, T1.11, T1.13–T1.15),
`chart-helpers.test.ts` (positions, `seriesColor`, the JSON Schema's agreement with the
validator), `chart-summary.test.ts` (T1.16 + the canonical bytes),
`chart-fuzz.test.ts` (the failure modes §9 asks for, see drift 8).

**Mutation checks (§9; each applied, the named test shown failing, then reverted).**

```
1) accept a numeric string instead of refusing it            (spec.ts readNumbers)
   → 4 fail, incl. (fail) T1.2 "12.5" — write the number, no quotes
2) positions by index instead of elapsed time                (dates.ts datePositions)
   → (fail) T1.10 instants across a DST change stay monotone and on elapsed time
3) hand-edit a dark slot #9085e9 → #8a83d8                   (palette.ts CHART_PALETTE)
   → (fail) T1.15 dark: 8 adjacent pass, first-3 all-pairs still clears the CVD floor
4) plain stride sampling instead of LTTB                     (scale.ts downsampleLttb)
   → (fail) T1.11 a 1-in-1000 spike survives 1000 → 200
5) always-compact auto format                                (format.ts autoFormat)
   → (fail) T1.13 auto: compact above 10 000, full below
6) a "k" suffix treated as a unit, not a scale               (spec.ts numericReading)
   → (fail) T1.2 "12k" and "€12" — the plain number
7) revert the two sentences the fuzz found                   (spec.ts readText,
                                                              stringValueError)
   → 3 fail: "a value slot cannot hold a date", "the complaint is about the type",
     "a series label and an axis title"
```

**Palette cross-check.** The ported validator was run against the reference
`validate_palette.js` the plan's numbers came from
(`.tentacle/tmp/model-charts/xcheck.ts`): every measured ΔE agrees — light 8
adjacent CVD 16.1 / normal 19.6, light first-3 12.5 / 17.9, dark adjacent 9.9 /
19.3, dark first-3 **6.6** (warn band) / 15.1 — and the contrast relief lands on the
same two light slots (`#eda100` 2.17:1, `#e87ba4` 2.69:1). Only the wording differs.

**Drift from the Implementation (and why).**

1. **The owner's example in Context uses `"y":{"unit":"€","format":"k"}`, which the
   plan's own D2 and the validation table forbid** (`format` is `compact|full`; `12k`
   is a *value* mistake). §7 says the schema wins over an illustrative example, so
   `format: "k"` is refused with `y.format "k" is not valid — allowed: compact, full
   (or leave it out and the client picks)`, and T1.1 uses the D2 form. The Context
   example needs a one-line fix in the doc (not done here — it is the owner's text).
2. **`formatPercent` glues `%` (`37,5%`)** like `formatNumber`'s `%` unit, instead of
   the plan's `37,5 %` for the *legend*. One rule for the glyph, and `%` glued is the
   Italian convention for a signed magnitude; a legend row reads `▬ Ricavi 37,5%`.
3. **`niceTicks` gained a count-fitting step-up.** Heckbert alone gives 11 ticks for
   `0..987` in 8 rows; the plan promises `maxTicks`, so the step climbs until the
   count fits (the tests pin `≤ maxTicks + 1`).
4. **`downsampleLttb` keeps a representative of every `null` run.** LTTB treats `null`
   as 0 for its area math and silently bridges gaps; the plan's "`null` = a break" is
   a correctness property, so a run of nulls that LTTB would drop keeps its middle
   point (pinned by T1.11 "nulls stay breaks").
5. **The 64 KiB cap is measured on the CANONICAL bytes** (`chartSpecBytes`), which is
   also what the artifact will store (D1) — so the cap and the version identity are
   the same number.
6. **`top-level unknown field` messages list the allowed keys** (`allowed: type,
   title, …`), and `options` gets its own sentence mapping Chart.js' bag onto the
   spec. The plan names the `options` sentence; the allowed-list form is what
   `datasets[0]`/`y` already did, so one shape for all three.
7. **`CHART_JSON_SCHEMA` reads `CHART_CAPS`** instead of repeating the numbers, so
   the model-facing schema and the validator cannot drift (pinned by
   `chart-helpers.test.ts`).
8. **Two sentences changed after a fuzz pass, and got their own test.** A pod can
   forge `rawInput` and a client re-validates it, so the validator must never throw
   and must never leak a JS internal into a sentence a model reads. Fuzzing 40 000
   inputs found two defects: a non-string `title` reported `title must be text —
   title is missing — give the chart a short title…` (the "you did not give it"
   sentence reused as the type complaint), and a date in a value slot got only the
   generic "write a number", with no hint that dates belong in `labels`. Both are
   fixed (`spec.ts` `readText` / `stringValueError`) and pinned by
   `chart-fuzz.test.ts`, whose bounded 3 000-case run asserts the other invariants
   too: never throws, always ≥ 1 and ≤ 8 errors, no `undefined`/`[object`/`NaN` in
   any message, and both arms of the fuzz reached (so the ok path is exercised, not
   just the refusals).

**Not in C1** (they belong to later slices): `packages/tools/src/chart.ts`,
`toolLabel("chart")`, `wiring.ts`, `tui/src/chart-lines.ts` + the `chart` theme
tokens, the TUI row branch, `apps/mobile/src/chart-{layout,scrub}.ts`,
`react-native-svg`, the gallery. `summary.ts` is here because the tool's result line
*is* its output (D4 lists it in `core`), and its exact line is pinned by T1.16 so C2
can only consume it.

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` clean (0 errors, 0 warnings, the
§6 baseline) · `bun test` **12 603 pass, 5 skip, 0 fail** (12 608 tests, 901 files,
462 s) — the 5 skips are exactly the three opt-in groups of §6 (2 live-docker, 2
live-k8s, 1 real-socket slow), so no new fail and no non-opt-in skip · no schema
changed, so `packages/protocol/schema/protocol.json` needed no regeneration · one
fragment `changelog.d/model-charts.added.md` (never `CHANGELOG.md`; its `[Unreleased]`
is untouched) · `TODO.md` untouched.

```sh
$ bunx tsc --noEmit                 # (no output)
$ bun run lint
Checked 1733 files in 542ms. No fixes applied.
$ bun test
 12603 pass · 5 skip · 0 fail · 13 snapshots, 98227 expect() calls
 Ran 12608 tests across 901 files. [462.30s]
```

**One pre-existing flake, not this change.** An earlier full run hit
`packages/daemon/test/session-log-store.test.ts:815` (T4, "the fork precedes the
source's next write") — `expect(control.forkTemps).toBe(1)` got 2. That fixture asserts
after a fixed `await Bun.sleep(60)`; it re-runs green in isolation (3/3) and fails under
deliberate CPU load (1 of 3 runs with six `bun test` peers alongside).
`packages/daemon/` imports nothing this slice added
(`grep -rn chart packages/daemon/src packages/daemon/test` → no match), so it cannot be
caused here: it is a timing assumption in that fixture, for its own task.

**Unverified in this slice** (C2's job, named so it is not mistaken for done): that a
real `SessionHost` + `Connection` + `RemoteClient` round-trip carries a 40 KiB chart
spec intact end to end (the plan's C2.0 repro), and that a TUI/phone row's stored
`args` re-validates to the same spec. The seam is proved statically above and the
validator is fuzzed, but the round trip itself is C2's first deliverable.

### C2 — the `chart` tool, registration, labels (slice C2 of 8)

*— claude-opus-5-5 (executor), 2026-11-16*

**Load-bearing check re-run FIRST, as the plan requires** — "the spec can ride the
tool call's own arguments to every client". Static grep (as C1) plus the runtime
proof the plan demanded, `.tentacle/tmp/model-charts/args-roundtrip.ts`: a real
`SessionHost` + `Connection` + `RemoteClient` over `createChannelPair`, a scripted
model calling `chart` with a **39 022-byte** spec (8 series × 700 points, which is
under the 64 KiB cap: a bigger fixture is refused by the validator, not by the wire).

```
$ NODE_PATH=…/zod@3.23.8/node_modules bun .tentacle/tmp/model-charts/args-roundtrip.ts
spec bytes = 39022
live: tool_start.arguments bytes=39020 deep-equal=true
reload: tui bytes=39020 deep-equal=true
reload: phone bytes=39020 deep-equal=true
PASS
```

**HOLDS.** Nothing C2 adds touches the wire: no `protocol.d/` note, no
`PROTOCOL_VERSION` bump, no `protocol.json` regeneration. The 2-byte gap is the fixture's own
non-ASCII `€` (three UTF-8 bytes against one JS code unit, and `ARGS.length` counts
code units): everything the property needs is asserted on the parsed value
(`toEqual`) and on string identity, never on a byte count.

The script lives in `.tentacle/tmp/model-charts/args-roundtrip.ts` (gitignored, so it
does not survive the branch) — reproduced here, and turned into the permanent test
**T2.0** (`packages/client/test/chart-args-roundtrip.test.ts`), which is the version
that keeps running:

```ts
// .tentacle/tmp/model-charts/args-roundtrip.ts — run with
//   NODE_PATH=<repo>/node_modules/.bun/zod@3.23.8/node_modules bun <this file>
// (a script under .tentacle/ resolves no workspace dependency, so `zod` — which
// `@tentacle/core` needs — comes from NODE_PATH and the four local modules are
// imported by absolute path).
const POINTS = 700;                       // 8 × 700 → ~39 KiB, under the 64 KiB cap
const spec = { type: "line", title: "Ricavi mensili".padEnd(115, " "),
  labels: Array.from({ length: POINTS }, (_, i) => `m${i % 12}-${Math.floor(i / 12)}`),
  datasets: Array.from({ length: 8 }, (_, s) => ({
    label: `Serie ${s}`,
    data: Array.from({ length: POINTS }, (_, i) => Math.round((i + s) * 13.5 * 100) / 100),
  })),
  y: { unit: "€", format: "compact" } };
const ARGS = JSON.stringify(spec);
// A model that calls `chart` once, then answers.
class Scripted { *stream() { yield { type: "tool_call", toolCall: { id: "c1", name: "chart", arguments: ARGS } }; yield { type: "done" }; } }
// The REAL stack: SessionHost + Connection + RemoteClient over createChannelPair.
new Connection(daemonCh, new SessionHost({ createAgent: () => ({ agent, permissions }) }));
const client = new RemoteClient(clientCh, new PermissionBroker());
await client.initialize();
const session = client.newSession();
for await (const event of session.send("dammi un grafico")) events.push(event);   // LIVE
const live = events.find((e) => e.type === "tool_start").arguments;
const history = await client.snapshot(session.sessionId);                          // RELOAD
const tui = messagesToItems(history).filter((i) => i.kind === "tool")[0].args;
const phone = historyRows(history, counter()).filter((r) => r.kind === "tool")[0].args;
const same = (a) => JSON.stringify(JSON.parse(a)) === JSON.stringify(spec);
console.log(same(live) && same(tui) && same(phone) && live === tui && live === phone ? "PASS" : "FAIL");
```

**As built** (dependency order):

| # | File | What it is |
|---|---|---|
| 1 | `packages/core/src/tool.ts` (`Tool.argumentsHint`) | An optional `(rawArguments) => string \| undefined` a tool may offer the registry's `invalid JSON arguments for <name>` path. The seam the NaN/Infinity hint rides (T2.2): the registry hands over the RAW text, and only the tool knows its own usual offender. |
| 2 | `packages/tools/src/registry.ts` | The parse-failure branch appends `tool.argumentsHint?.(rawArguments)` when it answers; byte-identical to before for every tool that has none — `invalid JSON arguments for ${name}`, no trailing newline (pinned by T2.2's third row). |
| 3 | `packages/tools/src/chart.ts` (new) | `CHART_TOOL_NAME`, `CHART_ARGUMENTS_HINT`, `chartArgumentsHint` (matched on `/\b(NaN|Infinity|undefined)\b/`, so a plain typo gets no diagnosis it does not deserve), `chartTool`: `permission: "none"`, `jsonSchema: CHART_JSON_SCHEMA` with `inputSchema: z.record(z.unknown())`, `concurrency: () => []`, `execute` = `validateChartSpec` → `summarizeChart(...).line`. The 1 371-char description (`two charts`, `colour`, "write 12.5, never \"12.5\"", the caps). |
| 4 | `packages/tools/src/index.ts` | Exports `chart.ts`. |
| 5 | `packages/core/src/tool-labels.ts` | `chart: "Chart"`. |
| 6 | `packages/agent/src/subagent.ts` | `CHART_TOOL_NAME` in both "never a child" lists (the registry filter and `readOnlyType`'s pre-filter skip). |
| 7 | `packages/cli/src/wiring.ts` | `tools.register(chartTool)` beside `createContextResetTool()` — the one registration site shared by every session-hosting build. |
| 8 | `packages/tui/src/render-lines.ts` | `toolSubtitle`'s `chart` case → the spec's `title`, falling back to the raw args. |
| 9 | `apps/mobile/src/tool-summary.ts` | `subtitleOf`'s `chart` case, case-for-case with the TUI's. |

Tests: `packages/tools/test/chart.test.ts` (T2.1, T2.2, T2.4),
`packages/client/test/chart-args-roundtrip.test.ts` (T2.0, the load-bearing
property), `packages/cli/test/chart-wiring.test.ts` (T2.5: registration + the
sub-agent filter, against the real `buildAgent`), `packages/core/test/tool-labels.test.ts`
(T2.6 label), `packages/tui/test/render-lines.test.ts` + `apps/mobile/test/tool-summary.test.ts`
(T2.6 subtitle parity in both directions). One existing pinned test changed, on
purpose: `packages/cli/test/wiring.test.ts:983`'s tool-name list gained `chart`
(that file's whole point is that the list is byte-pinned, so a new tool must be an
explicit edit there).

**Mutations (§9; each applied, the named test shown failing, then reverted —
script `.tentacle/tmp/mut.sh`, output below verbatim).**

```
1) drop the sub-agent filter entry                        (subagent.ts, registry filter)
   → (fail) a `general` child (tools: "all") does not get it…           0 pass 1 fail
2) drop the registration                                   (wiring.ts)
   → 4 fail (all three registration rows + the child's parent-had-it check)
3) registry: never append the hint                         (registry.ts `hint === undefined` → true)
   → 2 fail, (fail) T2.2 "the registry's JSON error carries it"
4) chart: drop `argumentsHint`                             (chart.ts)
   → the same 2 T2.2 rows fail
4b) chart: hint unconditionally, whatever the text       (chart.ts `return CHART_ARGUMENTS_HINT`)
   → (fail) T2.2 "a plain syntax error gets NO hint"
4c) registry: always append (newline + `hint ?? ""`)      (registry.ts)
   → 2 fail: the no-hint tool's message gains a trailing newline
5) answer with a home-made line instead of the shared summary (chart.ts)
   → 3 fail, incl. T2.1 "the result is `Chart shown to the user: …`"
6) `concurrency: "exclusive"` instead of `() => []`         (chart.ts)
   → (fail) T2.1 "the tool touches no resource: two charts never conflict"
7) the TUI subtitle reads the wrong key                     (render-lines.ts)
   → 2 fail: the phone's parity case AND the TUI's own chart row
8) drop `chart: "Chart"`                                    (tool-labels.ts)
   → 2 fail: (fail) toolLabel "maps every built-in tool name…", (fail) the chart row
9) skip validation entirely                                 (chart.ts `if (!validation.ok)`)
   → 2 fail, incl. T2.4 "an over-cap spec is refused with the cap's advice"
10) `rawInput: undefined`                                   (daemon/src/mapping.ts)
   → (fail) T2.0, the load-bearing round trip
11) client: `String(update.rawInput)` instead of the string  (client/src/mapping.ts)
   → (fail) T2.0 (`[object Object]`)
12) reload truncates the row's args to 4 000 chars           (tui/src/resume.ts)
   → (fail) T2.0
```

One mutation that stayed **green**, recorded so nobody re-derives it: the client
re-serialising the parsed object (`JSON.stringify` of `rawInput` instead of passing
the string through) leaves T2.0 green — JS preserves insertion order and the
round trip is lossless, so string identity survives. T2.0 therefore pins "nothing
is lost", which is what the renderers need; it does not pin "nobody
re-serialises". The test's header says so.

**Drift from the Implementation (and why).**

1. **T2.3 (the artifact registration) is NOT in C2 — it moved to C8.** The plan's
   D3 has `execute` call `ctx.artifacts.present({kind: "chart", …})`, but
   `ToolContext.artifacts` / `ArtifactSink` do not exist on this branch: they
   arrive with **feat/model-artifacts** (plan P8, "not on `main` yet"). Adding that
   seam here would mean a second, conflicting definition of `ArtifactSink` in
   `core/src/tool.ts` — the plan's own P8 says C1–C7 do not depend on it. So C2
   ships the tool without the sink and C8 (which already owns `"chart"` in
   `ARTIFACT_KINDS`, the gallery and the fragment) adds the `present` call, its
   failure mode and its test. **This is the one place the slice's "Done when" is
   not fully met: T2.3 is deferred, not dropped.**
2. **`concurrency: { keys: [] }` cannot be written as the plan says.** `Tool.concurrency`
   is `"exclusive" | ((input) => readonly ResourceKey[] | "exclusive")`
   (`core/src/tool.ts:218-220`) — there is no `{keys}` object, and an empty key
   list would classify as `"exclusive"` anyway (`isReadClass` requires `length >
   0`, `agent/src/round-plan.ts:53-55`). Written as `concurrency: () => []`: the
   tool touches nothing, and the round executor does not serialize charts. Pinned
   by mutation 6.
3. **The NaN/Infinity hint needed a seam that did not exist.** The plan says "we
   add the hint by checking the raw text", but `Tool.execute` never runs on a parse
   failure — `registry.execute` returns before it (`tools/src/registry.ts:81-95`).
   Rather than special-casing the name `"chart"` in the registry (a tool-specific
   branch in a generic choke point), the hint is a `Tool.argumentsHint` field: any
   tool that knows its usual non-JSON offender sets it, and every other tool's
   message is byte-identical (the 123 existing call sites keep `invalid JSON
   arguments for ${name}` alone). This is additive and needs no `protocol.d/`
   note (it is not on the wire at all).
4. **The result line's locale.** `summarizeChart` defaults to `en`, so a real
   call answers `y €11.8k–€20.8k` (`it` would give `11,8k €–20,8k €`, T1.16's
   fixture). The tool passes no locale on purpose: the result is MODEL-facing, the
   row is the client's to format, and a daemon (a pod's) has no reader locale to
   offer — inventing one from `LANG` inside a pod would be a guess about the
   laptop's user. T2.1/T2.4 pin the `en` text and say why.
5. **The subtitle's fallback is the RAW args, not `""`.** `toolSubtitle`'s
   `default:` arm returns `tool.args`; the `chart` case follows the same rule for a
   spec with no `title` (a pod-forged `rawInput`, an old row), so a broken chart
   row still says something instead of rendering an empty subtitle. Both sides do
   it, and the parity test covers `"not json"` on both.
6. **A second changelog fragment was not added.** The plan and C1 already own
   `changelog.d/model-charts.added.md`, and two fragments cannot share a
   `<slug>.<category>` (the release script treats a duplicate name as a conflict,
   `scripts/changelog.ts:88-92`). C2's user-visible part is folded into that one
   bullet rather than filed as `model-charts-c2.added.md`.
7. **`packages/cli/test/wiring.test.ts`'s pinned tool list gained `chart`.** That
   test exists to make a start-up change deliberate (`docs/feat/context-reset-refresh.md`);
   the addition is the intended one and carries its own comment there.

**Not in C2** (later slices): the TUI renderer and its `chart` theme tokens (C3),
the row branch / cut exemption / expand / `tui.chartGlyphs` (C4),
`apps/mobile/src/chart-{layout,scrub}.ts` (C5), `react-native-svg` + `ChartView` +
the transcript branch (C6), full screen / scrub / table / a11y / haptics (C7), the
gallery and the artifact sink (C8).

**Gate.** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bun run lint` clean (0 errors, 0 warnings — the §6 baseline) · `bun test`
**12 623 pass, 5 skip, 0 fail** (12 628 tests, 904 files, 455 s) — the 5 skips are
exactly the three opt-in groups of §6 (2 live-docker, 2 live-k8s, 1 real-socket
slow), so no new fail and no non-opt-in skip · no schema changed, so
`packages/protocol/schema/protocol.json` needed no regeneration · one fragment
(`changelog.d/model-charts.added.md`, extended; `CHANGELOG.md` untouched, its
`[Unreleased]` empty) · `TODO.md` untouched.

```sh
$ bunx tsc --noEmit                      # (no output)
$ bunx tsc -p apps/mobile --noEmit       # (no output)
$ bun run lint
Checked 1737 files in 510ms. No fixes applied.
$ bun test
 12623 pass · 5 skip · 0 fail · 13 snapshots, 98283 expect() calls
 Ran 12628 tests across 904 files. [454.98s]
```

**One pre-existing flake, NOT this change.** An earlier full run hit
`packages/exec/test/confinement.test.ts` ("R2-4: a hard-linked file INSIDE the root
is writable again", `packages/exec/test/confinement.test.ts:471`). It is not
reachable from here: `git diff <base> -- packages/exec` is empty and `packages/exec`
imports nothing this slice added. Measured, under 10 CPU hogs, 25 runs each:
**branch 0/25, pristine `main` (`main-ro` worktree) 2/25** — it flakes on `main`
too, and it is a timing assumption in that fixture (`link` + replace-rename under
load), for its own task. Recorded, not fixed here (AGENTS §0: a different defect).

**Unverified in this slice** (C3's job, named so it is not mistaken for done): that
an actual terminal DRAWS anything from these arguments — there is no renderer yet,
so a `chart` row today shows its label and title and, on an old client, the result
text. Whether the braille/blocks/bar renderers fit the frame at every width is
C3's and C4's, with `ink-testing-library` frames.

### Fix round 1

*— claude-opus-5-5, 2026-11-16*

**Nothing to fix: review round 1 produced no findings.** The reviewer's session
died on the quota limit before writing any verdict (evidence in *Review round 1*
below). So this round made **no code change** — fabricating fixes against a
review that never happened would be worse than none (AGENTS §9: prove the exact
property; there is no property named to prove).

Steps, in order:

1. Read `docs/EXECUTOR-BRIEF.md`, AGENTS §9, this doc, and located the expected
   input — the **latest Review round**. `## Review` was still the placeholder
   `*(empty — mandatory fresh-context review after C8)*`, and no
   `docs(model-charts): review round 1` commit exists on the branch.
2. Traced the orchestrator's artifacts to explain the absence rather than assume
   it: `runs/night-model-charts-review1.json` = `Error: Session ID … already in
   use` (no `.result`); `runs/night-model-charts.log` = `14:31 opus new on condo
   done:` with an **empty** result; the `condo` transcript's last record is the
   limit message. Recorded as *Review round 1* below.
3. Re-ran the checks the dead reviewer had already run, so the branch's state is
   independently confirmed rather than inherited (below).
4. Bounded adversarial pass to hand the next reviewer a lead instead of a blank
   page. Two probe results investigated to a verdict:
   - `niceTicks(0,0)` returning empty ticks was **my** error (a missing required
     `maxTicks`); with it, `niceTicks(0,0,5)` → `[-1,…,1]`, and `5,5` → `[4.5,5.5]`.
     Matches D4. **Not a defect.**
   - `scatter`/`{x,y}` `line` accept an all-`null` y (`"1 series × 1 · y no
     values"`) while the numeric `data` form refuses it. The plan's own table row
     "Empty / all-null → error (T1.3)" does not scope this to the numeric form, so
     this is a **candidate MEDIUM** — left for the real review to rule on, not
     silently "fixed" here (it is unpinned by any T1.3 case for points, and the
     validation change belongs with a red test that names the intended scope).
     Repro: `.tentacle/tmp/model-charts/allnull.ts`.

**No mutations are pasted because no fix was made** — there is no fix to mutate
(§9's non-vacuity rule applies to a change; there is none). The mutations already
recorded for C1 and C2 above remain the evidence for those slices.

**Gate** (run on this branch, this round, full suite — not the narrow files):

```sh
$ bunx tsc --noEmit     # TSC_EXIT=0
$ bun run lint          # Checked 1751 files in 516ms. No fixes applied.
$ bun test              # 12718 pass · 5 skip · 0 fail — Ran 12723 tests across 910 files. [461.94s]
```

The 5 skips are §6's three opt-in groups (`TENTACLE_K8S_SERVER`,
`TENTACLE_DOCKER_TESTS=1`, `TENTACLE_SLOW_TESTS=1`), not failures. The counts are
higher than C2's recorded `12623` because `main` was merged in at `5dcdfffa`.

**Unverified / owed:** a genuine fresh-context C1+C2 adversarial review. This
round cannot stand in for it.

### C4 — TUI wiring: row branch, cut exemption, expand, `tui.chartGlyphs` (slice C4 of 8)

*— claude-sonnet-4-5, 2026-12-06*

**Load-bearing check re-run FIRST (P3), and it held — then failed where the
slice needs it.** A repro on the branch (`.tentacle/tmp/model-charts/c4-repro.ts`,
output below) shows the three preconditions the slice stands on: the `chart` row
took the generic `plainToolBody` path, the generic cut applied to it, and
`tui.chartGlyphs` did not exist in the config schema (`strict()` refused it).
That is exactly the gap the slice closes; nothing in the plan contradicted the
code, so no plan edit was needed.

```sh
$ bun run .tentacle/tmp/model-charts/c4-repro.ts     # BEFORE
chart row body rows: 2
|● Chart Ricavi mensili 2025 vs 2026
|⎿ line chart: 2 series
renders a chart (braille/block glyphs): false
cut applied (has a "more lines" marker): true
tui.chartGlyphs accepted by the schema: false
  → Unrecognized key(s) in object: 'chartGlyphs'
```

As-built, in dependency order:

1. **`packages/tui/src/chart-lines.ts`** — new pure `chartToolBody(args, options)`:
   `JSON.parse` then `validateChartSpec` (the SAME shared caps as the daemon),
   `chartLines` on success, `undefined` on anything else. The client re-validates
   on every draw, so a pod's forgery or a spec a newer daemon wrote above this
   build's caps draws nothing rather than crashing or printing an error into the
   transcript (AGENTS §7 "a pod is not trusted"; T4.3).
2. **`packages/tui/src/render-lines.ts`** — the row branch in `toolLines`
   (`:735`): a `chart` call that resolves returns the chart rows INSTEAD of the
   header + connector + body, so the chart takes the row's place and is
   structurally exempt from `collapsedBody` (the exemption is not a second flag —
   there is no generic body left to cut). Per-item memo keyed on
   `width|expanded|glyphs` (`chartCache`), because the layout runs on every blink
   tick. Expand uses the existing `expandAll || isExpanded(expandedIds, id)`, so
   Ctrl+O and a header click both work with no new machinery — the chart's
   caption is row 0, which is already the header row `tool-hit.ts` toggles.
   `RenderOptions.chartGlyphs` added.
3. **`packages/config`** — `tui.chartGlyphs: "braille" | "blocks"` in
   `schema.ts` (beside `theme`, same `.strict()` object), the registry entry in
   `key-docs.ts` (leaf, enum, `carried: "no"`, default `braille`), the commented
   scaffold in `defaults.ts`, and `resolve.ts`'s `tui` type widened. `README.md`'s
   generated table refreshed with `bun run docs:config`.
4. **Plumbing** — `AppProps.chartGlyphs` → the App's four `RenderOptions` sites
   (the resize warm, the committing layout, `layoutOptsRef`, the idle warm; all
   four were needed — the resize-warm opts feed the cache the committing render
   then hits); `TuiOptions.chartGlyphs` → the App mount; `main.ts` ×2 from
   `config.tui?.chartGlyphs ?? "braille"`; `connect.ts` ×1 from its own
   `connectChartGlyphs` file reader (same rule as `connectTheme`: never block a
   connection on a broken file). `ChartGlyphs` exported from `@tentacle/tui`.

**Drift from the Implementation: two, both small and deliberate.**

- **The chart keeps NO header row at all.** The plan's D5 says "compact = mini
  plot + legend + axes (≈ 11 rows)" and lists expansion as "Ctrl+O, or a click on
  the chart's header", which reads as if a `● Chart <title>` row survives. The
  binding owner requirement (*Owner requirements*, ``:899``) says the opposite —
  "it does NOT render as a tool row (\"● Chart …\"): the chart itself takes the
  row's place, with at most a discreet caption". I followed the owner
  requirement: `chartLines`' own caption row (the title) is the block's row 0, so
  a click still lands on a header. The mockups' `● Chart …` rows predate that
  requirement.
- **The `chart` name is a local `const CHART_TOOL = "chart"` in `render-lines.ts`,
  not an import of `@tentacle/tools`' `CHART_TOOL_NAME`.** The TUI package does
  not depend on the tools package (that is why `toolSubtitle`'s `case "chart"`
  already spells the name out); the name is wire data anyway.

**Red before green (§9), each shown failing on the pre-change code and reverted
after.** Results pasted:

```
# Mutation 1 — drop the `chartRow` branch from `toolLines` (render-lines.ts)
(fail) a chart in the transcript (C4) > the row IS the chart: no tool chrome, and the title is its caption
(fail) a chart in the transcript (C4) > the chart body is exempt from the generic cut
(fail) a chart in the transcript (C4) > ctrl+o expands it (more rows, per-series stats and the data table)
(fail) a chart in the transcript (C4) > `tui.chartGlyphs: blocks` draws quadrant blocks, never braille
 111 pass · 4 fail

# …the same mutation, the App-frame suite (T4.1/T4.2/T4.3/T4.4)
(fail) live: the chart draws in place of the tool row
(fail) after a resume: the same chart, from the stored arguments
(fail) ctrl+o expands it, and a second ctrl+o collapses it again
(fail) `chartGlyphs: blocks` reaches the renderer through the App
(fail) a resize re-lays the chart out at the new width (form changes tier)
(fail) nothing is written to process.stdout while a chart draws (AGENTS §7)
 1 pass · 6 fail

# Mutation 2 — ignore `opts.chartGlyphs` (hard-code `braille`)
(fail) a chart in the transcript (C4) > `tui.chartGlyphs: blocks` draws quadrant blocks, never braille
 114 pass · 1 fail

# Mutation 3 — drop `chartGlyphs` from the App's committing layout options
(fail) a chart in the App (C4/T4) > `chartGlyphs: blocks` reaches the renderer through the App
 6 pass · 1 fail

# Mutation 4 — `chartToolBody` without `validateChartSpec` (a bare try/catch)
(fail) a chart in the transcript (C4) > an invalid (forged) spec falls back to the generic row, never a crash
(fail) a chart in the transcript (C4) > a spec valid on the daemon but over THIS build's caps also falls back
 113 pass · 2 fail

# Mutation 5 — a fixed width passed to `chartToolBody` (the resize property)
(fail) a chart in the App (C4/T4) > a resize re-lays the chart out at the new width (form changes tier)
 0 pass · 1 fail

# Mutation 6 — a direct `process.stdout.write` inside `chartToolBody`
(fail) a chart in the App (C4/T4) > nothing is written to process.stdout while a chart draws (AGENTS §7)
 0 pass · 1 fail

# Mutation 7 — remove `tui.chartGlyphs` from the config schema
(fail) tui.chartGlyphs > the two values are accepted in the file and in a profile; anything else is an error
(fail) tui.chartGlyphs > it sits beside `tui.theme` rather than replacing it
(fail) tui.chartGlyphs > a profile's value applies, and the scaffold shows the key
 1 pass · 3 fail

# Mutation 8 — `connectChartGlyphs` returns a constant `braille`
(fail) connectChartGlyphs > `tui.chartGlyphs: blocks` is read
 3 pass · 1 fail
```

**Tests added.** `packages/tui/test/render-lines.test.ts` — 11 cases (the row is
the chart; the cut is exempt; Ctrl+O expands; `expandedIds` expands; `blocks`
glyphs; four invalid/forged specs fall back; an over-cap spec falls back; a
running/queued chart keeps the generic row; every row fits the width at
120/100/80/60/50/40/30/20; another tool untouched). `packages/tui/test/app.test.tsx`
— 7 ink frames (live, after a resume, Ctrl+O both ways, `chartGlyphs` through the
App, resize 100 → 50 → 100 across the form tiers, a forged spec, the stdout spy).
`packages/config/test/tui-chart-glyphs.test.ts` — 4. `packages/cli/test/connect-chart-glyphs.test.ts`
— 4.

**Two properties I nearly asserted weakly, and fixed (§2).** The resize test
first compared only the widest plot row, which mutation 5 did NOT kill (the
frame stayed 100 wide because `chartLines` caps and centres at `CHART_MAX_WIDTH`
= 120); it now asserts the FORM TIER changes (`┤` plot at 100 cols → sparkline
rows `▁` and no `┤` at 50 → back), which is the property the slice hinges on. The
stdout spy was also shown non-vacuous (mutation 6).

**One pinned list changed on purpose:** `packages/config/test/key-docs.test.ts`'s
"defaults `resolveConfig` does not apply" now includes `tui.chartGlyphs`, exactly
as it includes `tui.theme` — the TUI applies `braille` at launch, not
`resolveConfig` (its test was updated with a comment saying so).

**One fragment, not two:** `changelog.d/model-charts.changed.md` (new). C1/C2
own `model-charts.added.md`; two files cannot share a `<slug>.<category>`
(`scripts/changelog.ts`), and "charts now draw in the TUI" is a change to what
exists, not a new capability. `CHANGELOG.md` untouched; `[Unreleased]` empty.

**Unverified in this slice (named so it is not mistaken for done):**
the *visual quality* of those frames at a real terminal — the frames are pinned
in tests, but whether the braille plot reads well at 80 columns with a real font
(and whether `blocks` is enough on a braille-less font) is the owner's look, not
a test. C3's mockup comparison is still owed for the same reason.

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` clean (0 errors, 0
warnings — the §6 baseline; the two auto-fixable formatting/organizeImports
trips in my own new code were fixed with `biome check --write`) · no schema
changed on the wire, so `packages/protocol/schema/protocol.json` needed no
regeneration (a config-file key is not a protocol schema) · the full suite
**12 989 pass / 5 skip / 0 fail**, the 5 skips being exactly §6's three opt-in
groups (2 live-docker, 2 live-k8s, 1 real-socket slow):

```sh
$ bunx tsc --noEmit
(no output)

$ bun run lint
Checked 1779 files in 529ms. No fixes applied.

$ bun test
 12989 pass
 5 skip
 0 fail
 33 snapshots, 101507 expect() calls
Ran 12994 tests across 923 files. [446.09s]
```

### Fix round 1 — Review round 2's two MEDIUMs (C1)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-16*

*(Two headings carry this name: the one above the C4 section, which had no
findings, and this one — the round that actually fixed something. Review rounds
3 and 4 restated round 2's two findings because no fix had run in between; their
verdicts are recorded under *Review* below.)*

**The findings picked up** are the ones in *Review round 2* (`spec.ts:607` and
`spec.ts:571-606`), repeated unchanged in rounds 3 and 4. Reproduced first, on
HEAD, before any edit — `.tentacle/tmp/model-charts/probe-round2.ts`:

```
1 scatter all-null y: ACCEPTED
2a pie points: ACCEPTED
2b bar points 900: ACCEPTED
2c stacked area misaligned x: ACCEPTED
ok line number-x points: ACCEPTED
ok line date-x points: ACCEPTED
ok scatter with points: ACCEPTED
ok scatter with a gap: ACCEPTED
```

Until the fix, all four hostile shapes were accepted (the four `ok` lines are the
legitimate forms, which must stay accepted); after it, all four are refused and
all four legitimate forms still pass.

**1. An all-`null` `{x,y}` series is refused (was a silent empty chart).**
`readNumbers` had the all-null check, `readPoints` did not, so a scatter whose
points all carry `y: null` validated, the tool reported `1 series × 1 · y no
values`, and nothing was drawn. `readPoints` now ends with the same check
(`spec.ts:646-649`) and the same sentence, `datasets[0].data has no values (all
null)`, so the model gets one message in either data form. A *gap* inside a
point series (some `y: null`) stays valid — the check is `every`.

**2. The point form is scoped to where its own x means something.**
`{x,y}` points carry their x, so they are only meaningful where x is a number:
the old `readData` accepted them for any type, and every count computed off
`labels` then silently saw nothing. Four consequences, one guard each:

- `readData` refuses points for `pie`/`doughnut` (`spec.ts:539-543`) — a slice
  is named by a label, and the shape had slipped past `checkPie` too.
- `readData` refuses points when the chart is not a `scatter` and `x.type` is
  `category` (`spec.ts:547-552`), with the fix in the sentence (`add x: {"type":
  "number"} (or "date")`) — and only for a *known* type, so an unknown `type`
  keeps the single, useful error it deserves. Refusing the *shape* is the fix
  for the finding review round 2 raised as "a bar with points and no labels",
  rather than bolting the category cap onto a chart whose axis cannot place the
  points.
- The 60-category bar cap now counts the point form's values when the axis *is*
  numeric (`spec.ts:768-778`): `datasets[0].data has 61 points (max 60
  categories for a bar chart) — …`, since those x positions never pass through
  `labels`.
- A `stacked` chart whose series sit on different x is refused
  (`checkAligned`, `spec.ts:913-928`): stacking sums one column at a time, so
  misaligned series stack into a lie. The plain-values form is aligned by
  construction and is untouched.

**Drift from the Implementation (and why).** Two, both narrowing:

1. The plan's `datasets[].data` row said only "`{x,y}` points for scatter and
   number/date x". It did not say what to do when a model writes them anyway,
   and it did not say the stacked form needs aligned x. Both rows are now
   written out (spec table + failure-mode table, *Design*), because an error
   message the plan does not name is a plan gap, not a free choice.
2. Fixing this exposed a pre-existing second message: `forms` was derived from
   the *validated* datasets, so a dataset that failed to parse made the chart
   look like the values form and `needsLabels` then demanded labels
   (`labels is missing — line charts need one label per value…`) on a pie. A
   pie with a string value got two errors, one of them misleading. `forms` is
   now read from the RAW arguments (`rawForms`, `spec.ts:821-828`), so the
   complaint describes what the model wrote. This is the fix review round 2's
   finding 2 implies (one honest sentence per mistake) rather than new scope.

The model-facing `CHART_JSON_SCHEMA` description of `datasets[].data` states the
new scope too (`json-schema.ts:66-67`), so a model reading the schema does not
have to hit the error to learn it. That guard also refuses to add the axis
sentence when `type` is unknown or missing (`spec.ts:547`): an unknown type is
already an error, and telling the model to fix the x axis of a chart that
cannot be drawn is a second, misleading job.

**Tests (red first).** Both files were run before the fix and failed on the
assertion of the property, not on a compile error:

- `packages/core/test/chart-spec.test.ts` T1.3 — `all null in the point form
  too` + `…but one real value among the gaps is still valid`.
- the new T1.13 — pie/doughnut points, a bar with points and a category x, the
  numeric-x bar cap at 60/61, the stacked alignment pair, an unknown type not
  being double-charged for a missing axis, and a block asserting the legitimate
  forms (line number-x, line date-x, scatter, a gap) still pass.
- `packages/core/test/chart-helpers.test.ts` — the schema description pins its
  three claims, so the model-facing text cannot drift back.

Red, before any code change (5 fail / 48 pass):

```
(fail) T1.3 shape > all null in the point form too (Review round 2, finding 1)
(fail) T1.13 … > pie and doughnut take slices from labels, never points
(fail) T1.13 … > a bar with points and no x type is refused (the category cap cannot see them)
(fail) T1.13 … > …and with a number x, the 60-category cap counts the points
(fail) T1.13 … > a stacked chart needs every series on the same x
```

**Mutations (§9 non-vacuity — each applied, run, reverted).**

```
### MUTATION 1 (finding 1): drop the all-null check in readPoints
(fail) T1.3 shape > all null in the point form too (Review round 2, finding 1)
 52 pass   1 fail

### MUTATION 2 (finding 2a/2b): both readData point-form scope guards disabled
(fail) T1.13 … > pie and doughnut take slices from labels, never points
(fail) T1.13 … > a bar with points and no x type is refused (the category cap cannot see them)
 51 pass   2 fail

### MUTATION 3 (finding 2b, cap): bar point-form category count removed
(fail) T1.13 … > …and with a number x, the 60-category cap counts the points
 52 pass   1 fail

### MUTATION 4 (finding 2c): stacked x-alignment check removed
(fail) T1.13 … > a stacked chart needs every series on the same x
 52 pass   1 fail

### MUTATION 5 (drift 2): rawForms forced to "values"
(fail) T1.13 … > a stacked chart needs every series on the same x
(fail) T1.13 … > the legitimate point forms still pass
 48 pass   5 fail

### MUTATION 6 (schema): the data description back to HEAD's wording
(fail) CHART_JSON_SCHEMA > the data description states the point form's scope
 12 pass   1 fail

### MUTATION 7 (the `type !== null` guard): an unknown type double-charged
(fail) T1.13 … > an unknown type is not double-charged for the axis it never had
 53 pass   1 fail
```

Every revert left the narrow file green again (54 pass / 0 fail;
`chart-helpers` 13 pass / 0 fail).

**Gate** (this branch, this round; the whole suite was run once, at the end):

```sh
$ bunx tsc --noEmit
(no output)          # TSC_EXIT=0

$ bun run lint
Checked 1779 files in 530ms. No fixes applied.

$ bun test
 12998 pass
 5 skip
 0 fail
 33 snapshots, 101463 expect() calls
Ran 13003 tests across 923 files. [442.38s]
```

The 5 skips are §6's three opt-in groups (2 live-docker, 2 live-k8s, 1
real-socket slow), not failures. The 9 new tests are the count's increase over
the 12 989 C4 recorded, and the suite was run on the final tree (after the
mutation-7 guard and its test).

**Not done here, deliberately.** No wire change (no method, no update, no
field), so no `protocol.d/` note and no `PROTOCOL_VERSION` move; no new
user-visible behaviour beyond a refused invalid spec, so `changelog.d/` is
unchanged (C4's two fragments stand). Review round 2's non-blocking LOW
(`chartArgumentsHint` matching `Infinity` inside a title string) is untouched —
it is LOW and costs one misleading sentence on an already-failed parse.

### Fix round 2

*— claude-opus-5-5, 2026-11-16*

One finding, from **Review round 2 (`Round 2`)** — its single MEDIUM (2b, half
fixed in Fix round 1). No other HIGH/MEDIUM was open on C1+C2: the review above
it (`Review round 2 — C1+C2 (fresh context)`) is an APPROVE with one non-blocking
LOW, which stays untouched (last paragraph of the previous section).

**Repro (RED, on the fix-round-1 code).** `.tentacle/tmp/model-charts/r3-cap.ts`:

```
A short-then-long: true [ 10, 200 ]
B disjoint x: true ok
C control: false datasets[0].data has 200 points (max 60 categories for a bar chart) — …
```

Two series, the long one second (A) and two 60-point series on disjoint x (B),
both `ok: true` — the cap reads `datasets[0].data.length` only, so a short first
series buys the rest an exemption. C is the same spec with one series: correctly
refused, which is what made the gap invisible.

**Root cause (one sentence).** `spec.ts` counted the point-form bar cap from one
dataset, while the renderer (`chart-lines.ts` `hbars`/`categories`) draws one
column per distinct x across the series that are present.

**Fix (`packages/core/src/chart/spec.ts`).**

- `distinctX(datasets)` beside `isPointForm` (`spec.ts:917`): the `Set` of
  `String(x)` across every point-form dataset — the column count the cap is
  about.
- The cap block (`spec.ts:766-784`) is now `if (type === "bar" && datasets)` and counts
  `distinctX` in the point form. Three messages, by shape: `labels` (unchanged
  text), one series (unchanged text — `datasets[0].data has 61 points …`), and
  NEW for several series: `datasets have 120 distinct x values (max 60
  categories for a bar chart) — fold the smallest into "Other" or use a line
  chart`. The `labels` sentence is byte-identical to before, deliberately: it is
  the owner-approved text and is pinned by T1.12.
- Doc: the *Design* error table row now names the several-series sentence and
  says the count is the distinct x across every series.

**Test (RED first, at the property).** `chart-spec.test.ts`, in T1.13: "…and the
cap counts every series' x, not only the first one's" — 10-then-200 must be
refused with the new sentence (line 283), 60+60 disjoint refused (line 287), and
60+60 *sharing* x still **accepted** (the guard must not reject a legitimate
multi-series bar). Red on the old code at `:283` — `expected the spec to be
refused, it was accepted`, not a compile error. Green after.

**Mutations (each reverted; tree clean after).**

```
# M1 — distinctX back to datasets[0].data.length
(fail) … the cap counts every series' x, not only the first one's   line 283
 54 pass / 1 fail

# M2 — distinctX = max length (counts A but not disjoint x)
(fail) … the cap counts every series' x, not only the first one's   line 287
 54 pass / 1 fail
```

M2 is the one that matters: it is the plausible near-miss the finding itself
offered ("the distinct x across all datasets (or the max length)") and the test
fires on the second assertion, so the two halves are pinned independently.

**Gate.** `bunx tsc --noEmit` green; `bun run lint` clean (1779 files);
`bun test` → 12999 pass, 0 fail, 5 skip (the 5 known opt-in live-infra skips:
k8s ×2, docker ×2, slow-ws ×1), 13004 tests / 923 files.

**Drift.** None to the Design beyond the error-row addition above. One shape
choice: the cap reads all *point-form* datasets only (`distinctX` skips a values
form), which is right because `forms` mixing points and values is already
refused a few lines earlier.

**Not done, deliberately.** Review round 2's LOW (`chartArgumentsHint` matching
`Infinity` inside a title string, `tools/src/chart.ts:37`) stays open: it is LOW
and misleads only on an already-failed parse.

### C5 — phone pure layout + scrub machine (slice C5 of 8)

*— claude-opus-5-5, 2026-11-16*

**Load-bearing check re-run first.** The scratch repro `args-roundtrip.ts` no longer
resolves `zod` from `.tentacle/tmp/` (it sits outside the workspace), so I ran its
committed form, T2.0: `bun test packages/client/test/chart-args-roundtrip.test.ts`
→ `1 pass, 0 fail, 12 expect() calls`. It holds. `apps/mobile/src/chart-*` did not
exist before this slice.

**As built** (all pure and React-free; the owner's picks: line A, bar/stacked/area/donut
B, scatter A, scrub A; mono typography):
- `packages/core/src/chart/format.ts` — `formatParts(value, format) → {number, unit,
  unitBefore}` (rev 2 item 3). Joined back, it reads exactly as `formatNumber`.
- `apps/mobile/src/chart-geometry.ts` — `monotoneTangents`/`monotoneCubics`/`monotonePath`
  (Fritsch–Carlson + Brodlie), `curveLength` (sampled, for the draw-in), `runs` (null =
  break), `domain` (12 % pad / zero + 8 %), `guides` (≤ 3 nice), `barUp`/`barSide` (only
  the data end rounded, r clamped, ≤ 0,2 pt → no path, negatives round the far end),
  `rectPath`, `sector` (4 tangent corners, clamped corner radius, full ring for one
  slice), `dodge`, `leastSquares`.
- `apps/mobile/src/chart-hero.ts` — `heroOf(spec, at, locale)` with the item-3 rules
  (line/area vs series 1 or own first value; stacked total vs previous column; bars
  max + "il più alto di N", no delta; donut total; scatter slope per 10^⌊log10 xMax⌋
  with an `r²` chip, gated on ≥ 8 points and r² ≥ 0,5), `heroDelta` (▲/▼, no pill on
  ref 0), `xTexts`, it/en words.
- `apps/mobile/src/chart-layout-kit.ts` (view-model types, mono text measuring with
  CJK = 2 cells, `fitText`, `textBox`/`overlaps`), `chart-layout-axis.ts` (x positions,
  `pickXLabels`, `guideItems` with the collision drop, `labelsFit`, legend, summary,
  table), `chart-layout-shapes.ts` (bars B as rows ≤ 12 categories / columns above,
  stacked B, donut B, scatter A), `chart-layout.ts` (`chartSpecOf` — re-validation of
  the object or the raw JSON text; `chartLayout`; line A and area B; `hit`; `scrubAt`).
- `apps/mobile/src/chart-scrub.ts` — `reduceScrub`: 250 ms hold → scrub at the down
  point (`index` + `tick`); travel ≥ 10 pt before the hold → `yield` (the list
  scrolls); one `tick` per index change; up/cancel → `release`.
- Tests: `apps/mobile/test/chart-{scrub,geometry,hero,layout}.test.ts` (+ the shared
  `chart-fixtures.ts`) — 51 tests, T5.1–T5.15; `packages/core/test/chart-format-parts.test.ts`.

**Drift from the Implementation, and why.**
1. **Files.** Item 5 named two files; the layout is five (`chart-layout.ts` + `-kit`,
   `-axis`, `-shapes`, and `chart-geometry.ts`, `chart-hero.ts`) so no write is huge and
   there is no import cycle (shapes and line both need the axis helpers). Plus
   `formatParts` in core `format.ts`, which rev 2 item 3 asks for but no slice listed.
2. **No `scheme` and no `style` option.** `chartLayout(raw, {width, height?, fontScale?,
   locale?, hidden?, measure?})`. Colours come back as `Paint` = `{series: k}` or a theme
   token (`mutedLine`, `track`, `guide`, …); the component resolves them per mode (the
   tokens are C6's `theme.ts`). The `style` switch is gone, as rev 2 said.
3. **The donut test reads "within 1 %" as 1 percentage point of the ring, after adding
   back each slice's pad strip.** Relative 1 % cannot hold: the 4 corner arcs cost
   ~5 pt² per slice, about 5 % of a 2,3 % slice. Measured with an independent SVG-path
   flattener plus the shoelace formula.
4. **A slice thinner than its gap keeps half its angle** (`pad = min(gap pad, sweep/4)`).
   Without this, a 0,5 % slice is swallowed by its 2,5 pt gap, and T5.13 asks that it
   survive.
5. **Stacked gap 1,5 pt, radius 3** (the picked B mockup), not item 5's generic 2 pt.
6. **No scrub on bar rows, donut or scatter** (`hit` → `null`; the machine then never
   enters). Columns and stacked scrub by column; line and area by x.
7. **Words.** `summary` reuses core `summarizeChart`, whose words are English ("min",
   "max", "from … to"). Only the numbers follow the locale. Italian words would be a
   core change for C7/a11y.
8. **Red before green was not followed in order.** I wrote the modules first and the
   tests after. Every test was then shown failing on the property it pins, by the
   mutations below (22/22 killed).

**Mutations** (scratch `c5-mut.ts`: apply, run the named test file, restore; `git
status` afterwards showed only this slice's files):
```
KILLED   T5.8 Catmull-Rom tangents — 1 fail
KILLED   T5.13 round caps (corner unclamped, pad unshrunk) — 1 fail
KILLED   T5.12 stacked gap not subtracted — 1 fail
KILLED   T5.12 r unclamped — 1 fail
KILLED   T5.9 guides allow 4 — 1 fail
KILLED   T5.9 collision drop disabled — 1 fail
KILLED   T5.10 delta vs series 0's first, not series 1 — 3 fail
KILLED   T5.10 ref = 0 not guarded — 1 fail
KILLED   T5.10 scatter gate removed — 1 fail
KILLED   T5.2 hit without clamp (null outside the plot) — 1 fail
KILLED   T5.3 x labels not thinned — 4 fail
KILLED   T5.4 colour by visible position — 1 fail
KILLED   T5.4 hidden series still in the domain — 1 fail
KILLED   T5.5 no re-validation — 1 fail
KILLED   T5.6 no yield on an early pan — 1 fail
KILLED   T5.6 tick on a repeated index — 1 fail
KILLED   T5.7 summary ignores the locale — 1 fail
KILLED   T5.11 dodge disabled — 1 fail
KILLED   T5.11 no legend fallback — 1 fail
KILLED   T5.14 scrub hero at rest — 1 fail
KILLED   T5.15 emoji triangle — 3 fail
KILLED   formatParts unit side ignored — 2 fail
```

**Gate.**
- `bun run lint`: clean (1813 files).
- `bunx tsc --noEmit`: one error, `packages/tools/src/pdf/pdf-worker.ts(22,38)` cannot
  find `pdfjs-dist`. That is not this diff: `pdfjs-dist` 6.5.438 is declared in
  `packages/tools/package.json` but not installed in this worktree; it arrived with
  the `main` merge.
- `tsc -p apps/mobile` and `tsc -p apps/relay`: clean.
- `bun test` (once): `13182 pass, 5 skip, 31 fail`. Narrow re-runs put the fails in
  `packages/tools`, `packages/daemon` and `packages/cli`: the PDF tests ("Cannot find
  module 'pdfjs-dist/legacy/build/pdf.worker.mjs'"), the two compiled-binary marker
  tests, and one `fs_read` sniff test. None is in a package this slice touched.
  `bun test apps/mobile packages/core` → `2914 pass, 0 fail`.
- **Unverified:** whether those 31 pass with `pdfjs-dist` installed. To check: run
  `bun install` in the worktree, then the full `bun test`.

**Changelog.** No fragment for C5. Nothing is drawn on the phone until C6 wires
`ChartView`, so there is no user-visible change, and internal work adds none (AGENTS
§10). `changelog.d/model-charts.added.md` and `.changed.md` already exist, one bullet
each; the phone bullet belongs to C6/C8.

**C5: DONE** (T5 green; pixels are C6's).

### C6 — `react-native-svg` + `ChartView` + transcript branch (slice C6 of 8)

*— claude-opus-5-5, 2026-11-16*

**Load-bearing check re-run first.** `bun test packages/client/test/chart-args-roundtrip.test.ts`
→ `1 pass, 0 fail, 12 expect() calls`. It holds.

**As built** (dependency order):
1. `apps/mobile/package.json`: `react-native-svg` `15.16.0`, exact — the version Expo 58
   pins (`node_modules/expo/bundledNativeModules.json:115`); `bun.lock` updated.
2. `apps/mobile/src/theme.ts`: `ChartTokens` + `chartTokensFor(palette)` — the mockup's
   chrome per mode (`modern-manifest.json`: `guide`, `guideStrong`, `track`, `mutedBar`,
   `mutedLine`, `seriesSoft`) plus the app's own `label`/`sec`, `page` as the dot-ring
   surface, and `green`/`red` for the hero pill.
3. `apps/mobile/src/chart-row.ts` (new, pure): `chartRowSpec` (name `chart`, status not
   `error`/`denied`, spec re-validated by `chartSpecOf`), `chartRowView` (layout at a
   width, with a 32-entry cache keyed by width + fontScale + locale + args, because a row
   re-renders on every transcript update), `chartScheme`, `paintColor`, `textColor`.
4. `apps/mobile/src/ui/chart/ChartView.tsx` (new, render only, hook-free): title (+
   subtitle), the mono hero (`fontVariant: tabular-nums`) with the delta pill / chip
   and the context line, then `<Svg>`: `LinearGradient` defs (one per series), guides
   (`Line`, dotted `1 3` / solid), paths (stroked when the layout gives `strokeWidth`,
   else filled), dots (halo, surface ring, hollow), mono `SvgText`; legend row when the
   layout falls back to one. No card, no frame `Rect`. The root is ONE accessibility
   element whose label is `layout.summary`.
5. `apps/mobile/src/screens/transcript/TranscriptRow.tsx`: `case "tool"` → `ChartRowView`
   when the name is `chart`; it lays out at `useWindowDimensions().width − 2 × space.inset`
   with the device's `fontScale` and locale, and falls back to `ToolRowView` when
   `chartRowView` is `null`. The chart takes the row's place: no `ToolRow` header (owner
   requirement, 2026-11-16 ~11:20). testID `chart-<callId>`.
6. E2E: `e2e/mock-model.ts` `CHART31` → one streamed `chart` call (`CHART_SPEC`);
   `e2e/flows/31-chart-inline.yaml` (send → `chart-mocked-.*` visible, no `tool-mocked-.*`;
   cold relaunch → reopen → still visible, i.e. rebuilt from history); registered in
   `e2e/run.ts` (`FLOWS`, `CHART_ID` session).
7. Tests: `test/chart-row.test.ts` (11), `test/chart-view.test.ts` (10, a mocked
   `react-native-svg` with string host stubs + the transcript dispatch),
   `test/e2e-mock-chart.test.ts` (2, through the real `OpenAIProvider` stream).

**Drift from the Implementation, and why.**
1. **The appear animation is NOT in C6.** Rev 2 item 8 describes it in `ChartView`, but
   its tests (Reduce Motion → opacity only; a history row does not animate) are T7, so
   it goes with C7. C6 draws still.
2. **`ChartView` is hook-free; the hooks live in `ChartRowView`** (`TranscriptRow.tsx`),
   so the render test can walk it with no renderer (the `band-notes.test.ts` pattern).
3. **A failed or refused `chart` call keeps the generic tool row**, even with a valid
   spec: its error/denial text is what the person needs to see. Not in the plan.
4. **Width from `useWindowDimensions`, not `onLayout`:** the row is full width minus the
   inset, so the window width is exact, and a rotation re-lays out with no extra frame.
5. **`header-wiring.test.ts` (mobile-chrome Design 2) pinned "no `react-native-svg` in
   `package.json`"** as a proxy for "the context ring is plain Views". The approved plan
   (Q8) adds the package, so that one line is dropped; the ring-level asserts (no
   `react-native-svg` import in `ContextRing`, geometry from the pure module) stay.
6. **`SF Pro Rounded` question (rev 2, "Unverified")**: moot, because the owner picked mono
   for the whole chart. For the record, RN 0.88 maps `ui-rounded` to
   `UIFontDescriptorSystemDesignRounded` (`RCTFontUtils.mm:381`), so no bundling would be needed.
7. **Red before green:** every new test file failed first on its missing module (not on
   an assertion), so non-vacuity is shown by the mutations below (12/12 killed).
8. **`chart-view.test.ts`'s `react-native` mock is a superset of `band-notes.test.ts`'s**
   (`Switch` included). Bun keeps the first mock's export shape across files: without it
   the first full run failed `band-notes` with "Export named 'Switch' not found".

**Mutations** (scratch `c6-mut.ts`: apply, run the named file, restore; `git status`
afterwards showed only this slice's files):
```
KILLED   gradient fill dropped — 1 fail
KILLED   status gate dropped (failed call drawn) — 1 fail
KILLED   no re-validation in the row (forged drawn) — 1 fail
KILLED   dispatcher never branches — 2 fail
KILLED   svg text not mono — 1 fail
KILLED   paint ignores the mode — 1 fail
KILLED   cache key without width (stale layout) — 1 fail
KILLED   a card container — 1 fail
KILLED   stroked paths also filled — 1 fail
KILLED   width without the inset — 1 fail
KILLED   mock model: no CHART31 branch — 1 fail
KILLED   dark tokens = light — 1 fail
```

**Gate.**
- `bunx tsc --noEmit`, `tsc -p apps/mobile`, `tsc -p apps/relay`: clean.
- `bun run lint`: clean (1818 files).
- `bun test` (once): `13231 pass, 5 skip, 2 fail`. The 2 fails were this slice's (drift
  5 and 8). Both are fixed; `bun test apps/mobile` afterwards → `2361 pass, 0 fail`. The
  full suite was not re-run (budget: once). The 5 skips match C5's run.
- No schema change → `protocol.json` untouched; no `protocol.d/` note (no wire change, D7).

**Changelog.** One bullet per fragment, and `model-charts.added.md` / `.changed.md` already
exist, so the iPhone half went into the `.changed.md` bullet ("Charts now draw in the Mac
TUI and on the iPhone"). No third file.

**Unverified — pixels.** No dev build was made in this slice (a new native module needs
one; plan: batch with model-artifacts S8), so `31-chart-inline` has not run on a
simulator, and the look has not been compared with `modern.html`. To verify: build the
dev client with `react-native-svg`, then `bun apps/mobile/e2e/run.ts --only 31-chart-inline`.

**C6: PARTIAL** — code + unit T6 green and mutation-checked; T6's e2e flow is written but
not run (pixels unverified, as the slice table allows).

### C7 — full screen, scrub, table, a11y, haptics (slice C7 of 8)

*— claude-opus-5-5, 2026-11-17*

**Load-bearing check re-run first.** `bun test packages/client/test/chart-args-roundtrip.test.ts`
→ `1 pass, 0 fail, 12 expect() calls`. It holds.

**As built** (owner picks: scrub A, full screen B, table A; mono everywhere):
1. `apps/mobile/src/chart-interact.ts` (new, pure): `tableView` (table A: adds a Δ column,
   series 0 vs series 1, only for a two-series category chart that is not stacked or a
   pie), `chartCsv` + `csvCell` (RFC 4180, raw numbers, formula-looking text gets a
   leading `'`), `toggleSeries` (the last visible series stays on) + `seriesChips`,
   `fullScreenKpis` (B: last · mean · max of the first visible series; none for a donut
   or a point cloud), `chartA11yActions` / `chartA11yEffect` (activate → full screen,
   showTable / showChart), `chartMotion` + `appearPlan` (the item-8 descriptor as data:
   Reduce Motion → `{opacity}` only, history → still), `claimAppear` (once per call
   id, only when first seen `running`), `fullScreenPlotSize`, `scrubOutcome` and
   `createScrubDriver` (`reduceScrub` + the tap it does not model; the haptic is a
   port).
2. `apps/mobile/src/chart-row.ts`: `ChartRowView.spec`; options `height` and `hidden`,
   both in the cache key.
3. `ui/chart/ChartView.tsx` (still hook-free): split into `ChartHero`, `ChartPlot`
   (+ the scrub's rule, dots and a surface veil right of the finger) and the legend;
   new props `scrub`, `mode` (`table` → `ChartTable` in the plot's place), `onAction`
   (the root's `accessibilityActions`), `plotHandlers` (on the plot only), `wrapPlot`,
   `locale`.
4. `ui/chart/ChartTable.tsx` (new): the table, tabular mono figures.
5. `ui/chart/useChartScrub.ts` (new): responder → driver, one `HOLD_MS` timer,
   `playHaptic` as the port; termination refused only while scrubbing.
6. `ui/chart/ChartAppear.tsx` (new): one `Animated.View` from `appearPlan`; the plan is
   fixed once Reduce Motion is known (`null` until then: drawn at opacity 0 for that
   read).
7. `ui/chart/ChartFullScreen.tsx` (new): `ChartFullScreenView` (dumb: `Modal` with
   `supportedOrientations` portrait + landscape, `animationType` `none` under Reduce
   Motion, close, chips, `Tabella`, Share, KPI strip; while scrubbing the scrub hero
   replaces the strip) and `ChartFullScreen` (state + `Share.share` of the CSV).
8. `ui/chart/ChartBlock.tsx` (new): the inline state (mode, full screen, appear,
   scrub); the `Grafico | Tabella` segments sit OUTSIDE the one accessibility element,
   so Maestro and touch reach them (VoiceOver uses the action).
9. `TranscriptRow.tsx`: `ChartRowView` renders `ChartBlock` instead of `ChartView`.
10. E2E: `e2e/flows/32-chart-interact.yaml` (seg table → back; tap → full screen; KPI
    strip; chip 1 off; table; close), registered in `e2e/run.ts` (`FLOWS`,
    `CHART2_ID` session).
11. Tests: `test/chart-interact.test.ts` (27); `chart-view.test.ts` +9 (scrub, table,
    actions, gesture placement; full screen: landscape, Reduce Motion, handlers, hidden
    series, KPI vs scrub hero, table); `chart-row.test.ts` +1.

**Drift from the Implementation, and why.**
1. **No `haptic-rules.ts` / `haptics.ts` change.** The `"tick"` kind
   (`Haptics.selectionAsync`) already exists (mobile-hub), and the scrub machine
   already decides WHEN. The driver calls the port `play("tick")` → `playHaptic`.
2. **The line's draw-in is a left-to-right wipe of the plot** (one `Animated.View`
   whose width animates, JS-driven, 900 ms, the item-8 bezier), not a per-path
   `strokeDashoffset`. It keeps `ChartView` free of `Animated`, and on a line with
   monotone x it looks the same. The fills, dots and labels are revealed by the same
   wipe, not faded in after 550 ms. Bars and columns spring as ONE group from their
   base, so there is no 35–45 ms stagger. The donut pops (0.82 → 1 plus opacity).
   `LayoutPath.length` stays unused.
3. **A dim veil, not a `ClipPath`.** Scrub A's "curve right of the finger at 30 %" is a
   surface-coloured `Rect` at 0.7 opacity over `[dimFromX, plot.right]`. It also dims
   the guides there. The look is the same on the solid page background.
4. **A call that settles within one render batch draws still.** `claimAppear` animates
   only a row first seen `running`. A history row is `ok` (`transcript-history.ts:101`).
5. **Full screen never animates its plot, and has no in-modal VoiceOver actions.** Its
   chips, `Tabella` and Share are plain buttons; the plot is one element with the summary.
6. **Test harness.** `chart-view.test.ts`'s walker keeps the stateful components
   (`ChartBlock`, `ChartAppear`, `ChartFullScreen`) as named nodes. Calling hooks with no
   renderer would throw. The dispatch test now asserts the `ChartBlock` props and walks
   `ChartView` from them. Its `react-native` mock gained `AccessibilityInfo`, `Animated`,
   `Easing` and `Share`, plus a `react-native-safe-area-context` mock. Both files pass
   together in either order.
7. **Red before green:** the `ChartView` and `chart-row` tests were written first and
   failed on their assertions (4 and 1 fails). `chart-interact.ts` was written before
   its tests, so its non-vacuity rests on the mutations below.

**Mutations** (scratch `.tentacle/tmp/model-charts/c7-mut.ts`: apply, run the named file,
restore a byte copy; `git status` afterwards showed only this slice's files):
```
KILLED   Reduce Motion ignored — 2 fail
KILLED   history row animates — 1 fail
KILLED   tick on release too — 1 fail
KILLED   tap on every up — 2 fail
KILLED   last series can be hidden — 1 fail
KILLED   Δ reversed — 1 fail
KILLED   csv formula not neutralised — 1 fail
KILLED   a11y action unfiltered — 1 fail
KILLED   hero ignores scrub — 1 fail
KILLED   portrait only — 1 fail
KILLED   modal ignores Reduce Motion — 1 fail
KILLED   cache key without hidden — 1 fail   (survived at first; the test then pinned it)
12/12 killed
```

**Gate.**
- `bun run lint`: clean (1831 files).
- `bun run typecheck` (root + mobile + relay): clean.
- `bun test` (once): `13318 pass, 5 skip, 0 fail`. The 5 skips are the same as in C5's run.
- No schema change → `protocol.json` untouched; no `protocol.d/` note (no wire change).

**Changelog.** I extended the iPhone bullet in `changelog.d/model-charts.changed.md` with
scrub, table, full screen, Share and the appear animation. It is one bullet per fragment,
and that file already holds the iPhone half, so there is no new file.

**Unverified.**
- **P9 on device** (the modal really rotates to landscape) and the pixels. No dev build
  was made, so `32-chart-interact` (like `31`) has not run on a simulator.
- Whether a tap on the plot's centre reaches the responder under Maestro.
- How the scrub feels on a real touch, and whether a vertical flick hands over to the list.

To verify: build the dev client, then run `bun apps/mobile/e2e/run.ts --only 32-chart-interact`,
then rotate in full screen.

**C7: PARTIAL.** The code, the unit T7 (VoiceOver label = summary, the Reduce Motion prop
check, the haptic spy with one tick per category, toggles, table, full screen) are green and
mutation-checked. T7's e2e flow is written but has not run, and P9 has not been checked on a
device.

## Review
*(empty — mandatory fresh-context review after C8)*

### Review round 1 — DID NOT PRODUCE FINDINGS (C1+C2)

*— claude-opus-5-5, 2026-11-16*

The round-1 reviewer never reached a verdict: its session
(`64a7f815-fe75-4884-8fae-9b9205d8a5e2`, account `condo`) ended on
**"You've hit your 5-hour limit"** after 179 records, mid-probe. Evidence:

- `runs/night-model-charts-review1.json` contains only
  `Error: Session ID … is already in use` — no `.result`, no verdict.
- No `docker`/doc edit: this section is still the placeholder, and
  `git log main..HEAD` has **no** `docs(model-charts): review round 1` commit.
- The transcript's only assistant text is progress narration ("Running the
  touched tests, lint and typecheck now", "Checking how the round planner treats
  the chart tool's empty concurrency keys", "Fixing the probe's import path"),
  then the limit. **Zero** HIGH/MEDIUM statements anywhere in it.

What it *did* establish (reusable, so the next reviewer starts further ahead):
the C1+C2 test files, `bun run lint` and `bunx tsc --noEmit` are green (see
*Fix round 1*); its scratch probe is `.tentacle/tmp/model-charts/edge.ts`.

**Consequence:** fix round 1 had **no findings to fix**, so this round changed
**no code**. A real fresh-context C1+C2 review is still owed before the
`C1+C2` group can be called reviewed.

#### Owner choices — iPhone visual language rev 2 (2026-11-16 ~12:35, binding)

*— recorded by claude-opus-5-5 (orchestrator), 2026-11-16*

On `modern.html`: **1 A · 2 B · 3 B · 4 B · 5 B · 6 A · 7 A · 8 B · 9 A · 10 A** (line A; bar, stacked bar, area, donut B; scatter A; scrubbing A; full screen B; gallery A; table A). Owner: "in generale mi piace il font mono sui grafici" → chart typography (hero number, labels, axis ticks, callouts) is MONOSPACE in every section, also where direction A is chosen. iPhone sections 1–10 are now decided; the plan is fully approved.

### Review round 2 — C1+C2 (fresh context)

*— claude-opus-5-5, 2026-11-16*

**Verdict: APPROVE (C1+C2 only)** — no HIGH/MEDIUM findings. Scope: `git diff main...HEAD`, slices C1+C2.

- **Gate (narrow):** the 12 touched test files → 295 pass / 0 fail (12 611 expects); `bun run lint` clean (1774 files); `bun run typecheck` green (root + mobile + relay). Full `bun test` not re-run in this round.
- **Mutation 1** (`subagent.ts:402`, drop `CHART_TOOL_NAME` from the "never a child" filter) → `chart-wiring.test.ts` RED (1 fail). Reverted, tree clean.
- **Mutation 2** (`spec.ts:549`, accept `"12.5"` as a number — the plan's C1 mutation) → 8 RED in `chart-spec`/`chart-fuzz`. Reverted, tree clean.
- **Attacks tried:** (a) §7 single session path — `chart` adds no wire method/update; T2.0 drives the real `SessionHost`+`Connection`+`RemoteClient` and both frontends' rebuild functions: holds. (b) Args truncation on any client/persistence path — grep for `args/arguments/rawInput .slice`/truncate in `packages`/`apps` src: none; relay/device frame caps (8 MiB) far above the 64 KiB spec cap: holds. (c) Pod forgery (§7 "pod not trusted") — `permission: "none"`, no laptop-side effect, drawing re-validates (C4/C5): holds for C2. (d) Registry hint seam — a tool without `argumentsHint` keeps the byte-identical message (pinned): holds.
- **Low (not blocking):** `chartArgumentsHint` (`tools/src/chart.ts:37`) matches `NaN|Infinity|undefined` anywhere in the raw text, including inside a string (a title "Infinity War" with an unrelated syntax error gets the NaN hint). Cost: one misleading sentence on an already-failed parse.
- **Not verified here:** T2.0 rebuilds rows from the daemon's history, not from a laptop `<uid>.jsonl` reload; T2.3 deferred to C8 (recorded drift).
- **Reviewer = same model family as the executor's orchestrator** (fresh context only): shared blind spots possible.

### Review rounds 2–4 in `runs/` (REQUEST-CHANGES — the findings fixed above)

*— recorded by rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (executor), 2026-11-16*

These are a *different* review from the section above: the orchestrator's
`runs/night-model-charts-review{2,3,4}.json` (one session,
`64a7f815-…`, account `condo`), each reviewing C1's validator at the C1/C2
scope. All three returned **REQUEST-CHANGES**; none of them committed its
section to this doc, so their verdicts are recorded here from the run files.

Round 2's two findings (MEDIUM):

1. `spec.ts:607` — `readPoints` has no all-`null` check (`readNumbers` has one at
   `:564`, pre-fix). A scatter whose points all carry `y: null` passes, the tool
   reports success (`"1 series × 1 · y no values"`), and nothing is drawn. The
   plan says an all-`null` series is an error.
2. `spec.ts:571-606` — `{x,y}` points are accepted for any chart type, but the
   plan allows them only for scatter and number/date x. Pie with no labels, a
   900-point category bar that skips the 60-category cap, and stacked areas whose
   series sit on different x all pass. The client re-runs this same check, so a
   forged spec in these shapes would reach the renderers too.

Rounds 3 and 4 restated both verbatim and added that the loop had reviewed only
review commits in between. All four hostile shapes still reproduced on HEAD
before *Fix round 1* below, which is the round that answers them.

### Round 2

*— claude-opus-5-5, 2026-11-16*

**Verdict: REQUEST-CHANGES** — one MEDIUM. Scope: `git diff HEAD~1` (c84c4301, fix of the two C1 MEDIUMs).

- **Gate:** `chart-spec`/`chart-helpers`/`chart-fuzz` + `packages/tools` + `packages/tui/test` → 2924 pass / 0 fail; `bun run typecheck` green; `bun run lint` clean (1779 files).
- **Mutations (each reverted, tree clean after):** M1 drop the `readPoints` all-null check → RED (T1.3 point form). M2 pie/doughnut guard off → RED (T1.13 pie). M3 category-x guard off → RED (T1.13 bar no x type). M4 point-form bar cap reverted to labels-only → RED (T1.13 cap). M5 `checkAligned` never called → RED (T1.13 stacked). Finding 1 and findings 2a/2c: fixed and pinned.
- **MEDIUM — finding 2b only half fixed** (`packages/core/src/chart/spec.ts:770`): the point-form bar cap counts `datasets[0].data.length` only. Probe (`.tentacle/tmp/model-charts/r2.ts`): `type: "bar"`, `x: {type: "number"}`, `datasets: [{10 points}, {200 points}]` → `ok: true`; likewise two series of 60 points on disjoint x (120 distinct categories) → `ok: true`. The 60-category cap is bypassed by putting a short series first, and the client re-runs this same validator, so a forged spec reaches the renderers. Fix: count the distinct x across all datasets (or the max length) and add a test with the long series second.

### Round 3

*— claude-opus-5-5, 2026-11-16*

**Verdict: PASS** — no HIGH/MEDIUM. Scope: `git diff HEAD~1` (d3d02ab9).

- **Round 2 MEDIUM fixed:** `spec.ts:770` now counts `distinctX(datasets)` (distinct x across every point-form series). The round-2 probe (`r2.ts`) now refuses both hostile shapes (`[10, 200]` points, 2×60 on disjoint x); the same-x stacked bar is still accepted.
- **Mutation:** going back to counting `datasets[0].data.length` → RED (T1.13 "the cap counts every series' x, not only the first one's"). Reverted, tree clean.
- **Gate:** `chart-spec`/`chart-helpers`/`chart-fuzz` 72 pass / 0 fail; `bun run typecheck` green; `bun run lint` clean (1779 files). No regression seen in the diff, which touches only the bar-cap branch.

## Review

### Review — C5+C6 (fresh context)

**Verdict: REQUEST-CHANGES** — one MEDIUM. Scope: `git diff main...HEAD`, slices C5+C6 only.

- **Gate (narrow):** the C5/C6 test files (`apps/mobile/test/chart-*`, `e2e-mock-chart`, `header-wiring`, `tool-summary`, core `chart-format-parts`) → 113 pass / 0 fail (4030 expects); `bun run lint` clean (1818 files); `bun run typecheck` green (root + mobile + relay). Full `bun test` not re-run.
- **MEDIUM — duplicate React keys for repeated scatter points** (`apps/mobile/src/ui/chart/ChartView.tsx:155`): a dot's key is `${series}:${x}:${y}:${r}`, so two equal `{x,y}` in one series (common with integer data) collide. Probe `.tentacle/tmp/model-charts/c56.ts`: a 9-point scatter with `{x:1,y:1}` twice → 1 duplicate dot key at every width (1–361) and fontScale (1, 3.1). React logs "two children with the same key" (a LogBox error in the dev build, which the e2e flows run on) and documents the reconcile as unsupported (children may be duplicated/omitted) on the row's frequent re-renders. Fix: key by index (the list is static per layout), plus a test with a repeated point. No other collision found: paths, texts, guides were unique across line/area/bar(±, 30×2)/pie(dup labels)/flat/single-point fixtures, and no `NaN`/`Infinity` in any path, dot, text, guide or hero.
- **Mutations (each reverted, `git status` clean after):** M1 `drawsAsChart` lets `denied` through → RED (chart-row "a failed or refused call keeps its tool row"). M2 scrub `tick` on a repeated index → RED (T5.6). The executor's 22 + 12 recorded mutations were not all re-run.
- **Attacks tried:** (a) §7 "pod not trusted" — the row re-validates `args` via `chartSpecOf` → core `validateChartSpec` before any layout; invalid/partial (streaming) JSON → `null` → generic `ToolRowView`; invalid specs are never cached: holds. (b) §7 "logic in pure modules" — decision, cache, colours in `chart-row.ts`; `ChartView` hook-free, `ChartRowView` only reads window/locale: holds. (c) Cache staleness — key = width|fontScale|locale|args; palette is resolved outside the cache, so a dark/light switch is not stale: holds. (d) Single session path / protocol — C5/C6 add no wire method, update or persisted field: holds. (e) Scrub machine — early timer, pan-before-hold yield, null hit at hold → idle: as specified.
- **Unverified (executor's own line, confirmed):** no dev build — `31-chart-inline.yaml` never ran, pixels unseen.
- **Reviewer = same model family as the C5/C6 executor** (claude-opus-5-5, fresh context only): shared blind spots possible.

*— claude-opus-5-5, 2026-11-16*

### Fix round 1 (C5+C6)

- **MEDIUM fixed — duplicate React keys for repeated scatter points** (`apps/mobile/src/ui/chart/ChartView.tsx`): a dot's key is now `dot:${i}` (the list is static per layout; equal `{x,y}` are legal), with a `biome-ignore noArrayIndexKey` and its reason.
- **Red → green:** new test in `apps/mobile/test/chart-view.test.ts` ("a repeated scatter point does not repeat a React key among its siblings", a 3-point scatter with `{x:1,y:1}` twice, checks sibling element keys) failed on the old key (`Expected: 3, Received: 2`), passes on the fix.
- **Mutation:** restoring the old `${series}:${x}:${y}:${r}` key → RED (1 fail); reverted, fix back.
- **Gate:** tsc root + mobile clean; lint clean; chart/e2e-mock-chart tests green.

*— claude-sonnet-5-5, 2026-11-17*

## Review

### Review round 2 — C5+C6 (fresh context)

**Verdict: APPROVE** — no HIGH/MEDIUM. Scope: `git diff main...HEAD`, slices C5+C6 only.

- **Gate (narrow):** the 9 C5/C6 mobile test files → 112 pass / 0 fail (3946 expects); `bun run lint` clean (1824 files); `bun run typecheck` green (root + mobile + relay). Full `bun test` not re-run.
- **Round-1 MEDIUM verified fixed:** `ChartView.tsx:160` keys dots by index. Mutation: old `${series}:${x}:${y}:${r}` key restored → RED (`chart-view.test.ts:168`, Expected 3 / Received 2); file restored from a byte copy (grep confirms `dot:${i}`).
- **Attacks tried:** (a) key collisions for guides/texts/paths under extreme ranges (1e-12 steps, 1e15+1, ±1e300, flat, -0, 0.1+0.2; line/area/bar, two identical series, widths 1/40/361, fontScale 1/3.1; probe `.tentacle/tmp/model-charts/rev2-keys.ts`) → 0 duplicates, no `NaN`/`Infinity`; out-of-range specs → `null` → generic tool row (fail-safe): holds. (b) §7 "pod not trusted" — row re-validates via `chartSpecOf` before layout: holds (round 1, not re-attacked beyond (a)). (c) §7 single session path / protocol — no wire, update or persisted change in C5/C6: holds.
- **Unverified (unchanged):** no dev build — `31-chart-inline.yaml` never ran, pixels unseen.
- **Executor behaviour:** fix minimal, red→green and mutation recorded honestly.
- **Reviewer = same model family as the C5/C6 executor** (claude-opus-5-5, fresh context only): shared blind spots possible.

*— claude-opus-5-5, 2026-11-17*
