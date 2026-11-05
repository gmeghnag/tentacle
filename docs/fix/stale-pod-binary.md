# fix/stale-pod-binary — `attach` to a container with an older tentacle build

> **Status:** review
> **Branch:** `fix/stale-pod-binary`
> **Type:** fix · **Size:** S–M · **Blast:** cross-module · **Suited:** strong model, standard review

## Context

*— claude-sonnet-5-5, 2026-11-05*

Live 2026-11-04: `tentacle attach ciao` on a container made by an older tentacle →
`[container] failed: connection closed`. The old binary rejects `serve --bridge`
(`unknown option --bridge`), so the link dies before `initialize` can say `VersionMismatch`.

`attach` already replaced a container binary whose `--version` differs
(`engine-runtime.ts` preflight, `containerDecision` in `container-version.ts`), guarded by
`residentGuard` (`pod-resident.ts`). Two gaps made the live case slip through:

1. **Versions are not builds.** Old binaries report the SAME version (`0.2.0`) as today's, yet
   lack `--bridge`; version equality ⇒ "reuse" ⇒ bare `connection closed`. (Owner review.)
2. **A source (`dev`) laptop** reuses whatever the container has (Q3,
   `docs/feat/version-mismatch-notice.md`). This is the same bug class, left as is by decision
   (below).

**Owner decision 2026-11-05 (option A, a build identifier):** every compiled binary carries a
build id beside its version; `attach` reuses a container's binary ONLY if its build id equals the
one this laptop would inject; a different or MISSING id → re-copy the laptop's binary, unless a
live daemon of the old binary is in use → do NOT kill it, one line
`[container] <name> runs an older tentacle build than this one · tentacle rm <name>, then run again`
(`pod` on k8s), no log path. From source: keep Q3 unless it is the same bug.

