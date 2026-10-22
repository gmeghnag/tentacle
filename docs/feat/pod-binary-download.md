# feat/pod-binary-download — version marker, download+verify helper, offline `run`/`attach` check

> **Status:** review
> **Branch:** `feat/pod-binary-download`
> **Type:** feat · **Size:** S–M · **Blast:** cross-module · **Suited:** strong model executes; standard Review

## Context

*— claude-opus-5-5, 2026-10-22*

Child 1 of 3 of `docs/eval/tentacle-update.md` (owner decisions D1–D4, 2026-10-22).
Today a pod binary in `<configDir>/bin/` is injected whatever its version, and
a compiled binary carries no version that can be read without executing it
(the laptop is often macOS and cannot run the Linux pod binary). The owner
decided:

- **D2** — a version **marker** constant `TENTACLE_VERSION_MARKER:<version>:END`
  compiled into the binary, read by scanning the file from the end. The binary is
  never modified after the build. No marker = unknown version.
- **D1** — `run`/`attach` stay offline: a missing pod binary, or one whose marker
  version ≠ `APP_VERSION`, is an error that says `run tentacle update`. The
  download lives in `tentacle update` (child 2), which this task gives a helper.
- **D3** — integrity is HTTPS + the release's `SHA256SUMS`, nothing more.
- **D4** — `attach` keeps reusing a tentacle already in the pod; untouched.

