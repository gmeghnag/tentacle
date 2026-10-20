# feat/session-ttl-limits — detached-session TTL, daemon-wide limits, server keepalive

> **Status:** review — APPROVE (fresh-context re-review); awaiting owner OK to commit/merge (promoted 2026-10-20) (child of `docs/eval/session-reattach.md`, step 5)
> **Branch:** `feat/session-ttl-limits`
> **Type:** feat · **Size:** M (was S–M: the plan touches 9 source files across `daemon` + `cli`, see Files) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (resource teardown on a long-lived `serve`, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** once sessions outlive connections
(`docs/eval/session-registry.md`), what bounds them? Split off the registry
child (review F7).

Facts: limits are per connection today (`DEFAULT_MAX_SESSIONS = 64`,
`daemon/src/ws-server.ts:39`); `ws-server.ts` sets neither `idleTimeout` nor
`sendPings` on `Bun.serve`, so Bun defaults apply (not verified what they are
for this Bun version).

## Implementation

### Revision at promotion (2026-10-20) — wins over the draft below

*— claude-opus-5-5, 2026-10-20*

Re-verified against `main` @ `d1864be`: `background-process-groups` and
`session-registry` are merged, so the "assumed" interfaces are now real.
Drift from the draft, each checked in the source:

- **R1 — the assumed interfaces exist, under these names.** `SessionHost.open`
  (synchronous create-or-attach, `session-host.ts:68-85`), `close(id): boolean`
  (idempotent, `:86-95`), `get`/`size`/`values` (`:47-59`); `HostedSession`
  `attach` (`hosted-session.ts:208`), `detach` (`:233`), `close` (`:554`),
  `attachedCount` (`:195`), `running` (`:185-187`); `close()` calls
  `jobs?.dispose()` (`:574`). `running` covers a **compaction** too
  (`controller !== null`, `:185-187`) — correct for
  `busy`: a compaction is work in progress.
- **R2 — load-bearing assumption: already proven on `main`.** "Connection.close()
  only detaches … session/close … kills them" (`daemon/test/integration.test.ts:596-662`)
  runs a real `BackgroundJobs` + `HostExecution`, starts `sleep 3<rand>; true`,
  closes through `SessionHost.close` and asserts `pgrep` finds nothing. T1 reuses
  that exact pattern with `reapExpired` in place of `session/close`.
- **R3 — no "suspended" state exists while detached.** With nobody attached the
  permission requester answers `cancelled` at once (`hosted-session.ts:160-168`),
  so a detached turn never waits on a permission: `busy === running` is complete
  today. The contract handed to `permission-events` (Open question 3) stands.
- **R4 — stamps at the END events only (simpler, equivalent).** Instead of a
  `stamp()` at every transition, two fields: `lastActiveAt` (set when anything
  that keeps a session non-idle ENDS: an attachment removed, the busy slot
  released) and `lastDetachAt` (an attachment removed), both initialised to
  the creation time. Then `quietSince = idle ? lastActiveAt : null` and
  `detachedSince = attached === 0 ? lastDetachAt : null`. Equivalent to the
  draft: a session can only *become* idle at the end of its last
  attachment/busy period, and nothing can end while it is idle. Sites: `detach`,
  `emit`'s throwing-sink removal, `finishTurn` (sync — steering invariant kept),
  `compact`'s `finally`. A start (attach, turn start) needs no stamp: it makes
  the session non-idle, which `liveness()` derives from the live state.
- **R5 — the reaper is owned by `startDaemon` (`cli/src/serve.ts`), not
  `startWsServer`.** `startDaemon` builds the `SessionHost` (`serve.ts:29-36`);
  `startWsServer` is a transport adapter that is *handed* a host it does not own
  (`ws-server.ts:18`). The thing that owns the registry owns its sweep; ws-server
  gets only the keepalive options. `startDaemon` wraps the returned `stop()`.
- **R6 — limit defaults at the exposure boundary.** `SessionHostOptions.maxSessions`
  / `maxDetachedSessions` are optional (unset = no limit), like today's
  `ConnectionOptions.maxSessions` (`connection.ts:51`) whose default lived only in
  `ws-server.ts:51`. `serve` applies the exported defaults (64 / 16); the in-process
  worker, `serve --stdio` and existing tests are unchanged.
- **R7 — Open question 5b is resolved by decision F.** `closeOnBackpressureLimit:
  true` with a 16 MiB limit is already on (`ws-server.ts:193-194`), so a
  non-reading peer is closed at the backpressure limit or the idle timeout,
  whichever first. Nothing to add here.
- **R8 — no protocol change, including `session_closed.reason`.** It is
  `z.enum(["closed"])` (`protocol/src/updates.ts:131`); a reaped session has
  nobody attached (both expiry rules require `attached === 0`), so no client
  ever receives its `session_closed`. A new reason would be a breaking enum
  change for zero readers.
- **R9 — two per-connection cap tests to replace, not one.**
  `integration.test.ts:342-349` and `registry.test.ts:312-330`. The latter's
  property ("a session closed by another client frees the cap") is kept, made
  daemon-wide. `Connection.dropStale()` stays (it still prunes stale entries).
- **R10 — `data` on the refusal works end to end.** `RpcError` carries `data`
  (`transport/src/errors.ts:14-24`) and the peer serialises it
  (`transport/src/peer.ts:347,456-461`) and rebuilds it client-side (`:427-430`).

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

Verified against `main` @ `4914e9b`. Line numbers below are **today's**; the
three children this task builds on (`background-process-groups`,
`session-event-stream`, `session-registry`) are not implemented yet, so the
interfaces they will add are named as **assumed** and must be re-checked by the
executor before the first edit (§8 "if a step contradicts the code, STOP").

### Open questions / contradictions

Each has a recommendation; the plan below follows the recommendation.

1. **Does a daemon-wide limit ever *end* a session?** Parent point 10 and this
   doc's Review say a busy session "ends only by an explicit `close`, a
   daemon-wide limit, or an optional admin cap". Read literally, a limit could
   *evict* a live session — which is the silent loss point 8 rejects.
   **Recommendation: limits are admission control only.** They refuse a *new*
   session (`TooManySessions`, visible error); they never close an existing
   one. The only things that end a session are `close`, the idle TTL (idle
   sessions only) and the opt-in admin cap. Fix the parent's wording on
   approval.
2. **Detached cap: refuse or evict?** The Review says "a visible error instead
   of a slow leak". Refusal has a cost: once a flapping client has piled up
   `maxDetachedSessions` detached sessions, *every* client is refused a new
   session until the TTL (24 h) or an operator restart clears them — there is
   no `session/list` to find and close them. Eviction (close the oldest
   *idle* detached session to make room) avoids that but is a silent close of
   someone's session before its TTL. **Recommendation: refuse** (as the Review
   decided), with an audit line naming the cap and the count, and a default
   generous enough that only a real leak hits it (16, see Design). Owner to
   confirm; if eviction is preferred, it is a ~10-line change in
   `SessionHost.admit` restricted to idle (never busy) sessions.
3. **Order vs `permission-events` (child 7) and `daemon-side-persistence`
   (child 6).** This task (child 5) lands *before* both, so "suspended turn"
   does not exist yet as its own state. Today a turn waiting on a permission is
   simply a running turn (`HostedSession.controller` is set until the turn's
   `finally`, `hosted-session.ts:68-70,113-115`), so `running` already covers
   it in-process. The plan therefore defines **one seam**,
   `HostedSession.busy`, = `running` in this task. Contract handed forward:
   - `permission-events` MUST make `busy` true for a suspended turn, including
     one rebuilt after a daemon restart if that rebuild does not hold an
     `AbortController` (its design is not written yet). Its test list gains
     "a suspended, detached session is not reaped after TTL + 1 h".
   - `daemon-side-persistence` MUST (a) start the TTL at reload time — its
     Review already says "reload sessions as detached; the idle TTL starts"
     (`daemon-side-persistence.md:77-78`) — and (b) make a **reaped/closed
     session's record not reload** (delete or tombstone it). Otherwise every
     restart resurrects reaped sessions with a fresh 24 h, and the reaper
     never frees anything across restarts. Recommendation: reap goes through
     the same `SessionHost.close` as `session/close`, so whatever `close` does
     to the record, reaping does too — one path.
4. **"A silent peer is detached within the keepalive bound (fake timers)"**
   (Review, Tests) **cannot use fake timers**: the ping/idle timers live inside
   Bun's native WebSocket server (uWS), not in JS `setTimeout`. Measured below:
   the smallest effective bound is ~8 s whatever `idleTimeout` is set to (4 s
   timer granularity). **Recommendation:** one real-socket test, ~8–10 s wall
   time, with an explicit per-test timeout of 15 s. If the owner rejects a
   10 s test in the default suite, gate it like the live-k8s test (opt-in env)
   and keep the pure option-mapping test always on.
