# feat/tentacle-update — `tentacle update`: self-update the CLI and its pod binaries

> **Status:** review
> **Branch:** `feat/tentacle-update`
> **Type:** feat · **Size:** M · **Blast:** cross-module (it rewrites the user's own executable) · **Suited:** strong model executes; standard Review + a real `--check` against GitHub

## Context

*— claude-opus-5-5, 2026-10-22*

Child 2 of 3 of `docs/eval/tentacle-update.md` (owner decisions D1, D2, D3,
D5, D6). Child 1 (`feat/pod-binary-download`, merged `57502f0`) added the
version marker, `readBinaryVersion`, the download+verify helper, and made
`run`/`attach` refuse a missing or stale pod binary with "run `tentacle
update`". That command does not exist yet, so a release install is at a dead
end. This task adds it and folds in child 1's review nits N1–N4.

- **D1** — `update` installs **both** Linux pod binaries at the version the CLI
  will be at, and fills in missing or stale ones even when the CLI is current.
- **D2** — a pod binary's version is its marker; no marker = unknown = replaced.
- **D3** — HTTPS + the release's `SHA256SUMS`.
- **D5** — an unwritable install dir fails with a `sudo` hint, never escalates.
- **D6** — no startup check; only explicit `update` / `update --check`.

**Repro** (2026-10-22, `main` @ `57502f0`):

```
$ bun packages/cli/src/main.ts update --check
# → "update --check" is taken as a one-shot PROMPT (cliMode → "prompt"):
#   there is no `update` command (packages/cli/src/flags.ts cliMode/COMMANDS).
$ curl -sI https://github.com/gmeghnag/tentacle/releases/latest | head -1
HTTP/2 404            # the repo is private today (or has only pre-releases)
$ curl -sI https://github.com/oven-sh/bun/releases/latest | grep -i location
location: https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4
```

## Implementation

*— claude-opus-5-5, 2026-10-22*

### Load-bearing assumption

**On Unix, `rename(temp, process.execPath)` atomically replaces the running
executable without disturbing the running process, and a same-directory temp
makes it atomic.** POSIX `rename(2)` semantics: the running process keeps its
inode. The temp is created in `dirname(process.execPath)`, as
`downloadVerifiedAsset` already does for its `destDir`
(`pod-binary-download.ts:97-150`). The real `--check` and a scratch-dir self
replace are run in Execution.

### Preconditions

- `APP_VERSION` is `"dev"` from source (`version.ts:40`). In that case
  `process.execPath` is `bun`, which must never be overwritten.
- `readBinaryVersion` (`version-marker.ts:84`) and `configBinPath`
  (`pod-binary-build.ts:158`) give each pod binary's status.
  `POD_BINARY_TARGETS` (`:190`) lists both targets.
- `downloadVerifiedAsset` returns a verified 0755 temp in `destDir`;
  `commitDownload` renames it (`pod-binary-download.ts:97,154`).
- Release assets: `tentacle-bun-{linux,darwin}-{x64,arm64}` + `SHA256SUMS`,
  tag `v<packages/cli version>` (`.github/workflows/build.yml` release job).
- `main` dispatches by `cliMode` (`flags.ts:459`), with per-command `ARGS`
  (`flags.ts:55`) and `USAGE`. `configDir` is resolved only inside
  `loadConfig` (`packages/config/src/load.ts:164`, not exported). `update`
  needs the dir, not the model config.
- Bun's `fetch` with `redirect: "manual"` returns the `302` and its `Location`.
  With the default it follows the asset redirect to
  `release-assets.githubusercontent.com` (probed 2026-10-22 on `oven-sh/bun`).

### Design

**"Latest" = the `/releases/latest` redirect, not the API.**
`GET https://github.com/<repo>/releases/latest` with `redirect: "manual"`
returns a `302` to `…/releases/tag/<tag>`. Reasons:
- no 60 req/h unauthenticated API limit;
- no JSON to parse;
- drafts and pre-releases are never "latest".
Status handling:
- 404 means no published release, or a non-public repo. The message says
  exactly that and suggests `--version`.
- 403/429 is reported as rate limiting or blocked.
- Anything else is reported with its status.

1. **Pure plan** (`packages/cli/src/update-plan.ts`):
   - `compareVersions` (semver precedence, pre-release < release);
   - `normalizeTag`;
   - `tagFromLatestLocation`;
   - `laptopAsset(platform, arch)`;
   - `planUpdate({current, target, explicit, pods})` returns
     `{ self: version | null, podVersion, podTargets, status }`.
     - The CLI moves only when `--version` names a different version, or when
       latest > current. A CLI that is *ahead* of latest is left alone.
     - The pods always go to the version the CLI ends at; any pod whose marker
       ≠ that version (missing, unknown, stale) is in `podTargets`.
2. **Command** (`packages/cli/src/update.ts`, `runUpdate(opts, deps)`, with
   injected `fetch`, `runVersion`, `rename`, `isWritable`). Steps:
   1. Refuse `dev`.
   2. Resolve the target.
   3. Read the pod markers and plan.
   4. Print `current → target`. `--check` stops here: exit 10 if `update`
      would change anything (CLI or pods), else 0.
   5. **D5:** check that the install dir (when the CLI moves) and
      `<configDir>/bin` (mkdir) are writable, **before any download**. The hint
      is `sudo TENTACLE_CONFIG_DIR=<configDir> tentacle update`, which keeps
      the pod binaries in the user's dir.
   6. Fetch `SHA256SUMS` once per tag.
   7. Stage: the pod binaries into `<configDir>/bin`, the laptop asset next to
      `execPath`. The helper verifies each one.
   8. Check every pod temp's marker = `podVersion`. A temp with no marker is
      refused (post-review).
   9. Run the new CLI's `--version` and require `tentacle <target>`.
   10. Commit: rename the pods first, **the CLI last**.
   11. `finally`: remove any temp that was not committed.
3. **Wiring:** an `update` mode in `flags.ts` (`ARGS.update` = `--check`,
   `--version <v>`, no positionals). `main.ts` dispatches before
   `loadConfig`. `configDirFromEnv` is exported from `packages/config`.
4. **Nits from child 1:**
   - **N1:** `build.ts` asserts exactly one well-formed marker
     (`findAllVersionMarkers`).
   - **N2:** a dedicated define `__TENTACLE_VERSION_MARKER__` with a `typeof`
     guard, so the environment cannot set the version.
   - **N3:** `parseSha256Sums` throws on a name listed with two different
     digests.
   - **N4:** `file.sync()` before close; a size cap (default 512 MiB); cancel
     the body on the HTTP-error and open-failure paths; refuse a redirect that
     lands on a non-HTTPS URL.

### Files

`packages/config/src/load.ts` · `packages/cli/src/version.ts` ·
`packages/cli/src/version-marker.ts` · `packages/cli/src/pod-binary-build.ts` ·
`scripts/build.ts` · `packages/cli/src/pod-binary-download.ts` ·
`packages/cli/src/update-plan.ts` (new) · `packages/cli/src/update.ts` (new) ·
`packages/cli/src/flags.ts` · `packages/cli/src/main.ts` · `README.md` · tests.

### Failure modes

| Case | Outcome |
|---|---|
| Source mode (`dev`) | refused, exit 1, nothing fetched |
| No full release: `/releases/latest` is 404 (private repo) or a 3xx whose `Location` is not `/releases/tag/<tag>` (public repo with only pre-releases redirects to `…/releases`) | clear "no published release … pick a tag with --version" message, exit 1 (post-review fix) |
| Install dir or `<configDir>/bin` not writable | refused before any download, with the `sudo` hint |
| HTTP error / network drop / checksum mismatch | the helper removes its temp; `finally` removes the others; nothing renamed |
| New CLI `--version` ≠ target, or it fails to run | abort before any rename; temps removed |
| Crash after the pod renames, before the CLI rename | the pods are at the new version and the CLI is old. `run` says "run `tentacle update`"; the re-run sees CLI old/target new, pods current, so it fetches only the CLI and converges |
| CLI current, pods missing/stale | pods only (D1); CLI untouched |
| CLI ahead of latest (no `--version`) | CLI untouched; "newer than latest (<tag>); kept"; pods are **not** fetched (the CLI's version may be unreleased), and stale ones get a `--version v<current>` hint. Exit 0, also for `--check` (post-review) |
| Two concurrent updates | separate temps; the last rename wins with identical bytes |

### Tests

- `update-plan.test.ts`: version order, tag parsing, asset names, every plan
  status.
- `update.test.ts`, using a fake `fetch` (a release server in memory), fake
  `runVersion`/`rename`, and real temp dirs:
  - up to date;
  - update available (CLI and both pods replaced; the CLI renamed last);
  - `--check` exits 0/10 and writes nothing;
  - `--version` downgrade;
  - dev refusal;
  - unwritable dir refused with zero downloads;
  - checksum mismatch and a body drop leave the old install intact, with no
    temps;
  - a self-test failure aborts before any rename;
  - a crash on the CLI rename, then a re-run that converges and downloads only
    the CLI;
  - pod-only fill-in;
  - a marker-less pod (unknown version) replaced;
  - latest 404.
- Nit tests: duplicate digests, the size cap, the non-HTTPS redirect, and the
  marker env override ignored.

## Execution

*— claude-opus-5-5, 2026-10-22*

In order:

1. **Repro** confirmed on `57502f0`: `update` was not a command, and
   `/releases/latest` returns 404 for `gmeghnag/tentacle`.
2. **N2:** `version.ts:42-48` adds `declare const __TENTACLE_VERSION_MARKER__`
   and `compiledVersionMarker()` (a `typeof` guard). `buildBinary` defines
   `__TENTACLE_VERSION_MARKER__`. Check from source:
   `TENTACLE_VERSION_MARKER=…9.9.9… bun main.ts --version` → `tentacle dev`.
   The compiled binary prints `tentacle 0.1.0-beta.1`.
3. **N1:** `findAllVersionMarkers` (`version-marker.ts:75`). `scripts/build.ts:50-60`
   requires exactly one well-formed marker, equal to the version
   (`bun run compile` → `version marker 0.1.0-beta.1 ok`).
4. **N3/N4** in `pod-binary-download.ts`:
   - `parseSha256Sums` throws when one name has two different digests (`:49`);
   - `HttpStatusError` (`:58`);
   - the body is cancelled on an HTTP error, a non-HTTPS final URL (`:91`)
     and an `open` failure;
   - `maxBytes`, default 512 MiB (`:125`);
   - `file.sync()` before close (`:186`).
5. **Plan** in `update-plan.ts` (new): `compareVersions` `:33`, `planUpdate` `:115`.
6. **Command** in `update.ts` (new):
   - `resolveLatestTag` `:91` uses the redirect, not the API;
   - `runUpdate` `:133`: D5 check `:183` before any `SHA256SUMS` or asset
     request; commit order `:261`.
7. **Wiring:**
   - `flags.ts`: `update` mode, `ARGS.update` `:105`, `USAGE` `:499`;
   - `main.ts:246` dispatches before `loadConfig`, so a broken `config.jsonc`
     does not block an update; `HELP` has a new entry;
   - `packages/config/src/load.ts:168` adds `configDirFromEnv`.
8. **README:** the "Updating" note covers `--check`, `--version` and the
   `sudo` behaviour.

**Tests:**
- `update-plan.test.ts` (9).
- `update.test.ts` (17): a fake in-memory GitHub `fetch`; a fake `runVersion`
  that answers from the staged file's own marker; `rename`/`isWritable` seams;
  real temp dirs. It covers every case in the brief, plus:
  - an inconsistent pod marker;
  - an implicit downgrade being refused;
  - a nonexistent `--version` tag;
  - two spawn tests of the real `main.ts` wiring.
- Nit tests: 4 in `pod-binary-download.test.ts`, 2 in `version-marker.test.ts`.

The code came before its tests, so non-vacuity was shown **by mutation**: each
mutation was applied, the narrow file run, and the file restored.

| Mutation | Tests that failed |
|---|---|
| CLI renamed before the pods | renamed-LAST + crash-converges |
| D5 check removed | unwritable |
| self-test compare removed | wrong `--version` |
| `finally` temp `rm` removed | 4 |
| dev guard removed | dev |
| `--check` always returns 0 | `--check` |
| pod version = target when the CLI stays | 2 plan tests |
| pod-marker check removed | inconsistent-release |
| N2 reverted to `process.env` | env-override spawn test |
| N3 / size-cap / HTTPS-check guards removed | their test (one each) |
| `update` removed from `flags.ts` | both wiring tests |

**Real checks** (2026-10-22, nothing outside scratch replaced):
- `./dist/tentacle update --check` → `[update error] no published release at
  https://github.com/gmeghnag/tentacle/releases (HTTP 404): the repository has
  no non-pre-release release yet, or it is not public. Pick a tag with
  --version vX.Y.Z`, exit 1. The repo is private, and `v0.1.0-beta.1` is a
  pre-release in any case.
- `./dist/tentacle update --check --version v0.1.0-beta.1` reports the CLI
  current and both pods `unknown version → 0.1.0-beta.1`, exit 10 (the real
  `~/.config/tentacle/bin` is read, not written).
- `update --version v0.1.0-beta.1` with `TENTACLE_CONFIG_DIR` and the binary in
  scratch → `release v0.1.0-beta.1 not found … HTTP 404 … not public`, exit 1.
  Nothing was written besides the binary copy.
- **Redirect + verify on a real public release:** `downloadVerifiedAsset` on
  `oven-sh/bun` `bun-v1.4.4` (`bun-linux-aarch64-musl.zip`, 47.9 MB, sums
  from its `SHASUMS256.txt`) followed the redirect to
  `release-assets.githubusercontent.com` and verified the SHA-256 in 4.9 s.
- **Load-bearing assumption:** a copy of `dist/tentacle` ran `serve --stdio`
  in scratch while another copy was `mv`ed over its path. The inode changed
  (52706256 → 52706259), the old process stayed alive, and the new file ran
  (`tentacle 0.1.0-beta.1`) with a valid signature (`codesign -v`).

**Gate:** `bun run check`: typecheck clean · Biome `Checked 384 files … No
fixes applied` · `1924 pass · 2 skip · 0 fail` (the two opt-in skips).

**Drift and decisions:**
- `--check` exits 10 whenever `update` would change anything, **pods
  included** (a CLI that is current with a stale pod reports 10). This is
  stricter than "CLI update available", and it matches what `update` would do.
- `update --check` is refused in `dev` too: there is no version to compare.
- When the CLI is *ahead* of latest, it is never downgraded implicitly; the
  pods are filled at the CLI's own version.
- `--version` accepts `vX.Y.Z` or `X.Y.Z`. The tag must look like `v<semver>`,
  so `bun-v1.4.4`-style tags are rejected.
- The `sudo` hint carries `TENTACLE_CONFIG_DIR=<configDir>`, so root does not
  put the pod binaries in `/root/.config`. Residual: if `<configDir>/bin` did
  not exist yet, root creates it, and a later non-sudo update cannot write
  there.
- ~~Known limitation: pinning `v0.1.0-beta.1` re-downloads the pods on every
  run.~~ Removed post-review: versions before 0.1.0 are refused (see below).
- Not unit-tested: `file.sync()`, the body `cancel()` paths and the default
  `spawnVersion` (exercised only by the real runs above).

**Unverified:** a full real `tentacle update` that replaces a CLI from a public
`gmeghnag/tentacle` release. That needs the repo public and a marker-carrying
release (≥ 0.1.0), so it belongs to the release step (child 3 / first tag).

### Post-review fixes

*— claude-opus-5-5, 2026-10-22* (REQUEST-CHANGES round; owner: no compat for
pre-0.1.0 builds). Each new test was red on the old code first, then
mutation-checked: removing each fix makes its test fail again.

1. **Must-fix (F1):** `resolveLatestTag` treats any 3xx whose `Location` is
   not `/releases/tag/<tag>` like the 404: "no published release … Pick a tag
   with --version". Test: a `302 → …/releases`. The failure-mode row is fixed.
2. **Ahead of latest:**
   - `planUpdate` returns `status: "ahead"` with **no** pod targets.
   - The report says `tentacle <v> is newer than latest (<tag>); kept`.
   - Stale pods get a hint (`tentacle update --version v<v>`, valid if that
     release exists), but nothing is fetched at a possibly unreleased tag.
   - Exit 0 for both `update` and `--check`. Decision: in this state, stale
     pods are the user's call, not "an update is available".
3. **Stale temps:** on start (not `--check`), files named
   `.tentacle-bun-*.<12 hex>.tmp` in the install dir and `<configDir>/bin` are
   removed when untouched for ≥ 60 s. A live run writes continuously, and its
   staging-to-commit gap is ≤ 17 s, so a concurrent run's temps survive. Other
   `.tmp` files are never touched.
4. **Never overwrite a non-tentacle:** before the CLI moves,
   `readBinaryVersion(execPath)` must equal `appVersion`. This runs before any
   download.
5. **Self-test timeout:** `spawnVersion` sends SIGTERM at `timeoutMs` (15 s),
   then SIGKILL after `graceMs` (2 s), and reports "timed out". Test: a shell
   stub that traps TERM. Bun resets inherited signal *ignores* in children, so
   `trap '' TERM` does not survive and the stub installs a handler instead.
   The mutation (no SIGKILL) hangs the test into its 5 s timeout.
6. **A downloaded pod binary with no marker is refused, for every version.**
   This applies the owner's rule rather than the review's "≥ 0.1.0".
7. **sudo:**
   - With `SUDO_UID`/`SUDO_GID` set while running as root (an injectable
     `sudoOwner` seam), the dirs this run created for `<configDir>/bin` and the
     committed pod files are `chown`ed back to the user (injectable `chown`).
   - The install-dir CLI binary keeps root ownership.
   - This closes the "root-created `bin/`" residual noted above.
8. **The sudo hint** uses the resolved `execPath`:
   `sudo TENTACLE_CONFIG_DIR=<dir> <execPath> update`.
9. **Pre-0.1.0 removed (owner):** `MIN_UPDATE_VERSION = "0.1.0"`
   (`update-plan.ts`). A target below it (`--version v0.1.0-beta.1`, `0.0.9`,
   or such a "latest") is refused before any request with "versions before
   0.1.0 cannot be installed by update". What was removed:
   - the "pre-marker release → `undefined` marker allowed" branch and its
     comment (`update.ts`);
   - the "≤ beta.1" wording in the tests;
   - the "predates D2" wording in `version-marker.ts`;
   - the beta.1 known-limitation note above.
   A local pod binary with no marker is still just stale, and it is replaced.

Gate after these fixes: `bun run check`. Typecheck is clean; Biome `Checked 384 files … No fixes applied`; tests `1932 pass · 2 skip · 0 fail` (the two opt-in skips).

## Review

*— claude-opus-5-5, 2026-10-22* — same model family as the executor, in a
fresh context, so blind spots we share can get past both passes.

**Verdict: REQUEST-CHANGES (one small must-fix).** The core is sound:
self-replacement, commit order, D1, D5 and the nits folded in from child 1.
One false premise turns the commonest "no release yet" state into an opaque
error.

**Gate** (re-run): `bun run check` passes.
- Typecheck is clean.
- Biome: `Checked 384 files … No fixes applied` (0 errors, 0 warnings).
- Tests: **1924 pass · 2 skip · 0 fail** (1926 tests, 160 files). The 2 skips
  are the opt-in ones.

**Premise table**

| Premise | Verdict |
|---|---|
| Load-bearing: `rename(temp, execPath)` in the same directory replaces a running binary and leaves the running process alive | TRUE. The executor's inode check holds, and my e2e confirms it: the inode changed, the new file reads marker `0.1.0-beta.1` and has mode 755 |
| `process.execPath` is the real file, not the symlink | TRUE. I compiled a scratch binary and ran it through a symlink, both directly and via `PATH`. `execPath` is the symlink **target**, so the target is the file replaced and the link keeps working. That is the right file |
| `configDir` is resolved only in `loadConfig`. `update` must match it | TRUE. `configDirFromEnv` uses the same `resolveConfigDir` and `HOME` fallback, and no CLI flag overrides the directory |
| Failure-mode row "Latest 404 (private repo / **only pre-releases**)" | **FALSE for a public repo.** `curl -sI` shows `github.com/{oven-sh/homebrew-bun,torvalds/linux}/releases/latest` → `302 location: …/releases` (no `/tag/`). See F1 |
| Pre-releases are never "latest" | TRUE (GitHub semantics; see the row above for what is returned instead) |
| The N1–N4 nits are in | TRUE. Details below |

The nit fixes, checked one by one:
- **N1:** `build.ts:50-60` checks for exactly one marker. `findAllVersionMarkers(dist/tentacle)` returns `["0.1.0-beta.1"]`, so the `typeof` guard did not duplicate the literal.
- **N2:** `TENTACLE_VERSION_MARKER=…9.9.9… bun main.ts --version` now prints `tentacle dev`.
- **N3:** `parseSha256Sums` throws when one name has two different digests.
- **N4:** all four parts are in the code:
  - `file.sync()` before close;
  - a 512 MiB cap;
  - `body.cancel()` on the HTTP-error, non-HTTPS and `open`-failure paths;
  - HTTPS required on the final URL.

  `sync` and `cancel` have no unit tests. I reviewed them by reading the code
  only, and they are correct.

**Mutations.** Each test failed under its mutation, and the tree was
byte-identical afterwards (shasum checked):
- Implicit downgrade allowed: 3 tests fail (plan and command).
- Self-test compare removed: "wrong --version aborts before ANY rename" fails.
- D5 check disabled: "unwritable install dir refused BEFORE any download"
  fails.
- Pre-release order inverted: the `compareVersions` test fails.

**E2E trace** (`.tentacle/tmp/tentacle-update/e2e.ts`). It calls the real
`runUpdate` with:
- a fake GitHub `fetch` that serves `dist/tentacle` with real SHA-256 sums;
- the real `spawnVersion`;
- real renames into a scratch install dir and config dir.

Results:
1. **Self asset drops mid-body:** exit 1. The install is the same inode, no
   temp is left, and `bin/` is empty.
2. **Crash injected on the CLI rename:** exit 1. Both pods are committed and
   the CLI is untouched.
3. **Re-run:** it converges. The only requests are `latest`, `SHA256SUMS` and
   the darwin asset; the CLI is replaced and the pods are not re-fetched.
4. **CLI ahead of latest:** see F2.
5. **Explicit `--version v0.1.0` whose assets say beta.1:** refused by the pod
   marker check before any rename.

CLI arguments:
- `update --version` with no value gives a usage error.
- `update foo` gives a usage error.
- Source mode refuses before any network request.

**Attacks tried**
1. **Self-replacement.** The old install stays intact on network failure,
   checksum mismatch, self-test failure and pod-marker mismatch, because
   nothing is renamed before every stage passes. Disk full is a write error →
   the helper removes the temp. A crash between the pod renames and the CLI
   rename converges (trace 2–3).
   - Hole: a **kill -9** mid-download leaves a ~70–90 MB
     `.<asset>.<hex>.tmp` in the install dir and `<configDir>/bin`, and
     nothing ever sweeps it (N-a).
   - Overwriting a file that isn't tentacle: `dev` is refused, so `bun` is
     safe in every supported path. The guard is the version string, not the
     file itself (N-b).
2. **Self-test.** The check is an exact `tentacle <target>` after `trim`; good.
   The timeout is `proc.kill()`, which sends SIGTERM only, so a child that
   ignores it hangs `update` forever (N-c).
3. **`compareVersions`.**
   - Order is correct: `0.1.0-beta.1 < 0.1.0`, numeric before alphanumeric
     identifiers, `+build` ignored.
   - `normalizeTag` accepts an optional `v` and requires `^\d+\.\d+\.\d+`, so
     malformed tags and `bun-v1.4.4` are refused.
   - There is no implicit downgrade (mutation-verified).
4. **Latest resolution.**
   - Only the tag is taken from `Location`, and the download URL is rebuilt
     on `github.com`, so a foreign host cannot redirect the download.
   - 403/429 is reported as rate limiting.
   - **F1:** a public repo with no full release returns a 302 to `/releases`,
     which ends in "unexpected answer … HTTP 302".
5. **D1.** Both arches are planned. A current CLI with missing, stale or
   marker-less pods gets them filled (tests + trace).
   - Drift "the beta.1 pin re-downloads the pods on every run": acceptable,
     because only that pre-marker release is affected.
   - Pods with no marker are accepted at stage time. That is safe only
     because `build.ts` guarantees markers from 0.1.0 on (N-d).
6. **D5 and sudo.**
   - The writability check runs before any request; the hint carries
     `TENTACLE_CONFIG_DIR`.
   - Under sudo, the pod files land root-owned (0755) in the user-owned
     `<configDir>/bin`. A later non-sudo `update` can still rename over them,
     because that needs write permission on the directory, which the user
     has, not ownership of the file. `run` can still read them.
   - The only root-owned leftover is a `bin/` **created** by root (the
     residual the executor declared) (N-e).
   - The hint says bare `tentacle`, which depends on root's `secure_path`
     (N-f).
7. **The executor's drift.**
   - `--check` exiting 10 on stale pods only: accepted; it mirrors what
     `update` would do.
   - `--check` refused in dev: accepted.
   - No implicit downgrade: accepted.
   - The `TENTACLE_CONFIG_DIR` hint: accepted.
   - However, an ahead CLI **with stale pods** reports misleadingly (F2).
8. **§7.**
   - `update.ts` imports no k8s or TUI code and is dispatched before
     `loadConfig`.
   - All output goes through `write`; there are no raw terminal writes while
     Ink owns the terminal (Ink never mounts here).
   - No cluster calls.

**Findings**

Must-fix:
- **F1** `packages/cli/src/update.ts:105-119`: a 3xx whose `Location` is not
  `…/releases/tag/<tag>` (in practice `…/releases`) must give the same
  "no published release … pick a tag with --version" message as the 404. Add a
  test with `location: https://github.com/<repo>/releases`, and fix the doc's
  failure-mode row. This is the exact state `gmeghnag/tentacle` is in once it
  is public with only `v0.1.0-beta.1`.

Nits:
- **F2** `update.ts:168-174` with `update-plan.ts:123-128`: when the CLI is
  ahead of latest and the pods are stale, the report prints
  `tentacle 0.2.0 is up to date (v0.1.0-beta.1)`, `--check` exits 10, and
  `update` then tries pods at the unreleased `v0.2.0` (a loud 404). Print the
  "newer than the latest release; kept" line whenever `!explicit && order < 0`,
  whatever `status` is.
- **N-a** `update.ts:146`: at start, remove stale `.<asset>.*.tmp` files in
  `installDir` and `<configDir>/bin`, so a kill -9 does not leak ~90 MB per
  attempt.
- **N-b** `update.ts:184`: before planning a CLI move, also require
  `await readBinaryVersion(execPath) === appVersion`. This is defence in depth,
  so `update` never renames over a file that is not this tentacle (for
  example, a non-compiled bundle run by `bun`).
- **N-c** `update.ts:61`: escalate to `proc.kill("SIGKILL")` after the
  timeout, or kill with SIGKILL directly.
- **N-d** `update.ts:236`: from 0.1.0 on, require a marker: if
  `compareVersions(podVersion, "0.1.0") >= 0` and the marker is `undefined`,
  throw.
- **N-e** `update.ts:192`: when running as root with `SUDO_UID` set, `chown`
  a `bin/` that this run created back to `SUDO_UID:SUDO_GID`.
- **N-f** `update.ts:187`: in the hint, use `${deps.execPath}` instead of bare
  `tentacle`.

**What holds:**
- Stage-then-commit, with the CLI last and convergence after a crash.
- Exact self-test.
- Semver order and no implicit downgrade.
- D1, D3 and D5.
- The N1–N4 nits from child 1.
- Correct symlink resolution.
- §7 is untouched.

**Executor behaviour:**
- The plan was source-verified.
- It ran real network checks (a private-repo 404 and the `oven-sh/bun`
  redirect + SHA-256) and a real rename-while-running check.
- It declared its drift and the residual risks honestly: the root-created
  `bin/`, and the untested `sync`/`cancel`.
- It wrote tests after the code, and made up for it with 14 mutations. I
  reproduced 4.
- It missed the public-repo 302 shape (F1), because it probed only the
  private repo.

### Re-review

*— claude-opus-5-5, 2026-10-22* — same model family, fresh context.

**Final verdict: APPROVE-WITH-NITS.** F1 and all 7 nits are applied. The new
owner rule (no compat for builds before the marker) holds.

**Gate:** `bun run check` passes.
- Typecheck is clean.
- Biome: `Checked 384 files … No fixes applied`.
- Tests: **1932 pass · 2 skip · 0 fail** (1934 tests, 160 files).

**E2E** (`.tentacle/tmp/tentacle-update/e2e2.ts`). It uses the real
`runUpdate` and `spawnVersion`, real renames, and fake 0.1.0 assets that carry
a marker.
- `/releases/latest` answered with `302 → …/releases`: exit 1 with the clear
  "no published release … pick a tag with --version" message. **F1 is fixed.**
- `--version v0.1.0-beta.1` is refused before any request (0 requests).
- A dropped body leaves the install on the same inode, with no temps.
- A crash on the CLI rename leaves both pods committed and the CLI untouched.
  The re-run fetches only `latest`, `SHA256SUMS` and the darwin asset, then
  converges; the new CLI's marker reads 0.1.0.
- A CLI ahead of latest: exit 0, the "newer than latest; kept" line, and
  nothing fetched.

**Mutations.** Each test failed under its mutation, and the tree was
byte-identical afterwards:
- F1 (3xx branch removed): 1 test fails.
- Nit 2 (ahead fills the pods again): 4 tests fail.
- Nit 4 (the `execPath` marker guard removed): 1 test fails.
- Nit 5 (no SIGKILL): the SIGTERM-ignoring test **fails** (5 s timeout), so
  it is no longer vacuous. Side effect: under the mutation, the stubborn
  `sh` child is left hanging and blocks the test runner until it is killed.
  That only happens on broken code, but the test's `finally` could kill it.
- Nit 7 (no chown): the sudo test fails.

**Ruling on nit 2:** OK. Not fetching pods at a tag that may be unreleased is
correct. Exit 0 under `--check` is consistent, because `update` would do
nothing. The `--version v<current>` hint is the user's path out.

**Concurrent temp sweep (60 s mtime):** the code comment's claim that it is
"never" a concurrent run's temp is **not strictly true**. This is reasoned
from the code, not run.
- A pod temp that is fully staged keeps its mtime (`chmod` updates only
  ctime) while the same run downloads the CLI asset.
- On a link slower than ~1.5 MB/s (~90 MB in more than 60 s), or after a
  stall of more than 60 s, a second `update` started in that window deletes
  the first run's staged pod temps.
- The first run then fails **loudly**: `rename` throws ENOENT, or `chmod`
  throws on a temp unlinked mid-download. The CLI is not renamed, any pods
  already committed are correct and verified, and a re-run converges.

So there is no corruption, only a spurious failure in a rare race.

**Nits (non-blocking):**
- `update.ts:92`: raise `STALE_TEMP_MS` to about 1 h, which bounds the leak
  and makes the race practically impossible, or fix the comment to say what
  happens in the race.
- `update.test.ts:505-522`: kill the stubborn child in `finally`, so a
  regression times out cleanly instead of hanging the runner.
