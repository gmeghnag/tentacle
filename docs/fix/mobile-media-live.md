# fix/mobile-media-live — after sending a photo the phone stays "Running" and never shows the reply; the photo has no thumbnail

`Type: fix · Size: S–M · Blast: contained (apps/mobile) · Suited: DeepSeek exec (repro first), Opus review`

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-16*

**Owner, live on the iPhone build of 2026-11-16 15:04 (main f0c80329 + build patch), session via `serve` on the Mac over the relay, model Qwen3.8-27B:**
1. Sent "Cosa vedi?" + a photo (IMG_4876.jpg). The header stays **Running** (spinner, Stop button) and no reply appears. **The daemon finished the turn**: the serve log `~/.config/tentacle/daemon/proj-2a4dc70b7988/de3ef43f-….jsonl` ends with `media_message` (user) → `message` (assistant: "Nella foto vedo: un contatore del gas…") → `turn_end` → `checkpoint`. **Leaving the session and re-entering shows the reply** ⇒ the history projection is fine; the LIVE path after a media message is broken (the assistant stream / turn_end updates of that turn are not applied, or applying them throws and the screen stops updating).
2. In the user bubble the photo renders as a placeholder `[image: IMG_4876.jpg]` with a generic image glyph instead of the photo's **thumbnail**.
3. Owner request (same task): **pull-to-refresh** on the session transcript — a resync (re-open/re-read the session from the daemon) as a safety net. Native `RefreshControl`, the mobile-chrome look.

## Implementation

*— the executor writes it FIRST (AGENTS §1, §8): reproduce, then plan, then fix.*

- **Repro first (paste output):** drive the phone's session controller/reducer (the existing fakes in `apps/mobile/test/`, e.g. the session-screen-controller / connection tests) through: send text + an image attachment → daemon echo of the user `media_message` → assistant deltas → `turn_end`. Assert the transcript shows the assistant text and the running state ends. Find which update the phone drops or throws on (media echo row shape, attachment ids, an exception in a row mapper, a turn-id mismatch between the media prompt and its updates…). Characterize: does it happen for a text-only message? (expected: no).
- **Thumbnail:** the user's own bubble must show the image it just sent (the local picked URI / the downscaled upload, docs/feat/attachments*.md); after a reopen, the history's media row should show a thumbnail if the daemon serves it, else a tasteful placeholder — say which and why.
- **Pull-to-refresh:** pull on the transcript → resync with the daemon (the reopen path the owner used), spinner while loading, no duplicate rows, works offline with an honest message.
- **Tests red-first** for each of the three; `bun run check` green.

## Execution

## Review
