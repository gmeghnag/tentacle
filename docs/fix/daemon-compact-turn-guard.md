# fix/daemon-compact-turn-guard — `session/compact` is not mutually exclusive with a running turn on the daemon

> **Status:** review — APPROVE-WITH-NITS, nits addressed (promoted from `eval/` 2026-10-20)
> **Branch:** `fix/daemon-compact-turn-guard`
> **Type:** fix · **Size:** S · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review red-teaming "Don't serialize the RPC peer" (§7)

## Context

*— claude-opus-5-5, 2026-10-17*

**Question being decided:** is the claim "`session/compact` is not guarded against
a running turn on the daemon" real, which clients can actually trigger it, and
should it be promoted to a `fix/` task?

**Evidence (source).**
- `packages/daemon/src/hosted-session.ts:92-95` — `prompt()` rejects with
  `TurnInProgress` when `this.controller` is set. `compact()` (`:118-122`) has no
  such check, sets no busy state, and passes no `AbortSignal`.
- `packages/daemon/src/connection.ts:126-132` — `session/compact` goes straight to
  `hosted.compact()`; `onNotification` (`:191-196`) routes `session/cancel` only to
  `hosted.cancel()`, which aborts `this.controller` (`hosted-session.ts:130-132`)
  — `null` during a compact, so cancel is a no-op for it.
- `packages/transport/src/peer.ts:184` — `void this.handleRequest(...)`: inbound
  requests are dispatched concurrently by design (AGENTS §7).
- `packages/agent/src/session.ts:66-70` — a turn passes the session's own
  `this.messages` array into `Agent.runMessages`, which `push`es assistant/tool
  messages into it (`packages/agent/src/agent.ts:165-260`).
- `packages/agent/src/session.ts:91-99` — `compact` snapshots `before`, awaits
  `summarize` (a full model round-trip), then `this.messages.length = 0;
  push(...compactedHistory(...))` on that same array.
- Sessions are per-connection (`connection.ts:53`), so a *second* client cannot
  reach another client's session; the trigger is one client issuing overlapping
  requests.

**Repro** (`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/repro.ts`,
the real `Connection` + `SessionHost` + `Agent` over `createChannelPair`, same
pattern as `packages/daemon/test/integration.test.ts`; a scripted model whose
summarize call and tool `exec` are gated by promises). Actual output:

```
A compact mid-turn -> {"ok":{"before":2,"after":1}}
A prompt -> {"stopReason":"end_turn"}
A final history:
  [0] user "Summary of the earlier conversation (com"
  [1] tool toolCallId=c0 "exit=0\nok"
  [2] assistant "done1"
A orphan tool messages: [ "c0" ]
B prompt during compact -> {"ok":{"stopReason":"end_turn"}}
B history after 2nd turn, before compact resolves: 8 msgs
B compact settled after cancel notification?  false
B compact -> {"before":4,"after":1}
B final history:
  [0] user "Summary of the earlier conversation (com"
```

- **A (compact during a turn):** compact is accepted, wipes the in-flight turn's
  user prompt and the assistant message carrying `tool_calls: [c0]`; the turn
  then appends `tool(c0)` after the summary. Final history has an **orphan tool
  message** — invalid for OpenAI-compatible APIs.
- **B (prompt during a compact):** the prompt is **not** rejected (controller is
  `null`), runs a whole turn (4 → 8 messages), then the compact resolves and
  replaces everything with a summary of the *stale 4-message* view: the second
  turn is **silently lost**. `session/cancel` during the compact had no effect.

**Veracity: CONFIRMED** (both directions, plus non-cancellable compact).
Unverified in one line: that the next model call on history A returns a provider
400 — inferred from the OpenAI tool-message contract, not executed against a
real endpoint. Persisting the corrupted history is also inferred: the main thread
persists `snapshot` after each turn (AGENTS §7), so a `--resume` would inherit it.

**Trigger / who can hit it.**
- **TUI, direction B — reachable today.** `/compact` is guarded only against
  `running` (`packages/tui/src/App.tsx:415`) and then fires `void
  session.compact()` (`:420`) without marking the session busy, so typing a
  prompt while "Compacting the conversation…" is shown sends `session/prompt`
  mid-compact. Summarising is a full LLM call (seconds), so the window is wide.
  (Static reading of `App.tsx`; not re-verified with an ink frame capture.)
