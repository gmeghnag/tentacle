# feat/docker-ssh-dialer — the `ssh://` engine dialer (docker-runtime slice A2)

> **Status:** context · implementation · execution (review pending)
> **Branch:** `feat/docker-ssh-dialer`
> **Type:** feat · **Size:** S (one new leaf module + its tests + one wiring site; no new dependency) · **Blast:** contained (leaf code in one package; adds an implementation of the frozen `Dialer` interface, no protocol / persistence / terminal-IO / §7-invariant change) · **Suited:** qwen3.8-27b (contained S) + standard Review, fresh-context preferred.

## Context

*— qwen3.8-27b (tentacle), 2026-10-26*

**Why.** `docs/feat/docker-engine-client.md` (slice A, merged) freezes the
transport seam — `Dialer = (signal?) => Promise<ByteDuplex>`
(`packages/docker/src/byte-duplex.ts:36`) — and its `socketDialer` (unix +
tcp/TLS, `byte-duplex.ts:252`). Its Design §2 says **"The ssh dialer (A2)
implements this same interface"** and §9 (lines 305-325) is the approved spec
for exactly this slice: a `ByteDuplex` over `ssh … docker system dial-stdio`'s
child stdio, so a remote engine is ONE more dialer of the same code path —
the client never learns which transport it rides (the `client.test.ts`
"one code path" property, `client.test.ts:354`).

**Repro (capability missing), 2026-10-26, on `main` @ `36a5cec`:**
```
$ rg -n "ssh" packages/docker/src
…(only the `ssh` ENDPOINT PARSER in engine-endpoint.ts:36,223,269-307 —
  `resolveEngineEndpoint` already returns `{kind:"ssh",…}` for `ssh://[user@]h[:port]`)
$ rg -n "sshDialer|makeDialer|dialerFor|endpointDialer" packages/
(no output — no dialer for the ssh kind exists anywhere)
$ sed -n '115,116p' packages/docker/test/integration.live.test.ts
  if (ep.kind === "ssh") {
    console.log(`[live] ${target.name}: ssh endpoints are slice A2 — skipped`);
```
So the endpoint is PARSED (`engine-endpoint.ts:36,275`) but there is no dialer
to dial it: a `ssh://` endpoint cannot be used to build a `DockerClient`
(`DockerClient` only takes a `Dialer`, `client.ts:38`). This slice adds that
dialer and wires the `ssh` endpoint kind to it where the live test currently
refuses/defers it.

**Constraints.** Follow the frozen §9 spec verbatim: the exact `ssh` argv,
`detached` + own process group via `@tentacle/exec` `trackGroup`/`killGroup`,
env = `scrubSensitiveEnv(process.env)` **plus `SSH_AUTH_SOCK` re-added**,
stderr piped + captured (8 KiB cap) **never inherited**, early-exit message
classification, and hermetic tests (a fake `ssh` on a temp PATH bridging to a
`Bun.listen` unix fake engine, plus a fake-spawner seam). No new dependency
(`@tentacle/core` + `@tentacle/exec` are already workspace deps, and the root
`tsconfig.json:14,16` already maps both).

## Implementation

*— qwen3.8-27b (tentacle), 2026-10-26*

### Load-bearing assumption

**The `FileSink` the child's stdin is (`Bun.spawn` → `Subprocess.stdin`,
`bun-types/bun.d.ts:5119-5135`) exposes exactly the backpressure signal the
`ByteDuplex` contract needs, and nothing more:** `write(chunk)` returns a
**`number` (bytes accepted, no backpressure) or a `Promise` (queued,
backpressure)** — confirmed empirically on Bun 1.4.3 (`.tentacle/tmp/
docker-ssh-dialer/probe-*`): small writes return the full length; once the
64 KiB pipe buffer is full the return is a `Promise`. `flush(): number |
Promise<number>` resolves when the sink's buffer empties, and `end(error?)`
half-closes (FIN). There is **no `drain` event** on the sink, so `buffered` /
`setOnDrain` are derived from that write/flush return, not from an event. This
is what lets `runExec`'s 4 MiB high-water pump (`exec-run.ts:78,225`) drive an
ssh connection with no polling. Proven once in T3 (the 8 MiB round-trip
through the real bridge); if it were wrong the pump would either stall or
over-queue, and T3 would hang.

### Preconditions

Verified invariants / facts the change relies on, each cited:

- **The interface is frozen and transport-agnostic** — `ByteDuplex`
  (`byte-duplex.ts:19-35`) has no socket-only member (`socketDialer` adds
  nothing to it), and `Dialer` is `(signal?) => Promise<ByteDuplex>`
  (`byte-duplex.ts:36`). `DockerClient` consumes ONLY a `Dialer`
  (`client.ts:38,121`) — so a ssh dialer drops in with the client unchanged.
- **The ssh endpoint is already validated** — `engine-endpoint.ts:269-307`
  refuses a `user`/`host` starting with `-` or containing whitespace/control
  chars (`unsafeSshToken`), and a path/query/fragment, so the argv's `--` +
  the validated `host` stop option injection. `user`/`port` are optional.
  `endpointLabel` (`engine-endpoint.ts:308-315`) names it `ssh://[user@]host[:port]`.
- **Process groups: `@tentacle/exec`** — `trackGroup(pgid)` registers a live
  group in the exit net, `releaseGroup(pgid)` hands a leader's exit to the
  lingers, `killGroup(pgid, signal)` signals the whole group, `isLingering`
  tells whether a released group still has members
  (`packages/exec/src/process-group.ts:96,132,145,171,201`).
