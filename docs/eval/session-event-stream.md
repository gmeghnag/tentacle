# eval/session-event-stream — the stream as single source of truth: consistent cut, turn events, compaction barrier, idempotent commands

> **Status:** eval (child of `docs/eval/session-reattach.md`, step 3)
> **Branch:** none until promoted (then `feat/session-event-stream`)
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (protocol + TUI-over-RPC session path, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** make the per-session update stream complete and
replayable, so a client that was away can reconstruct exactly what happened —
*before* any change lets a turn outlive its socket (parent, review F5).

Evidence (parent has the repro): the replay buffer is reset per turn and capped
by count (`daemon/src/hosted-session.ts:26,96`); `turn_end` is not streamed
(`daemon/src/mapping.ts:65,105`) — the stop reason is the `prompt` response
(`client/src/remote-client.ts:162`), lost on disconnect; history is committed
per round (`agent/src/agent.ts:256,331`) while streamed chunks get a seq before
that; `compact` replaces history out of band (`agent/src/session.ts:95-96`);
the daemon keeps only text content and drops other blocks silently
(`daemon/src/mapping.ts:14-19`).

## Implementation

*(empty — filled when promoted)*

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `protocol-schema-export`.** Scope (parent points
3–6, 14–16):
- Per-session ring bounded in **bytes**, never reset at turn boundaries; `seq`
  per-session monotonic. Exposes `replayFrom(since)` and the cut; the `open`
  method that serves them lands in `session-registry`.
- **Consistent cut**: the daemon tracks `committedSeq` = the seq at the last
  point where `messages` contains everything emitted so far (round end, turn
  end, compaction). `snapshot` returns `{messages, since: committedSeq}`.
  Replay `seq > since` then always carries the whole round in flight.
- `turn_start{turnId}`, `turn_end{turnId, stopReason, error?}`; `prompt{turnId}`
  acks at once; a failing turn ends with `turn_end{stopReason:"error", error}`.
- `history_replaced{reason}` emitted by `compact`; it advances the cut.
- Idempotency: `turnId → ack` map for the session's lifetime (not
  count-bounded, review F8); `enqueue` dedupes by `id` the same way.
- Event classes display/mandatory in the schema; clients ignore unknown display
  events.
- Wire hygiene: optional fields omitted, never `null` (except `exitCode`,
  JSON-RPC error `id`).
- Paged `snapshot{cursor?, limit?}` — newest first + cursor for older.
- A non-text content block is **rejected** with an explicit error instead of
  dropped (attachments come later, `docs/eval/attachments.md`).
- **Preserve the end-of-turn no-await window** (steering invariant, `packages/agent/src/agent.ts` (INVARIANT comment at the final steering drain, added by `fix/steering-over-rpc`)):
  from the final steering drain to the moment the turn is marked ended, the
  new turn driver must run synchronously — emitting `turn_end`, clearing the
  controller and recording the `turnId` ack happen in one synchronous segment.
  Update the `agent.ts` comment, which names `HostedSession.prompt` (that
  method changes shape here).
- **`enqueue` checks the idempotency key *before* `running`.** A key already
  seen returns the cached ack even if the turn has since ended; only an unseen
  key gets the `NoTurnRunning` check (`daemon/src/connection.ts`, steering
  branch).
- Bumps `PROTOCOL_VERSION`. Updates the exported schema (step 2).

**Why, item by item.**

- **Why a ring bounded in bytes, not in number of updates.** One update can be
  a 5-byte text chunk or a 500 KB tool result. A count bound bounds neither
  what we care about (memory) nor what we need (coverage): 1024 tiny chunks
  cover a fraction of one long answer, so the buffer overflows *mid-message*;
  1024 large tool results can be hundreds of MB. A byte bound limits memory
  directly, and the resync path handles anything older.
- **Why the ring is never reset at turn boundaries.** Today it is reset at
  every `prompt` (`hosted-session.ts:96`). Events between turns
  (`background_exit`) and the tail of the previous turn vanish as soon as the
  next turn starts: a phone away across two turns — one of them started from
  the laptop — loses the end of the first. Coverage must depend on size only,
  never on turn structure the client cannot see.
- **Why the cut is the last committed boundary, not the seq counter (F1).**
  Concretely: the model streams chunks with seq 41–45; the round is not yet
  committed (history is pushed only at round end, `agent.ts:256,331`). A
  snapshot with `since = 45` returns `messages` *without* those chunks, and
  replay `seq > 45` *excludes* them: the client shows the answer with its first
  part missing. With `since = 40` (last committed), replay 41..N re-sends the
  whole round and the client renders it complete.
- **Why `since` is opaque to clients.** Clients only echo it back. If they
  compared or computed with it, its meaning would be frozen in every client
  language; opaque, the daemon can change the cut granularity later (per round,
  per turn) without breaking anyone.
- **Why `turn_start` / `turn_end` in the stream and `prompt` acking at once.**
  The outcome of a turn must live where re-attach can find it. The response to
  a request dies with its connection — the repro shows exactly that (`prompt`
  rejected with `connection closed`, stop reason lost). `turn_start` lets a
  client that attaches mid-turn know a turn exists and which one (`turnId`).
  Keeping `prompt` long-lived *as well* would give two channels for one fact,
  and every client in every language would need code to reconcile them.
- **Why a failing turn ends with `turn_end{error}`.** Today a model error is a
  rejection of `prompt`. A client that was offline when it happened would see a
  turn that never ends: a spinner forever.
