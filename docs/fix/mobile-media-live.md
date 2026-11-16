# fix/mobile-media-live — after sending a photo the phone stays "Running" and never shows the reply; the photo has no thumbnail

`Type: fix · Size: S–M · Blast: contained (apps/mobile) · Suited: DeepSeek exec (repro first), Opus review`

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-16*

**Owner, live on the iPhone build of 2026-11-16 15:04 (main f0c80329 + build patch), session via `serve` on the Mac over the relay, model Qwen3.8-27B:**
1. Sent "Cosa vedi?" + a photo (IMG_4876.jpg). The header stays **Running** (spinner, Stop button) and no reply appears. **The daemon finished the turn**: the serve log `~/.config/tentacle/daemon/proj-2a4dc70b7988/de3ef43f-….jsonl` ends with `media_message` (user) → `message` (assistant: "Nella foto vedo: un contatore del gas…") → `turn_end` → `checkpoint`. **Leaving the session and re-entering shows the reply** ⇒ the history projection is fine; the LIVE path after a media message is broken (the assistant stream / turn_end updates of that turn are not applied, or applying them throws and the screen stops updating).
2. In the user bubble the photo renders as a placeholder `[image: IMG_4876.jpg]` with a generic image glyph instead of the photo's **thumbnail**.
3. Owner request (same task): **pull-to-refresh** on the session transcript — a resync (re-open/re-read the session from the daemon) as a safety net. Native `RefreshControl`, the mobile-chrome look.

4. **Owner (screenshot of a WhatsApp photo bubble), same task:** a message with an attachment + text is laid out like WhatsApp — the **image on top, full bubble width, rounded to the bubble**, and the **text (caption) BELOW the image inside the same bubble**, never the text above a small squeezed image. The same for **PDF and other files**: a document card on top (icon, file name, size / page count) and the caption below it. A bubble with only an image has no empty text area. Tapping the image opens it full screen. Applies to the user's own bubbles (and to any media row rendered in the transcript).

5. **Owner, same task — downscale photos before sending.** Today (`apps/mobile/src/photo-source.ts:116,120`) a photo is only converted HEIC→JPEG (0.9) and downscaled ONCE, by 0.5, only when over `MAX_IMAGE_BYTES`; a normal iPhone photo goes out at ~4032×3024 / several MB. New default: **long edge ≤ 2048 px, JPEG quality 0.8** (≈300–600 KB) — models downsample anyway (Claude ~1568 px) and local VL models (Qwen-VL) turn pixels into tokens (slow prefill, context burned); smaller uploads over the relay. Never upscale. A Settings switch **"Send photos at original size"** (off by default; a versioned phone-local setting, the existing settings-store pattern) bypasses it. The local bubble thumbnail still uses the local photo. Keep the existing over-cap refusal rule. Pure decision in `photo-input.ts` (`nextPhotoStep`: target size from width/height/setting), tested; the effect stays in `photo-source.ts`.

## Implementation

*— claude-opus-5-5 (executor), 2026-11-17*

Five items, in dependency order: **S1** the live path (item 1) · **S5** the downscale
pure step (item 5) · **S2** the thumbnail's local URI (item 2) · **S4** the bubble
layout (item 4) · **S3** pull-to-refresh (item 3). S2 and S4 share the local-URI
threading, so S2 comes first.

### Load-bearing check (AGENTS §1: evidence, not a hypothesis)

S1's assumption, and the whole task stands on it: **the screen's own
`RemoteSession` is the session entry's stream listener, and a second handle for
the same id REPLACES it.** Verified: `remote-client.ts:3023-3026` — `register()`
does `if (listener) existing.listener = listener` for a live id, and every
`RemoteSession.open()` goes through `client.attachSession(id, this, …)`
(`remote-session.ts:515-521`).

Repro (`.tentacle/tmp/mobile-media-live/repro.test.ts`, a real in-process daemon
+ real clients, the driver wired exactly as `App.tsx:321-341` wires it):

