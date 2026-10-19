# eval/daemon-session-lifecycle — the daemon has no session lifecycle: background processes outlive their session

> **Status:** eval (Context + Review; Implementation empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** M (if promoted: split into two tasks, see Review) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (touches the protocol, the daemon `Connection`, and the TUI-over-RPC session path, AGENTS §7)

> **Superseded in part (2026-10-19):** task 2 below (`fix/daemon-session-lifecycle`) is absorbed by `docs/eval/session-registry.md` and `docs/eval/session-ttl-limits.md`, a child of the protocol-v2 redesign `docs/eval/session-reattach.md`. Task 1 (`fix/background-process-groups`) now has its own self-contained doc, `docs/fix/background-process-groups.md` (promoted, in execution), which also pulls in the process-exit net and job disposal on connection close from task 2 — see the caveat at `:172`.

## Context

*— claude-opus-5-5, 2026-10-17*

**Question being decided:** is the claim real that the daemon has no session
lifecycle, so background processes get orphaned and session ids can be
overwritten? If it is, should we add an explicit session teardown (a
`session/close` method, plus job cleanup on connection close and process exit),
and in what shape?

Related, narrower, **not duplicated here**: the `TODO.md` item "`BackgroundJobs.jobs`
map is never reaped" (`exec/background.ts:78`) is about the buffers of
*finished* jobs. This eval is about *running* processes and session objects that
never get torn down.

### Evidence (source)

- **No teardown method.** `packages/protocol/src/methods.ts:28-32` defines
  `session/new|prompt|compact|snapshot|request_permission`, plus the
  notifications `session/update|cancel` (`:39-40`). There is no `session/close`.
  `Connection.onRequest` (`packages/daemon/src/connection.ts:103-114`) has
  no case that removes a session, and nothing calls `sessions.delete`.
- **Connection close only cancels turns.** `Connection.close()`
  (`connection.ts:79-84`) calls `session.cancel()` on each session and then
  `peer.close()`. It does not kill jobs, does not clear the map, and does not
  call `setSink(null)`. ws-server calls it on socket close (`ws-server.ts:193-196`).
  The stdio daemon (pod) calls it on stdin end (`cli/src/serve.ts:93-104`).
- **One `BackgroundJobs` per session.** `SessionHost.create` calls the
  `createAgent` factory for every `session/new` (`daemon/src/session-host.ts:39`).
  The factory is `buildAgent`, which builds a fresh `HostExecution` and
  `BackgroundJobs` (`cli/src/wiring.ts:76,82`), for the worker
  (`cli/src/worker.ts`), `serve` (`serve.ts:31`) and stdio (`serve.ts:65-78`).
  Nothing calls `kill` on those jobs except the model's own `shell_kill`.
- **`/clear` creates a new daemon session** on every RPC runtime: `App.tsx:402-403`
  → `createSession()` → `client.newSession(…, freshUid)` (`cli/src/local-runtime.ts:110-116`,
  and `connect.ts:28`). The new session is opened lazily, on its first prompt
  (`client/src/remote-session.ts:41`). **Exception:** the `--in-process` path
  reuses ONE agent and ONE `jobs` for every `/clear` (`cli/src/main.ts:496-516`),
  so `/clear` alone orphans nothing there.
- **Children are plain children.** `spawnBackground` runs
  `Bun.spawn(["/bin/sh","-c",cmd])` with no `detached` and no process group, and
  `kill` is `proc.kill()`, which sends SIGTERM to the `sh` pid only
  (`exec/src/host-execution.ts:130-145`).
- **Duplicate id overwrites the session.** `newSession` checks `sessions.size`
  first, then runs `sessions.set(id, hosted)` with the id the client supplied
  (`connection.ts:151-167`). An existing entry with that id is replaced
  without being cancelled or detached.
- **Job-exit notices ignore `sessionId`.** The client sends every
  `background_exit` to the global `exitListeners`, whatever the session
  (`client/src/remote-client.ts:71-76`). The TUI then renders it and, if idle,
  auto-wakes a continuation turn (`tui/src/App.tsx:194-217`).

### Reproduction

The scripts are throwaway, in the session scratchpad
(`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/repro.ts`,
`.../kill.ts`). They use the real `Connection` + `SessionHost` +
`Agent` + `builtinTools` + `HostExecution` + `BackgroundJobs`, the same
construction as `wiring.ts:76-82`. A scripted model makes the agent call
`shell {command:"sleep 3000N", run_in_background:true}` on its first turn.

**1. `/clear` followed by connection close, then parent exit** (`repro.ts clear`). Session A
is created and prompted (it starts `sleep 30001`). Then session B is created and
prompted, exactly like `/clear` + a prompt. Then `Connection.close()` runs and the process exits:

```
live sleep 30001 (session A, after /clear): [ "62955" ]
A jobs: [ "bg-1:running" ] B jobs: [ "bg-1:running" ]
sessions in map: 2
after Connection.close(): live sleep 3000[12]: [ "62955", "62956" ]
parent pid 62954 exiting without kill
--- after parent exit:
  PID  PPID COMMAND
62955     1 sleep 30001
62956     1 sleep 30002
```

**2. Duplicate `sessionId`** (`MAX=3 repro.ts dup`):

```
dup ids: X X agents built: 2 map size: 1
background_exit notices for X after overwrite: [ "X:bg-1:killed" ]
MAX=3: 10 more session/new{Y} accepted, agents built: 12, map size: 2
```

The old session X stays alive with its sink attached, and its job exit still
reaches the client tagged `X`. The client cannot tell it from the new session X.
Repeating `session/new{Y}` built 10 more agents while the map stayed at 2.

**3. Session cap** (`repro.ts max`, `maxSessions: 64` = `DEFAULT_MAX_SESSIONS`, `ws-server.ts:39`):

```
session/new accepted 64, then: too many sessions on this connection (max 64)
```

**4. Explicit kill of a compound command** (`kill.ts`). `jobs.start("sleep 30009; echo done")`
followed by `jobs.kill(id)` gives:

```
kill(): true
status: killed
grandchild still alive: 63497
  PID  PPID COMMAND
63497     1 sleep 30009
```

All spawned processes were killed afterwards (`pgrep -fl "sleep 3000"` → none).

### Verdict per sub-claim

| # | Claim | Verdict |
|---|---|---|
| 1 | No `session/close`; HostedSessions are never removed from `Connection.sessions` | **CONFIRMED** (methods.ts:28-40; no `sessions.delete`; repro 1 "sessions in map: 2") |
| 2 | One `BackgroundJobs` per session, and nothing kills running jobs; `Connection.close` only cancels turns | **CONFIRMED** (repro 1: both sleeps alive after `close()`) |
| 3 | After `/clear` the old jobs keep running and the model can no longer reach them | **CONFIRMED for the worker / `connect` / pod paths**. **NOT applicable to `--in-process`**, which shares one `jobs` across `/clear` (main.ts:496-516). Repro 1: A's `bg-1` is still running, and B has its own `bg-1`, so the same id now names a different job. |
| 4 | A remote ws client disconnects and its jobs run forever in the daemon | **CONFIRMED** (repro 1 after `close()`, which is what `ws-server.ts:195` calls) |
| 5 | Children survive worker terminate / TUI exit | **CONFIRMED** for parent-process exit: the children are reparented to PID 1 (repro 1). The worker is a thread in the same process, so `worker.terminate()` cannot kill them, and nothing else does. (`worker.terminate()` was not exercised in isolation. Process exit covers it, because the TUI exits right after.) |
| 6 | Repeated `/clear` on `connect` eventually hits "too many sessions" | **PARTIALLY.** The cap is real and reachable: session 65 is refused (repro 3). But a `/clear` with no prompt after it creates no daemon session (lazy open, remote-session.ts:41), so it takes 64 `/clear`+prompt cycles on one connection. That is unlikely interactively, but plausible for a long-lived scripted `connect`. |
| 7 | A duplicate client-supplied `sessionId` overwrites a running HostedSession (orphaned, sink still attached) and bypasses `maxSessions` | **CONFIRMED.** The overwrite and the live sink: repro 2. The bypass is **PARTIAL**: the size check runs before the overwrite, so while below the cap a client can rebuild agents with one id without limit (12 agents, map size 2). It cannot go past the cap with new ids. Our own client sends `sessionId` only for the first (resume) session (local-runtime.ts:112-116), so this needs a buggy or hostile peer. |
| + | (new) `shell_kill` / `BackgroundJobs.kill` leaves grandchildren running | **CONFIRMED** (repro 4). `proc.kill()` signals only `sh`, so `npm run dev`, `a && b`, and pipelines survive their own kill. The same flaw would defeat any teardown we add, so the fix must use process groups. |
| + | (code-read, not reproduced) After `/clear`, an old session's job exit is broadcast as a TUI notice and auto-wakes a turn on the NEW session, whose agent has no record of that job | **UNVERIFIED.** Follows from remote-client.ts:71-76 (no `sessionId` filter) and App.tsx:209-216. To verify: drive the TUI harness through `/clear`, then kill the old job. |

**Severity: medium-high.** This leaks real OS resources: processes, ports held
by dev servers, and CPU on watchers. On a laptop they outlive the TUI. On a
long-lived `tentacle serve` daemon they pile up for every client and
disconnect. In a user-owned `exec` pod they outlive our session, and AGENTS §7
says that pod is the user's, so we leave junk running there. A remote client
can also leave processes running after it disconnects. It does not escalate
privilege, since that client could already run shell, but it is persistence
nobody accounts for. Correctness bugs on top: per-session job ids (`bg-1`)
collide across `/clear`, and a duplicate id causes misattributed updates.

**Trigger:** use `run_in_background` (directly, or a model starting a dev
server), then any of: `/clear` followed by a prompt (worker / `connect` / pod),
exiting the TUI, a ws client disconnect, stdio stdin EOF, or `shell_kill` on a
compound command.

## Implementation

*(empty — an eval; filled when promoted)*

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-17*

**Verdict: real. Recommend promoting to `fix`, split into two tasks.** Every
core sub-claim reproduced against the real daemon stack. Two claims are
narrower than stated: `--in-process` `/clear` does not orphan, and the
max-sessions bypass is partial. The fix direction below follows AGENTS §7:
additive protocol, version stays 1, one session path.

1. **`fix/background-process-groups`** (S–M, `exec` only, cross-module). Spawn
   background, and ideally foreground, children in their own process group
   (`detached: true`, so `setsid`), and kill the **group** (`process.kill(-pid, SIGTERM)`,
   escalating to SIGKILL after a grace period). Add `BackgroundJobs.dispose()`
   (or `killAll()`), which kills every running job. Do this first, because any
   teardown that only signals `sh` still leaks (repro 4). Red test: a compound
   `sleep N; true` job; after `kill`, `pgrep` finds no `sleep N`. Caveat:
   `detached` children no longer get the terminal's SIGINT/SIGHUP, so the
   explicit teardown in task 2 becomes the *only* net. Land both together.
2. **`fix/daemon-session-lifecycle`** (M, load-bearing):
   - `JobController` / `AgentFactory` exposes a dispose hook. `HostedSession.close()`
     cancels the turn, detaches the sink (`setSink(null)`), unsubscribes `onExit`,
     and disposes its jobs.
   - **Additive `session/close`** request in `@tentacle/protocol`
     (`PROTOCOL_VERSION` stays 1): `Connection` closes the session and deletes it
     from the map, and an unknown id is a no-op. The client (`RemoteSession`) sends it
     when `/clear` replaces a session. An old daemon answers `MethodNotFound`:
     catch it and ignore it (the session leaks as today, nothing worse).
     Apply it the same way on every runtime (worker / pod / `connect`). Don't add
     a parallel path.
   - **`Connection.close()`** closes every hosted session (jobs included), not
     just `cancel()`. This covers ws disconnect, stdio EOF, and worker teardown.
   - **Process-exit net**: the worker / `serve` / stdio daemon kills the
     remaining job groups on `exit`/SIGINT/SIGTERM. That is synchronous
     `process.kill(-pgid)`, which is safe inside an `exit` handler.
   - **Duplicate `sessionId`**: reject it with a domain error (`SessionExists`, or
     reuse an existing code), rather than overwriting. That also closes the
     cap bypass. (Close-and-replace was the alternative. Rejecting is simpler and
     can't silently kill a live turn.)
   - Optional, same task: tag `background_exit` handling by `sessionId` on the
     client, so a straggler from a closed session cannot auto-wake the new one.
     The daemon-side close above makes this mostly moot.
   - Policy to decide in Implementation: should a *deliberate* long-lived
     server survive `/clear`? Recommendation: no. The model in the new session
     cannot see or kill it, so it is unmanaged by definition. If the user wants
     a server to outlive the agent, they can start it outside tentacle.

**Not covered here:** reaping finished-job buffers stays the separate `TODO.md`
item. The foreground `exec` SIGTERM-only / no-escalation item already in
`TODO.md` should share the process-group helper from task 1.
