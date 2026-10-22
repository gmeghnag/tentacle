# eval/tentacle-update — `tentacle update`: self-update the CLI and its cached pod binaries

> **Status:** eval — **all decisions taken by the owner 2026-10-22** (see *Owner decisions*); ready to promote as three children
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** M overall → split on promotion (see *Proposed split*) · **Blast:** cross-module (cli + pod-binary resolution + the release workflow; it rewrites the user's own executable) · **Suited:** strong model executes; standard Review plus a manual end-to-end run against a real release

## Context

*— claude-opus-5-5, 2026-10-20*

**Question being decided:** what `tentacle update` does, where it gets its
bits from, how it replaces the running executable safely, and how it keeps
the Linux binaries injected into pods (`run`/`attach`) in step with the laptop
binary, so that after an update the laptop and the pod never run different
versions by accident.

**Premise:** releases and code live at the **public** repo
`https://github.com/gmeghnag/tentacle` (it is private today; this eval assumes
it is already public, as decided 2026-10-20). Every download is anonymous HTTPS:
no token and no `gh` dependency.

### Verified facts (current `main` @ `82e7fcb`)

- **F1 — what "version" means.** A compiled binary's version is
  `packages/cli/package.json` `version`, baked in at build time with a
  `define` (`packages/cli/src/pod-binary-build.ts:102-108`). It is read at
  `packages/cli/src/main.ts:45` (`APP_VERSION`), and when you run from source
  it is `"dev"`. `tentacle --version` prints `tentacle <version>` and exits
  before config loading (`main.ts:147-153`). **Today every version is
  `0.0.0`**, so without a version-bump discipline an update has nothing to
  compare.
- **F2 — what a release contains.** `.github/workflows/build.yml` (added
  2026-10-20) publishes on a `v*` tag four raw, non-archived binaries,
  `tentacle-bun-{linux,darwin}-{x64,arm64}`, plus `SHA256SUMS`. The `release`
  job fails if the tag is not `v<packages/cli version>`, so **tag ↔ asset ↔
  `--version` agree by construction**. The macOS assets are ad-hoc
  `codesign`ed on a macOS runner (`scripts/build.ts`).
- **F3 — where pod binaries come from.** `resolvePodBinary`
  (`pod-binary-build.ts:174-215`) checks, in order: `TENTACLE_POD_BIN`
  (`:181`) → `<configDir>/bin/tentacle-<target>` (`:190`, `configBinPath`
  `:148`) → the repo cache `dist/pod-bin/` (`:199`) → a build from source.
  `configDir` is `--config-dir` › `TENTACLE_CONFIG_DIR` ›
  `$XDG_CONFIG_HOME/tentacle` › `~/.config/tentacle`
  (`packages/config/src/load.ts:112-123`). The asset names in F2 match
  `tentacle-<target>` exactly. **Consequence today:** a user who installed only
  a release binary, with no source tree, cannot `run`/`attach` until they put
  the Linux binaries in `<configDir>/bin/` by hand, because the build fallback
  needs the repo (error text at `:208`).
- **F4 — `attach` reuses whatever is in the pod, with no version check.** The
  preflight runs `tentacle --version` in the pod and, on exit 0, skips
  injection and serves that binary, whatever its version
  (`packages/cli/src/pod-runtime.ts:405-419`). `run` always injects fresh
  (`pod-runtime.ts:236-252`). So after an update, re-attaching to a pod injected
  earlier keeps the **old daemon**. If the protocol changed in between
  (`PROTOCOL_VERSION = 5`, `packages/protocol/src/version.ts:7`), it fails
  cleanly with `VersionMismatch` at `initialize`. If it did not, the skew is
  **silent**: same protocol, older daemon behaviour.
- **F5 — re-injecting over a live binary would fail.** The install command is
  `head -c N > <binPath>` (`packages/cli/src/pod-binary.ts:172`): it truncates
  the target in place. If another session's daemon is still running from that
  file, Linux refuses the write with `ETXTBSY` ("Text file busy"). Any fix to F4
  must write to a temp file and `mv` it over (a rename does not touch the
  running inode).
- **F6 — GitHub serves "latest" without the API** (checked 2026-10-20 on a
  public repo, `oven-sh/bun`):
  `GET https://github.com/<o>/<r>/releases/latest` → `302 Location:
  …/releases/tag/<tag>` (version discovery), and
  `…/releases/latest/download/<asset>` → `302` to the asset blob → `200`. The
  `api.github.com` endpoint is limited to 60 req/h unauthenticated; the
  redirects are not. Drafts and pre-releases are never "latest".

### Where this sits with the §7 invariants

`update` runs **only on the laptop**, on the user's command. The pod never asks
for it and never supplies bytes for it. The pod binaries still flow
laptop → pod exactly as today (F3), so "identity on the laptop, a pod is not
trusted" is untouched. No protocol change: the command is local and does not
open a session.

### Proposed design (to discuss, not approved)

**Command surface**

```
tentacle update               # update to the latest release (self + pod binaries)
tentacle update --check       # only report current → latest; exit 0 up to date, 10 update available
tentacle update --version v0.4.0   # pin / downgrade to a specific tag
```

**Algorithm (stage everything, then commit; the executable is swapped last)**

1. Refuse if `APP_VERSION === "dev"`: running from source, `process.execPath`
   is the `bun` binary itself and must never be overwritten. Suggest
   `git pull && bun run compile`.
2. Resolve the target tag (F6 redirect, or `--version`). If it equals
   `APP_VERSION` and the pod binaries are already at that version, print "up to
   date" and exit.
3. Download `SHA256SUMS`, then, each to a temp file **in the destination
   directory** (same filesystem, so the final `rename` is atomic):
   - the laptop asset `tentacle-bun-<os>-<arch>`, next to `process.execPath`;
   - both Linux pod assets (`linux-x64`, `linux-arm64`), into `<configDir>/bin/`
     (D1, decided).
4. Verify every temp file against `SHA256SUMS`, plus the signature if D3 says
   so, then `chmod 755`. Run the new laptop binary's `--version` (same
   arch, so it runs) and require exactly `tentacle <tag without v>`.
