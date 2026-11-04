# fix/k8s-multi-container — multi-container pod: refuse before exec; not-found is one line

> **Status:** review
> **Branch:** `fix/k8s-multi-container`
> **Type:** fix · **Size:** S · **Blast:** cross-module · **Suited:** strong or weak model; standard Review

## Context

*— claude-sonnet-5-5, 2026-11-04*

Owner, live (OpenShift, pod with 2 containers, no `--container`):

```
$ tentacle attach -n openshift-dns dns-default-4kqw9
[pod] failed: cannot exec into pod "dns-default-4kqw9" — the exec closed before the command reported a status. The container may not … · log: ~/.config/tentacle/logs/dns-default-4kqw9/daemon.log
```

The cause was GUESSED after the exec died (`containerExecError`, `packages/cli/src/engine-k8s.ts`). Decision: with no `--container`, READ the pod first (the `getPod` the attach preflight already does) and, with more than one `spec.containers`, fail BEFORE any exec with kubectl's wording:

`[pod] failed: a container name must be specified for pod dns-default-4kqw9, choose one of: [dns kube-rbac-proxy] · pass --container <c>`

Second item (owner, live): `tentacle attach nome-che-non-esiste` (not in the kept index, so it falls back to a pod in the current namespace) printed `[pod] failed: pod "…" not found in namespace … check the name (…) o… · log: …/daemon.log` — truncated at ~120 chars, and the log dir was created though nothing ran. Wanted: `[error] nome-che-non-esiste: not in tentacle ps, and no pod with that name in openshift-dns` (docker/podman: `… no container with that name on docker`).

General rule: the `· log:` suffix appears — and the log dir/file is created — ONLY if something ran in the workload; a not-found / pre-start refusal creates nothing. A short cause must be short at the source: the ~120-char cut (`shortCause`) must never truncate a refusal.

**Repro:** red tests on the unchanged code (2026-11-04), run with `bun test` on the 5 touched files: 7 assertion failures — attach of a two-container pod resolved a runtime (exec ran); not-found created the log dir; `inspect` returned `ready` for two containers and threw a plain `Error` (not typed) for 404; `failedLine` cut the 125-char refusal to `… pass --container <…`; no `[error]` line from `main`.

## Implementation

*— claude-sonnet-5-5, 2026-11-04*

### Load-bearing assumption

`attachEngineRuntime` already calls `host.inspect(name)` → `kube.getPod` BEFORE any exec (`engine-runtime.ts` attach, the `inspect` call after the `attaching to` phase), and the pod it returns carries `spec` (typed `unknown`, `packages/k8s/src/types.ts` `Pod.spec`). So no new API call, same auth/TLS seam as the rest of `@tentacle/k8s`.

### Preconditions

- `host.inspect` is called only from `attachEngineRuntime` (grep: one call site). Its errors were wrapped with `recordFailure(error, stderr)`, which creates/tags the log; `stderr = openDaemonLog(...)` was opened at the top of the function, i.e. BEFORE `inspect` (creating dir + file via `mkdirSync` / `appendFileSync`, `pod-stderr-log.ts`).
- `failedLine` (`pod-stderr-log.ts`) cuts via `shortCause` (`SHORT_CAUSE_MAX = 120`) — this is the truncation seen live. The kubectl line is 125+ chars, so it would be cut too.
- `main.ts` attach (non-run) prints every error with `failedLine(noun, error)`; the kept-entry case is distinguishable (`keptEntry`).
- The old guess `containerExecError` stays reachable: `--container <wrong-name>` (container given, so no refusal), or a pod whose `spec` is unreadable. **Kept as the fallback**, unchanged — not dead code.

### Design

1. `@tentacle/k8s` `podContainerNames(pod)` — `spec.containers[].name` in order, defensive (init/ephemeral never listed).
2. `engine-host.ts`: `RefusalError` (a pre-start refusal: never cut, no log) and `WorkloadNotFoundError extends RefusalError` (`noun`, `place`); `EngineHost.inspect(name, {container?})`.
3. `engine-k8s.ts` `inspect`: 404 → `WorkloadNotFoundError(<old text>, "pod", "in <ns>")`; after the terminal-phase check, if `container === undefined` and `podContainerNames(pod).length > 1` → `RefusalError("a container name must be specified for pod X, choose one of: [a b] · pass --container <c>")`. A GET failure (403, network) keeps its existing path (unchanged). The namespace-missing create error becomes a `RefusalError` too (run path: nothing ran).
4. `engine-docker.ts` `inspect` 404 → `WorkloadNotFoundError(<old text>, "container", "on <docker|podman>")`.
5. `engine-runtime.ts` attach: pass `{container}` to `inspect`; `inspect` failure, `stopped` (now `RefusalError`) and `waitForReady` failure no longer call `recordFailure`; `openDaemonLog` moves to just before the first exec. `provisionWorkload` (run) skips `recordFailure` for a `RefusalError`.
6. `pod-stderr-log.ts`: `failedLine` does not cut a `RefusalError` (first line, still `untrustedText`-sanitised — pod/container names are pod-supplied); `notListedLine(name, err)`.
7. `main.ts` attach: `!keptEntry && WorkloadNotFoundError` → `notListedLine`; otherwise `failedLine`. A kept entry whose pod vanished keeps `[pod] failed: pod "x" not found…` (uncut, no log), since "not in tentacle ps" would be false.