```
rows: [ "user:hi", "assistant:ok:hi", "user:Cosa vedi?" ]
turn (running): {"kind":"turn","key":"r3","turnId":"d7b7e45d-…","own":true}
assistant shown: true
(fail) expect(received).toBeNull()   ← the media turn never ends
```

The same repro with the driver's port built over the SCREEN's handle instead of
a new one:

```
rows: [ "user:hi", "assistant:ok:hi", "user:Cosa vedi?", "assistant:ok:Cosa vedi?" ]
turn (running): null
```

⇒ **item 1 reproduces, and a text-only message does not** (`user:hi` →
`assistant:ok:hi` both arrive). Root cause: `App.tsx`'s `outboxOf` `getSession`
opens a SECOND `RemoteSession` for the id (`App.tsx:323-334`), whose `open()`
re-registers the entry's listener; the screen's `watch` then receives nothing,
so the turn's `text`/`turn_end` updates are dropped and `transcript.turn` — drawn
as the header's "Running" — is never cleared. The reply IS in the history, which
is why leaving and re-entering showed it.

### Preconditions (verified against the code)

- `ComposeHandle` already carries the right port: `compose-handle.ts:68-70` —
  `port: outboxSessionOf(session, client, () => null)` over the SCREEN's handle.
  So the fix reuses an existing seam; no new port, no second session path (§7).
- The screen already builds that handle lazily: `session-screen-controller.ts:513-515`
  (`handle: () => status.phase === "open" && handle !== null ? deps.compose?.handle(handle) : null`).
- No read-back method exists (`thumbnails.ts:19-25`): an image's bytes cannot be
  fetched from the daemon, so a reopened history row can only be a placeholder.
  Item 2 therefore shows the LOCAL copy on the row the phone just sent.
- `MAX_IMAGE_BYTES` / `IMAGE_MIME_TYPES` come from `@tentacle/protocol`'s
  `attachment.ts` (15 MiB, png/jpeg/gif/webp) — the cap rule is unchanged.
- The versioned-record store pattern: `voice-settings-store.ts`,
  `activity-settings-store.ts` (`SecureKV` port, unknown `v` never overwritten).

### Design

**S1 — the media turn must fold into the screen's transcript.**
`ComposeWiring.driver`'s folding object (`session-screen-controller.ts:239-250`)
gains `handle: () => ComposeHandle | null` (the same accessor the compose half
already gets). `App.tsx`'s `outboxOf` builds `getSession` from it:
`{ ...folding.handle().port, prompt: folding.prompt }` — never
`client.newSession`. One listener, one session path. Guard: a new
`apps/mobile/test/mobile-media-live-wiring.test.ts` reads `App.tsx`'s text (the
`push-wiring-guards.test.ts` idiom, since RN's Flow cannot be parsed by Bun) and
fails if that `getSession` opens a session handle.

