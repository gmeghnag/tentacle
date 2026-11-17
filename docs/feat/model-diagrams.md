# feat/model-diagrams — the model draws Mermaid diagrams in the conversation (iPhone WebView, Mac TUI in ASCII)

> **Status:** implementation APPROVED (D1–D2 orchestrator 2026-11-17; D3–D7 after the owner's visual picks, 2026-11-17 09:40)
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

**Owner answers (2026-11-17 09:40):** Q1 — **all A** (1A 2A 3A 4A 5A 6A), plus a **setting to switch the iPhone diagrams to the B look** (soft-filled nodes / participants, caption below): one setting `diagrams.style: "outline" | "filled"`, default `"outline"`, in the config (read by the daemon/TUI where relevant) AND as a toggle in the iPhone Settings (same place as the other display settings), applied to every diagram type that has a B variant (flowchart, sequence; others follow the same fill rule). Q6 — 420 pt (recommendation; owner did not object).

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

## Execution — slice D2

*— claude-opus-5-5, 2026-11-17* (executor; branch `feat/model-diagrams`, uncommitted working tree)

Scope: **slice D2 only** (Files item 2): the probe, then the `diagram` tool, the
daemon-side `parseMermaid`, registration, the child-agent exclusion and the
subtitle cases. Nothing of D3–D7. `TODO.md` untouched. Note: D1 is already merged
to `main` (`425fb610`); this branch is behind `main` and was not re-merged (no
commits by the executor). `main..feat/model-artifacts` is now 0 commits, so D6/D7's
"artifacts merged" gate looks open — the orchestrator should confirm.

### 0. Load-bearing check, re-run first — **HOLDS (with a shim scoped to the import)**

Probe `.tentacle/tmp/model-diagrams/probe-d2/` (`mermaid@11.17.2` exact, `linkedom@0.18.15`):

```
$ bun parse.ts            # bare bun
flowchart  valid:THROWS DOMPurify.addHook is not a function …   (same for class, state, gantt, mindmap, timeline, journey; gitGraph: DOMPurify.sanitize)
sequence   valid:ok | er valid:ok
$ bun parse.ts shim       # linkedom → window/document/DOMParser/Element/Node/HTMLElement
flowchart  valid:ok | broken:throws [jison {"first_line":2,…,"first_column":10}] Parse error on line 2:
sequence   valid:ok | broken:throws [jison {"first_line":2,…,"first_column":6}]
class      valid:ok | broken:throws [jison {"first_line":3,…}]
state      valid:ok | broken:throws [jison {"first_line":2,…,"first_column":10}]
er         valid:ok | broken:throws [jison {"first_line":2,…,"first_column":6}]
gantt      valid:ok | broken:throws [jison {"first_line":4,"last_line":5,…}] Parse error on line 5:
mindmap    valid:ok | broken:throws [jison {"first_line":2,"last_line":4,…}] Parse error on line 4:
timeline   valid:ok | broken:throws [jison {"first_line":2,"last_line":3,…}] Parse error on line 3:
journey    valid:ok | broken:ACCEPTED        ← fixture too weak; "Do it 5 Me" (no colons) is refused, used in T2.0
gitGraph   valid:ok | broken:throws [langium line 3 col 9] Parsing failed: Parse error on line 3, column 9
$ bun scoped.ts           # shim set for the IMPORT only, globals deleted after, then parse
after import: typeof window = undefined
flowchart ok · flowchart-bad throws · sequence/class/state/er/gantt/mindmap/timeline/journey/gitGraph ok · journey-bad, gitGraph-bad throw
--- writes (0)            ← no console.* / stderr write from mermaid 11.17.2 (11.4.1 printed a chevrotain warning)
$ bun size.ts             # Bun.build compile + minify (the repo's buildBinary options)
empty 67.6 MiB · entry 71.4 MiB · delta 3.8 MiB · compiled run: ok
$ bun size2.ts            # scoped.ts compiled → the same 13 results as above, writes (0)
```

Decision rule → "shim works": the shim lives in the lazily imported path of
`diagram-parse.ts`, and only for the duration of mermaid's import. Binary size
delta (Owner Q3): **+3.8 MiB**.

### 1. As built (dependency order)

| File | What |
|---|---|
| `packages/tools/package.json` · `bun.lock` | `mermaid` `11.17.2` and `linkedom` `0.18.15`, exact. Lockfile: +260 lines additive; two existing entries (`entities@4.5.0`, `uuid@8.3.2`) only re-nested under their dependents. |
| `packages/tools/src/diagram-parse.ts` | `parseMermaid(src, {loader?, budgetMs?}) → {ok:true} \| {ok:false, reason:"invalid", error} \| {…"unavailable", detail} \| {…"timeout"}`, never throws. `loadMermaid` sets the 6 DOM globals, imports mermaid, `initialize({startOnLoad:false, securityLevel:"strict", logLevel:"fatal", maxEdges:500})`, and restores the globals' previous descriptors in a `finally`. `cachedMermaidLoader` = one load per process, a failed load forgotten. Budget `MERMAID_PARSE_BUDGET_MS = 2000` races the parse only (not the import). |
| `packages/tools/src/diagram.ts` | `diagram` tool: `DIAGRAM_JSON_SCHEMA` (`title` 1..120, `mermaid` ≤ `DIAGRAM_CAPS.bytes`, both required, no extra keys), `DIAGRAM_ARGUMENTS_HINT` + `diagramArgumentsHint` (a raw line break inside the `mermaid` string, or a backtick-quoted value), the ~1 KB description, `createDiagramTool({parse?})` (seam) and `diagramTool`. `execute`: field errors (all at once) → `lintDiagram` → `parseMermaid(canonical)` → `explainMermaidError(error, canonical, lineMap)` / "not available" / "too complex — split it" → else `summarizeDiagram(diagramModel(…), type, {title, notes}).line`. `permission: "none"`, `concurrency: () => []`. |
| `packages/tools/src/index.ts` | exports both modules (mermaid stays behind the dynamic import). |
| `packages/cli/src/wiring.ts` | `tools.register(diagramTool)` right after `chartTool`. |
| `packages/agent/src/subagent.ts` | `DIAGRAM_TOOL_NAME` in both "never a child" lists (P6). |
| `packages/tui/src/render-lines.ts` · `apps/mobile/src/tool-summary.ts` | `case "diagram":` falls through to chart's `str("title") ?? args`. |
| tests | `packages/tools/test/diagram.test.ts` (30), `packages/cli/test/diagram-wiring.test.ts` (3), a diagram pair in `apps/mobile/test/tool-summary.test.ts`'s TUI-parity table, one test in `packages/tui/test/render-lines.test.ts`, and `"diagram"` added to the pinned start-up tool list in `packages/cli/test/wiring.test.ts:986`. |
| `changelog.d/model-diagrams.added.md` | D1's fragment (still unreleased on `main`) rewritten to describe the tool — the one fragment for this slug. |

### 2. Red before green (§9)

Tests written first against stubs with the real types (`parseMermaid` → `{ok:true}`,
the tool → `{content:""}`, the hint → `undefined`):
`bun test packages/tools/test/diagram.test.ts` → **25 fail / 4 pass**, every fail on
an assertion. The 4 green on the stub: the "no `window` left" and "settles in time"
guards and the "no hint" negatives (their mutants M2/M5/M9 bite below), and the T2.6
pin (green from the `package.json` edit, made before the stubs). Then the wiring test
→ **1 fail** (T2.7: the child got `diagram`) before the `subagent.ts` edit; the two
subtitle tests → **2 fail** (the raw JSON as subtitle) before the `case`. After the
code: 30 + 3 + 144 pass.

### 3. Mutation checks (`.tentacle/tmp/model-diagrams/probe-d2/mutate.ts`; each applied by exact match, narrow test run, file restored; `cmp` against backups after → identical)

| # | Mutant | Result |
|---|---|---|
| **M1** | no DOM shim (the load-bearing target) | **10 fail** — T2.0 for every DOMPurify-dependent type |
| M2 | shim globals never restored | 1 fail — "the DOM shim does not outlive the import" |
| M3 | `lineMap` not passed to the explainer | 1 fail — "a fenced source keeps the MODEL's line numbers" |
| M4 | a failed import throws instead of `unavailable` | 1 fail — T2.4 |
| M5 | no budget race | 1 fail — T2.5 |
| M6 | a failed load stays cached | **0 fail on the first run** — T2.4 injected its own loader and bypassed the cache. Fixed: the cache became `cachedMermaidLoader` and a test drives it (fail → retry → cached). Re-run: **1 fail** |
| M6b | no cache at all | 1 fail — the same test |
| M7 | notes dropped from the result | 1 fail — T2.1 notes |
| M8 | lint skipped (raw source to mermaid) | 3 fail — notes, fenced line, `pie` → chart |
| M9 | the hint never offered | 2 fail — newline and backtick hints |
| M10 | `wiring.ts` does not register it | 3 fail — the wiring tests |
| M11 | the child filter misses it (`subagent.ts:408`) | 1 fail — T2.7 |
| M12 | TUI subtitle case removed | 1 fail — the render-lines test (the phone's parity table bites the same way) |

Not mutable: the `readOnlyType` list (`subagent.ts:643`). `diagram`'s concurrency is
`[]`, which is read-class whether or not it is listed, so removing it is an
equivalent mutant (same as `chart`'s entry there).

### 4. Drift from the Implementation (and why)

1. **mermaid `11.17.2`, not D1's probe version `11.4.1`.** It is the latest 11.x
   (the plan says "`mermaid@11` exact"). D1's explainer was built from 11.4.1
   errors, so T2.0/T2.2 run **real** 11.17.2 errors through it: the `->` sentence
   (`line 2, col 12`), the colon-less message, and a `line ≥ 2` for every type's
   broken fixture all hold. D6/D8 must pin the same version (T2.6's other halves).
2. **The shim is scoped to the import, not resident.** The plan puts it "in a
   lazily imported daemon-only module". The probe showed DOMPurify binds `window`
   only when its module is evaluated. So the globals are restored right after the
   import (pinned by a test and M2): a resident `window` would flip every
   browser-sniffing library in the daemon. The remaining exposure is the import's
   own `await`, once per process.
3. **`parseMermaid` returns no `stats`.** The plan's own D4 says the stats come from
   the D5 model. The tool reads them through `summarizeDiagram(diagramModel(…))`,
   so there is one counter, not two.
4. **The budget does not include the import**, and `Promise.race` only cuts an
   **async** hang. A synchronous loop inside mermaid would block the daemon's
   thread regardless; fixing that needs a worker (not in the plan). Unverified: no
   pathological mermaid input that loops was found or tried.
5. **T2.6 is the daemon half only**: `package.json` pins the version exactly, and
   it is the installed one. The phone bundle header (D6) and the TUI page (D8) do
   not exist yet; their halves join that test then.
6. **`maxEdges: 500`** is set in `initialize` (Owner Q8). It is mermaid's default,
   and no test drives a 501-edge source. Unverified that 11.17 enforces it at
   `parse` rather than at render.
7. **The changelog fragment** was rewritten now (the brief asks for one; D1's
   fragment is still unreleased). D7 must extend this same file.
8. Until D3/D4 (TUI) and D6 (phone), a `diagram` call shows as the generic row
   `Diagram <title>` + the result line, which is D9's old-client path.

No `protocol.d/` note, no `protocol.json` regeneration: no schema, update kind or
log entry changed (a new tool name and its arguments are data, D9).

### 5. Gate

```
$ bunx tsc --noEmit        → clean (no output)
$ bun run lint             → Checked 1860 files. No fixes applied.
$ bun test packages/tools/test/diagram.test.ts                   → 30 pass · 0 fail
$ bun test packages/cli/test/diagram-wiring.test.ts              → 3 pass · 0 fail
$ bun test apps/mobile/test/tool-summary.test.ts packages/tui/test/render-lines.test.ts → 144 pass · 0 fail
$ bun test                 → 13528 pass · 5 skip · 1 fail   (465.71s)
    the 1 fail: packages/cli/test/wiring.test.ts "start-up output pinned" — the pinned
    tool list lacked "diagram" (expected: the tool IS new). Pin updated (:986, with a comment), then
$ bun test packages/cli/test/wiring.test.ts                      → 42 pass · 0 fail
```

The 5 skips are the opt-in ones. The full suite was not re-run after the pin update
(budget: once); the one changed file was re-run on its own, green.

**Per slice: D2 DONE.**

### Semantic fix after main merge (D2)

*— claude-code_2-1-323_agent, 2026-11-17*

**Symptom (reproduced first, §1).** After merging `main` (carrying
`apps/mobile/src/tool-summary.ts` from `feat/mobile-tool-rows`), two tests in
`apps/mobile/test/tool-summary.test.ts` went red — both from ONE cause:

```
(fail) SUMMARISED_TOOLS is the TUI's `toolSubtitle` switch, name for name
       > a `toolSubtitle` case missing from SUMMARISED_TOOLS fails here
  @@ -7,3 +7,2 @@  "chart", -  "diagram",  "fs_edit",     Expected - 1 / Received + 0
(fail) rowSubtitle: the ONE line on a step > shell, search, jobs, agents, skill
  Expected: "Flusso di login"
  Received: "title Flusso di login · mermaid flowchart TD A --> B"
```

**Root cause (one sentence).** D2 added the `diagram` arm to the TUI's
`toolSubtitle` switch, and the mobile side's `subtitleOf` *did* merge with a
mirrored `diagram` case — but `SUMMARISED_TOOLS` (the phone's gate that routes a
name to `subtitleOf` at all, `tool-summary.ts:205`, `:46`) still ended at
`chart`, so `rowSubtitle` sent `diagram` down the MCP flattening instead.

**Fix.** `apps/mobile/src/tool-summary.ts:65-67` — `"diagram"` added to
`SUMMARISED_TOOLS`, with a comment pointing at D2. Nothing else was missing: the
guard now names nothing beyond `diagram`, and `CASES` already carried the two
diagram cases added with D2, both consistent with the TUI's
`str("title") ?? tool.args` (`render-lines.ts:673-677`) — the titled one
(`"Flusso di login"`) and the untitled one (the raw args, unchanged).

Both guard tests are non-vacuous here: they were red before this one-line edit
and green after, with the diff showing exactly `-   "diagram",`.

**Gate.**

```
$ bun test apps/mobile/test/tool-summary.test.ts  → 54 pass · 0 fail
$ bun test packages/tui                           → 2593 pass · 0 fail (178 files)
$ bunx tsc -p apps/mobile --noEmit                → clean (no output)
$ bun run lint                                    → Checked 1955 files. No fixes applied.
```

The full `bun test` was not re-run for this fix (it was green apart from these
two on `main` before the merge); the two packages that own the changed file and
the mirrored rule were re-run on their own, both green.

## Review

*— claude-opus-5-5, 2026-11-17* (fresh-context adversarial reviewer, slice D2 only; diff `main...HEAD`)

**Verdict: APPROVE-WITH-NITS** — no HIGH or MEDIUM finding.

Gate (re-run by the reviewer): `bun test` on the 5 touched files → **219 pass · 0 fail**. `bun run lint` → 1860 files, clean. `bun run typecheck` → clean. The full suite was not re-run.

Mutation: **M1** (the DOM shim never installed) → **10 fail / 20 pass** in `diagram.test.ts`. The file was restored from a backup, `cmp` shows it identical, and `git status` is clean.

Attacks tried:
1. **A synchronous hang blocks the daemon thread.** A dense flowchart (399 lines, 9 KiB, about 1,200 edges) is refused in 7–115 ms. The source never reaches mermaid's layout, because `maxEdges: 500` IS enforced at `parse` in 11.17.2. This settles Execution drift 6, which it marked unverified. The residual risk (a jison loop) is unproven and is documented as drift 4.
2. **The shim leaks.** After the load, `typeof window` is `"undefined"` in a separate process. M2 is pinned by a test.
3. **§7 invariants.** Child exclusion: both lists in `subagent.ts` (:407, :643). No terminal write: `logLevel: "fatal"`, and the probe recorded 0 writes. No protocol or persistence change: correct, no `protocol.d/` note is needed. Every tool is registered in `buildAgent`. Pods get no provider credentials. All hold.

Nits (LOW):
- (a) An edge-cap refusal reads `line 1: Edge limit exceeded… — check the type line and the syntax around it`. The fix it names is wrong; it should say "split it / group into subgraphs". This comes from D1's explainer fallback (`core/diagram/`). Add a fixture when D3/D4 touch it.
- (b) During mermaid's one-time import `await`, `window`/`document` exist process-wide. Concurrent daemon code could observe them. This is documented as drift 2 and accepted.
- (c) Attribution mismatch. The commit `ac95a936` says "exec (deepseek)", but the Execution section is signed `claude-opus-5-5`. One of them is wrong, and §10 signatures exist precisely to track this. The orchestrator should correct it.

The executor behaved well. It reported honestly: the full-suite run before the pin fix, the M6 mutant that did not bite at first and was then fixed, and the unverified items it named. The reviewer is the same model family as the signed executor, so shared blind spots are possible.

## Execution — slice D3

*TUI ASCII renderer only: flowchart, sequence, source highlighting, the `diagram-lines` entry, theme roles. Nothing of D4–D7 (no `render-lines` branch). `TODO.md` untouched.*

### 0. Load-bearing check, re-run first — **HOLDS**
- `bun test packages/tools/test/diagram.test.ts` (it contains T2.0, mermaid parsing in `bun test`): **30 pass, 0 fail**.
- D3 relies on D1's `diagramModel` reading the mockup sources. `.tentacle/tmp/model-diagrams/d3/check-model.ts` on the 5A and 6A sources gives a `flowchart` (6 nodes; shapes rect/decision/cylinder; labels `sì`/`no`) and a `sequence` (3 participants, 4 messages, call/reply).

### 1. As built (dependency order)
1. `packages/tui/src/diagram-canvas.ts` (**new, drift 1**): the shared grid. A line cell stores its DIRECTIONS, so junctions merge by themselves (a box border hit by an edge becomes `┬`, a crossing becomes `┼`). Dotted and thick weights give `╎╌` / `┃━`. A wide grapheme takes 2 cells. Cells carry style names, not colours.
2. `diagram-ascii-flow.ts` — `drawFlow(model, maxWidth) → {rows, width, boxes} | undefined`. Layout steps:
   - Layers: DFS back edges are reversed (their arrowhead is drawn at the start), ranks by longest path, dummy slots for long edges, 2 barycentre sweeps.
   - Cross positions: the average of a left-packed and a right-packed placement, relaxed 4×.
   - Ports: one per edge (`┬`); boxes are widened to `2k+3`.
   - Gaps: stub rows hold the labels, beside their vertical run. Channel rows are ordered so that no two vertical runs share a column. Then the arrow row.
   - One router for all four directions: everything is laid out on an abstract main×cross grid and mapped to TD/BT/LR/RL at draw time. Sideways labels sit on their line (`─ yes ─►`).
   - Subgraphs: a dim titled frame. The title slides past any edge crossing the border.
   - Returns `undefined`, so the caller shows the source, for:
     - a self-loop;
     - a column conflict;
     - a label with no room;
     - a frame that would hold a non-member box;
     - frames that touch or nest;
     - more than 60 nodes;
     - a drawing wider than `maxWidth`.
3. `diagram-ascii-seq.ts` — `drawSequence(model, maxWidth)`. The 6A lifelines draw:
   - calls as `├──►│` and replies as `│◄╌╌┤`;
   - a lost message with `×`;
   - a self-message as a loop;
   - notes as a dim box that hides the lifelines under it.

   It switches to the 6B list (arrows aligned) under 50 cols, or when the lifelines don't fit.
4. `diagram-highlight.ts` — a tolerant tokenizer that splits each line into keyword/id/arrow/string/comment runs; the runs always join back to the line.
5. `theme.ts` — `DiagramRole` + `diagramColor(role, tokens)`. This maps roles onto **existing** tokens: borders/edges/frames dim, decision in the accent, labels as `syntax.string`, source tokens as the syntax tokens. No new colour, and the pinned `Tokens` table is unchanged.
6. `diagram-lines.ts`:
   - `parseDiagramArgs` re-lints the call's own args (a forged call gives `undefined`, so the generic row shows).
   - `diagramToolBody` / `diagramLines` / `diagramView` build the view: a centred caption `title · type` (plus ` · source only in the terminal` when nothing is drawn; ` · ^X^O open` only with `openHint`), then the drawing.
   - Compact with no drawing: `│ `-prefixed highlighted source, cut at 5 lines with the generic `… +N more lines · ctrl+o to expand`.
   - Expanded: the drawing + the whole source.
   - Every row is cut to `width`.
7. Tests: `packages/tui/test/diagram-lines.test.ts` (41 tests, 12 snapshots) + `diagram-fixtures.ts`. They include a seeded random-flowchart generator covering all four directions, cycles, dotted/thick lines, labels, and the cylinder/decision/round shapes.

Frame comparison against the mockups. Snapshot `login 80 — colour off` has the 5A structure:
- `◇  Token valido?  ◇`;
- two exits `╰─┬───┬─╯`;
- `│ sì   │ no` beside their vertical runs;
- the cylinder lip `├───┤`.

It differs from the hand-placed mockup in one way: F (Risposta) is entered from above by two `▼`, not from the sides. Snapshot `phone 80` has the 6A structure; spacing is 2 cells tighter than the mockup. Pixels were not looked at in a terminal (no screenshot this session).

### 2. Red before green (§9) — **drift 2, honest**
The modules were written before the tests, so there is no "test fails on missing code" run. Non-vacuity is instead shown by the 9 mutations below: each was applied by exact match and made a named test fail. T3.4 is the one exception, covered only by its fixture assertions. One test added during the mutation pass (stranger box inside a frame) was RED against mutation M8 before it counted.

### 3. Mutation checks (`.tentacle/tmp/model-diagrams/d3/mutate.ts`; each applied, narrow test run, file restored — `git status` after shows only the intended files)
```
M1 channel order constraint dropped: KILLED (1 fail)   ← T3.2 fuzz walk
M2 in-rank min spacing dropped: KILLED (9 fail)        ← snapshots + T3.3
M3 sequence list fallback removed: KILLED (2 fail)     ← T3.5 <50 cols
M4 width by code units, not cells: KILLED (1 fail)     ← T3.8 CJK
M5 rows not cut to the width: KILLED (1 fail)          ← T3.1 fuzz 20..200
M6 decision ◇ not drawn: KILLED (7 fail)               ← 5A + T3.6
M7 comment not highlighted: KILLED (1 fail)            ← highlighting
M8 frame drawn over a stranger box: KILLED (1 fail)    ← (first SURVIVED → test added)
M9 forged args not re-linted: KILLED (2 fail)          ← forged → generic row
```
T3.2 walks each arrowhead back along the glyphs to a box border. It requires the multiset of `from>to` pairs to equal the model's arrow edges, over 200 seeded random flowcharts. 176 of the 200 are drawn at 400 cols, and the test asserts more than 120 so the property cannot pass vacuously. The other 24 honestly fall back to the source view.

### 4. Drift from the Implementation (and why)
1. **An extra file, `diagram-canvas.ts`.** Flow and sequence share the direction-merging grid; duplicating it would split one behaviour across two modules (§7 "logic in pure modules").
2. **Red-first replaced by mutation evidence** (§2 above).
3. **Theme "diagram tokens"** are a role→existing-token function, not a new `Tokens.diagram` group. The plan (P8) says "no new colours". A new group would also change the byte-pinned dark table.
4. **Sequence `alt`/`loop` blocks are not framed.** The D1 model keeps their kind and title but not which messages they wrap, so a frame would be a guess. A dim line under the drawing names them and points to the source (ctrl+o). Follow-up: add message spans to `SequenceBlock` in core.
5. **Flowchart width tier.** The plan says "a flowchart that does not fit the width". The renderer also falls back for graphs it cannot draw faithfully (see the list in §1.2). The caption says `source only in the terminal` in both cases.
6. **Owner's `diagrams.style: outline|filled`.** The ASCII drawing has no fills, so there is nothing to switch in D3. It concerns the phone (D5/D6) and config (where it is read).
7. **Changelog.** `changelog.d/model-diagrams.added.md` already exists, and D3 has no user-visible effect until D4 wires it. The fragment is left unchanged; D4 should edit its "drawing it inline … follows" sentence.
8. The Review nit (a) about the edge-cap sentence is in core's explainer (D1 code). It is not a D3 renderer change, so it is left for the orchestrator/D4.

### 5. Gate
- `bunx tsc --noEmit`: clean.
- `bun run lint`: clean (0 errors; `biome check --write` was used for formatting; two `noAssignInExpressions` were hand-fixed).
- `bun test packages/tui/test/diagram-lines.test.ts`: 41 pass.
- Theme tests (`theme`, `theme-no-stray`, `theme-contrast`): 19 pass.
- Full `bun test`, run once: **14414 pass, 5 skip, 0 fail**. No skip is in the D3 files. AGENTS §6 pins 3 opt-in skips, and this run did not attribute the other 2 (unverified; `bun test 2>&1 | grep -i skip` names them).
- No schema change, so `protocol.json` was not regenerated; no `protocol.d/` note.

*— claude-opus-5-5, 2026-11-17*

### Fix round 1

**Finding 1 (MEDIUM), forged control/escape bytes reach the drawn rows: FIXED.**
- `packages/tui/src/diagram-lines.ts`: a `CONTROL` regex `[\u0000-\u001f\u007f-\u009f]/g` (the `subagent-notify.ts:29` rule). `diagramView` now replaces every C0/C1 control with a space before anything is laid out:
  - in the title;
  - in each line of the canonical source (newlines kept), which `diagramModel`, the drawings and the source view all read.

  This is the one point every row passes through, so a `DiagramCall` built by hand is cleaned too, not only one that came through `parseDiagramArgs`.
- Test: `diagram-lines.test.ts`, block "forged control bytes never reach a drawn row". It forges OSC 52 + `ESC[2J` + C1 CSI + CR in 4 places: title, flowchart node label, `classDiagram` source line, sequence message. Each is checked compact and expanded, with `color: false` so any control byte in the output can only come from the input. It asserts no line matches `[\u0000-\u001f\u007f-\u009f]`.

**Red before green:** on the unfixed code, 4 of 4 failed on the `not.toMatch` assertion (not on an import). The sequence case also failed, through its source view. After the fix: 45 of 45 pass.

**Mutations** (`.tentacle/tmp/model-diagrams/fix-d3/mutate.ts`, run from the main repo root's `.tentacle/tmp`; each applied by exact match, narrow test run, file restored → `restored: true`, `git status` shows only the two intended files):
```
F1 title not cleaned: KILLED (1 fail) … > title
F2 source lines not cleaned: KILLED (3 fail) … > flowchart label | … > source view | … > sequence message
```

**Drift:** the cleaning is in `diagramView`, not in `parseDiagramArgs`. Both are pure, and `diagramView` is the single path to a row. The review's "not checked" item is still unverified: whether Ink 5 passes OSC through. The fix makes that moot for this view.

**Gate:** `bunx tsc --noEmit` clean. `bun run lint`: 1977 files, no fixes. Full `bun test`: 14418 pass, 5 skip, 0 fail (the same 5 skips as in the D3 gate).

*— claude-opus-5-5, 2026-11-17*

## Review

**Slice D3, fresh-context adversarial review. Verdict: REQUEST-CHANGES** (1 MEDIUM).

1. **MEDIUM: pod-forged control/escape bytes reach the drawn rows** (`packages/tui/src/diagram-lines.ts:65-66` for the title, `:116-119` for the caption, flow labels at `diagram-ascii-flow.ts:267,270,624`). `parseDiagramArgs` re-lints but strips no C0/C1 controls, and `lintDiagram` does not refuse them. Repro (`.tentacle/tmp/model-diagrams/rev-d3/esc.ts`) puts `\x1b]52;c;…\x07\x1b[2J` (OSC 52 clipboard write + clear screen) in three places:
   - the `title`: ESC present in the output;
   - a flowchart node label `A["x…y"]`: ESC present;
   - a `classDiagram` source line, which reaches the highlighted source view: ESC present.

   A sequence message came out clean. Once D4 hands these rows to Ink, a pod (not trusted, §7) could write the laptop clipboard or corrupt the alt-screen. That contradicts the failure-mode row "Pod forges `rawInput` → … the TUI draws text only". Fix: in this pure module, replace `[\u0000-\u001f\u007f-\u009f]` (tab → space) in the title and in every model label/source line before layout. This is the same rule `subagent-notify.ts:29` uses. Add a test that a forged ESC never appears in `diagramToolBody` output. Not checked: whether Ink 5 passes OSC through unchanged (it does not filter non-SGR escapes as far as this review knows, but no frame was captured).

**Gate (narrow + static):** `bun test packages/tui/test/diagram-lines.test.ts` + theme tests: 77 pass / 0 fail (12 snapshots). `bun run lint`: clean. `bun run typecheck`: clean. Full `bun test` was not re-run in this review.

**Mutation:** sideways edge labels blanked (`diagram-ascii-flow.ts:267`) → KILLED (1 fail, snapshot `loop 80`). File restored from a copy; `git status` clean afterwards.

**Attacks tried:**
- (a) Escape injection: finding 1.
- (b) Label survival over 400 seeded random flowcharts at 400 cols: 354 drawn, 0 with a missing node or edge label. T3.4 holds beyond its fixtures.
- (c) Widths 1–19 (outside the T3.1 fuzz), with a CJK and an ASCII title, on 4 fixtures, compact and expanded: 0 lines wider than `width`.
- (d) 3000-message sequence: refused upstream by lint (`undefined` → generic row).
- (e) 60-node flowchart: 1 ms. No render-thread stall.

**Holds:**
- Pure modules, no I/O, no terminal writes (§7).
- Forged or invalid args → `undefined` (M9).
- Theme roles map onto existing tokens.
- Drift items 1–8 are reasonable and honestly stated.

**Executor:** candid about the red-first drift, and backed it with 9 mutations. **Reviewer = same model (claude-opus-5-5) as the executor:** only the context is fresh, so blind spots may be shared.

*— claude-opus-5-5, 2026-11-17*

### Round 2

**Verdict: PASS.** Finding 1 is fixed in `b389554c`.

- **Fix:** `diagram-lines.ts:47-49,94-101` replaces C0/C1 controls with a space in the title and in each source line. It does this BEFORE `diagramModel`, so labels, caption and source view are all cleaned. The round-1 repro (`rev-d3/esc.ts`) is now clean in all 4 cases.
- **Mutations** (each restored from a copy; `git status` clean afterwards):
  - title cleaning dropped → KILLED (`title`);
  - source cleaning dropped → KILLED (3 fails: flowchart label, source view, sequence message).
- **Regressions:** `diagram-lines` + theme tests: 81 pass / 0 fail. All 12 snapshots are unchanged, so the drawings did not change. `bun run lint` and `bun run typecheck` are clean. Full `bun test` was not re-run.
- **Nit, not blocking:** the exported `parseDiagramArgs` still returns the raw title. D4 must render it only through `diagramView`, and should not show `call.title` in its own row.
- **Correction to round 1:** the executor commits are tagged `deepseek`, so the reviewer is a DIFFERENT model family, not the same one.

*— claude-opus-5-5, 2026-11-17*

## Execution — slice D4

*TUI wiring only: the `diagramRow` branch in `render-lines.ts` (a sibling of `chartRow`), its tests, and the changelog sentence D3 deferred. Nothing of D5–D7 (no phone, no artifacts, no `openHint`). `TODO.md` untouched.*

### 0. Load-bearing check, re-run first — **HOLDS**

The D4 plan names P3 as its seam: *a tool may draw itself in its row's place* — `chartRow` → an early return in `toolLines` (`render-lines.ts:788-793`), a per-item memo keyed on the layout inputs, per-id expand via `expandedIds` + Ctrl+O via `expandAll`. Re-run on this branch:

- `bun test packages/tui/test/app.test.tsx -t "a chart in the App"` → **7 pass, 0 fail**. The seam is real and reachable through the App.
- `bun test packages/tui/test/diagram-lines.test.ts` (D3's renderer, the thing D4 wires) → **45 pass, 0 fail**.
- `bun test packages/tools/test/diagram.test.ts` (D2's tool, whose `args` D4 reads) → **30 pass, 0 fail**.

So a `diagram` call's arguments reach the TUI and the renderer draws them; what was missing is only the branch. Confirmed empirically, not by reading: before the change a `diagram` call rendered `● Diagram Flusso di login` (see §2).

### 1. As built (dependency order)

1. **Red first (§9).** `packages/tui/test/app-diagram.test.tsx` (7 tests) was written and run against the un-branched code: **1 pass, 6 fail**. The one pass is honest and vacuous — the forged-source test asserts the row is the generic one, which is what every row was. Its non-vacuity is shown by mutation M1/M8 below, not by that red run.
2. `packages/tui/src/render-lines.ts`:
   - `DIAGRAM_TOOL = "diagram"` (`:100-101`), a literal for the reason `CHART_TOOL` is one (`:94-98`): the TUI does not depend on `@tentacle/tools`, and the name is data on the wire.
   - `diagramRow(tool, width, opts)` (`:785-828`): name guard → settled-call guard (`running`/`queued` keep the generic row) → the same `expanded` computation the other rows use → a `WeakMap<ToolItem, Map<key, rows|null>>` memo keyed `${width}|${expanded?1:0}` → `diagramToolBody(tool.args, { width, expanded })` → `undefined` when the renderer refuses.
   - the branch in `toolLines` (`:839-848`), right after the chart's, returning the rows in the item's place (no bullet, no `● Diagram` header, no `⎿` connector).
   - `openHint` is deliberately **not** passed: the `^X^O` chord cannot open a diagram until D7 adds the artifact kind, and a hint the key does not honour would be a lie (D3's caption already supports it; D7 turns it on).
3. `packages/tui/test/diagram-row.test.ts` (9 tests): the narrow, pure seam — no chrome, caption is row 0, `expandedIds` ≡ `expandAll`, the width in the memo key (drawing ⇄ source on the SAME item), forged args → generic row (6 shapes), `running`/`queued` → generic row, another tool's row untouched (including one whose args are diagram-shaped), every row within the width at 8 widths × 2 tiers, no `process.stdout` write.
4. `packages/tui/test/app-diagram.test.tsx` (7 tests): the frames T4 names — live through the real `Agent` + `createDiagramTool({ parse })`; after a resume from `messagesToItems`; Ctrl+O expand/collapse; a click on the caption (row 0) expanding it; a resize 120 → 50 → 120; a forged source; a `process.stdout` spy.
5. `changelog.d/model-diagrams.added.md`: D3's deferred sentence replaced — the terminal drawing (flowchart boxes/decisions, sequence lifelines), `ctrl+o`/caption-click for the source, and the source fallback for a type the terminal cannot draw; the phone renderer still "follows".

### 2. Red before green (§9)

`bun test packages/tui/test/app-diagram.test.tsx` on the code without the branch: **1 pass, 6 fail**, each on its own assertion (not an import):
- live: `Expected to contain: "╭"` (received `● Diagram Flusso di login`);
- resume: the same;
- Ctrl+O: no source rows;
- click: `captionRow` found no caption → `Expected: > 0, Received: 0`;
- resize: no box at 120;
- stdout spy: no box drawn.

Two honest adjustments made during the red→green loop, both stated rather than hidden:
- `ink-testing-library`'s terminal is 24 rows × 100 cols, and a drawn diagram is taller: an overflowing frame loses its **top** rows (the caption, so the click target). The tests now mount, then commit an 80-row screen at 120 cols (`mountApp`), the order `app.test.tsx` uses so the App's resize subscription is already live.
- The resize fixture's first draft was a 6-node flowchart that still fit 50 cols; it gained a seventh node and an extra edge so the tier really changes (verified by `.tentacle/tmp/model-diagrams/d4/probe3.ts`: `wide @120 drawn=true`, `wide @50 sourceOnly=true`).
- Three assertions were wrong about the house style, not about the code, and were corrected after the run: the queued row's glyph is `◌` (not `●`) and it carries the title as a *subtitle*; the `shell` tool's label is `Bash`; `SOURCE_ONLY` is cut at narrow widths, so only `source only` is pinned.

### 3. Mutation checks (§9; `.tentacle/tmp/model-diagrams/d4/mutate.ts` — each applied by exact match, both narrow files run, the file restored from a copy; `git status` after shows only the intended three files)

```
M1 diagramRow branch dropped from toolLines:                  KILLED (9 fail)
M2 memo key drops the width:                                   KILLED (2 fail)  ← resize, on one item
M3 expanded ignored (always compact):                          KILLED (3 fail)
M4 tool chrome kept above the drawing:                         KILLED (3 fail)
M5 diagramRow used for every tool:                             KILLED (1 fail)  ← the impostor-tool test
M6 a raw terminal write inside the branch:                     KILLED (2 fail)  ← the stdout spies
M7 only a settled call draws (running guard dropped):          KILLED (1 fail)
M8 the generic-row fallback removed (return [""] on refusal):  KILLED (2 fail)
```

Two mutations earned a test rather than a shrug, which is the point of the exercise:
- **M5 first SURVIVED.** The `shell` case alone could not kill it: hand the diagram renderer a `{"command":"ls -la"}` arg and it refuses, so the row is generic either way. A second case was added — a tool NAMED `draw` carrying valid diagram args — and M5 then died. The guard is pinned on the name, which is what it actually is.
- **M6/M7 first matched the WRONG site.** Their `from` strings existed in `chartRow` too, so the first replacement mutated the chart and the diagram tests stayed green — a false SURVIVED that would have read as "this code is untested". The anchors were widened to the diagram-specific context and both then died. One mutation (M8) was then killed only after its anchor was made unique to `diagramRow`: `bun -e` on the mutated build showed `["● Diagram not json"]`, i.e. the `return [""]` path is swallowed by the generic row below it, and the test that catches it is the forged-args one.

### 4. Drift from the Implementation (and why)

1. **A second test file, `diagram-row.test.ts`.** The plan lists T4's checks only as ink frames. Three of them (the name guard, the `running`/`queued` guard, "every row within the width at 8 widths") are pure `itemLines` properties: an App frame cannot state them, and the first two cannot even fail in a frame. This is the same split `render-lines.ts` already has for the chart (narrow unit tests + `app.test.tsx` frames), so it is the house pattern rather than a new one.
2. **No `openHint`.** The plan's D8 mentions `^X^O apri` in the caption; D4's own T4 does not, and the chord needs D7's artifact kind. Passing `openHint: true` now would advertise a key that does nothing. D7 flips one option.
3. **The changelog fragment is edited, not added.** D3's drift item 7 asked for exactly this; the fragment title and its D1/D2 content are unchanged.
4. **The memo keys on `width|expanded` only** — no glyphs/locale analogue, because a diagram's drawing depends on nothing else. `openHint` will be a third component when D7 passes it.
5. The Review nit about `parseDiagramArgs` returning the raw title is honoured structurally: `toolLines` never shows `call.title` for a diagram — only `diagramView`'s cleaned caption reaches a row (the caption in these frames comes from the renderer, not from `toolSubtitle`).

### 5. Gate

- `bunx tsc --noEmit`: clean.
- `bun run lint`: clean, 1986 files (2 files auto-formatted by `biome check --write`; no hand fixes needed, no `noControlCharactersInRegex` suppression added — the control-byte rule already lives in `diagram-lines.ts`).
- Narrow: `app-diagram` 7 pass, `diagram-row` 9 pass, `diagram-lines` 45 pass, `render-lines`+`chart-lines`+`tool-hit` 222 pass, `app.test.tsx` 123 pass.
- Full `bun test`, run once at the end: **14467 pass, 5 skip, 0 fail** (same 5 skips as the D3 gate: 3 opt-in + 2 pre-existing).
- No schema change, no `protocol.d/` note (a tool name and its arguments are data on the wire, D9). `protocol.json` untouched.

*— claude-opus-5-5, 2026-11-17*
