# fix/inject-bin-dir-probe — pick a writable+exec install dir in ONE probe, before any upload

> **Status:** implementation APPROVED (owner 2026-11-20: Owner questions 1–5 all as recommended)
> **Branch:** `fix/inject-bin-dir-probe`
> **Size:** M · **Blast:** load-bearing (pod lifecycle / injection, AGENTS §7 "Pod/container lifecycle") · **Suited:** Opus executes, mandatory fresh-context Review
> **Changelog:** `changelog.d/inject-bin-dir-probe.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-19*

`run` and `attach` install the injected binary at `${binDir ?? "/usr/local/bin"}/tentacle`
(`packages/cli/src/engine-runtime.ts:479` for `run`, `:901` for `attach`). A pod that runs
as non-root — OpenShift's default random UID — cannot write `/usr/local/bin`, so the 60–90 MB
upload starts, `mkdir -p … && head -c N > /usr/local/bin/tentacle.new` exits non-zero
(`pod-binary.ts:315`, `:342-343`), and the run fails. Today the user must know to pass
`--bin-dir` / `TENTACLE_POD_BIN_DIR` (`main.ts:1521`, `:1984`, `:2041`; help `main.ts:495`,
`:506-507`). A read-only rootfs or a `noexec` `/tmp` fails the same way, and only AFTER the
upload (`--version` at `pod-binary.ts:362-377`).

Owner's request (2026-11-19, `TODO.md` row `fix/inject-bin-dir-probe`):

- Choose the dir automatically, in this order: `/usr/local/bin` → `$HOME/.local/bin` → a
  private `/tmp/tentacle-<uid>/`. An explicit `--bin-dir` (or `TENTACLE_POD_BIN_DIR`) still wins.
- **Hard requirement:** prove that every candidate can be written to AND executed from, in
  ONE cheap probe, BEFORE any upload. Never upload, fail, then upload again.
- Reuse a binary that already matches, in ANY candidate dir.

Today's code does not meet any of these: there is no write/exec check. The arch/libc probe
(`probePod`, `pod-binary.ts:148-171`) knows nothing about the install dir. `attach`
checks for a binary already in the pod at ONE path, then at `tentacle` on PATH
(`engine-runtime.ts:931-938`). `run` never reuses anything: it always injects
(`engine-runtime.ts:600`).

**Repro:** none run yet. There is no cluster in this context, and the container engine
could not be reached without approval. The executor runs this first, from
`.tentacle/tmp/inject-bin-dir-probe/`, and pastes the command and its output here:
`tentacle run --engine docker --image registry.access.redhat.com/ubi9/ubi --user 12345:0`
(a non-root UID with no passwd entry, like OpenShift). If `--user` cannot be passed to
`run`, use a UBI image whose `USER` is non-root, e.g. `ubi9/ubi-minimal` built `FROM …`
with `USER 1001`. Expected on `main`: `failed to inject tentacle (exit 1): … Permission denied`,
reported only after the transfer bar has run. A second repro covers `--bin-dir /tmp` on a
container started with `--tmpfs /tmp:noexec`. Expected: the upload completes, then
`tentacle --version failed … Permission denied`.

## Implementation

*— claude-opus-5-5, 2026-11-19*

### Load-bearing assumption

**One `sh -c` exec can prove that a dir is both writable and exec-able, without the real binary:**
write a 2-line `#!/bin/sh` script into the dir, `chmod 700` it, then execute it **directly**
(`"$f"`, not `sh "$f"`). On a `noexec` mount, `execve` returns `EACCES` for a script too:
the kernel checks the script file's own mount before it looks at the interpreter. On a
read-only fs or an unwritable dir, the redirect fails. **NOT yet verified here.** The
cheap decisive test is the executor's first step: in
`docker run --rm --tmpfs /tmp:noexec --read-only --user 12345 ubi9/ubi sh -c '<probe script>'`,
the result must be `no /usr/local/bin`, `no /tmp/...` and `ok` for nothing (or for `$HOME`
if that is writable). If a direct script exec ever succeeds where an ELF exec would fail
(an SELinux/LSM policy that treats them differently), the post-upload `--version`
(`pod-binary.ts:362-377`) still fails with a clear error. That error is final: the
owner's no-re-upload rule holds, and the gap is reported, not hidden.