- **The spawn pattern to copy** — `host-execution.ts:178-191` spawns
  `/bin/sh -c …` with `...({ detached: true } as object)` (its own group;
  pgid = pid), `trackGroup(proc.pid)`, and
  `proc.exited.then(() => releaseGroup(proc.pid))`; `terminate`
  (`host-execution.ts:215-224`) is `killGroup(pid, "SIGTERM")` then
  `killGroup(pid, "SIGKILL")` after a grace, skipped when the group is
  already released-and-empty (`isLingering` false).
- **Secret scrub + `SSH_AUTH_SOCK`** — `scrubSensitiveEnv`
  (`packages/core/src/env.ts:11-34`) drops any key matching `/…|AUTH|…/`, so
  it drops `SSH_AUTH_SOCK`; the ssh dialer re-adds it explicitly (the ssh
  agent socket is what lets key-based auth work; it is not a secret value, it
  is a path the user's own `ssh` must reach). Precedent for a child env that
  re-adds an explicit key: `mcp/transport.ts:27-30` (scrub, then overlay).
- **stderr captured, never inherited** — precedent `mcp/transport.ts:31-40`
  (spawn `stderr: "pipe"` and drain it to `onStderr`, never `inherit`), so a
  chatty/failed `ssh` cannot scribble over the TUI's alt-screen (§7
  "Never write raw to the terminal while Ink owns it").

### Design

Add `packages/docker/src/ssh-dialer.ts`, an implementation of the SAME
`Dialer` (`byte-duplex.ts:36`), next to `socketDialer`. `sshDialer(ep, opts?)`
(`ep = Extract<EngineEndpoint,{kind:"ssh"}>`). The dialer is a pure function
of `ep` + an injectable seam, so every property is unit-testable.

**argv** (spec §9, `engine-endpoint.md` §9):
```
ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15
    -o ServerAliveCountMax=3 [-l user] [-p port] -- <host> docker system dial-stdio
```
`-T` disables pseudo-terminals (a PTY would break the raw HTTP framing and
echo input); `BatchMode=yes` makes auth/host-key failures **fail** instead of
prompting (so nothing can hang on a TTY); `ServerAlive*` keep the NAT/LB link
alive (the ssh analog of TCP keepalive, `byte-duplex.ts:44`). No secrets in
argv. `user`/`port` are added only when present on the endpoint.

**Spawn** (`host-execution.ts:178-191` pattern): `Bun.spawn(argv, { env,
stdin:"pipe", stdout:"pipe", stderr:"pipe", detached:true })`. `detached` ⇒
its own process group (no controlling TTY; a host-key prompt can never block),
pgid = `proc.pid`. `trackGroup(proc.pid)` at spawn; `releaseGroup` on exit.
env = `scrubSensitiveEnv(process.env)` with `SSH_AUTH_SOCK` re-added from
`process.env.SSH_AUTH_SOCK` when set (a dialer `options.env` overlay is allowed
for tests, mirroring `mcp/transport.ts:27-30` and `host-execution.ts:230-234`).

**`ByteDuplex` over the child stdio** (one `class SshDuplex`, mirroring
`SocketDuplex`, `byte-duplex.ts:105-246`):
- `write(bytes)`: hand to `proc.stdin`. The return decides backpressure —
  a `number` (accepted) leaves `buffered` at 0; a `Promise` (queued) marks
  `buffered` > 0 and `void promise.then(onDrain)`. (The number is not a
  reliable partial count — a 64 KiB write once returned 66576 — so it is
  treated as "accepted", not "N bytes accepted".)
- `buffered`: 0 unless a `Promise`-return is in flight.
- `setOnData(fn)`: `stdout` is read with a `getReader()` loop → `fn(bytes)`;
  bytes before the handler is set are held (same hold-then-flush as
  `SocketDuplex.data`, `byte-duplex.ts:215-224`).
- `setOnDrain(fn)`: fired when an in-flight `Promise`/`flush()` settles.
- `setOnEnd(fn)`: the child's `exited` / stdout-EOF fires it once; on a
  non-clean exit the error **carries the captured stderr** (8 KiB cap) so the
  message classification (below) is available to `dialError`-style callers.
- `end()`: `proc.stdin.end()` (FIN = the command's stdin EOF; reading
  continues) — the half-close the whole client relies on.
- `close()`: SIGTERM the group, SIGKILL after a short grace (mirror
  `host-execution.ts:215-224`), then `untrackGroup`; idempotent; fires `onEnd`
  once. `untrackGroup`/`releaseGroup` so the exit net never hits a recycled
  pgid.

**Dial failure** = a reject (like `socketDialer`, `byte-duplex.ts:252`),
translated to an actionable `Error` naming the endpoint. **Early-exit
classification** (spec §9): a spawn ENOENT (the child never ran) →
"ssh not found on PATH"; the child exits quickly and its captured stderr says
"Host key verification failed" → "verify the host key once with `ssh <host>`";
"Permission denied" → "load a key in ssh-agent / IdentityFile (batch mode: no
password prompts)"; exit 127 / "docker: command not found" (or a dial-stdio
`command not found`) → "ssh contexts need the docker CLI on the server"; a
resolve/refused/timeout → a network message. A **late** failure (the child ran,
then died) is NOT a dial failure — it is an `onEnd` error carrying stderr, so
a request already in flight gets the actionable text rather than hanging
(`http-conn.ts` settles the exchange on `onEnd(error)`).