5. Commit: `rename` the pod binaries first and **the laptop binary last**. A
   crash before step 5 leaves the old install intact. Temp files are removed in
   `finally`.
6. Record the pod binaries' version (D2) and print `0.3.1 → 0.4.0`.

Other processes already running the old executable keep their inode and are
unaffected (Unix rename semantics). This includes the in-process worker, which
is embedded in the same file.

### Decisions to take

- **D1 — which pod binaries. DECIDED by the owner (2026-10-22): downloaded by
  `tentacle update`, never lazily at the first `run`/`attach`.** `update`
  installs **both** Linux pod binaries (`linux-x64`, `linux-arm64`) at the
  target version, and fills in missing or out-of-date ones even when the CLI is
  already up to date (so `tentacle update` is also the first-time setup of the
  pod binaries for a release-only install). `run`/`attach` never touch the
  network: a missing pod binary, or one whose version (D2) ≠ `APP_VERSION`, is
  an error that says `run: tentacle update`. Open sub-question: a
  `--no-pods` flag for users who never use pods (saves ~2 × 89 MB)?
- **D2 — how a cached pod binary knows its version.** The laptop cannot
  execute a Linux binary to ask it (macOS laptop). Options: (a) put the version
  in the file name (`tentacle-<version>-<target>`, old ones garbage-collected);
  (b) a sidecar `<configDir>/bin/manifest.json` `{version, sha256 per target}`.
  *Recommendation: (b).* The F3 lookup path stays the same, and the manifest
  doubles as the integrity record. `resolvePodBinary` treats a
  version ≠ `APP_VERSION` as a miss: an error pointing to `tentacle update` (D1).
- **D3 — integrity beyond HTTPS.** `SHA256SUMS` from the same release catches
  corruption and truncation, **not** a compromised release or account.
  Options: (a) SHA-256 only; (b) GitHub artifact attestations
  (`actions/attest-build-provenance`), but verifying them needs `gh` or a
  Sigstore client, which is heavy for a self-updater; (c) sign `SHA256SUMS` in
  CI with an **Ed25519** key kept in a repo secret, embed the public key in the
  binary, and verify with `node:crypto` (no new dependency). *Recommendation:
  (c)*, cheap and it closes the "replace my executable from the internet" risk.
  Key rotation means a release that embeds the new key, signed with the old.
- **D4 — the attach version skew (F4/F5).** The preflight should compare the
  pod's `--version` with `APP_VERSION` and re-inject on mismatch, writing
  through a temp file + `mv` (F5). *Recommendation: a separate small `fix`*,
  because it is a bug today even without `update`, and keeping it separate keeps
  the update task free of k8s code. Open sub-question: on mismatch, re-inject
  silently or ask, since another user's session may be running the old daemon
  in that pod. The old daemon keeps running on its inode, so re-injecting is
  safe for it.
- **D5 — unwritable install path.** If `dirname(process.execPath)` is not
  writable (e.g. `/usr/local/bin` owned by root), fail with the exact
  `sudo tentacle update` hint. Never escalate on our own. Package-manager
  installs (Homebrew later) should refuse and point to the package manager.
  Detection is by path prefix, or by a marker the formula sets; decide when
  Homebrew exists.
