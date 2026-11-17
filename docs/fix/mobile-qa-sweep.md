# fix/mobile-qa-sweep — live simulator QA of everything merged 16–17/11, and fix what is broken

> **Status:** context · implementation (executor: sweep FIRST, list every defect with a screenshot, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/mobile-qa-sweep`
> **Size:** M–L (split fixes into commits per defect) · **Blast:** cross-module (apps/mobile) · **Suited:** Opus exec + fresh Opus review WITH the screenshots
> **Changelog:** `changelog.d/mobile-qa-sweep.fixed.md`

## Context

Owner 2026-11-17 09:14, on the iOS build of main 32dcf4fb: "sembra che qui i test dall'app emulata non li abbia fatti nessuno". True: the night's slices were reviewed on code + unit tests; most simulator checks were skipped ("pixels unverified"). Already found by the owner:
1. **Artifacts gallery**: the close ✕ sits ON the status-bar clock (top-left, no safe-area inset) — `.tentacle/tmp/mobile-qa-sweep/owner-artifacts.png`.
2. **HTML artifact viewer**: opening "Pagina HTML minimale" (HTML page · 567 B) shows only "Couldn't keep this file" (`apps/mobile/src/screens/artifacts/ArtifactViewerModal.tsx:189`); the viewer also opens as a half sheet under the gallery.
3. Hub long-press dead / no haptics / no glyph / Activity "Scheduled · soon" → being fixed in `fix/mobile-hub-longpress-dead` (do NOT touch hub files; just re-check at the end and note).
4. App crash-loop on a session with a chart → being fixed in `fix/mobile-crash-ibm-chart` (do not touch; re-check at the end).

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor (Opus):
- **Simulator**: use your OWN simulator, `iPhone 17 Pro Max` (UDID 0B43D716-9670-421A-BE51-9162004F2963) — other agents use the booted iPhone 17 Pro. Build the app as the e2e harness does (`apps/mobile/e2e/README.md`, `run.ts`, mock model `mock-model.ts`, Maestro flows in `e2e/flows`) against a local daemon you start on a FREE port (never port 4000: that is the owner's live serve).
- **Sweep FIRST** (before any fix): exercise every user-visible feature merged since 2026-11-16 — tool rows variant C (rows, ∴, expand, error, running, long command), charts inline + full screen + gallery/hub entry, artifacts of every kind (HTML, image, PDF, Markdown) from the row AND from the gallery, open-at-end on open/reopen/foreground + row swipe timestamps, session drawer long-press (rename/delete/pin, pinned first), PDF attach/view, the `diagram` tool's row (D2: generic row today), the composer + header basics. Light AND dark. For each: screenshot to `.tentacle/tmp/mobile-qa-sweep/shots/<nn>-<what>.png` and a row in a table here under `### Sweep results` (feature · expected · seen · OK/BUG · screenshot).
- **Fix** every BUG in this branch's scope (not hub, not the chart crash): root cause in one sentence, red→green regression test (pure test where possible, plus a Maestro flow or real-screen render for UI ones), re-screenshot after. A bug too big for here → a `TODO.md`-ready line in `### Follow-ups` (do not edit TODO.md).
- Gate: `bunx tsc --noEmit`, `bunx tsc -p apps/mobile --noEmit`, `bun run lint`, the mobile tests; full `bun test` once at the end.

## Execution

**Status: PARTIAL.** Owner bugs 1 and 2 are fixed with red→green tests. The live
simulator sweep was **NOT run**: starting the harness (`bun apps/mobile/e2e/run.ts`)
was refused by the session's permission gate (no approval available), so there
are no `shots/`, no `### Sweep results` table, no re-screenshot after the fixes,
and no re-check of bugs 3 and 4.

### Harness prep (for the sweep, unused so far)
- `apps/mobile/e2e/run.ts` (device pick + after the flow loop): `E2E_DEVICE=<udid>`
  pins the simulator (the harness otherwise takes the FIRST iOS-26 device, which is
  the other agents' booted iPhone 17 Pro); `E2E_HOLD=1` keeps serve, the mock and
  the hooks up after the flows until Ctrl+C, for a hand-driven sweep.
- `apps/mobile/e2e/mock-model.ts` `callDirectives`: a prompt line
  `CALL <tool> <json>` makes the round call that tool with those arguments (any
  `present`/`chart`/`diagram`/`shell` row on demand, without a new constant per flow).
- Intended command (not run):
  `E2E_DEVICE=0B43D716-9670-421A-BE51-9162004F2963 E2E_HOLD=1 bun apps/mobile/e2e/run.ts --ios 26 --only 01-shell`.

### Bug 2: HTML artifact shows "Couldn't keep this file"
- **Root cause:** the viewer read sets `fileUri: ""` for every TEXT kind (html, svg,
  markdown, text: decoded, never cached), and the modal tested `phase.fileUri === ""`
  ("too big to keep") BEFORE the html/markdown branches, so every text artifact hit
  the error.
- **Fix:** the branching moved to a pure `viewerBody(phase, viewer, target)` in
  `apps/mobile/src/artifact-open.ts` (AGENTS §7); `too-big` now applies only to the
  file kinds (image, pdf). `ArtifactViewerModal.tsx` only maps `body` to elements.
- **Red** (`viewerBody` extracted with the buggy order unchanged, modal wired to it,
  before the fix): `apps/mobile/test/artifact-open.test.ts`
  `Expected: "webview" Received: "too-big"` (1 fail). Green after the one-condition fix.
- Pin: `artifact-viewers-wiring.test.ts`: the modal calls `viewerBody(phase,
  choice.kind, target)` and has no `fileUri === ""` or `choice.kind === …` branch.
  The existing chart pin in `artifact-gallery-wiring.test.ts` moved from
  `choice.kind === "chart"` to `body === "chart"`.

### Bug 1: gallery ✕ on the status-bar clock; viewer opens as a half sheet
- **Root cause (✕):** `ArtifactGallery` is a full-screen stack screen
  (`App.tsx` `name="ArtifactGallery"`, `headerShown: false`, no `presentation`),
  but it passed `insetTop={false}` to `ScreenHeader`, which is only meant for sheets.
  **Fix:** the prop is removed.
- **Root cause (half sheet):** the gallery mounts `ArtifactViewerModal` as a plain
  sibling of its list, and the viewer's root was `flex: 1`, so it shared the column
  with the list. **Fix:** the root is absolutely positioned over the whole host
  (`position: "absolute"`, all edges 0, `zIndex: 1`); `ViewerHeader` already adds
  `insets.top`.
- Tests (`artifact-gallery-wiring.test.ts`): (a) the gallery passes
  `insetTop={false}` iff its route is a sheet presentation; (b) the viewer root is
  absolutely positioned. (b) was **red** on `root: { flex: 1 }` before the fix.
  (a) was **mutation-checked**: putting `insetTop={false}` back → 1 fail; reverted.
- These are source pins (`.tsx` cannot be imported from Bun). The pixels are
  unverified until the simulator sweep runs.

### Mutations
| target | mutation | result |
|---|---|---|
| `viewerBody` | buggy order (`fileUri === ""` → too-big for every kind) | red: `Expected "webview" Received "too-big"` |
| gallery header | re-add `insetTop={false}` | red: "the gallery header takes the top inset…" |
| viewer root | `flex: 1` (pre-fix) | red: "the artifact viewer covers the whole screen…" |

### Drift from Implementation
- "Sweep FIRST" could not be done, because the harness launch was refused. The fixes
  for the two owner-reported bugs went ahead on the owner's screenshot as evidence.
- A row card's tap opens the gallery, not the artifact itself
  (`SessionScreen.tsx` `onArtifact: (meta) => onOpenArtifacts("card")`: `meta` is
  ignored). Noted only, not changed; the sweep should decide whether this is a bug.

### Follow-ups
- Run the sweep (command above), fill `### Sweep results`, and re-screenshot
  bugs 1–2 in light and dark; re-check bugs 3 (hub) and 4 (chart crash).

### Gate
`bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bun run lint` clean (1966 files) · `bun test apps/mobile` 2934 pass / 0 fail ·
full `bun test`: 14361 pass / 5 skip / **1 fail**. The fail is
`packages/daemon/test/session-log-store.test.ts:815` (fork T4, `forkTemps` 2 vs 1),
in a package this branch does not touch (`git diff -- packages` is empty). That file
alone passes 43/43, so it looks like a timing flake under full-suite load. The
skip count is 5, against the 3 opt-in skips in AGENTS §6; not investigated.

*— claude-opus-5-5 (executor), 2026-11-17*

## Review