- **TUI, direction A** — guarded client-side (TODO.md Block 6 FIXED item covers
  `/retry` and `/clear`; `/compact` has its own `running` check).
- **Any other protocol client** (`tentacle connect` targets a daemon over ws; a
  custom/script client, a future second frontend) — both directions are
  reachable; the daemon is the only place that can enforce it.

**Severity: 🟡 medium-high.** Silent conversation loss (B) and a poisoned
history that can 400 every subsequent turn and get persisted (A). Reachable from
the shipped TUI by an ordinary user action (B).

## Implementation

*— claude-opus-5-5, 2026-10-20*

**Re-verified on current `main` (`6578e61`) before planning** — the code moved
since the eval (3b: `prompt` acks at once, idempotent by `turnId`), so the
eval's line numbers are stale; the bug is not. Repro re-run, same verdict:

```
A compact mid-turn -> {"ok":{"before":2,"after":1}}
A final history:
  [0] user "Summary of the earlier convers"
  [1] tool toolCallId=c0 "exit=0\nok"
  [2] assistant "done:exit=0\nok"
A orphan tool messages: [ "c0" ]
B prompt during compact -> {"ok":{"turnId":"b1"}}
B history mid-compact: 4 msgs
B compact settled after session/cancel? false
B compact -> {"ok":{"before":2,"after":1}}
B final history:
  [0] user "Summary of the earlier convers"
```

(`.tentacle/tmp/daemon-compact-turn-guard/repro.ts`: real `Connection` +
`SessionHost` + `Agent` over `createChannelPair`; the summarize call — the
tool-free request — and the tool `exec` are gated by separate promises. A:
compact while the turn is parked in `exec(c0)`. B: prompt `b1` while the
summarize is parked, then `session/cancel`, then release.)

### Load-bearing assumption

**The busy check and the busy set run in one synchronous stretch, in BOTH
`prompt` and `compact`.** Then two requests dispatched concurrently by the peer
(`packages/transport/src/peer.ts:310`, `void this.handleRequest`) cannot both
pass the check, whatever their interleaving, with no lock and no serialisation.
- `prompt` already is: `hosted-session.ts:144-169` has no `await` (documented
  at `:139-141`); the check is `:152`, the set `:156`.
- `Connection` reaches both synchronously: `connection.ts:212-218` (`prompt`,
  plain function) and `:166-172` (`compact` returns `hosted.compact()` without
  awaiting first). `HostedSession.compact` is `async`, but an async function
  runs synchronously up to its first `await` — so the check + set go before
  `await this.session.compact(...)`.

### Preconditions

- One busy slot already exists: `controller` (`hosted-session.ts:67`), cleared
  only by `finishTurn` when it owns the slot (`:238-241`). `cancel()` aborts it
  (`:278-280`); `Connection.close()` cancels every session (`connection.ts:85-88`).
- `enqueue` already refuses unless `activeTurnId === turnId` (`:259`), and
  `activeTurnId` is set only by `prompt` (`:157`) → stays `null` during a
  compaction → `NoTurnRunning` there with no change.
- `Session.compact(signal)` accepts a signal (`agent/src/session.ts:91`) and
  forwards it to `summarize` → the model request (`agent.ts:145-146`,
  `compact.ts:60`); the history is replaced only AFTER the `await`
  (`session.ts:93-96`) — so a compaction that fails before that point leaves it
  untouched (already pinned for the empty summary, `compact.test.ts:80`).
- `running` (`hosted-session.ts:114`) has no production caller (only daemon
  tests, `integration.test.ts:537,1003,1059`; the TUI `running` hits are its
  own state) — widening it to "a turn or a compaction" is free.
- Domain codes are an additive wire table (`protocol/src/jsonrpc.ts:29-38`),
  exported to `schema/protocol.json` (`json-schema.ts:51`; staleness test
  `protocol/test/json-schema.test.ts:39`).

### Design

Mutual exclusion is **per-session state in `HostedSession`, reject — never
queue, never lock** (§7 "Don't serialize the RPC peer").

1. **One slot, two kinds.** `controller` becomes "the active operation's
   controller" (a turn OR a compaction); a `compacting` flag says which. A
   private `assertIdle()` throws `TurnInProgress` ("a turn is already running")
   or the new `CompactInProgress` ("a compaction is running"). `prompt` calls it
   where it checks today (after the idempotency key and `assertTextOnly`, so a
   rejected prompt still records nothing); `compact` calls it first.
