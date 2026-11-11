# fix/dev-build-version-skew — a dev build names its build, and the skew says what actually fixes it

> **Status:** review
> **Branch:** `fix/dev-build-version-skew`
> **Type:** fix · Size: S · Blast: contained · Suited: DeepSeek exec

## Context

*— deepseek-v4, 2026-11-10*

An owner on a `serve` host hit a skew live:

```
$ tentacle connect ws://192.168.1.17:4000
protocol version mismatch: client 21 (tentacle 0.3.0), daemon 16 (tentacle 0.3.0) — update the daemon: run "tentacle update" on that host
```

Two independent defects make that line wrong and unactionable:

1. **A dev build lies about itself.** Both sides printed `tentacle 0.3.0`, so the
   line reads as "same version, different protocol" — which cannot be acted on.
   The laptop's client was a `main` build (protocol 21) and the daemon the
   published release `v0.3.0` (protocol 16), and *nothing* in the message says
   the two are different builds of one version number. The build script already
   computes and verifies a per-source build id and **prints it**
   (`scripts/build.ts:83`, `console.log(\`build marker ${expectedBuild} ok\`)`),
   but it never reaches the version the binary reports:
   `APP_VERSION` is the plain `packages/cli/package.json` version, defined as the
   `TENTACLE_VERSION_MARKER` literal in `pod-binary-build.ts:142`.
2. **The advice is wrong in the reported case.** `advice()` blames the daemon
   purely from the protocol numbers (`daemon/src/version-mismatch.ts:44`) and
   tells the owner to `tentacle update` on that host. There the daemon *was*
   the latest release: `tentacle update` reinstalls `v0.3.0` and nothing moves.
   The fix that works is to put the client's build on that host.

Constraint: the protocol is unchanged. This task words a refusal and names a
build; it must not touch the wire format, a persisted format or an invariant
(hence `contained`).

**Repro** (`/Users/gmeghnag/tentacle/.tentacle/tmp/version-skew/`, gitignored):

_Recorded in **Execution** below (the script and its output, pasted, per
AGENTS §6)._

## Implementation

*— deepseek-v4, 2026-11-10*

### Load-bearing assumption

**A released build reports a plain `<major>.<minor>.<patch>` and never a `+`
suffix, because the release is cut from a clean, tagged `main` whose
`packages/cli/package.json` equals the tag.** Proven at two places that already
fail loudly otherwise:

- `scripts/release.ts:110` — every `packages/*/package.json` must carry the
  same version, and `scripts/release.ts:157` refuses unless the written
  `packages/cli/package.json` version is exactly the tag `v<version>`.
- `.github/workflows/build.yml:82` — the release job refuses a tag that does not
  match `packages/cli/package.json`, then publishes the binaries built in that
  same run — so a published binary's version IS a package.json version.

Hence a `+` in a reported version can only come from a build we added it to (a
dev build), and its absence can only mean a release. The advice may key on that
without guessing.

### Preconditions (verified in the source)

- `APP_VERSION` = the compiled-in `TENTACLE_VERSION_MARKER`, else `"dev"` from
  source — `packages/cli/src/version.ts:53`.
- The build marker (`computeBuildId`: 12 hex of a content hash of the source) is
  computed and verified exactly once per build — `pod-binary-build.ts:169`,
  `scripts/build.ts:78-86`.
- `MARKER_VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/` already accepts a `+` suffix —
  `version.ts:22` — so `0.3.0+1a2b3c4d5e6f` is a legal version everywhere a
  version is carried: the binary marker, `ClientInfoSchema.version`
  (`protocol/src/session.ts:117`), `parseVersionLine`
  (`cli/src/container-version.ts:15`).
- A version is compared for EQUALITY only, never for order, outside `update`:
  `podBinaryProblem` (`pod-binary-build.ts:280`), `container-version.ts:43`,
  `packages/cli/src/update.ts:287` (marker equality). `compareVersions`
  explicitly ignores `+…` build metadata (`update-plan.ts:39`) — and `update`
  refuses a non-release `appVersion` (nothing is published for a `+` version;
  it cannot be named by `--version`, see `normalizeTag`, `update-plan.ts:18`).
  **Corrected by fix round 1 — as originally written this was false.** Only
  `compareVersions` strips `+`: every other consumer compares `APP_VERSION`
  against a binary's plain version MARKER, so a compiled dev build
  (`0.3.0+<id>`) disagreed with its own binaries. The comparisons are now fed
  `APP_RELEASE_VERSION` (plain) and the `+` is display/wire only; see the
  fresh-context Review and *Execution — fix round 1*.
