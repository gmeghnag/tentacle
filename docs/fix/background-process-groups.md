# fix/background-process-groups — kill whole process groups, and never let a job outlive tentacle

> **Status:** reviewed (2026-10-19) — Review round 1: REQUEST-CHANGES; findings 1–6 fixed and verified by the executor (see Execution, *Review round 1 — fixes*). The owner waived a round-2 Review. **Merged to `main` 2026-10-19**; gate green on the merge.
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
   its jobs must too. **Scope note** *(corrected after Review round 1, finding
   4)*: in `serve`/stdio/ws `close()` sends the group SIGTERM, but **no grace
   window actually elapses** — stdio `finish()` → `connection.close()` →
   `resolve()` (`cli/src/serve.ts:107-114`) returns from `main` and
   `process.exit` runs in the same tick (`cli/src/main.ts:573`), so item 4's
   SIGKILL follows at once; ws `serve` on SIGINT (`main.ts:231-236`) likewise.
   It is the orderly path only while the process keeps running after a
   connection closes (ws `serve` with several clients). On the default worker
   path `Connection.close()` never runs at all (Preconditions). Accepted for
   this fix; the follow-up *graceful shutdown* (Notes/debt) closes both.

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
- **No controlling terminal** *(added after Review round 1, finding 3)*:
  Bun's `detached` is `setsid`, so a command has no controlling tty
  (`/dev/tty: Device not configured`). Anything that prompts through
  `/dev/tty` — `sudo`, ssh/git password prompts, curses pinentry — now fails
  fast instead of fighting Ink for the terminal (before, it could block the
  turn or write raw to Ink's screen, §7). Accepted as a known limit, and
  arguably the correct behaviour for a model-run command.
- **Inherited ignored SIGHUP/SIGTERM** *(added after Review round 1, finding
  1)*: `nohup tentacle serve` (or `trap '' HUP; exec tentacle …`) must keep
  ignoring the signal; the net's listener is installed only for a signal not
  inherited as ignored (probed with libc `sigaction` at module load, see
  Execution). If the probe fails (no libc symbol), the listener is installed.
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

- **Follow-up: graceful shutdown.** On the default worker path — and, in
  practice, stdio/ws `serve` too (item 6 scope note) — exit kills jobs with
  SIGKILL only (no TERM grace: dev servers may leave sockets /
  temp files). Fix later with a `shutdown` object message from
  `LocalRuntime.dispose()` → worker runs `Connection.close()` (→ `dispose()`,
  item 6) → acks → `terminate()`, bounded by a timeout; item 4 stays the
  fallback. Add a `TODO.md` entry when this fix merges. Likely folded into the
  v2 `session-registry` child, which changes teardown anyway.
- Residual races (spawn→exit before `add` arrives; pgid reuse within one
  message hop) are accepted — see Failure modes.

### Extension — groups that outlive their leader (`cmd &`)

*— claude-opus-5-5, 2026-10-19 (found during Execution, approved by the owner
the same day)*

**Problem.** Items 1–6 drop a group from the registry when its **leader**
(`sh`) exits. A command that backgrounds a child and returns —
`npm run dev > log 2>&1 &`, a very common model idiom — exits `sh` at once
while the child lives on **in our group**. Nothing reaches it: the job is
`exited` so `kill`/`dispose` skip it, and the exit net no longer tracks it.
Repro (`.tentacle/tmp/background-process-groups/amp.ts`, real modules, then
`process.exit(0)`):

```
bg job status: exited kill(): false tracked: 0   →  bg survivors: 1
fg exec returned 0 tracked: 0                     →  fg survivors: 2
```

It is a small **regression**, not only a gap: before, that child sat in the
terminal's foreground group and died of SIGHUP when the window closed;
`detached` removes that.

**Design.**
- `process-group.ts` gains `releaseGroup(pgid)`, called by `HostExecution` on
  the leader's exit instead of `untrackGroup`. It probes `kill(-pgid, 0)`:
  `ESRCH` (group empty) → `untrackGroup` as before; otherwise the group is
  **lingering** — it stays tracked (so the exit net, on whichever thread owns
  it, still kills it) and joins a thread-local `lingering` set re-probed by one
  `unref`'d interval (`LINGER_PROBE_MS` = 5 s); when a probe finds it empty it
  is untracked (forwarded as `remove` from a Worker). `EPERM` counts as alive
  (conservative: keep tracked; the net's SIGKILL then fails harmlessly).
- **pid-reuse safety.** A group with members keeps its pgid, so a lingering
  pgid cannot be recycled; the only window is between the group emptying and
  the next probe (≤ 5 s) *and* a pid wrap-around — same order as the risks
  already accepted above.
- `BackgroundHandle.kill(): boolean` (core) — true if anything was signalled.
  `HostExecution`'s kill signals the group while the leader runs, and after
  the leader's exit **only if the group is lingering** (never a group we
  already released — that pgid may be recycled).
- `BackgroundJobs` keeps each job's kill handle after the leader's exit;
  `kill(id)` on an `exited` job forwards to it and returns its result (so
  `shell_kill` reports a lingering child as killed); `dispose()` kills every
  job, running or lingering. A running job's semantics are unchanged.
- Foreground `exec` gets the net only (no job to kill later): a lingering
  `cmd &` from `exec` dies with tentacle.

**Tests (red first).** `BackgroundJobs.kill` and `dispose` reach a `&` child
after the leader exited; `kill` on an exited job with an empty group returns
false; exit net (main thread) kills a lingering `&` child from both a job and
a foreground `exec`; worker path (real worker) kills a lingering `&` child;
registry unit: `releaseGroup` untracks an empty group, keeps a live one
lingering, and `probeLingering` untracks it once it empties.

## Execution

*— claude-opus-5-5, 2026-10-19*

**Pre-flight** (re-run before any code, bun 1.4.3, macOS): `pgid.ts` →
`Bun.spawn detached: child pgid=28108 own=true … left: none`; `bpg-mainnet`
`exit` → `MAIN-NET killed 28117 / exit alive: 0`, `term` →
`MAIN-NET killed 28125 / term alive: 0`. Load-bearing assumption holds.
Preconditions verified: the only model-command spawns are
`host-execution.ts` `exec`/`spawnBackground` (others: MCP stdio, k8s auth,
pod cleanup, config/flags `apiKeyCommand`, clipboard — none run model input).

**As built, in plan order.**
- `core/src/jobs.ts` — `JobController.dispose()`. `core/src/execution.ts` —
  `BackgroundHandle.kill(): boolean` (*Extension*).
- `exec/src/process-group.ts` (new, exported from the barrel) — `killGroup`,
  `trackGroup`/`untrackGroup`, lazy main-thread net (`exit` → SIGKILL every
  tracked group; `SIGHUP` → `exit(129)`, `SIGTERM` → `exit(143)`; SIGINT
  untouched), Worker forwarding (`setGroupForwarder`), `applyGroupMessage`
  (main side, validating), and the *Extension*'s `releaseGroup` /
  `probeLingering` / `isLingering`.
- `exec/src/host-execution.ts` — one `spawnShell` (`detached`, track, release
  on leader exit) and one `terminate` (group TERM → group KILL after
  `killGraceMs`) shared by `exec` and `spawnBackground`.
- `exec/src/background.ts` — `dispose()` (idempotent, kills every job);
  kill handles kept after exit (*Extension*).
- `daemon/src/hosted-session.ts` `disposeJobs()`; `daemon/src/connection.ts`
  `close()` → `cancel()` then `disposeJobs()` per session.
- `cli/src/worker.ts` — `setGroupForwarder(… postObject({type:"job-group"…}))`
  at module top level, before any session. `cli/src/local-runtime.ts` —
  `applyGroupMessage` first in the existing object-message listener;
  `remoteJobsView` gains a no-op `dispose` (jobs live daemon-side).
- Fakes gain `dispose` (cli, tui, agent ×2, tools); the exec fake handle's
  `kill` returns `!done`.

**Drift from Implementation (and why).**
1. **pgid validation is `integer > 1` and `≠ process.pid`**, not just "reject
   0 / -1": `kill(-1)` signals *every* process we may signal, so pgid `1` must
   be rejected too.
2. **Escalation SIGKILLs the group unconditionally after the grace**, not "if
   the leader has not exited": `sh` can die on TERM while a grandchild that
   ignores TERM lives on in the group. A group with members keeps its pgid, so
   this only mis-hits if the group emptied *and* the pgid was recycled within
   the grace window.
3. **`HostExecutionConfig.killGraceMs`** (default `KILL_GRACE_MS` = 2000) — a
   seam so test 5 runs with a 300 ms grace (§9: small timeouts).
4. **No stderr line for "worker without a forwarder".** `@tentacle/exec` has
   no daemon-log path, and a raw `console.error` from the worker would write to
   Ink's terminal (§7). The guard is test 4b: mutation M4 (drop
   `setGroupForwarder` in `cli/src/worker.ts`) turns it red.
