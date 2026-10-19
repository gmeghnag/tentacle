# eval/background-process-groups — kill whole process groups, and never let a job outlive tentacle

> **Status:** approved — ready to promote and execute (2026-10-19). To start: `git mv docs/eval/background-process-groups.md docs/fix/background-process-groups.md`, branch `fix/background-process-groups` off `main`, follow **Implementation** (it is the approved plan), fill **Execution**.
> **Branch:** none yet — `fix/background-process-groups` is opened on promotion (AGENTS §10)
> **Type:** eval → fix · **Size:** S–M · **Blast:** load-bearing (touches how the worker, `serve` and the stdio pod daemon terminate) · **Suited:** strong model executes; mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-19*

**What is broken.** Tentacle starts shell commands as `/bin/sh -c <command>` and
"kills" them with `proc.kill()`, which signals **only the `sh` process**
(`packages/exec/src/host-execution.ts:87` for foreground `exec`,
`:144` for `spawnBackground`). Anything `sh` started — the second half of
`a && b`, a pipeline, `npm run dev`'s node child — is re-parented to PID 1 and
keeps running. Separately, **nothing kills background jobs when tentacle
exits**: `BackgroundJobs` (`packages/exec/src/background.ts:77`) has `kill(id)`
(`:111`) and no way to kill everything; no exit handler touches it.

This is task 1 of `docs/eval/daemon-session-lifecycle.md` (CONFIRMED there,
repro 4 and repro 1), and step 1 of the protocol-v2 plan
(`docs/eval/session-reattach.md`, children table). It is self-contained: an
executor needs only this doc and AGENTS.md.

**Why the exit net is in this task, not later.** The lifecycle eval warned
(`daemon-session-lifecycle.md:172`): once children are `detached` (own process
group), they no longer receive the terminal's SIGINT/SIGHUP, so the explicit
teardown becomes the **only** safety net — "land both together". The original
task 2 (session close) has since moved into the v2 redesign
(`session-registry`, `session-ttl-limits`), which lands much later. Shipping
process groups alone would make things **worse** than today: today Ctrl+C or
closing the terminal at least reaches the direct children through the
terminal's process group; after, every background job would survive
everything. So this task must also bring the process-exit net and job disposal
on connection close.

**Repro (evidence).** From `daemon-session-lifecycle.md` (2026-10-17, real
`BackgroundJobs` + `HostExecution`): `jobs.start("sleep 30009; echo done")`
then `jobs.kill(id)`:

```
kill(): true
status: killed
grandchild still alive: 63497
  PID  PPID COMMAND
63497     1 sleep 30009
```

And repro 1 there: after `Connection.close()` and parent exit, both
`sleep 3000N` children are alive with PPID 1.

**Facts verified for this plan** (2026-10-19, bun 1.4.3, macOS; scripts in
`.tentacle/tmp/background-process-groups/`, gitignored — pasted here):

```ts
// pgid.ts — can Bun put a child in its own process group; does group-kill reach grandchildren?
const a = Bun.spawn(["/bin/sh", "-c", "sleep 31001; true"], { detached: true } as never);
await Bun.sleep(200);
const pa = Number((await Bun.$`ps -o pgid= -p ${a.pid}`.text()).trim());
console.log(`Bun.spawn detached: child pgid=${pa} own=${pa === a.pid}`);
process.kill(-a.pid, "SIGTERM");
await Bun.sleep(300);
console.log("left:", (await Bun.$`pgrep -fl "sleep 31001"`.nothrow().text()).trim() || "none");
```
```
Bun.spawn detached: child pgid=93270 own=true parent pgid=93262
node spawn detached: child pgid=93273 own=true
left: none
```

```ts
// worker-sig.ts + w.ts — does process.on("exit") registered INSIDE a Bun Worker
// fire when the main process ends? (w.ts appends a line to a log in its exit handler)
```
```
process.exit() from main      -> worker exit handler fired
bare SIGTERM  (no handler)    -> worker exit handler fired
bare SIGHUP   (no handler)    -> worker exit handler fired
SIGTERM/SIGHUP with handler   -> worker exit handler fired
```

So: (1) `Bun.spawn(..., { detached: true })` gives the child its own process
group (pgid = child pid) — the option is not in Bun's TS types, hence the cast;
(2) `process.kill(-pgid, sig)` reaches the grandchild; (3) an exit handler
registered inside the worker thread — where `BackgroundJobs` lives on the
default path — fires on the main process's exit, SIGTERM and SIGHUP. SIGKILL of
tentacle cannot be caught by anything; out of scope.

