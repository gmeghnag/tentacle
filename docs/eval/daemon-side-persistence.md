# eval/daemon-side-persistence — `serve` persists session history on its own host

> **Status:** eval (child of `docs/eval/session-reattach.md`, step 6)
> **Branch:** none until promoted (then `feat/daemon-side-persistence`)
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (persistence + pod-trust invariants, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** with sessions that outlive their connection and
turns that stay suspended on a permission for hours
(`docs/eval/session-reattach.md` points 8 and 10), should a `tentacle serve`
daemon persist session history on its own host? **Answer from the owner's
scenario: yes, for `serve`** — promoted from an open question to a v2 child.

Scenario that decides it (2026-10-19): the phone dies while a permission is
pending; hours later it reconnects. With client-only persistence (AGENTS §7
today), everything the agent did after the phone's last snapshot exists only in
daemon memory: a daemon restart in that window loses it, and the suspended turn
cannot be rebuilt. The owner's requirement is that the turn waits, intact,
until they return.

Why the current rule exists, and why it still holds for pods: in pod `run` /
`attach` the daemon is not trusted and its filesystem is ephemeral, so the
laptop must own the record. A `serve` on the user's own machine is a
different trust situation.

## Implementation

*(empty — filled when promoted)*

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `session-registry`, before `permission-events`.**
Scope:
- `serve` only: the daemon writes each session's history (and the pending
  permission record, if any) to a store on its host after every committed
  boundary (round end, turn end, compaction — the same cut as
  `session-event-stream`). On startup it reloads sessions as detached.
- **Never `await` the store inside the end-of-turn window.** Steering
  invariant (`agent.ts`, `fix/steering-over-rpc`): no `await` between the final
  steering drain and the turn being marked ended. The turn-end write starts
  *after* the turn is marked ended, or is queued without being awaited in that
  stretch. (The steering task doc says no end-of-turn hook is planned; this
  child is that hook.)
- **Persist the pending steering queue** together with the pending permission
  record, and re-queue it on restart.
- Pod modes unchanged: the laptop persists from `snapshot`; the pod daemon
  stores nothing durable.
- The client still persists its own copy (offline viewing, `--resume` against a
  daemon that lost the session); on re-attach the daemon's copy wins.
- Reuse the session-store code and its durability fixes rather than a second
  store (`docs/eval/session-store-durability.md`: atomic write, schema check).
- AGENTS §7 "persistence lives on the laptop" must be amended to say *where the
  daemon is trusted (`serve`), it also persists* — a rule change, so it rides
  this task's branch with Review (§10).

**Why, item by item.**

- **Why `serve` only, and not pods.** In pod modes the daemon is not trusted
  (AGENTS §7): a record it writes is pod-supplied data. If we reloaded it as
  history we would let whoever controls the pod fabricate a conversation —
  e.g. inject instructions the model then follows on resume. Pods are also
  ephemeral (`run` deletes its pod on exit), so a store there protects nothing.
  On `serve` the host is the user's own machine.
- **Why write at committed boundaries (the stream's cut).** A restored session
  must correspond exactly to some `since` token, so a client re-attaching after
  a restart gets a consistent snapshot + replay. Writing mid-round would store
  half a message the agent cannot resume from.
- **Why reload sessions as detached.** After a restart nobody is attached; the
  idle TTL starts and suspended turns re-emit their `permission_request`, so
  the first client to re-attach sees the pending approval.
- **Why the client still keeps its own copy.** Offline viewing (phone in
  airplane mode), and recovery when the daemon lost the session (pods, disk
  loss) via `open{messages}`.
- **Why the daemon's copy wins on re-attach.** The daemon executed the turns;
  the client's copy can be behind, never ahead — a client never authors history
  except prompts, which go through the daemon anyway.
- **Why reuse the session-store code.** One durability implementation.
  `session-store-durability` found in-place writes that truncate on crash; a
  second store would re-introduce exactly those bugs.
- **Why amend AGENTS §7 in this task.** Otherwise the next model reads
  "persistence lives on the laptop", sees a daemon store, and removes it as an
  invariant violation.
- **Why the store must not be awaited at turn end.** This child is precisely
  the "async persist at end of turn" the steering invariant forbids. With an
  `await store.save()` between the final drain and "turn ended", a
  `session/enqueue` arriving during the write is accepted (the turn is still
  running), never drained (the drain already happened), and lost when the turn
  ends — silently. Writing after the turn is marked ended costs nothing: the
  data is the same, and a crash in between loses at most what a crash during
  the write would.
- **Why persist the steering queue.** A turn suspended on a permission is
  running, so `enqueue` is accepted and queued for the round after approval.
  The queue lives in memory: a restart during an hours-long suspension would
  drop those messages silently — the bug class steering closed.
- **Why "resume from a pending tool call" is the load-bearing assumption.** If
  the loop cannot resume from "assistant tool call awaiting approval" without
  re-running the model round, a restart re-asks the model: a different tool
  call comes back, and the approval the user is looking at no longer matches
  what would run — plus the cost of the extra round.

Load-bearing assumption to prove first: the persisted history plus the pending
permission record is enough to rebuild a suspended turn — i.e. the agent loop
can resume from "assistant tool call awaiting approval" without replaying the
model round. Verify against `agent/src/agent.ts` (where tool authorization sits
relative to the assistant-message push).

Failure modes: crash mid-write (atomic rename); disk full (surface, keep serving
from memory); two daemons on one store (lock or refuse); a store from an older
protocol version (version the file; refuse or migrate explicitly).

Tests: restart mid-suspension → session reloads, `permission_request`
re-emitted, approving runs the tool once; restart after `turn_end` → history
intact; a pod-mode daemon writes nothing.
