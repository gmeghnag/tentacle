# fix/mobile-connect-latency — the phone connects at once and re-reads a session reliably

Type: fix · Size: M · Blast: cross-module (app link + `@tentacle/client`) · Suited: Opus plan → executor → Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-24*

Owner 23/11 ~23:55: on the iPhone a Mac session (the owner's `serve` in ~/assistant, via relay.tentacle.so) stays «connecting» a few seconds, on a cold open AND back from background; and sometimes, after a reconnect, the session shows in red «could not re-read this session — showing what was already loaded» with the composer saying «This session has ended», until the owner switches to another session and back. A Sonnet triage (code-read, NOT device-proven) wrote `.tentacle/tmp/connect-latency/REPORT.md` — read it all; its file:line claims must be re-verified, its causes proven (red-first fake-clock tests) before fixing:
- `address-dial.ts:43` `STAGGER_MS` 750 per direct address even when the previous one rejected fast (the Mac advertises LAN + Tailscale before the relay → ~1.5 s off-LAN); `lastGood` not persisted across a cold start.
- `suspend()` starts a full-jitter backoff (≤ 30 s); `resume()` does not redial now; attempts may count while suspended.
- serial relay round trips (relay dial → Noise → initialize → session/open) — measure with per-phase timing logs; parallelise only what is safe.
- re-read: `resync()` (`session-screen-controller.ts:2147`) does `leave` then `attach`; if the attach fails (`gone` when the entry is `closing`, `remote-client.ts:4236`; or a 30 s timeout) the screen stays `failed` with no handle, and `link(up)` never retries (`remote-client.ts:1793`); the «ended» placeholder (`SessionScreen.tsx:1685`) is wrong for this state.
Owner 24/11 ~00:10: queue it right after `feat/mobile-native-sheets` (with `feat/image-view`). `feat/workflows-ui` (branch, unmerged) touched `client/src/remote-client.ts` (slice 1b) — list the overlap and how to avoid a conflict.

## Implementation

## Execution

## Review
