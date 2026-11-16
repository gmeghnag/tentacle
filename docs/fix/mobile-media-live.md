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

## Review
