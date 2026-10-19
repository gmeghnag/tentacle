# fix/background-process-groups — kill whole process groups, and never let a job outlive tentacle

> **Status:** approved, **revised** (2026-10-19) — the exit net moved to the main thread after the executor's pre-flight check falsified the original load-bearing assumption (see *Revision* in Context). Follow **Implementation**, fill **Execution**.
> **Branch:** `fix/background-process-groups`
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

So: (1) `Bun.spawn(..., { detached: true })` gives the child its own process
group (pgid = child pid) — the option is not in Bun's TS types, hence the cast;
(2) `process.kill(-pgid, sig)` reaches the grandchild. SIGKILL of tentacle
cannot be caught by anything; out of scope.

### Revision — the worker's exit handler does NOT fire when it holds a child

*— claude-opus-5-5, 2026-10-19 (finding by the executor, Qwen3 27B, during the
mandatory pre-flight re-run; reproduced independently before revising)*

The original plan put the exit net in the thread that owns the jobs (the
Worker on the default path), on the strength of a `worker-sig.ts` experiment
whose worker **spawned nothing**. That proved a weaker property than the one
the design needs (§2): with a **live child** — the real case, a running
background job — the worker's `process.on("exit")` handler does not run.

```ts
// fmain.ts — main: start a worker, exit 250 ms after it reports ready
const w = new Worker(new URL(`./${process.argv[2]}`, import.meta.url).href);
w.onmessage = () => setTimeout(() => process.exit(0), 250);

// fchild.ts — worker: exit net + one live detached child
import { appendFileSync } from "node:fs";
const log = new URL("./f.log", import.meta.url).pathname;
const note = (s) => appendFileSync(log, s + "\n");
let jobPid = 0;
process.on("exit", () => { note("EXIT-NET"); try { process.kill(-jobPid, "SIGKILL"); note("KILLED"); } catch (e) { note("ERR"); } });
const p = Bun.spawn(["/bin/sh","-c","sleep 50001; true"], { detached: true, stdout: "ignore", stderr: "ignore" } as never);
jobPid = p.pid; postMessage("ready");

// fnochild.ts — worker: same exit net, no child
```
```
fchild.ts:   (log empty — handler never ran)
fnochild.ts: EXIT-NET
pgrep: 18214 /bin/sh -c sleep 50001; true / 18215 sleep 50001   ← leaked
```

The executor's end-to-end run with the real modules (real Worker + Connection +
`BackgroundJobs`/`HostExecution`, torn down exactly like
`LocalRuntime.dispose()`) confirms it: job alive after dispose, and the
daemon's `Connection.close()` ran **0 times** — `disposeTransport` is just
`worker.terminate()` (`cli/src/local-runtime.ts:215`), so on the worker path
nothing ever calls `Connection.close()`. `worker.terminate()` does not run the
worker's exit handler either (with or without a child).

What does hold — a `new Worker` shares the OS process with the main thread, so
a **main-thread** exit handler can kill a group the worker spawned, given its
pgid over the existing object side-channel:

```ts
// bpg-mainnet/main.ts
const w = new Worker(new URL("./w.ts", import.meta.url).href);
let pgid = 0;
process.on("exit", () => { try { process.kill(-pgid, "SIGKILL"); console.log("MAIN-NET killed", pgid); } catch (e) { console.log("ERR", e); } });
w.onmessage = (e) => { pgid = e.data.pgid; setTimeout(() => { if (process.argv[2] === "term") w.terminate(); process.exit(0); }, 250); };

// bpg-mainnet/w.ts
const p = Bun.spawn(["/bin/sh","-c","sleep 50002; true"], { detached: true, stdout: "ignore", stderr: "ignore" } as never);
postMessage({ pgid: p.pid });
```
```
MAIN-NET killed 18295
exit alive: 0          (main process.exit)
MAIN-NET killed 18303
term alive: 0          (worker.terminate() then process.exit — LocalRuntime.dispose order)
```

Also verified: `isMainThread` from `node:worker_threads` is `true` on the main
thread and `false` inside a Bun Worker (bun 1.4.3).