5. `stdin: "ignore"` made explicit — verified equal to Bun's default.
6. `@tentacle/exec` added as a **devDependency** of `@tentacle/daemon` (test 6
   uses a real `BackgroundJobs`); `bun.lock` +1 line.
7. Test 3/6 wait for `onExit` before asserting `killed`: the tree is gone
   before `exited` resolves; marking `killed` synchronously would skip
   `finish()` and so the `background_exit` stream.
8. **The *Extension*** (groups outliving their leader) — found here, approved
   by the owner, specified in Implementation above.

**Tests** — new: `exec/test/process-tree.test.ts` (1, 2 ×2, 3, 5, 4 ×3
main-thread exit/SIGTERM/SIGHUP, Extension ×5), `exec/test/process-group.test.ts`
(7 + Extension unit, incl. a Worker fixture), `cli/test/worker-exit-net.test.ts`
(4b on the **real** `startWorkerRuntime`: a scripted model starts the job via
the `shell` tool inside the worker, then `dispose()` + `process.exit(0)`; plain
and `&` variants), `daemon/test/integration.test.ts` (6). Fixtures under
`exec/test/fixtures/`, `cli/test/fixtures/`. Every test asserts "no process of
the tree alive" via `pgrep -f` on a unique marker, with `pkill` cleanup.