5. **Keepalive does not bound every dead-peer case — measured.** (a) A peer
   that keeps *reading* TCP but never answers pings is **never** closed while
   the server keeps sending to it: server sends reset the idle timer
   (experiment 2: 24 sends in 25 s, `idleTimeout: 8`, no close). Such a peer is
   alive at the TCP level, so this is acceptable; the reaper does not depend on
   it. (b) A peer that stops reading (frozen app once its kernel buffer is
   full, a truly half-open socket) **is** closed at about `idleTimeout`, but
   the server buffers everything sent meanwhile — measured 12 MB at
   64 KiB / 50 ms before the close at 12 s (experiment 3). Bun's
   `closeOnBackpressureLimit` closes it in 1.5 s, but would also close a
   healthy client receiving one large `snapshot`. **Recommendation:** this task
   sets only `idleTimeout`/`sendPings`; per-sink backpressure ("a sink that
   cannot keep up is dropped and resyncs", `session-registry.md` Review) stays
   with the registry's fan-out, where it can be decided per sink without
   killing the socket. Recorded as debt, not silently assumed.
6. **Default for `maxSessions` changes meaning.** 64 per connection
   (`ws-server.ts:39`) becomes 64 per daemon. For a personal host that is still
   far above use; noted so the Review does not read it as an accidental
   tightening.

### Load-bearing assumption

**Closing a session ends every process it started.** A reaper built on a close
that leaves `sh`'s children alive frees nothing while looking like it does
(this doc's Review, last "Why").

Status: **not provable on today's `main` — an explicit dependency.**
- Today `JobController` has no way to end all jobs: `start/read/kill/list/onExit`
  only (`packages/core/src/jobs.ts:35-49`), and `kill` signals only `sh`
  (`background-process-groups.md` Context, repro 4: `sleep 30009` survives with
  PPID 1).
- `fix/background-process-groups` adds `JobController.dispose()` (group kill,
  TERM → KILL escalation; its Design 2–3) and proved the mechanism on Bun 1.4.3
  (its `pgid.ts`: `detached: true` gives the child its own group; `kill(-pgid)`
  leaves no `sleep 31001`).
- `session-registry` adds `HostedSession.close()` that "cancels the turn,
  detaches every sink, unsubscribes `onExit`, disposes its jobs"
  (`session-registry.md` Review, scope bullet 1) and moves `disposeJobs()` out
  of `Connection.close()`.

**Executor's first step (before any edit):** on the branch with both merged,
re-run the bpg `pgid.ts` script, then write test T1 (below) — a detached
session whose background job runs `sleep 3<rand>; true` is reaped and
`pgrep -f "sleep 3<rand>"` finds nothing. If T1 cannot be made green by the
reaper calling `SessionHost.close`, STOP (§0): the dependency is not delivering
what this plan stands on.

Second, smaller assumption (race-freedom, proven by construction): **a sweep and
an `open` cannot interleave.** The RPC peer dispatches each inbound request with
`void this.handleRequest(...)` (`packages/transport/src/peer.ts:291`), and a
handler runs synchronously until its first `await`. `session-registry` requires
attach to be synchronous in one tick (its Review, "Why attach must be
synchronous"); this plan makes the sweep synchronous too (decide + `close` in
one loop, no `await`). So in a single-threaded event loop one of them runs
entirely first; see Failure modes for both outcomes.

### Preconditions

Verified on `main` (cite) or assumed from an approved/earlier child (named).

- **Today's per-connection limit.** `DEFAULT_MAX_SESSIONS = 64`
  (`daemon/src/ws-server.ts:39`), passed per `Connection`
  (`ws-server.ts:182-186`), checked against *this connection's* map
  (`daemon/src/connection.ts:56,195-199`), error `TooManySessions = -32006`
  (`transport/src/errors.ts:16`). Pinned by
  `daemon/test/integration.test.ts:249-256`.
- **No keepalive options today.** `Bun.serve` gets `hostname/port/tls/fetch/
  websocket{open,message,close}` only (`ws-server.ts:162-199`). Socket close →
  `WsChannel.fireClose()` + `Connection.close()` (`ws-server.ts:193-196`).
- **Bun 1.4.3 defaults, measured** (experiment 1 below): `idleTimeout` 120 s,
  `sendPings` true. The repo's type package is older (`@types/bun` 1.1.14,
  `package.json:25`; its `bun.d.ts` documents the same defaults: 120 s,
  `true`) — the types do not prove runtime behaviour, the experiment does.
- **The CLI WebSocket client answers pings.** `connect` uses the runtime's
  `WebSocket` (`client/src/ws-channel.ts:77`); experiment 1 shows Bun's client
  auto-pongs (`server: pong received` every ping). So `sendPings: true` keeps
  an idle-but-healthy TUI attached indefinitely.
- **Running turn.** `HostedSession.running` = `controller !== null`
  (`daemon/src/hosted-session.ts:68-70`); the controller is cleared in the
  turn's `finally` (`:113-115`). A turn awaiting a permission answer is still
  running (the requester is awaited inside the turn, `:48-52`).
- **Steering invariant.** No `await` from the last steering drain through
  `turn_end` and "on through the daemon's `HostedSession.prompt` clearing its
  controller" (`agent/src/agent.ts:270-278`). Anything this task adds at turn
  end must be synchronous.
- **Where `serve` is configured.** `startDaemon` builds the `SessionHost` and
  calls `startWsServer` (`cli/src/serve.ts:28-43`); the CLI parses `serve`
  flags with `parseFlags` (`cli/src/main.ts:187-240`, `cli/src/flags.ts:18-46`)
  and stops the server on SIGINT (`main.ts:230-235`). The stdio pod daemon
  closes its single connection on stdin end and then the process returns
  (`serve.ts:106-120`, `main.ts:192-197`) — no long-lived registry there, so
  **no reaper and no keepalive on stdio**.
- **Time in pure code is passed in, not read** — the repo's existing pattern
  (`tui/src/App.tsx:345-351` passes `Date.now()` into pure reducers). There is
  no clock abstraction or fake-timer use in the repo today
  (`rg "useFakeTimers|setSystemTime|interface Clock" packages` → nothing).
- **Assumed from `session-registry` (not on `main`; re-check):**
  `SessionHost` holds the registry `Map<string, HostedSession>` and exposes
  `open(...)` (create-or-attach, synchronous attach) and `close(id): void`
  (idempotent, synchronous, unknown id = no-op). `HostedSession` holds a set of
  attached sinks with `attach(sink)` / `detach(sink)` and `close()`.
  `Connection.close()` detaches instead of cancelling.
- **Assumed from `background-process-groups`:** `JobController.dispose(): void`,
  synchronous, idempotent; `HostedSession.close()` calls it.

### Design

**Definitions (the single source of truth, in the pure module).**

- `attached` — number of sinks currently attached to the session (registry).
- `busy` — `running || suspended`. In this task `busy === running`
  (Open question 3); `permission-events` extends it.
- **idle** ⇔ `attached === 0 && !busy`. Background jobs do **not** count:
  a dev server left running by an abandoned session is exactly what the
  reaper exists to stop.
- `quietSince` — the time of the most recent transition **into** idle; `null`
  while not idle. Set on: last sink detached while not busy; turn ended while
  no sink attached; session created detached (persistence reload).
  Cleared on: any attach; turn start.
- `detachedSince` — the time of the most recent transition to `attached === 0`
  (regardless of `busy`); `null` while any sink is attached. Used only by the
  admin cap.
- **TTL expiry** ⇔ idle ∧ `now − quietSince ≥ idleTtlMs`.
- **Admin-cap expiry** ⇔ `adminCapMs` set ∧ `attached === 0` ∧
  `now − detachedSince ≥ adminCapMs` — closes even a busy session; off by
  default.

The timestamps are recorded **at the transitions** (not discovered by the
sweep): a sweep-only design would miss an attach/detach that happens between
two sweeps and reap a session that was used minutes ago — the "re-attach resets
the TTL" property would be false.

**1. Clock seam.** `SessionHostOptions.now?: () => number` (default
`Date.now`). `SessionHost` passes it to every `HostedSession` it builds; both
the stamps and the sweep read the same clock, so a test drives everything with
`let t = 0; now: () => t`. No fake timers anywhere.

**2. `HostedSession` liveness (≈25 lines).** A private `stamp()` recomputes
`quietSince`/`detachedSince` from `attached` and `busy` after each transition:
in `attach`, `detach`, at turn start, and in the turn's `finally` right after
`controller = null` — synchronous, no `await` (steering invariant). Exposed as
a read-only `liveness(): SessionLiveness` (`{ id, attached, busy, quietSince,
detachedSince }`). A session constructed with no sink (persistence reload,
`open{messages}` before attach completes) starts with both stamps = `now()`.

**3. Pure decision — new `daemon/src/session-reaper.ts`.**

```ts
export interface ReapPolicy {
  readonly idleTtlMs: number;          // > 0; default 24 h
  readonly adminCapMs?: number;        // undefined = off (default)
}
export interface SessionLiveness {
  readonly id: string; readonly attached: number; readonly busy: boolean;
  readonly quietSince: number | null; readonly detachedSince: number | null;
}
export type ReapReason = "idle_ttl" | "admin_cap";
/** Pure: which sessions expire at `now`. No I/O, no clock read. */
export function selectExpired(
  sessions: Iterable<SessionLiveness>, now: number, policy: ReapPolicy,
): { id: string; reason: ReapReason }[];
```

Rules exactly as the Definitions; `idle_ttl` wins when both apply. A session
with `attached > 0` is never selected, whatever the policy.

**4. Sweep — `SessionHost.reapExpired(policy): {id, reason}[]`.** Synchronous:
collect `liveness()` of every registered session, `selectExpired(…, now(),
policy)`, then for each result **re-check** that session's liveness (cheap,
guards a future refactor that adds an `await`) and call the registry's
`close(id)`. Returns what it closed so the caller can audit. Reaping is
`close` — no second teardown path (§7 "one session path").