| Net location | Teardown | Fires? |
|---|---|---|
| worker, no child | main `process.exit` | yes (the original, misleading test) |
| worker, live child | main `process.exit` | **no** |
| worker, any | `worker.terminate()` | **no** |
| main, pgid forwarded from worker | `process.exit`, with or without `terminate()` first | **yes** |

## Implementation

*— claude-opus-5-5, 2026-10-19 (approved plan, revised the same day: item 4 and its tests/rationale; the executor verifies it against the code and records drift in Execution)*

### Load-bearing assumption

`process.kill(-pgid)` from a `process.on("exit")` handler on the **process's
main thread** kills every live job group when tentacle exits — including
groups spawned by the Worker, whose pgids reach the main thread over the
existing object side-channel — even while those children are alive and even
after `worker.terminate()`. Verified above (*Revision*: `bpg-mainnet`, both
`exit` and `term` variants → 0 alive). The executor re-runs `pgid.ts` and both
`bpg-mainnet` variants first; if any result differs, STOP and report (§0).
The thread that owns the jobs is **not** a valid home for the net on the worker
path (*Revision*: `fchild.ts`).

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
  (`ws-server.ts:193-195`) and stdio EOF (`cli/src/serve.ts`). It does **not**
  run on the worker path: `LocalRuntime.dispose()` → `disposeTransport` →
  `worker.terminate()` (`cli/src/local-runtime.ts:143-145,215`).
- The worker has an object side-channel to the main thread, separate from the
  string RPC frames: `postObject` (`cli/src/worker.ts:34`; object messages are
  ignored by `messagePortChannel`), received by the `message` listener in
  `cli/src/local-runtime.ts:202-209` (today: `mcp-errors`). The listener is
  attached before the handshake, so no early message is dropped.
- `@tentacle/cli` already depends on `@tentacle/exec` (`cli/package.json:18`);
  the exec barrel is `exec/src/index.ts` (add the new module's export there).

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
4. **Process-exit net, on the main thread.** New module
   `exec/src/process-group.ts` (exported from the barrel) holds `killGroup`,
   a module-level `Set` of live pgids, and:
   - `trackGroup(pgid)` / `untrackGroup(pgid)` — called by `HostExecution` on
     spawn and on the leader's exit (both `exec` and `spawnBackground`).
   - **On the main thread** (`isMainThread` from `node:worker_threads`):
     `trackGroup` adds to the set and lazily installs **one**
     `process.on("exit")` handler that synchronously sends `SIGKILL` to every
     registered group (`ESRCH` swallowed). This covers `--in-process`, `serve`
     and the stdio pod daemon with no plumbing.
   - **In a Worker**: never install the handler (proved dead, *Revision*).
     Instead forward each add/remove to a sink set with
     `setGroupForwarder(fn)`. `cli/src/worker.ts` sets it at module top level,
     before any session can spawn:
     `setGroupForwarder((op, pgid) => postObject({ type: "job-group", op, pgid }))`.
   - **Main side of the forward**: the existing `message` listener in
     `cli/src/local-runtime.ts` handles `type === "job-group"` by calling the
     main thread's own `trackGroup` / `untrackGroup` (validate: `op` is
     `"add"|"remove"`, `pgid` is a positive integer — never `kill(-0)` /
     `kill(-1)`, which would hit our own group or everything). The main's
     registry then installs the net exactly as in the in-process case.
   SIGKILL, not TERM: an exit handler cannot wait for a grace period; orderly
   shutdown is `dispose()`'s job, this is the last resort. Same OS process for
   main and worker, so no new transport and no protocol change; the
   side-channel is in-process, not pod-originated (§7 trust rule unaffected).