- The daemon already words the refusal from both sides' facts and ships them in
  `VersionMismatchData` (`daemon/src/version-mismatch.ts:110`); every daemon
  since protocol 10 sends it, and the client shows it unchanged
  (`client/src/version-mismatch.ts:27`).

### Design

Pure functions, no I/O, no new protocol field:

1. **`devBuildVersion(version, build)`** (`cli/src/version.ts`): `"0.3.0"` +
   `"1a2b3c4d5e6f"` → `"0.3.0+1a2b3c4d5e6f"`; anything that is not a build id
   yields the version unchanged. `APP_VERSION` is defined through it, so **one
   place** decides what a build calls itself.
2. **The build decides whether it is a dev build**, not the source state:
   `buildBinary` (`pod-binary-build.ts`) — the one function both the `compile`
   script and the pod-binary cache call — takes the suffix from the caller.
   `scripts/build.ts` passes one **unless `TENTACLE_RELEASE=1`**; the pod-binary
   cache build (a cache file for local use, never shipped) always passes one.
   A release build therefore keeps the plain version and the version-marker
   check in `scripts/build.ts` still holds (it derives `cliVersion()`, the plain
   version).
3. **`advice(...)`** (`daemon/src/version-mismatch.ts`): the advice becomes a
   function of the facts, with the client's version now self-describing (`+` = a
   dev build, i.e. newer than any release):

   | older side | the client | advice |
   | --- | --- | --- |
   | client | any | `update this client: "tentacle update"` (a dev client's own fix is its checkout, which `update` already refuses with the right words — `update.ts:218`) |
   | daemon (`serve`) | a dev build (`+`) | `the client is a newer build than any release: install the same build on that host (build this source there, then run "tentacle serve")` — nothing published has this protocol, so `tentacle update` would reinstall the same old release |
   | daemon (`serve`) | a release (no `+`) | `update the daemon: run "tentacle update" on that host and restart "tentacle serve"` (unchanged — `update` really can move it) |

   A container daemon keeps its `attach` advice (that path rebuilds the pod's
   binary from this laptop, which is exactly "the same build"). A client that
   reported no version keeps today's advice — never a guess, and neither does a
   client that is not the CLI (the app, `tentacle-mobile`): it has no "build
   this source" step to point at, so it keeps today's words.
   `VersionMismatchData.update` is untouched (still `client` | `daemon`): only
   the words change.

   The discriminator is the CLIENT's build, not the daemon's: the daemon's own
   version is irrelevant to whether `update` can help it — what matters is that
   the protocol the client speaks exists in no published release, which its `+`
   says.

### Files

1. `packages/cli/src/version.ts` — `devBuildVersion`, `APP_VERSION` through it.
2. `packages/cli/src/pod-binary-build.ts` — `buildBinary(outfile, target, build?)`,
   the marker literal from it; the pod cache passes `computeBuildId(root)`.
3. `scripts/build.ts` — pass the build id unless `TENTACLE_RELEASE=1` (the
   decision itself is `buildIdFor` in `pod-binary-build.ts`, so it is tested);
   the marker check accepts "none" for a release; say which version it compiled.
   `.github/workflows/build.yml` — set `TENTACLE_RELEASE=1` for a `v*` tag only.
4. `packages/daemon/src/version-mismatch.ts` — `versionAdvice`.
5. `CHANGELOG.md` — Fixed.
6. Tests: `packages/cli/test/version.test.ts` (new),
   `packages/daemon/test/version-mismatch.test.ts` (cases),
   `packages/cli/test/connect.test.ts` (the real CLI message).

### Failure modes

- **A released binary gets a suffix.** `TENTACLE_RELEASE=1` is set by
  `scripts/release.ts` (a test asserts it), so a release build cannot be one
  without it, and the marker check in `scripts/build.ts` fails if it ever got
  one; the release workflow keeps the plain version.
- **The daemon reports a version string we cannot classify** (no `clientInfo`
  from an old client — which is also always an older client, so it takes the
  `update this client` branch) → today's advice, never a guess: the "install
  the same build" line is only used when the CLIENT said it is a `+` build.
- **`update` on a dev build** → already refused with the checkout advice
  (`update.ts:218`), so no new dead end.
- **Wire/persisted compat**: no schema, no field, no version bump — an old
  daemon reading a `+` client version still validates it
  (`ClientInfoSchema.version` allows `+`) and words its own message.

### Tests

Red before green, each pinning the exact property:

1. `devBuildVersion`: appends an id, leaves a version without one, refuses a
   non-id (the "a release never lies" property).
2. `versionAdvice`/`advice`: a dev-build client + an older `serve` daemon →
   "install the same build" (and no `tentacle update`); a RELEASE client + an
   older `serve` daemon → the `update` hint; a dev-build client + a container →
   the `attach` advice; an older client → "update this client".
3. `scripts/build.ts`'s decision, `buildIdFor` (a pure function the script
   calls, so no compilation in the test): `TENTACLE_RELEASE=1` yields no
   suffix; every other value does. Plus one real compile per side (below).
