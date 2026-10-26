# fix/musl-image-detect — Detect musl / shell-less images with a clear error

> **Status:** done
> **Branch:** `fix/musl-image-detect`
> **Size:** S · **Blast:** contained · **Suited:** a weaker model may execute (one module + 2 call sites in one package, no wire/persistence/§7 change); standard in-context Review

## Context

*— claude-sonnet-5-5, 2026-10-26*

**Problem.** The injected `tentacle` is a glibc binary (`pod-binary.ts:107`). On
an Alpine/busybox-musl image the ELF interpreter (`/lib64/ld-linux-x86-64.so.2`,
`/lib/ld-linux-aarch64.so.1`) is absent, so the kernel/runtime reports a bare
`no such file or directory` for a file that *does* exist. The user gets an
obscure error, and only AFTER a 60–90 MB transfer. `libcMismatchHint`
(`pod-binary.ts:113-117`) matches only the dynamic-loader texts
(`error while loading shared libraries|cannot open shared object file`), not this
one. Found by the docker-runtime planner.

**Evidence (real strings; `docs/eval/docker-runtime.md:174-188`, Docker engine,
2026-10-26):**
- `alpine:3` + glibc binary → `--version` → exit 255, `exec …: no such file or directory`.
- `busybox:latest` + glibc binary (glibc busybox, no `libdl`) → exit 127,
  `error while loading shared libraries: libdl.so.2 …` (already hinted).
- musl binary on `alpine:3` → `Error loading shared library libstdc++.so.6`
  (musl support stays OUT of scope: the `bun-linux-*-musl` target exists — the
  comment at `pod-binary.ts:107` is stale — but needs `libstdc++`, absent in `alpine:3`).

**What the user sees now (k8s), from the code.** `injectAgentBinary` throws
`[pod <name>] tentacle --version failed (exit <n>): <detail><hint?>`
(`pod-binary.ts:205-211`), `detail = stderr.trim() || status || "no output"`.
On k8s a runtime-level exec failure arrives on the status channel, not stderr
(`exec-run.ts:70-103`: `Failure` → `exitCode 1`, `message` = first cause, else
top-level message; `stderr` stays empty), so `detail` is the runtime's message
(roughly `…unable to start container process: exec: "/usr/local/bin/tentacle": no such file or directory`
— **exact k8s text unverified**, I have no cluster; Docker text above is the
only recorded sample). **Second bug in the same line:** the hint is computed
from `version.stderr` only (`pod-binary.ts:209`), so even a matching text that
arrives via `status` never gets the hint. The shell-less (distroless) case is
worse: the arch probe silently falls back to x64 (`pod-binary.ts:61-76`), the
transfer runs `sh -c …` (`:173-177`) and fails with `failed to inject tentacle
(exit 1): <runtime's "sh: executable file not found" status JSON>` (`:190-196`).

**Owner decisions (2026-10-26, `docs/eval/docker-runtime.md` "Owner answers" 5):**
detect musl and fail with "this image uses musl (Alpine): use a glibc-based
image" (keep the existing hint's examples); serves k8s now and Docker later (one
shared function); prefer POSITIVE detection over error-text parsing; an image
without `sh` must also fail clearly; fix the stale comment.

**Repro (red, written in Implementation → Tests).** There is no cluster here;
the repro is the unit test with `FakeKube` scripted to the Alpine probe output
(`/lib/ld-musl-x86_64.so.1` present, no glibc loader) — today it throws
nothing at probe time and proceeds to transfer.

## Implementation

*— claude-sonnet-5-5, 2026-10-26*

### Load-bearing assumption

`injectAgentBinary` is the ONLY place the binary gets into a pod and both
entry points (`run` `pod-runtime.ts:360`, `attach` `pod-runtime.ts:559`) call it
with a `podArch` seam built on `probePodArch` (`:365`, `:564`); the Docker
runtime will reuse it verbatim over its own `runExec` (`docker-runtime.md:45`,
"Generic — written entirely against `PodCluster.runExec`"). So one probe + one
classifier in `pod-binary.ts` covers k8s and Docker. Also assumed: a probe that
is *inconclusive* must never block (the current philosophy, `pod-binary.ts:48,58`
"never abort on the probe") — only a POSITIVE finding throws.