5. **Signals reach the exit net — SIGHUP/SIGTERM handlers are required.**
   *(Revised: the original "SIGTERM/SIGHUP already trigger `exit`" was measured
   inside a child-less worker and is false on the main thread.)* On the main
   thread a delivered signal with no listener terminates the process **without**
   running `exit` handlers (`tui/terminal.ts:6` says the same; repro below).
   Today: SIGINT is handled in every mode by handlers that end in
   `process.exit` (TUI raw mode / `tui/terminal.ts`; `cli/main.ts:231` serve,
   `:555` one-shot; `cli/terminal.ts:28` REPL) — leave SIGINT alone. SIGTERM is
   handled only while the TUI is mounted (`tui/terminal.ts:31`); **SIGHUP —
   closing the terminal window — by nobody**. So when the main-thread net is
   installed (lazily, item 4) it also installs one `SIGHUP` and one `SIGTERM`
   listener that call `process.exit(128 + signum)` (129 / 143), which runs the
   `exit` net. Coexists with the TUI's SIGTERM handler: whichever runs first
   exits, and the TUI's restore still runs from its own `exit` listener
   (`runOnce`).
   ```ts
   // bpg-mainnet/sig.ts — main thread, exit net, live child, no signal listener
   const p = Bun.spawn(["/bin/sh","-c","sleep 50003; true"], { detached: true, stdout: "ignore", stderr: "ignore" } as never);
   process.on("exit", () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} });
   setInterval(() => {}, 1000);
   ```
   ```
   kill -TERM → SIGTERM alive: 2   (sh + sleep leaked: exit handler never ran)
   kill -HUP  → SIGHUP alive: 2
   ```
6. **Jobs die with their connection (today's semantics).** `Connection.close()`
   calls `dispose()` on each hosted session's jobs, after `cancel()`.
   `HostedSession` keeps the `jobs` reference it already receives and exposes
   `disposeJobs()`. v2 note: `session-registry` later replaces this with
   "detach instead of close"; until then a session dies with its connection, so
   its jobs must too. **Scope note:** this is the orderly (TERM → KILL) path for
   `serve`/stdio/ws only; on the default worker path `Connection.close()` never
   runs (Preconditions), so there tentacle's exit kills jobs via item 4's
   SIGKILL, without a TERM grace window. Accepted for this fix; closing it is
   the follow-up *graceful worker shutdown* (Notes/debt below).

### Files

`core/src/jobs.ts` (interface: `dispose`) → `exec/src/process-group.ts` (new:
`killGroup`, registry, main-thread exit net, worker forwarder) +
`exec/src/index.ts` (export) → `exec/src/host-execution.ts` (`detached`, group
kill + escalation, `trackGroup`/`untrackGroup`) → `exec/src/background.ts`
(`dispose`) → `daemon/src/hosted-session.ts` (`disposeJobs`) →
`daemon/src/connection.ts` (`close` disposes) → `cli/src/worker.ts`
(`setGroupForwarder` → `postObject`) → `cli/src/local-runtime.ts` (handle
`job-group` in the existing listener). Any `JobController` fake in tests gains
a no-op `dispose`.

### Failure modes

- **Group already gone** (job exited between check and kill) → `ESRCH`
  swallowed; never throw from a kill path or from the exit handler.
- **Process ignores SIGTERM** → escalation to SIGKILL after the grace period;
  the exit net uses SIGKILL directly.
- **A command that itself calls `setsid` / daemonizes** (`nohup … &`,
  `docker run -d`) leaves our group on purpose; we cannot and should not chase
  it. Document as a known limit.
- **pid reuse**: the registry removes a group on the leader's exit, so the net
  never signals a recycled pgid. On the worker path the `remove` crosses a
  thread boundary, so there is a short window where the main still holds a
  pgid whose leader is gone; a recycled pgid in that window is theoretically
  hit. Accepted (window ≈ one message hop; pgid reuse needs pid wrap-around).
- **Spawn → exit race on the worker path**: if tentacle exits after the worker
  spawned a job but before the main thread processed its `add` message, that
  job is not in the main registry and leaks. Window ≈ one event-loop turn;
  accepted, documented, not tested.
- **Worker without a forwarder** (a future worker entrypoint forgets
  `setGroupForwarder`): jobs would be unprotected silently. Guard: in a worker,
  `trackGroup` with no forwarder set writes one line to stderr (via the daemon
  log path, never raw to the terminal — §7) and test 7 pins that
  `cli/src/worker.ts` sets it.
- **Malformed `job-group` message** → ignored by validation; never
  `process.kill(-0|-1|NaN)`.
- **Worker crash / `terminate()` before exit**: the main registry is
  independent of the worker's lifetime, so its pgids are still killed at exit
  (*Revision*: `term` variant).
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
4. **Exit net, main thread:** spawn a child Bun process (a fixture script)
   that starts a background job on its main thread and then calls
   `process.exit(0)` (variants: is sent SIGTERM; is sent SIGHUP — exit codes
   143 / 129) → `sleep N` not alive afterwards. Red today (repro 1; the
   signal variants are red even with an `exit` handler, see item 5).
4b. **Exit net, worker path (the case the original plan got wrong):** fixture
   main starts a Worker that sets the forwarder (as `cli/src/worker.ts` does)
   and starts a background job via the real `BackgroundJobs`; the main wires
   `job-group` messages to `trackGroup`/`untrackGroup` exactly as
   `local-runtime.ts` does (prefer driving the real `startWorkerRuntime` if it
   can be pointed at a fixture; otherwise reuse the same handler function,
   exported for the purpose), then `worker.terminate()` + `process.exit(0)` →
   `sleep N` not alive. Red today.
5. Escalation: a job that traps TERM (`trap '' TERM; sleep N`) is gone after
   the grace period.
6. `Connection.close()` disposes the hosted session's jobs (daemon integration
   test with a real `BackgroundJobs`).