How the cut never hits a short cause: it is by TYPE, not by length — `RefusalError` bypasses `shortCause`; `notListedLine` never goes through it.

### Files

`packages/k8s/src/types.ts` · `packages/cli/src/engine-host.ts` · `engine-k8s.ts` · `engine-docker.ts` · `engine-runtime.ts` · `pod-stderr-log.ts` · `main.ts`; tests in `packages/cli/test/{engine-k8s,engine-docker,engine-runtime,pod-stderr-log,main}.test.ts`.

### Failure modes

- Pod GET 404 / 403 / network: unchanged messages (404 now typed); no log created for any (nothing ran).
- Pod terminated: `stopped` verdict wins over the container check.
- `--container` given (right or wrong): no refusal; a wrong name still hits the exec guess.
- `spec` missing/odd shape: `podContainerNames` → `[]`, no refusal, behaviour as before.
- Race (a container added between GET and exec): the exec fallback applies.
- Protocol/persistence: untouched (no wire or on-disk change).

### Tests

Fakes: `FakeCluster` / `StubCluster` (`getPod` overridable), `FakeDockerClient`, `main` seam `attachPlainRuntime`. Pins: refusal wording + no `exec:`/`runexec:` call + no log dir; not-found/terminated → no log dir; a failure after the first exec keeps its log; `failedLine` uncut for `RefusalError` but cut for a plain `Error`; `notListedLine` for k8s and docker; `main` prints exactly one `[error]` line without `failed:` / `log:`.

## Execution

*— claude-sonnet-5-5, 2026-11-04*

Done as planned, in order: tests first (red: 7 assertion failures, see Repro) → `types.ts`/`engine-host.ts`/`engine-k8s.ts`/`engine-docker.ts` → `engine-runtime.ts` → `pod-stderr-log.ts` → `main.ts`.

Drift: (a) the docker "already exists" / mount-denied create errors are NOT converted to `RefusalError` (a pull may already have run; out of scope) — only the k8s missing-namespace one is. (b) `containerExecError` kept as fallback, not removed.

Mutations (one per behaviour, each reverted, `shasum` identical to before):
- M1 `names.length > 1` → `> 99` (engine-k8s): 2 tests red (k8s inspect, attach no-exec).
- M2 open the log before `inspect` (engine-runtime): 2 tests red (multi-container, not-found/terminated).
- M3 `failedLine` ignores `RefusalError`: 1 red (cut at 120).
- M4 main always `failedLine`: 1 red (`[error]` line).

Gate (foreground): `bunx tsc --noEmit`, `bunx biome check .`, `bun test packages` — see Review.

## Review

*— claude-sonnet-5-5, 2026-11-04*

Self-review only (not a fresh context; Blast is cross-module, standard review). Gate (foreground, after dropping the `name` overrides that tripped TS2416 and a biome format of two test files): `bunx tsc --noEmit` clean; `bunx biome check .` clean; `bun test packages` 4290 pass, 3 skip (the opt-in ones), 0 fail. Not verified live against OpenShift: the pod GET on a real cluster carries `spec.containers` (standard k8s API), checked only with fakes.

## Review (fresh context)

*— claude-opus-5-5, 2026-11-04*

**Verdict: APPROVE-WITH-NITS (PASS — LOW findings only).** Fresh context, different model from the executor (claude-sonnet-5-5); still the same family, so shared blind spots are possible.