**Red before green.** On the old code: 9/9 of the original behavioural tests
red (`exec` timeout/abort even hung to the 5 s test timeout — the grandchild
held the pipe open); after the Extension's tests were added, 5/5 `&` cases red
(the "empty group → kill returns false" guard is green on both, by design).

**Non-vacuity by mutation** (each applied alone, tests re-run, reverted):

| Mutation | Fails | Expected |
|---|---|---|
| M1 drop `detached` | 15 — every tree/net test | 1, 2, 4, 4b |
| M2 drop `exit` handler | 4 ×5, 4b ×2, install-once | 4, 4b |
| M3 drop SIGHUP/SIGTERM listeners | 4-SIGTERM, 4-SIGHUP, install-once | only signal variants |
| M4 drop worker forwarder | 4b ×2 only | 4b, 4 still passes |
| M5 drop main-side apply | 4b ×2 only | 4b, 4 still passes |
| M6 drop SIGKILL escalation | 5 only | 5 |
| M7 `close()` doesn't dispose | 6 only | 6 |
| M8 release always untracks | all 5 `&` tests + unit | Extension |
| M9 exited-job kill skips handle | `&` kill + dispose | Extension |
| M10 probe never untracks | lingering unit | Extension |

The `terminate` guard (never signal a *released, empty* group) has no mutation
test: proving it needs a recycled pid. It is a safety guard, reasoned not
measured.

**Gate.** `bun run check`: typecheck clean, `biome check .` 0/0, `bun test`
769 pass / 1 skip (the opt-in live-k8s `integration.live.test.ts`) / 0 fail.
No `sleep 3NNNNNN` left alive after any run.

