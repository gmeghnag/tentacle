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

*— Claude (Anthropic model id not exposed to this session; CLI 2.1.323 via `AI_AGENT=claude-code`), 2026-11-15*

**Branch/worktree:** ran in `.tentacle/worktrees/voice-off-by-default`, branch
`feat/voice-off-by-default`. No `git checkout`/`restore`/`stash`/`commit` was
issued (executor constraint).

### Load-bearing check (Implementation's assumption), run FIRST — PASSED

"Every TUI path resolves `voice.enabled` through `VOICE_DEFAULTS` merged with the
config." Verified by reading, before any edit:

- `packages/tui/src/voice-session.ts:40-41` — `VOICE_DEFAULTS.enabled: true` is the
  ONE default; the schema leaves `enabled` unset (`packages/config/src/schema.ts:457`
  `z.boolean().optional()`, no `.default()`), so nothing else can supply it.
- `packages/cli/src/main.ts:2268` (local TUI), `:1411` (run/attach), `:959`
  (`voice` command) and `packages/cli/src/connect.ts:159,164` all build
  `{ ...VOICE_DEFAULTS, ...(config.voice ?? {}) }`, or `VOICE_DEFAULTS` on a broken
  file. No path bypasses the merge.
- `packages/tui/src/useVoice.ts:83-87` reads `config.enabled` into
  `voiceAvailability`, and `App.tsx:217` defaults `voice` to `VOICE_DEFAULTS`.

So flipping that one object flips every path. **PASSED** — no bypass found.

### Repro (capability missing), before any edit

`.tentacle/tmp/voice-off-by-default/repro.ts`, on the branch as inherited:

```
VOICE_DEFAULTS.enabled   = true
key-docs rendered default= true
effective (voice: {})    = true
=> terminal voice is ON by default
```

The capability (off by default) is absent, as the Context claims.

### As-built, in order (red first, each slice's narrow file run)

1. **S1 — the default + the notice** (`packages/tui/src/voice-session.ts`).
   RED first: 4 new tests in `voice-session.test.ts` failed (the default was
   `true`, the notice was the old `(config: voice.enabled false)` wording).
   - `:43` `VOICE_DEFAULTS.enabled: false` (with a comment naming the opt-in).
   - `unavailableNotice("disabled")` → `voice is off — set "voice": { "enabled": true } in the config`.
   - **Drift, and why:** the plan's failure mode "Ctrl+R when off → the notice,
     never a spawn" could NOT hold with only the flip. The reducer's spawn path is
     gated on the `availability` its CALLER passes, and at least one test/caller
     can pass `{available: true}` while the config says off. I therefore made the
     property structural in `voiceInit` (`:207-217`): `!config.enabled` forces
     `unavailable: "disabled"` regardless of the caller. One line of computation,
     in the pure module (AGENTS §7), and it also keeps the notice honest — with
     the config off, "it is off over SSH" would be a lie. Mutation-proven (M4).
   - Existing dictation tests now OPT IN explicitly: `cfg()` in
     `voice-session.test.ts` and a named `ON` constant in `voice-app.test.tsx`.
     The one test that exercises the shipped default passes `VOICE_DEFAULTS`.

2. **S2 — `key-docs.ts` + the schema comment** (config package). RED first: the
   two new `key-docs.test.ts` cases failed (`Received: "true"`, and the prose did
   not name the opt-in).
   - `key-docs.ts:879-889`: summary is the plan's wording, `default: () => false`,
     details say `voice: { "enabled": true }` turns it on, `example: "true"` (the
     example is now the non-default, which is what an example should be).
   - `schema.ts:452` and the `enabled` field's doc comment now say "Absent: OFF …
     `voice: { "enabled": true }` turns the terminal's voice features on".
   - Stale comments fixed where they repeated the old default verbatim:
     `config/src/resolve.ts:190`, `tui/src/app-types.ts:447`, `tui/src/run.tsx:73`.

3. **S3 — `tentacle voice status`** (`packages/cli/src/voice-cmd.ts:110-119`).
   RED first: 2 new `voice-cmd.test.ts` cases failed (nothing was printed). It now
   prints, before the helper's own report and for `status` only:
   `voice: enabled` or `voice: disabled — set "voice": { "enabled": true } in the config`.
   `setup` prints nothing extra (pinned).

4. **S4 — docs.** `bun run docs:config` regenerated README's table (the drift gate
   `readme-config-table.test.ts` was RED before it, green after). Hand-edited
   prose: README's Features bullet and the "Voice dictation" intro now say it is
   off by default and how to turn it on; `docs/feat/voice-dictation.md` (the
   `enabled?: boolean` line and a note under the key table);
   `docs/feat/voice-conversation.md` gets one Preconditions line making the
   switch inherited by conversation mode (the plan asked for the note).

5. **S5 — failure-mode tests beyond the plan's list.** "A `voice` block present
   without `enabled` is OFF, not on" at two boundaries: the pure merge
   (`voice-session.test.ts`) and the real file read (`connect-voice.test.ts`,
   through `connectVoice`). "`enabled: true` in the file turns it on" on both too.

6. **Changelog:** `changelog.d/voice-off-by-default.changed.md` (one bullet).
   `CHANGELOG.md` untouched.

No protocol schema changed, so `packages/protocol/schema/protocol.json` was NOT
regenerated (nothing to regenerate — no `protocol.d/` note either: this is not a
wire change).

### Mutation checks (AGENTS §9: prove each test non-vacuous; all reverted)

| # | Target | Mutation applied | Result |
|---|---|---|---|
| M1 | `VOICE_DEFAULTS.enabled` | back to `true` | 4 RED: the 3 default-resolution tests + the App-level "NO config" test |
| M2 | `key-docs` `voice.enabled` | `default: () => true` | 1 RED: "documents `false` — absent means OFF" |
| M3 | `unavailableNotice("disabled")` | the old `(config: voice.enabled false)` string | 4 RED (reducer + App notices) |
| M4 | the `voiceInit` guard | `!config.enabled` → `false` | 1 RED: "a toggle with the default config is the notice, never a spawn" — the App-level path still passed (its own availability is correct), which is exactly why the guard is needed for callers that are not |
| M5 | the `voice status` line | deleted | 2 RED |

### Gate

- `bunx tsc --noEmit` → clean.
- `bun run lint` → `Checked 1655 files … No fixes applied` (0 errors, 0 warnings:
  matches the AGENTS §6 clean baseline). One round of `biome check --write` was
  needed first: Biome wants single quotes on the key-docs prose containing `"enabled"`.
- `bun test` → **11917 pass, 5 skip, 0 fail** (855 files, 416 s). The 5 skips are
  the documented opt-in gates and not new: 2 k8s (`TENTACLE_K8S_SERVER`), 2 docker
  (`TENTACLE_DOCKER_TESTS=1`), 1 slow keepalive (`TENTACLE_SLOW_TESTS=1`).
- `bun run docs:config` run; `readme-config-table.test.ts` green.

### Not verified / for Review

- No end-to-end run of the real Swift helper (opt-in, needs a Mac mic and the
  built binary). The off path cannot reach it (`voiceAvailability` + the new
  `voiceInit` guard both refuse), and the on path is the existing, unmodified
  spawn path, so the risk is low — but it is a reasoning argument, not a run.
- The `voice: { "enabled": true }` text appears in three places (the notice, the
  `status` line, the key-docs details). They are separate strings by design (one
  is a TUI notice, one a CLI line, one a doc card, in three packages), but nothing
  pins them to each other; a future reword can drift one.

## Review