**Repro** (2026-10-22, on `feat/pod-binary-download` = `main` @ `38fbd09`,
`.tentacle/tmp/pod-binary-download/repro.ts`):

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePodBinary } from "../../../packages/cli/src/pod-binary-build.ts";
const dir = mkdtempSync(join(import.meta.dir, "cfg-"));
mkdirSync(join(dir, "bin"));
writeFileSync(join(dir, "bin", "tentacle-bun-linux-x64"), "STALE-NO-MARKER");
const bytes = await resolvePodBinary("bun-linux-x64", { configDir: dir, build: async () => false });
console.log("resolved:", Buffer.from(bytes).toString());
```

```
resolved: STALE-NO-MARKER          # a marker-less (unknown-version) binary is injected
$ grep -rn VERSION_MARKER packages scripts | wc -l
0                                  # no marker exists in the build
```

## Implementation

*— claude-opus-5-5, 2026-10-22*

### Load-bearing assumption

**A string literal that the bundled code uses survives `Bun.build({compile,
minify})` verbatim, as contiguous UTF-8 bytes in the output file, near its
end.** The version reaches the build only as a `define` literal
(`packages/cli/src/pod-binary-build.ts:104-108`); the CLI reads it at
`packages/cli/src/main.ts:67`. Proven empirically in Execution by compiling a
real `bun-linux-x64` binary and scanning it (an unused literal could be
tree-shaken, so the marker must be load-bearing: `APP_VERSION` is *derived*
from it).

### Preconditions

- `resolvePodBinary` order today: `TENTACLE_POD_BIN` (`pod-binary-build.ts:181`)
  → `<configDir>/bin/tentacle-<target>` (`:189-196`) → repo cache → build from
  source (`:199-213`).
- Both runtimes resolve through it: `run` at `pod-runtime.ts:308`, `attach` at
  `:496`, only when the preflight `tentacle --version` fails (`:485`, D4).
- `run` creates the pod at `pod-runtime.ts:278` *before* the arch is known (arch
  is probed inside `injectAgentBinary`, `pod-binary.ts:140`, then resolved at
  `:143`). So a "fail before any pod is created" check cannot know the arch.
- `injectAgentBinary` resolves (`pod-binary.ts:143`) before the first write into
  the pod, so an `attach` resolve error mutates nothing.
- Release assets are raw `tentacle-bun-<os>-<arch>` + `SHA256SUMS` in
  `sha256sum` format (`.github/workflows/build.yml`, "Checksums" step).
- `scripts/build.ts` builds through `buildBinary` and re-signs on macOS (it must
  check the marker after the re-sign, never rewrite the file).

### Design

1. **`packages/cli/src/version.ts`** (new, pure): `MARKER_PREFIX`,
   `formatVersionMarker(v)`, `parseVersionMarker(s)`, `APP_VERSION` =
   `parseVersionMarker(process.env.TENTACLE_VERSION_MARKER) ?? "dev"`.
   `buildBinary` replaces the `TENTACLE_APP_VERSION` define with
   `process.env.TENTACLE_VERSION_MARKER` = the marker literal, from the same
   `packages/cli/package.json` read. Deriving `APP_VERSION` from the marker makes
   the literal load-bearing (never tree-shaken) and `--version` and the marker
   cannot disagree. `main.ts` imports `APP_VERSION`.
2. **`packages/cli/src/version-marker.ts`** (new): `findVersionMarker(bytes)`
   (pure, scans from the end, returns the last valid
   `TENTACLE_VERSION_MARKER:<[0-9A-Za-z.+-]{1,64}>:END`; anything else, e.g. the
   bare prefix literal in the scanner's own code, is skipped) and
   `readBinaryVersion(path, {tailBytes = 16 MiB, chunkBytes})`: read the tail,
   else a full backward scan in chunks overlapping by the max marker length.
   Read-only.
3. **`resolvePodBinary`** gets `appVersion` (default `APP_VERSION`).
   - `"dev"`: unchanged, byte for byte.
   - otherwise: `TENTACLE_POD_BIN` still wins (the explicit escape hatch), then
     `<configDir>/bin/tentacle-<target>` only if its marker equals `appVersion`;
     otherwise throw `PodBinaryError` "the Linux pod binary for <arch> is missing
     / at version X / of unknown version (this tentacle is Y): run `tentacle
     update`". No repo cache, no build.
   - `checkPodBinaries(opts)`: the same check for **both** Linux targets (D1/D8:
     `update` always installs both, no `--no-pods`), no-op in dev or with
     `TENTACLE_POD_BIN`.
4. **`startPodRuntime`** calls `checkPodBinaries` before `createPod`, so `run`
   fails before any cluster mutation. `attach` is not pre-checked (the pod may
   already have tentacle, D4); its resolve error happens before any write into
   the pod. `PodRuntimeDeps.appVersion?` is the test seam.
5. **`packages/cli/src/pod-binary-download.ts`** (new), for child 2:
   `releaseAssetUrl`, `parseSha256Sums`, `fetchSha256Sums`, `downloadVerifiedAsset`
   (stream into `<destDir>/.<asset>.<random>.tmp`, hash while writing, compare,
   `chmod 755`, return the temp path; delete it on every failure) and
   `commitDownload(temp, final)` (`rename`). Injected `fetch`, no dependency.
6. **`scripts/build.ts`**: after the build (and the macOS re-sign) it reads the
   output's marker and exits 1 unless it equals `packages/cli/package.json`
   `version`. CI runs it for all four targets, so every release asset is checked.
7. **README Install**: step 2 becomes `tentacle update`.

### Files

`packages/cli/src/version.ts` (new) · `packages/cli/src/version-marker.ts` (new) ·
`packages/cli/src/pod-binary-build.ts` · `packages/cli/src/main.ts` ·
`packages/cli/src/pod-runtime.ts` · `packages/cli/src/pod-binary-download.ts` (new) ·
`scripts/build.ts` · `README.md` · tests under `packages/cli/test/`.

### Failure modes

| Case | Outcome |
|---|---|
| Pod binary missing / stale / no marker (release build) | `run`: error before `createPod`; `attach`: error before any write into the pod, pod untouched (never deleted) |
| Only one arch present | `run` errors (both are required, D1/D8); `attach` errors only if it needs the missing arch |
| Marker split across a read chunk | chunks overlap by the max marker length |
| Several markers / prefix literal in code | strict grammar; the last valid one from the end wins |
| Download: HTTP 404/5xx, body drop, checksum mismatch | throws with the URL/asset; the temp file is removed; final path untouched |
| Asset absent from `SHA256SUMS` | throws before downloading the asset (no temp created) |
| Dev mode (`APP_VERSION === "dev"`) | today's behaviour, unchanged |

### Tests

- `version-marker.test.ts`: found near the end; found only by the full-scan
  fallback (marker before the tail); absent → `undefined`; split across a chunk
  boundary; corrupt/partial (`…:0.1.0` without `:END`, bad charset, bare prefix)
  → `undefined`; `parseVersionMarker`/`formatVersionMarker` round trip.
- `pod-binary-download.test.ts` (fake `fetch`, real temp dir): checksum OK
  (0755, temp left for the caller, commit renames); mismatch, missing entry,
  404, 500, a stream erroring mid-body: each throws and leaves no temp file.
- `pod-binary-build.test.ts`: release mode with a matching marker returns the
  bytes; missing, stale, unknown-version each throw the `tentacle update` error
  and never build; dev mode is unchanged (existing tests); `checkPodBinaries`.
- `pod-runtime.test.ts`: `run` with a missing / stale binary throws and
  `kube.calls` is empty (no `create:`); a matching binary is injected;
  `attach` with a pod that has tentacle is unaffected by a missing binary.

## Execution

*— claude-opus-5-5, 2026-10-22*

In order:

1. **Repro** (Context) run before any edit: a marker-less binary in
   `<configDir>/bin` was injected; no marker existed in the build.
2. **Marker.** `packages/cli/src/version.ts` (new): `MARKER_PREFIX` `:13`,
   `formatVersionMarker` `:20`, `parseVersionMarker` `:28`, `APP_VERSION` `:40`
   (derived from the `process.env.TENTACLE_VERSION_MARKER` define).
   `pod-binary-build.ts`: `buildBinary`'s define now injects the marker
   (replaces the `TENTACLE_APP_VERSION` define; nothing else referenced it), and
   `cliVersion()` `:144` is the single read of `packages/cli/package.json`.
   `main.ts:54` imports `APP_VERSION`; `--version` at `:200` is unchanged.
3. **Scanner.** `packages/cli/src/version-marker.ts` (new): `findVersionMarker`
   `:51`, `readBinaryVersion` `:84` (16 MiB tail, then a backward scan in 8 MiB
   chunks overlapping by `MAX_MARKER_BYTES`).
   **Load-bearing assumption proven** on a real `bun-linux-x64` compile
   (93,636,576 bytes): three occurrences of the prefix, ~355 KB from the end;
   only one is well-formed (`TENTACLE_VERSION_MARKER:0.1.0-beta.1:END`); the
   other two are the scanner/format code (`…:${e}:END`, `…:")||!e…`) and are
   rejected by the grammar. `readBinaryVersion` returned `0.1.0-beta.1` in 6 ms.
   A host `bun-darwin-arm64` build, re-signed with `codesign`, runs
   (`tentacle 0.1.0-beta.1`) and its marker reads the same.