## Implementation

*— claude-opus-5-5, 2026-10-19 (approved plan; the executor verifies it against the code and records drift in Execution)*

### Load-bearing assumption

`process.kill(-pgid)` from an exit handler running in **whatever thread owns the
jobs** kills every live job group when tentacle exits. Verified above for Bun
1.4.3 (worker exit handler fires on `process.exit`, SIGTERM, SIGHUP). The
executor re-runs the two scripts first; if either result differs, STOP and
report (§0) — the design below depends on it.

### Preconditions

- Children are spawned only via `HostExecution.exec` and
  `HostExecution.spawnBackground` (`host-execution.ts:79,130`); verify with
  `rg "Bun.spawn|spawn\(" packages --glob '!**/test/**'` that no other spawn
  path runs model-requested commands (MCP stdio servers are a separate
  lifecycle — leave them).
- `BackgroundJobs` is created per session by `buildAgent`
  (`cli/src/wiring.ts:86`) and handed to the daemon via the `AgentFactory`
  (`daemon/src/session-host.ts`), so `HostedSession` already receives `jobs`.
- `Connection.close()` (`daemon/src/connection.ts`) runs on ws close
  (`ws-server.ts:193-195`) and stdio EOF (`cli/src/serve.ts`).

### Design

1. **Own process group for every spawned shell.** `HostExecution.exec` and
   `spawnBackground` pass `detached: true` to `Bun.spawn`. A single helper
   `killGroup(pid, signal)` does `process.kill(-pid, signal)` and swallows
   `ESRCH` (group already gone).
2. **Kill = group kill with escalation.** `BackgroundHandle.kill()` and the
   foreground `exec` timeout/abort path send `SIGTERM` to the group, then
   `SIGKILL` to the group after a grace period (proposal 2 s, a constant) if the
   leader has not exited. The foreground path keeps returning `exitCode ?? 124`
   as today.
3. **`dispose()` on the job controller.** Add `dispose(): void` to
   `JobController` (`core/src/jobs.ts`) and implement it in `BackgroundJobs`:
   group-kill every running job (same escalation) and mark them killed.
   Idempotent.
4. **Process-exit net, in the exec module.** A module-level registry of live
   process-group ids (added on spawn, removed on exit) and **one**
   `process.on("exit")` handler, installed lazily on first spawn, that
   synchronously sends `SIGKILL` to every registered group. SIGKILL, not TERM:
   an exit handler cannot wait for a grace period; orderly shutdown is
   `dispose()`'s job, this is the last resort. Living in the exec module means
   it runs in the thread that owns the jobs (the worker on the default path,
   the main thread for `--in-process`, the daemon process for `serve` / stdio),
   with no cross-thread plumbing.
5. **Signals reach the exit net.** Verified that SIGTERM/SIGHUP already trigger
   `exit` in Bun 1.4.3. Do **not** add new SIGINT handling: the TUI owns Ctrl+C
   in raw mode and exits via `process.exit`, which triggers the net. If the
   executor finds a path that terminates without `exit` firing, add a minimal
   handler there and record it in Execution.