### Preconditions

- `runExec(target, input?, options?)` returns `{exitCode, stdout, stderr, status?}`
  and rejects on timeout/close (`exec-run.ts:50-56,121-122`); the exec `command`
  is an argv with no shell (`pod-binary.ts:151`) — hence `sh -c`.
- The install step itself already requires `sh` + `head` (`pod-binary.ts:173-177`;
  documented `packages/k8s/src/pod.ts:7-10`), so using `sh -c` in the probe adds
  no new image requirement.
- The glibc binary's interpreter is fixed per target: x64 →
  `/lib64/ld-linux-x86-64.so.2`, arm64 → `/lib/ld-linux-aarch64.so.1`
  (standard for Bun's glibc builds; **executor must confirm with
  `readelf -l`/`file` on a built binary** — one command — before hard-coding).
- Fakes: `FakeKube` + `ok()/fail()` + `depsFor()` (`pod-binary.test.ts:35-97`);
  `pod-runtime.test.ts:129-144` fakes `uname` and otherwise answers
  `exitCode 0, stdout ""` — an inconclusive probe, which must still pass (below).
- No §7 invariant touched (no protocol, persistence, broker, terminal write, or
  pod-lifecycle change; errors throw into the existing `catch` that deletes the pod).

### Design

**Positive probe, folded into the arch probe (zero extra round-trip on the happy
path).** Today the arch probe is one exec (`uname -m`). Replace it with ONE
`sh -c` exec that prints the arch and the two loader facts:

```
sh -c 'uname -m; for f in /lib/ld-musl-*; do [ -e "$f" ] && echo "musl $f"; done; for f in /lib64/ld-linux-x86-64.so.2 /lib/ld-linux-aarch64.so.1; do [ -e "$f" ] && echo "glibc $f"; done'
```

Same round-trip count as now, so no cost on the happy path (a glibc image prints
`x86_64` + `glibc /lib64/…`). New pure, exported, React-free pieces in
`pod-binary.ts`:

- `parseProbe(raw): { arch: PodArch; musl: boolean; glibcLoaders: string[] }`
  (reuses `mapUnameOutput` for line 1; unknown lines ignored).
- `classifyImage(arch, parsed)`: returns `"ok"` when the *target arch's*
  interpreter is present OR the probe is inconclusive (empty/no marker lines —
  e.g. the old fakes, or a probe that failed) ; `"musl"` when musl loader present
  and the arch's glibc interpreter absent; `"no-glibc"` when the shell worked
  (arch line present) but neither loader exists (scratch/static-only).
- `PodProbe = { arch, status: "ok"|"musl"|"no-glibc"|"no-shell"|"unknown" }`.
  `probePodArch` is **replaced** by `probePod(kube, podName, container?)`
  returning `PodProbe`; never throws (an exec throw/timeout → `unknown`, arch x64
  as today). `PodBinaryDeps.podArch` becomes `probe: () => Promise<PodProbe>`
  (pre-public, no compat shim — AGENTS §7).
- **No shell** = positive-by-exclusion without text parsing: if the `sh -c`
  probe returns non-zero or rejects, retry nothing; set `status: "unknown"` and
  remember `probeFailed`. If the install `sh -c` then fails too, the install
  error is wrapped with the clear hint "this image has no shell (`sh`) —
  distroless/scratch images are unsupported; use an image with `sh` and `head`".
  Rationale: the first positive signal that `sh` is missing is `sh -c` failing
  in the probe AND in the install; both are our own execs, not guessed strings.
  (A bare non-zero probe with a working `sh` is exotic — e.g. no `uname`: then
  `uname` failing inside `sh -c` still yields exit of the last command; the
  script's final loop makes exit 0 whenever `sh` ran, since `for` returns 0 when
  its last `[ -e ]` is a skipped `&&` list — **executor: add a trailing `true`**
  to guarantee it.)

