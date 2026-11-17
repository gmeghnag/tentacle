# feat/model-diagrams — the model draws Mermaid diagrams in the conversation (iPhone WebView, Mac TUI in ASCII)

> **Status:** implementation APPROVED for D1–D2 (orchestrator, night delegation 2026-11-17); D3+ wait for the owner's visual picks (Q1, Q6).
> **Branch:** `feat/model-diagrams`
> **Type:** feat · **Size:** L (split into 7 slices, each S or M) · **Blast:** cross-module (a new model tool with no I/O; a new third-party runtime — mermaid — in the daemon binary and the app bundle; no protocol bump, no new update type, no session-log type) · **Suited:** per slice (below): `opus` for the load-bearing probe and the visual/native slices, `deepseek` for the pure/contained ones; mandatory fresh-context Review of the whole branch (L).
> **Changelog:** `changelog.d/model-diagrams.added.md` (written by D7).

## Context

*— claude-opus-5-5, 2026-11-17*

**The ask (owner, 2026-11-16, `TODO.md` entry `feat/model-diagrams`):** the agent
draws **Mermaid** diagrams (flowchart, sequence, class, state, ER, gantt,
mindmap…; numbers stay with `chart`, no `xychart`). Drawn **the SAME way as
charts**: in the conversation where the model creates it, between the reply's
paragraphs (text → diagram → text), centred, full width on the conversation
background, no card/bubble, no tool row. iPhone: rendered in the isolated WebView
of model-artifacts with mermaid.js **bundled (offline)**, theme-aware, pinch-zoom,
full screen. TUI: highlighted source + an ASCII box/arrow rendering for
flowchart/sequence + a key to open it rendered in the browser (artifacts opener).
**Daemon-side validation** with the error (line + reason) returned to the model so
small (~27B) models self-correct. Artifact kind `mermaid` (gallery, hub,
persistence for free). Design follows the owner's chart picks
(`.tentacle/mockups/model-charts/modern.html`, README row: **mono font on all
charts**; 1A 2B 3B 4B 5B 6A 7A 8B 9A 10A).

**What exists today (evidence, `main` @ b09ba216):**

- **model-charts is merged** (`5885a501`) and already owns every seam this task
  reuses: the spec rides the tool call's own arguments (`packages/tools/src/chart.ts:5-11`);
  the TUI draws a `chart` call IN PLACE of its row with no header
  (`packages/tui/src/render-lines.ts:695-740`); the phone does the same
  (`apps/mobile/src/screens/transcript/TranscriptRow.tsx:282-310`, branch at `:431`,
  pure decision `apps/mobile/src/chart-row.ts:34-41`); the tool is registered in
  every session-hosting build (`packages/cli/src/wiring.ts:698-703`) and kept from
  child agents (`packages/agent/src/subagent.ts:405,639`); a tool can advertise a
  hand-written schema and its own argument-parse hint (`packages/core/src/tool.ts:165,178`).
- **model-artifacts is NOT merged.** `feat/model-artifacts` is 37 commits ahead of
  its merge-base `6fedc0ca`; S8+S9 (phone viewers + `react-native-webview` 14.0.1)
  are in fix round 1 / round 2 (`git show feat/model-artifacts:docs/feat/model-artifacts.md`,
  sections at lines 2550–2823). Its seams exist only on that branch:
  `ARTIFACT_KINDS` + `artifactKindOf` (`packages/protocol/src/artifact.ts:55,97`),
  `artifactCsp()` (`packages/core/src/artifact-csp.ts`), the isolated
  `HtmlViewer` (`apps/mobile/src/screens/artifacts/HtmlViewer.tsx:1-15`: **no
  `onMessage`, no `injectedJavaScript`, scripts OFF by default** pending the escape
  suite), the TUI opener (`packages/tui/src/artifact-open.ts`, `os-open.ts`) and the
  `Ctrl+X Ctrl+O` chord (`packages/tui/src/chord.ts:22-43`). Chart's own C8
  (artifact kind + gallery) is waiting on the same merge.
- No Mermaid anywhere: no dependency, no code, no WebView on `main`
  (`react-native-webview` appears in `bun.lock` only as a peer entry).

**Repro** (that the capability is missing; run 2026-11-17 in this worktree, `main` @ b09ba216):

```
$ rg -n -i 'mermaid' packages apps --glob '!**/node_modules/**' | wc -l
       0
$ grep -oE '"(mermaid|happy-dom|jsdom|linkedom)[^,]{0,40}' bun.lock
(no output: none of them is a dependency)
$ git rev-list --count main..feat/model-artifacts
37
```

The executor re-runs these on `main` before D1, and re-checks whether
`feat/model-artifacts` has merged (it gates D6 and D7, *Slices*).

**Unverified at planning time (the load-bearing one, below):** whether `mermaid`'s
parser runs headless in Bun. The planner's `bun install` of `mermaid` in
`.tentacle/tmp/model-diagrams/probe/` needed an approval this session did not have,
so the probe is **D2's first step** (it decides the DOM-shim question, and the binary
size — Owner Q3).

**Constraints that shape the design:** AGENTS §7 — one session path over RPC (a
diagram is a tool call like `chart`: no new transport); logic in pure modules,
components only render; persistence split (nothing new persisted: the source IS the
call's arguments, already in the log); a pod is not trusted (a pod can forge
`rawInput`, so clients re-lint and only ever *draw*, in a sandbox, with no effect on
the laptop); protocol fields free, update classes and critical log entries not (none
added); never write raw to the terminal (ASCII rows go through `render-lines` → Ink).

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**Mermaid's own parser can validate a diagram daemon-side, in Bun, without a
browser — and report a line (and usually a column) for each failure — in every
build that hosts a session (worker, `serve`, the compiled pod binary).** Everything
else is chart's proven path (args ride `tool_call.rawInput` to every client, live
and on reload — model-charts' load-bearing assumption, proven by its T2.0).

Why it is not obviously true: `mermaid` (v11) is a browser library. `mermaid.parse`
does not lay out, but some diagram modules touch `DOMPurify`/`document` at import or
parse time, and v11 uses two parser families (jison for flowchart/sequence/class/
state/ER/gantt/mindmap/timeline/journey; langium `@mermaid-js/parser` for gitGraph,
pie, info, packet, architecture…) with **different error shapes**.

**First step of D2 (proves it before anything else, AGENTS §0/§2):**
`.tentacle/tmp/model-diagrams/probe/parse.ts` — install `mermaid@11` (exact) in the
probe dir; for each allowed type (D2 below) parse one valid and one broken fixture
with `await mermaid.parse(src)` in plain `bun`; record per type: ok / throws at
import / throws at parse, and for a broken fixture the error's line/column source
(`err.hash.loc.first_line/first_column` for jison, `parserErrors[].token.startLine`
for langium). Then the same with a minimal shim (`linkedom`'s `parseHTML` →
`globalThis.window/document`, installed only if the bare run fails). Then
`bun build --compile` a 5-line entry that imports it and report the size delta.
**Decision rule:** bare works → no shim; shim works → shim in a lazily imported
`daemon-only` module; neither → **STOP** and report (no fallback is silently taken:
an own grammar for ten diagram types is a different task).

### Preconditions

- **P1 — the args seam** is chart's (`tools/src/chart.ts:5-11`; proof chain in
  `docs/feat/model-charts.md` *Load-bearing assumption* and its T2.0 test). A
  diagram's source rides it unchanged.
- **P2 — a tool owns its error sentences:** permissive `inputSchema` + hand-written
  `jsonSchema` (`core/src/tool.ts:165`) + `argumentsHint` for raw-JSON failures
  (`core/src/tool.ts:178`), exactly as `chartTool` (`tools/src/chart.ts:51-75`).
- **P3 — the TUI draws a call in its row's place:** `chartRow` →
  `toolLines` early return (`tui/src/render-lines.ts:695-740`); per-item memo by
  `(width, expanded, glyphs)` (`:693`); per-id expand + Ctrl+O (`:708`); the
  subtitle switch (`:622-626`). A `diagram` branch is a sibling of the chart one.