6. **Jobs die with their connection (today's semantics).** `Connection.close()`
   calls `dispose()` on each hosted session's jobs, after `cancel()`.
   `HostedSession` keeps the `jobs` reference it already receives and exposes
   `disposeJobs()`. v2 note: `session-registry` later replaces this with
   "detach instead of close"; until then a session dies with its connection, so
   its jobs must too.

### Files

`core/src/jobs.ts` (interface: `dispose`) → `exec/src/host-execution.ts`
(`detached`, group kill + escalation, registry + exit handler — or a small new
`exec/src/process-group.ts` if that keeps `host-execution.ts` readable) →
`exec/src/background.ts` (`dispose`) → `daemon/src/hosted-session.ts`
(`disposeJobs`) → `daemon/src/connection.ts` (`close` disposes). Any
`JobController` fake in tests gains a no-op `dispose`.

### Failure modes

- **Group already gone** (job exited between check and kill) → `ESRCH`
  swallowed; never throw from a kill path or from the exit handler.
- **Process ignores SIGTERM** → escalation to SIGKILL after the grace period;
  the exit net uses SIGKILL directly.
- **A command that itself calls `setsid` / daemonizes** (`nohup … &`,
  `docker run -d`) leaves our group on purpose; we cannot and should not chase
  it. Document as a known limit.
- **pid reuse**: the registry removes a group on the leader's exit, so the net
  never signals a recycled pgid.
- **Foreground `exec` loses the terminal's Ctrl+C**: fine — the TUI is in raw
  mode and cancels via the abort signal, which now group-kills.
- **`/clear` without disconnect** still leaves the previous session's jobs
  running until the connection closes or tentacle exits. Known residual;
  closed by `session/close` in the v2 `session-registry` child.
- **Two `exit` handlers per test process** (many `HostExecution`s in one test
  run): the lazy single install prevents handler pile-up; assert it in a test.
- **Pod modes**: the same code runs inside the pod (`serve --stdio`), so a pod
  daemon's exit also kills its job groups. `attach` pods are user-owned: this
  only cleans up what *we* started there.

### Tests

Red before green (§9), on the exact property: **after the operation, no
process from the job's process tree is alive** — not "kill returned true".
Use a unique marker per test (`sleep 3<random>`), check with `pgrep -f`, and
clean up in `afterEach` with `pkill -f` so a red run does not leak.

1. `BackgroundJobs.kill` on `sleep N; true` → no `sleep N` alive. Red today
   (repro 4).
2. Foreground `exec("sleep N; true", { timeoutMs: 200 })` → after it returns,
   no `sleep N`. Same with an aborted `signal`.
3. `dispose()` with two running jobs → none alive; second `dispose()` is a
   no-op.
4. **Exit net:** spawn a child Bun process (a fixture script) that starts a
   background job and then calls `process.exit(0)` (variant: is sent SIGTERM)
   → `sleep N` not alive afterwards. Red today (repro 1).
5. Escalation: a job that traps TERM (`trap '' TERM; sleep N`) is gone after
   the grace period.
6. `Connection.close()` disposes the hosted session's jobs (daemon integration
   test with a real `BackgroundJobs`).

Non-vacuity by mutation: revert `detached` (or kill `pid` instead of `-pid`)
→ tests 1, 2, 4 must fail; remove the exit handler → test 4 must fail.

### Why, item by item

- **Why process groups.** `sh -c` is the leader of everything the command
  starts. Signalling only `sh` (today) leaves its children orphaned — repro 4.
  A group kill is the only POSIX way to reach the whole tree without walking
  `ps` output (racy, platform-specific).
- **Why foreground `exec` too.** Same bug, different trigger: Esc or a timeout
  on `npm test` kills `sh` and leaves the test runner's workers running,
  holding CPU and ports. One helper fixes both.
- **Why SIGTERM then SIGKILL.** TERM lets dev servers and test runners clean up
  (temp files, sockets); some processes ignore it, so a bounded escalation
  guarantees the kill actually happens.
- **Why `dispose()` on the interface.** Callers above `exec` (daemon, later the
  v2 registry and TTL reaper) need "end everything this session started"
  without knowing job ids. Putting it on `JobController` makes it the seam the
  v2 children reuse instead of reinventing.
- **Why the exit net lives in the exec module.** It must run in the thread that
  owns the jobs. The default path runs them in a Worker; a net in the main
  thread could not see the worker's pgids without new cross-thread messaging.
  The experiment shows the worker's own exit handler fires on the main
  process's exit and signals, so a module-level registry + handler covers
  worker, `--in-process`, `serve` and stdio with one piece of code.
- **Why SIGKILL in the exit handler.** An `exit` handler must be synchronous;
  it cannot wait for a grace period. Without SIGKILL, a process that ignores
  TERM survives tentacle — exactly the leak we are closing.
- **Why it must land with process groups (not later).** `detached` removes the
  terminal's implicit cleanup; without the net this task would increase
  orphans — the regression the lifecycle eval warned about (`:172`).
- **Why `Connection.close()` disposes now, though v2 will change it.** Today a
  session is unreachable once its connection is gone, so its jobs are
  unmanaged by definition. v2 changes the session's lifetime and will move
  disposal to session close/TTL accordingly; this is the correct behaviour for
  the code as it is.
- **Why not chase `setsid`/daemonized processes.** A command that deliberately
  leaves the group asked to outlive its parent; chasing it would require
  tracking arbitrary descendants and could kill things the user started on
  purpose.

## Execution

*(empty — filled by the executor after promotion)*

## Review

*(empty — mandatory fresh-context Review after Execution: blast is load-bearing)*