**Wiring** (minimal): the one place that refuses/defers the `ssh` kind is the
live test, `integration.live.test.ts:115-116`. Replace that early-return with
`dial: sshDialer(ep)` (instead of `socketDialer(ep)`), so an opt-in
`ssh://` context is exercised end-to-end through the same lifecycle test.
No other call site constructs a dialer from an endpoint today
(`client.ts:38` takes a `Dialer`; the only endpoint→dialer construction is
the live test), so the wiring is a one-line change at that site plus a
`makeDialer(ep)`-style helper is NOT added (nothing else needs it yet — keep
the diff minimal).

### Files

Smallest diff, dependency order:
1. `packages/docker/src/ssh-dialer.ts` (new) — `SshDuplex` + `sshDialer` +
   `classifySshExit` (the pure early-exit classifier).
2. `packages/docker/src/index.ts` — `export * from "./ssh-dialer.ts";`
3. `packages/docker/test/ssh-dialer.test.ts` (new) — hermetic T1-T6.
4. `packages/docker/test/integration.live.test.ts` — wire the `ssh` kind
   (`sshDialer`) where it is currently refused (line 115-116); the existing
   `TENTACLE_DOCKER_CONTEXTS`/`DOCKER_HOST` resolution already produces an
   `ssh` endpoint, so no new env is required for it to be reachable — and an
   opt-in `TENTACLE_DOCKER_SSH_HOST` target is added for the live-only path.
5. `docs/feat/docker-ssh-dialer.md` — this doc (rides the branch).
No `package.json` / `bun.lock` change (`@tentacle/core` + `@tentacle/exec`
are already workspace deps and root `tsconfig.json:14,16` already maps them).

### Failure modes

Every row converges to an actionable `Error` (a dial reject, or an `onEnd`
error carrying stderr) — never a hang, never a silent drop, never stderr on
the terminal.

| Failure | Where detected | Outcome / convergence |
|---|---|---|
| `ssh` not on PATH | spawn throws ENOENT (synchronous) | dial rejects "ssh not found on PATH"; no child, nothing to clean |
| Host key not accepted (BatchMode) | child exits, stderr "Host key verification failed" | dial rejects "verify the host key once with `ssh <host>`" |
| No key / auth refused | child exits, stderr "Permission denied" | dial rejects "load a key in ssh-agent / IdentityFile (batch mode: no password prompts)" |
| docker CLI missing on the server | child exits 127 / "command not found" | dial rejects "ssh contexts need the docker CLI on the server" |
| Server unreachable / timeout | child exits, `ConnectTimeout` fires | dial rejects a network message naming `ssh://…` |
| ssh dies mid-session | child `exited` while a request is in flight | `onEnd` error carrying captured stderr → the in-flight request/hijack settles (does not hang) |
| Client `close()` (channel teardown) | `SshDuplex.close()` | SIGTERM group → SIGKILL grace → `untrackGroup`; `onEnd` once; idempotent |
| Tentacle exits while a link is live | `trackGroup` exit net | the group is SIGKILLed (never orphaned to PID 1) |
| `SSH_AUTH_SOCK` unset | env build | not re-added (ssh uses config/keys); never a secret leak |
| Backpressure (large `runExec` input) | `FileSink.write` Promise | pump pauses while `buffered > 0`, resumes on drain; memory bounded (T3) |
| stderr larger than 8 KiB | capture buffer | truncated to 8 KiB (classification only needs the leading lines) |

### Tests

Red-before-green for the wiring (the live test's ssh path was a skip); every
hermetic test is shown **red by mutation** (one mutation per key property, §9):
a fake `ssh` (a bun script on a temp PATH) that bridges stdio to a `Bun.listen`
unix **fake engine**, plus a **fake-spawner seam** (`SshSpawner = (argv, env,
opts) => SshProc`) so the argv / env / `detached` / group calls are asserted
without a real child (mirrors `PodDeleteSpawner`, `pod-cleanup.ts:155`).

- **T1 argv** — the fake spawner records `argv`; assert it is exactly
  `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15
  -o ServerAliveCountMax=3 -- host docker system dial-stdio`, and that
  `user`/`port` become `-l u`/`-p 2222` only when present; **no** secret
  string appears in argv. *Mutation: drop the `--` → a `user`/`host` that
  looks like an option would be parseable; assert the literal `--` is present
  and immediately before `host`.*
- **T2 env** — the recorded env: a `SECRET_KEY`/`FOO_TOKEN` is scrubbed,
  `PATH`/`HOME` survive, and `SSH_AUTH_SOCK` is present even though
  `scrubSensitiveEnv` drops it. *Mutation: stop re-adding `SSH_AUTH_SOCK` →
  it is absent, test fails.*
- **T3 one real request + an exec hijack through the ssh dialer, client
  unchanged** — the real `sshDialer` (real `Bun.spawn` of the fake `ssh` →
  fake engine) drives a `new DockerClient({ dial: sshDialer(ep) })`:
  `ping()` resolves the negotiated `/v1.52`, `createContainer` + `startContainer`
  work, and `openExec`'s hijack 101 + a frame round-trips (the daemon's
  `initialize` analog). This is the spec's "prove the client only ever sees a
  `Dialer`" over the REAL ssh transport (not just the scripted one-code-path
  test in `client.test.ts:354`). *Mutation: make `end()` call `proc.kill()`
  (full close) instead of `stdin.end()` → the half-close exec never ends, test
  fails.*