7. Registry unit tests: `trackGroup`/`untrackGroup` round-trip; one exit
   handler however many tracks (`process.listenerCount` delta ≤ 1 for each of
   `exit`, `SIGHUP`, `SIGTERM`; none for `SIGINT`);
   `job-group` validation rejects `0`, `-1`, `NaN`, unknown `op`; in a Worker,
   `trackGroup` calls the forwarder and installs no handler.

Non-vacuity by mutation: revert `detached` (or kill `pid` instead of `-pid`)
→ tests 1, 2, 4, 4b must fail; remove the exit handler → 4 and 4b must fail;
remove the SIGHUP/SIGTERM listeners → only the signal variants of 4 fail;
drop the `job-group` forwarding (worker side or main side) → 4b must fail
while 4 still passes — that pair is what proves the worker path specifically.

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
- **Why the exit net lives on the main thread.** A Worker's exit handler does
  not run when the worker holds a live child, nor on `worker.terminate()`
  (*Revision*), so a net in the owning thread is dead on the default path —
  exactly where the jobs live. The main thread's handler always runs on
  `process.exit` (`cli/main.ts`, and `tui/terminal.ts` routes SIGINT/SIGTERM
  to `process.exit`), and since the worker shares the OS process, the main can
  signal the worker's groups. The only missing piece was the pgids; the
  existing object side-channel carries them, so no new transport. The registry
  code stays in the exec module (one implementation, unit-testable); only
  *where the handler is installed* depends on `isMainThread`.
- **Why not a graceful shutdown handshake instead.** Main sends `shutdown`,
  the worker runs `Connection.close()` → `dispose()`, then `terminate()`. It
  would give the worker path the TERM grace window, but it adds a handshake
  with a timeout and still needs the main-thread net as fallback (the worker
  may be wedged, or the process may exit without `dispose()`). So the net is
  needed either way; the handshake is an improvement on top — follow-up.
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

### Notes/debt

- **Follow-up: graceful worker shutdown.** On the default worker path, exit
  kills jobs with SIGKILL only (no TERM grace: dev servers may leave sockets /
  temp files). Fix later with a `shutdown` object message from
  `LocalRuntime.dispose()` → worker runs `Connection.close()` (→ `dispose()`,
  item 6) → acks → `terminate()`, bounded by a timeout; item 4 stays the
  fallback. Add a `TODO.md` entry when this fix merges. Likely folded into the
  v2 `session-registry` child, which changes teardown anyway.
- Residual races (spawn→exit before `add` arrives; pgid reuse within one
  message hop) are accepted — see Failure modes.

## Execution

*(empty — filled by the executor after promotion)*

## Review

*(empty — mandatory fresh-context Review after Execution: blast is load-bearing)*