**Where it throws.** In `injectAgentBinary`, right after the probe and BEFORE
`resolveBinary`/transfer (saves the 60–90 MB transfer on a doomed image):
- `musl` → `Error("[pod X] this image uses musl (Alpine): use a glibc-based image (e.g. UBI9, Debian, RHEL) — tentacle is a glibc binary")`
  (message text kept shared via one exported constant used by the hint too).
- `no-glibc` → `Error("[pod X] this image has no glibc loader (<interp> not found): use a glibc-based image (e.g. UBI9, Debian, RHEL)")`.
- `no-shell` → as above, raised from the install-failure path.
- `unknown`/`ok` → proceed exactly as today.

**Safety net kept, fixed.** Keep `libcMismatchHint` for images the probe cannot
classify. Two corrections: (1) call it with `detail` (stderr OR status), not
`version.stderr` only (`pod-binary.ts:206-209`) — on k8s the text is in
`status`; (2) additionally match `no such file or directory` ONLY in the
`--version` failure path, where the file was written one step earlier, so
"no such file" can only mean a missing interpreter (the real Alpine/Docker
string, `docker-runtime.md:179-186`). The matched k8s string stays
unverified (see Context) — which is exactly why detection is positive-first
and text matching is only the fallback. Update its doc comment: drop "Bun has no
static or musl build" (`pod-binary.ts:107`) → "the `bun-linux-*-musl` target
exists but needs `libstdc++`/`libgcc` (absent in `alpine:3`); musl images stay
unsupported".

