# feat/voice-off-by-default — terminal voice is off unless the config turns it on

> **Status:** implementation APPROVED by the owner (2026-11-15, "la funzionalità voce da terminale lasciamola spenta di default, accendibile da config")
> **Branch:** `feat/voice-off-by-default`
> **Type:** feat · **Size:** S · **Blast:** contained (one default + its docs/tests; no protocol, persistence or terminal-path change) · **Suited:** any executor; standard Review
> **Changelog:** `changelog.d/voice-off-by-default.changed.md`: "- **Voice in the terminal is off by default.** Turn it on with `voice.enabled: true` in the config; Ctrl+R then dictates as before."

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-15*

The owner wants every voice feature of the TUI (today: Ctrl+R dictation, `docs/feat/voice-dictation.md`; next: the hands-free conversation mode, `docs/feat/voice-conversation.md`) OFF by default and enabled from the config. The switch already exists: `voice.enabled` (`packages/config/src/schema.ts:454-457`, "Off turns the key into a no-op notice; the helper is never spawned"), but its default is ON: `VOICE_DEFAULTS.enabled: true` (`packages/tui/src/voice-session.ts:40-41`) and `key-docs.ts:878-883` (`default: () => true`), plus the schema comment "Absent: enabled" (`schema.ts:452`).

## Implementation

*— claude-opus-5-5 (orchestrator), 2026-11-15*

- **Load-bearing assumption:** every TUI path (local `main.ts:2267`, `connect.ts:290`) resolves `voice.enabled` through `VOICE_DEFAULTS` merged with the config — verify by grep before editing; a path that bypasses it would stay ON.
- **Design:** flip the default to `false` in ONE place (`VOICE_DEFAULTS`), and align `key-docs.ts` (`default: () => false`, summary "Whether the terminal's voice features (Ctrl+R dictation; conversation mode later) are on. Off by default.") and the schema comment ("Absent: OFF …"). The disabled notice (`voice-session.ts:231`) must tell the user how to turn it on: `voice is off — set "voice": { "enabled": true } in the config`. `tentacle voice status` should print whether it is enabled and how to enable it. README / docs: where they describe Ctrl+R, say it must be enabled first. Regenerate the config docs (`bun run docs:config`) if the repo tracks their output.
- **Files:** `packages/tui/src/voice-session.ts`, `packages/config/src/key-docs.ts`, `packages/config/src/schema.ts` (comment), the voice-status command (rg "voice status"), README/docs mentions, tests listed below, `changelog.d/voice-off-by-default.changed.md`.
- **Failure modes:** a config with `voice` present but no `enabled` → OFF (the default, not "present means on"); `enabled: true` → behaves exactly as before (all existing voice tests run with it ON explicitly, not by default); the Ctrl+R key when off → the notice, never a spawn, and the key does nothing else.
- **Tests (red first):** default resolution → `enabled === false` with no config; Ctrl+R with no config → notice text contains `voice.enabled`, no helper spawned (`voice-spawn`/`voice-app` style); with `enabled: true` → unchanged behaviour (update existing tests to opt in explicitly); `key-docs.test.ts` default.
- The conversation-mode plan follows the same switch (noted in `docs/feat/voice-conversation.md`).

## Execution

## Review
