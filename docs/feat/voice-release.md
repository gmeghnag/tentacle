# feat/voice-release — the macOS voice helper ships with every release

> **Status:** execution
> **Branch:** `feat/voice-release`
> **Type:** feat · **Size:** S–M · **Blast:** cross-module (CI + installer) · **Suited:** Opus (plan + execution); fresh-context Review recommended (CI path only provable on the first tag)
> **Changelog:** `changelog.d/voice-release.added.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner request (18/11): voice dictation must work after ONE command,
`curl -fsSL tentacle.so/install | sh`. Today the macOS helper `tentacle-voice`
(native/voice-mac, SwiftPM) is not a release asset: the release job publishes
only the four `tentacle-bun-*` binaries + `SHA256SUMS`
(`.github/workflows/build.yml`, matrix + `release` job), and `scripts/install.sh`
installs only the CLI. A user who installed the binary has no repo, so the only
documented way to get the helper — `bun run voice:build` — is not available to
them, and `tentacle voice status` tells them to run it anyway
(`packages/cli/src/voice-cmd.ts` `helperMissingNotice`).

**Repro** (2026-11-18, `main` @ 19aa1181): `rg tentacle-voice .github scripts/install.sh`
→ no match: no CI step builds the helper and the installer never fetches it.

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

The TUI and `tentacle voice` find a helper placed **next to the running
`tentacle`** with no configuration: `helperPathCandidates`
(`packages/tui/src/voice-spawn.ts:52-67`) returns `voice.helperPath`, then
`resolve(execPath, "..")/tentacle-voice` (`:61-63`), then
`<configDir>/voice/bin/tentacle-voice` (`:64`). So installing it as
`$TENTACLE_INSTALL_DIR/tentacle-voice` — the directory `install.sh` puts
`tentacle` in — is enough; no config, no code change on the lookup side.

### Preconditions

- The helper's package targets **macOS 26** (`native/voice-mac/Package.swift`,
  `platforms: [.macOS("26.0")]`, for `SpeechTranscriber`): it needs the macOS 26
  SDK to build, and dyld refuses it on an older macOS.
- `scripts/voice-build.ts` already builds `-c release` and signs ad-hoc like
  `scripts/build.ts`; it imports only bun builtins (no `bun install` needed).
- The release job collects artifacts by `pattern: tentacle-*` and checksums
  `tentacle-*` (`build.yml` release job): an artifact named `tentacle-voice-darwin`
  is published and listed in `SHA256SUMS` with no change to those lines.
- `install.sh` stages a download next to its destination and `mv`s it (atomic
  rename on one filesystem), cleaning stages in the `EXIT` trap.
- The helper had no side-effect-free mode: `nil` = the protocol loop (mic),
  `status`/`setup` touch speech assets (`main.swift` entry switch).

### Design

- **One universal binary, `tentacle-voice-darwin`** (arm64 + x86_64), not one per
  CLI target. Why: the helper is ~0.3 MB per slice, so doubling it costs nothing;
  it is ONE build, ONE smoke (an arm64 runner can't run an x64-only build
  anyway — the CLI's darwin-x64 is `smoke: false` for that reason), ONE checksum
  line, and the installer needs no target mapping (Rosetta shells included).
  `voice-build.ts --universal` passes `--arch arm64 --arch x86_64` to both the
  build and `--show-bin-path`.
- **A separate `voice` job on `macos-26`**, not a step in the darwin matrix rows:
  those run on `macos-latest`, whose SDK is not guaranteed to be 26; pinning the
  one job that needs it keeps the CLI builds untouched. Steps: build, `lipo -archs`
  must show both slices, `codesign --verify`, smoke `--version`, upload artifact
  `tentacle-voice-darwin`. `release` now `needs: [build, voice]` and refuses to
  publish unless all five assets are present.
- **`tentacle-voice --version`** (new, prints `tentacle-voice protocol 1`): no mic,
  no assets. It is the CI smoke AND the installer's "does it run on this Mac"
  check (it fails to load below macOS 26).
- **`install.sh`**, Darwin only, between the CLI and the pod binaries (so a fatal
  pod-binary failure never costs the helper): `install_voice` — not listed in
  `SHA256SUMS` → one line, skip (an older release; no request is even made);
  download fail / checksum mismatch / `--version` not `tentacle-voice …` → one
  line, skip, the existing helper untouched; else `chmod 755` + atomic `mv` to
  `$install_dir/tentacle-voice`. Every helper failure returns 0: it never fails
  the CLI install. Linux: unchanged (never requested).
- The "helper missing" hints (`voice-cmd.ts`, `useVoice.ts`) now name the
  installer first; `bun run voice:build` stays as the from-source path.

### Files

`native/voice-mac/Sources/TentacleVoice/main.swift` (`--version`) ·
`scripts/voice-build.ts` (`--universal`) · `.github/workflows/build.yml` (`voice`
job, release `needs` + asset check) · `scripts/install.sh` (`listed_sum`,
`install_voice`) · `scripts/release.ts` (the publish message) ·
`packages/cli/src/voice-cmd.ts`, `packages/tui/src/useVoice.ts` (hint) ·
`scripts/test/install.test.ts`, `packages/cli/test/voice-cmd.test.ts` ·
`README.md`, `docs/BUILD.md`, `changelog.d/voice-release.added.md`.

### Failure modes

| Case | Converges to |
|---|---|
| Older release (no helper in `SHA256SUMS`) | CLI installed; `- voice helper not in this release …`; helper not requested |
| Helper listed, download fails (404, network) | CLI installed; one `!` line; stage removed |
| Checksum mismatch | CLI installed; one `!` line with both digests; old helper kept |
| macOS < 26 (helper won't load) | CLI installed; `- voice helper skipped … needs macOS 26`; not installed |
| Pod-binary fetch fails after | script fails as before, helper already installed |
| Interrupted mid-download | `EXIT` trap removes `.tentacle-voice.install.$$`; old helper intact |
| CI: no macos-26 SDK / swift fails | `voice` job fails → `release` (needs it) does not run: no half release |
| CI: a slice missing, unsigned | `lipo`/`codesign --verify` step fails the job |
| Rename on one side only | the asset-name test (install.sh ↔ build.yml) fails |
| `tentacle update` later | updates the CLI, NOT the helper (debt, below) |

### Tests

`scripts/test/install.test.ts` (real `sh` + `curl` against a fake server; `uname`
faked on PATH so the Darwin path runs on Linux CI): installed next to tentacle +
executable · older release (one line, not requested) · checksum mismatch (old
helper kept, exit 0) · listed but 404 · helper that won't run (macOS < 26) ·
installed before the pod binaries · Linux never fetches it · asset name shared by
install.sh and build.yml (artifact, required list, `needs`).
`voice-cmd.test.ts`: the missing-helper notice names the installer.

## Execution

*— claude-opus-5-5, 2026-11-18*

1. Tests first: the 7 helper tests in `install.test.ts` → **6 fail** on the
   unchanged `install.sh` (the Linux one passes by design: it pins "unchanged").
2. `install.sh` → 14/14 pass. Non-vacuity by mutation: replacing the helper's
   checksum comparison with `if false` fails exactly the mismatch test; reverted.
3. `--version` in `main.swift`; `voice-build.ts --universal`. Local `bun run
   voice:build --universal` (Xcode on macOS 27): builds, 0.6 MB (warning only:
   "x86_64 deprecated for deployment target macOS 27" — the local SDK; the
   macos-26 runner targets 26).
4. Local end-to-end (`.tentacle/tmp/voice-release/run.sh`): a `file://` release
   with a stub CLI + the REAL universal helper + `shasum` SHA256SUMS → install.sh
   printed `✓ …/bin/tentacle-voice (tentacle-voice protocol 1)`; the installed copy
   is `x86_64 arm64`, `codesign --verify`: valid on disk after the move. Same base
   with the helper removed from SHA256SUMS → `- voice helper not in this release
   (voice dictation needs a newer one)`, CLI installed, no helper.
5. Workflow `voice` job + release checks; asset-name test added (no workflow
   linter exists in the repo). Hints in `voice-cmd.ts`/`useVoice.ts`; docs.
6. Gate: `bunx tsc --noEmit` clean · `bun run lint` clean (one Biome format fix
   applied to the test) · full `bun test`: **15284 pass, 5 skip, 0 fail**
   (1089 files; this task adds no skip — the skips are the pre-existing opt-ins).

Drift from plan: none.

**Only CI can prove** (first push to `main` / first `v*` tag): that `macos-26` is
an available runner label with Xcode 26 by default, that the universal build and
`--version` work there, and that the release lists `tentacle-voice-darwin` in
`SHA256SUMS`.

**Debt:** `tentacle update` replaces the CLI (`packages/cli/src/update.ts:247`,
`installDir = dirname(execPath)`) but not the helper next to it, so after an
update the helper can be older than the CLI. Harmless while the helper protocol
is v1 and versioned by `VOICE_PROTOCOL_VERSION`; a follow-up should fetch
`tentacle-voice-darwin` in `update` on macOS (same checksum + atomic path).
Re-running the installer refreshes it today.

## Review

*— pending*