- **P4 — the phone draws a call in its row's place:** the `kind: "tool"` switch
  branches on the name (`TranscriptRow.tsx:431`) into a view that falls back to
  `ToolRowView` when the pure decision returns `null` (`:287-298`); the decision is
  pure and cached (`chart-row.ts:34-41,77-110`).
- **P5 — labels/subtitles** have one table (`core/src/tool-labels.ts:20-22`) and the
  phone mirrors the TUI subtitle case for case (`apps/mobile/src/tool-summary.ts:80`).
- **P6 — never a child's tool:** `subagent.ts:405,639` exclude `CHART_TOOL_NAME`; the
  same list takes `DIAGRAM_TOOL_NAME`.
- **P7 — model-artifacts (branch only; gates D6/D7):** isolated WebView props as
  data (`artifact-viewer.ts` `htmlViewerProps`/`navigationPredicate`/`webViewParts`,
  `:137,176,187`), `artifactCsp()` (one CSP string for Mac and phone), `ARTIFACT_KINDS`
  closed client list + `artifactKindOf` (unknown → `"other"`), `ToolContext.artifacts`
  + `ArtifactStore.present`, the TUI opener (`artifact-open.ts` pure plan + one spawn,
  pod origin ⇒ confirm) and `Ctrl+X Ctrl+O` (`chord.ts:22-43`).
- **P8 — chart tokens and palette** (slot 1 teal, slot 2 orange; light/dark) exist in
  `apps/mobile/src/theme.ts` (`chartTokensFor`) and `core` (`seriesColor`); a diagram
  theme derives from them (no new colours).

### Design

**D1 — one data path, chart's: the source is the tool call; the artifact is the
index.** The model calls `diagram({title, mermaid})`. Clients draw INLINE from the
row's `args` (P1) — no fetch, works on reload, in pods, on old daemons. Where a
session has an artifact sink (P7, after model-artifacts merges), the tool also
`present`s the canonical source as kind `"mermaid"` (`text/vnd.mermaid`, UTF-8), so
it reaches the gallery and the hub badge and survives compaction — the exact split
chart's D1 chose and the owner approved (charts Q1).

**D2 — the tool (`packages/tools/src/diagram.ts`).** `name: "diagram"`, label
`Diagram`, subtitle = `title`; `permission: "none"`; `concurrency: () => []`;
not offered to child agents (P6).

```ts
input: {
  title: string;     // required, 1..120 — caption, gallery name, VoiceOver opener
  mermaid: string;   // required, the Mermaid source, ≤ 20 KiB, ≤ 400 lines
}
```

The field is named `mermaid` (not `source`/`code`) so a small model knows the
language from the schema alone. **Allowed types (v1):** `flowchart`/`graph`,
`sequenceDiagram`, `classDiagram`, `stateDiagram(-v2)`, `erDiagram`, `gantt`,
`mindmap`, `timeline`, `journey`, `gitGraph`. **Refused with a pointer to `chart`:**
`xychart-beta`, `pie`, `quadrantChart`, `sankey-beta`, `radar-beta` (numbers stay
with `chart`, owner). **Refused as unsupported:** everything else (`architecture`,
`block`, `C4*`, `packet`, `kanban`, `requirementDiagram`… — experimental, or icons
fetched from the network) with the allowed list (Owner Q4).

`execute`: `lintDiagram` (D3, pure) → on error `isError` with the sentences; else
`await parseMermaid(canonical)` (D4) → on error the normalised sentences; else, if
`ctx.artifacts`, `present(...)` (D7; a store failure is a NOTE, never an error);
result (model-facing and the old-client fallback):
`Diagram shown to the user: flowchart "Flusso di login" · 6 nodes · 6 links [· ignored: %%{init}%%, 2 style lines — the app chooses colours and fonts]`.

Description (≈ 800 chars): when to use (structure: flows, sequences, states, entity
relations, timelines; not numbers → `chart`; not a 2-node "diagram" → a sentence),
the allowed types, "no Markdown fences, no `%%{init}%%`, no colours", "quote a label
that has ( ) [ ] { } or punctuation: `A[\"Carica (sessione)\"]`", "≤ ~40 nodes reads
on a phone", one tiny example.

**D3 — the pure lint and canonical form (`packages/core/src/diagram/lint.ts`,
React-free; imported by the tool, the TUI and the app — the app already depends on
`@tentacle/core`).** `lintDiagram(raw) → { ok: true; canonical; type; notes; lineMap } | { ok: false; errors }`,
every error at once (≤ 8), each `line N[, col M]: <what> — <fix>`. It runs
**daemon-side AND on every client before drawing** (a pod can forge `rawInput`; a cap
may be lowered later): a client that gets `ok: false` draws the generic tool row.

| Typical small-model mistake | Outcome |
|---|---|
| source wrapped in ```` ```mermaid … ``` ```` | **stripped + note** (a retry costs more than the fix); line numbers keep pointing at the model's lines via `lineMap` |
| `%%{init: {...}}%%` or a `---\nconfig:` front-matter | **dropped + note** "the app chooses theme and fonts" (Owner Q5) |
| `style`/`classDef`/`linkStyle`/`class A foo`/`:::foo` | **dropped + note** — hard-coded fills break dark mode (Owner Q5) |
| `click A call cb()` / `click A href "javascript:…"` | **always dropped + note** (no callbacks, no links: the sandbox refuses navigation anyway) |
| first line `flowchart-v2`, `graph TB` with a typo (`grpah`), `sequence` | `line 1: unknown diagram type "grpah" — did you mean "graph"? Allowed: …` (Levenshtein + an alias table: `sequence`→`sequenceDiagram`, `state`→`stateDiagram-v2`, `er`→`erDiagram`, `class`→`classDiagram`) |
| `xychart-beta` / `pie` | `line 1: "pie" draws numbers — use the chart tool (type "pie"/"doughnut")` |
| empty / only comments | `the diagram is empty — start with a type line, e.g. "flowchart TD"` |
| > 20 KiB / > 400 lines | `the diagram is too large (412 lines > 400) — split it into two diagrams or group nodes into subgraphs` |
| tabs, CRLF, a BOM, NBSP | normalised silently (they confuse the lexer, never the meaning) |

Then the **parse errors** from mermaid itself (D4) are rewritten by
`explainMermaidError(err, canonical, lineMap)` (also in `core/diagram/`, pure, fed
error *fixtures* recorded by the D2 probe — so `core` never imports mermaid):

| Mermaid's raw error (shape) | What the model reads |
|---|---|
| jison `Parse error on line 3: …A --> C(sessione) x…  Expecting 'SEMI','NEWLINE',… got 'PS'` on a label with `( )` | `line 3, col 12: the label "Carica (sessione)" has parentheses — quote it: C["Carica (sessione)"]` |
| a node id `end` / `graph` / `subgraph` | `line 5: "end" cannot be a node id — rename it (e.g. fine)` |
| `-->` written `->` / `—>` / `==>` mismatched | `line 4, col 5: "->" is not an arrow in a flowchart — use "-->" (or "-.->", "==>")` |
| sequence `A->>B` missing `:` text | `line 6: a message needs text after a colon — A->>B: richiesta` |
| an unclosed `subgraph` / `alt` / `loop` | `line 12: "subgraph Auth" (line 4) is never closed — add "end"` |
| anything else | `line N, col M: Mermaid could not parse this — <the raw expectation, shortened>` + the line with a `^` under the column |

