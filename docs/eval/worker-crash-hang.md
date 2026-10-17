# eval/worker-crash-hang — a worker daemon that dies after the handshake hangs the TUI forever

> **Status:** eval (Context + Review; Implementation empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Size:** S · **Blast:** contained · **Suited:** a weaker model may execute the `fix` once promoted (one file in `packages/cli`, no protocol/persistence change); standard Review, but the regression test must use a real Bun `Worker` (the bug is in Worker-event wiring, which a fake channel would hide).

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** if the in-process worker daemon dies (uncaught
exception, unhandled rejection, `process.exit`) *after* the handshake, does the
TUI's in-flight turn ever settle, or does it hang "running" with no error? And
if it hangs, should this be promoted to a `fix`?

**Evidence (code):**

- `packages/cli/src/local-runtime.ts:178-180` — the only Worker lifecycle
  listener is `error`, and it just writes `workerError`, which is read only in
  the handshake-failure log line (`local-runtime.ts:213`). Nothing listens for
  the Worker `close` event and nothing closes the channel after the handshake.
- `packages/transport/src/port-channel.ts:41-49,56-65` — `fireClose()` (the
  only path to `onClose`) runs only from the channel's own `close()`. The
  `MessageEndpoint` interface (`port-channel.ts:15-23`) has no lifecycle event,
  so the channel cannot notice the worker dying.
- `packages/transport/src/peer.ts:71,128-142` — `RpcPeer` rejects in-flight
  requests ("connection closed") only on `channel.setOnClose`; the per-request
  timer exists only when `requestTimeoutMs` is set (`peer.ts:95-100`).
- `packages/client/src/remote-client.ts:64` — `new RpcPeer(channel, {...})`
  with no `requestTimeoutMs` (correctly: a turn can be arbitrarily long, so a
  timeout is not the right fix).
- `packages/client/src/remote-session.ts:56-62` — the turn's event queue closes
  only when `client.prompt()` settles. `cancel` (`remote-client.ts:138`) is a
  notification to the (dead) worker, so Esc cannot unstick it either
  (code-derived, not executed).
- `packages/cli/src/worker.ts` has **no** `uncaughtException` /
  `unhandledRejection` handler (nor does `packages/daemon/src`; `rg` finds none),
  so the worker is *not* kept alive — an uncaught error terminates it. Errors
  thrown *inside* an RPC request handler are caught by the peer/`Connection`
  and returned as RPC errors, so the trigger is an error **outside** a handler
  promise chain (timer / event-emitter / stream callback, a fire-and-forget
  rejection, OOM, `process.exit`).

**Repro (real Bun 1.4.3 `Worker`, real `RemoteClient` + `messagePortChannel`,
wired as in `startWorkerRuntime`).** Scripts:
`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/crash-main.ts`
and `.../scratchpad/crash-worker.ts`. The worker answers `initialize` and
`session/new` through an `RpcPeer`, never answers `session/prompt`, and 50 ms
later dies in one of three ways. Output (stack frames trimmed):

```
== throw    (uncaught throw in a setTimeout)
5ms handshake ok
5ms session s1
57ms worker event: error  ... error: boom: uncaught in worker
59ms worker event: close 1
3007ms after 3s: prompt settled = false
== exit     (process.exit(3))
6ms handshake ok
6ms session s1
59ms worker event: close 3
3008ms after 3s: prompt settled = false
== reject   (unhandled promise rejection)
7ms handshake ok
7ms session s1
59ms worker event: error  ... error: boom: unhandled rejection
61ms worker event: close 0
3008ms after 3s: prompt settled = false
```

Facts established: in Bun, a dying worker fires `error` (for throw/rejection,
not for `process.exit`) and then **always** `close` (with the exit code; note an
unhandled rejection exits with code **0**). No `exit` or `messageerror` event
fires. The main thread stays alive, and the pending `session/prompt` never
settles.

**Non-vacuity / fix-direction check:** the same script with one added line,
`worker.addEventListener("close", () => channel.close())`
(`.../scratchpad/crash-main-fixed.ts`), gives in all three modes:
`59ms prompt REJECTED RpcError: connection closed` → `prompt settled = true`.
So the missing `close` → `channel.close()` wiring is the exact property that
causes the hang.

**Veracity verdict: CONFIRMED.** Each of the claim's three points holds, and the
hang reproduces with a real Bun Worker.

**Severity: medium.** The trigger is rare (it needs an error outside a request
handler, or OOM / `process.exit` in the worker), but the result can't be
recovered within the session and gives no sign of what happened: the turn
spins forever, Esc cannot cancel it, the cause in `workerError` is never shown,
and the post-turn `snapshot` → persist step never runs, so the last turn is
not saved. A later prompt would also go to a dead worker (`postMessage` to a
terminated Worker is silently dropped), so it hangs too. Only the worker
runtime is affected; WS/pod channels have their own close paths.

**Trigger:** any worker-side termination after the handshake while a request
(typically `session/prompt`) is in flight. If it happens while idle, the
next request hangs instead.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-17*

**Verdict: real bug — recommend promoting to `docs/fix/worker-crash-hang.md`
(`fix/worker-crash-hang`).** I tried to falsify the claim three ways: (1) a
keep-alive handler in `worker.ts` that would turn the crash into a zombie, which
does not exist; (2) Bun closing the port or firing `messageerror` on the
main-thread side so the channel notices anyway, which does not happen (only
`error` and `close` fire on the `Worker` object); (3) a timeout somewhere on the
client path, which is absent and correctly so. None held, so the hang is real.

**Fix direction (smallest, additive, no protocol change):**

- In `startWorkerRuntime` (`packages/cli/src/local-runtime.ts`), add
  `worker.addEventListener("close", …)` that calls `channel.close()`. The
  `RpcPeer` then rejects every in-flight request with "connection closed"
  (`peer.ts:128-142`), `RemoteSession` fails its queue, and the TUI leaves
  the running state. Later requests reject at once with "peer is closed"
  (`peer.ts:80-81`).
- Surface the cause. Carry `workerError` / the exit code into the rejection or
  the log, so the user sees "worker daemon crashed: <message> (exit N)" and
  not just a bare "connection closed". Log it through the buffered
  stderr/StatusLine path, never as a raw write while Ink is mounted (§7).
- Keep the listener on the `Worker` in `cli`, and do not add a lifecycle event
  to `MessageEndpoint`. Worker/self/MessagePort lifecycles differ, and the
  transport stays a dumb pipe (§7: a target adds only transport + lifecycle).
- Do **not** add a `requestTimeoutMs` to `RemoteClient`. Turns are
  unbounded, so a timeout would mask the bug and break long turns.
- Out of scope for the fix, but worth a note: automatic respawn or falling
  back to in-process mid-session. The daemon owned the live conversation, so
  a crash can at most resume from the last persisted snapshot, and that is a
  separate design.

**Tests for the fix (red before green):** a real-`Worker` test in
`packages/cli/test/` with a tiny fixture worker that handshakes and then dies
(throw, unhandled rejection, `process.exit`). It must assert that the pending
`prompt` rejects within a short bound and that a later request rejects at once.
The repro above already shows it red on current `main` and green with the
one-line wiring. A fake `MessageEndpoint` is not enough, because the property
being tested is Bun's Worker `close` event.

**Residual uncertainty:** what the TUI renders after the rejection (error line
vs. silent reset) was not checked with ink-testing-library, and the Esc/cancel
non-recovery is code-derived only. Both should be pinned in the fix's tests.