- **Why `history_replaced` as a barrier (F6).** `compact` replaces the history
  array wholesale (`session.ts:95-96`) out of band. A client on the replay path
  would apply post-compaction events on top of its *pre-compaction* history:
  the conversation it shows no longer matches the daemon's, and nothing tells
  it. The barrier event forces a resync from the new cut.
- **Why idempotency keys live for the session's lifetime (F8).** Scenario: the
  phone sends a prompt in a tunnel, the ack is lost, the phone sleeps three
  hours, twenty turns run from the laptop, then the phone retries. A
  count-bounded key set has evicted the key → the prompt runs **twice** (think
  "deploy to staging"). One entry per turn is a few bytes; bounded by the
  session's life, cleared on close. A retry of a finished turn returns the
  cached ack, so the client converges instead of re-running.
- **Why `enqueue` gets an id too.** Same ambiguous-ack case: a duplicated steer
  injects the same instruction twice into the model's context.
- **Why event classes (display vs mandatory).** Today an unknown discriminant
  fails the whole frame (AGENTS §7 caveat). After going public we want to add
  display events (a progress bar, a new usage field) without breaking app
  versions users have not updated. But a *mandatory* event cannot be
  ignorable: an ignored `permission_request` is a turn suspended forever with
  no dialog; an ignored `turn_end` is a spinner forever. So the class is
  explicit in the schema, and a client fails **loudly** on an unknown mandatory
  event ("update the app") rather than hanging silently.
- **Why optional fields are omitted, never `null`.** zod distinguishes the two;
  TypeScript consumers tolerate both. Swift `Codable` and Kotlin serialization
  do not, cleanly: allowing both forces every client to handle three states per
  field (absent, null, value). One rule removes a state everywhere. Exceptions
  where `null` carries meaning: `exitCode` (`null` = killed by a signal, no
  code) and the JSON-RPC error `id`.
- **Why a paged snapshot, newest first.** `snapshot` returns the full history.
  A long session with large tool outputs reaches megabytes, and every resync
  re-transfers it: on mobile that is data, battery, and seconds before
  anything renders. It may also approach the 8 MiB frame cap
  (`ws-server.ts:40`; not verified, see `oversize-frame-hang`). Newest first
  because the UI shows the end of a conversation first and loads older parts on
  scroll, like every chat app.
- **Why reject non-text blocks explicitly now.** Today they are dropped
  silently (`daemon/src/mapping.ts:14-19`): a user sends a photo, the model
  answers as if there were none, and the user believes it saw it. Silent and
  plausible is the worst kind of failure; an explicit error is honest until
  `docs/eval/attachments.md` ships.
- **Why bump `PROTOCOL_VERSION`.** These are breaking changes; a mixed pair must
  fail at `initialize` with `VersionMismatch`, not mid-turn with a decode error
  (AGENTS §7).
- **Why the no-await window must survive the rewrite.** `fix/steering-over-rpc`
  proved that a remote `session/enqueue` is either drained into the turn or
  rejected with `NoTurnRunning` *only because* nothing between the final drain
  and "turn ended" yields to a macrotask: a transport message (WebSocket, worker
  `postMessage`, pod exec stream) cannot interleave. This child rewrites exactly
  that stretch (`prompt` acks at once; a separate turn driver emits `turn_end`
  and clears the controller). One `await` there — an async idempotency store, an
  awaited sink, an end-of-turn hook — reopens the window: the enqueue is
  accepted, the turn ends without draining it, the text is lost silently, the
  same bug class steering just closed. The invariant has no test (it depends on
  microtask order, fragile), so the only protection is that the plan names it.
- **Why the idempotency check comes before the `running` check.** Scenario:
  the phone sends a steer, the daemon drains it into the turn, the ack is lost,
  the turn ends, the phone re-attaches and re-sends `enqueue{id}`. Checking
  `running` first answers `NoTurnRunning`; the client concludes the steer was
  rejected and re-sends it as a new prompt — the instruction runs **twice**.
  The key says "already done"; it must win. Test it with exactly this sequence.
- **Ring size:** not fixed here on purpose — a proposal to calibrate in
  Implementation against real sessions (bytes per turn on long tool-heavy
  turns).

Load-bearing assumption to prove first: the daemon can observe the "history
committed" boundary. The agent pushes into `Session.messages` inside
`runMessages` (`agent.ts:256,331`) without emitting a dedicated event; verify
whether an existing `AgentEvent` (e.g. the round's final assistant/tool event)
always follows the push in the same tick. If not, the agent must emit a
`committed` marker — that touches the agent loop (load-bearing in itself).

Failure modes: ring overflow mid-round (→ resync from the cut; client discards
its partial round); `prompt` retried with an already-terminal `turnId` (return
the cached ack, never re-run); `compact` while a turn runs (coordinate with
`docs/eval/daemon-compact-turn-guard.md` — the barrier assumes compaction is
serialized with turns); paged snapshot racing new events (the cursor pins the
cut; later events come via replay).

Tests (steering): enqueue accepted → ack dropped → turn ends → same
`enqueue{id}` re-sent → cached ack, never `NoTurnRunning`, the model saw the
text once. The no-await window stays untested (microtask order); Review must
check it by reading the new turn driver.

Tests (daemon boundary, scripted client): the parent's revised property —
every drop point *k*, both re-attach and fresh/forced-resync mid-round, ordered
reducer output + seq contiguity. Mutations that must fail it: `since` = raw
counter; ring reset at turn start; no `history_replaced`; duplicate `turnId`
re-runs.