**Why not text-only / why not a second probe.** Parsing the Alpine failure text
(a) is runtime-specific (runc vs containerd vs CRI-O vs Docker phrase it
differently; k8s's wording is unrecorded) and (b) fires only after the
transfer. A second dedicated exec would cost one more k8s WebSocket handshake
per `run`/`attach`-inject for no gain over folding into the existing probe.

**Docs touched in passing:** `pod.ts:9`, `main.ts:160`, `main.ts` help text
(~:160) already say "musl images cannot run it" — still true; no edit.

### Files

1. `packages/cli/src/pod-binary.ts` — `parseProbe`, `classifyImage`, `probePod`
   (replaces `probePodArch`), `PodBinaryDeps.probe`, throw points, `hint` fixes,
   stale-comment fix; header comment step 1.
2. `packages/cli/src/pod-runtime.ts:365,564` — `podArch: () => probePodArch(…)`
   → `probe: () => probePod(…)`; import at `:50`.
3. `packages/cli/test/pod-binary.test.ts` — see Tests (rename `podArch` in
   `depsFor`).
4. `packages/cli/test/pod-runtime.test.ts` — only if the inconclusive-probe path
   needs it (expected: **no change**, the existing fake answers `stdout ""`).

### Failure modes

- **Probe exec throws / times out / non-zero** → `unknown`, x64, proceed (as
  today); if install then fails, the no-shell hint wraps it. Converges: pod is
  deleted by the caller's `catch`.
- **Inconclusive output** (empty, or old `uname`-only fake) → `ok`; no false
  positives. The classifier throws only on a positive musl / no-loader reading.
- **glibc image with musl compat installed** (`/lib/ld-musl-*` AND the glibc
  interpreter) → `ok` (interpreter present wins). Tested.
- **Wrong arch reading** → we check the loader of the arch we will inject;
  `uname` unknown → x64 as today, the `--version` fallback still catches it.
- **Interpreter path differs on an exotic glibc distro** (e.g. NixOS-style) →
  `no-glibc` false positive. Mitigation: only throw `no-glibc` when NEITHER
  loader path exists AND the shell answered; documented limitation (NixOS
  images are not a supported target today).
- **Hint false positive** (`no such file` in the `--version` path for another
  reason) — only reachable after a successful install of that exact path;
  accepted.
- **Doc/message drift** between k8s and Docker: one constant, one function.

### Tests

All in `pod-binary.test.ts`, red first (§9) on current `main` (they fail to
compile/assert there: `probePod`/`classifyImage` absent, `injectAgentBinary`
proceeds to transfer), then green:

1. `parseProbe`/`classifyImage` table: x64 glibc → ok; arm64 glibc → ok; musl only
   → musl; musl + glibc interpreter → ok; shell worked but no loader →
   no-glibc; empty/garbage → ok (inconclusive); x64 box with only the
   *arm64* interpreter → not ok (checks the property: the arch's own loader).
2. `probePod` with `FakeKube`: scripted Alpine output → `musl`; scripted
   exec throw → `unknown`, never rejects; asserts the single `sh -c` argv.
3. `injectAgentBinary` on musl: `FakeKube([ok(alpineProbe)])` through the real
   `probePod` seam → rejects `/uses musl \(Alpine\): use a glibc-based image/` and
   `kube.calls` has **only the probe** (no transfer, `resolveBinary` spy never
   called) — pins "fail before the 60 MB transfer".
4. No shell: probe `fail(...)` then install `fail(...)` → rejects
   `/no shell/`, 2 calls.
5. `--version` fallback: status-only failure (stderr `""`,
   `status` = Alpine-style `exec …: no such file or directory`) → message ends
   with the glibc hint (pins the stderr→detail fix; red today).
6. Existing `libcMismatchHint` tests stay green; add `no such file or directory`
   cases and the unchanged `Exec format error` / `sh: tentacle: not found` →
   still `undefined` in the *probe-free* hint (hint keeps its narrow matcher;
   the broader match lives at the `--version` call site).
7. Non-vacuity by mutation (§9): make `classifyImage` always return `ok` →
   tests 1, 3 fail; revert the `detail` change → test 5 fails.
8. Happy path unchanged: the existing sequence test still asserts exactly 2 calls
   after the probe (probe is the injected seam there).

**Validation:** `bun test packages/cli/test/pod-binary.test.ts` and
`pod-runtime.test.ts` per slice, then `bun test`, `bun run typecheck`,
`bun run lint` (baseline clean). Unverified: a real k8s cluster run on
`alpine:3` and a distroless image (no cluster access in the planner); Docker
sample is from the eval's recorded probes. Executor: one live check on
`alpine:3` if a cluster is available.

**Sizing, honestly:** S · contained. One module + two one-line call sites + tests,
no wire/persistence/invariant change, behaviour pinned by its own tests.
Slightly above the "≲50 lines" S guide in test volume; code is ~60 lines.

### Owner question

Is `no-glibc` (shell present, no loader at all, e.g. scratch+busybox-static) worth
its own message, or fold into the musl message? Plan assumes its own, one line.

### Approval

*— orchestrator (claude-opus-5-5), 2026-10-26*

APPROVED (S · contained: the orchestrator approves under the owner's standing
rule). Question answered: "shell present but no loader" (scratch + static
busybox) gets its OWN message — the accurate one.

## Execution

*— claude-sonnet-5-5, 2026-10-26*

**Baseline (before any edit):** `bun run check` green — 2883 pass / 2 skip / 0 fail, lint clean.

**Repro.** No cluster available; the repro is the red unit tests (below). On
current code `injectAgentBinary` has no libc probe: with a musl image it goes on
to resolve + transfer the binary.

**PT_INTERP confirmed.** Built `bun build --compile --target=bun-linux-x64|arm64`
of a one-line script into `.tentacle/tmp/musl-image-detect/elf/` (no `readelf`/`file`
on macOS), parsed the ELF program header with a 15-line Bun script:
`h-x64 PT_INTERP = /lib64/ld-linux-x86-64.so.2`,
`h-arm64 PT_INTERP = /lib/ld-linux-aarch64.so.1` — matches the Implementation.

**As built (in order):**
1. Tests first (`pod-binary.test.ts`): `depsFor` now scripts `probe` (replaces
   `podArch`); `probePodArch` block replaced by `parseProbe/classifyImage` and
   `probePod` blocks; new `injectAgentBinary` cases (musl / no-glibc fail before
   any exec or `resolveBinary`; no-shell; inconclusive proceeds; status-only
   `--version` failure gets the hint; `Exec format error` gets none).
2. **Red:** with assertion-less stubs for the new exports (never detect
   anything) and a temporary `podArch` in `depsFor` so the old flow ran:
   13 fail / 18 pass, the failures on the asserted properties (musl/no-glibc
   classification, probe argv, "fails before resolve", no-shell hint, status
   hint). (Before the stubs the file failed at import — red by absence.) Temp
   lines removed.
3. **Green:** `pod-binary.ts` — `GLIBC_INTERPRETER`, `PROBE_SCRIPT`, `parseProbe`,
   `classifyImage`, `probePod` (replaces `probePodArch`), `PodProbe`,
   `PodBinaryDeps.probe`, `unsupportedImageError`, early throw before resolve,
   no-shell wrap on install failure, `--version` hint now computed from `detail`
   (stderr OR status) + a `no such file or directory` fallback at that site,
   stale comment (`:107`) fixed, header step 1 updated. `pod-runtime.ts`: two
   call sites + import (`probe: () => probePod(…)`).
4. `pod-runtime.test.ts`: its fake answers the new probe (`sh -c echo
   tentacle-probe…`) with glibc x64 output; two assertions that named
   `uname -m` now match the probe command; the `readOnly` helper (fails every
   `sh`) exempts the probe.

**Mutations (each reverted; `shasum` of `pod-binary.ts`, both tests and
`pod-runtime.ts` byte-identical to pre-mutation):**
- `classifyImage` never returns musl/no-glibc → 4 fail (musl, no-glibc,
  arch-loader, `probePod` Alpine).
- + remove the early `throw unsupported` → 6 fail (adds the two "fails before
  resolve" tests).
- hint computed from `version.stderr` only → 1 fail (the status-only test).
- Not mutated: the no-shell wrap (covered by its test, not mutation-proven).

**Drift from Implementation (and why):**
- Probe output starts with a sentinel line `tentacle-probe` (not just the arch
  line): "the shell ran" is then positive; without it an image lacking `uname`
  would read as inconclusive instead of `no-glibc`.
- `PodProbe.status` has `probe-failed` (exec non-zero/throw) and `unknown`
  (no sentinel) instead of the planned `no-shell`; no-shell is raised from the
  install failure when `probe-failed`, as designed.
- Script ends with `true` (planned).
- `readOnly` fake in `pod-runtime.test.ts` exempted the probe: without that the
  attach "read-only dir" test got the no-shell hint (its fake failed every `sh`,
  an artefact — a real read-only image answers the probe). Real-world false
  positive remains possible only if the probe fails for another reason AND the
  install fails (the hint says "may have no shell").

**Unverified:** a live run on `alpine:3` / a distroless image in k8s or Docker
(no cluster); exact k8s text for a missing interpreter (the fallback matches the
Docker-recorded `no such file or directory`).

**Gate (end):** `bun run check` — typecheck ok, biome clean (0 errors/warnings),
`2895 pass / 2 skip / 0 fail` (+12 tests vs baseline).

### Live check (orchestrator, 2026-10-26)

*— claude-opus-5-5 (orchestrator), 2026-10-26*

The executor had no cluster; the orchestrator ran the real `PROBE_SCRIPT`
(extracted from `pod-binary.ts`) in local Docker containers (arm64 Docker
Desktop) and fed the output to `parseProbe` + `classifyImage`:

```
alpine:3              tentacle-probe / aarch64 / musl /lib/ld-musl-aarch64.so.1   → {"arch":"arm64","status":"musl"}
debian:bookworm-slim  tentacle-probe / aarch64 / glibc /lib/ld-linux-aarch64.so.1 → {"arch":"arm64","status":"ok"}
busybox:latest        tentacle-probe / aarch64 / glibc /lib/ld-linux-aarch64.so.1 (glibc variant)
```

Containers labelled `tentacle.test=musl-verify`, all removed (`--rm`; filter empty).

## Review

*— claude-opus-5-5, 2026-10-26* (fresh context; a different model from the
executor claude-sonnet-5-5, but the same model as the orchestrator that
approved the plan and ran the live check, so blind spots shared with the
approval can survive this pass.)

**Verdict: APPROVE-WITH-NITS.** It is correct, the change is contained, and the
tests are non-vacuous. Nothing here blocks the merge.

**Gate (re-run in the worktree):** `bun run check`: typecheck ok, biome clean,
**2895 pass / 2 skip / 0 fail** (2897 tests / 222 files). This matches Execution.

**Mutations (reviewer's own, each reverted; `shasum -c` OK on all 4 touched files):**
- M1: the no-shell wrap was disabled (`probe.status === "probe-failed"` set to
  never-true). Result: **1 fail** ("no shell … → a clear no-shell error").
  Execution had not mutation-proven this one. It is proven now.
- M2: `classifyImage` was changed to accept *any* glibc loader instead of the
  loader for the target arch. Result: **1 fail** ("x64 box with only the arm64
  interpreter"). The arch-specific property is pinned.

**Findings**
1. *Nit, message:* `pod-binary.ts:190` and `:195` give the advice twice.
   The output reads "…use a glibc-based image (e.g. UBI9, Debian, RHEL) —
   tentacle is a glibc binary, use a glibc-based image (e.g. UBI9, Debian,
   RHEL)". The owner's wording "this image uses musl (Alpine): use a glibc-based
   image" is there, but the example list is repeated. Suggested text:
   `this image uses musl (Alpine): use a glibc-based image (e.g. UBI9, Debian,
   RHEL) — tentacle is a glibc binary`.
2. *Minor, misleading cause (it never refuses an image that would work):* when
   `uname` is unmapped (ppc64le, s390x, armv7) or missing, `mapUnameOutput`
   falls back to x64 (`pod-binary.ts:50`, `:85`). With no uname line, `lines[1]`
   holds the first loader line. In that case `classifyImage` returns `no-glibc`
   and the error says "/lib64/ld-linux-x86-64.so.2 not found". The real cause is
   the arch, or an arm64 glibc image without `uname`. The x64 binary could not
   have run there either, so no working setup is refused: the image used to
   fail after the transfer with `Exec format error`, and now it fails earlier
   with the wrong reason. Optional fix: read the arch from the glibc loader that
   was found when the uname line is not recognised, or name the uname reading
   in the `no-glibc` message. (Found by reading the code: my scratch trace in
   `.tentacle/tmp/musl-image-detect-review/t.ts` was not allowed to run in
   this session.)
3. *Nit, duplication:* `pod-binary.ts:303-307` builds the hint text a second
   time instead of reusing `libcMismatchHint`. The wording cannot drift because
   both use `GLIBC_ADVICE`, but the prefix is copied.
4. *Nit, no-shell hint may be wrong:* `:279-282`. If the probe fails for a
   transient reason (exec timeout or network) and the install also fails for a
   different reason (read-only fs, ENOSPC), the error still says "may have no
   shell". It is hedged ("may"), and the raw install error comes first, so this
   is accepted. Execution already notes it.

**Premise table**
| Premise | Verdict |
|---|---|
| Symptom: no libc check today, musl image → transfer, then an obscure error (main `pod-binary.ts` probe = `uname -m` only) | TRUE (diff `-` side) |
| `:107` comment "Bun has no static or musl build" is stale | TRUE, fixed |
| hint computed from `version.stderr` only | TRUE (old `:209`), fixed to use `detail` |
| k8s exec Failure → `exitCode 1`, message in `status` (`exec-run.ts:96-101`) | TRUE, so missing `sh` gives `probe-failed` (non-zero), not a throw |
| PT_INTERP x64 `/lib64/ld-linux-x86-64.so.2`, arm64 `/lib/ld-linux-aarch64.so.1` | taken from Execution's ELF parse, consistent with the glibc ABI; not re-run |
| Two call sites `pod-runtime.ts:365,564` + import `:50` | TRUE, the `pod-runtime.ts` diff is exactly these 3 lines |

**Attacks tried**
- *glibc images refused by mistake.* Merged-usr (Fedora/UBI `/lib64 →
  usr/lib64`, Debian `/lib64/ld-linux-x86-64.so.2` symlink): `[ -e ]` follows
  symlinks, so they are `ok`. Ubuntu/Debian arm64 have
  `/lib/ld-linux-aarch64.so.1`, so `ok` (also seen in the live check).
  Alpine+gcompat ships the glibc interpreter path, so it is `ok` (interpreter
  present wins) and any later failure falls to the `--version` hint. No refusal.
  NixOS-style images (no `/lib64` loader): the kernel cannot exec a binary
  whose PT_INTERP is missing, so refusing it is **correct**, not the false
  positive the plan feared. Arch mismatch: only the cause text is wrong
  (finding 2).
- *`unknown`/`probe-failed` never block.* `unsupportedImageError` throws only for
  `musl`/`no-glibc` (`:187-199`). The script ends with `true`, so a working `sh`
  always exits 0. A missing sentinel or a banner before it gives `unknown`, which
  goes ahead. An image with `uname` but no `sh` could never install anyway
  (install is `sh -c … head`), so there is no regression from the old `uname -m`
  probe. One small loss: with `unknown` the arch is not read from line 2, so it
  falls back to x64. This only happens on garbled output, so it is accepted.
- *No-shell message.* It only fires when the probe failed AND the install failed.
  It is worded "may have no shell" and comes after the raw error, so it never
  states "no shell" as fact (finding 4).
- *Happy path cost.* One `sh -c` exec replaces one `uname` exec, so there is no
  extra round-trip. The attach/run order tests assert the probe sits at the same
  index as before.
- *`readOnly` fake (`pod-runtime.test.ts:1068-1071`).* The exemption is
  justified. The fake failed *every* `sh` exec, which no real read-only image
  does (the probe only reads). Without it the test would assert an artefact.
- *§7.* No protocol, persistence, broker, terminal-write or pod-lifecycle
  change. The throws land in the existing caller `catch`, which deletes the pod.
  Contained, as sized.

**What holds:** the detection is based on the paths the binary's PT_INTERP
needs, checked for the target arch. It fails before `resolveBinary` (the test
asserts no transfer happens). The `detail` fix covers k8s, where the text
arrives via `status`. One shared function is ready for Docker.

**Executor behaviour:** disciplined. It confirmed PT_INTERP empirically before
hard-coding, showed red before green, and mutation-proved three properties. It
reported its drift honestly (the sentinel, `probe-failed` instead of
`no-shell`, the `readOnly` fake) and flagged the one property it had not
mutation-proven (closed here by M1). No scope creep.

### Review fixes (owner: "ok", no further review round)

*— claude-opus-5-5 (orchestrator), 2026-10-26*

- Finding 2: an arch we build no binary for (`uname -m` ∉ x86_64/amd64/aarch64/arm64)
  → new status `unsupported-arch` + `machine`, message "unsupported architecture:
  <machine> (tentacle ships linux x64 and arm64 builds)", before the transfer;
  a probe that ran but printed no `uname` → `unknown` (never blocks).
- Findings 1 and 3: the musl / no-glibc messages give the advice once; the
  post-transfer loader hint is one constant (`LIBC_HINT`).
- Finding 4 (the hedged "may have no shell"): accepted as is.
- Tests (red first, 4 → green): ppc64le → `unsupported-arch`; empty uname →
  `unknown`; musl message advice once; s390x fails before the transfer.
  Mutation: the `KNOWN_MACHINES` check disabled → the ppc64le test red;
  restored byte-identical (`shasum`).