### Preconditions (verified)

- Every pod command is a one-shot `host.runExec({name, container, command}, stdin?, {timeoutMs})`.
  The probe already uses `["sh","-c",PROBE_SCRIPT]` (`pod-binary.ts:155-159`), so a richer
  script costs no extra round-trip.
- The install stages `<binPath>.new` and then renames it over the old binary
  (`pod-binary.ts:309-318`). With `beforeCommit`, a resident is stopped only after
  the bytes are staged (`:345-358`; `engine-runtime.ts:979-1002`). That ordering stays.
- In `attach`, the decision (`containerDecision`, `engine-runtime.ts:952-955`) uses ONE
  probe result (`EngineRunExecResult`) plus the expected version and build
  (`:908-917`, `:947-951`). It already handles a reused binary outside the install dir
  (`found === "tentacle"` → `installedAt` notice, `:1065`).
- The resident's socket does not depend on the install dir (`pod-resident.ts:64-78`:
  `${TMPDIR:-/tmp}/tentacle-<uid>/resident.sock`, a 0700 dir created by `mkdirSync`
  at `:296`, `:503`). So a binary in any dir reaches the one resident, as the comment
  at `engine-runtime.ts:895-899` already relies on.
- The kept index records `binDir` only when the user gave it (`main.ts:1601`;
  `kept.ts:48-49`). It is read back by `attach <name>` (`main.ts:1984`, `:2041`), the
  detached relay (`relay.ts:369`) and `tentacle logs` (`logs-cmd.ts:772`). `logs` execs the
  bridge **by path** (`podDaemonCommand(binPath)`, `logs-cmd.ts:772-781`) and does no
  version probe.
- The workspace planner refuses a mount that contains the install dir
  (`workspace-mount.ts:696-699`). It is given `binDir ?? "/usr/local/bin"`
  (`main.ts:1551`) and, for a hop, a hard-coded `/usr/local/bin` (`hop-targets.ts:275`).
- AGENTS §7: the pod is not trusted. Nothing here gates a laptop effect, and every
  pod-printed string that reaches the terminal goes through `untrustedText`
  (`engine-runtime.ts:929-930`).

### Design

**One pure module, `packages/cli/src/pod-install-dir.ts`** (React-free, unit-tested; AGENTS §7
"logic lives in pure modules"):

1. `placementScript({ candidates, probeVersion, buildId })` builds ONE POSIX `sh` script
   that prints, line by line, with fixed sentinels:
   - the current `PROBE_SCRIPT` lines (sentinel, `uname -m`, loaders). Reuse the
     constant; do not fork it.
   - for each candidate `d`, in order:
     - `$HOME/.local/bin` is skipped when `$HOME` is empty or `/`.
     - The `/tmp` candidate is skipped when `id -u` is unavailable. Its parent is
       created with `mkdir -m 700`, and it is skipped unless it is owned by us and is not
       a symlink (`[ -O "$p" ] && [ ! -L "$p" ]`).
     - Then `mkdir -p "$d"`, write `"$d/.tentacle-probe.$$"` (`#!/bin/sh` / `exit 0`),
       `chmod 700`, run it directly, and `rm -f` it.
     - The line printed is `cand <i> ok <abs-dir>` or `cand <i> no <step>`, where the step
       is `mkdir|write|exec|home|owner`.
   - for each candidate, if `"$d/tentacle"` is executable: run
     `"$d/tentacle" --version [--build-id]` (the same argv as today, `engine-runtime.ts:923`)
     with output captured. The probe prints `bin <i> <exit>` and then the first 2 output
     lines, each prefixed `|`. After the candidates it does the same for
     `command -v tentacle` (the PATH fallback that exists today, `:936`).
   - `true` at the end, so a failure in one candidate never fails the exec.
2. `parsePlacement(stdout)` returns
   `{ image: PodProbe, dirs: {dir, ok, step?}[], binaries: {path, probe: EngineRunExecResult-like}[] }`.
   Missing or garbled lines count as "not ok". A real shell always prints a line for
   every candidate, so a missing line never means "fine".