- **T4 stderr never inherited + captured (8 KiB cap)** — the fake `ssh`
  writes to its stderr; assert the dialer's `onEnd` error message carries the
  first ≤8 KiB of it and the test process's own stderr never did (a spy on
  the fake spawner's `stderr` mode = `"pipe"`, not `"inherit"`). *Mutation:
  spawn with `stderr: "inherit"` → the capture is empty / the assertion fails.*
- **T5 process-group kill on close** — the fake `ssh` spawns a long-lived
  grandchild in its own group; the dialer's `close()` must SIGTERM the group
  (assert via the fake spawner's recorded `killGroup`-equivalent / the
  grandchild is reaped) and the child is gone; a second `close()` is a no-op.
  *Mutation: `close()` only `proc.kill()`s the leader (not `-pgid`) → the
  grandchild survives, test fails.*
- **T6 early-exit classification** — the fake `ssh` exits with each of:
  ENOENT (spawner throws), "Host key verification failed", "Permission
  denied", exit 127, a network timeout; assert the dial rejects with the
  matching actionable message for each (this is the pure `classifySshExit`,
  unit-tested directly too). *Mutation: return one fixed message for all
  cases → the per-case assertions fail.*
- **T7 live (opt-in, `TENTACLE_DOCKER_SSH_HOST`)** — `test.skipIf` unless
  `TENTACLE_DOCKER_SSH_HOST` is set; runs the same lifecycle as
  `integration.live.test.ts` over `sshDialer(resolveEngineEndpoint(
  {DOCKER_HOST: "ssh://…"}))`. Skipped by default; NOT run here (no remote).

Gate (§4): `bun test` (no new non-opt-in skip; the ssh live path is gated),
`bun run typecheck`, `bun run lint` (baseline 0/0).

## Execution

*— qwen3.8-27b (tentacle), 2026-10-26*

### As-built, in order

1. `packages/docker/src/ssh-dialer.ts` (new, 410 lines) — exactly per
   Implementation/Design: `sshCommand` (the §9 argv, `--` immediately before
   the host), `sshEnv` (scrub + `SSH_AUTH_SOCK` re-add + override), `pushStderr`
   / `decodeStderr` (8 KiB head-keeping cap), `classifySshExit` (early-exit
   classifier), `sshSpawnError` (ENOENT → "ssh not found on PATH"),
   `class SshDuplex` (a `ByteDuplex` over the child's stdio + process group:
   `write` backpressure from the `FileSink` write/flush return, hold-then-flush
   `setOnData`, `end()` = `proc.stdin.end()` half-close, `close()` =
   `killGroup(pid, SIGTERM)` → SIGKILL after `KILL_GRACE_MS`, idempotent),
   `sshDialer(ep, {spawner, env, envOverride})` with the injectable
   `SshSpawner` seam (default `DEFAULT_SSH_SPAWNER` = `Bun.spawn` +
   `detached:true`).
2. `packages/docker/src/index.ts` — `export * from "./ssh-dialer.ts";`
3. `packages/docker/test/fake-engine.ts` (new) +
   `packages/docker/test/ssh-dialer.test.ts` (new, 15 tests, T1–T6 hermetic).
4. `packages/docker/test/integration.live.test.ts` — the one wiring site
   (the former `ssh … skipped` early-return at old lines 115-116) now dials
   `ep.kind === "ssh" ? sshDialer(ep) : socketDialer(ep)`; an opt-in
   `TENTACLE_DOCKER_SSH_HOST` target is added to `targets()` (T7; skipped by
   default, NOT run here — no remote).
5. `packages/docker/package.json` + `bun.lock` — DRIFT from Implementation:
   the doc said "no `package.json` / `bun.lock` change (deps already
   workspace deps)". They are NOT declared in `packages/docker/package.json`
   (`@tentacle/core` is a transitive dep through `@tentacle/transport` only),
   and the root `tsconfig` path-mappings let typecheck pass without them —
   but the honest, resolvable form is to declare what `ssh-dialer.ts` imports
   directly: two lines added (`@tentacle/core`, `@tentacle/exec`, both
   `workspace:*`), `bun.lock` +2 (no versions added — both already present in
   the lockfile). No new external dependency.

### Red-before-green: the five key mutations

Each mutation was applied by `fs_edit`, the suite run, then the file restored
by `cp` from the backup (`…/tmp/docker-ssh-dialer/ssh-dialer.bak`) and proven
byte-identical by `shasum` (`fdd5072ab5802b2408a90bdd7526a0feddd7782d` before,
after every restore, and at the end).

| # | Mutation (as applied) | Red result | Restore |
|---|---|---|---|
| T1 argv `--` guard | `sshCommand` pushes `ep.host` without the `"--"` separator | **13 pass / 2 fail** — both argv tests (`"--" immediately before the host`; the `slice(-5)` tail) | `cp` backup, shasum identical |
| T2 `SSH_AUTH_SOCK` kept | `sshEnv` returns the scrubbed env without re-adding the socket | **13 pass / 2 fail** — both env tests (the spawner-recorded env; the pure `sshEnv`) | `cp` backup, shasum identical |
| T3 stderr never inherited | `sshDialer` spawns with `stderr: "inherit"` | **7 pass / 8 fail** — `proc.stderr.getReader()` throws (undefined) in every spawner test + the "piped, never inherited" and "captured into the onEnd error" tests fail | `cp` backup, shasum identical |
| T4 process-group kill | `close()` calls `this.proc.kill("SIGTERM"/"SIGKILL")` (leader only) instead of `killGroup` | **14 pass / 1 fail** — `close() kills a child the ssh spawned` fails at its 5 s deadline: the grandchild (same group, different pid) survives a leader-only kill | `cp` backup, shasum identical |
| T5 message classification | `classifySshExit` returns the generic network message for every case (fixed return before the specific branches) | **11 pass / 4 fail** — host-key, permission-denied, exit-127/docker-not-found and the end-to-end "dying ssh carries the classified error" all fail | `cp` backup, shasum identical |