**Gate (foreground, once).** `bun run check` stops at `tsc -p apps/mobile` (TS6053 `expo/tsconfig.base` not found: this worktree has no `apps/mobile` install). It is the environment, not this diff. That failed `tsc` also EMITTED six `.js` files into `apps/mobile/` (18:27). I confirmed by timestamp that my run created them, then removed them; the tree has no untracked files except the task doc. Then: `bunx tsc --noEmit` clean · `bunx biome check .` clean (619 files) · `bun test` **4329 pass, 3 skip (opt-in), 1 fail + 1 error**. Both the fail and the error are the same thing: `apps/mobile/test/rn-websocket.test.ts` cannot resolve `@tentacle/client`. It is environmental, and every `packages/` test passes.

**Mutation (1, mine).** I removed `!keptEntry &&` from the `notListedLine` branch (`packages/cli/src/main.ts:1447`). `main.test.ts` stayed **92 pass, 0 fail**: the mutation SURVIVED (finding 1). I reverted it, and `shasum -c` reports `main.ts: OK`, byte-identical.

**Checked and holds:**
- Exact wording and order: `[${names.join(" ")}]` comes from `spec.containers` in array order (`engine-k8s.ts:196-201`, `k8s/src/types.ts:49-58`). The test asserts the exact string (`engine-k8s.test.ts`). With `failedLine` the line is `[pod] failed: a container name must be specified for pod X, choose one of: [a b] · pass --container <c>`, uncut and with no `· log:` (no `recordFailure` runs, so no `logPath`).
- Init and ephemeral containers are excluded: only `spec.containers` is read. The test fixture includes `initContainers: [{name:"init"}]`, and the exact message pins that it is left out.
- One container, or `--container` given: the check is skipped (`options?.container === undefined`). The test asserts `ready` in both cases. A wrong `--container` still falls back to `containerExecError`.
- GET 403 / network: still `throw error instanceof Error ? …` (`engine-k8s.ts:182`), unchanged. Only 404 is now typed.
- Same auth and TLS: there is no new call. `inspect` is the same `kube.getPod` (`k8s/src/client.ts:133`, `doFetch` + `headers()`) that the preflight already made. There is no extra round trip with or without `--container`.
- Item 2, k8s: not found → `WorkloadNotFoundError(…, "pod", "in <ns>")`. Docker/podman: not found → `(…, "container", "on <kind>")`. `main` prints `notListedLine`, a single line with no `failed:`, no `log:` and no cut (`main.test.ts` and `pod-stderr-log.test.ts`).
- Nothing on disk: `openDaemonLog` now runs after `inspect`, the `stopped` check and `waitForReady` (`engine-runtime.ts:753`). `engine-runtime.test.ts` checks the real filesystem: `existsSync(dirname(logPath)) === false` for multi-container, 404 and terminated pods.
- A real failure after the first exec still gets its log (`existsSync(logPath)` and `failureLogPath`).
- Run path: only the k8s missing-namespace error became a `RefusalError`, and `provisionWorkload` skips its log.

**Attacks tried:**
1. Kept-entry branch mutation: survived (finding 1).
2. A long cause on a path that is not a refusal and now has no log: found finding 2.
3. Pods with a default container: found finding 3.
4. Empty `--container ""`: `main` drops it (`container ? {container} : {}`), so it behaves like "no container" and is refused. Consistent.
5. Terminated pod with 2 containers: `stopped` wins (tested).
6. Odd `spec` shape: `podContainerNames` returns `[]`, so behaviour is as before.

**Findings (all LOW):**
1. **LOW, test coverage.** No test pins the kept-entry case: a kept pod that has vanished must still print `[pod] failed: pod "x" not found…` and not "not in tentacle ps". The `!keptEntry` mutation survives (`main.ts:1447`).
2. **LOW.** A `waitForReady` failure in `attach` (`engine-runtime.ts:747`) no longer writes a log, but it is a plain `Error`, so `shortCause` still cuts it at 120 chars. With a long pod name, `pod <name> did not become ready within 60000ms (phase …)` can lose its tail, and there is no log holding the full text. Either make it a `RefusalError` or leave it uncut.
3. **LOW, UX.** kubectl honours the `kubectl.kubernetes.io/default-container` annotation; many OpenShift operator pods set it. When the annotation is present, `kubectl exec` does NOT refuse, but tentacle does. The behaviour is still safe (the exec API needs a name), but "same as kubectl" holds only for pods without the annotation. Possible follow-up: use the annotation as the default container.

**How the executor behaved.** Tests came first. The deviations are declared (docker create errors were left alone; `containerExecError` was kept as a fallback). The executor's mutations were real. One gap: its gate ran `bun test packages` rather than `bun run check`, and it never mentioned that `check` cannot run in this worktree. Claims match the code. Nothing was verified live on OpenShift (stated).

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-04*

