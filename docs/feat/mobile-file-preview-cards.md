# feat/mobile-file-preview-cards — File preview cards in the phone's transcript

> **Status:** review
> **Branch:** `feat/mobile-file-preview-cards`
> **Type:** feat · **Size:** M · **Blast:** contained · **Suited:** Opus exec + simulator screenshots; standard Review
> **Changelog:** `changelog.d/mobile-file-preview-cards.added.md`

## Context

*— claude-opus-5-5, 2026-11-21*

Owner, 2026-11-20 ("WhatsApp-like"): a file the model presents (`present` →
artifact card) should show an inline PREVIEW in the phone's transcript — a PDF's
first page, the image, a markdown / text file's first lines, an HTML snapshot —
plus name, kind · pages · size; a tap opens the existing viewer. Thumbnails are
made ON THE PHONE (iOS QuickLook), cached, offline; loading and unavailable are
honest states (never an empty box). Owner chose mockup **variant A "band on
top"** on 20/11 (`.tentacle/tmp/mobile-file-preview/mockups/index.html`, section
A + the shared spec; https://claude.ai/artifact/W3d7bGq7kd5xTUR2fVv6M4). Owner
rules: minimal, no rounded inset cards, no pure black, never meaning by hue alone.

**What `main` does (verified 2026-11-21, `3a48d4d5`):**

- The card is a 40 pt tile + title + line 2 + chevron
  (`apps/mobile/src/screens/transcript/TranscriptRow.tsx:685-746` on `main`);
  the tile is the kind's text glyph, or an image thumbnail when one is loaded.
- Only images ≤ 1 MiB are ever wanted (`apps/mobile/src/thumbnails.ts:42-44`,
  `wantsThumbnail`) — PDF / HTML / markdown never get a preview.
- **Even that image thumbnail is never fetched**: the port that reads a card's
  bytes, `createArtifactThumbnailSource` (`apps/mobile/src/artifact-thumbnail.ts`),
  is called by nothing —
  ```
  $ rg -n "createArtifactThumbnailSource" apps/mobile --glob '!**/node_modules/**'
  apps/mobile/src/artifact-thumbnail.ts:23:export function createArtifactThumbnailSource(deps: {
  ```
  The screen's only source is `sentPhotoSource` (`App.tsx:1478-1482` on `main`),
  which knows sent photos only, so every card on `main` draws its glyph.
- "Unavailable" is never shown on the phone: the card is built with no state
  (`TranscriptRow.tsx:583`, `artifactCard(tool.artifact)`), so a version the
  daemon no longer has keeps a live chevron and fails only inside the viewer.
- Found on the path (pre-existing bug): expo-file-system 58 made `File.write()`
  async ("`File.write()` is now asynchronous and returns a Promise. Use
  `File.writeSync()` …", `node_modules/expo-file-system/CHANGELOG.md:70`), and
  the artifact cache's port drops that promise
  (`apps/mobile/src/artifact-cache-expo.ts:57` on `main`): `put` returns the uri
  of a file that may still be being written. A preview hands that uri to
  QuickLook at once, so this must be fixed here.

**Repro (the capability is missing):** the four-card session of flow 36
(Execution) on `main`'s build draws four 40 pt glyph tiles — no preview of any
kind, and no page count. The rg output above is the root cause for the image case.

## Implementation

*— claude-opus-5-5, 2026-11-21*

### Load-bearing assumption

**The existing thumbnail driver can carry every kind's preview unchanged in its
rules**: it already fetches only for rows in the visible window ± `PREFETCH_ROWS`,
bounds in-flight requests (`MAX_IN_FLIGHT`), cancels off-window requests on their
own controller and records a failure as final (`thumbnails.ts:120-196` on
`main`); its port (`ThumbnailSource.fetch`, `:70-73`) is the only thing that
knows how bytes are made. So a preview is "a thumbnail whose port also runs
QuickLook", and the driver gains only one outcome (`gone`). Proven by the
driver's own suite (`apps/mobile/test/thumbnails.test.ts`, unchanged rules,
green) plus the new `gone` cases.

### Preconditions

- The session screen's verified read is published once per attach on the feed
  (`session-screen-controller.ts:1328-1337`, called at `:1508`), and reads through
  the CURRENT handle — so a port in `App.tsx` can use it without a second
  `RemoteSession` (which would steal the stream).
- Every byte the phone keeps goes through the cache's one writer, `put`
  (`artifact-cache-store.ts:178-211`), which enforces the 200 MB cap;
  `forgetComputer` removes the computer's whole directory on unpair (`:228-233`).
