# fix/tui-voice-off-despite-config — Ctrl+R says "voice is off" although the config enables it

> **Status:** context · implementation (executor: repro FIRST, then plan, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/tui-voice-off-despite-config`
> **Size:** S · **Blast:** contained (cli → tui voice config plumbing) · **Suited:** DeepSeek exec + Opus review
> **Changelog:** `changelog.d/tui-voice-off-despite-config.fixed.md`

## Context

Owner 2026-11-17 ~11:50, Mac, `~/bin/tentacle 0.6.0+b460f20d9db8` (main 90d936cd), a FRESH TUI started in `~/Documents/cases/07813345` (plain local TUI, footer `~/Documents/cases/07813345 · ctx … · auto-accept on`), Ctrl+R → notice `voice is off — set "voice": { "enabled": true } in the config`.

Facts (orchestrator, verified):
- `~/.config/tentacle/config.jsonc` has `"voice": { "enabled": true }`; in that folder `tentacle config list` prints `voice.enabled = true  # file`; `readFileConfig({})` there returns `voice: {"enabled":true}` (repro `.tentacle/tmp/voice-off/r.ts`).
- The notice is `unavailableNotice("disabled")` (`packages/tui/src/voice-session.ts:245`), reached when the TUI's `voiceConfig.enabled` is false — i.e. App got `VOICE_DEFAULTS` (`App.tsx:245` default) or a config without `enabled`.
- Static reading found `voice` passed on main.ts:1418 (runEngineTui), 2284 (local), connect.ts:355; `connectVoice` swallows ANY error into `VOICE_DEFAULTS` (connect.ts:221 catch) — a silent-drop suspect.
Static reading has stalled (two strikes): the next step is EMPIRICAL.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor: reproduce FIRST — start the real TUI the way the owner does (plain `bun packages/cli/src/main.ts` / the compiled binary in a temp folder with a temp config dir holding `"voice": {"enabled": true}`, under a PTY: `script`/`expect` or the repo's TUI harness) and capture the notice after Ctrl+R; then bisect which start path the plain `tentacle` takes today (local relay? worker? connect-like?) and where `voice` is lost (log the props reaching `App`/`useVoice` in the repro, not in the product). Fix at the root, never silently default: a swallowed config error must surface as a notice. Regression test that fails today for the exact path the owner uses. Do NOT touch the owner's real config.

## Execution

## Review