3. `choosePlacement(parsed, expected)` is the single decision:
   - **reuse:** the FIRST binary (in candidate order, then PATH) whose version and build
     match, as decided by today's `containerDecision`. If none matches, the decision
     is unchanged (`inject`, or `replace` with `found` = the first binary that answered).
   - **install dir:** the first candidate with `ok`. If there is none, throw ONE error
     before any upload. It lists each candidate and its failed step, and ends
     `— pass --bin-dir <a writable, exec-able dir>`.
   - **explicit `--bin-dir`:** the candidate list is `[binDir]`, with no fallback.
     It is still probed, so a bad `--bin-dir` fails before the upload, not after.

**Wiring.** The probe replaces the exec(s) that ran first:

- `attach` (`engine-runtime.ts:901-955`): the two `versionOf` calls become one placement
  exec, wrapped in the same `host.execError` translation (`:939-943`). `binPath` becomes
  the chosen dir. `found` becomes the matched or first-answering binary's path.
  `injectAgentBinary` gets `probe: () => Promise.resolve(parsed.image)`, so no
  second `uname` exec runs. `residentGuard`, `beforeCommit` and the replace-failed
  fallback (`:972-1058`) keep their behaviour.
- `run` (`engine-runtime.ts:479`, `:600-619`): the placement exec runs right after
  `waitForReady`, then `injectAgentBinary` runs at the chosen dir. A fresh workload
  whose image already ships a matching build is reused, which is new behaviour
  (Owner Q4).
- `injectAgentBinary` (`pod-binary.ts:265`): no logic change. It already takes `binPath`
  and an injected `probe`. Its `mkdir -p` stays harmless.
- **No-shell images** (distroless): when the placement exec fails, as `probePod`
  already detects (`probe-failed`), `attach` falls back to today's two direct
  `--version` execs. A reuse then still works without `sh`. An inject would fail
  anyway (`head` needs `sh`), and it keeps the existing "no shell" message
  (`pod-binary.ts:331-335`).
- `tentacle logs` (`logs-cmd.ts:772`): see Owner Q2. The recommended fix runs the same
  placement script with `probeVersion` set, picks the matching binary (one exec, never an
  upload), and falls back to `entry.binDir ?? /usr/local/bin` when the probe fails.
- The kept index, the relay and the resume hint are unchanged: `attach` re-probes every
  candidate, so it finds an auto-picked dir without a record. `binDir` stays "what the user typed".
- Docker workspace mount: candidates inside the mount target are skipped by the
  probe (the mount target is passed in), so nothing is ever written into the laptop
  folder. The planner keeps its refusal for an explicit `--bin-dir` and for
  `/usr/local/bin` (unchanged, `main.ts:1551`, `hop-targets.ts:275`).
- The help text (`main.ts:495`, `:506-507`) changes from "Read-only rootfs? pass
  --bin-dir" to "the dir is picked automatically; --bin-dir forces one".

### Files (dependency order)

1. `packages/cli/src/pod-install-dir.ts` (new): the script builder, parser and chooser.
2. `packages/cli/src/pod-binary.ts`: export `PROBE_SCRIPT` (or a builder for its lines)
   so it can be reused. No behaviour change.
3. `packages/cli/src/engine-runtime.ts`: `provisionWorkload` (`:479`, `:600`) and
   `attachEngineRuntime` (`:901-1081`). The `binDir` docs at `:239-242` and `:749-750`.
4. `packages/cli/src/logs-cmd.ts:772` (per Owner Q2).
5. `packages/cli/src/main.ts:495`, `:506-507`: the help text.
6. Tests: `packages/cli/test/pod-install-dir.test.ts` (new),
   `packages/cli/test/engine-runtime.test.ts` (the fakes, `:169-190`), and
   `packages/cli/test/pod-binary.test.ts` if `PROBE_SCRIPT` moves.
7. `changelog.d/inject-bin-dir-probe.fixed.md`, plus the `TODO.md` row.

There is no protocol change, no change to the kept schema, and no persistence change.

### Failure modes