**Review round 1 — fixes** (*— claude-opus-5-5, 2026-10-19*; the owner
asked for findings 1–6 to be fixed without a second Review round, so each fix
is held to red-before-green or mutation non-vacuity here):
1. **`nohup` regression → fixed.** `process-group.ts` probes, at module load
   on the main thread, whether SIGHUP/SIGTERM were inherited as `SIG_IGN`, via
   `bun:ffi` `sigaction(sig, NULL, &old)` on `libSystem` (macOS) / `libc.so.6`
   (glibc; the pod binary is glibc-linked); `sa_handler` is the first field,
   `SIG_IGN` = 1. An ignored signal gets no listener. At load, not lazily: once
   any JS listener exists (e.g. the TUI's SIGTERM) Bun's handler replaces the
   disposition and the probe would read "not ignored". Any probe failure →
   install (pre-fix behaviour). Measured first (macOS): `plain HUP=false`,
   `nohup HUP=true`, `trap '' TERM` → `TERM=true`, also in a
   `bun build --compile` binary. `ps -o sigignore` was tried first and is not
   available on macOS. Test: `an inherited ignored SIG{HUP,TERM} stays ignored
   (nohup)` — red before (exit 129/143), green after; mutations M11/M12 (force
   the probe to "not ignored") turn each red. The install-once test now runs
   its subprocess under `trap - HUP TERM`, so a runner under `nohup` cannot
   fail it for the wrong reason (verified: `nohup bun test …` green).
   **Not verified:** Linux at runtime (struct layout reasoned for
   glibc x86_64/arm64, not executed).
2. **Test could SIGKILL a real group → fixed.** No fixed fake pgids: each is
   drawn at random and accepted only if `kill(-p, 0)` → `ESRCH`; `afterEach`
   untracks every drawn pgid even after a failed assertion; the subprocess
   variant untracks in `finally`.
3. **No controlling tty → documented** (Failure modes).
4. **Doc said stdio gets a TERM grace → corrected** (item 6 scope note,
   Notes/debt).
5. **Missing `remove` forwarding was unpinned → test added:** `a job that
   exits in the worker is untracked on the main thread` (real worker; main
   registry `1` while running → `0` after exit). Mutation M13 (worker forwards
   only `add`) turns exactly it red.
6. **TERM-to-leader-only was unpinned → tightened:** the kill, exec
   timeout/abort, dispose and `Connection.close()` tests use
   `killGraceMs: 10_000` (≫ the 2 s wait), so only a group-wide SIGTERM passes.
   Mutation M14 (SIGTERM to the leader pid only) now fails 7 tests (was 3).

Full battery re-run after the fixes: M1–M14 each fail the expected tests
(M3 re-targeted as "drop the SIGHUP listener": fails the SIGHUP variant, the
TERM-ignored variant that relies on HUP, and install-once). Not fixed, by
the Review's own grading: 7 (guard unpinned), 8, 9, 10 — left as noted there.

**Residuals (unchanged from Failure modes, plus):****Residuals (unchanged from Failure modes, plus):** a job started *after*
`dispose()` (a tool call racing `Connection.close()`) is not disposed — the
exit net still kills it at exit; `/clear` leaves jobs until disconnect/exit;
graceful worker shutdown remains the follow-up in Notes/debt.

## Review

*— claude-opus-5-5 (fresh-context reviewer), 2026-10-19*

> **Same model as the executor** (claude-opus-5-5), only a fresh context, so
> blind spots we share may have survived both passes. For a load-bearing change,
> AGENTS §10 recommends a second look from a different model.

### Verdict: **REQUEST-CHANGES**

The core fix is correct. I reproduced it on the real code paths: group kill,
`dispose`, the main-thread exit net, worker forwarding and lingering `&`
groups. The gate is green, and every new behavioural test failed under my own
mutations. Two findings still need a fix or an explicit owner decision before
merge: a regression for anyone running tentacle under `nohup` (1), and a test
that can SIGKILL an unrelated process group on the developer's machine (2).
Findings 3–5 are small documentation and test additions. The rest are nits.

### Findings

1. **Medium: the lazy SIGHUP listener overrides an inherited `SIG_IGN`, so
   `nohup tentacle serve` dies when the terminal closes**
   (`exec/src/process-group.ts:89`). Once the first shell command has run, the
   main thread installs `process.on("SIGHUP", () => process.exit(129))`. That
   replaces an ignored disposition, so a daemon started under `nohup`, or under
   `trap '' HUP`, now exits on hangup. Measured with
   `.tentacle/tmp/background-process-groups-review/hup.ts`, started as
   `sh -c "trap '' HUP; exec bun hup.ts …"` and then sent `kill -HUP`:
   `track=no exit=0 "survived HUP"` versus `track=yes exit=129`. Before this
   change, the second run survived too. The same applies to an ignored SIGTERM
   (less common). Possible fixes: install the SIGHUP listener only when a TTY is
   attached (nohup redirects stdio), or get the owner to accept this and record
   it in Failure modes.
2. **Medium (test hazard): `process-group.test.ts:71-76` can SIGKILL a real,
   unrelated process group.** The test calls `trackGroup(54320)` and then
   `releaseGroup(54320)`, and relies on no group 54320 existing. If one of the
   user's processes happens to lead group 54320 at that moment, `groupAlive` is
   true. The pgid then stays tracked as lingering, the test fails, and when the
   `bun test` process exits, its own exit net runs `kill(-54320, SIGKILL)`.
   macOS pids reach that range (about 37k here today). This happens even when
   the code under test is correct. Separately, `:18-23` and `:43-48` leave
   `FAKE` tracked if an assertion fails between track and untrack, because there
   is no `try/finally`. Fix: use a pgid that is known not to exist, for example
   one spawned, reaped and checked with `kill(-p, 0)` → `ESRCH` immediately
   before use. Untrack in a `finally`, or add a final assertion that
   `trackedGroups()` contains no fake.
3. **Low (undocumented behaviour change): Bun's `detached` is `setsid`, not
   just `setpgid`** (`exec/src/host-execution.ts:161`, whose comment says only
   "pgid = its pid"). Measured under a pty (`script -q /dev/null bun tty.ts`):
   - On `main`: tty `ttys000`, `/dev/tty` opens.
   - On the branch: tty `??`, stat `Ss` (session leader), and
     `/bin/sh: /dev/tty: Device not configured`.

   Model commands that prompt through `/dev/tty` (`sudo`, `ssh` and https `git`
   password prompts, curses `pinentry`) now fail fast instead of prompting into
   or hanging on Ink's terminal. For the §7 rule "never write raw to the
   terminal while Ink owns it" this is arguably an improvement, but it is a
   behaviour change, and it should be listed under Failure modes or Notes.
4. **Low (doc inaccuracy): there is effectively no TERM grace on stdio or ws
   `serve` either.** Design item 6 calls `Connection.close()` the orderly
   TERM → KILL path for "`serve`/stdio/ws". On stdio, `finish()` runs
   `connection.close()` and then `resolve()` (`cli/src/serve.ts:107-114`). From
   there, `return 0` (`cli/src/main.ts:194`) leads to `process.exit`
   (`main.ts:573`) in the same tick, so the exit net's SIGKILL follows the TERM
   immediately. `serve` (ws) does the same on SIGINT (`main.ts:231-236`). The
   grace window only exists for a ws client that disconnects while the daemon
   keeps running. Record this in Notes/debt, next to *graceful worker
   shutdown*.
5. **Low (test gap): nothing pins worker-side `remove` forwarding.** Mutation
   R7 forwards only `add` from `cli/src/worker.ts:41`, and every test stays
   green (7 pass / 0 fail across `worker-exit-net` + `local-runtime`). If that
   regressed, the main registry would keep every pgid the worker ever used,
   including one per foreground `exec`, and SIGKILL them all at exit, recycled
   pgids included. The current code does remove them (end-to-end trace below:
   `tracked=[37693]` → `[]`). Suggested pin: after the job exits, the
   worker-path fixture asserts that the main's `trackedGroups()` is empty.
6. **Nit: tests 2 and 6 pin only "eventually gone", not "TERM reaches the
   group".** With R6 (SIGTERM to the leader pid only, group SIGKILL kept),
   exec timeout, exec abort and the daemon `close` test all pass, because the
   SIGKILL lands after 2 s, inside their 2 s polling window. Only the
   background-kill tests catch it. That is enough as a guard, but the "TERM
   lets dev servers clean up" property of foreground `exec` is unpinned.
7. **Nit: the `terminate` guard against signalling a released, empty group**
   (`host-execution.ts:184-186`) is unpinned: R2 removes it and all tests stay
   green. The executor already disclosed this.
8. **Nit: foreground `exec("cmd &")` without a redirect** now returns at the
   timeout with `sh`'s exit code 0, and the child is killed. Because the code is
   0 and not 124, the shell tool's "[killed — timed out…]" note
   (`tools/src/builtins.ts:294`) is not shown. On `main` the same call hung
   until the child died (measured: 130 s until I killed it by hand, and it
   leaked). So this is a net improvement, and the missing note is cosmetic.
9. **Nit: kill handles are now kept for every exited job**
   (`exec/src/background.ts:84`, with `handles.delete` removed). Each keeps a
   `Subprocess` closure alive. This adds to the open `TODO.md:51` (the jobs map
   is never reaped). A future reaper must drop the handle with the job, after
   which a lingering group is reachable only through the exit net.
10. **Info: the downstream eval assumes a different name.**
    `docs/eval/session-ttl-limits.md:189-190` assumes
    "`HostedSession.close()` calls" `dispose`; this task ships
    `HostedSession.disposeJobs()`. That consumer must adapt.

### Gate (re-run by me)

`bun run check`:

| Step | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check .` | 263 files, 0 errors / 0 warnings |
| `bun test` | **769 pass / 1 skip / 0 fail**, 770 tests across 94 files |

These counts match the Execution section exactly. The one skip is the opt-in
live-k8s test. No `sleep 3NNNNNN` process was left after any run.

### Mutation non-vacuity (my own, each applied alone, narrow files, reverted)

| # | Mutation | Result |
|---|---|---|
| R16 | `killGroup` signals `pgid`, not `-pgid` | **15 fail**: every tree, net, worker and daemon test |
| R3 | `dispose` kills only `running` jobs | **1 fail**: `dispose` reaches `&` child |
| R6 | SIGTERM to the leader pid only (group KILL kept) | **3 fail**: bg kill, `&` kill, `&` dispose (finding 6: exec/daemon tests stay green) |
| R11 | exited-job `kill` always returns true | **1 fail**: empty group → false |
| R5 | main applies `add` as untrack | **3 fail**: 4b ×2 + `applyGroupMessage` unit |
| R15 | lingering group kept for probing but untracked from the net | **4 fail**: `&` exit net ×2, worker `&`, lingering unit |
| R2 | drop the released/empty guard in `terminate` | **0 fail**: unpinned (finding 7) |
| R7 | worker forwards `add` only, never `remove` | **0 fail**: unpinned (finding 5) |

Before and after the mutations, the working tree was byte-identical:

| Check | SHA-1 |
|---|---|
| `git diff \| shasum` | `f8ba82ae…` |
| `git status --porcelain \| shasum` | `078dd4f6…` |
| Untracked new files | `89ef6af6…` |

I did not run the "drop `1` from the pgid validation" mutation on purpose. A
tracked `1` would make the test process's own exit net run
`kill(-1, SIGKILL)`, which kills every process I own.

### Premise table

| Premise (Implementation / Context) | Verdict |
|---|---|
| Symptom: `kill()` leaves the grandchild alive; jobs outlive the parent (repro on `main` in a worktree, `repro.ts`) | **TRUE**: `kill(): true, status: killed`, grandchild `sleep …1` alive with PPID 1; job b's `sh` and `sleep` alive with PPID 1 after parent exit. Branch: none alive in either case |
| `host-execution.ts:87` foreground `proc.kill()`, `:144` background `proc.kill()` | TRUE (main) |
| `host-execution.ts:79,130` the only model-command spawns | TRUE; `rg` shows only `flags.ts`, `config/load.ts`, `mcp`, `k8s`, `clipboard` besides, none of which run model input |
| `background.ts:77` class, `:111` `kill` | TRUE |
| `wiring.ts:86` per-session `BackgroundJobs`; `session-host.ts` hands `jobs` to `HostedSession` | TRUE (`session-host.ts:39-41`) |
| `ws-server.ts:193-195` close → `Connection.close()` | TRUE |
| `local-runtime.ts:143-145,215` dispose → `worker.terminate()`, no `Connection.close()` | TRUE |
| `worker.ts:34` `postObject`; `local-runtime.ts:202-209` object listener | TRUE |
| `cli/package.json:18` depends on `@tentacle/exec` | TRUE |
| `daemon-session-lifecycle.md:172` "land both together" | TRUE |
| `tui/terminal.ts:6` listener-less signal skips `exit`; `:31` SIGTERM handled only while mounted | TRUE |
| "SIGINT handled in every mode by handlers that end in `process.exit`" (`main.ts:231,555`, `cli/terminal.ts:28`) | **PARTLY**: the one-shot and REPL handlers only abort or close readline; the exit comes later, from `main.ts:573`. Harmless here |
| `isMainThread` true on main, false in a Worker | TRUE, also in a `bun build --compile` binary (checked) |
| Item 6: `close()` is the orderly TERM → KILL path for serve/stdio | **FALSE in effect** (finding 4) |

### Attacks tried

1. **The trust rule (pod is not trusted).** `applyGroupMessage` is called only
   from the in-process Worker's object listener (`local-runtime.ts:206`). Pod
   `run`/`attach` and `connect` use string-frame `streamChannel`/ws, which has
   no object path, and model commands run in child processes, not in the
   worker's JS. Validation rejects 0, 1, negatives, non-integers and our own
   pid. **Holds.** A pod daemon cannot make the laptop kill anything.
2. **Ordering of `exit` listeners.** Could an earlier listener that throws (a
   TUI restore hitting EIO on a hung-up tty) skip the net, which registers
   later? `throwexit.ts` showed the job is still killed. **Holds.** On SIGTERM
   with the TUI mounted, the TUI's handler registers first and calls
   `exit(143)`. The net and the pod cleanup (`pod-runtime.ts:174`) then run as
   `exit` listeners, and ours never runs. **No conflict.** On the laptop in pod
   `run`/`attach`, the main thread spawns no shells, so the lazy listeners are
   never installed there and pod-lifecycle semantics are unchanged.
3. **Inherited ignored SIGHUP (`nohup`).** **Found a regression** (finding 1).
4. **`setsid` and controlling-tty side effects.** **Found a behaviour change**
   (finding 3).
5. **Foreground `exec` when the command backgrounds a child that keeps stdout
   open** (`fgamp.ts`). On `main` it hangs until that child dies, then leaks.
   On the branch it returns at the timeout with the group killed. **Improvement**
   (finding 8).
6. **Worker `terminate()` with lingering probes in flight, and dispose before
   exit.** `runtime.dispose()` is called only right before `process.exit`
   (`main.ts:311,493`), and the main registry does not depend on the worker, so
   it still kills at exit. **Holds.** A residual remains: in a long-lived host
   that terminated the worker, a lingering pgid would never get its `remove`.
   No such host exists today.
7. **Does `kill(): boolean` reach every implementer and caller?** Implementers
   are `HostExecution` and three test fakes. Callers are `BackgroundJobs` and,
   through it, `shell_kill`. `remoteJobsView` got `dispose`. **Holds.**
8. **Serialization of the RPC peer.** `Connection.close()` and `disposeJobs()`
   are synchronous, and no new awaits or locks were added to handlers.
   **Holds.**
9. **Raw writes to the terminal.** `process-group.ts` writes nothing (the
   planned stderr line was dropped for exactly this reason, Drift 4).
   **Holds.**
10. **Fixed fake pgids in tests.** **Found a hazard** (finding 2).
11. **Flakiness.** Markers are random 6-digit `sleep 3NNNNNN`, `pgrep -f`
    polling with 2 s deadlines, and `pkill -9` in `afterEach`. The full suite
    was green on my run and on the executor's. In my narrow re-runs, the tests
    a mutation did not target always passed, so I saw no flake (a small
    sample). The 2 s polling windows sit right at the 2 s default grace (see
    R6), so a slow CI machine could turn a TERM-path weakness into a
    timing-dependent result. Not seen.
12. **`EPERM` and pid reuse.** `EPERM` counts as alive, which keeps the pgid
    tracked. A group made entirely of setuid processes would then never be
    untracked, and once it empties and the pgid is reused by one of our own
    groups, the net could hit it. That needs pid wrap-around. Same order as the
    accepted risks, **noted, not a finding**.

### End-to-end trace (real code path)

`.tentacle/tmp/background-process-groups-review/e2e.ts` drives the real
`startWorkerRuntime`. A scripted model calls the `shell` tool in the
**foreground** with `sleep M >/dev/null 2>&1 &` inside the worker. The trace
showed:

1. `after turn: sleep pid=37694 main tracked=[37693]`: the worker forwarded
   `sh`'s pgid, and the group is lingering after `sh` exited.
2. After an external `kill -9` of the sleep and one probe period:
   `main tracked=[]`. The `remove` crossed the thread boundary.
3. `dispose()` + `process.exit(0)`: nothing left.

The worker-path design works end to end.

### What holds

- Group kill with TERM → KILL escalation.
- `dispose()`, idempotent.
- The main-thread exit net, on `exit` and on SIGTERM/SIGHUP (exit codes
  143/129).
- Worker → main forwarding with validation, lingering `&` groups, and a
  `Connection.close()` that disposes jobs.
- The in-process trust boundary, the unserialized peer, and no raw terminal
  writes.

### How the executor behaved

- **Rigorous and honest.** It re-ran the pre-flight, caught a real flaw in its
  own plan (the worker exit net never fires) with a repro, and stopped to
  revise instead of forcing the code. It found the `cmd &` gap and got owner
  approval before extending the plan.
- **Drift and mutations recorded.** Every drift is listed with its reason. The
  mutation table is accurate where I re-checked it (R16 ≈ M1, 15 fails), and it
  disclosed the one unpinned guard.
- **Missed:** the SIG_IGN override (finding 1), the fake-pgid hazard (2), the
  `setsid` side effect (3), the zero TERM grace on stdio (4), and the
  `remove` forwarding left unpinned (5).
- **Gate:** the claim of 769/1/0 is exact.