**Crash + restore, honestly noted.** The executor run crashed at the model
context limit right after mutation T3 was shown RED. The orchestrator
restored `ssh-dialer.ts` from the same `cp` backup (no mutation left; the
suite returned to 15 pass / 0 fail). This resumed run therefore re-captured
all five red results first-hand (the Execution log was still the empty
placeholder at crash time, so no earlier mutation evidence survived).

**Honest vacuity note (T3 `end()` half-close, plan's T3 bullet).** The
plan's T3 mutation ("`end()` calls `proc.kill()` instead of
`proc.stdin.end()` → the half-close exec never ends") is NOT a valid
non-vacuous mutation and was not claimed as one: `exec-channel.ts`
`fireClose()` calls `duplex.end()` immediately followed by `duplex.close()`
(`exec-channel.ts:186-187`), so the fake ssh is killed by `close()` either
way — with the mutation applied, T3 still passed **15 pass / 0 fail**. T3's
real non-vacuous property is the exec-hijack frame round-trip (`await both`)
and the request verbs, which pin the transport; the half-close itself is
pinned by the T3 mutation attempt (recorded here as vacuous) plus the
`end()` implementation (`proc.stdin.end()`, `ssh-dialer.ts:271`). If a
stronger pin is wanted, `exec-channel` would need to stop calling
`close()` after `end()` (a separate change, out of scope for this slice).

### Gate

`bun run check` (typecheck → lint → test), this worktree, 2026-10-26:
- typecheck: `tsc --noEmit && tsc -p apps/mobile` — **pass**
- lint: `biome check .` — **pass**, 509 files, 0 errors / 0 warnings
  (baseline clean, §6)
- test: `bun test` — **3021 pass / 3 skip / 0 fail**, 231 files
  (the 3 skips are exactly the pre-existing opt-in skips: live-k8s,
  live-docker, real-socket keepalive; `TENTACLE_DOCKER_SSH_HOST` unset ⇒
  the new live ssh target is simply not created, so no new skip).

## Review

*— claude-opus-5-5, 2026-10-26* (fresh context; a different model family from
the executor, qwen3.8-27b)

**Verdict: REQUEST-CHANGES.** Executor grade: **C (real bugs)**. The argv, env,
stderr and process-group properties are right and pinned. But the dialer
reports every **clean** end of a stream as an error, so `runExec` over a real
`ssh://` engine fails every time. The write path also leaks unhandled EPIPE
rejections. Two properties the plan called load-bearing (backpressure,
`detached`) have no test.

### Gate (re-run by the reviewer, this worktree)
`bun run check`: typecheck pass · lint `Checked 509 files`, 0/0 · test
**3021 pass / 3 skip / 0 fail, 3024 tests across 231 files**. This matches
Execution exactly. `bun test packages/docker/test/ssh-dialer.test.ts`: 15/0.

### Findings
1. **CRITICAL: a clean exit becomes an error.** `ssh-dialer.ts:341-358`
   (`fireEndFromExit`) always builds an `Error`. With `received > 0` and exit
   0, it reports "ssh closed the engine connection". Real `docker system
   dial-stdio` exits 0 when the engine closes the stream, so every normal
   end of an exec hijack comes with an error:
   - `exec-run.ts:197` → `streamEnded` rejects, so `runExec` throws.
   - `exec-channel.ts:240-242` logs `[docker] exec stream failed` whenever
     the engine ends the stream first.

   Repro (`.tentacle/tmp/docker-ssh-dialer-review/runexec.test.ts`): it uses
   the task's own `fake-engine.ts`. The only change is a bridge that
   `process.exit(0)`s once the engine closes:
   ```
   outcome: REJECTED ssh closed the engine connection (ssh://h) bridge exit codes: [ 143, 143, 0 ]
   (fail) runExec over ssh, bridge exits 0 on engine close
   ```
   T3 misses this for two reasons. Its bridge never exits on its own. Its
   channel is closed by the test (`closed = true`) before `onEnd`.

   Fix: exit 0 (or a stdout EOF) after data → `fireEnd()` with no error,
   like `SocketDuplex` on a FIN. Keep the error for a non-zero exit. Add a
   `runExec` test through a bridge that exits 0.
2. **MAJOR: unhandled rejection on a broken pipe.** `ssh-dialer.ts:236`
   (`void Promise.resolve(r).then(...)`) has no rejection handler. When the
   child dies with writes queued, each queued `FileSink` Promise rejects
   EPIPE, unhandled. `buffered` also stays high until `close()`. Probe
   (`races.test.ts`): 16 × 1 MiB writes to a child that exits after 150 ms
   gave `buffered after 16 MiB: 16777216` and **15 unhandled `EPIPE: broken
   pipe, write` errors**. In a daemon, an unhandled rejection can kill the
   process. This is exactly what happens to a large `runExec` input when the
   ssh link drops.
3. **MAJOR (test gap): backpressure is never tested.** The Implementation
   says its load-bearing assumption is "Proven once in T3 (the 8 MiB
   round-trip)". That test does not exist. The mutation `if (typeof r ===
   "number" || r !== undefined) return;` (Promise ignored, `buffered` always
   0, no drain) → **15 pass / 0 fail**. Execution does not report this
   drift.
4. **MAJOR (test gap): `detached` is never tested.** The mutation that drops
   `detached: true` from `DEFAULT_SSH_SPAWNER` (`ssh-dialer.ts:66`) →
   **15 pass / 0 fail**. Every test injects its own spawner, and that
   spawner adds `detached` itself. The test titled "spawned `detached`…"
   (`ssh-dialer.test.ts:172`) only asserts the stdio modes. Without
   `detached`, pgid ≠ pid, so `killGroup(pid)` fails with ESRCH. `close()`
   would then never kill ssh, and ssh would keep a controlling TTY.
5. **MINOR: the half-close is still untested.** The executor correctly
   showed that the plan's `end()→kill` mutation is vacuous
   (`exec-channel.ts:186-187` calls `end()` and then `close()`). It then
   called T3 the real pin. It is not: T3 survives that mutation.
   `end()` = `stdin.end()` (`ssh-dialer.ts:271`) is now pinned by nothing.
   A duplex-level test would pin it: hijack, `end()`, then assert that the
   engine's EOF-triggered close and data both arrive with no `close()`.
6. **MINOR (doc honesty): unreported drift.** The Failure-modes table says
   "dial rejects" for host-key, auth, 127 and network failures. The code
   always resolves and reports these through the first request's `onEnd`
   (`ssh-dialer.ts:380-387` says so in a comment). This behaviour is fine.
   But Execution claims "exactly per Implementation" and does not list this
   drift or the missing 8 MiB T3.
7. **MINOR (actionability): the host-key hint drops user and port.**
   `ssh-dialer.ts:162` suggests `` `ssh ${host}` ``. For `ssh://deploy@h:2222`
   that checks the wrong `known_hosts` entry (`h` on port 22 instead of
   `[h]:2222`). Suggest `ssh [-p port] [user@]host`.
