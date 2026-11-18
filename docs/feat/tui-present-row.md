# feat/tui-present-row — `● Present <title>`, and a click opens it

> **Status:** execution
> **Branch:** `feat/tui-present-row`
> **Type:** feat · **Size:** S · **Blast:** contained · **Suited:** Opus exec + Opus review
> **Changelog:** `changelog.d/tui-present-row.changed.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner request (TODO.md, 2026-11-18). The TUI row of the `present` tool
(docs/feat/model-artifacts.md D8/S6b) printed the raw JSON args — for generated
content that is the title AND the whole HTML page — and, when the row had no card
(a resume the daemon's list did not join, an older daemon), the model's verbose
receipt. Owner wants `● Present <title>` only, at most a short grey result, and a
CLICK on the row that opens the artifact with the Mac's default app through the
EXISTING safe path (`artifact-open.ts` plan + `os-open.ts`: our temp names,
CSP-wrapped HTML/SVG, `other` never opened, pod bytes always ask) — for inline
content and path artifacts (pdf, images) alike.

**Repro** (`.tentacle/tmp/tui-present-row/repro.test.ts`, run with
`bun test ./.tentacle/tmp/tui-present-row/repro.test.ts`; renders a `present`
`ToolItem` through `itemLines` at width 80, SGR stripped):

```ts
import { test } from "bun:test";
import { itemLines } from "../../../packages/tui/src/render-lines.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const meta = { artifactId: "a3", version: 1, sha256: "a".repeat(64), size: 593,
  mimeType: "text/html", kind: "html", title: "Latency report", callId: "c1", createdAt: 1 } as const;
const args = JSON.stringify({ title: "Latency report",
  content: `<!DOCTYPE html><html><body><h1>p99</h1>${"x".repeat(400)}</body></html>` });
const base = { kind: "tool", id: "c1", name: "present", args, status: "ok",
  resultText: 'Presented "Latency report" to the user as artifact a3 v1 (html, 593 B). They open it from the card in the transcript.' } as const;