**5. Loop — `startReaper(host, policy, opts)` in `session-reaper.ts`.** A
`setInterval(sweep, sweepIntervalMs)` (default 60 s; the TTL is honoured to
within one interval) with the interval `unref()`'d so it never keeps a process
alive; `opts.setInterval/clearInterval` are injectable (default globals) only
so a test can assert start/stop wiring; the sweep logic is tested directly
through `reapExpired`. Returns `stop()`. Each reaped session → `onAudit("session-reaped <id> <reason>")`.
Started by `startWsServer` (the only long-lived host), stopped by its
`RunningServer.stop()`.

**6. Daemon-wide limits — admission control in `SessionHost`.**
`SessionHostOptions.maxSessions?` (live sessions, default 64) and
`maxDetachedSessions?` (default 16). Checked **only when `open` would create**
(no live id, or `open{messages}` recreating); attaching to a live session is
never refused. Refusal: `RpcError(TooManySessions, "too many sessions on this
daemon (max N)")` or `"… detached sessions on this daemon (max N) — close or
wait for the idle TTL"`; the error carries `data: { limit: "sessions" |
"detached", max }` so a client can tell them apart without parsing text (an
additive field; no new error code). Limits never close an existing session
(Open question 1). `Connection` loses `maxSessions`
(`connection.ts:41,57,67,195-199`); `ConnectionOptions` keeps
`permissionTimeoutMs` (removed later by `permission-events`) and
`maxFrameBytes`.

Why 16 detached: a phone + a laptop TUI + a few `connect`s leave a handful
detached in a day; 16 is above honest use and below "a client reconnects every
few minutes without an id for a day" (which would pile up hundreds).

**7. Keepalive — `ws-server.ts`.** Pass explicitly to `Bun.serve`'s
`websocket`: `idleTimeout: options.idleTimeoutSec ?? 60` and `sendPings: true`.
Measured behaviour (experiment 1): the server pings an idle socket before the
deadline, a healthy client's pong keeps it open, a silent peer is closed at the
first 4 s tick ≥ `idleTimeout` (8 s for 1–8, 32 s for 30, 120 s for the
default 120), firing the same `close` handler → `Connection.close()` → detach
(registry) → the TTL starts. 60 s instead of Bun's 120 s halves the window in
which fan-out keeps buffering for a dead peer (Open question 5b), at the cost
of one ping per idle socket per ~minute. `sendPings: false` is never allowed:
with it a healthy idle client is closed at `idleTimeout` (experiment 1, third
run). `--stdio` is untouched (no socket).

**8. Configuration on `serve`.** New flags, parsed in `main.ts`'s `serve`
branch and passed through `startDaemon` (`ServeOptions`) to
`SessionHostOptions` / `WsServerOptions`:
`--session-ttl <dur>` (default `24h`), `--session-admin-cap <dur>` (default
off), `--max-sessions <n>` (64), `--max-detached-sessions <n>` (16),
`--ws-idle-timeout <dur>` (60s). A pure `parseDuration("24h" | "90m" | "45s"
| "1500ms") → ms` in `cli/src/flags.ts`; invalid or ≤ 0 → `[serve error]` and
exit 1 before binding. HELP text (`main.ts:70-71`) gains one line. No config-file
keys (flags only, like `--host/--port` today) — additive later if wanted.

### Files

Dependency order (protocol → daemon → cli); **no protocol change** (no new
method, no new update variant, no version bump: `TooManySessions` exists, the
`data` field is additive).

1. `packages/daemon/src/session-reaper.ts` — **new**: `ReapPolicy`,
   `SessionLiveness`, `selectExpired` (pure), `startReaper` (loop).
2. `packages/daemon/src/hosted-session.ts` — `now` param, `quietSince` /
   `detachedSince` stamps at attach/detach/turn start/turn `finally`, `busy`,
   `liveness()`.
3. `packages/daemon/src/session-host.ts` — `now`, `maxSessions`,
   `maxDetachedSessions` options; admission check in the create branch of
   `open`; `reapExpired(policy)`.
4. `packages/daemon/src/connection.ts` — drop per-connection `maxSessions`.
5. `packages/daemon/src/ws-server.ts` — `idleTimeoutSec`, `sessionTtlMs`,
   `adminCapMs`, `sweepIntervalMs` options; `idleTimeout`/`sendPings` on
   `Bun.serve`; start the reaper, stop it in `stop()`; remove
   `DEFAULT_MAX_SESSIONS` (moves to `session-host.ts`).
6. `packages/daemon/src/index.ts` — export `ReapPolicy` if `serve.ts` needs the
   type.
7. `packages/cli/src/flags.ts` — `parseDuration`.
8. `packages/cli/src/serve.ts` — `ServeOptions` gains the limits/TTL/keepalive
   fields; pass to `SessionHost` / `startWsServer`.
9. `packages/cli/src/main.ts` — parse the five flags, HELP line.
10. Tests: `daemon/test/session-reaper.test.ts` (new),
    `daemon/test/integration.test.ts` (rewrite the per-connection cap test at
    `:249-256`, add T3–T6), `daemon/test/ws-server.test.ts` (T7),
    `cli/test/…flags…` (T9; executor locates the existing flags test file with
    `rg parseFlags packages/cli/test`).

### Failure modes

- **TTL fires during a turn** → impossible by construction: `busy` sessions are
  never idle, so never `idle_ttl`-selected; only the opt-in admin cap closes a
  busy session, and only when nothing is attached. Pinned by T2/T3.
- **Suspended turn (after `permission-events`)** → covered only if that child
  keeps `busy` true (Open question 3). Until it lands, a pending permission is
  a running turn — also covered.
- **Re-attach races the reaper.** Both synchronous, so one runs first.
  (a) `open` first: the session has `attached > 0` → the sweep skips it.
  (b) sweep first: the session is closed and removed from the registry →
  `open{id}` without `messages` → `UnknownSession` → the client recreates with
  `open{id, messages}` (registry's documented recovery). Never a half-closed
  session receiving an attach. Pinned by T5.
- **Turn ends while detached** → `quietSince` = turn-end time, so the full TTL
  runs from the end of the work, not from the disconnect. Pinned by T3.
- **Clock jumps** (NTP step, suspend/resume of the host): `Date.now()` is wall
  time; a forward jump can reap up to the jump early, a backward jump delays.
  Accepted: the TTL is a 24 h housekeeping bound, not a deadline anyone relies
  on to the second. (`performance.now()` would avoid it but is per-process,
  meaningless for a persisted `quietSince` after a restart.)
- **Sweep throws for one session** (a bug in a `close` path) → catch per
  session, `onError`, continue with the others; never let one bad session stop
  the reaper for the daemon's lifetime. Pinned by a fake-host test in T8.
- **`close` of a reaped session cannot kill a process** (group already gone,
  `setsid`ed child) → owned by `background-process-groups` (`ESRCH`
  swallowed; `setsid` is a documented limit there).
- **Limits at the boundary:** the N+1-th create is refused, the N-th
  succeeds; re-attach at the limit succeeds; after a reap/close a create
  succeeds again (counts are derived from the registry, never a separately
  maintained counter that could drift). Pinned by T6.
- **Detached cap reached by a flapping client** → every new create refused
  until TTL/restart (Open question 2); the audit line makes it diagnosable.
- **Keepalive closes a healthy client** → only if it stops answering pings for
  ~`idleTimeout`; Bun's client and browser/iOS WebSockets auto-pong while the
  app runs. A *frozen* iOS app will be detached — intended (parent point 12):
  its session is not affected, only the socket; it re-opens on foreground.
- **Dead peer during a streaming turn** → buffered until the idle close
  (Open question 5); bounded by Bun's 16 MiB default backpressure limit
  (documented default; experiment 3 shows the close happening before it at
  ~12 MB).
- **`stop()` while a sweep is due** → `clearInterval` first; sessions are not
  closed by `stop()` (process exit follows and the bpg exit net kills job
  groups) — unchanged from today.
- **Model-proxy sessions** → n/a: only `serve --stdio` uses the proxy and it
  runs no reaper; the process ends with its connection.
- **Version skew** → none: no wire change.

### Tests

All new behaviour is red on today's code (the options/methods do not exist →
typecheck/test red); each test pins the exact property, not a correlate.
Fakes: the existing `ScriptedProvider` / `harness` pattern in
`daemon/test/integration.test.ts:19-80`, extended with a `now` option; a
gated slow model (a scripted provider that awaits a test-controlled promise)
for "turn still running"; a real `BackgroundJobs` only in T1. Unique
`sleep 3<rand>` markers + `pkill -f` in `afterEach` (bpg pattern).

- **T1 — load-bearing: reaping ends the session's processes.** Real
  `BackgroundJobs` via the factory; start `sleep 3<rand>; true`; detach; set
  `t += 24h`; `reapExpired` → `pgrep -f` finds nothing. Property: *no process
  of the job's tree alive*, not "close was called". Mutation: make
  `reapExpired` remove the session from the map without calling its `close` →
  must fail.
