# eval/permission-events — permission requests as session state, answered by any attached client

> **Status:** eval (child of `docs/eval/session-reattach.md`, step 7)
> **Branch:** none until promoted (then `feat/permission-events`)
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (single-broker + pod-trust invariants, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** replace the daemon→client `session/request_permission`
request with a `permission_request` stream event plus a
`session/resolve_permission` command, so a pending approval survives a
disconnect and can be answered from whichever client is attached.

Evidence: the requester is captured once per session from the creating
connection (`daemon/src/connection.ts:179`, `hosted-session.ts:48`); a closed or
timed-out request is coerced to `cancelled` (`connection.ts:208`); the
deadline is a flat 5 min (`ws-server.ts:38`). Session-remembered grants
("allow always") are cached **daemon-side** in `PermissionGate`
(`agent/src/permission-gate.ts:70-77`: `isRemembered` → approve without asking;
`remember` on a `session`-scope answer); `daemon/src/permission-map.ts:49-50`
only maps the wire outcome to that scope.

## Implementation

*(empty — filled when promoted)*

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `session-registry` and `daemon-side-persistence`.** Scope:
- `permission_request{requestId, toolCallId, …}` (mandatory event);
  `session/resolve_permission{sessionId, requestId, outcome}`;
  `permission_resolved{requestId, outcome}` fanned out so every client closes
  its dialog.
- `requestId` is a fresh nonce per request, never reused across a
  cancelled/restarted turn.
- First valid answer wins; a late/unknown `requestId` → explicit
  `PermissionNotPending` (never silently dropped).
- **No timeout** (parent point 8, owner decision): a pending request
  *suspends* the turn until a person answers (approve / deny) or a client
  cancels the turn — attached or not. Remove the permission deadline
  (`permission-timeout` option, `ws-server.ts:38`) for this path; a dead socket
  never produces a deny. The TTL reaper skips suspended turns.
- **Suspension survives a daemon restart** (`serve`): from the daemon-persisted
  history, a trailing assistant tool call with no result and a recorded pending
  request → rebuild the suspended turn and re-emit `permission_request`
  (new nonce). Coordinate with `docs/eval/history-validity-invariant.md`:
  "awaiting permission" is a legitimate state, not a dangling call to repair.
- Bumps `PROTOCOL_VERSION`; removes `session/request_permission`; updates the
  exported schema.

**Why, item by item.**

- **Why an event instead of a daemon→client request.** A request is bound to the
  connection that received it: the requester is captured once at session
  creation (`connection.ts:179`, `hosted-session.ts:48`). After a reconnect
  nobody can answer it; today it is coerced to `cancelled` (`connection.ts:208`).
  An event is session state: it is replayed on attach and visible to every
  client.
- **Why `resolve_permission` is a command addressed to the session.** The answer
  must reach the session whatever socket it arrives on; a JSON-RPC response can
  only answer the request on the connection that issued it.
- **Why `permission_resolved` is fanned out.** With multi-attach both the phone
  and the TUI show the dialog. When one answers, the other must close it —
  otherwise the user answers twice, or believes they denied something the other
  device approved.
- **Why a fresh nonce per request.** Scenario: request R1 is pending, the turn is
  cancelled and restarted, and a new request for the same tool reuses the id. A
  late "approve" from the phone, meant for R1 — maybe a *different* command —
  approves R2. A nonce binds every approval to exactly what the user saw.
- **Why first-wins plus an explicit `PermissionNotPending`.** Two devices answer:
  the outcome must be deterministic, and the loser must learn its click did not
  count. A silent drop makes the losing UI lie ("you denied it" while the other
  device approved).
- **Why no timeout.** Owner decision (2026-10-19): a dead socket — a phone with
  a flat battery — must never turn into a denial. It is safe: while suspended,
  the tool does not run. And it is why the 5 min deadline (`ws-server.ts:38`)
  existed that makes it obsolete: a request bound to one connection could hang
  a turn nobody else could unblock; in v2 any attached client can answer or
  cancel, so a waiting turn is suspended, not hung. A synthetic deny is also
  harmful: the model continues blind and piles up further requests.
- **Why the suspension must survive a daemon restart.** A suspension can last
  hours on a host that restarts (an update, a reboot). In memory only, a reboot
  would silently erase the pending approval and the work before it — the exact
  loss the owner rejected.
- **Why coordinate with `history-validity-invariant`.** That eval treats a tool
  call with no result as broken history to repair. Here it is the *expected*
  state of a suspended turn; a repair on resume would delete the call and
  destroy the suspension.
- **Why the single-broker assumption is load-bearing.** Two decision points is
  the bug AGENTS §7 documents: a second broker's default `allowAll` auto-
  approves everything. `resolve_permission` must carry the client broker's
  decision, never create a second decider. Remembered grants staying
  daemon-side is existing behaviour, and it has a good consequence: "allow
  always" on one device holds on every device attached to the session.
- **Why fake `permission_resolved` events are display-only.** In pod modes the
  pod controls the daemon and can write any frame. A client that recorded a
  local approval because of such an event would let the pod mint approvals for
  its own input — forbidden by the pod-trust invariant.

Load-bearing assumption to prove first (restated, review F3): **the daemon
makes no *novel* decision.** Every new approval comes from the client's single
`PermissionBroker` (AGENTS §7) via `resolve_permission`; the daemon decides on
its own only for session-remembered grants already given by that broker
(`permission-gate.ts:70-77`, existing behaviour). There is no fail-safe deny
any more: the fail-safe is *not running* the tool while suspended.
Consequence to state in the design: with multi-attach, an "allow always" given
on one device holds for every device attached to that session.

Invariants to red-team: pod-trust — a pod-originated request must not create a
lasting approval for pod-supplied input ("allow always" stays session-scoped);
a hostile pod could emit fake `permission_resolved` events — the client treats
them as display-only (close a dialog), never as a decision.

Tests: request pending → drop → re-attach → the request is replayed and the
answer is accepted; two clients answer → first wins, second gets
`PermissionNotPending`; a request pending for hours (fake timers) is still
pending and approvable — never auto-denied; daemon restart mid-suspension →
the request is re-emitted and approving it runs the tool exactly once; a late answer after a restarted turn does not bind to the
new request; mutation: route the answer through a second broker → the existing
single-broker spy test fails.