4. CLI level (real message): `connect` against a daemon that refuses with the
   report → the message the owner sees, for both the "+daemon" and the
   "release daemon" cases.
5. Mutation: dropping the suffix from `APP_VERSION` makes 1 and 4 fail;
   removing the advice branch makes 2 and 4 fail (both shown in Execution).

## Execution

*— deepseek-v4, 2026-11-10*

**Repro, before any edit.** `.tentacle/tmp/version-skew/repro.ts` plus a real
`bun run compile` on the unmodified tree:

```
1) a dev build's own version string : "dev"
2) the live line (daemon = latest release, client = main):
   protocol version mismatch: client 22 (tentacle dev), daemon 16 (tentacle 0.3.0) — update the daemon: run "tentacle update" on that host and restart "tentacle serve"
$ ./dist/tentacle --version --build-id
tentacle 0.3.0          ← a `main` build, byte-for-byte, calling itself release v0.3.0
f4b2b14ef66a
```

Faithful to the live report: the compile script knew the build id
(`build marker f4b2b14ef66a ok`) and still reported `0.3.0`.

**Done, in order.**

1. **RED, on the assertion** — `packages/cli/test/version.test.ts` (new).
   First run failed on a missing export (an import error, which §9 does not
   count), so `devBuildVersion` was added returning its argument (today's
   behaviour) and the test then failed on the property:
   `Expected "0.3.0+1a2b3c4d5e6f" / Received "0.3.0"`.
   Same for `packages/daemon/test/version-mismatch.test.ts` (new live case) and
   `packages/cli/test/connect.test.ts` (the real message): both red on the
   message, which still read `— update the daemon: run "tentacle update" …`.
2. `packages/cli/src/version.ts` — `devBuildVersion` (checks the id is a build
   id, so a version is never invented); `APP_VERSION` now goes through it with
   `APP_BUILD`, so one place decides what a build calls itself. From source it
   stays `"dev"` (no marker, no build id).
3. `packages/cli/src/pod-binary-build.ts` — `buildBinary(outfile, target, build)`
   compiles the build marker only when given one; `buildIdFor(env, sourceId)` is
   the pure release/dev decision; the pod-binary cache build passes
   `computeBuildId()`, so a locally cached binary also says `+<id>`.
4. `scripts/build.ts` — calls `buildIdFor(process.env, computeBuildId(root))`;
   its build-marker check now expects exactly one when there is an id and NONE
   for a release; it prints the version it compiled.
   `.github/workflows/build.yml` — `TENTACLE_RELEASE=1` only for a `v*` tag.
5. `packages/daemon/src/version-mismatch.ts` — `advice()` gains the dev-build
   client branch (`isDevBuild`: the version contains `+`). Pure, from facts
   already in hand.
6. `CHANGELOG.md` — Fixed.

**Real binaries, both sides** (the acceptance check that matters):

```
$ bun run compile                      $ rm dist/tentacle; TENTACLE_RELEASE=1 bun run compile
build marker 6f43104044d1 ok           build marker none (release build) ok
compiled tentacle 0.3.0+6f43104044d1   compiled tentacle 0.3.0
$ ./dist/tentacle --version
tentacle 0.3.0+6f43104044d1            tentacle 0.3.0
6f43104044d1                           dev
```

**Drift from Implementation (and why).**