- **T2 — `selectExpired` table (pure).** idle & `now − quietSince = ttl` →
  reaped; `ttl − 1` → not; `attached = 1` → never (also with the cap); `busy`
  → never without the cap, for any elapsed time (e.g. 30 days); cap set,
  busy, detached ≥ cap → `admin_cap`; cap set, detached < cap → not; both
  apply → `idle_ttl`. Mutation: drop the `busy` check → the 30-day busy row
  fails.
- **T3 — a running turn is never reaped; TTL counts from its end.** Prompt
  with the gated model; drop the connection (detach); `t += 25h`; sweep →
  session still registered and the turn still running; release the model;
  turn ends at `t1`; `t = t1 + 24h − 1` → alive; `+1` → reaped. Mutation:
  stamp `quietSince` at detach only (not at turn end) → the `−1` assertion
  fails.
- **T4 — re-attach resets the TTL.** Create, detach at 0; `t = 23h` attach
  from a second connection, detach at 23h; `t = 46h` → alive (would be reaped
  at 24h without the reset); `t = 47h` → reaped. Mutation: don't clear/re-stamp
  `quietSince` on attach → fails at 46h.
- **T5 — reaper vs open.** (a) at expiry, `open{id}` then sweep → not reaped,
  updates flow. (b) sweep then `open{id}` → `UnknownSession`; then
  `open{id, messages}` → recreated with those messages.
- **T6 — daemon-wide limits.** `maxSessions: 2`: connection A creates 1,
  connection B creates 1, B's third create → `TooManySessions` with
  `data.limit = "sessions"`; B attaching to A's session → allowed. After
  `close` of one → a create succeeds. `maxDetachedSessions: 1`: create + drop
  one, then a new create → refused with `data.limit = "detached"`; after
  the TTL reap → allowed. Mutation: keep the check per `Connection` → the
  cross-connection assertion fails (today's code is exactly this mutation:
  red). Replaces `integration.test.ts:249-256`.
- **T7 — keepalive (real socket, ~8 s, timeout 15 s; Open question 4).**
  `startWsServer({ idleTimeoutSec: 1, … })`; open a raw TCP client that
  completes the upgrade and never answers (the `keepalive.ts` client below)
  and a Bun `WebSocket` client that stays idle. Assert: within 12 s the
  server's `onAudit` logged `connection-close` exactly once (the silent one)
  and the Bun client is still `OPEN`. Mutations: `sendPings: false` → the
  healthy client is closed too → fails; drop `idleTimeout` → the silent peer
  survives 12 s (default 120 s) → fails. Red today: no `idleTimeoutSec`
  option.
- **T8 — loop wiring.** `startReaper` with injected `setInterval`/
  `clearInterval` spies: one interval at `sweepIntervalMs`, `stop()` clears
  it; a host whose `close` throws for one id still closes the others and
  reports the error via `onError`.
- **T9 — `parseDuration`.** `24h`, `90m`, `45s`, `1500ms` → ms; `0`, `-1h`,
  `1d`, `abc`, empty → error.

Non-vacuity summary (§9): T1 (skip `close`), T2/T3 (drop `busy`, wrong stamp
point), T4 (no reset on attach), T6 (per-connection count), T7 (pings off,
timeout default). Each mutation applied, test seen red, reverted — recorded in
Execution.

Gate: `bun run check` green; lint baseline clean (AGENTS §6).

### Experiments (2026-10-19, bun 1.4.3, macOS)

Scripts in `.tentacle/tmp/session-ttl-limits-impl/` (gitignored — pasted in
full).

**1. `keepalive.ts` — defaults and behaviour of `idleTimeout` / `sendPings`.**

