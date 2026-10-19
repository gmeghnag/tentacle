# eval/client-reattach — `RemoteClient` reconnects and resumes transparently

> **Status:** eval (child of `docs/eval/session-reattach.md`, step 8)
> **Branch:** none until promoted (then `feat/client-reattach`)
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (TUI-over-RPC one-session-path invariant, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** the client half of re-attach — reconnect, `open`
with the last cut, apply replay or resync — living in `RemoteClient` so every
frontend (TUI over `connect`/`attach`, the future mobile app) gets it without
code of its own.

Evidence: today a dropped socket rejects the in-flight `prompt` with
`connection closed` and nothing reconnects (parent Repro).
`client/src/ws-channel.ts:69-77` builds the token URL with `URL.searchParams`
and passes headers as the 2nd `WebSocket` argument — fine on Bun, likely not on
React Native (unverified; a mobile client brings its own `DuplexChannel`
adapter, the "a new target adds only a transport" shape of AGENTS §7).

Related: `docs/feat/pod-attach-resilience.md` (keepalive + reconnect for pod
`attach`, not started) — likely absorbed by this child; decide when promoting.

## Implementation

*(empty — filled when promoted)*

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `session-event-stream`, `session-registry` and
`permission-events`.** A suspended turn (parent point 8) must render as
"waiting for your approval" with working Approve / Deny after any resync. Scope:
- A **pure, React-free reducer** (AGENTS §7 "logic lives in pure modules"):
  `(state, event | openResult | snapshotPage) → state`; applies `seq > since`,
  drops `seq ≤ since`, rebuilds on resync (discarding the partial round),
  applies `history_replaced`, ignores unknown *display* events, fails loudly on
  an unknown *mandatory* one.
- `RemoteClient`: reconnect with backoff via an injected channel factory;
  `open{sessionId, since}`; on resync, paged `snapshot` → reducer → replay;
  re-send un-acked commands with their idempotency keys.
- Persistence unchanged: the main thread persists from `snapshot` after
  `turn_end` and after every resync.
- TUI: a "reconnecting…" status via the single `StatusLine` path — never raw
  terminal writes (AGENTS §7).
- Test vectors (frame sequence + drop point + expected reducer output) written
  as **JSON fixtures**, validated against the exported schema
  (`docs/eval/protocol-schema-export.md`), so a Swift/Kotlin client can run the
  same cases.

**Why, item by item.**

- **Why in `RemoteClient`, not in each frontend.** If the TUI, the React Native
  app and an ACP adapter each implemented reconnect, they would diverge, and the
  subtle parts (the cut, seq dedupe, the compaction barrier) would be
  re-implemented wrong at least once. One session path (AGENTS §7); React
  Native imports the same TypeScript module.
- **Why a pure reducer.** The logic is a state machine with many edge cases
  (gap, duplicate, resync mid-round, barrier, unknown event). Pure and
  React-free, it can be tested exhaustively as a table, without sockets or
  rendering (AGENTS §7: logic in pure modules; the TUI harness strips SGR, so
  render-time logic is untestable).
- **Why drop `seq ≤ since` instead of trusting the daemon not to resend.**
  Re-sent events are normal: the ack-ambiguity retry, a replay overlapping
  frames that were in flight. Idempotent application is what makes recovery
  safe to repeat.
- **Why discard the partial round on resync.** The snapshot's cut sits *before*
  the round in flight (F1), so replay re-sends that round in full; keeping the
  local partial would show its first part twice.
- **Why fail loudly on an unknown mandatory event.** Ignoring it means a hang:
  a spinner forever, or an approval nobody can see. A loud "please update" is
  recoverable; a silent hang is not.
- **Why an injected channel factory.** Every reconnect needs a fresh socket.
  Injection also allows `FakeWS`-driven tests and lets React Native or Swift
  bring their own transport (the `URL.searchParams` / header issue in
  `ws-channel.ts:69-77`).
- **Why re-send un-acked commands with the same keys.** It is the ambiguous-ack
  case: without the keys a re-send duplicates the command; without the re-send
  the command is lost.
- **Why persist after `turn_end` and after every resync.** Keeps the AGENTS §7
  rule that the client persists from `snapshot`. After a resync the local state
  was rebuilt from the daemon, so persisting then keeps disk aligned with what
  the user sees.
- **Why the status goes through `StatusLine`.** "Reconnecting…" is exactly the
  kind of message someone would `console.log` mid-session, corrupting Ink's
  render (AGENTS §7: never write raw while Ink owns the terminal).
- **Why a backoff cap and stop-on-401.** Unbounded fast retries drain a phone
  battery and hammer the server; a rejected token is not transient, retrying it
  only hides the real problem from the user.
- **Why JSON test vectors.** The property is the contract, not the TypeScript
  code; a Swift or Kotlin client must pass the same cases. Writing them as data
  costs nothing now and avoids a translation later.
- **Why the suspended-turn rendering is called out.** The owner's scenario —
  phone dies on a pending approval, comes back hours later, finds the turn
  waiting with working Approve / Deny — is the acceptance test of the whole
  redesign. If it does not work end to end, the rest does not matter.

Failure modes: reconnect while a command is in flight (re-send with same key);
daemon restarted (`UnknownSession` → recreate with persisted `messages`); token
rejected (stop retrying, surface it); endless flapping (backoff cap +
user-visible state). Mobile note (owned by the mobile eval): a frozen iOS app
reconnects on foreground; this module just has to make that a normal resume.

Tests: the parent's revised property end to end (client + daemon, in-memory
channel pair): every drop point *k*, both re-attach and fresh/forced-resync
mid-round, ordered reducer output (incl. the partial message) + seq contiguity.
Mutations that must fail it: disable seq dedupe; skip the resync snapshot;
ignore `history_replaced`.