| Case | Behaviour / how it converges |
|---|---|
| No candidate passes write+exec | One error before the upload, listing `dir: step` for each candidate, plus the `--bin-dir` advice. A `run` workload is then handled by the existing `removeUnlessKept` path (`engine-runtime.ts:558-583`). |
| `--bin-dir` given but unusable | The same error, for that one dir. There is no silent fallback, because the user's choice wins. |
| Upload or `--version` fails after a dir passed the probe (disk full, an LSM quirk) | That error is final, and no second upload is tried (owner rule). The `attach` replace fallback (`:1035-1057`) still runs the OLD binary if it answers, as today. |
| The old binary sits in `/usr/local/bin` (image-shipped, root-owned) but the user is non-root | Install goes to `$HOME/.local/bin`, `residentGuard` asks the old binary (`oldBin = found`), and the notice says `installedAt`. The next `attach` reuses the matching copy in `$HOME/.local/bin`, because any matching candidate wins. This converges: it closes the non-convergence noted at `TODO.md:721-731`. |
| `$HOME` unset, `/`, or read-only (OpenShift) | The candidate is skipped with `home` or `mkdir`, and `/tmp` is used next. |
| `/tmp/tentacle-<uid>` pre-created by another uid, or a symlink | The candidate is skipped with `owner`. A `/tmp` that fails both this check and the exec check means no dir, so the error is raised. |
| `/tmp` is `noexec` | The `/tmp` candidate gets `exec`. This is the case the owner's requirement exists for. |
| No `sh` (distroless) | `attach` falls back to the direct `--version` reuse check, and an inject still errors "no shell". |
| A probe exec timeout | Treated like a failed probe: the reuse fallback runs, and an inject errors with the probe's cause. There is never an upload. |
| A pod-printed `--version` text | It is parsed from delimited lines, and any line shown passes `untrustedText`. |
| Probe residue | The probe script is removed. Dirs created by `mkdir -p` stay (Owner Q3). |
| A candidate inside the docker workspace mount | It is skipped (`mount`), so the binary is never written into the laptop folder. |
| A pod restart that wipes `/tmp` | The next `attach` re-probes, finds no binary, and injects once. |

### Tests (red before green; fakes as in `engine-runtime.test.ts:169-190`)

- `pod-install-dir.test.ts` (pure):
  - the parser handles `ok` / `no <step>` for each candidate, and missing lines count as
    not-ok;
  - the chooser picks the first `ok` dir;
  - a matching binary in candidate 2 beats a stale one in candidate 1;
  - an explicit dir means no fallback;
  - when nothing is `ok`, the error names every dir and its step;
  - a candidate inside the mount is skipped.