```ts
// keepalive.ts — what do Bun.serve websocket idleTimeout / sendPings actually do on this Bun?
// Usage: bun keepalive.ts <idleTimeoutSec|default> <sendPings: true|false|default> <client: bun|silent> <observeSec>
// "silent" = raw TCP client: completes the WS handshake, logs every frame it receives, never answers
// (models a frozen app / half-open peer at the WS layer). "bun" = Bun's WebSocket client (auto-pong).
import { connect } from "node:net";
const [idleArg, pingArg, client, obsArg] = process.argv.slice(2);
const ws: Record<string, unknown> = {
  open() { log("server: open"); },
  message() {},
  close(_w: unknown, code: number) { log(`server: close handler fired code=${code}`); },
  ping() { log("server: ping received"); },
  pong() { log("server: pong received"); },
};
if (idleArg !== "default") ws.idleTimeout = Number(idleArg);
if (pingArg !== "default") ws.sendPings = pingArg === "true";
const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${s}`);
const server = Bun.serve({ port: 0, fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 426 }); }, websocket: ws as never });
log(`bun ${Bun.version}; idleTimeout=${idleArg} sendPings=${pingArg} client=${client}`);
if (client === "bun") {
  const c = new WebSocket(`ws://127.0.0.1:${server.port}`);
  c.onclose = (e) => log(`client: closed code=${e.code}`);
} else {
  const s = connect(server.port, "127.0.0.1", () => {
    s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  let hs = false;
  s.on("data", (b: Buffer) => {
    if (!hs) { hs = true; log("client: handshake response received"); const i = b.indexOf("\r\n\r\n"); b = b.subarray(i + 4); if (!b.length) return; }
    const op = b[0] & 0x0f;
    log(`client: frame opcode=0x${op.toString(16)} (${op === 9 ? "PING" : op === 8 ? "CLOSE" : "other"}) — not answering`);
  });
  s.on("close", () => log("client: TCP closed"));
}
await Bun.sleep(Number(obsArg) * 1000);
log("observation window over");
server.stop(true);
process.exit(0);
```

```
$ bun keepalive.ts default default silent 140
   0.0s bun 1.4.3; idleTimeout=default sendPings=default client=silent
   0.0s server: open
   0.0s client: handshake response received
 104.0s client: frame opcode=0x9 (PING) — not answering
 120.0s server: close handler fired code=1006
 120.0s client: TCP closed
 140.0s observation window over

$ bun keepalive.ts default default bun 140
   0.0s server: open
 104.0s server: pong received
 140.0s observation window over          (healthy client still open at 140 s)

$ bun keepalive.ts 8 default silent 25
   4.0s client: frame opcode=0x9 (PING) — not answering
   8.0s server: close handler fired code=1006
   8.0s client: TCP closed

$ bun keepalive.ts 8 default bun 25
   4.0s / 8.0s / 12.0s / 16.0s / 20.0s / 24.0s server: pong received
  25.0s observation window over          (still open)

$ bun keepalive.ts 8 false bun 25        (sendPings: false, healthy client)
   8.0s server: close handler fired code=1006
   8.0s client: closed code=1006

$ bun keepalive.ts 1 default silent 10   → PING at 4.0s, close at 8.0s
$ bun keepalive.ts 5 default silent 15   → PING at 4.0s, close at 8.0s
$ bun keepalive.ts 30 default silent 40  → PING at 24.0s, close at 32.0s
$ bun keepalive.ts 1 default bun 10      → pongs at 4.0s, 8.0s; still open
```

Read: defaults are `idleTimeout` 120 s and `sendPings` on (the Context's
"unverified" is now verified). Pings keep a healthy client open indefinitely;
a silent peer is closed at the first 4 s tick ≥ `idleTimeout` (minimum ~8 s);
with pings off even a healthy idle client is closed.

**2. `keepalive-send.ts` — do server sends reset the idle timer?**

```ts
// keepalive-send.ts — does the SERVER sending data reset the idle timer? (a dead peer that keeps
// receiving fan-out updates). Silent raw client; server sends a 100-byte text frame every <periodMs>.
// Usage: bun keepalive-send.ts <idleTimeoutSec> <periodMs> <observeSec>
import { connect } from "node:net";
const [idleArg, periodArg, obsArg] = process.argv.slice(2);
const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${s}`);
let sent = 0; let timer: Timer | undefined;
const server = Bun.serve({
  port: 0,
  fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 426 }); },
  websocket: {
    idleTimeout: Number(idleArg),
    open(ws) { log("server: open"); timer = setInterval(() => { const r = ws.send("x".repeat(100)); sent++; if (r <= 0) log(`server: send returned ${r}`); }, Number(periodArg)); },
    message() {},
    close(_w, code) { clearInterval(timer); log(`server: close handler fired code=${code} after ${sent} sends`); },
  },
});
log(`bun ${Bun.version}; idleTimeout=${idleArg}s, server sends every ${periodArg}ms, client silent`);
const s = connect(server.port, "127.0.0.1", () => s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
let pings = 0;
s.on("data", (b: Buffer) => { for (let i = 0; i < b.length; i++) if (b[i] === 0x89) pings++; });
s.on("close", () => log(`client: TCP closed (pings seen ~${pings})`));
await Bun.sleep(Number(obsArg) * 1000);
log(`observation window over (sent=${sent}, pings seen ~${pings})`);
server.stop(true); process.exit(0);
```

```
$ bun keepalive-send.ts 8 1000 25
   0.0s bun 1.4.3; idleTimeout=8s, server sends every 1000ms, client silent
   0.0s server: open
  25.0s observation window over (sent=24, pings seen ~6)
  25.0s server: close handler fired code=1006 after 24 sends   (← only at server.stop)
```

Read: a peer that keeps reading but never pongs is not closed while the server
streams to it (Open question 5a).

**3. `backpressure.ts` — a peer that stops reading.**

```ts
// backpressure.ts — a peer that stops READING (frozen app: kernel buffers fill). Server sends a
// 64 KiB frame every 50 ms. Does idleTimeout close it? Does closeOnBackpressureLimit?
// Usage: bun backpressure.ts <idleTimeoutSec> <backpressureLimitBytes|default> <closeOnBackpressureLimit: true|false> <observeSec>
import { connect } from "node:net";
const [idleArg, bpArg, closeArg, obsArg] = process.argv.slice(2);
const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${s}`);
let sent = 0, dropped = 0, backpressured = 0; let timer: Timer | undefined; let sock: { getBufferedAmount(): number } | undefined;
const opts: Record<string, unknown> = {
  idleTimeout: Number(idleArg), closeOnBackpressureLimit: closeArg === "true",
  open(ws: never) { sock = ws; log("server: open"); timer = setInterval(() => { const r = (ws as { send(s: string): number }).send("x".repeat(65536)); sent++; if (r === 0) dropped++; if (r === -1) backpressured++; }, 50); },
  message() {},
  close(_w: unknown, code: number) { clearInterval(timer); log(`server: close handler fired code=${code} sent=${sent} backpressured(-1)=${backpressured} dropped(0)=${dropped}`); sock = undefined; },
};
if (bpArg !== "default") opts.backpressureLimit = Number(bpArg);
const server = Bun.serve({ port: 0, fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 426 }); }, websocket: opts as never });
log(`bun ${Bun.version}; idleTimeout=${idleArg}s backpressureLimit=${bpArg} closeOnBackpressureLimit=${closeArg}; client stops reading after handshake`);
const s = connect(server.port, "127.0.0.1", () => s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
s.once("data", () => { s.pause(); log("client: handshake done, paused reading"); });
const iv = setInterval(() => { if (sock) log(`server: bufferedAmount=${sock.getBufferedAmount()} sent=${sent} (-1)=${backpressured} (0)=${dropped}`); }, 5000);
await Bun.sleep(Number(obsArg) * 1000);
clearInterval(iv); log("observation window over");
server.stop(true); process.exit(0);
```

```
$ bun backpressure.ts 8 default false 22
   0.0s client: handshake done, paused reading
   5.0s server: bufferedAmount=5621062 sent=98 (-1)=86 (0)=0
  10.0s server: bufferedAmount=12030044 sent=196 (-1)=184 (0)=0
  12.0s server: close handler fired code=1006 sent=235 backpressured(-1)=223 dropped(0)=0

$ bun backpressure.ts 8 1048576 true 12
   1.5s server: close handler fired code=1006 sent=30 backpressured(-1)=17 dropped(0)=1
```

Read: a non-reading (frozen/half-open) peer **is** closed by `idleTimeout`
(here at 12 s), after buffering ~12 MB; `closeOnBackpressureLimit` closes it
much sooner but is a socket-level kill also for a legitimately large send
(Open question 5b).

### Why, item by item

Decisions not already argued in the Review.

- **Why stamps at transitions, not "last seen idle" in the sweep.** The sweep
  only samples every 60 s; an attach-use-detach between two samples would be
  invisible and the session reaped up to 24 h early. Transitions are the only
  exact record.
- **Why a pure `selectExpired` plus a thin loop.** AGENTS §7 "logic lives in
  pure modules": every rule (idle, busy, cap, boundary) is a table test with
  plain numbers; the loop has nothing left to get wrong but start/stop.
- **Why an injected `now()` and not Bun fake timers.** The repo has no
  fake-timer usage; passing time in is its existing pattern
  (`App.tsx:345-351`). It also makes the 24 h tests instant and deterministic
  without patching globals that the RPC peer's own timers use.
- **Why a 60 s sweep, not a timer per session.** One interval for the daemon,
  nothing to cancel on every attach/detach/turn transition; ≤ 60 s of slack on
  a 24 h TTL is irrelevant.
- **Why reaping is `close`.** One teardown path: what `session/close` frees,
  reaping frees (jobs, sinks, `onExit`, persisted record later). A second path
  would drift — the lifecycle eval's orphans came from nobody owning the end.
- **Why background jobs don't keep a session alive.** Otherwise a single
  forgotten `npm run dev` makes the session immortal — the leak the TTL
  exists to close. A user who wants a job to outlive the session should not run
  it through an agent session.
- **Why limits are checked only on create.** Refusing an *attach* would lock a
  user out of their own running work because of someone else's sessions; the
  attach adds nothing to what the daemon holds.
- **Why counts are derived, not counters.** `registry.size` and "sessions with
  `attached === 0`" are computed from the source of truth at check time; a
  separate counter is a second truth that drifts on an exception path.
- **Why the admin cap measures *detached* time, not session age.** A session
  in active use (attached) must never be closed under the user; the cap's job
  is "nobody has looked at this for X, even though it is busy".
- **Why `idleTimeout` 60 s, not Bun's 120 s or something tight.** The value
  bounds how long fan-out buffers for a dead peer (experiment 3) and how stale
  the attached set can be; 60 s halves both for one ping per minute per idle
  socket. Tighter buys little (mobile is reconnect-on-foreground, parent point
  12) and risks closing clients on a briefly blocked event loop.
- **Why set `sendPings: true` explicitly although it is the default.** It is
  the property that keeps a healthy idle TUI attached (experiment 1, third
  run); pinning it in code and in T7 protects it from a Bun default change.
- **Why no reaper/keepalive on `--stdio`.** The stdio daemon has one
  connection and exits when it ends (`serve.ts:106-120`); there is nothing to
  outlive and no socket to ping.
- **Why flags only (no config-file keys).** Matches how `serve` is configured
  today (`--host/--port/--token`, `main.ts:187-229`); a config key is an
  additive follow-up if an operator asks.


## Execution

*— claude-opus-5-5, 2026-10-20*

Built on `feat/session-ttl-limits` off `main` @ `d1864be`, following the
Revision at promotion (R1–R10) over the draft.

**Order.** Tests first: `daemon/test/session-reaper.test.ts` red on `main`
(`Cannot find module '../src/session-reaper.ts'`); then `session-reaper.ts`
(pure `selectExpired` + `startReaper`) → `HostedSession` (clock, stamps,
`liveness()`) → `SessionHost` (`now`, `maxSessions`, `maxDetachedSessions`,
`onAudit`, `admit()`, `reapExpired`) → `Connection` (per-connection cap
removed) → `ws-server.ts` (`idleTimeoutSec` default 60, `sendPings: true`,
`maxSessions` option removed) → CLI (`parseDuration`, `parseServeLimits`,
`startDaemon` applies defaults + owns the reaper, `main.ts` flags + HELP).

**As built (files).**
- `packages/daemon/src/session-reaper.ts` — new: `DEFAULT_SESSION_TTL_MS`
  (24 h), `DEFAULT_SWEEP_INTERVAL_MS` (60 s), `ReapPolicy`, `SessionLiveness`,
  `selectExpired`, `Reapable`, `startReaper` (interval `unref`'d, every sweep
  in try/catch → `onError`, audit `session-reaped <id> <reason>`).
- `packages/daemon/src/hosted-session.ts` — `now` (7th ctor param, default
  `Date.now`); `lastActiveAt`/`lastDetachAt` stamped in `removeAttachment`
  (used by `detach` and by `emit`'s throwing-sink removal), in `finishTurn`
  when the slot is released, and in `compact`'s `finally`; `liveness()`.
- `packages/daemon/src/session-host.ts` — `DEFAULT_MAX_SESSIONS` (64) /
  `DEFAULT_MAX_DETACHED_SESSIONS` (16) exported; `admit()` in the create
  branch of `open` only; refusal = `TooManySessions` with
  `data: {limit: "sessions"|"detached", max}` + audit
  `session-refused <limit> <count>/<max>`; `reapExpired(policy, onError?)`
  synchronous, via `close(id)`, per-session try/catch.
- `packages/daemon/src/connection.ts` — `ConnectionOptions.maxSessions` and its
  check removed; `dropStale()` kept (still prunes closed sessions).
- `packages/daemon/src/ws-server.ts` — `idleTimeoutSec`,
  `DEFAULT_WS_IDLE_TIMEOUT_SEC = 60`, `sendPings: true`; `maxSessions` gone.
- `packages/daemon/src/index.ts` — exports `session-reaper.ts`.
- `packages/cli/src/flags.ts` — `parseDuration`, `ServeLimits`,
  `parseServeLimits` (a flag given with no value → error, never a default;
  `--ws-idle-timeout` whole seconds ≤ 960, Bun's own ceiling — measured: Bun
  throws `websocket expects idleTimeout to be 960 or less`).
- `packages/cli/src/serve.ts` — `ServeOptions extends ServeLimits` (+
  `sweepIntervalMs`); `startDaemon` applies the defaults, starts the reaper,
  `stop()` stops reaper then server. `startStdioDaemon` untouched.
- `packages/cli/src/main.ts` — `parseServeLimits` before `resolveToken` (fails
  before binding), spread into `startDaemon`; HELP lines.
- `packages/cli/package.json` + `bun.lock` — `@tentacle/protocol` as a
  **devDependency** (the e2e test needs `PROTOCOL_VERSION`).

**Drift from the Implementation (and why).**
1. **`SessionLiveness` carries raw stamps, not derived `quietSince` /
   `detachedSince`.** First cut followed the draft; mutation M2 ("drop the
   `busy` check in `selectExpired`") stayed **green** — the rule was
   duplicated (`liveness()` already nulled `quietSince` while busy), so the
   pure rule was dead and the decision lived in the class. Now `liveness()`
   reports `{attached, busy, lastActiveAt, lastDetachAt}` and every rule is in
   `selectExpired` (AGENTS §7 "logic lives in pure modules"); M2 is red.
2. **No per-session "re-check" before `close` in the sweep** (draft Design 4).
   The sweep is synchronous, so the re-check could never differ from the
   decision: untestable dead code. The synchronous contract is documented on
   `reapExpired` instead.
3. **Refusal audit line** (decision D6) — `SessionHostOptions.onAudit`; the
   draft named the line but not where it is emitted.
4. **Tests moved, not rewritten in place.** The two per-connection cap tests
   (`integration.test.ts` "session/open is refused past the per-connection
   cap", `registry.test.ts` "the per-connection cap counts attachments…" and
   "a session closed by another client frees this connection's cap") are
   deleted; their daemon-wide equivalents (re-open by the same connection at
   the cap, attach at the cap, a close by another client frees a slot) are in
   `session-reaper.test.ts` "daemon-wide limits".
5. **T7 asserts the chain, not only the close:** after the silent peer is
   closed, its session is `{attached: 0, busy: false}` (detached → TTL running).
7. **T7 is opt-in (owner, 2026-10-20)** — `test.skipIf(!TENTACLE_SLOW_TESTS)`,
   as Open question 4 allowed. The always-on guard is a new pure
   `socketOptions()` (`ws-server.ts`) spread into `Bun.serve`'s `websocket`,
   pinned by "socketOptions (the keepalive/backpressure contract, always on)";
   M9/M10 are red on it without the slow test. AGENTS §6 baseline updated: two
   opt-in skips.
6. **Added an e2e over a real socket** (`cli/test/serve-limits.test.ts`):
   `startDaemon` with `sessionTtlMs: 200`, `sweepIntervalMs: 25` reaps a
   detached session and audits it (and `open{id}` then gets `UnknownSession`);
   with no options the 17th session is refused while 16 are detached (defaults
   really applied).

**Tests (all new red on `main`: module/options absent).**
`daemon/test/session-reaper.test.ts` (16): pure table (TTL boundary, attached,
busy 30 days, admin cap, precedence), T1 load-bearing (real `BackgroundJobs` +
`HostExecution`, `pgrep` = 0 after the reap), T3 (running turn not reaped at
25 h; TTL from turn end ±1 ms), turn-ended-while-attached, T4 (re-attach
resets), throwing-sink-is-a-detach, admin cap (busy, opt-in, `disposed`),
close-throws-sweep-continues, T5 a/b, T6 (cross-connection, seeded recreate
counts, attach + same-connection re-open allowed, close frees, detached cap
refuses without evicting, TTL reap frees, audit lines), no-limits-by-default,
T8 (interval, `unref`, audit, stop; a throwing sweep is reported and the loop
continues). `daemon/test/ws-server.test.ts` +2 (`socketOptions`, always on; T7, ~12 s
real socket, opt-in `TENTACLE_SLOW_TESTS=1`).
`cli/test/serve-limits.test.ts` (7): `parseDuration`, `parseServeLimits`, e2e ×2.

**Mutations (§9)** — script `.tentacle/tmp/session-ttl-limits/mutate.py`
(applies one, runs the file, restores byte-identical, sha256-checked). All
**RED**:

| # | Mutation | Caught by |
|---|---|---|
| M1 | sweep deletes from the map without `close` | T1 (`sleep` survives), admin cap, close-throws |
| M2 | drop `!s.busy` in `selectExpired` | pure table (30-day busy row), T3 |
| M3 | `>=` → `>` | pure table, T1 |
| M4 | no stamp when the busy slot is released | T3 |
| M5 | detach stamps `lastDetachAt` only | turn-ended-while-attached, T4, throwing sink |
| M6 | throwing sink removed without stamp | throwing-sink test |
| M7 | no per-session catch in the sweep | close-throws test |
| M8 | no `admit()` | both limit tests |
| M9 | `sendPings: false` | `socketOptions` test (always on); T7 (opt-in) |
| M10 | no `idleTimeout` (Bun's 120 s) | `socketOptions` test (always on); T7 (opt-in) |
| M11 | `startDaemon` does not start the reaper | e2e reap |
| M12 | no `?? DEFAULT_MAX_DETACHED_SESSIONS` | e2e defaults |
| M13 | interval not `unref`'d | T8 |
| M14 | no stamp at all on detach | as M5 |
| M15 | `liveness()` reports `busy: false` | T3, admin-cap test |
| M16 | `selectExpired` ignores `attached` | pure table |

First run: M2 **green** → drift 1 above, then red.

**CLI trace** (`.tentacle/tmp/session-ttl-limits/`, throwaway config dir):
```
$ tentacle serve --port 0 --session-ttl 0s
[serve error] --session-ttl: invalid duration "0s" (use e.g. 24h, 90m, 45s, 1500ms)
exit=1
$ tentacle serve --port 0 --ws-idle-timeout 2000s
[serve error] --ws-idle-timeout must be whole seconds, at most 960s
exit=1
```

**Gate.** `bun run check`: typecheck clean, `biome check .` 277 files, no
fixes; `bun test` **967 pass, 2 skip (the opt-in live-k8s and keepalive), 0 fail**
across 103 files (29.1 s, after the Review and Re-review fixes); `TENTACLE_SLOW_TESTS=1` on `ws-server.test.ts`: 12
pass. Suite cost of this task: ~+1 s (T7 is opt-in; with
`TENTACLE_SLOW_TESTS=1` it adds ~12 s and passes).

**Response to the fresh-context Review (2026-10-20).** Each finding addressed
on this branch:
- F1 → test "a compaction counts as busy; the TTL counts from its end"; M17
  (drop the stamp in `compact`'s `finally`) RED.
- F2 → test "a connection forgets a session another client closed" (WeakRef +
  `Bun.gc(true)`, stable 5/5); M19 (drop `dropStale()` in `Connection.open`) RED.
- F3 → test "a busy detached session counts toward the detached cap"; M18
  (count idle-detached only) RED.
- F4 → e2e "the 65th live session is refused (max 64)" (M20 RED) and "stop()
  stops the reaper too" (M21 RED).
- F5 → `startDaemon` derives the sweep: `min(60 s, ttl, adminCap)` unless
  given; the e2e reap test no longer passes `sweepIntervalMs` (M22 — always
  60 s — RED).
- F6 → refusal text now "close one with session/close, or wait for the idle TTL".
- F7 → R1/R3/R5/R7 line numbers corrected against `main` @ `d1864be`. They had
  been cited from the draft's layout without re-opening the files — a slip the
  Review caught.
- F8 → `main` gained two CI commits (`2193a4c`, `82e7fcb`); merge `main` into
  the branch before merging back.
- F9 → already done (AGENTS §6 lists both opt-in skips).
- F10 → handoff: `daemon-side-persistence` must add a restore seam for
  `lastActiveAt`/`lastDetachAt` (today the constructor stamps `now()`).

**Response to the Re-review nits (2026-10-20).** A and B closed: the period
is a pure `sweepIntervalFor(ttl, cap)` in `cli/src/serve.ts` =
`max(1 s, min(60 s, ttl, cap))`, pinned by a table test (M22 TTL term, M23 cap
term, M24 floor — all RED) plus an e2e where a 200 ms admin cap alone closes a
detached session (`session-reaped <id> admin_cap`). C (a client cannot find a
session id to close without `session/list`) is the disclosed D6 lockout; left.

**Not done / left as is.** The keepalive does not close a peer that keeps
*reading* but never pongs while the server streams to it (Open question 5a,
measured): it is alive at TCP level and the reaper does not depend on it.
`Date.now()` wall clock (failure mode "clock jumps") accepted as designed.

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `session-registry`.** Scope:
- Reaper: close a session when it has no attachment, **no running or
  suspended turn**, and the **idle TTL of 24 h** (owner decision, configurable
  on `serve`) has elapsed. A turn suspended on a permission is never reaped
  (parent point 8): it ends only by `close`, a daemon-wide limit, or an optional
  admin cap (configurable, off by default).
- Daemon-wide limits: max live sessions (replaces per-connection
  `maxSessions`), and a cap on detached sessions so a flapping client cannot
  pile them up.
- Keepalive: set `idleTimeout`/`sendPings` explicitly to reap half-open sockets
  server-side. Not the mobile strategy (a frozen iOS app does not answer pings —
  parent point 12).

**Why, item by item.**

- **Why any TTL.** Sessions no longer die with their socket. Without a bound,
  every abandoned session — app uninstalled, TUI killed with `-9`, laptop lid
  closed forever — lives indefinitely in a long-running `serve`, together with
  its background jobs (dev servers holding ports, watchers burning CPU).
- **Why 24 h.** Owner decision (2026-10-19). Reasoning: on a host you own, an
  idle session costs only memory (history + agent objects) plus whatever jobs
  it started; 24 h covers "I'll pick it up tomorrow" without accumulating a
  week of abandoned sessions. Configurable because a small or shared host may
  want less.
- **Why a running or suspended turn is never reaped.** Reaping a running turn
  destroys work in progress — the opposite of the feature. Reaping a suspended
  one would be a deny-by-timeout under another name, which the owner explicitly
  rejected: a flat battery is not a decision (parent point 8).
- **Why the admin cap is off by default.** Any default value re-introduces, for
  someone, the silent loss the owner rejected. An operator who needs a hard
  bound opts in knowing what it does.
- **Why limits become daemon-wide.** Per-connection limits made sense when
  sessions died with their connection. Now a client reconnecting N times could
  hold N × 64 sessions. What we protect — memory, processes — is per daemon, so
  the limit must be too.
- **Why a separate cap on detached sessions.** A buggy or flapping client that
  re-opens *without* an id on every reconnect creates a new session each time;
  the cap turns that into a visible error instead of a slow leak.
- **Why keepalive, and why it is not the mobile strategy.** Server-side pings
  detach half-open sockets so fan-out stops writing to dead peers (their send
  buffers grow) and the attached-clients set stays truthful. A backgrounded iOS
  app is frozen and answers no ping; the phone's real model is
  reconnect-on-foreground (parent point 12). Tuning pings for mobile would be
  effort spent on the wrong side.
- **Why process-group kill is the load-bearing assumption.** Closing a session
  must free what it holds. `daemon-session-lifecycle` repro 4 showed `kill`
  reaches only `sh`: compound commands survive. A reaper built on that leaks
  forever while *looking* like it frees resources — worse than no reaper,
  because nobody goes looking.

Load-bearing assumption to prove first: closing a session really ends its
processes — depends on `fix/background-process-groups` (kill the group, not
`sh`); verify with `pgrep` after a reaped session that ran `sleep N; true`.

Failure modes: TTL fires during a turn (must not — guarded); re-attach races
the reaper (attach wins if it lands first; after close → `UnknownSession` →
client recreates from `messages`); clock in tests (inject a timer).

Tests: reaper closes only idle+detached sessions after 24 h (fake timers), never a suspended one; a re-attach resets the TTL;
limit rejects the N+1th session with a domain error; a silent peer is detached
within the keepalive bound (fake timers).

### Review of the implementation (fresh context)

*— claude-opus-5-5, 2026-10-20 (fresh context; the SAME model as the executor — see "Reviewer" below)*

**Verdict: APPROVE-WITH-NITS.** The behaviour is correct on every path I attacked, and
it respects the §7 invariants and owner decisions G and D6. Two of the stamp/prune
sites the change relies on are **not pinned by any test**: mutations survive (findings 1–2).
Both are test-only fixes, cheap, and should land before merge. Everything else is a nit.

**Findings**

1. **minor — the compaction stamp is untested.** `hosted-session.ts:544`
   (`lastActiveAt = now()` in `compact`'s `finally`) is one of the four R4 sites,
   but deleting it leaves `bun test packages/daemon/test/` green (mutation R4
   below). Effect if it regressed: a client that detaches mid-compaction gets its
   TTL counted from the detach instead of from the compaction's end. The session is
   then reaped early, by at most the length of the compaction. The executor's
   table (M4/M5/M6/M14) covers the turn-end, detach and sink sites, not this one.
2. **minor — `dropStale()` in `Connection.open` lost its only pin.**
   `connection.ts:243`. Execution's drift 4 deleted `registry.test.ts` "a session
   closed by another client frees this connection's cap (no stale entry)". That
   test's own comment named this exact mutation. The daemon-wide replacement
   ("a close frees a slot") goes through `SessionHost`, not through the
   connection's map, so dropping the call is now green (mutation R1). The impact
   today is a retained reference (memory), not a wrong count. Still, R9 says the
   property "is kept", and it is not.
3. **nit — whether busy-detached sessions count toward the detached cap is
   unpinned.** At `session-host.ts:132`, excluding `running` sessions stays green
   (R2). Counting them is the reading of D6 I agree with ("detached" means nobody
   attached), but nothing fixes it.
4. **nit — two `serve` defaults are unpinned.** `maxSessions ?? DEFAULT_MAX_SESSIONS`
   (`serve.ts:43`, R8) and `stop()` stopping the reaper (`serve.ts:79`, R5) are both
   green when removed. The e2e test only pins the detached default (16), which
   always fires before 64.
5. **nit — TTL resolution is the 60 s sweep, and this is invisible on the CLI.** In
   the end-to-end trace, `--session-ttl 1s` reaped at 60.1 s. The sweep interval
   has no flag and is not in HELP. Only the code comment says "honoured to within
   one interval". Harmless at 24 h, surprising at small values.
6. **nit / disclosure — the refusal advice cannot be acted on.** The message says
   "re-attach and close one" (`session-host.ts:140`), but without `session/list`
   only a client that kept its ids can do that. Every other client is locked out
   for up to the TTL, or until `serve` restarts. This is disclosed (Open question 2)
   and decided by the owner (D6). Recording it so the message gets fixed when
   `session/list` exists.
7. **nit — several premise line numbers are stale; every property holds** (see the
   table).
8. **info — `git diff main` shows `.github/workflows/build.yml` deleted.** This is
   not part of this task: `main` advanced (`2193a4c`, `82e7fcb`) after the branch
   base `d1864be`. Merge or rebase before merging, or that file will look deleted
   in review.
9. **nit — the AGENTS §6 test baseline is now stale.** It says "all pass except the
    single opt-in live-k8s skip", but the default suite now has 2 opt-in skips. Update
    §6, which is a docs carve-out, and the Execution gate line. Neither the
    keepalive contract nor the wiring loses coverage in the default suite: the
    pure test catches M9/M10, and the backpressure real-socket test catches a
    dropped spread (R9). The silent-peer/healthy-peer behaviour itself (pong
    resets Bun's idle timer) now runs only opt-in.
10. **info — handoff to `daemon-side-persistence`.** That plan restores
   `lastActiveAt` from the record (`docs/eval/daemon-side-persistence.md:411,430`).
   The constructor always stamps `now()` and has no restore seam, so that child has
   to add one.

**Gate (re-run by me).** First run: `tsc --noEmit` clean; `biome check .` 277 files,
no fixes; `bun test` 960 pass, 1 skip, 0 fail, 961 tests (37.0 s), matching Execution.
**After the owner-requested change made during this review** (the real-socket
keepalive test became opt-in, and the options moved into the pure `socketOptions()`
with an always-on test), I re-ran it: `bun run check` exit 0; `tsc` clean; `biome` 277
files, no fixes; `bun test` **960 pass, 2 skip (live-k8s + slow keepalive, both
opt-in), 0 fail**, 962 tests in 103 files (26.7 s). With `TENTACLE_SLOW_TESTS=1`,
`ws-server.test.ts` gives 12 pass, 0 fail. Test counts in the new files also match
Execution: 16 in `session-reaper.test.ts`, 7 in `serve-limits.test.ts`, +1 in `ws-server.test.ts`.

**Mutations.** I used my own runner, `.tentacle/tmp/session-ttl-limits-review/mut.py`. It
sha256-checks the file before and after each mutation. Afterwards I confirmed the
`git diff --stat` line and the sha of every file in `daemon/src` + `cli/src` were
identical to before the run.

| # | Mutation | Narrow test | Result |
|---|---|---|---|
| X-M1 | sweep deletes from map, no `close` | session-reaper | RED (3: load-bearing pgrep, admin cap, close-throws) |
| X-M2 | drop `!s.busy` | session-reaper | RED (3) |
| X-M4 | no stamp at turn end | session-reaper | RED (1: T3) |
| X-M8 | no `admit()` | session-reaper | RED (2) |
| R1 (mine) | drop `dropStale()` in `Connection.open` | all daemon tests | **GREEN — finding 2** |
| R2 (mine) | detached cap excludes busy | session-reaper + serve-limits | **GREEN — finding 3** |
| R3 (mine) | `admit()` on the attach path too | session-reaper | RED (2) |
| R4 (mine) | no stamp in `compact`'s `finally` | all daemon tests | **GREEN — finding 1** |
| R5 (mine) | `stop()` leaves the reaper running | serve-limits | GREEN — finding 4 |
| R6 (mine) | flag without value accepted | serve-limits | RED |
| R7 (mine) | `--session-ttl` ignored (always default) | serve-limits | RED |
| R8 (mine) | no `?? DEFAULT_MAX_SESSIONS` | serve-limits | GREEN — finding 4 |
| M9 (re-run after `socketOptions`) | `sendPings: false` | ws-server, default / SLOW=1 | RED / RED (the pure test, plus the real socket) |
| M10 (re-run) | `idleTimeout: 120` | ws-server, default / SLOW=1 | RED / RED |
| R9 (mine) | drop `...socketOptions(options)` from `Bun.serve` | ws-server, default / SLOW=1 | RED (the always-on backpressure test) / RED |

**Premise table.** Line numbers are on `main` @ `d1864be`.

| Cite | Claim | Verdict |
|---|---|---|
| R1 `session-host.ts:68-85` | sync `open` create-or-attach | TRUE |
| R1 `session-host.ts:88-96` | idempotent `close(id): boolean` | TRUE (actually :86-95) |
| R1 `session-host.ts:48-60` | `get`/`size`/`values` | TRUE (:47-59) |
| R1 `hosted-session.ts:167-205,555-576` | attach/detach/close/attachedCount/running | property TRUE; range wrong (attach :208, detach :233, close :554) |
| R1 `:575` | `close()` calls `jobs?.dispose()` | TRUE (:574) |
| R1 `:162-164` | `running` covers compaction | property TRUE (`controller !== null`, :185-187); line wrong |
| R2 `integration.test.ts:596-662` | real jobs + pgrep close test | TRUE |
| R3 `hosted-session.ts:144-148` | requester answers `cancelled` when nobody attached | property TRUE; line wrong (:160-168) |
| R5 `serve.ts:29-36` | `startDaemon` builds the host | TRUE |
| R5 `ws-server.ts:24` | ws-server is handed the host | property TRUE; line :18 |
| R6 `connection.ts:51`, `ws-server.ts:51` | per-conn option / default 64 | TRUE |
| R7 `ws-server.ts:186-189` | `closeOnBackpressureLimit: true`, 16 MiB | property TRUE; line :193-194 |
| R8 `updates.ts:131` | `reason: z.enum(["closed"])` | TRUE |
| R9 `integration.test.ts:342-349`, `registry.test.ts:312-330` | per-connection cap tests | TRUE (both, plus the stale-entry test that follows them) |
| R10 `errors.ts:14-24`, `peer.ts:347,456-461,427-430` | `data` round-trips | TRUE; and the trace below received `data` client-side |
| Exec | Bun throws above `idleTimeout` 960 | not re-measured; the CLI rejects 2000s (checked) |

**End-to-end trace.** Script: `.tentacle/tmp/session-ttl-limits-review/trace.ts`. It starts the real CLI
`serve --port 0 --session-ttl 1s --max-detached-sessions 1 --max-sessions 2
--ws-idle-timeout 5s` and drives it with the real `RemoteClient` over `connectWebSocket`:
```
[0.2s] A opened ad92cfc2-…
[1.7s] A still attached after 1.5s (> ttl): reaped? false
[1.7s] serve: [daemon] connection-close
[2.0s] serve: [daemon] session-refused detached 1/1
[2.0s] B create refused: code=-32006 data={"limit":"detached","max":1} msg=too many detached sessions on this daemon (max 1) — re-attach and close one, or wait for the idle TTL
[60.1s] serve: [daemon] session-reaped ad92cfc2-… idle_ttl
[60.1s] B create after reap: a0bc97a5-…
[60.2s] serve exit=0
```
CLI errors (each `exit=1`, before binding): `--session-ttl 0s`, `--ws-idle-timeout 2000s`,
`--max-sessions` (no value), `--max-detached-sessions -1`, `--session-admin-cap 1.5h`.

**Attacks tried**

1. *Liveness-stamp argument.* I enumerated every write to the busy slot and the
   attachment set: `rg "controller = null|attachments\.(delete|clear)"`.
   - `finishTurn` (:479) and `compact` (:542) are stamped.
   - `removeAttachment` (:221) covers `detach` and the throwing-sink removal.
   - `attach`'s delete+add (:255) re-adds synchronously: no gap.
   - `close()`'s `clear()` (:602) runs on a session already out of the registry.
   - The retried open (`connection.ts:249`) is detach (stamped) then attach.
   - `cancel` and the throwing `turn_start` emit both end in `finishTurn`. `emit`
     catches internally. `finishTurn` is idempotent per turn and stamps only when
     it releases the slot.

   Result: the argument holds. Only the compaction site is untested (finding 1).
2. *Reaper vs `open`, `lookup` and `dropStale`.* Both `reapExpired` and `open` are
   synchronous and nothing awaits. A connection can hold an entry for a reaped
   session only through the throwing-sink path: the attachment is gone, so the
   session counts as detached. `lookup`'s identity check
   (`host.get(id) === entry.hosted`) then answers `UnknownSession`. Result: no
   wrong state; the prune path is no longer pinned (finding 2).
3. *Admission bypass.*
   - A seeded `messages` open and `create:true` with a dead id both reach `admit()`
     (it sits after the UnknownSession check and before `build`).
   - Concurrent opens are serialised by the synchronous `open`.
   - Attach is never refused: mutation R3 is RED.
   - Counting busy-detached sessions matches D6, though unpinned (finding 3).
   - The lockout is disclosed (finding 6).
4. *§7 invariants.*
   - One teardown path: the reap is `SessionHost.close`; M1 is RED with pgrep.
   - No await or lock added to `Connection` handlers.
   - `finishTurn` gains only a synchronous `now()`, so the steering no-await test
     stays green.
   - `onAudit` goes to `serve`'s stdout, never through an Ink path. The reaper
     exists only in `startDaemon`, its only caller is `main.ts:227`, and
     `startStdioDaemon` is untouched.

   Result: nothing found.
5. *Keepalive.*
   - The pod `run`/`attach` path is `serve --stdio` (`main.ts:196`), so it never
     reaches `Bun.serve`: 60 s cannot affect it.
   - The client `ws-channel.ts` has no ping code. It relies on the WebSocket
     auto-pong, which T7's healthy client exercises on Bun's own client.
   - Pings do not fight `closeOnBackpressureLimit`. A peer that reads but never
     pongs while being streamed to is not closed; Execution discloses this (5a).
   - 60 s halves Bun's prior 120 s for a sleeping laptop's `connect`. That is not
     a new failure mode: reconnect belongs to `client-reattach`.

   Result: nothing found.
6. *CLI edge cases.*
   - Flags with no value, zero, negative and fractional values all fail before
     binding.
   - `--max-sessions` below the live count cannot happen, because limits exist
     only at startup.
   - A typo'd flag (`--sesion-ttl`) is silently ignored. That is pre-existing
     `parseFlags` behaviour, not this task's.
   - `startDaemon` called programmatically with `sessionTtlMs: 0` is not
     validated: CLI-only validation, harmless.
7. *Prior art.* `session-registry.md:141` anticipated `reason: "expired"`. R8's
   rejection is sound: every reaped session has 0 attachments, so nobody reads it.
   `background-process-groups.md:723` (a reaper must drop job handles) is satisfied
   via `close` → `jobs.dispose()`. `TODO.md:213` (the per-connection `maxSessions`
   fix) is a closed historical entry, now superseded. I found no open item that
   blocks this task.

**What holds.**
- The rules live in the pure `selectExpired` (drift 1 is a real improvement: it was
  caught by M2 going green).
- Reaping is `close`.
- Limits only refuse and never evict (G, D6).
- Attach is never refused.
- Counts are derived, not kept as counters.
- The interval is `unref`'d, and both the sweep and each close are fail-soft.
- `idleTimeout`/`sendPings` are explicit, and T7 is a real-socket test that both
  M9 and M10 break.
- The CLI fails before binding, and the defaults are applied at the exposure
  boundary only.

**How the executor behaved.** It worked tests-first and followed the Revision. It
reported its own vacuous mutation (M2 green) and fixed the design instead of
the test. The Execution claims I checked (gate counts, test counts, CLI messages,
mutations M1/M2/M4/M8) are accurate. It missed one of its own four stamp sites in
both tests and mutation table (compaction). It also deleted a test whose pinned
property (connection-level stale prune) has no other pin, while describing that
property as "kept". The premise lines were cited from memory of an older layout:
every property is right, several line numbers are not.

**Reviewer.** I am `claude-opus-5-5`, the same model as the executor (and as the
planner), in a fresh context only. Shared blind spots survive both passes. The
gaps I found are omissions, which a fresh context does catch. A misreading of
Bun keepalive semantics, or of the "stamp at END" argument, that we would both
make is not excluded. AGENTS §10 would prefer a different model for a
load-bearing review.

#### Re-review (after the executor's response)

*— claude-opus-5-5, 2026-10-20 (same model as the executor; fresh context, as above)*

**Verdict: APPROVE.** Findings 1–4 are now pinned. Each of the properties I
mutated independently (`.tentacle/tmp/session-ttl-limits-review/mut3.py`, every
file sha256-restored, `git status` unchanged) now fails its test:

| Mutation | Result |
|---|---|
| drop the compaction stamp | RED |
| drop `dropStale()` from `open` | RED |
| make `dropStale`'s body a no-op | RED |
| exclude busy sessions from the detached count | RED |
| no `maxSessions` default | RED |
| `maxSessions` default 65 | RED |
| `stop()` leaves the reaper running | RED |
| sweep always 60 s | RED |
| sweep ignores `adminCap` | **GREEN** (nit A) |

**WeakRef test.** Run alone 15 times: 15/15 pass. Whole file run 10 times: 10/10,
0 fail. Not vacuous: both `dropStale` mutations turn it RED.

**Gate.** `bun run check` exit 0: `tsc` clean; `biome` 277 files, no fixes;
`bun test` **965 pass, 2 skip (both opt-in), 0 fail**, 967 tests in 103 files.

**Attacks on the sweep derivation** (`serve.ts:72-74`):
- With `adminCap < ttl`, the interval is `adminCap`, which is correct.
- `--session-ttl 1ms` gives a 1 ms interval. I measured `startReaper` against a
  64-entry fake host: about 2.5 % of a core, against 0.2 % at 1 s. It is bounded,
  and an operator only gets it by asking for it explicitly.

**Nits (do not block merge)**
- A. The `adminCap` term of the `min` is unpinned.
- B. There is no floor on the interval. Clamping to ≥ 1 s, or rejecting a TTL
  below 1 s, would be cheap.
- C. The new refusal text ("close one with session/close") still needs an id that
  a client without `session/list` does not have. This is the same disclosure as
  finding 6.