- **D6 — update notifications.** A passive "new version available" check at
  startup means a network call on every launch. *Recommendation: out of scope
  for v1* (explicit `update` / `--check` only); revisit with an opt-in config
  key.
- **D7 — version discipline (prerequisite).** Releases need a real semver
  bump in `packages/cli/package.json` before tagging. The workflow already
  rejects a mismatched tag. Comparison is by semver, so a downgrade happens only
  through an explicit `--version`.

### Failure modes (how state converges)

| Case | Outcome |
|---|---|
| Network drop / GitHub 5xx mid-download | Temp files deleted; old install untouched; exit non-zero with the URL that failed |
| Checksum or signature mismatch | Same as above; message names the asset; nothing renamed |
| Asset missing for this platform (e.g. a future target not built) | Abort before any download of the others; list the release's assets |
| Disk full in `<configDir>/bin` or install dir | Write error before commit; temps cleaned |
| Crash during commit (between pod renames and self rename) | Pod binaries at new version, laptop at old: the manifest says new, so `resolvePodBinary` (D2) sees a version ≠ `APP_VERSION` and re-fetches the old one. It converges on the next `run`/`attach`. Re-running `update` finishes the job |
| Two `tentacle update` at once | Both stage separate temps; the last rename wins; contents identical (same tag) |
| Running from source (`dev`) | Refused (step 1): never overwrite `bun` |
| Install dir not writable | Refused with the `sudo` hint (D5) |
| Old pods after update | Handled by D4, not by `update` (it does not touch clusters) |
| macOS Gatekeeper | `fetch` sets no quarantine xattr; the asset is ad-hoc signed in CI (F2), and rename preserves the signature |

### Proposed split on promotion

1. ~~**`fix/attach-version-skew`**~~ dropped (D4). (S, cross-module): preflight compares
   versions; re-inject via temp + `mv` (D4, F4/F5). Independent; can go first.
2. **`feat/pod-binary-download`** (S, contained): D1 (download helper used by
   `update`; `run`/`attach` error on a missing/stale binary) + D2 manifest in
   `resolvePodBinary`, with an injected `fetch` seam and `SpyFetch` tests.
3. **`feat/tentacle-update`** (M, cross-module): the command, staged
   download/verify/commit, `--check` / `--version`, plus the CI step that signs
   `SHA256SUMS` (D3). Reuses the download + verify helpers from task 2.

### Owner decisions (2026-10-22) — these supersede the proposals above

| # | Decision |
|---|---|
| D1 | `tentacle update` downloads **both** Linux pod binaries at the target version (also filling missing/stale ones when the CLI is current). Never lazily: `run`/`attach` stay offline and fail with "run `tentacle update`" on a missing or stale pod binary |
| D2 | **No `manifest.json`.** A version **marker** constant compiled into the binary (e.g. `TENTACLE_VERSION_MARKER:<version>:END`); tentacle reads a Linux pod binary's version by scanning the file **from the end** (the bundle sits in the last MBs). Never modify the binary after build (macOS code signature; Bun's trailing payload on Linux). A build test asserts the marker matches the version. A binary without a marker (e.g. 0.1.0-beta.1) = unknown version → replaced by `update` |
| D3 | **HTTPS + SHA-256 only** (`SHA256SUMS` of the same release). No attestations, no signing in v1; Ed25519-signed `SHA256SUMS` recorded in `TODO.md` as later hardening |
| D4 | **Unchanged:** `attach` keeps reusing whatever tentacle binary is already in the pod; no re-inject. (Protocol 10 already turns a skew into a clean `VersionMismatch` at `initialize`.) No `fix/attach-version-skew` task |
| D5 | Install dir not writable → `update` says so and fails (with the `sudo` hint); never escalates itself |
| D6 | No startup "new version available" check; only explicit `update` / `update --check` |
| D7 | A **release script** (`bun run release <version>`): bumps every `package.json`, turns `[Unreleased]` into `[<version>] - <date>` in `CHANGELOG.md`, commits and tags; refuses on a dirty tree or a red gate. `0.1.0` is the first public tag |
| D8 | No `--no-pods` flag. **Everything ships in v0.1.0.** Order: (1) `feat/pod-binary-download` (marker + download/verify helper + `run`/`attach` offline error) → (2) `feat/tentacle-update` (the command) → (3) `feat/release-script` |

## Implementation

*(empty until promoted — see AGENTS §10)*

## Execution

*(empty until promoted)*

## Review

*(verdict pending the discussion of D1–D7)*