Owner decision: the docker/podman create errors "name already exists" (409) and "mounts denied" become `RefusalError`s (`engine-docker.ts`, `conflict`), by the general rule — log suffix and log dir only if something ran IN the workload (an image pull is not the workload). `provisionWorkload` already skips `recordFailure` for a `RefusalError`, so `failedLine` prints one uncut line with no `log:`, and no dir is created. Other create failures (`toError`, e.g. a failed pull) are unchanged and still log.

Review LOW closed: "kept-entry branch untested" — new `main.test.ts` test: a name that IS in the kept index whose workload is gone keeps `[container] failed: …` (not `not in tentacle ps`, no `log:`).

Red-first: the docker test failed on the assertion (`toBeInstanceOf(RefusalError)`) before the change. Mutations, each reverted, `shasum` identical to before:
- M5 drop `!keptEntry` in `main.ts` (the one that had survived): the new kept-entry test goes red.
- M6 409 `RefusalError` → `Error`: docker test red.
- M7 mounts-denied `RefusalError` → `Error`: docker test red.

Other Review LOWs: the Review's list was not passed to this round and is not in my context, so none were touched or listed here beyond the one named above; please paste them if they are to be recorded.

## Review — round 2

*— claude-opus-5-5, 2026-11-04*

**Verdict: PASS (APPROVE-WITH-NITS, LOW only).** Fresh context, a different model from the executor (claude-sonnet-5-5), same family.

**Gate (foreground, once):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (619 files) · `bun test packages` **4292 pass, 3 skip (opt-in), 0 fail**. The tree is clean apart from this doc.

**Verified:**
- **Round-1 mutation now goes red.** Dropping `!keptEntry` (`main.ts:1447`) fails the new kept-entry test in `main.test.ts` (92 pass, 1 fail). Reverted; `shasum -c` OK.
- **Docker/podman refusals create nothing on disk.** 409 and mounts-denied now return `RefusalError` from `conflict` (`engine-docker.ts:190-204`). `provisionWorkload` skips `recordFailure` for them. The test checks the real filesystem (`existsSync(dirname(logPath)) === false`) and `failedLine` with no `log:`. Every other create error (`toError`, e.g. a failed pull) still logs.
- **A real start failure still gets its log (my mutation).** I changed `provisionWorkload` to `path !== undefined && false`, so it never records. `startPodRuntime › setup before the daemon (tentacle --version crashes): the error carries the log path…` goes RED (230 pass, 1 fail on the 4 files). Reverted; `shasum -c` reports `engine-runtime.ts: OK`.

**Findings (LOW):**
1. Round-1 LOW 2 and 3 are still open. The executor says the list did not reach it, although it is in this doc's first Review section:
   - 2: an `attach` `waitForReady` failure is cut at 120 chars and has no log.
   - 3: the `kubectl.kubernetes.io/default-container` annotation is not honoured.
   Both are OK to defer to `TODO.md`.

**How the executor behaved:** red-first, three real mutations (M5–M7). The round's scope is honest. It said openly that it had not seen the other LOWs instead of inventing them.

### Execution — round 3

*— claude-sonnet-5-5, 2026-11-04*