2. **`compact`**: `assertIdle()` → new `AbortController` in the slot,
   `compacting = true` — all before the first `await` → `await
   session.compact(signal)` → `finally` frees the slot. Nothing else can have
   taken the slot meanwhile (every taker goes through `assertIdle`), so the
   unconditional clear is safe; `finishTurn` never touches it (its
   `activeTurnId === turnId` guard is false during a compaction).
3. **Cancellable.** `cancel()` is unchanged — it aborts whatever is in the slot,
   so `session/cancel` and `Connection.close()` now stop a summarise. A
   compaction that rejects after its signal aborted is reported as the new
   `Cancelled` domain code ("compaction cancelled"): providers throw anything on
   abort (an `AbortError`, the proxy's "model stream cancelled"), and the
   remote peer would redact it to "internal error".
4. **Abort wins over a late summary (agent layer).** `Session.compact` calls
   `signal?.throwIfAborted()` after the `await`, before replacing: a provider
   that ignores the signal (or a summary that lands just after the cancel) must
   not overwrite the history of a compaction the client was told is cancelled.
   The replace is synchronous after that check, so the outcome is binary:
   compacted, or untouched + `Cancelled`.
5. **Wire.** Two additive codes: `CompactInProgress: -32009`, `Cancelled:
   -32010` (generic name: any future cancellable request reuses it). Additive →
   `PROTOCOL_VERSION` stays (§7: an old peer sees an error with an unknown code
   — still an error, still catchable; no new method or update discriminant).
   Re-export `schema/protocol.json`.
6. **Clients: no change needed.** A prompt rejected mid-compaction already
   fails its turn with the `RpcError` (`client/src/remote-session.ts:139-146`),
   so the TUI shows "a compaction is running" instead of silently losing the
   turn; a rejected `/compact` shows "Compact failed: …" (`App.tsx:420-423`).
   The TUI busy-state UX is a follow-up (Notes), not the fix.

### Files

1. `packages/protocol/src/jsonrpc.ts` — `CompactInProgress`, `Cancelled`.
   `packages/protocol/schema/protocol.json` — regenerated (`bun run schema:export`).
2. `packages/agent/src/session.ts` — `throwIfAborted()` in `compact`.
3. `packages/daemon/src/hosted-session.ts` — `compacting`, `assertIdle`,
   guarded/cancellable `compact`, doc comments (`running`, `controller`, class
   header).
4. Tests: `packages/daemon/test/integration.test.ts`,
   `packages/agent/test/compact.test.ts`.

### Failure modes

| Case | Converges to |
|---|---|
| compact while a turn runs | rejected `TurnInProgress` at once; the turn and its history untouched; no summarize call |
| prompt while compacting | rejected `CompactInProgress`, `turnId` not recorded (a retry after the compaction starts the turn) |
| compact while compacting | rejected `CompactInProgress`; the first one completes normally |
| `session/cancel` while compacting | summarize aborted → compact rejects `Cancelled`; history untouched, nothing persisted; slot freed (next prompt runs) |
| provider ignores the abort, summary arrives later | `throwIfAborted` → same as above (no late overwrite) |
| cancel lands after the replace | compact resolves normally (the replace + return are synchronous; cancel finds the slot already empty or aborts nothing) |
| compaction throws (empty summary, model down) | error propagates as today; `finally` frees the slot |
| connection closes mid-compaction | `close()` → `cancel()` → aborted; nothing persists into a dead session |
| `enqueue` while compacting | `NoTurnRunning` (no turn) — unchanged path |
| `snapshot` while compacting | answered at once with the pre-compaction history (no serialisation) |
| retried `turnId` while compacting | cached ack / `ended`, as today (the key is checked before `assertIdle`) |
| version skew (old client, new daemon) | old client gets an error with an unknown code — surfaced as an error; no silent drop |

### Tests

Red first on current code, then green (§9). In `integration.test.ts`, a new
`describe("compaction is exclusive with a turn", …)` with a test-local provider
that gates the summarize request (the tool-free one) separately from turn
calls, and IGNORES the abort signal (the stronger case for cancel):
1. compact during a turn → `TurnInProgress`; after the turn ends the history is
   the full turn (user, assistant+toolCalls, tool, assistant), no orphan, and
   the model got no summarize request.
2. prompt during a compaction → `CompactInProgress`; compaction result counts
   the pre-compaction history; the same `turnId` afterwards starts a turn that
   runs on the compacted history.
3. compact during a compaction → `CompactInProgress`.
4. `session/cancel` during a compaction → rejects with `Cancelled`; history
   byte-identical to before; a prompt afterwards is accepted (slot freed).
5. a compaction that throws (empty summary) frees the slot (prompt accepted).
6. non-serialisation: while a compaction is parked, `session/snapshot` and
   `session/enqueue` (→ `NoTurnRunning`) answer before it is released.
In `compact.test.ts`: `Session.compact` with an aborted-after-summarize signal
rejects and leaves the history untouched and unpersisted (the agent-layer
property in isolation). Non-vacuity of 4 by mutation: drop `throwIfAborted` →
test 4 must fail (history replaced).

## Execution

*— claude-opus-5-5, 2026-10-20*

In plan order:

1. `protocol/src/jsonrpc.ts:37-38` — `CompactInProgress: -32009`, `Cancelled:
   -32010`; `bun run schema:export` (+2 lines in `schema/protocol.json`).
   `PROTOCOL_VERSION` unchanged (additive).
2. Tests written first (7) and run **red on the unchanged daemon/agent
   code**: 5 fail / 2 pass — the two passing are the regression guards (failed
   compaction frees the slot; peer not serialised), which by construction hold
   on the old code (it has no slot). Excerpt:
   ```
   (fail) Session.compact cancellation > a signal aborted while summarizing wins over the late summary: history untouched
   (fail) … > compact during a turn is rejected TurnInProgress; the turn's history stays whole [1010ms]
   (fail) … > prompt during a compaction is rejected CompactInProgress and not recorded
   (fail) … > compact during a compaction is rejected CompactInProgress; the first completes [1004ms]
   (fail) … > session/cancel stops a compaction: Cancelled, history untouched, session free
    2 pass / 5 fail
   ```
3. `agent/src/session.ts:96` — `signal?.throwIfAborted()` after the summarize.
4. `daemon/src/hosted-session.ts` — `compacting` flag next to `controller`
   (now documented as the busy slot), `assertIdle()` (used by `prompt` in place
   of its inline check, and first in `compact`), `compact` takes the slot
   before its first `await`, maps an aborted failure to `Cancelled`, frees the
   slot in `finally`. `running`/`cancel` docs widened; class header states the
   exclusion rule.
5. Green: 7/7. **Mutations** (each reverted), all caught:
   | mutation | fails |
   |---|---|
   | M1 drop `throwIfAborted` | agent abort test, daemon cancel test |
   | M2 drop the `finally` clear | prompt-during-compaction, cancel, failed-compaction |
   | M3 `compact` skips `assertIdle` | compact-during-turn, compact-during-compaction |
   | M4 never set `compacting` | prompt-during-compaction, compact-during-compaction (wrong code) |
   | M5 no `Cancelled` mapping | cancel test |
6. Repro re-run on the fix:
   ```
   A compact mid-turn -> {"err":-32004}
   A final history:
     [0] user "go"
     [1] assistant toolCalls=c0 ""
     [2] tool toolCallId=c0 "exit=0\nok"
     [3] assistant "done:exit=0\nok"
   A orphan tool messages: []
   B prompt during compact -> {"err":-32009}
   B history mid-compact: 2 msgs
   B compact settled after session/cancel? true
   B compact -> {"err":-32010}
   B final history:
     [0] user "hello"
     [1] assistant "done:hello"
   ```
7. Gate: `bun run check` → typecheck clean, `biome` 267 files clean, **863
   pass / 1 skip (the opt-in live-k8s `skipIf`) / 0 fail**.

**Drift from Implementation.**
- **Test helper `rejection(p, ms)` instead of `expect(p).rejects`.** The first
  red run hung the suite at ~100% CPU: on bun 1.4.3 `expect(p).rejects` on a
  promise that never settles spins past `--timeout` — and "the request stays
  parked" is precisely the old-code behaviour. Reproduced in isolation and
  registered in `docs/library-bugs.md`; the helper races the promise against a
  timer so a regression fails in 1 s instead of hanging CI.
- Test 6 (non-serialisation) has no mutation that kills it short of adding a
  lock, which is the thing it guards against; it pins the boundary contract.

**Round 2 — fixes for the Fix review's findings** (*— claude-opus-5-5, 2026-10-20*):
- **F1 (must):** two same-tick tests, both orders — "compact then prompt in the
  same tick: the compaction wins, the prompt is rejected" and "prompt then
  compact in the same tick: the turn wins". The reviewer's mutation (`await
  null` between `assertIdle()` and taking the slot) is now **caught** by the
  first one (9 pass / 1 fail). (An `await` *before* `assertIdle` still
  survives — harmless, exclusion holds; only who gets in changes.)
- **F2 (fixed, not deferred):** `Connection` forwarded no per-request signal,
  so a client that cancelled its `session/compact` with `$/cancelRequest` was
  told "cancelled" while the daemon later replaced the history — the exact
  state Design §4 rules out. Now `connection.ts` passes `context.signal` into
  `hosted.compact(signal)`, which links it to the slot's controller (already
  aborted → abort at once; listener removed in `finally`). Test
  "`$/cancelRequest` on session/compact stops it daemon-side" — red under the
  mutation "drop the signal" (9 pass / 1 fail).
- **F4:** stale `peer.ts:184` → `:310` in the Implementation (the Context keeps
  its 2026-10-17 citation as written).
- **F5:** test "a retried turnId while compacting gets its cached outcome"
  added. Connection-close mid-compaction stays untested here (it is `cancel()`,
  covered by the `session/cancel` test; the reviewer's attack script confirmed
  it converges). Cancel-after-replace: the replace and the return are
  synchronous, so no window to test.
- **F3, F6:** not changed — see Notes.
- Gate (`bun run check`): typecheck clean, biome 267 files clean, **867 pass / 1 skip (opt-in live-k8s) / 0 fail** (868 tests, 96 files).

**Round 3 — Round-2 nits** (*— claude-opus-5-5, 2026-10-20*):
- **R2-1 (fixed):** a `compact(signal)` whose signal is already aborted now
  rejects `Cancelled` right after `assertIdle()` — no slot taken, no summarize
  call (replaces the "abort the fresh controller" branch). Unit test "a compact
  whose signal is already aborted is Cancelled before any model call" on
  `HostedSession` directly (over the wire the peer always hands a fresh signal,
  `peer.ts:337-342`); red when the pre-check is dropped (10 pass / 1 fail).
- **R2-2 (left):** the `removeEventListener` in `finally` stays untested — a
  late abort would only hit a dead per-compaction controller; hygiene, not
  behaviour.
- **R2-3 (noted below).**
- Gate (`bun run check`): typecheck clean, biome 267 files clean, **868 pass /
  1 skip (opt-in live-k8s) / 0 fail** (869 tests, 96 files). No further review
  round, by the owner's decision (2026-10-20).

### Notes / debt (follow-ups, deliberately left)

- **TUI busy state for `/compact`** (`App.tsx:409-424`): the TUI does not show
  a compaction as busy, nor lets Esc cancel it (`compact?(signal?)` is already
  declared at `App.tsx:48`). After this fix a prompt typed meanwhile fails
  loudly ("a compaction is running") instead of being lost. UX follow-up.
- **`session/cancel` is session-wide** (F3, `protocol/src/session.ts:148`): a
  cancel meant for a turn can abort a compaction that reached the daemon just
  before it. Unreachable from the TUI (in-order frames; it cancels only while
  its turn runs). A turn-/op-scoped cancel belongs with the event-stream work
  (3c).
- **Slot held until a signal-ignoring provider returns** (R2-3): after
  `$/cancelRequest` the client has already rejected locally, but a prompt sent
  at once gets `CompactInProgress` until the summarize call returns. Loud and
  self-healing; the TUI busy-state follow-up must account for it.
- **`session/compact` has no idempotency key**: a retried compact compacts
  twice (each one valid). Fold into 3c's compaction barrier.
- **`jsonrpc.ts:25` comment** (F6, pre-existing on `main`): domain codes are
  in JSON-RPC's *server-error* range (-32000…-32099), not "outside the
  reserved range". Typo-class doc fix, separate.

## Review

### Fix review

*— claude-opus-5-5, 2026-10-20* (a fresh context, but the **same model** as the
executor: our blind spots overlap, so a different-model pass is still advisable
for a load-bearing task, AGENTS §10)

**Verdict: REQUEST-CHANGES.** The fix is correct: I found no wrong behaviour, and
the gate is green. One change is needed before merge: the **load-bearing
assumption has no test**. A mutation that breaks it survives the whole suite
(finding 1). The other findings are low or nits.

**Findings**
1. **(must fix: the test is missing)** `packages/daemon/test/integration.test.ts:1070-1281`.
   No test sends `compact` and `prompt` in the same tick. Every test waits with
   `until(...)` between the two requests. Mutation: add `await null;` between
   `this.assertIdle()` and `this.controller = controller` in `compact`
   (`hosted-session.ts:292-294`). This breaks exactly the property the plan stands
   on ("check and set in one synchronous stretch"). Result: **daemon + client +
   cli: 209 pass / 0 fail**, so the mutation is not caught. In the end-to-end
   attack (below), the same mutation admits BOTH requests: compact →
   `{"before":3,"after":1}` and prompt `t1` → acked. That is the original bug.
   Add a test that sends both requests without awaiting, in both orders, and
   checks that exactly one is admitted. It must fail on this mutation.
2. **(low; already on `main`; follow-up)** `packages/daemon/src/connection.ts:69`.
   `onRequest: (method, params) => …` drops the peer's `RequestContext.signal`.
   Effect: a `$/cancelRequest` sent for `session/compact` rejects on the client
   ("request N was cancelled"), but the daemon keeps the busy slot (the next
   prompt gets `CompactInProgress`) and later replaces the history. That is the
   "told cancelled, but compacted" state that Design §4 rules out. Only
   `session/cancel` is guarded. Shipped clients cannot reach this today:
   `remote-client.ts:204` passes no signal. But `App.tsx:48` already declares
   `compact?(signal?)`. Either wire the context signal to `hosted.cancel()` for
   compact, or record this as debt in Notes.
3. **(nit)** `session/cancel` applies to the whole session: `CancelParams` has
   only `sessionId` (`protocol/src/session.ts:148`). A cancel the client sent
   for a turn can abort a compaction that the daemon received just before it.
   The TUI is safe because frames are FIFO and the TUI sends cancel only while
   it is `running`. Noted only.
4. **(nit, doc)** A premise cites `peer.ts:184` as `void this.handleRequest`,
   both in Context and in Implementation's load-bearing assumption. That line
   is stale: the dispatch is at `packages/transport/src/peer.ts:310`. The claim
   itself is true.
5. **(nit)** Three Failure-mode rows have no test: "retried `turnId` while
   compacting", "connection closes mid-compaction", and "cancel lands after the
   replace". My end-to-end script confirms the close case: history untouched,
   slot freed, and the client gets `-32603` (connection closed). Optional.
6. **(nit; already on `main`)** The comment at `protocol/src/jsonrpc.ts:25`
   says domain codes are "outside JSON-RPC's reserved range". In fact -32000 to
   -32099 is the spec's implementation-defined server-error range. This diff
   did not introduce it.

**Gate** (`bun run check`, run by me): typecheck clean, biome `Checked 267 files`
clean, **863 pass / 1 skip (the opt-in live-k8s skip) / 0 fail**, 864 tests
across 96 files. This matches Execution.

**Premise table**
| Premise | Verdict |
|---|---|
| Context symptom: repro on `main` (src restored from `HEAD` temporarily) | TRUE: A orphan `c0`; B prompt acked mid-compact, cancel no-op, turn lost |
| repro on the fix | TRUE: A `-32004`, history whole; B `-32009`, cancel → `-32010`, history untouched |
| `peer.ts:184` `void this.handleRequest` | FALSE (stale line); the claim is true at `:310` |
| `connection.ts:166-172` compact goes to `hosted.compact()` with no `await` first; `:212-218` prompt is plain | TRUE |
| `HEAD hosted-session.ts:67` controller, `:139-141` doc, `:152`/`:156-157` check and set, `:238-241` finishTurn guard, `:259` enqueue guard, `:278-280` cancel | TRUE |
| `connection.ts:85-88` close() cancels every session | TRUE |
| `HEAD session.ts:91-96` compact(signal), replaced only after the await | TRUE |
| `agent.ts:145-146` and `compact.ts:60` forward the signal | TRUE |
| `compact.test.ts:80` empty-summary pin | TRUE |
| `running` has no production caller (`integration.test.ts:538,1004,1060` only) | TRUE |
| `json-schema.ts:51` exports error codes; drift test `json-schema.test.ts:39` | TRUE |

**Mutations** (each reverted; `git diff | shasum` = `959523dd…` at start and end)
| Mutation | Result |
|---|---|
| M1 remove `signal?.throwIfAborted()` | caught: agent cancellation test + daemon cancel test fail |
| M2 empty the `finally` in `compact` | caught: 3 fail (prompt-during, cancel, failed-compaction) |
| `await null` BEFORE `assertIdle` in `compact` | survives (6/6). Harmless: exclusion holds, only the admission order changes |
| `await null` BETWEEN `assertIdle` and the slot set | **survives** (209/209 daemon+client+cli). The bug comes back end to end → finding 1 |

**Attacks tried** (`.tentacle/tmp/daemon-compact-turn-guard-review/attacks.ts`,
with the real `Connection`, `SessionHost`, `Agent` and `createChannelPair`)
- *Same-tick race, both orders* (the §7 "don't serialize" angle). Fix:
  compact-first → compact ok + prompt `-32009`; prompt-first → prompt ok +
  compact `-32004`. On `main` both are admitted (compact `before:3`). Holds on
  the fix; no test covers it (1).
- *Peer not serialised.* No lock and no `await` were added on the request path.
  `handleRequest` calls the handler synchronously after a sync `safeParse`.
  Snapshot and enqueue still answer while a compaction waits (test 6, passes).
  Holds.
- *Steering invariant* (no `await` from the last drain to `finishTurn`). `drive`
  and `finishTurn` are unchanged. `finishTurn` clears the slot only when
  `activeTurnId === turnId`, and that value is `null` during a compaction, so a
  turn's end can never free a compaction's slot. After `turn_end`, the
  generator only unwinds: microtasks, then a sync `persist` in `Session.send`'s
  `finally`. No compaction can be admitted before that. The pin test "no
  macrotask fits…" passes. Holds.
- *Idempotency of prompt and enqueue.* The `turnId` key is checked before
  `assertIdle`, so a retry during a compaction gets the cached ack. A rejected
  prompt is not recorded: the same `turnId` later starts a turn (test 2).
  `enqueue` during a compaction → `NoTurnRunning`. Holds.
- *Connection closes mid-compaction.* Daemon history stays at 2 messages and
  `running` is false. On `main`, the history was replaced. Holds.
- *`$/cancelRequest` of compact.* The client is told "cancelled", but the
  daemon compacts anyway → finding 2. This was already the case on `main`.
- *Persisted history when a prompt is rejected mid-compaction*
  (`local-runtime.ts` flush). The flushes ask for `snapshot`, which the daemon
  answers in FIFO order, so the compacted history is persisted last. Holds
  (from reading the code; not executed).

**What holds.** The design (one busy slot, reject instead of queueing, a
`finally` that frees the slot, abort wins in the agent layer) is minimal and
correct. Both error codes are additive and schema-exported. Keeping
`PROTOCOL_VERSION` is justified (no new method or update discriminant). The
clients surface the new errors with no code change.

**How the executor behaved.** Disciplined. Execution matches Implementation
except for one disclosed drift. Tests went red first, and the red run is
recorded. The executor isolated and registered a real bun runner bug
(`docs/library-bugs.md`) instead of working around it silently. The five
mutations it reports reproduce. The gap: its mutation set did not attack the
assumption the plan itself named as load-bearing (finding 1).

#### Round 2

*— claude-opus-5-5, 2026-10-20* (same model as the executor, fresh context:
the same caveat as above applies)

**Verdict: APPROVE-WITH-NITS.** F1 and F2 are fixed, and each new test is
shown to fail under the mutation it targets. F4 and F5 are done. F3 and F6
are recorded in Notes / debt with a reason. Nothing in round 2 blocks the
merge.

**Gate** (`bun run check`, run by me): typecheck clean, biome 267 files clean,
**867 pass / 1 skip (opt-in live-k8s) / 0 fail**, 868 tests across 96 files.
This matches Execution's Round 2.

**Mutations** (each reverted; `git diff | shasum` = `92b1779d…` before and after)
| Mutation | Result |
|---|---|
| `await null` between `assertIdle()` and taking the slot | **caught**: "compact then prompt in the same tick" fails |
| `connection.ts` drops `signal` (`hosted.compact()`) | **caught**: "`$/cancelRequest` on session/compact" fails |
| drop `signal?.addEventListener(...)` | **caught**: same test fails |
| drop the `if (signal?.aborted) controller.abort()` branch | survives (nit R2-1) |
| drop `signal?.removeEventListener(...)` in `finally` | survives (nit R2-2) |

**Attacks on the signal linking**
(`.tentacle/tmp/daemon-compact-turn-guard-review/r2.ts`: real `Connection` and
`SessionHost`, with a summarize step that ignores the abort signal)
- *Signal already aborted* (calls `HostedSession.compact` directly, because the
  wire cannot produce this). Result: `-32010`, history untouched, slot freed.
  The summarize model call is still made: `summaries 1` (nit R2-1).
- *Abort after the compaction settles, and listener leaks.* The listener is
  added once and removed once. A late `abort()` while the next turn runs has
  no effect: the turn completes and the history grows normally. Holds.
- *`session/cancel` and `$/cancelRequest` on the same compaction.* Both abort
  the same controller: the history is untouched, the slot is freed, and the
  client gets its local "cancelled". Holds.
- *A prompt sent right after `$/cancelRequest`* gets `-32009`. The slot stays
  held until the summarize actually unwinds (here the provider ignores the
  signal), while the client has already rejected the request locally. The
  failure is loud and the slot frees itself; this is correct by design
  (observation R2-3).
- *`peer.close()`* also aborts every `inboundCancel` controller
  (`peer.ts:259`). A close therefore now reaches a compaction by two paths:
  `cancel()` and the signal. Both are idempotent. Holds.

**Nits (none blocking)**
- R2-1 `hosted-session.ts:297-299`: over the wire, the already-aborted branch
  never runs, because the peer creates a fresh controller and calls the
  handler synchronously (`peer.ts:337-342`). It is defensive code with no
  test. A direct caller that passes an aborted signal still pays for one
  summarize model call. To fix both, reject `Cancelled` before taking the
  slot, and add a unit test.
- R2-2 `hosted-session.ts:311`: the `removeEventListener` is good hygiene but
  has no test. Without it, a late abort only hits an orphaned per-compaction
  controller, which does nothing. Harmless.
- R2-3: with a provider that ignores the signal, the slot outlives the
  client-side cancel. That is correct (fail-loud, not silent), but the TUI
  busy-state follow-up in Notes should keep it in mind.

### Eval verdict (pre-promotion)

*— claude-opus-5-5, 2026-10-17*

**Verdict: CONFIRMED — promote to `fix/daemon-compact-turn-guard`.**

Attempts to falsify: (1) maybe `Session.compact` copies the array — no, it
mutates `this.messages` in place (`session.ts:96-97`), the same reference the
running `runMessages` holds; (2) maybe the peer serialises requests — no,
`peer.ts:184` is fire-and-forget; (3) maybe the TUI fully covers it — only for
direction A; direction B is open; (4) maybe cancel stops a compact — no, it only
aborts the turn controller. The repro output above is decisive for all four.

**Fix direction (do not serialise the peer, §7).** Make mutual exclusion a
per-session state in `HostedSession`, rejecting rather than queueing:
- `compact()` throws `TurnInProgress` (or a new additive domain code) when a turn
  or another compact is active; `prompt()` likewise rejects while a compact is
  active. Use one busy flag / shared `AbortController` set synchronously before
  the first `await`, cleared in `finally`.
- Give the compact its own `AbortController`, pass its signal to
  `session.compact(signal)` (already supported, `session.ts:91`), and let
  `cancel()` abort it, so `session/cancel` stops a long summarise.
- `running` (`hosted-session.ts:65`) should probably report true during a compact
  too; check its callers before changing its meaning.
- Optional defence in depth: `Session.compact` could re-check that
  `this.messages.length === before` after the `await` and refuse to overwrite.
- TUI: show the compact as busy (or reject prompts with a notice) — but the
  daemon guard is the real fix; the client must handle the rejection cleanly.

Failure modes to pin with red-first tests in `packages/daemon/test/integration.test.ts`
(ScriptedProvider + gated exec/summary, as in the repro): compact-during-turn is
rejected and the history stays valid; prompt-during-compact is rejected; cancel
aborts a pending compact and leaves the history untouched; a compact that throws
clears the busy state; `session/enqueue` / `request_permission` still flow
concurrently during a turn (non-serialisation regression).