- `artifact/read`'s refusal is typed: `DomainErrorCode.ArtifactUnavailable`
  (`packages/protocol/src/jsonrpc.ts:85`) with `data.reason` `unknown` |
  `evicted` | `store_failed` (`packages/protocol/src/artifact.ts:169`), raised by
  `ArtifactStore.read` (`packages/daemon/src/artifact-store.ts:209-222`) and
  passed to the caller as is by `RemoteClient.readArtifact`
  (`packages/client/src/remote-client.ts:2609`).
- The artifact meta carries an image's `width` / `height` before any byte
  (`artifact-store.ts:190-191`), so an image band's height is known at render.
- Local Expo modules are autolinked from `apps/mobile/modules/`
  (`tentacle-speech` is the precedent: podspec + `expo-module.config.json`).
- No §7 invariant is touched: no protocol, no persistence format of the daemon
  or the laptop, no terminal I/O; one additive core option (display only).

### Design

1. **Pure view-model** `apps/mobile/src/artifact-preview.ts` (React-free):
   - `previewSource(meta)`: image → its file; pdf / html / svg → a QuickLook
     page; markdown / text → lines the app draws; chart / other → none.
   - `wantsPreview(meta)` (the driver's rule): previewable and ≤ `PREVIEW_MAX_BYTES`
     = 5 MiB (the approved spec; it extends Owner Q6's 1 MiB image line).
   - `bandHeight(meta, W)`: 150 pt fixed; an image `clamp(W·h/w, 120, 240)` from
     the meta — known before the bytes, so nothing jumps.
   - `previewStatus(thumbState, meta)`: `loading` | `ready{preview}` | `failed` |
     `gone`; too big is `failed` up front (never a forever-loading band).
   - `previewLines(kind, text)`: ≤ 8 lines via the transcript's own markdown
     parser (headings, paragraphs, bullets, code as mono); `(empty)` for none.
   - `previewCardView(meta, status, W)` → `{card, symbol, band, dim, trailing,
     disabled, a11yLabel}`: loading = band + dimmed symbol; failed = band + full
     symbol (never a collapse); ready = top-aligned page (`drawnHeight = W·h/w`) /
     cover image / lines; gone = no band, dimmed, no chevron, disabled, line 2
     "… · no longer available"; `other` = no band + Share glyph.
2. **Core** `artifactCard(meta, {pages})`: "PDF · 7 pages · 214 KB" (display
   only; ignored for other kinds / non-positive-integers). The Mac ignores it.
3. **Driver** (`thumbnails.ts`): `Thumbnail.preview?`, `ThumbnailState.gone?`,
   the port may answer `"gone"` → `gone(state, id)` (= failed + gone);
   `visibleRefs` uses `wantsPreview`; the ref carries the meta
   (`ImageRef.artifact`), so the port never looks a sha up in a list that lags.
4. **Port** `artifact-preview-source.ts` (every effect injected, unit-tested):
   kept preview → shown with no dial (offline); else the cache's copy
   (`ARTIFACT_CACHE.uriOf`, new) or the verified read through `put`; then image =
   the file, lines = first 4 KB, page = QuickLook at `W × 1.5W` pt + PDFKit page
   count; results kept. `ArtifactUnavailable` `unknown|evicted` → `"gone"`;
   anything else → `null` (symbol). Never throws.
5. **Native** `modules/tentacle-preview` (Swift): `thumbnail(fileUri, outUri,
   wPt, hPt)` — `QLThumbnailGenerator`, `representationTypes: .thumbnail` only
   (an icon is a refusal, not a preview), JPEG 0.85 — and `pdfPageCount`
   (PDFKit). Bound by `preview-native-expo.ts` (`requireOptionalNativeModule`:
   absent → pages keep their symbol).
6. **Disk** `artifact-preview-expo.ts`: previews under
   `artifacts/<computer>/previews/<sha>-w<W>.{json,jpg}` — inside the computer's
   cache directory, so an unpair drops them; a JSON whose page image is gone is
   remade. `readTextHead` reads a bounded head (FileHandle).
7. **Wiring**: `artifact-thumbnail.ts` plugs the real pieces; `App.tsx` chains it
   after `sentPhotoSource` (its existing `next` fallback); the component
   `ArtifactCardRow` → `ArtifactCardBody` only maps the view-model (band with
   `radius.tile` + hairline `sep` edge, meta row: 20 pt light symbol, title
   `ellipsizeMode="middle"`, line 2, 13 pt semibold chevron).
8. **Fix on the path**: `artifact-cache-expo.ts` writes with `writeSync`.

### Files

`packages/core/src/artifact-card.ts` (+ test) · `apps/mobile/src/artifact-preview.ts` (new)
· `apps/mobile/src/thumbnails.ts` · `apps/mobile/src/transcript-rows.ts`
(`ImageRef.artifact`) · `apps/mobile/src/artifact-preview-source.ts` (new) ·
`apps/mobile/src/artifact-cache-store.ts` (`uriOf`) ·
`apps/mobile/src/artifact-cache-expo.ts` (`writeSync`) ·
`apps/mobile/modules/tentacle-preview/` (new) · `apps/mobile/src/preview-native-expo.ts`
(new) · `apps/mobile/src/artifact-preview-expo.ts` (new) ·
`apps/mobile/src/artifact-thumbnail.ts` (rewired) · `apps/mobile/App.tsx` ·
`apps/mobile/src/screens/transcript/TranscriptRow.tsx` · e2e:
`apps/mobile/e2e/preview-fixtures.ts`, `run.ts`, `flows/36-preview-*` · tests below.

### Failure modes

| Case | What converges |
|---|---|
| File > 5 MiB | `failed` before render: band + symbol, no download; tap opens the viewer as before. |
| QuickLook refuses (icon only, broken file, an HTML it cannot draw) | port → `null` → `failed`: band + symbol at full strength. |
| Daemon says `unknown` / `evicted` | `"gone"` → no band, dimmed, no chevron, disabled, "no longer available". |
| Daemon disk failed (`store_failed`) | plain failure (symbol); may read on the next screen. |
| Link down / no reader yet | `null` → symbol for this screen's life (the driver never retries a failure — its existing rule); a preview made before is served from disk with no dial. |
| Scrolled away mid-read | the driver aborts the request's own controller; the port returns `null` on an aborted signal; the driver drops a settle from an abandoned request. |
| Cache cannot keep it (over the cap) | `put` → no uri → `null` → symbol. |
| Unpair | `forgetComputer` removes `artifacts/<computer>/`, previews included. |
| Build without the native module | `PREVIEW_NATIVE = null`: pages keep their symbol; images and lines still preview. |
| Rotated / other screen width | the key is the band width (`w358`): another width makes a new preview. |
| Kept JSON corrupt / foreign | `parseStoredPreview` → `null` → remade; a page JSON whose image is gone → remade. |

### Tests

- `apps/mobile/test/artifact-preview.test.ts` (new, written first, RED: module
  missing): source per kind, cap, symbols = the gallery's, band height (image
  clamp, no dims), status (loading / in flight / loaded / sent-photo thumb /
  failed / gone / aborted = loading / too big = failed), view per state, lines.
- `apps/mobile/test/artifact-preview-source.test.ts` (new): PDF pipeline order,
  offline (kept preview, no dial), cached version not re-read, image, markdown
  head, gone vs `store_failed`, QuickLook refusal, no native, too big, abort,
  ref without meta / mismatched sha.
- `apps/mobile/test/artifact-card-render.test.ts` (new): the component maps it
  (band testIDs, top-aligned page style, gone disabled + no chevron).
- `apps/mobile/test/thumbnails.test.ts`: `gone` outcome (failed + gone, never
  retried); the cap moved to `wantsPreview`.
- `apps/mobile/test/artifact-cache-store.test.ts`: `uriOf`.
- `packages/core/test/artifact-card.test.ts`: pages (singular, ignored for other
  kinds / bad counts).
- e2e flow `36-preview-cards` (simulator): four cards, waits for "7 pages"
  (QuickLook + PDFKit really ran), light + dark shots.

## Execution

*— claude-opus-5-5, 2026-11-21*

1. **Evidence first.** `rg` above: the image thumbnail port was never wired, so
   on `main` every card draws its glyph; `artifactCard` is never given a state.
2. **RED** — `bun test apps/mobile/test/artifact-preview.test.ts` before the module:
   `error: Cannot find module '../src/artifact-preview.ts'` (0 pass, 1 fail, 1 error);
   core pages test on the old `artifactCard`: `8 pass 1 fail`;
   `uriOf` test on the old store: `TypeError: cache.uriOf is not a function` (18 pass 1 fail).
3. **GREEN** in plan order: core `pages` → `artifact-preview.ts` → driver `gone` +
   `wantsPreview` + `ImageRef.artifact` → `artifact-preview-source.ts` → `uriOf` →
   native module → expo bindings → `artifact-thumbnail.ts` rewired → `App.tsx` →
   `ArtifactCardRow`/`ArtifactCardBody` → render test → flow 36.
   `artifact-preview-source.test.ts` was written AFTER its module (not shown red);
   its non-vacuity is the mutation table below instead.
4. **Mutations** (each applied, the named file run, reverted):
   ```
   previewStatus: too big not decided up front      artifact-preview        20 pass 1 fail
   previewCardView: gone still tappable             artifact-preview        20 pass 1 fail
   page squashed into the band (drawnHeight=150)    artifact-preview        20 pass 1 fail
   driver ignores "gone"                            thumbnails              23 pass 1 fail
   source never answers "gone"                      artifact-preview-source 12 pass 1 fail
   source skips the kept-preview lookup (offline)   artifact-preview-source 12 pass 1 fail
   component draws a page with `cover`              artifact-card-render     4 pass 1 fail
   core: no singular "1 page"                       core artifact-card       8 pass 1 fail
   (control) band hidden when dim — equivalent      artifact-card-render     5 pass 0 fail
   ```
5. **Drift from Implementation / the mockup:**
   - **Symbols**: the gallery's existing per-kind table (`gallery-layout.ts`
     `kindSymbol`) instead of the mockup's second table (pdf `doc.richtext`,
     markdown `doc.text`, svg `scribble`, chart `chart.bar.xaxis`), so a file
     looks the same in the transcript and in Artifacts. Pinned by a test.
   - **No 150 ms fade** on arrival (the spec's "dissolvenza"): the picture
     simply replaces the symbol in a band of the same size. Left out to keep the
     component a plain renderer (no Reduce-Motion plumbing); a follow-up if wanted.
   - **The cap is 5 MiB for every previewable kind** (the approved spec's
     "proposta"), up from Owner Q6's 1 MiB for images. One constant
     (`PREVIEW_MAX_BYTES`) if the owner wants 1 MiB back.
   - **`artifact-cache-expo.ts` → `writeSync`** (the pre-existing async-write bug
     in Context). Two other ports drop `File.write()`'s promise the same way and
     are NOT touched here (not on this path): `outbox-fs-expo.ts:51`,
     `pdf-source.ts:59` — a follow-up `fix`.
   - The never-wired `createArtifactThumbnailSource` is replaced (same file,
     `artifact-thumbnail.ts`, so the cache-wiring source pin still holds).
6. **Simulator** (own device `tentacle-preview-cards`, iPhone 17 Pro iOS 26.5,
   created for this task, **shut down and deleted** at the end): native build
   (`expo prebuild` + `run:ios` Release; `TentaclePreview` compiled), then
   `bun apps/mobile/e2e/run.ts --udid … --only 36-preview-cards --hold`:
   `✓ 36-preview-cards (iOS 26) pass` / `GATE PASS — 1 passed (70 s)`. The flow
   waits for "7 pages" on the PDF card, i.e. QuickLook + PDFKit really ran.
   **QuickLook draws HTML on iOS** (the mockup's open question): the dashboard
   page renders as its top. Screens (gitignored):
   `.tentacle/tmp/mobile-file-preview-cards/screens/36-preview-{top,bottom}-{light,dark}.png`
   (top: PDF + image; bottom: image tail, markdown, HTML).
   - **Not captured: loading and unavailable.** Loading lasts less than one
     capturable frame on the harness's loopback link (a `simctl` screenshot loop
     while opening a session with a 4.6 MB PDF showed the preview already made);
     unavailable needs a daemon that LOST the bytes (`evicted` / `unknown`), and
     the e2e `serve` keeps artifacts in memory only (no `<uid>.artifacts/` on
     disk), so a restart drops the cards with the bytes. Both states are pinned
     by `artifact-preview.test.ts` (view-model) and `artifact-card-render.test.ts`
     (drawn: band + dimmed symbol at height 150; gone = no band, no chevron,
     disabled, "no longer available"). To see them on a device: a memory-budget
     eviction (`SessionHost` `artifactBytes`) or a throttled link.
7. **Gate** — `bun run check` (typecheck → lint → test), exit 0:
   ```
   Checked 2170 files in 631ms. No fixes applied.
    15985 pass
    5 skip
    0 fail
   Ran 15990 tests across 1136 files. [516.24s]
   ```
   5 skips (AGENTS §6 names three opt-in groups; a group may hold several tests).
   None of this task's test files contains a skip; not re-counted on `main`.

## Review

*— pending*