4. **Build check.** `scripts/build.ts:46-58`: after the build and the macOS
   re-sign, read the marker and exit 1 unless it equals `cliVersion()`. CI's
   `bun run compile` therefore checks all four release targets. Mutation
   (define `"9.9.9"`): `error: …/dist/tentacle carries version marker 9.9.9,
   expected 0.1.0-beta.1`, exit 1. A real host-target compile also runs in
   `bun test` (`pod-binary-build.test.ts`, "version marker in a real compiled
   binary"; ~0.15 s here, so no opt-in gate was needed).
5. **Offline `run`/`attach`.** `pod-binary-build.ts`: `PodBinaryError` `:185`,
   `POD_BINARY_TARGETS` `:190`, `podBinaryProblem` `:196`, `checkPodBinaries`
   `:225`; `resolvePodBinary` `:253` gains a release branch (after
   `TENTACLE_POD_BIN`, before the dev-only path, which is unchanged).
   `pod-runtime.ts:281` calls `checkPodBinaries` before `createPod`;
   `appVersion` seam on both deps types, passed at `:317` / `:508`.
6. **Download helper.** `packages/cli/src/pod-binary-download.ts` (new):
   `releaseAssetUrl` `:32`, `parseSha256Sums` `:40`, `fetchSha256Sums` `:65`,
   `downloadVerifiedAsset` `:97`, `commitDownload` `:154`. Not wired to any
   command (child 2).
7. **README** Install step 2 now says `tentacle update` and that `run`/`attach`
   stop on a missing or mismatched pod binary. **Depends on child 2**
   (`feat/tentacle-update`): the command does not exist until it lands, so this
   branch must not ship alone.

**Tests** (new): `version-marker.test.ts` (10), `pod-binary-download.test.ts`
(9), `pod-binary-build.test.ts` (+8), `pod-runtime.test.ts` (+6). The modules were
written before their tests, so "red first" was shown by **mutation** instead.
Each mutation was applied, the narrow file run, and the code restored:
- chunk overlap removed → the split-boundary test fails;
- tail-only (no fallback) → fallback + split tests fail;
- the `:END` check dropped → the corrupt-marker test fails;
- stop at the first malformed prefix → the "last valid wins" test fails;
- version equality forced true → stale/unknown tests fail (build + runtime);
- release branch disabled → missing/stale/unknown fail;
- `checkPodBinaries` call removed from `startPodRuntime` → the 3 "fails before
  any pod is created" tests fail (`kube.calls` not empty);
- temp `rm` removed → the mismatch and mid-body-drop tests fail;
- checksum compare / `chmod` / the SHA256SUMS-entry guard each removed → their
  test fails;
- marker define `"9.9.9"` → the real-compile test fails.

**Gate:** `bun run check`: typecheck clean, Biome `Checked 380 files … No fixes
applied` (0 errors, 0 warnings), `1892 pass · 2 skip · 0 fail` (the two opt-in
skips).

**Drift from Implementation / decisions taken:**
- `run` requires **both** Linux pod binaries before creating the pod, because
  the pod's arch is unknown until it exists (`pod-binary.ts:140`). This follows
  D1/D8 (`update` always installs both; no `--no-pods`).
- In a release build, the repo cache and build-from-source are no longer
  fallbacks. So a compiled binary run from the repo (`./dist/tentacle run`) now
  needs matching binaries in `<configDir>/bin`, or `TENTACLE_POD_BIN`.
  `TENTACLE_POD_BIN` is kept as the explicit escape hatch, unchecked.
- Side effect: `dist/tentacle` (gitignored) was rebuilt by `bun run compile`
  during verification; it is the host build at `0.1.0-beta.1`.

**Unverified:** a real download from GitHub (the helper has only been run
against a fake `fetch`). Child 2 should verify it end to end against a real
release.

## Review

*— claude-opus-5-5, 2026-10-22* — same model family as the executor, in a
fresh context. Blind spots we share can get past both passes.

**Verdict: APPROVE-WITH-NITS.** Nothing must be fixed before merge. The nits
below are cheap. N3–N5 belong to child 2 (`feat/tentacle-update`), which is the
first code to use the download helper.

**Gate** (re-run): `bun run check`. Typecheck is clean. Biome: `Checked 380
files … No fixes applied` (0 errors, 0 warnings). Tests: **1892 pass · 2 skip ·
0 fail** (1894 tests, 158 files). The 2 skips are the opt-in ones. No
`session-reaper` flake.

**Premise table**

| Premise | Verdict |
|---|---|
| Symptom: on `main`, a marker-less `<configDir>/bin` binary is injected | TRUE. `main:pod-binary-build.ts` returns `configBinPath` whenever it exists, with no version check |
| The version reaches the build only as a `define`, which `main.ts:67` reads (on `main`) | TRUE (`TENTACLE_APP_VERSION`) |
| `run` creates the pod before the arch is known (`pod-binary.ts:140` probes, `:143` resolves) | TRUE |
| `injectAgentBinary` resolves before its first write into the pod | TRUE (`pod-binary.ts:143`, then the stream) |
| `attach` resolves only after a failed preflight `tentacle --version` | TRUE (`pod-runtime.ts:484-498`) |
| `SHA256SUMS` is in `sha256sum` format and the names are `tentacle-bun-<os>-<arch>` | TRUE (`build.yml:98`, `mv dist/tentacle-${TARGET}`). The names match `configBinPath` |
| Load-bearing: the marker literal survives `compile+minify` intact | TRUE. In `dist/tentacle` (host target, 73,308,576 B) the prefix appears 3 times, ~663 KB from the end. Only `…:0.1.0-beta.1:END` is well-formed. The other two are `` `…:${e}:END` `` and `"TENTACLE_VERSION_MARKER:"`, and the grammar rejects both. There is a 4th hit, `"process.env.TENTACLE_VERSION_MARKER"` (the bundled `buildBinary` define key), but it has no `:`, so it does not match the prefix. There are no UTF-16 copies. `readBinaryVersion` returns `0.1.0-beta.1`, the same as `dist/tentacle --version` |

**Mutations.** Each test failed under its mutation, and the tree was
byte-identical afterwards (shasum checked):
- M1: drop the chunk/tail overlap. The split-boundary test fails (1).
- M2: remove `checkPodBinaries` from `startPodRuntime`. The 3 "fails before any
  pod is created" tests fail.
- M3: pre-check in `attach` too, which violates D4. The test "attach: a pod
  that already has tentacle never needs the local binary" fails.
- M4: remove the temp `rm`. The mismatch test and the mid-body drop test fail.
- M5: make `podBinaryProblem` always accept. 6 tests fail, in both build and
  runtime.

**Attacks tried**
1. **False marker.** Covered under the load-bearing premise in the table:
   exactly one real match, chosen the same way on every run. Residual risk:
   Bun constant-folds template literals (you can see this in the
   `formatVersionMarker` output). A future literal such as
   `` `${MARKER_PREFIX}0.2.0${MARKER_SUFFIX}` `` placed after the real marker
   would win. `scripts/build.ts` would then fail loudly, unless the folded
   version equals the real one. See N1.
2. **Chunk overlap and grammar bounds.** The overlap is `MAX_MARKER_BYTES - 1`
   (88 B) at both the tail→fallback boundary and between chunks. That is
   sufficient: a marker that starts at `s < boundary` ends at most at
   `boundary - 1 + MAX`. M1 confirms it. A truncated or over-long version (65
   characters or more), or a missing `:END`, is rejected. The charset is the
   same in `version.ts` and the byte scanner.
3. **`APP_VERSION` on every path.** Results:
   - Compiled `--version` prints `0.1.0-beta.1`.
   - From source it prints `dev`.
   - The pod health probe only checks the exit code of the injected binary's
     `--version`, so it is unchanged.
   - Protocol `initialize` uses `PROTOCOL_VERSION`, not `APP_VERSION`, so it is
     unaffected.
   - The worker entrypoint gets the same define.
   - Gap: from source, a `TENTACLE_VERSION_MARKER` environment variable is
     honoured. `TENTACLE_VERSION_MARKER='TENTACLE_VERSION_MARKER:9.9.9:END' bun
     packages/cli/src/main.ts --version` prints `tentacle 9.9.9`, and it also
     switches source-mode `run` onto the release path. See N2.
4. **§7 pod lifecycle.** Results:
   - A failing `run` throws before `phase()` and `createPod`, so `kube.calls`
     is empty (M2).
   - `attach` with tentacle already in the pod never resolves, so it needs no
     local binary (M3, D4).
   - An `attach` that does need to inject throws inside `resolveBinary`, before
     any write, and never deletes the pod.
   - `TENTACLE_POD_BIN` skips both the pre-check and the version check. This is
     consistent, and it is the documented escape hatch.
   - The pre-check exists only in `run`, which always injects.
5. **Drift.** Both are accepted.
   - (a) `run` requires both arches. The arch is not knowable before
     scheduling: images can be multi-arch, the node is unknown, and listing
     `nodes` needs cluster RBAC that a namespaced user usually lacks. D1 has
     `update` always install both, so requiring both costs nothing extra after
     an update. It also keeps "zero cluster calls on failure".
   - (b) There is no repo-cache or source-build fallback in a release build.
     This follows from D1 (exact version, offline). `TENTACLE_POD_BIN` covers
     `./dist/tentacle run` from the repo.
6. **Download helper.** Trace results:
   - `parseSha256Sums` handles CRLF (via `trim`) and `*` correctly.
   - A **duplicate** name silently takes the last entry (N3).
   - A missing `destDir` throws `ENOENT` and leaves nothing behind.
   - A `302` that the injected fetch does not follow is a loud `HTTP 302`.
     Bun's real `fetch` follows redirects by default, and the code also passes
     `redirect: "follow"`. A real GitHub redirect to objects.githubusercontent
     has not been verified (deferred to child 2, as the executor stated).
   - The body is streamed, not buffered. There is no size cap (N4).
   - `commitDownload` is a same-directory `rename`, which is atomic, but the
     file is not `fsync`ed first (N4).
   - On the HTTP-error and `open`-failure paths the body is not cancelled.
     That is a leak only, with no correctness impact.
7. **CI.** Every matrix target runs `bun run compile` → `scripts/build.ts`.
   The marker check runs after the macOS re-sign and exits 1 on a mismatch.
   The release job's tag check is unchanged (`build.yml:80-84`). Tag =
   `package.json` = marker, so release assets are pinned to the tag.

**Findings.** None are must-fix.
- **N1** `scripts/build.ts:50-57`: also assert that there is exactly **one**
  well-formed marker in the output, for example by exporting a
  `findAllVersionMarkers` from `version-marker.ts`. Today a future
  constant-folded marker literal is caught only when its version differs.
- **N2** `packages/cli/src/version.ts:40`: the source mode can be overridden
  from the environment. Fix: define a dedicated global identifier, such as
  `define: { __TENTACLE_VERSION_MARKER__: … }` together with
  `typeof __TENTACLE_VERSION_MARKER__ === "string" ? … : undefined`, instead of
  `process.env.*`. Then only the compiler can set it.
- **N3** `packages/cli/src/pod-binary-download.ts:45-48`: when one name appears
  with two **different** digests, throw instead of keeping the last one.
- **N4** (child 2) `pod-binary-download.ts`:
  - Before `close`, call `await file.sync()`. A crash after `rename` could
    otherwise leave a truncated binary, which matters most for the CLI itself.
  - Optionally add a size cap, for example 512 MiB.
  - In the catch block, `response.body?.cancel()` on the HTTP-error and
    `open`-failure paths.
- **N5** (process): the README now points at `tentacle update`, and a release
  build refuses today's marker-less binaries. Do not tag a release from `main`
  between this merge and `feat/tentacle-update` (D8 already ships them
  together).

**What holds:**
- D1 (offline, both arches, "run `tentacle update`").
- D2 (marker read from the end, file read-only, build check on all 4 targets,
  marker-less = unknown).
- D3 (SHA-256 against the same release's `SHA256SUMS`).
- D4 (`attach` reuse untouched).
- §7 pod lifecycle (`run` makes no cluster call on failure, `attach` never
  creates or deletes).
- Dev mode is unchanged.

**Executor behaviour:**
- The plan was source-verified, and the citations checked out.
- Drift was declared honestly, along with the rebuilt `dist/tentacle`.
- It was candid about writing tests after the code and made up for it with
  real mutations. I reproduced 5 of them.
- The unverified part (a real GitHub download) is stated clearly.