- **The advice keys on the CLIENT's build, not the daemon's.** The first draft
  (and the first red test) keyed on the daemon's version being a `+` build. That
  is the wrong question: whether `update` can help depends on whether the
  protocol the client speaks exists in a published release, and the client's `+`
  says exactly that. A dev-build daemon behind a RELEASE client is a different
  case with a different fix (the client must move), so keying on the daemon
  would have mis-advised it. Implementation, table and tests were corrected;
  the live case is unaffected.
- **`buildBinary`'s third parameter has NO default.** With a default, the
  release path's explicit `undefined` was swallowed by the default (a JS default
  also applies to `undefined`) and the release binary silently got a build
  marker — caught by `scripts/build.ts`'s own check (`carries build marker(s)
  [85d876fdb0b0], expected none (a release build)`) on the first real release
  build. Required-and-explicit instead; the `resolvePodBinary` seam passes the
  id through a closure.
- **`buildIdFor` lives in `pod-binary-build.ts`, not `scripts/build.ts`.** The
  script is a top-level script with side effects on import; the decision had to
  be a pure function the script calls to be testable without compiling.
- **`pod-binary-build.test.ts` updated**: its existing real-compile test now
  passes `computeBuildId()` (a dev build) and a second test pins the release
  side (no build marker at all). Not in the plan's file list, but it calls the
  signature that changed.

**Gate.**

```
bunx tsc --noEmit          → clean (exit 0)
tsc -p apps/mobile         → 47 errors, ALL in apps/mobile/* or node_modules libs (deps absent)
bun run lint               → biome check .: 871 files, 0 errors, 0 warnings (baseline, §6)
bun test                   → 6785 pass, 3 skip, 1 fail, 1 error (480 files, 289 s)
```

The one failure + one error are the SAME file,
`apps/mobile/test/rn-websocket.test.ts`: `Cannot find module
'@tentacle/client'`, because this worktree's install ran with
`--filter '!@tentacle/mobile'` (as CI does, §6) and `apps/mobile/node_modules`
does not exist here. Evidence it is environmental, not a regression: the
primary checkout HAS that directory; no mobile file is in this diff
(`git diff --name-only | grep apps/mobile` → empty); and the file fails alone
(`bun test apps/mobile/test/rn-websocket.test.ts` → same "Cannot find module"),
i.e. before any test body runs. The 3 skips are the documented opt-in ones
(live-k8s, live-docker, real-socket keepalive). Everything else is green,
including `apps/mobile`'s OTHER test files, which resolve their imports.

**Not verified:** the CI release path (`TENTACLE_RELEASE=1` from a `v*` tag) is
verified only locally by running the same command the workflow runs; the YAML
expression itself needs a tagged run, and the mobile project's typecheck/test
needs `bun install` without the mobile filter.

## Review

*— deepseek-v4, 2026-11-10*

Adversarial pass over the diff (the executor reviewed its own work here, so
this is **not** the fresh-context Review AGENTS §10 asks for on load-bearing or
`L` work — this task is `contained`/`S`, where standard in-context Review is
the rule; a second pair of eyes is still the cheaper way to catch what I
rationalised).

What holds, checked against the source:

- **The load-bearing assumption is real.** A released binary cannot carry a
  `+`: `release.ts` refuses a mismatched tag and rewrites `packages/cli/package.json`
  to the tag; build.yml re-checks the tag against that file before publishing
  the very binaries it built, and I made the release job the only caller that
  sets `TENTACLE_RELEASE=1`. Verified end to end, not just read: a real
  `TENTACLE_RELEASE=1 bun run compile` produces `tentacle 0.3.0` and, crucially,
  a binary with **no build marker at all** (`--version --build-id` prints
  `dev`), which is what makes a later `attach`'s "an older build" check behave.
- **Red before green, on the property, for all three layers** — and both
  mutations were run and seen to fail (suffix dropped → the version and
  build-seam tests; advice branch removed → the daemon AND the CLI-level
  `connect` test). Nothing was left mutated: `rg MUTATION` finds only
  pre-existing doc comments.
- **The three advice branches cannot disagree with what `update` can do:** the
  new line is reached only for the CLI with a `+` client version and a non-container
  daemon; every other combination keeps bytes it kept before (the pre-existing
  daemon tests are unchanged and still pass).
- **No protocol, persisted-format or invariant surface is touched:**
  `VersionMismatchData` is byte-identical (only `message` words change), no
  schema changed, no `PROTOCOL_VERSION` bump — correct, since no field or
  meaning changed (AGENTS §7). `ClientInfoSchema.version` already allowed `+`,
  so an older daemon still parses a `+` client.

What does not hold / residual risk, stated honestly:

- **A pre-release release** (`0.4.0-beta.1`) contains no `+` and is correctly
  treated as a release — but a client running such a build IS ahead of the
  latest stable release, and the message will still say `tentacle update`. I
  left this alone deliberately: `update` installs the latest stable, so the
  advice is only wrong when the daemon could not move to it, and keying on a
  `-` suffix would re-introduce the guessing this fix exists to avoid. The
  owner's own rule for the case is "release ⇒ no `+`"; a pre-release nuance is
  a follow-up, not something to fold in here.
- **`isDevBuild` reads the string, not a structured field.** A future client that
  puts a `+` in a release version would be mis-advised. That is the same
  assumption, one layer down; and the fix would be a protocol field, which is
  out of scope for a `contained` wording fix.
- The daemon words the message, so a client older than this change still shows
  the old text against a new daemon only if the DAEMON is old — i.e. this is a
  "update one side" bug class that cannot be retro-fixed for two old builds.
  Correct by construction.
- How the implementing model behaved: two real defects were caught by the
  repo's own checks rather than by reasoning — the default-parameter swallowing
  a release's `undefined` (caught by `scripts/build.ts`'s marker check on the
  first release compile) and the first draft keying the advice on the wrong
  side (caught by writing the test against the live shape first). Both are
  recorded in Execution as drift.

## Review (fresh context)

*— claude-opus-5-5, 2026-11-11*

**Verdict: REQUEST-CHANGES.** The hint logic, the CI expression
(`startsWith(github.ref, 'refs/tags/v') && '1' || ''` → `"1"` on a `v*` tag,
`""` on a branch/manual run, and `buildIdFor` treats `""` as dev) and the
release job's tag-vs-`package.json` check (reads the file, not the binary) are
correct. The load-bearing claim in `version.ts` — "`update` … ignores `+…`
metadata, so nothing that compares or installs a version changes meaning" — is
**false**: only `compareVersions` strips `+`; every other consumer compares
`APP_VERSION` for exact equality with a binary's **version marker**, and the
marker stays plain (`buildBinary` writes `formatVersionMarker(cliVersion())`).
So every compiled non-release build (`bun run compile`, CI on `main`) now has
`APP_VERSION = "0.3.0+<id>"` against its own marker `"0.3.0"`. Repro
(`.tentacle/tmp/version-skew/repro.ts`, run against the branch):

```
podBinaryProblem: the Linux pod binary for x64 is at version 0.3.0 (…; this tentacle is 0.3.0+1a2b3c4d5e6f): run `tentacle update`
planUpdate latest=0.3.0: {"self":null,"podVersion":"0.3.0+1a2b3c4d5e6f","podTargets":["bun-linux-x64","bun-linux-arm64"],"status":"update"}
update self-check refuses (marker 0.3.0 !== appVersion): true
attach, TENTACLE_POD_BIN = dev build, container runs that same build: {"kind":"replace","had":"0.3.0+1a2b3c4d5e6f","reason":"version"}
```

Findings (all HIGH — each breaks a command that worked on `main` for a compiled dev build):

1. **`run`/`attach` can never inject a pod binary** — `packages/cli/src/pod-binary-build.ts:276`
   (`version === appVersion`), reached from `checkPodBinaries` :293 and
   `resolvePodBinary` :337. A dev build is not `"dev"`, so it takes the release
   path and requires a config-dir binary whose marker equals `0.3.0+<id>` —
   which no binary carries. Scenario: compile `main`, `tentacle run` → always
   `PodBinaryError … run tentacle update`, and `update` cannot fix it (#2).
2. **`tentacle update` is broken for a dev build** — `packages/cli/src/update-plan.ts:128-132`
   and `packages/cli/src/update.ts:287`. (a) latest == `0.3.0`: `podVersion`
   becomes `0.3.0+<id>`, both pods are "stale", status `update` (and `--check`
   exits `EXIT_UPDATE_AVAILABLE`), then it downloads tag `v0.3.0+<id>` → 404.
   (b) latest `0.4.0`: the "never overwrite a file that is not this tentacle"
   guard reads marker `0.3.0` ≠ `0.3.0+<id>` → refuses to update itself.
3. **`attach` with `TENTACLE_POD_BIN` replaces its own build every time** —
   `packages/cli/src/container-version.ts:38/43` + `:176`. `expected` comes from
   the file's plain marker, `found` from the container's `--version`
   (`0.3.0+<id>`) → `replace … reason: "version"` on every re-attach, and the
   `StaleBuildError` "never kill a live daemon" guard (`engine-runtime.ts:893`)
   covers only `reason: "build"`, so a busy resident is replaced.

Exact fix (smallest, keeps the user-visible `+<id>`): keep the plain version as
the identity every **comparison** uses, and use the suffixed one only for
**display / the wire**. In `version.ts` export `APP_RELEASE_VERSION =
parseVersionMarker(compiledVersionMarker()) ?? "dev"` (plain) and
`APP_VERSION = devBuildVersion(APP_RELEASE_VERSION, APP_BUILD)`; pass the plain
one to `checkPodBinaries`/`resolvePodBinary`/`expectedContainer*`/`runUpdate`
(`engine-runtime.ts:843,882` defaults, `pod-binary-build.ts:293,337` defaults,
`main.ts:631`; the run-state owner records at `relay.ts:229` /
`attach-run.ts:432` are informational and may keep `APP_VERSION`), and have
`parseVersionLine` (`container-version.ts:13`) return the version up to `+`
(the build is already judged separately by the build rule). Keep
`APP_VERSION` for `--version`, `CLIENT_INFO`, `serve` identity and the worker
bootstrap. Add regression tests that fail today: `checkPodBinaries` with
`appVersion` from a dev build and a matching plain-marker binary passes;
`runUpdate` with a dev `appVersion` vs latest equal → "up to date", no
download; `containerDecision` for a `+` probe against a plain expected →
`reuse`. Also correct the false sentence in `version.ts:97-99` and the
Context/Review claim that consumers are unaffected.

Not findings: the three hint branches are right per case (a dev client is
reached only with `client.protocol > daemon.protocol`, where no published
release can match it; container/older-client branches unchanged). Narrow
tests pass (62/62) — they pass precisely because none exercises a `+`
`appVersion` through the equality consumers, so no mutation was needed to
show the gap.

## Execution — fix round 1

*— deepseek (tentacle --profile deepseek), 2026-11-11*

Applied the fresh-context Review's REQUEST-CHANGES exactly: the plain version is
now the identity every **comparison** uses; the `+<id>` one is display/wire only.
The three findings are one root cause — `APP_VERSION` was both — so the fix is
one split, not three patches.

**What changed**

- `version.ts`: `APP_RELEASE_VERSION = parseVersionMarker(compiledVersionMarker())
  ?? "dev"` (plain), and `APP_VERSION = devBuildVersion(APP_RELEASE_VERSION,
  APP_BUILD)`. The false sentence is gone; the header now says which constant is
  for comparing and which for displaying. `APP_VERSION` keeps `--version`
  (`main.ts:541,557`), `CLIENT_INFO` (`:127`), `serve`'s identity
  (`serve.ts:207,525`) and the worker bootstrap (`local-runtime.ts:1087`).
- Every comparing consumer takes the plain one: `podBinaryProblem`'s callers
  `checkPodBinaries` (`pod-binary-build.ts:293`) and `resolvePodBinary` (`:337`)
  defaults; `expectedContainerBuild`/`expectedContainerVersion` defaults
  (`engine-runtime.ts:849,888`); `runUpdate` (`main.ts:631`).
- `parseVersionLine` (`container-version.ts:21`) cuts at `+`, so a container's
  `0.3.0+<id>` answer compares equal to the plain marker of the binary this
  laptop would inject. The build difference is untouched: it stays the build
  rule's (`parseBuildFromVersionProbe`), which is why a same-version older build
  is still replaced (`reason: "build"`) and a busy resident still protected.
- Swept every other `APP_VERSION` consumer (below). All are display, wire, or an
  informational run-state/control-socket field — none compares or keys a path.

**Consumer sweep** (`rg -n "APP_VERSION" packages scripts apps`)

| consumer | kind | verdict |
| --- | --- | --- |
| `main.ts:541,557` | `--version`, `--help` version | display — keep suffixed |
| `version.ts:127` `CLIENT_INFO` | `initialize`'s client identity | wire — keep (the `+` is what an old daemon's message needs) |
| `serve.ts:207,525` | daemon identity (`serve`, `container`) | wire — keep |
| `local-runtime.ts:1087` | worker bootstrap `version` | wire — keep |
| `relay.ts:229,518`, `attach-run.ts:432` | run-state record + control reply | written, read only for validity (`run-state.ts:186`), never compared — keep (the Review allowed this) |
| `update.ts` message lines | `tentacle X is up to date` etc. | fed `deps.appVersion`, which is now plain — see note |

Note on `update`'s wording: its messages print `deps.appVersion`, so they now
print the plain version a released binary would. For a dev build that is the
honest answer (`update` can only ever install a release, and it names the
release lineage it is on); the build's own identity is `--version`'s job.

**Tests (each RED first, one mutation each, reverted after)**

1. `pod-binary-build.test.ts` — *a COMPILED DEV BUILD finds its own pod
   binaries*: `checkPodBinaries` with the DEFAULT `appVersion` and plain-marker
   binaries must not throw. Mutation: defaults back to `APP_VERSION` → RED with
   the review's own text (`… is at version 0.3.0 …; this tentacle is
   0.3.0+1a2b3c4d5e6f): run "tentacle update"`).
2. `update.test.ts` — *a COMPILED DEV BUILD at the latest release says up to
   date, and downloads nothing*: `update --check` on a dev build with latest
   `v0.3.0` must exit 0, say `tentacle 0.3.0 is up to date (v0.3.0)` and fetch no
   `/download/`. Mutation: `main.ts` passes `APP_VERSION` → RED, exit 10 with
   `bun-linux-x64: 0.3.0 → 0.3.0+1a2b3c4d5e6f` (finding 2 verbatim).
3. `container-version.test.ts` — *a dev build's `+<id>` answer against the plain
   expected version → reuse*, plus the two neighbours that must NOT regress
   (a different version still replaces; the build rule still replaces an older
   build of the same version). Mutation: drop the `+` cut in `parseVersionLine`
   → RED (both that test and its `parseVersionLine` unit).

A spawned process is required for 1 and 2: from source `APP_VERSION` is `"dev"`,
so the suite's own process cannot present a compiled dev build. `version.ts`
reads its literals via `typeof __TENTACLE_*`, which resolves on `globalThis` when
no `define` exists, so `test/fixtures/dev-build.ts` seeds the two marker globals
before the first import — byte-for-byte what `bun run compile` bakes in — and the
tests run it with `Bun.spawnSync` (a fresh module cache, a fake `fetch`, no
network). The three pre-existing `parseVersionLine` expectations that pinned the
old whole-string behaviour were updated to the new rule.

**Drift from the Review:** none in substance. One clarification: the Review
suggested `parseVersionLine` "return the version up to `+`" — done in
`parseVersionLine` itself rather than in `containerDecision`, so `had` and the
`replacedNotice` line also stop reporting a `+` id for a binary the build rule
already describes. `update`'s user-facing messages consequently print the plain
version (see the note above); the Review did not specify them.

**Gate** (this worktree, `--filter '!@tentacle/mobile'` install — `apps/mobile`
deps are absent here):

```
bunx tsc --noEmit   → clean (exit 0)
bunx tsc -p apps/mobile → 47 errors, all in apps/mobile/* or lib.dom/node_modules (deps absent)
bun run lint        → biome check .: 872 files, 0 errors, 0 warnings (baseline, §6)
bun test            → 6788 pass, 3 skip, 1 fail, 1 error (480 files, 289 s)
```

6788 pass = the 6785 pre-fix baseline + exactly the 3 new tests. The 1 fail + 1
error are the documented environmental one,
`apps/mobile/test/rn-websocket.test.ts` (`Cannot find module '@tentacle/client'`
— the mobile install is absent; it fails alone, before any test body, and
`git diff --name-only | grep apps/mobile` is empty). The 3 skips are the opt-in
ones (live-k8s, live-docker, real-socket keepalive).

**Verified on a real compiled binary** (not just the `globalThis` seam): a
`bun run compile` of this branch reports `tentacle 0.3.0+26f68a892baa`, and with a
config dir holding plain `0.3.0` pod binaries — `update --check` prints
`tentacle 0.3.0 is up to date (v0.3.0)`, both pods listed at `0.3.0` with no
`→`, exit 0; `run`'s preflight passes (it reaches pod creation, failing only on
the deliberately unreachable API server `https://127.0.0.1:1`). Mutating
`checkPodBinaries`'s default back to `APP_VERSION`, recompiling and re-running the
same `run` gives the review's finding 1 on a real binary: `[pod] failed: the Linux
pod binary for x64 is at version 0.3.0 (…; this tentacle is 0.3.0+<id>)`. Reverted
and recompiled (the `dist/tentacle` left in place is the unmutated build).

**Not verified:** nothing on the release path changed in this round, so the CI
`TENTACLE_RELEASE=1` case stands as Review recorded it; the mobile project's
typecheck/test still needs `bun install` without the mobile filter.

## Review — round 2

*— claude-opus-5-5, 2026-11-11*

**Verdict: PASS.** Scope: the fix commit `9dc03c0` (`git diff HEAD~1`) against round-1 findings 1–3, a sweep of every version consumer, and new HIGH/MEDIUM.

**(1) Findings fixed as specified, tests really red/green.**
- `version.ts:116/124`: there are now two versions. `APP_RELEASE_VERSION` is plain and comes from the marker. `APP_VERSION = devBuildVersion(APP_RELEASE_VERSION, APP_BUILD)` adds the build id.
- F1: the defaults in `pod-binary-build.ts:293,337` and `engine-runtime.ts:849,888` now use `APP_RELEASE_VERSION`.
- F2: `main.ts:631` now passes `APP_RELEASE_VERSION` to `runUpdate`.
- F3: `parseVersionLine` cuts the version at `+` (`container-version.ts:21`). The build rule is untouched, and the new test pins that an older build of the same version is still replaced (`reason: "build"`).
- The new F1 and F2 tests spawn `test/fixtures/dev-build.ts`. It seeds the two `__TENTACLE_*` globals before `version.ts` is imported, so the code really runs as a compiled dev build (`APP_VERSION` = `0.3.0+1a2b3c4d5e6f`, asserted). The suite's own process cannot do this, because from source the version is `"dev"`.
- Mutation run (I put back all three old sites at once):
  - the `pod-binary-build.ts` defaults back to `APP_VERSION`;
  - `main.ts:631` back to `APP_VERSION`;
  - `parseVersionLine` no longer cuts at `+`.

  Result: 4 fails, which are the two spawned dev-build tests, the `parseVersionLine` `+` test and the `containerDecision` reuse test. I reversed each mutation exactly; `git status` was clean afterwards and the tests were green again.

**(2) Sweep: no comparison still uses the version with `+`.** `rg APP_VERSION` over `packages/*/src`:
- **Display or wire only, never compared:** `--version`/help (`main.ts:541,557`), `CLIENT_INFO` (connect and the local runtime), `serve`'s identity (`serve.ts:207,525`) and the worker bootstrap (`local-runtime.ts:1087`).
- **Run-state owner records** (`relay.ts:229,518`, `attach-run.ts:432`): `run-state.ts:186/201` and `control-socket.ts:112` only parse and pass them on. No reader compares them.
- **Every comparison uses the plain version:**
  - pod-binary checks and resolution;
  - the version `attach` expects for the container (`expectedContainerVersion`) and the build rule (`expectedContainerBuild`);
  - every equality check in `update` (`update.ts:257,274,291`);
  - `compareVersions`, which strips `+` anyway.
- `parseVersionLine` cuts at `+`; its other caller (`engine-runtime.ts:989`) only builds a warning to display.
- `install.sh:150-151` compares `--version` of a published binary with the tag. A tag build sets `TENTACLE_RELEASE=1`, so that output is plain.
- The release job's tag check (`build.yml:87-88`) reads `package.json`, not the binary. Not affected.

**(3) New HIGH/MEDIUM: none.** One gap remains, and `main` has it too, so this branch did not add it. A dev-build laptop whose config-dir pod binaries are released ones (no build marker) has no build rule. On `attach` it reuses or injects a release binary, which may speak a different protocol, and the refusal then says "run tentacle attach again", which cannot help. This is outside this fix's scope. A follow-up could make it inject its own build.

Narrow tests (container-version, update, pod-binary-build, version, version-mismatch, connect): 136 pass, 0 fail.