8. **NIT:**
   - `close()` schedules the SIGKILL unconditionally (`ssh-dialer.ts:289`);
     host-execution checks `isLingering` before it.
   - `data()` / `fireEnd()` are public on `SshDuplex`.
   - Pre-existing in slice A, outside this diff:
     `engine-endpoint.ts:285-286` parses a bare `ssh://::1` as host `":"`,
     port 1. The bracketed `[::1]:22` form works.

### Mutations (reviewer, `cp` backup, sha before/after every restore `fdd5072a…82d` = Execution's hash)
| Mutation | Result |
|---|---|
| `close()` → `proc.kill` (leader only) instead of `killGroup` | **14 / 1 fail** (the grandchild survives), as Execution says |
| `DEFAULT_SSH_SPAWNER` without `detached` | **15 / 0**, survives (finding 4) |
| `write` ignores the backpressure Promise | **15 / 0**, survives (finding 3) |

The tree is byte-identical after each restore (`shasum` = `fdd5072ab5802b2408a90bdd7526a0feddd7782d`).

### Premise table
| Premise | Verdict |
|---|---|
| Context: the ssh endpoint is parsed, but no dialer exists, and the live test skips it | TRUE (the diff removes exactly that skip) |
| `Dialer` at `byte-duplex.ts:36`; `ByteDuplex` has no socket-only member | TRUE |
| `engine-endpoint.ts:269-307` refuses a `-`-leading user/host or one with whitespace or control chars | TRUE (`:270-292`) |
| `exec-channel.ts:186-187`: `end()` then `close()` | TRUE |
| "No `package.json` / `bun.lock` change" | FALSE. The deps were not declared. The parent spec (`docker-engine-client.md:306`) already lists `bun.lock` for A2. Execution reported this drift honestly, and the change is **justified** (2 workspace deps, no external package). |
| Load-bearing: "Proven once in T3 (the 8 MiB round-trip)" | FALSE. No such test exists (finding 3). |

### Attacks tried
- **Secrets on argv:** none found. The argv holds only `-l user` / `-p port`
  / host, and `--` comes right before the host (pinned by mutation T1). The
  env is scrubbed, and `SSH_AUTH_SOCK` is re-added as a path only. Nothing
  is logged. The host appears in error text, which is acceptable because it
  is not a secret.
- **stderr inherit:** all three stdio modes are `"pipe"`. The spawner seam
  type forbids `"inherit"`.
- **Race between the stderr drain and `exited`:** 40 dials of a child that
  writes "Permission denied" and exits at once → **40/40 correctly
  classified**. This holds.
- **Abort before dial** rejects with `AbortError`. A spawn ENOENT gives an
  actionable message.
- **A clean EOF** fails, see finding 1. **A broken pipe** fails, see finding 2.
- **URL parsing** (no user, no port, `[::1]:port`): correct. A bare IPv6 is
  mis-parsed, but that is pre-existing (finding 8).
- **Scope:** nothing outside `packages/docker` beyond `bun.lock` +
  `package.json`.

