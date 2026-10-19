# eval/session-ttl-limits — detached-session TTL, daemon-wide limits, server keepalive

> **Status:** eval (child of `docs/eval/session-reattach.md`, step 5)
> **Branch:** none until promoted (then `feat/session-ttl-limits`)
> **Type:** eval → feat · **Size:** S–M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (resource teardown on a long-lived `serve`, AGENTS §7)

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

*(empty — filled when promoted)*

## Execution

*(empty — an eval)*

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
