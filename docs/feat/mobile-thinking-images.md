# feat/mobile-thinking-images — glyph-clipped "Thinking" shimmer + photos above the bubble

> **Status:** implementation (awaiting owner answers — NOT approved)
> **Branch:** `feat/mobile-thinking-images`
> **Type:** feat · **Size:** M · **Blast:** contained (apps/mobile only; no protocol, no persisted format, no client package change) · **Suited:** Opus plan; slices S1/S3/S4 DeepSeek exec, S0 (spike) + S2 (shimmer component) Opus exec; standard Review, plus a simulator screenshot pass
> **Changelog:** `changelog.d/mobile-thinking-images.changed.md` (one bullet: the Thinking row's shimmer stays inside the letters and shows seconds; photos sit above the message bubble)

## Context

*— claude-opus-5-5, 2026-11-18*

Owner, device screenshot 18/11 00:54 (`.tentacle/tmp/thinking-images/owner-0054.png`):

1. **The live "Thinking…" row** — the shimmer shows as a visible RECTANGLE sweeping behind the word. Cause, read in the source: `ShimmerWord` (`apps/mobile/src/ui/StepNode.tsx:169-220`) draws the bright copy inside an `Animated.View` with `overflow: "hidden"` (`styles.band`, `:533`) that translates across the word (`:200-216`). The window has hard edges, and any sub-pixel mismatch between the two counter-moving transforms shows the window itself. It is a box by construction.
2. **A photo in a user message renders INSIDE the text bubble** — `UserRowView` (`apps/mobile/src/screens/transcript/TranscriptRow.tsx:155-268`) puts the images at full bubble width inside the `fill` bubble, caption below (the earlier "WhatsApp shape", `media-layout.ts:1-10`). The owner wants the photo as its own element, separate from the bubble.

Item (3) of the TODO entry (hub fan jank while Thinking) is **out of scope**: it is `feat/mobile-hub-native-driver`. The only link is that the new shimmer must not add JS-thread work per frame (see the load-bearing assumption).

**Spec (binding):** owner-picked mockups `.tentacle/mockups/mobile-thinking-images/index.html` + `README.md` "## CHOSEN" (owner 18/11 ~01:25):
- **Q1 = B + seconds** — the shimmer CLIPPED to the glyphs of "Thinking" (no box can show), plus tabular elapsed seconds in `sec` grey ("Thinking 12 s"). Reduce Motion → static grey word.
- **Q2 = F** — a user message's photos are their own element(s) ABOVE the text bubble: radius 16, max 200 pt, right-aligned; 2 photos side by side, 3–4 a grid, >4 a "+N" tile; photo-only message has no bubble; states: uploading (veil + ring + "N%"), failed ("not sent" + Retry), tap → full-screen viewer (✕, "2 of 5", swipe, pinch, caption, share); after reload the same as live, missing bytes → "Image not available".

**Landed before this, assumed:** `fix/mobile-qa-1117` and `feat/scheduled-fire-row` are merged into `main` (verified: both are ancestors of this branch, `git merge-base --is-ancestor`). From them this plan assumes: `StepNode` already carries the `wake` node kind (`StepNode.tsx:28-29`) and the step thread layout is as in `tool-steps.ts`; nothing else in those branches touches `UserRowView` or `ShimmerWord`.

**Not yet landed, conflicts:** `fix/mobile-photo-row` (unmerged since 15/11; review round 2 = **APPROVE** at `c10aa832`, one action left: correct two section signatures, AGENTS §10). It changes `apps/mobile/App.tsx`, `outbox-session.ts`, `session-screen-controller.ts` and adds tests in `outbox-link.test.ts` — the B9-a fix (the outbox port is the screen's own handle, so a photo send no longer steals the screen's stream). Its finding that matters here: **B10's history/other-device thumbnails are blocked — the protocol has no attachment read-back** (`packages/protocol/src/methods.ts:184` is the only attachment method, `attachment/put`; `apps/mobile/src/thumbnails.ts` says so). That bounds Q2's "identical after reload" (Owner question 2).

**Repro:** a feat — the capability (glyph-clipped shimmer, photos outside the bubble) is missing on `main`. Evidence is the owner screenshot above and the cited source. The executor's first step is the S0 spike, whose output is pasted under Execution.

## Implementation

*— claude-opus-5-5, 2026-11-18* — **NOT approved**: depends on the Owner questions below.

### Load-bearing assumption

**A text-shaped shimmer can be driven on the native animation driver with what the app already ships.** The deps are `react-native-svg` 15.16.0 (`apps/mobile/package.json:37`); no Reanimated, no MaskedView. RN's native driver animates only `transform`/`opacity` of native views. Animating a `LinearGradient`'s `offset`/`x1` or a `gradientTransform` goes through `setNativeProps` on the **JS** thread at about 60 Hz, which is exactly the load the owner's jank report (TODO item 3) blames. Not proven yet; **S0 decides it** before any other slice:

- **S0-a:** an `Animated.createAnimatedComponent` on the svg `G`/`Rect` inside a `<ClipPath>` made of `<SvgText>`, with `useNativeDriver: true`. Pass = no "not supported by native animated module" error, and the sweep moves on the simulator while the JS thread is blocked by a 2 s busy-loop. Fail = an error, or a frozen sweep.
- **S0-b (if S0-a fails):** a JS-driven gradient offset at 30 Hz, measured with the perf monitor on the iOS 26 simulator: JS fps idle vs Thinking, before and after.
- The result picks the build (Owner question 1). The two answers are: glyph clip with svg on the native driver; or, when S0-a fails, `@react-native-masked-view/masked-view` (text mask over a native-driven `translateX` gradient view, so the glyphs clip it and no box can show) vs the JS-driven gradient.

### Preconditions

- The motion constants and Reduce Motion behaviour already live in a pure module: `thinking-motion.ts:13-15` (`BREATHE_MS`, `SHIMMER_MS`) and `:81-87` (`thinkingLook`). Tests: `apps/mobile/test/thinking-motion.test.ts`.
- The elapsed clock exists: `ThinkingNode` `StepNode.tsx:480-481` (`start = useRef(Date.now())`, `useElapsed`). The text comes from `liveElapsed` (`tool-summary.ts:489-495`: `""` under 1 s, `"N s"`, `"M min S s"`, and **no hours**: 2 h reads `"120 min 0 s"`). The a11y label is `thinkingA11yLabel` (`tool-steps.ts:323-333`).
- The photo geometry is already pure: `media-layout.ts` (`mediaBox`, `layoutMedia`, `displayUri`, `MEDIA_MAX_RATIO = 4/3`), drawn by `TranscriptRow.tsx:158-232`. Pixels come from `ImageRef.localUri` (`transcript-rows.ts:28-30`, the phone's own copy kept by `photo-copies.ts`: newest 60, one week) else a thumbnail port that always answers `null` (`thumbnails.ts`; no read-back).
- The upload happens at PICK time in the composer (`compose-controller.ts:546`, chip `uploading → ready`, `compose-chips.ts:29-67`). So an **online** sent message's photos are already uploaded when its row exists. Only an **outbox** item uploads at send time (`outbox-driver.ts:241`, state `uploading`, `outbox-look.ts:28-29`, drawn by `ComposeBar.tsx` as a dashed text-only row). Per-byte progress exists in the client (`UploadOptions.onProgress`, `packages/client/src/remote-client.ts:254-258`, passed by `attachImage` `:2315,2344`) but the mobile app does not pass it.
- The viewer exists but is minimal: `MediaViewer.tsx` (one image, no paging/zoom/share, `:11-12` says so on purpose).

### Design

**S1 — pure: thinking text + elapsed (DeepSeek).** In `thinking-motion.ts` add `thinkingLabel(ms) → { word: "Thinking", seconds: string }`. `seconds` uses a new `thinkingElapsed(ms)`: `"0 s"`…`"59 s"`, `"1 min 05 s"` (seconds zero-padded so the width holds steady with tabular figures), `"1 h 02 min"` from 3600 s. Change `shimmerSweep` to return the gradient geometry for the chosen technique (stop positions with soft 0→peak→0 alpha, band ≈ 40 % of the width, start and end fully off the glyphs). `thinkingLook` is unchanged (Reduce Motion → `animate: false`, grey). Keep `liveElapsed` as it is for tool rows (one consumer change only, below).

**S2 — component: `ThinkingWord` replaces `ShimmerWord` (Opus).** In `StepNode.tsx` the word is drawn per S0's verdict, and the bright layer is visible only inside glyph outlines. The seconds go in a separate `Text`, `fontVariant: ["tabular-nums"]`, `palette.sec`, and replace the node's generic `trailing` for the thinking node (the ellipsis "…" goes away: the seconds now say "it is moving"). Reduce Motion: no clock, plain `sec` word, seconds still tick (1 Hz `setState`, as today). The breathing ∴ stays (the mockup keeps it). Delete the `band` style and the counter-transform. Keep `testID` contracts: `thinking-footer`, `thinking-therefore`, `labelTestID`.

**S3 — pure: photo block layout (DeepSeek).** In `media-layout.ts` add `photoBlock(refs, { maxWidth: 200, gap: 4, maxTiles: 4 })` → `{ tiles: { box, ref, overflow?: number }[], width, height }`:
- 1 photo: its own ratio inside a 200 × 200·(4/3) cap; a panorama (ratio > 2.5) is capped at 200 wide and at least 64 tall, cropped `cover`; a portrait ratio is clamped by `MEDIA_MAX_RATIO`; a missing or nonsense ratio is a 200 square (the existing rule, `mediaBox`).
- 2: two squares side by side, (200−gap)/2 each.
- 3: one tall tile on the left + two stacked on the right.
- 4: a 2 × 2 grid.
- >4: the first 4 in the 2 × 2 grid, the 4th tile carries `overflow = n − 3`, shown as "+N" over the photo (it stands for itself and the hidden ones).
- Radius 16 for the outer corners only (the inner gaps are hairline 4 pt). Right-aligned.

Add `userRowParts(row) → { photos: boolean, bubble: boolean }`: the bubble exists iff text, documents or the restart caption exist (so a photo-only message has no bubble). The old `layoutMedia`/`captionBelow` is removed once nothing uses it.

**S4 — component + states + viewer (DeepSeek, Opus review).**
- `UserRowView`: the photo block ABOVE the bubble, its own `View` (no `fill`). In light mode, a hairline `sep` border on each tile (the mockup's "filo sep"). `displayUri` and the `broken` list keep working per tile. A tile without pixels shows the icon + "Image not available" (Owner question 2).
- **States:** they belong to the **outbox row** (the only place a photo is still uploading or can fail after the person pressed Send). Extend `OutboxRowView` (`session-view.ts:180-186`) with `photos: ImageRef[]` (the item's local copies) and `progress: number | null` (in memory only, NOT written to the outbox file — see failure modes). `outbox-look.ts` maps `uploading` → veil + ring + `"Sending… N%"` (indeterminate ring when `progress` is null). `needs-decision` caused by an upload refusal → `"Not sent"` + `"Retry"`; Retry runs the existing decision sheet's resend, so no new path. `ComposeBar.tsx` draws the outbox photo block with the same `photoBlock` geometry. Progress plumbing: `outbox-driver.ts` `upload` dep gets an `onProgress` → `outbox-session.ts:121` passes it to `session.attachImage(bytes, meta, { onProgress })` (the client API already accepts it; no client change).
- **Viewer:** `MediaViewer` takes `{ items: {uri,label}[], index }`. A horizontal paging `ScrollView` (`pagingEnabled`); each page an iOS `ScrollView` with `maximumZoomScale={4}` for pinch (no new dep); the header shows "2 of 5"; the caption is the message text; Share uses RN `Share.share({ url })` (iOS shares a `file://` URL). Paging/index math lives in a pure `viewerIndex(items, tapped)`, and tiles without pixels are skipped in the pager.

### Files

In dependency order:
`apps/mobile/src/thinking-motion.ts`, `apps/mobile/src/ui/StepNode.tsx` (S1–S2) · `apps/mobile/src/media-layout.ts`, `apps/mobile/src/screens/transcript/TranscriptRow.tsx`, `apps/mobile/src/screens/transcript/MediaViewer.tsx` (S3–S4) · `apps/mobile/src/session-view.ts`, `apps/mobile/src/outbox-look.ts`, `apps/mobile/src/outbox-driver.ts`, `apps/mobile/src/outbox-session.ts`, `apps/mobile/src/screens/compose/ComposeBar.tsx` (S4 states) · `apps/mobile/package.json` only if Owner question 1 picks MaskedView · `changelog.d/mobile-thinking-images.changed.md`.

### Failure modes

| Case | Convergence |
|---|---|
| Native driver can't animate the svg clip (S0-a fails) | Stop; Owner question 1 decides. The fallback is never silently JS-driven. |
| App backgrounded during Thinking | The clock is `Date.now()`-based: on return it shows the true elapsed time. A native loop pauses with the app, so there is no catch-up burst. |
| Thinking for minutes or hours | `thinkingElapsed` uses min/h formats with tabular figures (no jitter, no `"120 min"`). |
| ThinkingNode remounts (leaving/re-entering the session, list virtualization) | Elapsed restarts at 0 (`StepNode.tsx:480`, mount = identity, as today). Recorded as debt, unchanged by this task. |
| Reduce Motion toggled mid-thinking | `thinkingLook` re-evaluates; the loop stops and the word is static grey. |
| Light/dark | Bright layer = `palette.label`, base = `palette.sec` (as today); screenshot both. |
| Font scale | `DENSE_FONT_SCALE` cap kept; the glyph mask is measured from the laid-out text (`onLayout`), width 0 → no sweep (existing rule). |
| 1 / 2 / 3 / 4 / 5 / 10 photos; portrait 3:4, landscape 4:3, panorama 6:1, missing ratio | `photoBlock` unit tests cover each; nothing 0-height, never upscaled past 200 pt. |
| Bytes missing after reload / file trimmed / other device | Tile shows "Image not available" (`displayUri` + `broken`); the viewer skips it. |
| Upload cancelled / link lost mid-upload | The outbox item goes back to `waiting` or `needs-decision` (existing driver). `progress` resets to null (in memory only), so a stale "62 %" never survives a restart. |
| Upload refused (too large, images off) | `needs-decision` → "Not sent" + Retry, through the existing decision sheet. |
| Photo-only message | No bubble, no empty text area (`userRowParts`). |
| Photo-row B9-a not merged | Q2 would ride on a screen that drops its own photo turn. Owner question 3. |

### Tests

Red first; each pure test fails on `main` before the change.
- `thinking-motion.test.ts`: `thinkingElapsed` at 0, 999 ms, 1 s, 59 s, 60 s, 65 s, 3599 s, 3600 s, 2 h; `thinkingLabel` drops the "…"; the gradient stops start and end fully off the word for width > 0, and width 0 → no sweep; Reduce Motion → `animate: false`.
- `media-layout.test.ts`: `photoBlock` for n = 1…5 and 10, each ratio above, missing/NaN/0 ratio; `"+N"` value; `userRowParts` (photo-only → no bubble; text-only → no photos; both).
- `outbox-look.test.ts`: `uploading` with progress 0.62 → `"Sending… 62%"`, null → indeterminate; refusal → "Not sent" + retry.
- `outbox-driver.test.ts`: `onProgress` reaches the row and resets on a cancel (fake upload dep).
- A component test (the existing `tool-rows-wiring` / `session-screen-compose` harness pattern): the thinking footer renders seconds and no band view; the user row renders photos outside the `fill` bubble, and a photo-only row has no bubble.
- Mutation: restore the old `band` overflow window → the "no band view" test fails; put the photo block back inside the bubble → the placement test fails.
- **Simulator screenshots** (executor, pasted into Execution): `bun run e2e:mobile --ios 26` for the thinking-hold flow (`e2e-mock-thinkhold`) and `18-photos`, light + dark, Reduce Motion on: 1, 2, 3, 5 photos, photo-only, an outbox upload in progress, a failed upload, the viewer at "2 of 5".

#### Orchestrator decisions

None: the owner decides, see below.

### Owner questions

1. **Shimmer technique if svg-native fails (S0-a).** (a) Add `@react-native-masked-view/masked-view` (native-driven, glyph-clipped; needs a dev-client rebuild); (b) JS-driven svg gradient at 30 Hz (no new dep, adds JS-thread work while Thinking, the jank the owner reported). **Rec: (a)**. Not needed at all if S0-a passes.
2. **Photos without bytes after reload / from another device.** There is no `attachment/get` (`methods.ts:184`), so only this phone's own copies (newest 60, one week) can be shown. **Rec:** ship F with an "Image not available" tile now, and open a separate `feat/attachment-get` (new protocol method + daemon handler) for true "identical after reload".
3. **`fix/mobile-photo-row` (APPROVE r2, signatures pending).** **Rec:** fix the two signatures and merge it into `main` BEFORE S3 starts, then rebase this branch. Its B9-a fix is what makes the just-sent photo row appear at all; folding it in would mix a load-adjacent RPC fix into a contained UI task.
4. **Upload % source.** Wire the client's existing `onProgress` through the outbox (mobile-only, in memory), or keep the indeterminate "Uploading photos…". **Rec:** wire it (≈20 lines, no client/protocol change).
5. **Copy language.** The mockup says "Invio… 62%", "Non inviata", "Riprova", "Immagine non disponibile"; the app is English ("Sending…", `outbox-look.ts:27`). **Rec:** English ("Sending… 62%", "Not sent", "Retry", "Image not available"), matching the rest of the app.
6. **Viewer share + pinch scope.** Native RN only (`Share.share`, `ScrollView` zoom, iOS-first; Android pinch is weaker) vs a gesture library. **Rec:** RN only now; a gesture library only if the owner finds pinch lacking on device.

## Execution

*(empty — starts after approval)*

## Review

*(empty)*
