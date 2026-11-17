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

### The load-bearing check — it FAILED (in the useful direction: it found the bug)

The plan's instruction was "reproduce FIRST, then bisect where `voice` is lost".
Done before any edit, in `.tentacle/tmp/tui-voice-off-despite-config/`:

`r.ts` drives the REAL `main([])` with its `startTui` + `startWorkerRuntime` seams
faked (a terminal, so the plain local TUI path is taken) and prints the options
object `startTui` received, with `TENTACLE_CONFIG_DIR` pointing at a config holding
`"voice": { "enabled": true }`. On the unfixed tree:

```
exit: 0
startTui calls: 1
voice: {"enabled":false,"key":"ctrl+r","language":"auto","engine":"apple", …}
```

`enabled:false` — the owner's symptom reproduced, without a mic or a PTY, and
pointing at the options object rather than at the TUI.

`r2.ts` then bisected the layer, which is the whole diagnosis:

```
readFileConfig.voice: {"enabled":true}     ← the file IS read correctly
loadConfig.voice: undefined                ← …and then DROPPED
sources.voice: undefined
```

**Root cause (one sentence):** `TentacleConfig.voice` is declared
(`packages/config/src/load.ts:230`) and `resolveConfig` does produce it
(`resolve.ts:829`), but `loadConfig` never projected it into the object it
returns — `load.ts:914-916` spreads `mount`/`tui`/`sessions`/`relay`/… and skipped
`voice` — so EVERY consumer (`main.ts:961` `voice status`, `main.ts:1418`,
`main.ts:2284`) read `config.voice === undefined` and fell back to
`VOICE_DEFAULTS`, i.e. `enabled: false`.

This also corrects the plan's two suspects: `connect.ts` was **not** the local
path (a bare `tentacle` uses `startWorkerRuntime` → `runEngineTui`), and
`connectVoice`'s swallow was not what the owner hit. Both call sites were
*written* correctly (`wiring.test.ts:1124` pins their text, and passed) — they
were reading a field that was never filled. That is why two rounds of static
reading stalled: the defect is one line *absent* from a 30-line spread, invisible
to every test that injects `config` as a fixture.

### As built, in dependency order

1. **`packages/config/src/load.ts:916`** (the fix, one line) —
   `...(resolved.voice !== undefined ? { voice: resolved.voice } : {})`, beside
   `tui`/`sessions`. No default is invented: absent stays absent, exactly as for
   `tui`, so `VOICE_DEFAULTS` remains the TUI's job and "a `voice` block without
   `enabled`" keeps meaning OFF.
2. **`packages/cli/src/connect.ts`** — the plan's second requirement ("never
   silently default: a swallowed config error must surface as a notice").
   `connectVoice` gained a `write` parameter and its `catch` now writes one
   `[config] … — using the voice defaults (off)` line before falling back, the
   same pre-mount channel [`connectTheme`](packages/cli/src/connect.ts:166) uses.
   `connectTui` passes its own `write`. This one catch is special because its
   fallback is *off*: `connectChartGlyphs` may stay silent (a wrong glyph is
   visible), silence here reproduces the reported symptom's shape.
3. **Tests** — new `packages/cli/test/voice-tui-config.test.ts` (the owner's path,
   behaviourally, through the real `main`); `packages/config/test/voice-config.test.ts`
   and `packages/cli/test/connect-voice.test.ts` extended.

### Red → green, evidenced

| Test | Assertion | Before | After |
|---|---|---|---|
| `voice-config.test.ts` "the file's `voice` reaches `TentacleConfig.voice`" | `cfg.voice` | `undefined` (red) | `{enabled:true,key:"ctrl+k"}` |
| `voice-config.test.ts` "…without `enabled` keeps meaning OFF" | `cfg.voice` | `undefined` (red) | `{key:"ctrl+k"}` |
| `voice-tui-config.test.ts` "`enabled: true` reaches `startTui`" | `voice.enabled` | `false` (red) | `true` |
| `voice-tui-config.test.ts` "settings beside `enabled` survive" | `voice.key` | `"ctrl+r"` (red) | `"ctrl+k"` |
| `voice-tui-config.test.ts` "`voice status` agrees with the file" | stdout | `voice: disabled…` (red) | `voice: enabled` |
| `connect-voice.test.ts` "a broken file says why voice fell back" | written lines | `[]` (red) | 1 × `[config] …` |

The first three reds were on the ASSERTION, never on an import or compile error.

### Mutation checks (non-vacuity, AGENTS §9) — all paste-verified, then reverted

1. Delete the `voice` projection in `load.ts` → **4 red** across
   `voice-config.test.ts` + `voice-tui-config.test.ts`.
2. Delete `voice: { ...VOICE_DEFAULTS, … }` from the local `startTui` call
   (`main.ts:2284`) → **3 red** in `voice-tui-config.test.ts`.
3. Delete the `write(…)` from `connectVoice`'s catch → **1 red** in
   `connect-voice.test.ts`.
4. Delete the `voice` projection again, with the new `voice status` test in place
   → **3 red**, including it. Confirmed independently by hand:
   `bun packages/cli/src/main.ts voice status` printed
   `voice: disabled — set "voice": { "enabled": true } in the config` on the
   mutated tree and `voice: enabled` on the fixed one.

### A second symptom the same bug had (found by this work)

`tentacle voice status` — the command a user runs exactly when dictation is
broken — reads `config.voice` at `main.ts:961` and so also said
`voice: disabled — set "voice": { "enabled": true } in the config` for a file that
already said it. Pinned by the `voice status` test above. It is not separately
listed in the plan; it is the same missing line.

### Drift from the Implementation

- The plan said "start the real TUI the way the owner does … under a PTY
  (`script`/`expect`)". Not done: the `startTui`/`startWorkerRuntime` seams give
  the same observable at the boundary that matters (the options object the TUI
  reads), deterministically and without a mic prompt or an alt-screen to parse.
  A PTY frame capture would have shown the same notice from the same
  `enabled:false`, one layer further from the cause.
- The plan's two named suspects (`connect.ts` / `connectVoice`) were not the
  owner's path. Fixed anyway, because the plan asked for the silent-default rule
  and it is a real defect on `connect`.
- No `protocol.d/` note: nothing wire-visible changed.

### Gate

```
bunx tsc --noEmit                      → clean (exit 0)
bun run typecheck                      → clean (tsc --noEmit && mobile && relay)
bun run lint                           → "Checked 1990 files … No fixes applied." (0/0, baseline clean)
bun test                               → 14501 pass, 5 skip (the 3 opt-in), 6 fail
```

The 6 full-suite failures are **pre-existing load flakiness, not this diff**:
every one of them passes in isolation and none imports `@tentacle/config`'s
`loadConfig`, `connectVoice`, or the voice path —
`packages/cli/test/voice-turn-f10.test.ts` (fails 1-of-2 under load, and was
re-run with this fix's line MUTATED OUT: identical 1-pass/1-fail, four times),
`packages/agent/test/prune-loop.test.ts`, `packages/tui/test/thinking-shimmer-sgr.test.ts`,
`packages/tui/test/chart-lines.test.ts` (5 s timeout in a 2400-assertion sweep),
`packages/docker/test/ssh-dialer.test.ts` (a fake-`ssh` child pid read before it
is written). Each was run alone just now: 11/0, 7/0, 51/0, 24/0.

Narrow runs of everything this task touches: `packages/config` (459 pass),
`packages/cli` (3520 pass, 2 opt-in skip), `packages/tui` (2708 pass).

*— deepseek-v4-pro (DeepSeek), 2026-11-17*

## Review