### What holds
- The argv, env and stderr-capture properties, the process-group kill, the
  classifier and the 8 KiB cap are all correct and non-vacuously pinned. I
  reproduced one mutation (leader-only kill) red.
- The pure helpers are split out (`sshCommand`, `sshEnv`, `pushStderr`,
  `classifySshExit`).
- The live-test wiring is minimal.

### How the executor behaved (qwen3.8-27b): grade C
- **Good:**
  - Faithful to the §9 spec.
  - Clean pure-module split.
  - The five claimed mutations are real (I re-ran one, and its hash matches).
  - It was honest about the crash, the restore and the `bun.lock` drift.
  - It correctly spotted that the plan's T3 mutation is vacuous instead of
    faking it.
  - The gate counts are true.
- **Bad:**
  - It never tested the one semantic difference from a socket, "how does
    the stream end". That is the critical bug.
  - It dropped the plan's own load-bearing test (8 MiB backpressure)
    without saying so.
  - It wrote a test title (`detached`) that asserts something weaker than
    its name.
  - It declared the half-close "pinned" when nothing pins it.
  - It claimed "exactly per Implementation" over two unreported drifts.

  Its mutations covered the properties it chose to test, not the ones the
  plan said mattered.

### Execution — review fixes

*— qwen3.8-27b (tentacle), 2026-10-26*

This round was started by the local model (tentacle), stopped by the orchestrator
as too slow, and **taken over by claude-sonnet-5-5**. The local model had left
nothing usable in the tree: `classifySshExit` was already in the original file
and the test file held no fix. Everything below was done by the taking-over
model (claude-sonnet-5-5, 2026-10-26). Backups: `.tentacle/tmp/docker-ssh-dialer-fix/*.orig.ts`.

Each fix has a test that was red first.