**Repro (before the fix):** fake host whose `<bin> --version` answers `tentacle 0.3.0` (this
laptop's version) and whose `<bin> --build-id` fails (`unknown option`), release laptop at 0.3.0
→ `attach` reuses it (no `head -c`, goes to `serve --bridge`). Test
`attach: same version but an OLDER binary with no build id → replaced` was RED with the rule off
(mutation M1: 3 fails).

## Implementation

*— claude-sonnet-5-5, 2026-11-05*

### Load-bearing assumption
`update` compares the marker VERSION exactly against the release (`update.ts:353`, `:370`), so
the build id must NOT live inside the version string. → a **second marker literal**
`TENTACLE_BUILD_MARKER:<12 hex>:END` (`version.ts`), separate `define`, same scanner idea
(`version-marker.ts`). `update`, `podBinaryProblem`, `--version` are untouched.

### Build-id shape
12 hex of sha256 over the sorted (path, bytes) of `packages/*/src/**`, `packages/*/package.json`,
`apps/*/package.json`, `scripts/yoga-auto.ts`, `bun.lock` (`computeBuildId`,
`pod-binary-build.ts`). Same source ⇒ same id (any target/machine, clean or dirty); any edit ⇒
different. Chosen over `<commit>+dirty` because two dirty trees would collide and a commit hash
is unavailable in a source tarball. Docs/tests do not change it. `scripts/build.ts` verifies the
compiled file carries exactly one build marker equal to `computeBuildId()`.

### Design
- Pod side: `tentacle --build-id` prints the id (`dev` from source) (`main.ts`, before arg
  parsing, like `--version`). Older binaries fail `unknown option` ⇒ "missing id" — no
  capability negotiation needed.
- Laptop side (`attach` only; `run` always injects into a fresh pod):
  `expectedContainerBuild` = `TENTACLE_POD_BIN`'s own build marker, else `APP_BUILD`
  (`undefined` from source ⇒ rule off, Q3). When expected is defined and the container's
  `--version` answered, ask `<bin> --build-id` and pass `{expected, found}` to
  `containerDecision`: version mismatch ⇒ `replace/version` (unchanged); else build mismatch or
  missing ⇒ `replace/build`.
- `replace` goes through the SAME guarded path (`residentGuard` → stage → stop idle resident →
  rename). A busy resident (`ResidentVerdict.refuse.busy`) with `reason: build` becomes
  `StaleBuildError` (a `RefusalError`): `failedLine` prints `[noun] <msg>` — no `failed:`, no
  log path; the generic busy message stays for a version replace. Never kills a live daemon.
- Replace notice says `… (an older build)` when the version agreed.

### Files
`version.ts`, `version-marker.ts`, `pod-binary-build.ts`, `main.ts`, `scripts/build.ts`,
`container-version.ts`, `pod-resident.ts` (`busy`), `engine-host.ts` (`StaleBuildError`),
`pod-stderr-log.ts`, `engine-runtime.ts`; tests in `container-version`, `version-marker`,
`pod-binary-build`, `pod-stderr-log`, `engine-runtime`.

### Failure modes
- Other early link death: unchanged (`connection closed`).
- `--build-id` exec throws/times out ⇒ "missing" ⇒ replace (guarded; a failed status probe
  refuses via `residentGuard`, fail closed).
- Replace fails (build/ network/ read-only fs): existing `replaceFailedWarning` path, then goes on
  with the old binary (may still end in `connection closed`; the warning says why).
- Replacing under a live resident: refused, never forced (`StaleBuildError`).
- Binary shipped in an image with the same build: reused (no copy).
- Dev laptop with `TENTACLE_POD_BIN` lacking a build marker ⇒ rule off.

### Tests
See Execution (list + mutations).

## Execution

*— claude-sonnet-5-5, 2026-11-05*

Done in plan order. New/changed tests: `container-version.test.ts` (decision table incl. build,
`parseBuildIdAnswer`, `expectedContainerBuild`, wording), `version-marker.test.ts` (build marker),
`pod-binary-build.test.ts` (`computeBuildId` stable/changes), `pod-stderr-log.test.ts`
(`failedLine` for `StaleBuildError`), `engine-runtime.test.ts` (6 attach cases: missing id ⇒
replaced + notice; different id ⇒ replaced; same id ⇒ reused; dev ⇒ reused (Q3); older build +
live daemon ⇒ one line, no copy/stop/exec; version replace + live daemon ⇒ old message).
Existing `containerDecision` expectations gained `reason: "version"`.

Mutations (each red, reverted; `shasum` of the four touched source files identical before/after):
- M1 `appBuild: undefined` (rule off) → 3 fails in engine-runtime.
- M2 `found !== expected` → `found === undefined` → 2 fails (engine-runtime, container-version).
- M3 drop the `reason build && busy` mapping → 1 fail (live-daemon line).
- M4 drop the `StaleBuildError` branch in `failedLine` → 1 fail.
- M5 drop file bytes from the hash → 1 fail.

`bun run compile` builds OK: `version marker 0.2.0 ok`, `build marker 5e638ad9e9c5 ok`.
Drift: none from the plan; `--version` is NOT extended (owner allowed it) because `update`
compares its output exactly (`update.ts:370`).

Debt: a laptop binary built locally at version V and pod binaries installed by `tentacle update`
for V carry different build ids ⇒ every attach re-copies (correct, wasteful); `run` is unchanged
(always injects). From source with no `TENTACLE_POD_BIN` the same bug remains (Q3) — a dev laptop
attaching to an old container still gets `connection closed`; say the word to reverse Q3.

## Review

*— claude-sonnet-5-5, 2026-11-05*

Gate (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .` clean; `bun test packages`
4459 pass · 3 skip (opt-in) · 0 fail. Two `serve-resident` tests needed `busy: true` in their exact
`residentGuard` expectations (contract widened). Fresh-context review not run (cross-module,
standard in-context review only). Unverified: a real old container (no docker used); the
compiled binary's `--build-id` output was not executed (build check passed).

## Review — round 2

*— claude-opus-5-5, 2026-11-05* (fresh context; a different model family from the Sonnet executor)

**Verdict: REQUEST-CHANGES.** There is one MEDIUM finding. Round 1's HIGH is fixed.

### Round 1's HIGH: fixed
An old `0.2.0` binary has no `--build-id`. It fails with `unknown option` and a non-zero exit,
so `parseBuildIdAnswer` returns `undefined` (`container-version.ts:60-68`). A release laptop
has `expectedBuild = APP_BUILD`, so `containerDecision` returns `replace/build` (`:155-157`).
The replace goes through the same guarded path. Equal ids give `reuse`, with no copy.

### Findings
1. **MEDIUM: the expected build is the laptop binary's own, not the build of the binary that
   would be injected.**
   - `expectedContainerBuild` returns `APP_BUILD` (`container-version.ts:84`). But a release
     laptop injects `<configDir>/bin/tentacle-<target>`, and that file is checked only by
     VERSION (`podBinaryProblem`, `pod-binary-build.ts:243`).
   - The configDir binary may be another build of the same version. That is TODO.md:1137
     4d(1), a locally compiled pod binary, or the executor's own Debt case. Then every
     binary this laptop injects never matches:
     - `run --detach` injects build B′.
     - Each later `attach` sees B′ ≠ B and replaces.
     - An idle resident of that run is **stopped on every attach**: its in-pod sessions go.
     - A busy detached run **cannot be attached at all**. The user is told
       `<name> runs an older tentacle build … · tentacle rm <name>, then run again`, which
       is advice to delete their own live run, and the binary is not even older.
   - The Debt line calls this "correct, wasteful". It is a regression: before this change,
     equal versions were reused.
   - **Fix:** in release mode, read the build id of the binary `resolvePodBinary` would
     inject. That is a cheap laptop-side marker read, the same way the `TENTACLE_POD_BIN`
     branch already works (`readBinaryBuildId(configBinPath(...))`). Add a test with
     configDir build ≠ `APP_BUILD`, then a re-attach: it must give `reuse` and no stop.
2. **LOW: one extra exec on every attach.** Each release attach pays one extra
   `--build-id` exec, and up to 15 s when an old binary hangs (`engine-runtime.ts:839-848`).
   A same-build attach copies nothing, but it is not free. This could be folded into the
   `--version` probe.
3. **LOW: build settings are outside the id.** `computeBuildId` does not hash `scripts/build.ts`,
   `bunfig.toml` or the `define`/minify options. A change to the build settings alone keeps
   the id.
4. **LOW (documented, Q3): dev is unchanged.** A `dev` laptop with no `TENTACLE_POD_BIN`
   still reuses the container binary and gets `connection closed`. This is the owner's
   decision, and it is stated in Execution.

### What holds
- **§7, the read stays laptop-side.** The pod's `--build-id` stdout is only data: it must be
  exit 0 and match `^[0-9a-f]{12}$`, and it is only compared. Nothing pod-supplied runs on the
  laptop. The laptop's ids come from its own compiled literal or its own marker scan
  (`readBinaryBuildId`). A lying pod can only get its own binary reused, and the pod is
  already not trusted.
- **A live daemon is never killed.** A busy verdict refuses before staging. `stopResident`
  asks again. A `StaleBuildError` escapes the "go on with the old one" catch
  (`engine-runtime.ts:924-928`). A failed probe still fails closed with the old message.
  `failedLine` prints one line with no `failed:` and no log path.
- **The id is stable for one build and differs between builds.** It is a sorted path+bytes
  sha256 that does not depend on the target, and it is pinned by `pod-binary-build.test.ts`.
  `scripts/build.ts` requires exactly one build marker equal to `computeBuildId()`.
- **k8s and docker/podman share one path.** The change uses only `host.runExec`, with no
  engine branch. An old k8s binary's `unknown option` exits 1, which also gives "missing".
- **Other early link deaths are unchanged.**

### Mutation
`parseBuildIdAnswer` was forced to always return `undefined`. Result: 2 fail / 114 pass, the
same-build reuse test in `engine-runtime` and the `parseBuildIdAnswer` unit test. Reverted;
the shasum is identical (`014c4d31…`).

### Gate
`bun run check` is **RED at typecheck**. The errors are the same environment errors in the
worktree's `node_modules/.bun/bun-types@1.1.37` as in round 1 (TS2687/TS2300/TS2430), not
this diff. Lint and tests did not run. The two narrow test files ran only under the mutation (114 pass /
2 fail, only the expected two). The clean run is not verified.

### Executor behaviour
The executor followed the plan and listed its debt honestly. But it judged the
configDir-build mismatch as cost only, and missed the attach refusal and the resident stops
that it causes.

### Execution — round 3

*— claude-sonnet-5-5, 2026-11-05*

1. **MEDIUM (fixed).** `expectedContainerBuild` no longer returns `APP_BUILD`. Release: it reads
   the build marker of the config-dir binaries `resolvePodBinary` injects
   (`readBinaryBuildId(configBinPath(...))`, both targets: the pod's arch is unknown before the
   probe); they must agree on one id, else (none readable / two builds) the build rule is off
   and the version rule stays. `TENTACLE_POD_BIN`: that file, as before. The `appBuild` dep is
   gone. Tests: configDir build ≠ any laptop build, re-attach → reused, no copy, no
   `--resident-stop`, one probe; a busy detached run of that build attaches normally; a different
   / missing container build still replaces or refuses with the one line.
2. **LOW 2 (fixed).** One exec per attach: the probe is `<bin> --version --build-id`. A new
   binary prints `tentacle <v>` then the id (`dev` from source); an older binary exits at
   `--version` and prints one line ⇒ "no build id". `parseVersionLine` / `versionLabel` read the
   first line. The standalone `--build-id` flag is removed (`main.ts`). Asked only when a build is
   expected (otherwise the probe is the old `--version`).
3. **LOW 3 (fixed).** `computeBuildId` also hashes `scripts/build.ts` and `bunfig.toml`; the
   `define`/`minify` options live in `pod-binary-build.ts` (already under `src/`).
4. **Q3 kept (owner):** from source (`dev`) with no `TENTACLE_POD_BIN` the container's tentacle is
   reused; a dev user attaching to an old container sets `TENTACLE_POD_BIN` (then that file's
   build id is the rule). Round 2's Debt line about re-copies is obsolete (configDir build is the
   reference).

Red first (before the src change): 4 engine-runtime attach tests + the build-settings test failed
on assertions. Mutations, one per item, each red then reverted (`shasum` of
`container-version.ts`, `engine-runtime.ts`, `pod-binary-build.ts` identical before/after):
- item 1: release expected build → a constant ≠ the config-dir id → 3 fails.
- item 2: probe without `--build-id` → 4 fails.
- item 3: drop `scripts/build.ts` + `bunfig.toml` from the hashed list → 1 fail.

Gate: `bunx tsc --noEmit` clean; `bunx biome check .` clean; `bun test packages` — first run 2
fails (names not captured; the known flaky-tests item in TODO.md), the next two runs 4466 pass ·
0 fail. Unverified: a real old container; the compiled binary's `--version --build-id` output
(build check passes, binary not executed).

## Review — round 3

*— claude-opus-5-5, 2026-11-05* (fresh context; a different model family from the Sonnet executor)

**Verdict: REQUEST-CHANGES (narrow).** Round 2's MEDIUM is fixed for the main case. One
residual of the same class is left (finding 1). It has the same trigger class (a hand-made
configDir) and the same harm.

### Round 2's MEDIUM: fixed
- **The rule now uses the injected binary's build.** `expectedContainerBuild` no longer uses
  `APP_BUILD`. In release mode it reads the build marker of the configDir binaries, laptop-side
  (`container-version.ts:86-108`, `engine-runtime.ts:811-818`).
- **The covering tests pass.** When the configDir build differs from the laptop, a re-attach
  gives `reuse`: one probe, no copy, no `--resident-stop`. A busy detached run of that same
  build attaches normally. Both are in `engine-runtime.test.ts`.
- **An old `0.2.0` binary is still replaced.** It prints one line, so
  `parseBuildFromVersionProbe` returns `undefined` and the decision is `replace/build`.

### LOW 2 and LOW 3: handled
- **LOW 2:** there is one exec. `--build-id` is added only when a build is expected
  (`engine-runtime.ts:824`). At HEAD, an old binary's `main` returns on `args[0] === "--version"`
  before argument validation. So the extra argument is ignored and it prints one line.
  `update`'s plain `--version` output is unchanged (`main.ts`).
- **LOW 3:** `scripts/build.ts` and `bunfig.toml` are now hashed.
- **`dev`:** Q3 is kept and documented (rule off; use `TENTACLE_POD_BIN`).

### Findings
1. **MEDIUM: a configDir binary with no build id is skipped instead of turning the rule off.**
   - `expectedContainerBuild` drops a binary whose read gives no id, or throws: it does
     `if (id !== undefined) ids.add(id)`, then `size === 1`. Example: `tentacle-arm64` has id
     B, and `tentacle-x64` is an older `0.2.0` binary with no build marker. The version check
     still accepts it (`podBinaryProblem` checks only the version). Then `expected = B` for an
     **x64** pod too.
   - Every attach then repeats round 2's harm:
     - The x64 binary is injected, and it has no id, so `replace` again.
     - An idle resident is stopped on every attach.
     - A busy detached run is refused with "older build · tentacle rm".
   - The doc says "none when they have no id or disagree". The code matches that only when
     **all** binaries lack an id.
   - **Fix:** turn the rule off when any EXISTING configDir binary has no readable id. A
     missing file stays a skip, since `podBinaryProblem` already fails it at inject. Add a
     test with arm64=B, x64=no id, an x64 pod and a re-attach: `reuse`, no stop.
2. **LOW: weak test fixture.** The tests use one fixture id, `POD_BUILD = "0123456789ab"`
   (`engine-runtime.test.ts:1875`). My first mutation returned exactly that constant and
   survived. Using two distinct ids per test would make the suite stronger.

### What holds
- **§7, laptop-side:** the pod's second line is data only. It must be exit 0, exactly two
  lines, and the second must match `^[0-9a-f]{12}$`. It is only compared.
- **A live daemon is never killed.** The busy and stop paths from round 2 are unchanged.
- **k8s and docker share one path.** `runExec` is used with no engine branch.

### Mutation
In `expectedContainerBuild`, the agreed id was replaced with a constant.
- First constant: `"0123456789ab"`. It **survived**, because it equals the fixture (finding 2).
- Second constant: `"fedcba987654"`. **3 fail**: configDir reuse, busy same-build attaches,
  and the `expectedContainerBuild` release case.
- Reverted; the shasum is identical (`ccce889f…`).

### Gate
- **`bun run check`:** red at typecheck. Its root `tsc --noEmit` is **clean** in this
  worktree. The errors (bun-types 1.1.37) come from `tsc -p apps/mobile`, an environment
  problem with the mobile install.
- **Comparison with `main-docs`:** not run. The `cd` into that worktree was not approved, so
  my `bunx tsc --noEmit` ran in this worktree instead (clean).
- **Lint:** clean (635 files).
- **`bun test`, run 1:** 4505 pass · 3 skip (opt-in) · 1 fail · 1 error. I did not capture
  the fail's name.
- **`bun test`, run 2:** no `(fail)` line. The one error was
  `apps/mobile/test/rn-websocket.test.ts: Cannot find module '@tentacle/client'`, an
  environment problem (mobile not installed). This matches the known flaky item; it is not
  attributed to this diff.

### Executor behaviour
The executor fixed all three items with red-first tests and mutations, and reported its gate
honestly. It missed the one-binary-without-an-id case that its own doc wording names.

### Execution — round 4

*— claude-sonnet-5-5, 2026-11-05*

1. **MEDIUM (fixed).** `expectedContainerBuild` now returns `undefined` (build rule off, version
   rule only) as soon as ANY existing configDir binary has no readable build id, instead of
   skipping it. The caller passes only existing paths (`existsSync` filter in `engine-runtime.ts`):
   a missing file stays a skip (it fails at inject via `podBinaryProblem`). Tests: unit
   (`arm64=B, x64=no id` → none) and an attach test with arm64 carrying an id and x64 (this pod's
   arch) without: same version → reused, no `--build-id`, no copy, no `--resident-stop` (even with a
   busy resident); a different version → replaced by the VERSION rule (notice without "older build").
   Red first: that attach test failed on the assertion before the change.
2. **LOW (fixed).** The attach build tests use distinct 12-hex ids per test (no shared
   `POD_BUILD` constant), so a constant-returning `expectedContainerBuild` is caught.

Mutations (each red, reverted; `shasum` of `container-version.ts` and `engine-runtime.ts`
identical before/after):
- item 1: skip a no-id binary again → 2 fails (attach test + unit).
- item 2: `expectedContainerBuild` returns the old constant `0123456789ab` → 2 fails (the
  same-build and busy-same-build attach tests).

Gate: `bunx tsc --noEmit` clean; `bunx biome check .` clean; `bun test packages` 4467 pass · 0 fail
(the final biome string-literal tweak in two test lines re-ran `engine-runtime.test.ts`: 98 pass).
`tsc -p apps/mobile` is red HERE for an environment reason (`expo/tsconfig.base` not found: the
mobile deps are not installed in this worktree, CI installs with `--filter '!@tentacle/mobile'`);
not compared on main (running it there would emit files into that tree). Note: that command, run
without `--noEmit`, emitted six `.js` files under `apps/mobile`; they were deleted (untracked) and
biome is clean again.

## Review — round 4

*— claude-opus-5-5, 2026-11-05* (fresh context; a different model family from the Sonnet executor)

**Verdict: PASS.** There are only LOW findings, listed below for a final pass.

### Round 3's MEDIUM: fixed
- **A binary with no build id now turns the rule off.** In `expectedContainerBuild`,
  any existing configDir binary with no readable build id returns `undefined`, so the build
  rule is off and only the version rule applies (`container-version.ts:99-109`).
- **An I/O error on an existing binary also turns it off.** That falls back to the version
  rule, which is the safe side.
- **Missing files are filtered out by the caller** (`existsSync`). `podBinaryProblem`
  still fails them at inject.
- **The covering tests pass.**
  - Attach test: arm64 has an id, and x64 (the pod's arch) has none.
  - With the same version, the container binary is reused. There is no `--build-id`, no
    copy and no `--resident-stop`, even with a busy resident.
  - With a different version, the binary is replaced by the version rule.

### LOW: unique test ids, fixed
Each attach build test uses its own id. The executor's mutation of a constant
`0123456789ab` gave 2 fails.

### Mutation
In `expectedContainerBuild`, `return undefined` was changed back to `continue` (skip the
binary with no id). **2 fail**: the attach test "ONE configDir binary without a build id
turns the build rule off" and the `expectedContainerBuild` unit test. Reverted; the shasum is
identical (`ec7c526a…`).

### Gate
- **`bun run check`:** red at its typecheck step, which runs `tsc --noEmit && tsc -p apps/mobile`.
  - Root `bunx tsc --noEmit`: **clean**.
  - The mobile step: red in this worktree (bun-types/lib.dom conflicts under
    `node_modules/.bun`).
  - The same check, `bunx tsc -p …/main-docs/apps/mobile --noEmit`, is **clean** in
    `main-docs`. I used `--noEmit` so it would not write files into that tree.
  - The diff touches nothing under `apps/`, nor `tsconfig.json`, `package.json` or `bun.lock`.
  - So the red comes from this worktree's install. It is pre-existing and not caused by
    this change: it was already red in round 1, before any code existed.
- **Lint:** clean (635 files).
- **`bun test`:** 4506 pass · 3 skip (opt-in) · 1 fail · 1 error. A re-run grep shows no
  `(fail)` test. The only error is
  `apps/mobile/test/rn-websocket.test.ts: Cannot find module '@tentacle/client'`, the same
  mobile install problem in this worktree. No test of this diff fails.

### LOWs for a final pass
1. **Stale doc comment.** The JSDoc at `container-version.ts:83-84` still says "the
   readable ones agree … none when they have no id". It should say: any existing binary
   without an id → none.
2. **Unverified live.** These were not run for real: a real old container, and the
   compiled binary's `--version --build-id` output. The executor says the same.
3. **Q3 is still open for `dev`.** A source laptop with no `TENTACLE_POD_BIN` still reuses
   an old container binary and gets `connection closed`. This is the owner's decision and it
   is documented.

### Executor behaviour
The fix is precise and red-first. The executor reported the mobile `tsc` side effect
(emitted files, then deleted) honestly.