Owner decision (the Review's LOW "default-container ignored"): honour the `kubectl.kubernetes.io/default-container` pod annotation, as kubectl does. This amends the refusal described in Design §3: with no `--container` and more than one `spec.containers`, an annotation naming a container that EXISTS in `spec.containers` is used silently (no extra line); a missing, empty or unknown annotation gives the refusal with the list, unchanged. One container, or `--container` given: unchanged, no annotation lookup.

As built: `engine-k8s.ts` `inspect` resolves it and returns it as `WorkloadState.container` (`ready` / `starting`, `engine-host.ts`); `attachEngineRuntime` adopts it as `container` when the user named none (`let container`), so EVERY exec — version probe, resident status, injection, the daemon and its redials — targets it (the API alone would still refuse a multi-container exec). README has no text on this refusal, so it is unchanged.

Pinned with the existing fakes (`StubCluster`, `FakeCluster`), using the live OpenShift 4.19 data of 2026-11-04: the `etcdctl etcd etcd-metrics etcd-readyz etcd-rev` pod with annotation `etcd` resolves to `etcd` (and every exec goes to `exec:<pod>:etcd:`); a `dns kube-rbac-proxy` pod with no annotation (also empty / `ghost`) is refused with the list. Red-first: both new tests failed before the code (refusal thrown / execs on `-`).

Mutations, each reverted, `shasum` identical:
- M8 ignore the annotation (`engine-k8s.ts`): 2 red.
- M9 trust the annotation without checking `spec.containers` (`ghost` accepted): 1 red.
- M10 resolve the annotation even with `--container`: 2 red.
- M11 runtime drops `state.container`: 1 red (execs go to `-`).

## Review — round 3

*— claude-opus-5-5, 2026-11-04*

**Verdict: PASS (APPROVE-WITH-NITS, LOW only).** Fresh context. The executor was claude-sonnet-5-5, a different model of the same family, so shared blind spots are possible.

**Gate (foreground, once):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (619 files) · `bun test packages` **4294 pass, 3 skip (opt-in), 0 fail**. The tree has no stray files; only this doc is untracked.

**Mutation (1, mine).** I pointed the daemon's exec `target.container` back at `deps.container`, so it ignores the resolved annotation (`engine-runtime.ts:932`). `engine-runtime.test.ts` › "the default-container annotation is the container EVERY exec targets" went RED (88 pass, 1 fail). Reverted; `shasum` is identical (`e7e4f02e…`).

**Round 3 checked against the code:**
- **Annotation honoured only when valid.** `engine-k8s.ts:202-215`: the annotation is used only when `options?.container === undefined`, there are more than one `spec.containers`, and `names.includes(preferred)`. In every other case (missing, `""`, an unknown name) the round-1 refusal is thrown with the list, unchanged. The test (`engine-k8s.test.ts`) uses the live etcd data: `etcdctl etcd etcd-metrics etcd-readyz etcd-rev` with annotation `etcd` → `{ready, container:"etcd"}`, and `starting` carries it too. Missing, empty and `ghost` → exact refusal string. The dns-default shape (2 containers, no annotation) is covered by the round-1 test.
- **`--container` wins and needs no lookup.** The block is skipped completely, and the state carries no `container` (`toEqual({kind:"ready"})`). The pod GET itself is the same preflight as before; there is no extra call.
- **Single container: unchanged.** With `names.length === 1`, nothing is resolved, whatever the annotation says (tested).
- **Every exec goes to the resolved container.** In `attachEngineRuntime` the only value is `let container` (`engine-runtime.ts:697`), and it is adopted at `:726-728` only when the user named none. All later sites use it: version probe `:776`, `execError` `:793/:978`, resident status/stop `:807/:834`, injection and probe `:851-852`, daemon target and redial `:930-938`. No `deps.container` remains after the preflight (grep).
- **No new terminal line.** The resolution prints nothing, and the test asserts that the logs never contain `etcd`. Pod-supplied annotation text never reaches the terminal on this path. A refusal still goes through `untrustedText`.
- **Docker is unaffected.** Its `inspect` ignores `options` and never sets `container`.

**Rounds 1–2 sanity check (still holds):** not-found → `WorkloadNotFoundError` → `notListedLine`, one `[error]` line (k8s and docker), while a kept entry keeps `failedLine`. `openDaemonLog` runs only after inspect, `stopped` and `waitForReady` (`engine-runtime.ts:760`), so a workload that never started gets no log dir. The `existsSync` tests are still green in the gate above.

**Attacks tried:**
1. Daemon/redial target bypassing the resolution (my mutation): caught.
2. Annotation + terminated pod: `stopped` is checked first, so it is refused as before. Correct.
3. Annotation naming an init container: refused, because only `spec.containers` is searched. That is stricter than kubectl (finding 2).
4. Annotation + `--container ""`: `main` drops the empty value, so the annotation applies. Consistent with kubectl.
5. Annotation names a container that is not running: the exec fails after it ran, so the log is kept and `containerExecError` applies. Acceptable.

**Findings (all LOW):**
1. **LOW, doc accuracy.** The Context calls the refusal "kubectl's wording". Current kubectl (≥ 1.21) no longer refuses. With no `-c` and no valid annotation it prints `Defaulted container "x" out of: …` and uses the FIRST container. Refusing is the owner's choice, and it is safer, but the claim "same as kubectl" holds only for the annotation part.
2. **LOW.** kubectl's `FindContainerByName` also accepts an annotation that names an init or ephemeral container; tentacle refuses that case. Rare, and it fails loud, so this is fine as it stands.
3. **LOW (carried over).** Round-1 LOW 2 is still open: in `attach`, a `waitForReady` failure is a plain `Error`, so it is cut at 120 chars and leaves no log. Move it to `TODO.md` if it is deferred.

**How the executor behaved:** tests were written red first, with the live data. It ran 4 real mutations (M8–M11), and each one pins a separate property. The scope is honest: README is unchanged, with the reason given. Its claims match the code.
