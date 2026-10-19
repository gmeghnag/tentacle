# eval/session-registry — daemon-owned sessions, `session/open` / `close`, detach, fan-out

> **Status:** eval (child of `docs/eval/session-reattach.md`, step 4)
> **Branch:** none until promoted (then `feat/session-registry`)
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (daemon `Connection`, one-session-path invariant, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** move session ownership from `Connection` to a
daemon-wide registry in `SessionHost`, so a session outlives its connection and
any authenticated connection can attach to it.

Evidence and repro: parent `docs/eval/session-reattach.md`. The session map
lives on `Connection` (`daemon/src/connection.ts:54`); `close()` cancels every
turn (`:80`); `ws-server.ts:193-195` calls it on socket close. Absorbs part of
task 2 of `docs/eval/daemon-session-lifecycle.md` (no `session/close`,
duplicate id clobbers a live session, jobs never torn down); the TTL reaper,
limits and keepalive are split into `docs/eval/session-ttl-limits.md` (review
F7: together they were L).

## Implementation

*(empty — filled when promoted)*

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `fix/background-process-groups` and
`session-event-stream`.** The order matters (review F5): detach-on-close is
only correct once `turn_end` is in the stream; otherwise a re-attached client
sees `running` and never learns the turn ended.

Scope:
- `SessionHost` = registry: `open` / `get` / `close`. `HostedSession` gets a
  **set** of attached sinks (fan-out) instead of one `sink`, and a `close()`
  that cancels the turn, detaches every sink, unsubscribes `onExit`, disposes
  its jobs.
- `session/open {sessionId?, since?, messages?}` replaces `session/new`: live →
  attach + `{replay}` or `{resync: true}` (from the event-stream ring/cut);
  absent + `messages` → recreate; else `UnknownSession`. A live id is never
  overwritten.
- `session/close {sessionId}`: idempotent; unknown id is a no-op.
- `Connection.close()` **detaches** instead of cancelling — and drops the
  `disposeJobs()` call that `background-process-groups` adds there today; job
  disposal moves to session `close` and the TTL reaper. Exception (parent
  point 11): a turn whose model is served through this connection
  (`--model-proxy`) is cancelled; the session survives.
- Local runtimes (worker, pod `run`) send `session/close` on exit; the
  process-exit net stays.
- Bumps `PROTOCOL_VERSION` (`session/new` removed); updates the exported schema.

**Why, item by item.**

- **Why move ownership to a registry at all.** The repro's root cause is that
  the session map's lifetime *is* the socket's lifetime (`connection.ts:54,80`).
  It cannot be fixed by "reconnecting to the same `Connection`": every new
  socket creates a new `Connection` object (`ws-server.ts` `open`). The
  registry is the only place whose lifetime is independent of sockets. It also
  gives teardown a single owner — the lifecycle eval found orphaned processes
  precisely because nobody owned the end of a session.
- **Why one `open` instead of `new` + `attach`.** With two methods the client
  must choose based on state it cannot know: did the daemon restart? did the
  TTL fire? did another device recreate it? Choosing wrong means a race (attach
  → reaped meanwhile → error → new → but another device already recreated it).
  The daemon knows; `open` puts the branch where the knowledge is.
- **Why a live id is never overwritten.** Today `session/new` with an existing
  id silently replaces a live session whose sink is still attached
  (`daemon-session-lifecycle` repro 2: misattributed updates, a second agent
  built). With `open`, an existing id *means* attach — the clobber is
  impossible by construction, not by a check someone can forget.
- **Why `open{messages}` recreates.** It preserves today's `--resume` path, and
  it is the only recovery when the daemon lost the session and has no store of
  its own (pod modes; `serve` before `daemon-side-persistence`).
- **Why `close` is idempotent.** It is called from exit paths, retries, and in
  races with the reaper. An error on an unknown id would force every exit path
  to handle an error that means nothing.
- **Why detach instead of cancel on socket close.** That *is* the requirement:
  work continues while the phone is away. Why not keep "cancel" for the TUI:
  one rule for every runtime (AGENTS §7, one session path). Local runtimes send
  `close` on exit, so what they observe does not change.
- **Why the model-proxy exception.** In pod `run` the model is reached through
  the laptop's connection. With it gone, the next `model/stream` fails anyway,
  mid-round, with an obscure transport error. Cancelling cleanly is honest and
  keeps the session for re-attach. A phone never serves the model: the key must
  stay on the identity host (AGENTS §7), and a backgrounded phone cannot keep a
  stream alive.
- **Why a set of sinks (fan-out).** Multi-attach (parent point 9): "attach
  steals" makes TUI and phone evict each other forever; fan-out is simpler and
  lets the TUI watch while the phone answers.
- **Why a slow sink must not block.** One frozen phone socket must not stall the
  agent loop or the laptop's stream. Writing to a sink must never be awaited by
  the emitter; a sink that cannot keep up is dropped and resyncs later — a
  dropped sink costs one resync, a blocking one stalls everyone. Second reason:
  `turn_end` is emitted inside the steering invariant's no-await window
  (`agent.ts`, see `session-event-stream`); an awaited fan-out there would let a
  `session/enqueue` be accepted and then dropped.
- **Why attach must be synchronous in one tick.** JavaScript is single-threaded:
  if an `await` separates "compute replay" from "add sink", events emitted in
  between are in neither → a gap. The reverse order gives duplicates, which
  seq dedupe absorbs; a gap nothing can repair.
- **Why "any authenticated client can open any session" is accepted.** One
  token already grants shell on the daemon; attaching to another session grants
  nothing creating one would not. Preventing it would add complexity for zero
  security. Per-device tokens (parent, out of scope) are the real fix.
- **Why local runtimes send `close` on exit.** Without it, every TUI that quits
  while connected to a `serve` leaves a session idle for 24 h holding memory
  and its jobs. `close` says "I am done" explicitly.

Load-bearing assumption to prove first: nothing outside `Connection` relies on
"session dies with its connection" — grep every `Connection.close` /
`newSession` caller (worker, `serve`, stdio pod daemon) and the `--resume` path.
Second: attach (compute replay + add sink) is synchronous in one tick, so no
event falls between replay and live.

Failure modes: open-while-closing race; two `open{messages}` for the same absent
id concurrently (second attaches, never recreates); daemon restart (sessions
gone → client recreates via `messages`); a client opening an id it never
created (same token = same principal; documented, not prevented); fan-out to a
slow sink must not block the others or the agent loop.

Tests: drop mid-turn → turn continues, a new connection attaches and receives
replay up to `turn_end`; duplicate `open` never builds a second agent (spy
factory); two attached clients both receive every event in order;
model-proxy detach cancels the turn but keeps the session.