**D4 — mermaid daemon-side (`packages/tools/src/diagram-parse.ts`).** One function
`parseMermaid(src) → { ok: true; stats } | { ok: false; error: unknown }`; it
**lazily imports** mermaid (and the shim, if D2's probe needs one) on the first call,
so a session that never draws a diagram pays nothing at start-up.
`mermaid.initialize({ startOnLoad: false, securityLevel: "strict" })` once. `stats`
(node/link/participant counts) come from our own pure model (D5), not mermaid's db.
**One mermaid version, pinned exact,** shared by the daemon, the phone bundle and
the TUI's browser page (D6/D8), pinned by a test comparing the three — so a diagram
the daemon accepted is one the clients can draw.

**D5 — a small, own structural model (`packages/core/src/diagram/model.ts`, pure).**
`diagramModel(canonical, type) → FlowModel | SequenceModel | { kind: "other"; type; lines }`:
a tolerant parser of the **flowchart and sequence subset** (nodes with shapes
`[ ]`, `( )`, `{ }`, `[( )]`, `(( ))`; edges `-->`, `---`, `-.->`, `==>`, labels
`-- x -->` / `-->|x|`; `subgraph … end`; direction TD/TB/LR/BT/RL; participants,
actors, `->>`, `-->>`, `-x`, `Note`, `alt/opt/loop … end`). It feeds three things:
the tool's result line, the VoiceOver summary on the phone ("flowchart, 6 nodes:
Richiesta → Token valido? …"), and the TUI ASCII renderer. **It never decides
validity** — mermaid does (D4). When it meets a construct it does not model, it
returns `other` and the TUI shows the source instead of a wrong drawing (honest
degradation, never a guess).

**D6 — iPhone: render once in a hidden renderer, display inert.** (mockups 1–4)
- **The security split (Owner Q2).** model-artifacts' viewer forbids a bridge and
  runs scripts OFF by default (P7). mermaid needs scripts. So:
  1. **One hidden renderer WebView per session screen** (`ui/diagram/DiagramRenderer.tsx`),
     loaded with OUR page: the bundled `mermaid.min.js` + a 30-line driver, under
     `artifactCsp()` (offline: `connect-src 'none'`), `baseUrl about:blank`,
     `incognito`, the artifacts `navigationPredicate`. It is the ONLY WebView with
     an `onMessage`: the app sends `{id, source, theme}` via `injectJavaScript`
     (the source as a JSON string literal, never concatenated into code); the page
     answers `{id, ok, svg, w, h}` or `{id, ok:false, line, message}`.
  2. The answer is untrusted (mermaid runs model/pod text; a mermaid XSS could
     forge messages): `diagram-bridge.ts` (pure) accepts only that shape, `svg` ≤
     512 KiB, `w/h` finite in (0, 20000], an `id` it asked for; anything else is
     dropped and the row shows the source.
  3. **Display = an inert WebView** (`ui/diagram/DiagramView.tsx`): `html =
     artifactCsp() + <svg>`, **`javaScriptEnabled={false}`**, no `onMessage`, the
     artifacts predicate — exactly the viewer's isolation with scripts off. Height
     is known from `w/h` (no bridge needed in the display). Even a malicious SVG is
     inert there.
- **Cache:** `(sha256(canonical), scheme, fontScale)` → `{svg, w, h}`, an in-memory
  LRU (32) + `FileSystem.cacheDirectory/diagrams/` (the artifacts cache pattern), so
  a scroll back or a reload never re-renders.
- **Theme-aware:** `diagram-theme.ts` (pure) maps chart tokens + palette (P8) to
  mermaid `themeVariables` (`base` theme), both schemes, **mono font** (owner chart
  pick). Switching light/dark re-renders from the cache key.
- **Inline (section 1):** the caption (title · type, mono, centred) and the diagram
  on the conversation background, 16 pt margins, no card. A diagram taller than
  ~420 pt is fitted to the width with a max height and a bottom fade + a "tocca per
  ingrandire" chip (section 3, Owner Q6). While rendering: the caption + a hairline
  placeholder of the estimated height (no spinner glyph); a render failure → the
  caption + the highlighted source (never an error in the transcript).
- **Full screen (section 4):** tap → modal, the same inert display with
  `maximumZoomScale 6`, pinch + double-tap (fit ↔ 100 %), landscape-capable (charts
  P9), segmented `Diagramma | Sorgente`, Share (SVG file via `Share.share({url})`,
  and "Copia sorgente"). VoiceOver: one element, `accessibilityLabel` = the D5 summary,
  action "Mostra sorgente".
- **Bundling mermaid offline:** a build script `apps/mobile/scripts/gen-diagram-renderer.ts`
  inlines `node_modules/mermaid/dist/mermaid.min.js` (the pinned version) into
  `assets/diagram/renderer.html`; loaded with `expo-asset` + `expo-file-system`
  (`readAsStringAsync`) into `source={{ html }}`. *Unverified:* whether Metro accepts
  `.html` as an asset without a `metro.config.js` `assetExts` line — D6's first check
  (the fallback is a `.txt` extension).

**D7 — artifact kind `mermaid` (after model-artifacts merges).** `"mermaid"` joins
`ARTIFACT_KINDS` (client list only; the wire kind is free); the tool's `present`;
the gallery row renders a thumbnail through the same renderer + cache; opening it
opens the full screen of D6. The hub needs nothing new (it opens the gallery and
badges `unseenArtifacts`, mobile-hub H4). Old app → `artifactKindOf` → `"other"`.

**D8 — TUI (Mac).** (mockups 5–7)
- `packages/tui/src/diagram-lines.ts` (pure: `(args, width, expanded, mode) →
  string[] | undefined`) + one branch in `render-lines.ts` beside `chartRow` (P3),
  same memo, same "only a settled call draws" rule.
- **Compact (5A, recommended):** caption line `title · type · ^X^O apri` (dim,
  centred), then the ASCII drawing centred in the width. **Expanded** (Ctrl+O or a
  click on the caption, P3): the drawing + the highlighted source under it
  (`│ `-prefixed, the command-rows style). Types without a drawing (class, state,
  ER, gantt, mindmap, timeline, journey, gitGraph) and a flowchart that does not fit
  the width show the highlighted source with the generic cut (`… +N more lines ·
  ctrl+o to expand`).
- **Flowchart layout** (`diagram-ascii-flow.ts`, pure): layered (longest-path
  ranks, two barycentre sweeps to reduce crossings), boxes `╭─╮│╰─╯`, decisions
  marked `◇` in the accent, cylinders with a `├─┤` lip, orthogonal edges with
  `┬ ┴ ├ ┤ ╭ ╮ ╰ ╯`, arrowheads `▼ ▲ ► ◄`, edge labels beside the vertical run,
  LR/RL laid out sideways; subgraphs as a dim titled frame. **Sequence**
  (`diagram-ascii-seq.ts`): lifelines, solid `──►`, dashed replies `╌╌►`, notes in a
  dim box; under 50 columns the one-message-per-line form (6B) is the automatic
  fallback.
- **Glyph audit:** no `\p{Extended_Pictographic}` glyph (`►◄` instead of `▶◀`), the
  chart rule; width by `string-width` (CJK labels count 2; cut with `…`).
- **Source highlighting:** `cli-highlight` (`read-highlight.ts:12`) has no mermaid
  grammar → a tiny pure tokenizer (`diagram-highlight.ts`: keyword, id, arrow,
  label, comment) painted with the existing `theme.ts` tokens.
- **Open in the browser:** `Ctrl+X Ctrl+O` (the artifacts chord, P7) opens the
  newest artifact — a diagram is one after D7. Before D7 (artifacts not merged) the
  key is absent and the caption shows no hint. The page = `artifactCsp()` + the
  pinned `mermaid.min.js` (embedded in the binary with `import … with { type: "text" }`)
  + the source as a `<script type="application/json">` + the driver, written to the
  opener's `0700` temp dir; pod origin ⇒ the opener's confirm line (P7, unchanged).
- No raw terminal writes (lines through `render-lines` → Ink, AGENTS §7).

**D9 — old clients and versions.** No `PROTOCOL_VERSION` bump, no `protocol.d/`
note (a new tool name and its arguments are data). Old TUI/app → the generic tool
row `Diagram <title>` + the result line. New client + a forged/invalid source →
generic row. Old app reading a `"mermaid"` artifact → `"other"` card.

### Files

Dependency order (slice in brackets):

1. `packages/core/src/diagram/lint.ts` · `explain.ts` · `model.ts` · `summary.ts` ·
   `index.ts` · `core/src/index.ts` (export) · `core/src/tool-labels.ts` (`diagram: "Diagram"`) [D1]
2. `packages/tools/package.json` (`mermaid` exact; + `linkedom` only if the probe
   needs it) · `tools/src/diagram.ts` · `tools/src/diagram-parse.ts` · `tools/src/index.ts`
   · `cli/src/wiring.ts` (register beside `chartTool`, `:703`) · `agent/src/subagent.ts`
   (`:405,639`) · TUI `toolSubtitle` case (`render-lines.ts:625`) + phone
   `tool-summary.ts:80` case [D2]
3. `packages/tui/src/diagram-ascii-flow.ts` · `diagram-ascii-seq.ts` ·
   `diagram-highlight.ts` · `diagram-lines.ts` · `tui/src/theme.ts` (diagram tokens) [D3]
4. `packages/tui/src/render-lines.ts` (branch + memo + expand) [D4]
5. `apps/mobile/src/diagram-row.ts` · `diagram-theme.ts` · `diagram-bridge.ts` ·
   `diagram-cache.ts` (pure) [D5]
6. `apps/mobile/scripts/gen-diagram-renderer.ts` · `assets/diagram/renderer.html`
   (generated) · `ui/diagram/DiagramRenderer.tsx` · `DiagramView.tsx` ·
   `DiagramFullScreen.tsx` · `screens/transcript/TranscriptRow.tsx` (branch at `:431`) [D6]
7. `packages/protocol/src/artifact.ts` (`"mermaid"`) · `tools/src/diagram.ts`
   (`present`) · `apps/mobile/src/artifact-gallery.ts` (thumbnail, filter) ·
   `packages/tui/src/artifact-open.ts` (a `mermaid` plan → the browser page) ·
   `changelog.d/model-diagrams.added.md` [D7]

### Failure modes

| Mode | What happens | Converges how | Pinned by |
|---|---|---|---|
| Fenced source, `%%{init}%%`, `style`/`classDef`, `click` | stripped + noted in the result | drawn; the model learns from the note | T1.2 |
| Unknown / misspelt type; `pie`/`xychart` | error with "did you mean" / "use chart" | model retries | T1.3 |
| Parenthesised label, `end` as id, `->`, missing `:` , unclosed block | mermaid's error rewritten to `line N, col M: … — fix` | model retries once | T1.4, T2.2 |
| An error shape `explain` does not know | generic sentence + the line + `^` (never a raw JSON dump) | model retries | T1.5 |
| Too large | error with "split / subgraphs" | — | T1.6 |
| mermaid import fails in a build (pod binary missing the module) | the tool answers `isError` "diagrams are not available in this build" — never a crash, never a silent success | — | T2.4 |
| mermaid parse hangs (pathological input) | parse runs with a 2 s budget (`Promise.race`); timeout → error "too complex — split it" | — | T2.5 |
| Pod forges `rawInput` | clients re-lint; the phone renders in the sandbox and displays inert; the TUI draws text only | nothing leaves the screen | T4.3, T5.3 |
| Forged renderer message (mermaid XSS) | `diagram-bridge` drops it; the row shows the source | — | T5.2 |
| Phone render fails / renderer not ready / app backgrounded | caption + source; retried when the row is next visible | — | T6.2 |
| Daemon accepted, client mermaid older | impossible by construction (one pinned version, T2.6); a lowered client cap → generic row | — | T2.6 |
| Huge flowchart in a narrow terminal / resize | source view with the cut; pure function of width → re-lays out | — | T3.5, T4.2 |
| Construct the own model does not know (e.g. `A & B --> C`) | `other` → source view, never a wrong drawing | — | T1.7 |
| NO_COLOR | drawing unchanged (shape, not colour, carries meaning: `◇`, `╌`) | — | T3.6 |
| Theme switch on the phone | re-render from the cache key (scheme in the key) | — | T5.4 |
| Old TUI / old app | generic row + result line | — | T2.3 |
| Artifact store absent / failing | inline diagram still drawn; result notes "not added to the gallery" | — | T7.1 |
| Compaction | the gallery keeps the artifact (manifest) | — | T7.2 |
| Sub-agent | not in its registry | — | T2.7 |

### Tests

Red first (§9): each written and shown FAILING before its code; one mutation per
slice applied and reverted. Fakes: the `createChannelPair` harness (chart's T2.0),
ink-testing-library frames (D4), recorded mermaid error fixtures (D1, no mermaid in
`core` tests), a fake WebView port for the renderer (D5/D6).

- **T1 (core, D1)** 1 one valid source per allowed type passes, `canonical` byte-equal
  for an already-canonical source; 2 fence / init / front-matter / `style` / `classDef`
  / `click` stripped with the exact notes, and `lineMap` maps a later error back to the
  model's line; 3 typos → "did you mean", `pie`/`xychart-beta` → "use chart"; 4 each
  recorded mermaid error fixture → its exact sentence (parentheses, `end`, `->`, missing
  `:`, unclosed `subgraph`); 5 an unknown error shape → generic sentence + caret line,
  never `[object Object]`/JSON; 6 caps at N pass, N+1 fail with the advice; 7 `model`
  on the flowchart/sequence fixtures (counts, shapes, labels, subgraphs) and `other` on
  an unmodelled construct; 8 summary strings (it/en).
- **T2 (tool, D2)** 0 **the probe as a test**: `parseMermaid` on a valid and a broken
  fixture per allowed type, in `bun test` (load-bearing); 1 valid → result line exact;
  2 broken → `isError` with the sentence; 3 old-client fallback = the result line is
  self-explanatory (snapshot); 4 import failure (injected loader throwing) → the
  "not available" error; 5 a hanging parse (injected) → the timeout error within the
  budget; 6 one-version pin: daemon dep = phone bundle header = TUI page; 7 sub-agent
  registry has no `diagram`; 8 label/subtitle parity TUI ↔ phone.
- **T3 (TUI renderer, D3)** snapshots (colour off/on) of the mockup diagrams at 120/80/50
  cols; properties: 1 no line wider than `width` (fuzz 20..200); 2 every edge is a
  connected path from its source box to its target box (walk the glyphs back); 3 no two
  boxes overlap; 4 every label of the model appears exactly once; 5 tiers: drawing ≥ fit,
  else source + cut; sequence < 50 cols → one line per message; 6 NO_COLOR keeps `◇`/`╌`;
  7 no glyph matches `\p{Extended_Pictographic}`; 8 CJK labels measured at width 2.
- **T4 (TUI wiring, D4)** ink frames: 1 a `diagram` row live and after resume shows the
  caption + drawing, no `● Diagram` header; Ctrl+O and a caption click expand to drawing
  + source; 2 resize 120 → 50 → 120 re-lays out; 3 a forged source → generic row;
  4 nothing written to `process.stdout` (spy).
- **T5 (phone pure, D5)** 1 `diagramRow` decision (name/status/lint) mirrors
  `chartRowSpec`; 2 `diagram-bridge` accepts exactly the shape, drops oversize/NaN/unknown
  id/extra keys; 3 forged args → `null`; 4 cache key includes scheme + fontScale, LRU
  bound; 5 `diagram-theme` both schemes use mono and only chart tokens (no pure black).
- **T6 (phone render, D6)** wiring test (the artifacts pattern): the display WebView has
  `javaScriptEnabled={false}`, no `onMessage`, no `injectedJavaScript`, the artifacts
  predicate; only the renderer has `onMessage`; 2 render failure → caption + source;
  e2e `32-diagram-inline.yaml`: the mock model calls `diagram` → visible; reopen →
  still visible; tap → full screen, Sorgente tab, back.
- **T7 (artifacts, D7)** 1 a `present` call with kind `mermaid` and canonical bytes; a
  throwing sink → success + note; 2 after compaction the gallery lists it; 3 an old kind
  list maps it to `"other"`; 4 the TUI opener writes a CSP-prefixed page with the pinned
  mermaid and the source as JSON (never interpolated into script text).

### Slices

| # | Slice | Size · Blast · Executor | Files item | Done when |
|---|---|---|---|---|
| D1 | Pure lint + error explainer + structural model + summary | M · contained · **deepseek** | 1 | T1 green + mutation (accept a fenced source without a note) |
| D2 | **Probe FIRST**, then `diagram` tool + daemon `parseMermaid` + registration + labels | M · cross-module · **opus** (load-bearing assumption, binary size) | 2 | T2 green incl. T2.0; probe output + size delta pasted in Execution |
| D3 | TUI ASCII renderer (flow, sequence, highlight) | M · contained · **opus** (visual bar) | 3 | T3 green; frames compared to mockup 5A/6A |
| D4 | TUI wiring | S · cross-module · **deepseek** | 4 | T4 green |
| D5 | Phone pure (row, theme, bridge validator, cache) | S · contained · **deepseek** | 5 | T5 green |
| D6 | Renderer + inert display + full screen (**needs model-artifacts S8 on `main`**) | M · cross-module · **opus** | 6 | T6 green on the simulator; else unit/wiring tests + the honest "pixels unverified" line |
| D7 | Artifact kind + `present` + gallery + TUI browser open + changelog (**needs model-artifacts merged**) | S · cross-module · **deepseek** | 7 | T7 green |

Order: D1 → D2 → D3 → D4 → D5 → D6 → D7. D1–D5 do not depend on model-artifacts.
If model-artifacts has not merged when D5 is done, the branch can merge D1–D5 (TUI
complete minus the browser key; phone shows the generic row) and D6–D7 follow on a
second branch — Owner Q7.

### Owner questions

Each with a recommendation. Mockups: `.tentacle/tmp/model-diagrams/mockups/index.html`
(section numbers in brackets). Non-visual ones (2–5, 7, 8) can be answered by the
orchestrator; the visual picks (1, 6) wait for the owner.

1. **Visual picks** [1–7]: iPhone inline style — 1A thin outlines + accent decision,
   mono caption above ★ vs 1B soft-filled nodes, caption below (2A/2B follow);
   big diagram — 3A fit width + max height + fade + "tap to zoom" ★ vs 3B natural size
   with horizontal scroll; full screen — 4A sheet like charts 8B with `Diagramma |
   Sorgente` ★ vs 4B immersive landscape canvas with floating zoom + minimap; TUI —
   5A ASCII drawing first, source on expand ★ vs 5B source first, drawing on expand;
   sequence — 6A lifelines ★ (6B is the automatic < 50-col fallback).
   **Recommendation: 1A 2A 3A 4A 5A 6A.**
2. **Phone rendering security.** (a) one hidden renderer WebView with a validated
   bridge + an **inert** (scripts-off, no bridge) display WebView; (b) a scripts-on
   display WebView per diagram with a height-only bridge (breaks the artifacts "no
   `onMessage`" rule in every row); (c) native `react-native-svg` `SvgCss` from the
   rendered SVG (no WebView display, but `foreignObject` labels and mermaid's CSS
   render unreliably). **Recommendation: (a)** — the only option where untrusted
   output is shown with scripts off, matching the artifacts viewer default.
3. **mermaid in the daemon binary** (pod binary included), lazily loaded, for exact
   validation. Size delta measured by D2's probe (expected a few MB, unverified).
   **Recommendation: accept**; the alternative (own grammar for ten types) gives
   small models wrong "valid" answers that the clients then fail to draw.
4. **Type scope.** Allowed: flowchart/graph, sequence, class, state, ER, gantt,
   mindmap, timeline, journey, gitGraph. `pie`/`xychart`/`quadrant`/`sankey`/`radar`
   → "use chart". `architecture`/`block`/`C4`/`packet`/`kanban`/`requirement` refused
   as unsupported. **Recommendation: as stated.**
5. **Model-supplied styling** (`%%{init}%%`, front-matter config, `style`,
   `classDef`, `linkStyle`, `:::`) — (a) drop and say so in the result; (b) keep it.
   **Recommendation: (a)**, chart's rule (charts Q2): the app owns colours and the mono
   font, and hard-coded fills break dark mode. `click` lines are always dropped.
6. **Inline size cap on the phone** [3]: max inline height before the fade.
   **Recommendation: 420 pt** (≈ half an iPhone screen), everything else in full screen.
7. **Merge shape.** If model-artifacts is not on `main` when D5 is done: (a) merge
   D1–D5 and do D6–D7 on a follow-up branch; (b) hold the branch until artifacts
   merges. **Recommendation: (a)** — the model-facing tool + TUI are useful alone, and
   one-code-branch-at-a-time (§10) is kept by finishing D1–D5 first.
8. **Caps.** 20 KiB / 400 lines per diagram, mermaid's own `maxEdges` 500, parse
   budget 2 s, renderer SVG ≤ 512 KiB, not offered to sub-agents.
   **Recommendation: as stated.**

**Answers (orchestrator, 2026-11-17, owner asleep — night delegation):** Q2 (a), Q3 accept, Q4 as stated, Q5 (a), Q7 (a), Q8 as stated — all the recommendations. Q1 and Q6 (visual) wait for the owner; only D1–D2 run before that.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

### Mockups

`.tentacle/tmp/model-diagrams/mockups/index.html` — self-contained (inline SVG +
one small script), dark default + light toggle, 390 px phone frames that stack under
800 px, one landscape frame. Sections: 1 iPhone flowchart inline (1A ★ / 1B), 2
sequence inline (2A ★ / 2B), 3 big diagram (3A ★ / 3B), 4 full screen (4A ★ diagram
and source tabs / 4B landscape), 5 TUI flowchart 80 cols (5A ★ / 5B), 6 TUI sequence
(6A ★ / 6B), 7 class diagram source view + a validation-error row. Tokens: mobile-chrome
B1 + charts palette A (slot 1 teal, slot 2 orange); mono typography throughout (owner's
chart pick). The production drawings come from mermaid (phone) and the D3 renderer
(TUI); the mockup's are hand-placed to choose a look.

**Structural check** (`bun .tentacle/tmp/model-diagrams/check-ascii.ts`, 2026-11-17:
strips the TUI `<pre>` frames, verifies every `┬` has a connector below and every `▼`
lands on a box edge, flags any `\p{Extended_Pictographic}` glyph, and prints widths):

```
frame 0: 30 lines, max width 72
frame 1: 16 lines, max width 72
frame 2: 17 lines, max width 65
frame 3: 8 lines, max width 44
frame 4: 9 lines, max width 73
frame 5: 6 lines, max width 75
ALL PASS
```

(Frame 4 was 83 wide on the first run — its caption was shortened to fit 80.)
**Unverified:** the pixels were not looked at by the planner (no browser screenshot in
this session); the owner's look is the visual check.

### Notes / debt

- An own grammar (no mermaid in the daemon) — rejected for v1 (Owner Q3).
- PNG export from the phone (needs a snapshot of the inert WebView): follow-up; v1
  shares SVG and the source.
- ASCII drawings for state/class/ER: later, on the same layered layout as flowchart.
- Live-updating a diagram in place (an `id`): later; the artifact versioning already
  supports it.

## Execution

*— deepseek (variant not recorded), 2026-11-17* — this section was written by
the executor whose commit reads `exec (deepseek)`. Its original signature
(`claude-sonnet-4-5-20250929`) was a wrong self-attribution; review round 1 asked
for it to be corrected, and no log of that session names its exact variant, so
none is invented here.

---

*— claude-sonnet-4-5-20250929, 2026-11-17* (superseded signature, see above)

Scope: **slice D1 only** (pure lint + error explainer + structural model + summary,
`Files` item 1). D2–D7 untouched: no `diagram` tool, no mural dependency, no TUI
renderer, no phone code, no artifact kind, no `TODO.md` edit.

### 0. The load-bearing check, re-run before anything else

The plan's own first D2 step, run early because D1's error explainer is built on
its **recorded shapes** (the explainer must be written against real mermaid
errors, not imagined ones). Probe: `.tentacle/tmp/model-diagrams/probe-d1/`
(gitignored, outside `tsconfig`/`bun test`, `bun add mermaid@11.4.1`).

```
$ bun shapes.ts            # no DOM shim
=== paren
  message: "DOMPurify.addHook is not a function. (In 'DOMPurify.addHook(\"beforeSanitizeAttributes\", …', 'DOMPurify.addHook' is undefined)"
=== endId / shortArrow / unclosedSub   → the same DOMPurify crash
=== seqNoColon → "Parse error on line 2: … Expecting 'TXT', got 'NEWLINE'"   ← real
```

**Bare Bun does NOT work**: every flowchart-class parse dies inside DoMPurify
before the grammar is reached, so the real error is masked. Per the plan's
decision rule, the shim was tried next (`bun add linkedom`, `parseHTML` →
`globalThis.window/document/DOMParser/Element/Node/HTMLElement`):

```
$ bun shim.ts              # with the linkedom shim
=== validFlow: OK   === paren: OK   === seqValid: OK   === classValid: OK
=== erValid: OK     === gitValid: OK (a chevrotain ambiguity warning on stderr)
=== pieValid: OK
=== endId THROWS    hash.loc {first_line:2, first_column:10}, token "end", expected ['AMP',…]
=== shortArrow THROWS  token "MINUS", loc {2,10}, expected ['SEMI','NEWLINE','EOF',…]
=== unclosedSub THROWS loc {5,0}, token 1 (a number, not a name)
=== seqNoColon THROWS  token "NEWLINE", expected ["'TXT'"]
=== erBroken THROWS    token "ALPHANUM", expected ['ZERO_OR_ONE',…]
```

Recorded facts D1's explainer is built on (mermaid 11.4.1):

1. **There are two error families, as the plan predicted.** jison →
   `err.hash.loc.first_line/first_column`, `err.hash.token`, `err.hash.expected`.
   chevrotain/langium (gitGraph, pie) → **`err.result.parserErrors[].token.startLine/startColumn`**,
   with `err.hash` absent; `err.result` is **cyclic** (never `JSON.stringify` it).
2. **A third shape exists**: a lexical error (`sequenceDiagram` + a bare
   `participant`) carries only `Lexical error on line 2` in the message, and its
   `hash.line` is **0-based and wrong** (`1` for line 2) — so it is read from the
   message, and the `hash` branch is guarded on `hash.loc` existing.
3. **A fourth**: an unknown type line throws a plain string-ish
   `No diagram type detected matching given configuration for text: …`, with no
   `hash` and no `result` at all.
4. **`C(sessione)` is legal** (a round node): the plan's first fixture row
   ("a label with parentheses") only fails inside `[ ]`. The explainer therefore
   keys on a bracket *inside* the label, and a test pins that a round node is
   never reported as a parenthesis problem.
5. `await mermaid.parse(src)` resolves to `{diagramType:"flowchart-v2", config}`
   on success — not a boolean — so "no throw" is the ok signal.
6. `linkedom@0.18.15` + `mermaid@11.4.1` install in ~2 s / 138 + 20 packages.
   **No repo dependency was added**: `packages/tools/package.json` and `bun.lock`
   are untouched (that is D2's, with the size delta the plan asks for there).

The plan's *load-bearing assumption* therefore **holds with the shim, not bare** —
which is exactly the plan's second branch ⇒ D2 must put `linkedom` behind its lazy
import. Recorded for D2; not acted on here.

### 1. As built (dependency order)

| File | What |
|---|---|
| `packages/core/src/diagram/types.ts` | `DiagramType`, `DiagramKeywords`, the alias table (`sequence`→`sequenceDiagram`, `state`→`stateDiagram-v2`, `graph`→`flowchart`, …), the refused-numbers set (`pie`, `xychart(-beta)`, `quadrantChart`, `sankey(-beta)`, `radar(-beta)`), the unsupported set (`architecture`, `block`, `C4*`, `packet`, `kanban`, `requirementDiagram`, `zenuml`, `info`), Levenshtein `nearestKeyword`. |
| `packages/core/src/diagram/lint.ts` | `lintDiagram(raw)` → `{ok:true, canonical, type, notes, lineMap}` \| `{ok:false, errors}`. Normalises BOM/CRLF/tabs/NBSP/trailing space silently; strips a fence, a config front-matter, `%%{init}%%` (multi-line too), `style`/`classDef`/`linkStyle`/`class A foo`/`:::cls`/`click` each as a **note**; canonicalises the type line; `DIAGRAM_CAPS` (20 KiB / 400 lines / 8 errors) each naming its advice. |
| `packages/core/src/diagram/explain.ts` | `explainMermaidError(err, canonical, lineMap)` → `string[]`. Reads all four shapes, rewrites the five recognisable mistakes (a bracketed label, a reserved id, a `->`, a colon-less sequence message, an unclosed block), else a sentence + the model's line + a caret. `lineMap` maps back to the model's lines. Never a JSON dump. |
| `packages/core/src/diagram/model.ts` | `diagramModel(canonical, type)` → `FlowModel` \| `SequenceModel` \| `OtherModel`. Tolerant flowchart reader (6 shapes, 9 link forms, edge labels in both spellings, `;`-separated statements, subgraphs, direction) and sequence reader (participants/actors with `as`, 8 arrows → call/reply/cross, notes, `alt/opt/loop/par/critical/break`). Anything outside the subset → `other`. |
| `packages/core/src/diagram/summary.ts` | `summarizeDiagram(model, type, {title, notes})` → `{line, shape}` (the tool's result line, notes appended) and `describeDiagram(...)` (the VoiceOver label, a 4-box reading order / the first 3 messages). |
| `packages/core/src/diagram/index.ts`, `packages/core/src/index.ts` | one export root, re-exported by `@tentacle/core` (the app's existing dependency). |
| `packages/core/src/tool-labels.ts:24` | `diagram: "Diagram"` (P5 — the label the TUI and permission prompt will read). |
| `packages/core/test/diagram-{lint,explain,model,summary}.test.ts` | 51 tests (T1.1–T1.8). |
| `packages/core/test/tool-labels.test.ts:22` | `diagram` → `Diagram`. |
| `changelog.d/model-diagrams.added.md` | one bullet (see the drift note below). |

### 2. Red before green (§9)

No file of `packages/core/src/diagram/` existed before this slice, so the RED
state was the import itself; to make the red **an assertion, not a compile
error**, the assertions themselves were driven to red on first run and each red
named a real defect:

- first `bun test packages/core/test/diagram-lint.test.ts` → **13 pass / 5 fail**:
  `class A {` in a classDiagram counted as a styling line (it is a *declaration*
  there, styling only in a flowchart); `graph` (no direction) came back as
  `flowchart` with no `TD`; my own count of dropped lines was wrong (5, not 4).
- first `bun test packages/core/test/diagram-explain.test.ts` → **6 pass / 4 fail**:
  the caret row was indented by two relative to the line it marks; the
  no-shape branch dropped `err.message` (a bare string error had nothing to say);
  and the parenthesis fixture was wrong (see probe fact 4 — `C(sessione)` is legal,
  the failure is only inside `[ ]`), which the test now pins explicitly.
- first `bun test packages/core/test/diagram-model.test.ts` → **8 pass / 3 fail**:
  an edge label was swallowed (`A -- no --> C` read as the link `-- no -->` but
  `A -->|si| B` produced the label `> B` — the piped forms were missing from the
  link table); a bare id did not keep a later `B[X]` label; `A[x] y` was accepted
  as a node.
- first `bun test packages/core/test/diagram-summary.test.ts` → **5 pass / 3 fail**:
  an `other` diagram reported its `title` line as its shape, and the reading
  order was 4 boxes where I expected 3 (the test was wrong; fixed).

### 3. Mutation checks (§9, the plan's D1 target plus one per module)

Each applied to the real file, suite run, then reverted (`cp` backup, `git status`
clean of backups afterwards).

| # | Mutation | Result |
|---|---|---|
| **M1** | the plan's named target: strip a fenced source but **accept it without a note** (`notes.fence = false`) | **2 fail** — "a Markdown fence is stripped, and lineMap still names the model's lines", "a bare ``` fence is stripped too" |
| M2 | `lineMap` returns the identity instead of the model's lines | **3 fail** — the fence, `%%{init}%%` and front-matter lineMap tests |
| M3 | the parenthesis rule is disabled (`parenthesisedLabel` → `null`) | **1 fail** — "a label with parentheses is quoted for it" |
| M4a | junk after a shape is accepted (`A[x] y` becomes a node) | **1 fail** — "a flowchart construct it does not model falls back to `other`" |
| M4b | an unclosed `subgraph` is drawn anyway | **1 fail** — same test (**and it exposed a gap**: that case was not in the list, so it was added, then re-mutated to confirm it bites) |
| M4c | `box` is accepted as a sequence block keyword (a construct we would draw wrongly) | **1 fail** — "a sequence construct it does not model falls back to `other`" |
| M5 | the notes are dropped from the result line | **1 fail** — "the notes ride the line, because that is where the model reads them" |

One mutation **did not bite on the first try** (an early M4 hit a guard that the
tests do not reach through that path); it was re-aimed at the three honesty
guards above rather than left as a passing mutation.

### 4. Drift from the Implementation (and why)

1. **`class A foo` is only styling in a flowchart.** The plan's table lists
   `class A foo` among the always-dropped styling lines (D3), but in a
   **classDiagram** `class A { … }` / `class A : +x int` is the diagram itself.
   Dropping it stripped whole class diagrams. Now: `style`/`classDef`/`linkStyle`
   always; `class <id> <id>` only when the type is `flowchart`. Same note text.
2. **`lineMap` is `readonly number[]`, not a function.** The plan writes
   `lineMap` without a shape; an array indexed by the canonical line (1-based
   value = the model's line) is what `explainMermaidError` consumes, and it is
   what a test asserts byte-for-byte.
3. **A fifth error shape was added to the explainer** (the lexical one, and the
   keyless "No diagram type detected") because the probe found them; the plan
   named two.
4. **`DiagramType` lives in `types.ts`**, re-exported by `lint.ts`, so the model,
   the summary and the lint share one type (the plan lists `type` on the lint's
   result without saying where the union lives).
5. **`sequenceDiagram` blocks `box`/`rect` are `other`, not modelled.** The plan's
   D5 list does not include them; modelling a participant box wrongly would draw
   a lie, so they fall back to the source (honest degradation, per D5's own rule).
6. **No `explain.ts`-level mermaid dependency, no `core` test importing mermaid**
   — the fixtures are hand-built records of the probe's shapes, as D1's *Tests*
   note requires.
7. **The changelog fragment was written now**, on this slice. The plan schedules
   it for D7. The owner's brief for this execution asks for one fragment, so it
   exists and describes **only what D1 ships** (the pure layer; "nothing is drawn
   yet"). **D7 must extend this same file** rather than create a second one —
   the slug+category is the designed collision point, and a second writer of
   `model-diagrams.added.md` is a real merge conflict, not a silent overwrite.
8. **`packages/core/src/index.ts` gained one line** (`export * from "./diagram/index.ts"`)
   and `tool-labels.ts` one entry, both in the plan's Files item 1.

Not done, deliberately (later slices): the `diagram` tool and its schema
description (D2), `parseMermaid` (D2), the TUI ASCII renderers and highlight
(D3/D4), the phone modules (D5), the WebView renderer (D6), the artifact kind
and `present` (D7). No `protocol.d/` note: no wire or on-disk shape changed
(no new method, no new update kind, no new log entry type).

### 5. Gate

```
$ bunx tsc --noEmit                      → clean (no output)
$ bun run lint                           → Checked 1856 files. No fixes applied.   (0 errors)
$ bun test packages/core/test/diagram-*.test.ts packages/core/test/tool-labels.test.ts
  51 pass · 0 fail · 147 expect() calls   (5 files)
$ bun test
  13478 pass · 5 skip · 0 fail · 33 snapshots · 106471 expect() calls
  Ran 13483 tests across 960 files. [445.30s]
```

The 5 skips are the opt-in ones (live-k8s, live-docker, the real-socket
keepalive, and the two that ride them) — none from this slice, which has no
`skip`/`todo` at all (`rg 'test\.skip|test\.todo' packages/core/test/diagram-*.ts`
→ 0).

No `packages/protocol/schema/protocol.json` regeneration: no schema changed.

**Unverified:** the plan's T1 fixtures are "recorded mermaid error fixtures"; the
five the explainer recognises are pinned (M3 shows they bite), but an error shape
outside them falls to the generic sentence by design, and a *fifth* family (a
future mermaid version) would degrade to that sentence, not crash — there is no
test for an unknown family because there is no fixture for one. Verify by adding
a recorded shape to `diagram-explain.test.ts` when D2's probe meets one.


## Review

*— claude-opus-5-5, 2026-11-17* (fresh context; slice D1 only; a different model family from the executor)

**Verdict: REQUEST-CHANGES.**

Gate (rerun by the reviewer): touched tests 51 pass / 0 fail (5 files); `bun run lint` clean (1856 files); `bun run typecheck` clean. The full suite was not rerun (D1 is pure core code; Execution reports 13478 pass / 5 opt-in skips).
Mutation: M1 (fence stripped without its note) → 2 fail, reverted, tree clean (`git status` empty).
Repro scratch: `.tentacle/tmp/model-diagrams/review/a.ts` (outputs quoted below).

Findings:
1. **HIGH — content after the type line is silently dropped** (`packages/core/src/diagram/lint.ts:309-313`). The rewrite replaces the whole type line with `keyword + direction`. So the common one-liner `graph TD;A-->B;B-->C` returns `{ok:true, canonical:"flowchart TD", notes:[]}`: every edge is gone, with no note and no error. That is a silent wrong state. Clients would draw an empty diagram, and the tool's stats would say 0 nodes. Fix: canonicalise only the leading keyword and keep the rest of the line. Add a T1.1 test for it.
2. **MEDIUM — a multi-line `%%{init}%%` before the type line is refused** (`lint.ts:243-248`). `isComment` skips only the opening `%%{` line. The type-line search runs BEFORE the directive pass (step 4), so `%%{init: {\n "theme":"dark"\n}}%%\nflowchart TD` → `line 2: unknown diagram type ""theme":"`. The plan says init is "dropped + note" (D3, T1.2). Multi-line init at the top is the usual form.
3. **MEDIUM — wrong "add end" advice** (`packages/core/src/diagram/explain.ts:204-235, 335-341`). `BLOCK_KEYWORDS` includes `section` (gantt/journey/timeline have no `end`) and `state` (`state "Idle" as I` is a declaration, and a composite state closes with `}`). So ANY parse error in a gantt with a section, or in a stateDiagram with a `state … as`, becomes `"section A" (line 3) is never closed — add "end"`. Following that advice breaks the source further, and the retry loop never converges. The rule also ignores whether the fault is related to the block. Scope the rule to the diagram type (flowchart: subgraph; sequence: alt/opt/loop/par/critical/break/rect/box), or require the fault to be at EOF.
4. **MEDIUM — `click` is not "always dropped"** (`lint.ts:123,282`). `CLICK_LINE` matches only at the start of a line, so `A-->B; click A href "javascript:…"` survives into `canonical` with no note. The same applies to `style`/`classDef` after `;`. Mermaid `securityLevel:"strict"` (D4) and the phone sandbox still stop the click, so this is defence-in-depth, not an exploit. But the plan's D3 table and the "pod forges rawInput → clients re-lint" failure mode both rely on this guarantee.

Attacks tried: one-liner flowchart (#1); multi-line init before the type line (#2); explain on gantt/state fixtures (#3); `;`-joined click (#4); `sequenceDiagram autonumber` on the type line (dropped silently, the same root cause as #1); the fence mutation (bites). Holds: no mermaid import in core; explain never dumps JSON or a cyclic `result`; caps fail loud; no protocol/persistence/§7 surface touched (blast `contained` confirmed); lint and typecheck clean.
Executor behaviour: thorough Execution notes and honest drift notes. But the Execution signature reads `claude-sonnet-4-5-20250929`, while the commit says `exec (deepseek)`. Fix the signature so model attribution is truthful (AGENTS §10).

### Fix round 1

*— claude-opus-5-5, 2026-11-17* (executor of fix round 1; branch `feat/model-diagrams`)

Scope: the four review-1 findings, plus the two gaps the fixes themselves
exposed. No test weakened, no finding deferred.

#### Repro, before any edit (`.tentacle/tmp/model-diagrams/fix1/repro.ts`)

All four reproduced exactly as the review described:

```
#1a {"ok":true,"canonical":"flowchart TD","type":"flowchart","notes":[],"lineMap":[1]}   ← graph TD;A-->B;B-->C: edges gone, no note
#1b {"ok":true,"canonical":"sequenceDiagram\nA->>B: hi", ...}                            ← `autonumber` silently dropped
#2  {"ok":false,"errors":["line 2: unknown diagram type \"\"theme\":\"dark\"\" — …"]}     ← multi-line init refused
#3a ["line 5: \"section A\" (line 3) is never closed — add \"end\""]                      ← gantt: wrong advice
#3b ["line 4: \"state \\\"Idle\\\" as I\" (line 2) is never closed — add \"end\""]          ← stateDiagram: wrong advice
#4a {"ok":true,"canonical":"flowchart TD\nA-->B; click A href \"javascript:alert(1)\"", …} ← click survives, no note
#4b {"ok":true,"canonical":"flowchart TD\nA-->B; style A fill:#f00", …}                    ← style survives, no note
```

#### Finding 1 (HIGH) — content after the type line is dropped

`lint.ts` `canonicalTypeLine`: only the leading keyword is rewritten; the rest of
the line (statements, `autonumber`, …) is kept. The flowchart direction is
defaulted to `TD` only when the type statement does not state one, and
`directionOf` now reads the type statement only (so `flowchart;A --> LR` is a node
named `LR`, not `RL`/`LR` direction).

This exposed **two downstream gaps** the review's "0 nodes" cue points at, both
fixed here as part of the same finding — a kept one-liner that the model still
reads as empty is the same silent wrong state:

- `model.ts` `flowOf`/`sequenceOf` read the body from `lines.slice(1)` only, so a
  one-liner came back `kind: "other"` (tool stats `0 nodes`). They now read the
  type line's statements too (`model1.ts` before → `kind: other`; after →
  `flowchart 3 nodes, 2 links`, `sequence 1 messages`).
- `flowOf`'s direction was read from the whole type line, so `flowchart;A --> LR`
  became `LR`. Scoped to the type statement.

#### Finding 2 (MEDIUM) — a multi-line `%%{init}%%` before the type line

`lint.ts`: the directive pass now runs **before** the type-line search (was step
4 after step 3), so a directive's inner lines are dropped before anything reads
them as the diagram. `lineMap` still maps to the model's lines.

#### Finding 3 (MEDIUM) — wrong "add end" advice

`explain.ts`: `BLOCK_KEYWORDS` is now keyed by diagram type
(`flowchart → subgraph`; `sequenceDiagram → alt/opt/loop/par/critical/break/rect/box`)
— `section` and `state` are gone. And the rule fires only when the fault is at
the source's **last content line** (where a missing `end` actually surfaces): a
mid-source fault is explained as itself, so the retry loop converges. A real
unclosed `subgraph`/`alt` at EOF still gets the advice (pinned).

#### Finding 4 (MEDIUM) — `click`/`style` after `;`

`lint.ts`: a line is split into `;`-separated statements (quote-aware, so a `;`
inside a `click A href "…"` or a label is text) and each statement is judged on
its own; the styling/click statements are dropped and counted, the rest of the
line is kept. A `;` inside a `%%` comment is prose, not a join. The type line's
own statement is never styled away.

#### Red before green (§9) and mutation checks

Red: `.tentacle/tmp/model-diagrams/fix1/red.ts` — 9 assertions failing on the
buggy tree, and after the fixes `ALL PASS` plus 3 extra cases (unclosed
`subgraph`/`alt` still bite; a mid-source fault is not blamed on a block).

Each fix's test was shown failing with the fix mutated back out, then reverted
(`rg MUTANT packages/core/src` → 0 after):

| Mutant | Reverted fix | Result |
|---|---|---|
| `canonicalTypeLine` returns keyword+direction only | finding 1 | 1 fail — `a one-liner keeps the statements after its type line` |
| directive's `}%%` scan disabled | finding 2 | 1 fail — `a multi-line %%{init}%% … is dropped too` |
| `if (statements.length > 1 && false)` | finding 4 | 2 fail — both `;` tests |
| `if (lost && false)` | finding 4 (unified loop) | 4 fail — both `;` tests + the existing styling test + the type-line click test |
| `if (false && faultLine < lastContentLine(lines))` | finding 3 (EOF half) | 1 fail — `a mid-source fault is explained as itself` |
| `BLOCK_KEYWORDS` replaced by the flat old list | finding 3 (type half) | 2 fail — gantt and state `as` tests |
| `typeHead.slice(0)` in `flowOf` | finding 1 (model gap) | 8 fail incl. `a one-line flowchart keeps its nodes and links` |
| direction read from the whole type line | finding 1 (direction) | 1 fail — `a direction is read from the type statement only` |

The first EOF mutant did **not** bite: my initial "closed subgraph further down"
test was vacuous (the `end` pops the frame regardless). Replaced with a source
that has an unclosed block *and* a mid-source fault, which is the property the
EOF condition actually decides.

#### Drift from the Implementation

The Implementation's D3 table says `click` is "always dropped"; its wording
implies whole lines. The as-built drops a `;`-joined *statement*, which is what
the guarantee needs (no click reaches a renderer) without losing the edges that
share the line. No plan section needed changing beyond that reading.

#### Gate

```
$ bunx tsc --noEmit    → clean (no output)
$ bun run lint         → Checked 1856 files. No fixes applied.   (0 errors)
$ bun test packages/core/test/diagram-{lint,explain,model,summary}.test.ts
  63 pass · 0 fail · 160 expect() calls   (4 files)
$ bun test             → 13493 pass · 5 skip · 0 fail · 106501 expect() calls
                         Ran 13498 tests across 960 files. [444.70s]
```

The 5 skips are the opt-in ones (live-k8s, live-docker, the real-socket
keepalive and the two that ride them). No `protocol.d/` note and no changelog
fragment: D1 is pure core code and adds no user-visible behaviour by itself
(the fragment rides the tool slice, D2).

Per finding: **1 FIXED**, **2 FIXED**, **3 FIXED**, **4 FIXED**.

### Round 2

*— claude-opus-5-5, 2026-11-17* (fresh-context reviewer; diff `HEAD~1`, commit 9d99fc6c)

**Verdict: PASS (APPROVE-WITH-NITS).**

Gate (reviewer reran it): touched tests 66 pass / 0 fail (5 files); `bun run typecheck` clean; `bun run lint` clean (1856 files). The full suite was not rerun.

Each round-1 finding was re-broken by a mutation. Every mutation made tests fail; all were reverted, and `git status` is empty:
- #1: `canonicalTypeLine` cuts the line at the first `;` → the one-liner and "stays on its line" lint tests fail.
- #2: the directive pass skips line 0 → 2 fail, including the multi-line init test.
- #3a: `section`/`state` put back in `BLOCK_KEYWORDS` → the gantt and state tests fail.
- #3b: the fault-at-EOF guard is neutralised → the mid-source test fails.
- #4: `splitStatements` no longer splits → 3 fail (`;` click/style, quoted href, click on the type line).

Regression probes (`.tentacle/tmp/model-diagrams/review/b.ts`):
- `graph TD;A-->B;B-->C`: lint keeps it, and the model reads 3 nodes / 2 edges.
- `graph LR;…;style A …;…`: the style is dropped with a note, and the direction stays LR.
- A one-line init: dropped with a note.
- A sequence message with `;`: kept intact.
- erDiagram: unchanged.

Nits (LOW, not blocking):
- (a) A free-text type (timeline/mindmap) with `…; style x` loses that text. It does come with a note, so the loss is not silent.
- (b) An unbalanced `"` hides a later `; click`. The source would not parse in mermaid anyway, and strict mode plus the sandbox still apply.