- `engine-runtime.test.ts`:
  - **(R1, the owner's property)** the fake answers the probe with `/usr/local/bin`
    `no write`, `$HOME/.local/bin` `ok`. Assert exactly ONE `head -c` exec, to
    `$HOME/.local/bin/tentacle.new`, and that no `head -c` precedes the probe. This
    is red on `main`: the install goes to `/usr/local/bin` and fails.
  - **(R2)** every candidate `no`: ZERO `head -c` execs, and one error naming the
    three dirs. Red on `main`: one `head -c` runs.
  - **(R3)** `attach` with a matching binary only in `/tmp/tentacle-<uid>`: no inject
    exec, and the daemon is exec'd by that path.
  - **(R4)** a failed placement exec with no shell: `attach` still reuses a
    `tentacle` on PATH, using the direct `--version`.
  - **(R5)** `--bin-dir /x` with `/x` `no exec`: an error, and no `head -c`.
  - Mutation checks (§9): make the chooser ignore `ok`, and R1/R2 must go red. Make the
    chooser fall back after an explicit dir, and R5 must go red.
- The existing tests that pin the exec sequence (`engine-runtime.test.ts:449-461`) are
  updated through one shared fake answer for the placement script. The diff of those
  tests is the visible proof that the order became probe → upload.

### Owner questions

1. **The `/tmp` candidate's exact path.** Recommendation:
   `${TMPDIR:-/tmp}/tentacle-<uid>/bin/`, inside the resident's existing 0700 state dir
   (`pod-resident.ts:68-73`), not the state dir itself. It is one private tree, and the
   binary is not mixed with `resident.sock` and the lock.
2. **`tentacle logs` after an auto-picked dir.** Recommendation: `logs` runs the same
   placement probe (read-only, one exec) to find the binary, rather than adding an
   `installedDir` field to the kept index. That needs no schema change, and an index
   record could go stale anyway after a pod restart.
3. **Leftover empty dirs from the probe** (`$HOME/.local/bin`, `/tmp/tentacle-<uid>/bin`
   created by `mkdir -p` but not chosen). Recommendation: the probe `rmdir`s only the
   dirs it created itself that are still empty, so it leaves no trace.
4. **`run` reuses a matching binary that the image already ships** (new: today `run` always
   injects). Recommendation: yes, through the same chooser, which saves the 60–90 MB
   upload. The build-id rule keeps it exact.
5. **Should `$HOME/.local/bin` come before `/tmp`, even though `$HOME` may be persistent and
   shared across pods (a PVC home)?** Recommendation: keep the owner's order. A
   persistent copy is only reused when its build matches, so it cannot be stale.

**Owner answers (2026-11-20):** 1–5 all as recommended. Implementation approved.

## Execution

*— claude-opus-5-5, 2026-11-20*

**Plan re-verified on today's main first.** Every `file:line` the plan cites still holds
(`engine-runtime.ts:479`, `:600`, `:901-955`, `:1065`; `pod-binary.ts:148-171`, `:309-358`;
`pod-resident.ts:64-78`, `:296`, `:503`; `logs-cmd.ts:772`; `main.ts:495`, `:506-507`,
`:1521`, `:1551`, `:1601`, `:1984`, `:2041`; `workspace-mount.ts:696`; `hop-targets.ts:275`;
the fakes at `engine-runtime.test.ts:169-190`, `:449-461`). No plan fix was needed.

**Repro: not run (no engine).** `docker info` / `podman info` hung, with no answer in 120 s,
so there is no container engine in this context. The live repro and the noexec check of the
load-bearing assumption stay **unverified on a real pod** (see the end of this section).
The script itself was run with a real `sh`, the laptop's, from `.tentacle/tmp/inject-bin-dir-probe/`.
`/usr/local/bin` (not writable here) printed `place 0 no write`. A temp `$HOME` printed `ok`,
and the dirs that the probe created were gone afterwards. With `HOME=/` it printed
`place 1 no home`, then `place 2 ok …/tentacle-501/bin`, and the parent was kept at `drwx------`.
This first run found one bug, now fixed: a `case … ;; esac` inside `$(…)` is a syntax error
in bash's `sh`, so the home candidate uses a `home_bin` function.

**As built, in the plan's order:**

1. `packages/cli/src/pod-install-dir.ts` (new, pure):
   - `installCandidates` (`:39`) returns `--bin-dir` alone, or `/usr/local/bin` → `home` → `tmp`.
   - `placementScript` (`:67`) builds the ONE `sh -c`:
     - It opens with an `echo tentacle-place` sentinel, then reuses `PROBE_SCRIPT` verbatim
       (not forked).
     - `probe_dir` runs `mkdir -p`, writes a `#!/bin/sh` file, `chmod 700`s it and execs it
       directly, then `rm`s it and `rmdir`s every dir it created (deepest first).
     - It stops at the first dir that passes. The later ones print `skip`.
     - Only safe characters are allowed in a dir: `[A-Za-z0-9._/@+-]`, absolute, no `..`.
     - A dir inside the docker workspace mount (`M`) gets `no mount` before anything is created.
     - The tmp candidate is `${TMPDIR:-/tmp}/tentacle-<uid>/bin` (Q1). Its parent is made
       with `mkdir -m 700` and must be `-O` and not `-L`, else `owner`.
     - It runs `probe_bin` on every candidate's `tentacle`, then on PATH's, deduplicated.
       Each answer is printed as `bin <exit> <path>` plus up to 3 output lines prefixed `|`.
       A pod line can therefore never forge a `place` line, and a 3-line answer still fails
       the exact-2-lines build parse, as it does today.
   - `parsePlacement` (`:198`): no sentinel → `null`. A missing or garbled line → `missing`, never ok.
   - `choosePlacement` (`:280`): the reuse is the first binary that `containerDecision` would
     reuse. Otherwise the decision is made on the first binary that answered. The install dir
     is the first `ok`. When there is none, `noDir` is one line naming each dir and its step
     (`untrustedText`), plus the `--bin-dir` advice.
2. `packages/cli/src/pod-binary.ts`: `PROBE_SCRIPT` is exported. `probePod`'s engine-arch
   fallback was extracted as `withEngineArch` (`:176`). No behaviour change.
3. `packages/cli/src/engine-runtime.ts`:
   - Shared helpers: `probePlacement` (`:448`, one exec, 30 s budget), `placementFailedError`
     (`:482`) and `expectedPodBinary` (`:496`). The last one was lifted out of `attach` so
     that `run` uses the same version/build rule.
   - `run` (`:759`) runs the probe right after `waitForReady`:
     - The probe did not run → an error, before any upload.
     - It reuses a matching binary (Q4) only when a version is known: see drift 1.
     - No dir passed → `noDir`, thrown before any upload, inside the existing `try`, so
       `removeUnlessKept` handles the workload as before.
     - Otherwise `injectAgentBinary` runs at the chosen dir. It is given
       `probe: withEngineArch(classifyImage(parsed.image))`, so there is no second `uname` exec.
     - The kept-line/announce tail was factored into `ready(binPath)` (`:726`), unchanged.
   - `attach` (`:1120-1213`): the placement exec replaces the two `versionOf` execs, with the
     same `execError` translation.
     - The probe did not run (no `sh`) → today's two direct `--version` execs, for reuse only.
     - Anything that needs an install throws `cannotInstall` at the top of the existing install
       `try` (`:1204`). So a failed REPLACE still goes on with the old binary and warns, as it
       did before, but now without having uploaded anything.
     - `installedAt` is now said when `found !== binPath` (`:1268`), not only for `tentacle`
       on PATH. This covers the old root-owned `/usr/local/bin` binary when ours went to
       `$HOME/.local/bin`.
   - `findPodBinary` (`:528`): the read-only lookup for `logs` (Q2).
4. `packages/cli/src/logs-cmd.ts:775`: `logs -f <run>` execs the binary that `findPodBinary`
   finds. It falls back to `entry.binDir ?? /usr/local/bin` when the probe cannot tell.
5. `packages/cli/src/main.ts`: the help text for `TENTACLE_POD_BIN_DIR` and for `attach` now
   says the dir is picked automatically and that `--bin-dir` forces one.
6. Tests:
   - `test/placement-fake.ts` (new) is one emulator, shared by the three fakes (`FakeCluster`,
     `FakeDockerClient`, the hop `fakeHost`). It answers the placement exec from the SAME
     granular answers the fakes already give, through any override (`this.runExec`): the image
     probe and each `<bin> --version`. So the existing musl, old-version and build-id overrides
     keep deciding.
   - The placement is recorded as `runexec:<pod>:placement`. Its sub-answers are not recorded:
     they are one exec.
   - The `$HOME`/tmp binaries exist only when `PlacementPod.binaries` lists them, so by
     default only `/usr/local/bin` (or `--bin-dir`), then PATH, are asked, as before.
   - The `.includes("--version")` overrides became `asksVersion` (the script mentions
     `--version` too).
   - Sequence tests updated. The diffs show the order is now probe → upload: `placement` at
     the index where `sh -c echo tentacle-probe` (run) or `… --version` (attach) used to be.
   - `readOnly` now models a read-only fs through the probe. Its two warning tests assert
     "no install dir …" and **no `head -c` at all**: before, they asserted a failed upload.
   - New: `test/pod-install-dir.test.ts` (17 tests, including 6 that run the script under a
     real `sh`), R1–R6 in `engine-runtime.test.ts`, and the `logs` Q2 test in
     `logs-follow-detached.test.ts`.
7. `changelog.d/inject-bin-dir-probe.fixed.md` and the `TODO.md` row.

**Red → green** (`bun test packages/cli/test/engine-runtime.test.ts -t "install-dir probe"`,
with the new tests on the OLD `engine-runtime.ts`):

```
(fail) … R1 run: /usr/local/bin is not writable → ONE upload, to $HOME/.local/bin, after the probe
(fail) … R2 run: no candidate is writable + exec-able → ZERO uploads, one error naming every dir
(fail) … R5 run: an explicit --bin-dir that cannot exec → an error, no fallback, no upload
error: [pod mypod] tentacle --version failed (exit 1): not found
(fail) … R3 attach: a matching binary only in /tmp/tentacle-<uid>/bin → reused by that path, nothing uploaded
 1 pass
 4 fail
```

R1 failed on `uploads` (`/usr/local/bin/tentacle.new` received). R2 and R5 resolved instead of
rejecting. R3 injected. After the fix: `5 pass, 0 fail`.

R4 (no `sh` → direct `--version` reuse) is green on the old code too, **by design**. It pins
the fallback, and its mutation below is red.

R6 and the `logs` Q2 test are red on the old behaviour, shown by restoring that behaviour:
`run` never reuses (R6: `1 pass, 1 fail`), and `logs` uses `binDir ?? /usr/local/bin`
(`13 pass, 1 fail`).

**Mutation checks (each reverted, then the file was restored):**

| Mutation | Result |
|---|---|
| The chooser ignores `ok` (always the first candidate) | R1, R2, R5 red |
| An explicit `--bin-dir` falls back to the defaults | R5 red |
| Only the first candidate + PATH are asked (the old preflight) | R3 red |
| No fallback when the probe cannot run | R4 red |
| `run` never reuses | R6 (reuse) red |
| The script does not `rmdir` the dirs it created | 2 real-`sh` tests red |
| The script has no mount skip | the mount test red |

**Drift from the Implementation:**

1. **`run` reuses only when this laptop's version is known.** From source with no
   `TENTACLE_POD_BIN`, `expected` is `undefined`, and `containerDecision` would reuse ANY
   answering binary. That is fine for `attach` (Q3, as before) but contradicts Q4's
   "the build-id rule keeps it exact". So from source, `run` always injects, as today.
2. **A thrown placement exec stays fatal in `attach`**, translated by `execError`, exactly as
   the first `versionOf` was before (a wrong container, a timeout). Only a non-zero exit or a
   missing sentinel takes the direct `--version` fallback. The plan's table had "a probe exec
   timeout → the reuse fallback runs". I kept today's behaviour, because the k8s
   wrong-container case arrives as a throw and must keep its actionable message.
3. **The probe stops at the first dir that passes** (later ones `skip`, untouched). It no
   longer probes every candidate, because the chooser only ever needs the first. The error
   still names every candidate, because it is raised only when none passed.
4. **Q3 cleanup**:
   - The probe `rmdir`s every dir it created itself, including the chosen one. The install's
     own `mkdir -p` recreates it.
   - The **tmp candidate's parent `tentacle-<uid>` (0700) is kept on purpose**. It is the
     resident's state dir: if the probe removed it, the install's `mkdir -p` would recreate it
     with umask permissions, and the resident's `mkdirSync(…, 0o700)` does not chmod an
     existing dir.
5. **The `attach` mount** for the skip is `state.workspace` (the container's label, which is
   untrusted). It is shell-quoted, and a forged value can only remove candidates.
6. **`findPodBinary`** (for `logs`) lives in `engine-runtime.ts`, next to the probe helpers it
   reuses. `logs-cmd.ts` already imported `podDaemonCommand` from there.

**Unverified:** the live repros and the load-bearing assumption (a directly exec'd script gets
`EACCES` on a `noexec` mount; a non-root UID on UBI). There was no container engine here. To
verify, from `.tentacle/tmp/inject-bin-dir-probe/`:
- `docker run --rm --read-only --tmpfs /tmp:noexec --user 12345 registry.access.redhat.com/ubi9/ubi sh -c "$(bun script.ts -)"`.
  Expect `no write`/`no mkdir` for `/usr/local/bin` and `$HOME/.local/bin`, and `no exec`
  for `/tmp/tentacle-12345/bin`.
- Then `tentacle run --engine docker --image …ubi9/ubi --user 12345:0`. Expect `$HOME/.local/bin`
  or the tmp dir, with no `Permission denied` after the transfer.

**Gate (`bun run check`):** green. The output was `tsc` clean for all three projects,
`Checked 2131 files … No fixes applied.`, then `15756 pass · 5 skip · 0 fail · Ran 15761 tests
across 1118 files`. The 5 skips are all opt-in `skipIf`s that this task does not touch: live docker
×2, live k8s, and slow. The first run had 34 failures in `T3 frames (snapshots)` (`packages/tui`,
which this task does not touch). They were caused by a stray `ESC[?25h` that some test wrote over
the first bytes of `packages/tui/test/__snapshots__/chart-lines.test.ts.snap`. I restored the file
with `git checkout`, its two test files passed alone (98/98), and the rerun was all green. That
looks like a pre-existing flake (a raw terminal write that landed in the snapshot file); it is
not caused by this change.