test("repro", () => {
  const cases = [
    ["with card", { ...base, detail: { kind: "artifact", artifact: meta } }],
    ["no card (resume/older)", base],
    ["no title, id only", { ...base, args: JSON.stringify({ id: "a3", path: "r.pdf" }) }],
  ] as const;
  for (const [label, item] of cases) {
    console.log(`--- ${label} @80`);
    for (const l of itemLines(item as never, { expandAll: false, width: 80 })) console.log(JSON.stringify(strip(l)));
  }
});
```

Before (main @ c7eb2c01, 2026-11-18):

```
--- with card @80
"● Present {\"title\":\"Latency report\",\"content\":\"<!DOCTYPE html><html><body><h1>p…"
"⎿ ◈ Latency report HTML page · 593 B · ^X^O open"
--- no card (resume/older) @80
"● Present {\"title\":\"Latency report\",\"content\":\"<!DOCTYPE html><html><body><h1>p…"
"⎿ Presented \"Latency report\" to the user as artifact a3 v1 (html, 593 B). They open it from the card in the transcript."
--- no title, id only @80
"● Present {\"id\":\"a3\",\"path\":\"r.pdf\"}"
"⎿ Presented \"Latency report\" to the user as artifact a3 v1 (html, 593 B). They open it from the card in the transcript."
```

After (this branch):

```
--- with card @80
"● Present Latency report"
"⎿ a3 · HTML page · 593 B"
--- no card (resume/older) @80
"● Present Latency report"
--- no title, id only @80
"● Present a3"
```

A click on a tool header today only toggles its command expansion
(docs/feat/tui-tool-expand.md); nothing opened an artifact by mouse.

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

A click on a call's HEADER row is already resolved to that call's id, purely, from
the laid frame: `tool-hit.ts: toolCallAtViewport` (`packages/tui/src/tool-hit.ts:74`)
called by `mouse-stream.ts: dispatchMouse` on a completed click. So opening is ONE
more branch in that pure dispatch, keyed by the id — no new hit test.

### Preconditions

- The App has ONE artifact decision path: `runArtifact(meta, artifactStep(meta,
  artifactOrigin, intent))` (`App.tsx`, the `runArtifact` const), used by `^X^O`
  and `/artifacts` Enter. `artifactStep` (`artifact-open.ts`) decides notice /
  confirm (pod, network) / open; the origin is the RUNTIME's (`shownInPod`).
- A `present` row's card meta is `ToolItem.detail` (`kind: "artifact"`), live from
  `tool_result.details` (`state.ts`) or joined on resume (`artifacts-panel.ts:
  withArtifactDetails`) — the same items `layoutTranscript(st.items)` lays out.
- `toolSubtitle` (`render-lines.ts`) is the one place a tool's header target is
  chosen, and the header is cut to the width by `fitSubtitle` (`tool-expand.ts:106`).
- The `present` tool's args: `title` (required), exactly one of `path`/`content`,
  optional `id` (`packages/tools/src/present.ts:40`).

### Design

- **Header** — `toolSubtitle` case `present`: `title` → args `id` → the card's
  `artifactId` → `path` → `""`. Never `tool.args`.
- **Result** — with a card: ONE grey row `presentResultLine(meta, inPod)` =
  `<artifactId> · <artifactCard(meta).line2>` (type, dims/size, `vN`, `from the
  pod`, `no longer available` — core's view-model, shared with the phone), cut to
  the width. No card and `ok`: no body (the result text is the model's receipt).
  Error: the error text as before. The `▣ … ^X^O open` card is dropped (owner:
  minimal); `^X^O` and `/artifacts` keep working.
- **Click** — `MouseSnapshot.artifactOf(id)` (App: `artifactOfCall(st.items, id)`,
  pure, `artifact-open.ts`). In `dispatchMouse`, a completed click on a header
  whose row carries an artifact emits `{kind: "openArtifact", artifact}` (also
  under Ctrl+O: a `present` header has nothing to expand); every other header
  keeps `toggleTool`. `useMouse` executes it through a new `MouseHost.openArtifact`
  port; App wires it (ref-backed, stable identity) to `runArtifact(meta,
  artifactStep(meta, artifactOrigin, "open"))` — the existing safe path, unchanged.
- **Keyboard** — the transcript has NO row-focus/selection model (keys go to the
  input; only panels have a cursor). The keyboard ways stay `Ctrl+X Ctrl+O`
  (newest artifact) and `/artifacts` (any artifact/version). A per-row focus is out
  of scope.

### Files

`packages/tui/src/render-lines.ts` (subtitle, result row, no-card body) ·
`artifact-open.ts` (`artifactOfCall`) · `mouse-stream.ts` (snapshot field, effect,
dispatch) · `useMouse.ts` (port + effect) · `App.tsx` (snapshot field, port wiring).

### Failure modes

- Row with no card yet (running, failed, unjoined resume): `artifactOf` →
  undefined → the click is the plain toggle; nothing read.
- `other` kind: `artifactStep` → notice, never the opener (test).
- Pod origin: confirm line first, nothing read before `y`, not remembered (test).
- No opener / no `readArtifact` on the runtime: `runArtifact`'s existing notice.
- Read failure: `artifactOpenError` notice (existing path).
- Click on the grey row or anywhere but the header: text selection, unchanged (test).
- Streaming args (partial JSON): the subtitle falls back, never the raw fragment.

### Tests

- `artifact-card.test.ts`: header = title (no `{`, no `DOCTYPE`); exactly two rows
  `● Present Latency report` / `⎿ a3 · HTML page · 593 B`; path image row; missing
  title → id → card id → path; long title cut with `…` at 40/80; `v2`; `other`;
  `from the pod`; no card → no body; error still shown.
- `mouse-stream.test.ts`: header + artifact → `openArtifact` (that meta, selection
  cleared); under Ctrl+O still opens; a non-call row never asks `artifactOf`.
- `app-artifacts.test.tsx` (ink-testing-library, SGR click, spy opener — never
  spawns): inline HTML → `bbbbbbbb.html`, `csp`, no network; path PNG →
  `aaaaaaaa.png`, unwrapped; pod → confirm, no read, `y` opens, asks again;
  `other` → notice, no read; click on the grey row → nothing. Existing card
  assertions updated to the new row.

## Execution

*— claude-opus-5-5, 2026-11-18*

- Repro run on the branch base before any edit (output above, "Before").
- Implemented as planned; no drift. `ARTIFACT_OPEN_HINT` (`render-lines.ts`) had
  no other user and was removed with the card. The model-facing result text of
  `present` ("…from the card in the transcript") is unchanged (tools package, out
  of scope).
- **Red → green:** the new/updated tests run against `HEAD`'s five sources (copied
  over from `git show HEAD:…`, then restored from a backup in
  `.tentacle/tmp/tui-present-row/bak/`): **23 fail / 46 pass**; on the branch:
  **69 pass / 0 fail** (`artifact-card`, `mouse-stream`, `app-artifacts`).
- **Mutation:** (1) App `artifactOf` → always undefined: the 4 App click tests
  fail; (2) the click's origin hard-coded to `"local"`: the pod-asks test fails.
  Both reverted.
- Gate: `bunx tsc --noEmit` clean; `bun run lint` clean (2085 files, after one
  `biome check --write` on `artifact-card.test.ts`); full `bun test`: **15336 pass,
  5 skip, 0 fail** (15341 tests / 1090 files). The skips are the opt-in suites
  (this branch adds none).
- Unverified: a real terminal + `open` on macOS (the opener port is spied in
  tests; `os-open.ts` is unchanged). Verify with `tentacle`, ask for a `present`,
  click the header.