**S5 — downscale before sending (`photo-input.ts`, pure).**
`PhotoState` gains `width`/`height` (the pick's intrinsic size) and
`sendOriginal` (the setting). New constants `PHOTO_MAX_EDGE = 2048`,
`PHOTO_JPEG_QUALITY = 0.8`. `nextPhotoStep` returns
`{ kind: "downscale"; width }` (a target WIDTH — never upscale) when the long
edge exceeds `PHOTO_MAX_EDGE` **and** `sendOriginal` is false **and**
`downscaled` is false; the over-`MAX_IMAGE_BYTES` case keeps its own one-shrink
step. The effect stays in `photo-source.ts` (`resize({width})` + JPEG 0.8
instead of `scale: 0.5`). The setting is a versioned phone-local record
(`photo-settings-store.ts` + `-expo.ts`, `voice-settings-store.ts`'s pattern)
with a Settings switch **"Send photos at original size"** (off by default).

**S2 — the row the phone sent shows its own image.**
`ImageRef` (`transcript-rows.ts:9-12`) gains optional `localUri` + `aspectRatio`;
`imageRef(ref, local?)`. The local file rides the send path additively:
`OutboxSession.prompt` / `ComposeDeps.prompt` take an optional 4th
`photos` argument (the item's copies), `outbox-driver.perform` passes them,
`promptWithRefs` maps `ref.id → file` into `OwnPrompt`, and `transcript.apply`'s
`user_message` case carries them onto the row. A reopened history row has no
local copy (no read-back method) ⇒ today's `[image: name]` placeholder stays.

**S4 — WhatsApp-shaped media bubble (pure model + dumb render).**
New `apps/mobile/src/media-layout.ts`: `layoutMedia(items, {maxWidth, maxHeight})`
— the image spans the bubble's width, its height is `width / aspectRatio`
clamped to `maxHeight`; a missing ratio is a square tile. The bubble renders
**media first, caption second** (`TranscriptRow.tsx:96-125`), media full bubble
width with the bubble's radius, no caption block when there is no text. Tapping
an image with a local URI opens `MediaViewer.tsx` (a `Modal` + `Image`).

**S3 — pull-to-refresh = the reopen the owner used.**
`SessionScreenController.resync()`: `controller.leave(id)` then the ordinary
`attach(false)` — the same path as leaving and re-entering, whose history arrives
as a `history` activity (reason `null`) and REPLACES the rows (`withHistory`,
`transcript.ts:274-281`), so no duplicates. `SessionScreenState.refreshing` drives
a `RefreshControl` on the transcript `FlatList`. Offline/busy: the attach's own
typed failure becomes an honest notice.

### Files

1. `apps/mobile/src/session-screen-controller.ts` — `folding.handle`; `resync()`;
   `refreshing`; `photos` on the prompt.
2. `apps/mobile/App.tsx` — `outboxOf`'s `getSession` from `folding.handle()`;
   `photoSettings` wiring.
3. `apps/mobile/src/photo-input.ts` · `photo-source.ts` — S5.
4. `apps/mobile/src/photo-settings-store.ts` · `photo-settings-expo.ts` — S5's switch.
5. `apps/mobile/src/screens/SettingsScreen.tsx` — the row.
6. `apps/mobile/src/transcript-rows.ts` · `transcript.ts` · `session-feed.ts` — S2.
7. `apps/mobile/src/media-layout.ts` (new) · `src/screens/transcript/TranscriptRow.tsx`
   · `src/screens/transcript/MediaViewer.tsx` (new) · `src/screens/SessionScreen.tsx` — S4/S3.
8. `apps/mobile/test/mobile-media-live-wiring.test.ts` (new) + the item tests below.

### Tests (red first, each with its mutation)

| test | red on | mutation that must turn it red |
|---|---|---|
| `outbox-link.test.ts` "a photo message's turn ends…" | the shipped wiring | the driver opening a second handle → the turn stays running |
| `mobile-media-live-wiring.test.ts` | old `App.tsx` text | `getSession` → `client.newSession` |
| `photo-input.test.ts` 4032×3024 → 2048×1536, 1200×900 untouched, `sendOriginal` bypass, HEIC still converted | the old step (no size target) | drop the edge rule / ignore `sendOriginal` / upscale |
| `photo-settings-store.test.ts` | no store | an unknown `v` written over |
| `transcript` / `session-feed` "the sent row carries its local file" | refs only | drop `localUri` |
| `media-layout.test.ts` (ratio clamp, missing ratio, caption-below order) | no model | unclamped height |
| `session-screen` "resync replaces the rows, never doubles them" + offline notice | no `resync` | append instead of replace |

### Failure modes

- **A resync while a turn runs**: `leave` detaches the listener; the re-attach's
  history is a snapshot of the daemon's truth, and the running turn re-announces
  itself as a `turn` activity (already handled by the feed). No duplicate rows.
- **Resync offline**: the attach fails typed (`link`); the screen keeps its rows
  and says so once — never an empty transcript.
- **A photo with no local copy** (reopened history, another device's message):
  the placeholder, never a broken `Image`.
- **`sendOriginal` with a HEIC**: still converted (no provider takes HEIC), just
  not resized — the bypass is about SIZE, not the format.
- **A photo that stays over `MAX_IMAGE_BYTES`**: unchanged — one shrink, then
  refuse visibly.
- **A missing picker width/height**: no resize decision is invented; the photo
  goes out as the picker gave it (the cap rule still applies).

### Validation

`bun test apps/mobile` per slice, then `bun run check` (typecheck → lint → test),
compared to the §6 baseline. No protocol/schema change (no new method, no field
on the wire), so no `protocol.d/` note and no `protocol.json` regeneration.

## Execution

### Fix round 1

*— claude-sonnet-4-5 (executor), 2026-11-17*

**Precondition, blocking and worth recording:** the disk was 100% full (117 MiB free), so
`bun test` could not even start — the preload's `mkdtempSync` threw `ENOSPC`. Cause: 11,035
leaked `/var/folders/…/T/tentacle-test-home-*` dirs (6.1 GB) from earlier runs
(`scripts/test-env-guard.ts:38` never removes them). I deleted only those older than 2 h
(no live run disturbed) and reclaimed 6.2 GB. Nothing in the repo was touched by this.

Done in the plan's order, after re-establishing each finding's red state.

**Finding 1 (HIGH, red gate).** `bunx tsc -p apps/mobile --noEmit` failed with
`session-feed.test.ts(261,7) TS2353 'photos' does not exist in type 'OwnPrompt'`, and
`bun run lint` had 6 errors. The lint errors were purely mechanical (organizeImports in
`App.tsx`/`photo-settings-expo.ts`/`outbox-link.test.ts`, format in `compose-controller.ts`
and the two statements joined on one line at `outbox-link.test.ts:923`, `useImportType` at
`SettingsScreen.tsx:16`) — `biome check --write` on those files, no semantics changed. The
typecheck error was the trace of S2 being half-built; finding 2a fixes it.

**Finding 2a (HIGH, S2 — the local photo reaches the row).** The plan's shape exactly: the
item's copies ride an optional 4th `photos` argument. New `localPhotosOf(item)`
(`outbox.ts`, beside `refsOf`) maps `ref.id → file`; `OutboxSession.prompt` and
`ComposeDeps.prompt` take it; `outbox-driver.perform` passes the UPLOADED item's;
`promptWithRefs` hands it to `feed.ownTurn`'s `OwnPrompt`; and the fold gained a distinct
input `own_prompt` (not a widened `user_message`, so a daemon- or peer-supplied event can
never claim local bytes) mapping refs through the already-present `imageRefWithLocal`. The
daemon's `user_message` case is untouched and still uses `imageRef`.

*Drift from the plan:* the plan said `transcript.apply`'s `user_message` case carries the
photos. That would put a local-URI field on the same input the wire's own `user_message`
parses into, so a ref-shaped payload could name a local file. A separate `own_prompt`
input is the same behaviour with the trust boundary intact.

*Drift:* item 2's `aspectRatio` is not exercised end-to-end. `PickedPhoto` carries no
width/height and the chip does not keep them, so a sent row has `localUri` but no ratio ⇒
a square tile (`media-layout.ts`'s documented fallback for an unknown shape). Threading the
picker's dimensions would touch the outbox record's validator for a cosmetic gain — left
as debt.

**Finding 2b (HIGH, S4 — the WhatsApp bubble).** New pure
`apps/mobile/src/media-layout.ts`: `mediaBox(ref, width)` (height from the ratio, clamped
at `MEDIA_MAX_RATIO = 4/3`, an honest `cropped` flag, and a missing or nonsense ratio
falling back to a square tile) and `layoutMedia(refs, {width, hasText})`. `TranscriptRow`'s
user bubble now renders **media first at full bubble width** (radius `radius.bubble`,
`resizeMode="cover"`) and the caption **below** it in the same bubble, with no caption
block at all when there are no words. The local URI wins over a fetched thumbnail. New
`MediaViewer.tsx` (a `Modal` + `Image`, one state, tap / close glyph / Android back) opened
by tapping an image.

*Drift:* the media width is the constant `MEDIA_BUBBLE_WIDTH = 218`, not a measured
`onLayout` width. A measured width needs a render-time round trip — the kind of logic §7
keeps out of a component — and `cover` in a box of the right SHAPE crops by a few points
instead of distorting. Debt.

**Finding 2c (HIGH, S3 — pull-to-refresh).** `SessionScreenController.resync()`: `leave` →
`attach(false)`, i.e. the owner's own recovery and the ONE attach path (§7), behind a
`refreshing` flag and a re-entry guard so a second pull is a no-op. The re-attach's history
is a `history` activity with reason `null`, which `withHistory` REPLACES, so rows never
double. A failed re-attach keeps the rows and says so once through the new
`RESYNC_FAILED_NOTICE` (`composer.ts`). `SessionScreen`'s transcript `FlatList` renders a
`RefreshControl` over it.

**Finding 3 (MEDIUM, the resize could distort).** Confirmed and fixed at the seam: the
decision moved out of the effect into `photo-input.ts`'s `resizeAxis(target)`, which names
the **long edge only** (width when `width >= height`, else height), and `photo-source.ts`
calls `reencode(…, resizeAxis(step))`. `reencode`'s target type is now one-edge-or-scale,
so naming both is not expressible; `ImageManipulator.resize` derives the other edge from
the pixels it actually holds, which is what makes a pre-EXIF-orientation picker report
harmless.

**One structural pin updated, deliberately:** `band-screens.test.ts` counted Settings'
bands (8) and listed them. Item 5's Photos switch is a real ninth band, so the count became
9 and "Photos" joined the label list. That test is a structure pin, not a behaviour one;
deleting the band to keep the count would have removed the owner's switch.

**Test non-vacuity (§9) — every mutation run and reverted.** Bun prints failures to
stderr, so each was read from `stdout + stderr`; `rc` is its exit code.

| module | mutation | result |
|---|---|---|
| `transcript.ts` fold | `imageRefWithLocal(...)` → `imageRef(ref)` | rc 1, 1 fail |
| `outbox-driver.perform` | drop the `localPhotosOf(...)` argument | rc 1, 1 fail (`localUri` undefined) |
| `outbox-link.test.ts` harness | driver's `getSession` opens a real second `client.newSession` (the review's own mutation, real API) | rc 1, 1 fail — `expect(...).toBeNull()`, the stuck "Running" |
| `media-layout.ts` | `MEDIA_MAX_RATIO` 4/3 → 1 | rc 1, 3 fail |
| `media-layout.ts` | `captionBelow` always `true` | rc 1, 1 fail |
| `media-layout.ts` | unsafe ratio used as-is | rc 1, 1 fail |
| `TranscriptRow.tsx` | `mediaBox(...)` → a hard-coded 96×96 box | rc 1, 1 fail |
| `SessionScreen.tsx` | `onRefresh` → a no-op | rc 1, 1 fail |
| `session-screen-controller.ts` | drop `RESYNC_FAILED_NOTICE` | rc 1, 1 fail |
| `session-screen-controller.ts` | leave `refreshing` true | rc 1, 2 fail |
| `transcript.ts` `applyHistory` | `withHistory` → `appendHistory` (append, not replace) | rc 1, 1 fail |
| `photo-input.ts` | `resizeAxis` always names the width | rc 1, 1 fail |
| `photo-input.ts` | `resizeAxis` names both edges | rc 1, 3 fail |

**Gate (on this branch, after every fix):**

```
bunx tsc --noEmit           → clean
bunx tsc -p apps/mobile     → clean
bunx tsc -p apps/relay      → clean
bun run lint                → clean (1747 files, 0 errors, 0 warnings; §6 baseline is clean)
bun test                    → 12687 pass, 5 skip, 0 fail (907 files, 13 snapshots)
```

The 5 skips are the pre-existing opt-in gates (live k8s ×2, live docker, the slow
real-socket keepalive, exec confinement) — none new, none mine.

**Debt, deliberate:** (a) a sent photo's `aspectRatio` needs the picker's dimensions in the
chip and the outbox record; (b) the media width is a constant rather than a measured bubble
width; (c) nothing exercises the `RefreshControl` on a device — the wiring guard pins the
call and the Maestro flows are a separate task. Unverified on hardware, as the plan's own
Validation said (no simulator here).

## Review

*— claude-opus-5-5, 2026-11-16* (fresh context; the same model family as the planner, not as the executor)

**Verdict: REQUEST-CHANGES.**

**Findings (HIGH/MEDIUM):**
1. **HIGH: the gate is red.** `bun test` on the touched files: 100 pass, **1 fail**. The failing test is `session-feed.test.ts:270`, "the sent row carries its LOCAL copy". `bun run typecheck`: `session-feed.test.ts(261,7) TS2353 'photos' does not exist in type 'OwnPrompt'`. `bun run lint`: **6 errors**, against a clean baseline (§6). They are organizeImports in `App.tsx`, `photo-settings-expo.ts` and `outbox-link.test.ts`; format in `compose-controller.ts` and `outbox-link.test.ts:923`, where two statements are joined on one line; and useImportType at `SettingsScreen.tsx:16`.
2. **HIGH: S2, S3 and S4 are not implemented, although "slice all" was in scope.**
   - S2: `photos` is not threaded through `OwnPrompt`/`transcript.apply`/`session-feed`. `imageRefWithLocal` (`transcript-rows.ts:175`) is dead code with no caller, so the sent bubble still shows `[image: name]`.
   - S3: there is no `resync()`, no `refreshing` and no `RefreshControl` on the transcript.
   - S4: `media-layout.ts`, `MediaViewer.tsx` and the `TranscriptRow.tsx` changes are missing, so owner items 2, 3 and 4 are still open.
   - The Execution section is empty, so none of this drift is declared.
3. **MEDIUM (plausible): the long-edge resize can distort a photo.** `photo-source.ts:629` passes BOTH `width` and `height` to `ImageManipulator.resize`, which does not keep the aspect ratio. The two numbers are computed from the picker's `asset.width/height`. If the picker reports pre-EXIF-orientation dimensions (a known expo-image-picker issue for rotated photos), a portrait photo is squashed into a landscape box. The plan said `resize({width})`. Pass only the long edge's dimension and let the manipulator derive the other.

**Mutation (§9):**
- In `outbox-link.test.ts`, I replaced `screenOn`'s `getSession` with a second `newSession`+`open` (the old `App.tsx` shape). The item-1 test went **red**: `transcript.turn` stayed `{own:true}` at line 1033. I reverted it and `git status` is clean, so S1's test is non-vacuous.
- Note: `await until(() => !screen.state().transcript.turn)` (line 1024) passes vacuously before the press. The test only holds because of the final `toBeNull()`.

**What holds:**
- S1 is correct and reuses the existing seam (`foldingOutboxSession` over the screen's `ComposeHandle.port`). It adds no second session path, so it respects the §7 "one session path" invariant.
- The pure step in S5 is sound (no upscale, GIF exempt, HEIC still converted with `sendOriginal`, bounded loop).
- The settings store follows the versioned pattern: an unknown `v` is never overwritten.

**Executor behaviour:** shipped about half the plan with a red gate and an empty Execution section. It added a test for unbuilt code (`session-feed`) that cannot typecheck.