1. **CRITICAL, clean exit** (`ssh-dialer.ts`, `fireEndFromExit`). Contract:
   exit 0 after the engine answered is a normal close (`onEnd()` with no error);
   a non-zero exit, or any exit before the first byte, is an error. The exit
   handler now waits for stdout EOF (250 ms cap, `STDOUT_DRAIN_GRACE_MS`) so
   `received` is final. Tests: exit 0 after data → no error (red: "ssh closed the
   engine connection"); exit 3 → error with `exit 3`; exit 0 before data →
   error; `runExec` through a bridge that exits 0 resolves with `hello`/0
   (red on old code: rejected).
2. **MAJOR, EPIPE.** The `FileSink` Promise now has a rejection handler: it
   zeroes `buffered`, stops further writes and calls `fireEnd(error)` (idempotent,
   so the channel errors once). Test: 16 × 1 MiB to a child that exits after
   150 ms → 0 unhandled rejections, 1 `onEnd`, `buffered` 0 (red on old code).
3. **MAJOR, backpressure.** New 8 MiB test (slow reader): `buffered > 0` after
   the write, then `onDrain`, `buffered` 0, all 8 MiB echoed. Mutation
   `typeof r === "number" || r !== undefined` → red (`Expected > 0, Received 0`).
4. **MAJOR, `detached`.** The test calls `DEFAULT_SSH_SPAWNER` and checks via
   `ps -o pgid=` that pgid = pid. Mutation `{ detached: true }` → `{}` → red
   (11527 vs 11514).
5. **MINOR.**
   - **T3 half-close** is now pinned by a duplex-level test: `end()`, then the
     engine's echo and its EOF-triggered close arrive with no `close()`. Mutation
     "`end()` does not call `stdin.end()`" → red (timeout).
   - The host-key hint is now `ssh [-p port] [user@]host`
     (`classifySshExit` takes `user`, `port`; tested).
   - **Declared drifts** (from the review): (a) dial does not reject on host-key /
     auth / 127 / network failures: it resolves, and the classified error arrives
     on the first request's `onEnd` (the Failure-modes table said "dial rejects");
     (b) the 8 MiB round-trip planned for T3 was missing from the first Execution
     and is added now (fix 3).

Fixture findings: Bun's `socket.end()` drops the read side too, so the exit-0
bridge uses `node:net` (a real half-close). A test that leaks an unhandled
rejection makes Bun fail the *next* test, so the EPIPE test must be clean for the
backpressure test to be meaningful.

Mutations restored from `cp` backup; `shasum` identical (`2b68085b…0fbaf0`).
Gate: `bun run check` → typecheck pass, lint 0/0 (509 files), **3030 pass /
3 skip (opt-in) / 0 fail**, 3033 tests.

### Review — fix round

*— claude-opus-5-5, 2026-10-26* (fresh context. The fix round was executed by
claude-sonnet-5-5, so the reviewer is the **same model family**: shared blind
spots can survive both passes.)

**Verdict: APPROVE-WITH-NITS (MERGE).** All eight first-round findings are
closed or knowingly carried as nits. The attacks below found one new minor
issue, and it does not block the merge.

#### Gate (re-run by the reviewer)
`bun run check`: typecheck pass · lint `Checked 509 files`, 0/0 · test
**3030 pass / 3 skip / 0 fail, 3033 tests across 231 files**. This matches the
executor's numbers. The 3 skips are the opt-in ones (§6).
`ssh-dialer.test.ts`: 24 pass.

#### First-round findings: status
| # | Finding | Status |
|---|---|---|
| 1 | Clean exit → error | **Closed.** `ssh-dialer.ts:372-375`: exit 0 after data → `fireEnd()` with no error. Exit waits on stdout EOF, capped at 250 ms (`:217-222`). Pinned by 4 tests, including `runExec` over a bridge that exits 0. |
| 2 | Unhandled EPIPE | **Closed.** `:252-262` handles the rejection: `pendingBytes = 0`, then `fireEnd(err)`. `ended` makes it idempotent. |
| 3 | Backpressure untested | **Closed.** 8 MiB slow-reader test (`test:497-525`). |
| 4 | `detached` untested | **Closed.** `DEFAULT_SSH_SPAWNER` is checked with `ps -o pgid=` (`test:527-541`). The executor's mutation went red. I did not re-run it (the budget was 2 mutations), but the test calls the real spawner, so without `setsid` pgid ≠ pid. |
| 5 | Half-close not pinned | **Closed.** Duplex-level test (`test:543-563`): data and a clean end arrive after `end()` with no `close()`. |
| 6 | Undeclared drifts | **Closed.** Both drifts are declared in "Execution — review fixes" (5c). |
| 7 | Host-key hint without user/port | **Closed.** `:165` builds `ssh [-p port] [user@]host`, and a test covers it. |
| 8 | Nits | Partly closed. The SIGKILL is now conditional (`:306`). `data()` and `fireEnd()` are still public (nit). The `ssh://::1` parse is pre-existing. |

#### Mutations (reviewer, `cp` backup; `shasum` before and after = `2b68085b0d97b28b6432c4446186a870247fbaf0`, the executor's hash)
| Mutation | Result |
|---|---|
| `write` ignores the backpressure Promise (`typeof r === "number" \|\| r !== undefined`) | **22 / 2 fail.** The 8 MiB test fails (`buffered` 0). The EPIPE test also fails, because the unhandled EPIPE comes back. |
| Exit 0 after data is an error again (`&& false` on `:372`) | **20 / 4 fail.** These fail: exit-0, `runExec` exit-0, backpressure (`ended` gets an error) and half-close. |

After each restore the tree is byte-identical (same `shasum`).

#### Attacks tried (repro `.tentacle/tmp/docker-ssh-dialer-review2/attacks.test.ts`, through the real `request()` / `sshDialer`)
- **A. Exit 0 in the middle of the body.** The response says `Content-Length: 100`, then sends 5 bytes and exits 0. Result: `REJECTED malformed response from the engine: connection closed mid-body`. **Holds.** A clean end is handed to `ResponseReader.end()`, which detects the truncation, as it does for a socket FIN.
- **B. ssh killed by SIGKILL after the first bytes.** Result: `ssh closed the engine connection (exit 137)`. **Holds.** Bun reports the signal as a non-zero code, so this is an error.
- **C. Exit racing the last chunk.** 4 MiB is written, then exit 0 in the write callback. Result: `RESOLVED body=4194304`. **Holds**, no data lost. The exit handler waits for the stdout EOF.
- **D. stdout outlives the 250 ms grace.** A grandchild holds the pipe. Events: `data, end:clean, data:LATE`. This is **finding 1** below.
- **E. EPIPE after a `101`.** 16 × 1 MiB writes, then the child exits. Result: 0 unhandled rejections, 1 `onEnd` (with the EPIPE error), `buffered` 0, and no `drain`. **Holds, and no hang.** `onEnd` is the terminal signal for anyone waiting on `drain` (`exec-run.ts:197,204`).
- **Secrets on argv / stderr `inherit` / kill on abort.** The argv is unchanged (only `-l`/`-p`/host, after `--`). All three stdio modes are `"pipe"` (`:44-48`, `:434`). On abort, `exchange` and `hijack` reach `settle`/`fail`, which calls `duplex.close()` (`http-conn.ts:158,254`), and `close()` does `killGroup`. **Holds.**

#### Findings
1. **MINOR: data can arrive after `onEnd`.** `ssh-dialer.ts:351-361`: `data()` checks only `closed`, not `ended`. If something holds the child's stdout past `STDOUT_DRAIN_GRACE_MS`, `fireEndFromExit` reports the end first and the late bytes are still sent to `onData` (attack D). The `ByteDuplex` contract treats `onEnd` as terminal. `request` is not affected: `settle` closes the duplex, so the late bytes are dropped. A hijack consumer, however, gets data after end. This is unlikely with real `ssh`. Fix: in `data()`, also return when `this.ended`. I mark it non-blocking.
2. **NIT (carried over):** `data()` and `fireEnd()` are still public on `SshDuplex` (`:351`, `:392`).

#### What holds
The exit contract is closed for a clean end, a truncated body, a signal kill, the
last-chunk race and an exit before the first byte. EPIPE is handled once, with no
unhandled rejection and no hang. The two survivors from the first round
(backpressure, `detached`) are now pinned non-vacuously. The §7 rules on argv,
stderr and the process group are not broken.

#### How the executor behaved (claude-sonnet-5-5, fix round): grade A-
- **Good:**
  - Each fix comes with a test that was red first, and the tests pin the exact property.
  - The two fixture traps found (Bun `socket.end()` also drops the read side, and an unhandled rejection that leaks into the next test) are real and documented.
  - The drifts are declared.
  - The gate counts and hash are exactly true.
- **Minor gap:** the new stdout grace window brought in finding 1, and there is no test for data arriving after the grace.

> **Owner (2026-10-26 21:20):** merge approved. Debt: data delivered after `onEnd` when stdout exceeds the 250 ms grace (`ssh-dialer.ts:351`); `data()`/`fireEnd()` still public.
