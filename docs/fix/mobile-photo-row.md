# fix/mobile-photo-row — the photo message renders after the reply, and as a placeholder

> **Type:** fix · **Size:** S–M · **Blast:** contained (apps/mobile transcript projection + thumbnail view; no protocol change expected) · **Suited:** DeepSeek executes, Opus review
> **Changelog:** `changelog.d/mobile-photo-row.fixed.md`

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-15*

Owner, real iPhone 12 Pro (iOS 18.3.1), build b97ff97b, 11:03 — screenshot `/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-ui/owner-shots/photo-row-1103.png`. A photo sent from the app reached `serve` and the model (the serve log has a `media_message` entry with `IMG_4854.jpg`, 1.29 MB, and Qwen3.8 described the picture correctly), but the app shows it wrong:

- **B9 (HIGH, ordering):** the user's row with the photo ("Cosa vedi?") is rendered BELOW the assistant's reply to it. The `media_message` row is placed after the reply instead of in log order (seq). Suspects: `apps/mobile/src/transcript-rows.ts` (projection), how `media_message` entries are merged with `message` entries, a separate list appended at the end.
- **B10 (thumbnail):** the photo shows a grey placeholder "[image: IMG_4854.jpg]" instead of the picture. Show the real thumbnail: for the phone's own just-sent photo use the local copy at once (outbox/cache); for history and other devices fetch it from the daemon by attachment id through the existing attachment read path (size-capped, cached, `apps/mobile/src/thumbnails.ts`), with loading and error states; tap opens full screen. If the daemon has no read path for attachments, STOP and record it as a plan correction (owner decision needed).

## Implementation

*— claude-opus-5-5 (orchestrator), 2026-11-15* — the executor first reproduces each bug with a red-first test (B9 on the pure transcript projection with a recorded log: `media_message` then the reply must render in log order; B10 on the thumbnail state machine), cites the cause with file:line in Execution, fixes it, mutation-checks the B9 test, and keeps `bun test apps/mobile`, `bunx tsc -p apps/mobile`, `bun run lint` green. Screens via `bun run e2e:mobile --ios 26 --only 18-photos` if the flow covers it.

## Execution

## Review
