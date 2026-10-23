# feat/send-now-b — `sendNow` on the client: `RemoteClient`, `RemoteSession`, the cli wrapper

> **Status:** implementation (plan approved by the owner 2026-10-23; R0 Ctrl+S pty check approved as the first step)
> **Branch:** `feat/send-now-b` (off `main` **after `feat/send-now-a` is merged**)
> **Type:** feat · **Size:** M · **Blast:** load-bearing (the single session path `RemoteClient` ↔ `Connection`, turn-stream routing, reconnect recovery; AGENTS §7) · **Suited:** strong model executes; fresh-context Review mandatory, red-teaming the turn hand-over inside `RemoteSession` and the recovery paths

Parent decision record: `docs/eval/send-now.md`. Previous slice: `send-now-a`
(the daemon method). This is the client half of the eval's slice A, plus the
cli wrapper from its slice B.

## Context

*— claude-opus-5-5, 2026-10-23*

**Why.** `session/send_now` (a) needs a client path. AGENTS §7 says one
session path for every runtime: `RemoteClient` ↔ `Connection` through
`createLocalRuntime`. So `sendNow` is added to `RemoteClient` (the
client-agnostic call the mobile app also uses, decision 15) and to
`RemoteSession` (the TUI's turn stream). The cli's persisting wrapper
forwards it. Nothing here renders. The TUI is c.

**Premises re-verified on `main` @ `be75584`** (no change to `packages/`
since the eval except version bumps):
- `RemoteSession.enqueue` binds to `this.turnId` with a fresh random key
  (`client/src/remote-session.ts:116-129`). `this.turnId` is set only by its
  own `send` (`:139-140`).
- One `active: ActiveTurn` is routed by order, not by turn id. Most updates
  (text deltas) carry no `turnId`. `output` drops everything while idle or
  ended (`:222-231`). `turn_start` is used only after a reset (`:307-313`).
  `turn_end` with the active `turnId` ends it (`:315-320`, `end` `:343-360`).
- Recovery: `recovered()` re-sends only the active turn's prompt, via
  `turnRecovery` (`:280-290`, `client/src/link-machine.ts:173-179`).
  `linkClosed` and `turn_lost` fail only `active` (`:259-272`, `:293-298`).
- `RemoteClient.prompt`/`enqueue` are **keyed** `sessionCall`s, re-sent after a
  drop and deduped by the daemon (`client/src/remote-client.ts:15-16`,
  `:469-503`). `cancel` is a notification, lost while down (`:505-510`).
- The cli's `persistingController` wraps `send` (flush when the turn settles),
  `compact` and `enqueue` (`cli/src/local-runtime.ts:134-166`).
- The daemon emits the old `turn_end` and then the successor's `turn_start` in
  one synchronous stretch, with nothing in between (a, T-A1). A successor
  cancelled before it started gets `turn_end{cancelled}` with **no**
  `turn_start`, and nothing of it was delivered (a, `endUnstarted` contract).

**Repro (capability missing)**, 2026-10-23: `rg -n 'sendNow' packages/client packages/cli` → exit 1.

**Other tasks.**
- *Task 1 (`feat/session-list`)* likely adds a `listSessions` to
  `remote-client.ts`: an adjacent method, a trivial rebase.
- *Task 6 (TUI renders foreign turns)* will rework `RemoteSession.output`'s
  idle drop (`:230`). This task's `next` hand-over is order-based (old
  `turn_end` → promote), the same rule task 6 needs for "a turn started
  elsewhere". Task 6 extends `promote()`. It does not conflict.
- *Task 5 (queued broadcast)* is client-side, a new display update in
  `client/mapping.ts`. It is independent of this task.

## Implementation

*— claude-opus-5-5, 2026-10-23*

### Load-bearing assumption

**On this session's stream, the old turn's `turn_end` comes strictly before
every update of the successor. So `RemoteSession` can keep routing by order:
it promotes the successor to `active` at the old turn's end.**

Proof: the daemon's `finishTurn` emits `turn_end` and then calls the hand-off
in the same synchronous stretch (a, Design; `hosted-session.ts:820-843`
today). `emit` numbers updates in call order (`hosted-session.ts:661-673`,
`++this.seq`), and the ring replays by seq. So a live stream and a replayed
one have the same order. Decisive test: T-B1 below. It runs against the real
daemon from a, not a fake.

### Preconditions

- Q1 — `prompt`'s ack-then-stream shape (`remote-session.ts:196-217`): the
  ack can arrive after the turn's whole stream (`:340-342`). The successor
  inherits the same `ActiveTurn` fields (`acked`, `ended`, `sent`,
  `abortWanted`).
- Q2 — a keyed `sessionCall` is re-sent after a drop until answered
  (`remote-client.ts:15-16`). A rejected one rejects its promise.
- Q3 — `RpcError` + `DomainErrorCode.{Cancelled, NoTurnRunning, TurnInProgress}`
  exist (`@tentacle/transport`; `Cancelled` is used by
  `hosted-session.ts:875,887`).
- Q4 — single-broker invariant untouched: no broker or runtime construction
  changes.

### Design

**`RemoteClient.sendNow(sessionId, turnId, interrupt, messages, onSent?): Promise<PromptResult>`**
is a keyed `sessionCall(… Method.SendNow …)`, shaped like `prompt`
(`remote-client.ts:469-483`). It is client-agnostic: plain params, no turn
tracking. The mobile app can call it directly.

**`RemoteSession`:**
- `enqueue(text, id?)`: `id` (the caller's row id) replaces the random key
  when given (`:121`), so a send-now can cite its enqueue keys (a, T-A5).
  Callers without one are unchanged.
- `sendNow(messages: readonly {id, text}[], target: "turn" | "compaction", signal?): Promise<AsyncIterable<SessionEvent>>`:
  1. Local refusals, with nothing sent. `messages` empty → reject
     `InvalidParams` (the TUI never calls it then, D2). `target: "turn"` with
     `this.turnId === null` or no live `active` → reject `NoTurnRunning`. No
     session id yet → reject `NoTurnRunning`.
  2. `newTurnId = randomUUID()`. Build `next: ActiveTurn` (with `prompt: ""`,
     `started: false`). **`this.turnId` is NOT switched yet.** Enqueues typed
     after the key keep binding to the old turn, and the daemon re-seeds them
     into the successor (a, seed step 2). This avoids a window where an
     enqueue to the successor id can only be folded. A folded steer is lost
     if the successor is cancelled before it starts (a, `endUnstarted`), and
     the client would then have to track which turn each row went to. *(This
     deviates from the eval's "sets `this.turnId` at once".)*
  3. Send `client.sendNow(id, newTurnId, interrupt, messages, onSent)`, where
     `interrupt = target === "turn" ? {kind:"turn", turnId: this.turnId} : {kind:"compaction"}`.
     Return a promise that **resolves on the ack** with `next.queue`'s
     iterable, and **rejects** with the RPC error (`MethodNotFound`,
     `TurnInProgress`, `NoTurnRunning`, …). On reject, `next` is discarded and
     nothing else changed. On ack: `ack.ended` → `end(next, ack.ended)` (a
     retried send-now whose turn already finished).
  4. `this.next = next` is set **before** step 3's request goes out.
     **Promotion:** in `end()` and `fail()` of the current `active`: `active = next`, `next = null`, `this.turnId = newTurnId`.
     Enqueues from then on bind to the successor. If an enqueue for the old
     turn is racing in flight, the daemon either still accepts and re-seeds
     it (before the hand-off) or rejects `NoTurnRunning` (after). The latter
     is today's boundary behaviour, and the TUI shows "not queued" and
     restores the row.
  5. `onUpdate` for the successor: on `turn_start` with its `turnId`, set
     `started = true` and, **always** (not only after a reset, unlike
     `:310`), push `user_message{prompt}` when `prompt !== ""`. The daemon's
     prompt is authoritative for what was sent (a filtered out the drained
     texts). On `turn_end` with `started === false` and `stopReason:
     "cancelled"`, fail the queue with
     `RpcError(DomainErrorCode.Cancelled, "send-now cancelled before it started")`.
     That is the a-contract surfaced, so the caller restores its texts.
  6. Abort: `signal` aborts like `runTurn`'s `onAbort` (`:180-184`):
     `abortWanted = true` and `client.cancel(id)`. The daemon marks the
     reservation cancelled, or cancels the running successor. A cancel lost
     while the link was down is re-sent on the ack (as `:209-213`).
- Recovery: `recovered()` also runs `turnRecovery` for `next` and re-sends
  `send_now` (keyed) when acked, unfinished and not recreated. `linkClosed`
  and `turn_lost` (when `sent`) also fail `next`.

**cli — `persistingController.sendNow`** (`cli/src/local-runtime.ts:134-166`):
it awaits `inner.sendNow(…)` (rejections pass through untouched, so the TUI
can fall back), then returns an iterable wrapped exactly like `send`'s
(`:135-148`): `flush()` once the successor settles, if anything was yielded.
The old turn still persists through its own `send` wrapper. `enqueue(text, id)`
forwards the id. Only `ChatMessage`s are persisted (§7). Nothing new is
written.

### Files

1. `packages/client/src/remote-client.ts`: `sendNow` (keyed). *(Task 1: an adjacent method.)*
2. `packages/client/src/remote-session.ts`: `enqueue(text, id?)`, `sendNow`, `next`, promotion in `end`/`fail`, the `turn_start`/`turn_end` successor rules, recovery for `next`.
3. `packages/client/src/index.ts`: export any new public type (if the executor adds one).
4. `packages/cli/src/local-runtime.ts`: `persistingController.sendNow`, `enqueue(text, id)`.

### Failure modes

| Case | Convergence |
|---|---|
| Old daemon (`MethodNotFound`) | `sendNow` rejects. `next` is discarded and `turnId` unchanged. The old turn streams on, and the caller falls back (c). T-B4. |
| `TurnInProgress` / `NoTurnRunning` / `InvalidParams` | Rejects with that code. No state changed. The caller decides (c: restore texts, or silent for `NoTurnRunning`). |
| Successor cancelled before it started (Esc in the window, another device's Stop, model-proxy drop) | The successor iterable rejects `Cancelled`. The caller restores its texts. T-B3. |
| Link drop before the ack | The keyed call is re-sent (Q2). The daemon dedupes (a, step 1). |
| Link drop after the ack, before the old `turn_end` | Re-attach replays from `since`. The old `turn_end` promotes, then the successor streams. `recovered` re-sends `send_now` (cached ack). T-B5. |
| Session recreated (daemon lost it) | `turn_lost` fails both `active` and `next` (if `sent`). Nothing is re-run (as `turnRecovery`). |
| The old turn ends naturally while `send_now` is in flight (the daemon takes a's step 5) | The stream order is: old `turn_end`, then the successor's `turn_start` (emitted before the ack), then the ack. `next` is installed **before** the request is sent, so the old `turn_end` promotes it and the successor's updates are routed to it whether or not the ack has arrived. T-B2. |
| Enqueue racing the promotion | Accepted+re-seeded, or `NoTurnRunning` → the TUI's existing "not queued" path. No silent drop. |
| A second `sendNow` while `next` is set | Rejects locally with `TurnInProgress`, so there is no second reservation (the daemon would say the same, a step 2). |

### Tests

Red first. `client/test/remote.test.ts` / `queue.test.ts` run against the
in-memory daemon (the existing pattern). `reattach.test.ts` is for recovery.

- **T-B1** (load-bearing): turn T1 blocked in a tool. `sendNow([{a,"A"}], "turn")`
  resolves on the ack. The old `send` iterable ends with `turn_end{cancelled}`.
  The resolved iterable then yields `user_message{"A"}`, the successor's
  events and `turn_end{end_turn}`. **No successor event is seen by the old
  iterable.** Mutation: promote on the ack instead of on the old `turn_end`
  → the old turn's trailing events leak into the successor (red).
- T-B2 the old turn ends naturally before the ack: the daemon starts the
  successor with the undelivered texts. The iterable still yields its
  `user_message` (the `next` installed before sending; mutation: install it
  in the ack handler → `user_message` lost, red).
- T-B3 cancel in the window → the iterable rejects `Cancelled`. No
  `user_message`.
- T-B4 old daemon (a fake `Connection` without the method, or a peer answering
  `MethodNotFound`) → `sendNow` rejects `MethodNotFound`. `enqueue` still
  binds to the old turn afterwards.
- T-B5 drop after the ack (FakeWS / channel factory, as `reattach.test.ts`)
  → after re-attach the successor streams to completion, and `send_now` ran
  once daemon-side.
- T-B6 `enqueue(text, "id1")` sends `id:"id1"`, and without an id stays random.
- cli: `persistingController.sendNow` flushes once after the successor
  settles (a spy store, as the existing `send` flush test), and passes a
  rejection through unchanged.
- Gate: `bun run check`, lint baseline clean.

## Execution

*— claude-opus-5-5, 2026-10-23*

**Interruption.** The run was stopped partway through by an account usage
limit and resumed on another account (same repo, same branch, nothing else
touched the tree). On resuming:
- `git status --short` and `git diff --stat` were checked;
- the three `src` files were compared with `cmp` against the post-implementation
  backup (`.tentacle/tmp/send-now-b/bak/`). All matched, so no temporary
  mutation was left applied. The test files differed from the snapshot only by
  the T-B5b–d tests added after it was taken.

**Baseline** (unchanged tree, before any edit), `bun run check`: typecheck
clean · lint `Checked 410 files … No fixes applied` · **2048 pass, 2 skip,
1 fail** (2051 tests). The fail was `packages/tui/test/queue.test.tsx` "a task
typed while running is shown queued…": a spinner glyph regex timed out under
full-suite load. Run alone, `--rerun-each 5`, it was 15/15 green, so I recorded
it as a **pre-existing timing flake**, not a regression. The expected baseline
was 2049/2/0. It is the same test set, and the end gate below has it green.

**Repro (capability missing)** on `main` @ e0f38e3: `rg 'sendNow|send_now'
packages/client packages/cli` matched nothing. The protocol and daemon had the
method (task a).

**Premises re-verified** (line numbers moved because task 1 added
`listSessions`; the meaning of each premise is unchanged):
- `RemoteClient.prompt`/`enqueue` are keyed `sessionCall`s (`remote-client.ts:486-520` before the edit), and `sessionCall` re-sends keyed calls (`:1214-1255`).
- `RemoteSession` premises hold as cited.
- Task a's drift, checked against `hosted-session.ts:823-975` and the contract comment (`protocol/src/session.ts:327-345`):
  - when the slot is already free, the old `turn_end` comes first, then the successor's `turn_start` (prompt `""` for a continuation), then the ack;
  - an unstarted successor gets `turn_end{cancelled}` with no `turn_start`;
  - `turns.set(turnId, {end})` makes a re-sent `send_now` return `ended`, for an unstarted successor too (`:968`).

No premise failed.

**As built, in plan order:**
1. `client/src/remote-client.ts:511` `sendNow(sessionId, turnId, interrupt, messages, onSent?)`: a keyed `sessionCall(Method.SendNow)`, the same shape as `prompt`.
2. `client/src/remote-session.ts`:
   - `ActiveTurn` gains `sendNow?: {interrupt, messages}` (a send-now turn re-sends `send_now`, not `prompt`) and `started`.
   - `next` (`:80`); `enqueue(text, id?)` (`:132`).
   - `sendNow` (`:173`):
     - local refusals: `InvalidParams`; `UnknownSession` if closed; `NoTurnRunning` with no id, or with no live turn for `"turn"`; `TurnInProgress` if `next` is already set;
     - `next` is installed **before** the request;
     - the abort listener is attached eagerly. A generator body is lazy, so Esc before the caller iterates would otherwise be missed;
     - resolves on the ack with `stream()` (`:242`);
     - on a reject, it detaches `next`/`active` and rethrows.
   - `install` (`:254`): sets `active` and `turnId`, and flushes the idle notices.
   - `promote` (`:263`) is called at the end of `end()` and `fail()`.
   - `sendPrompt` (`:329`) dispatches `prompt` or `send_now` and has a `settled` callback.
   - `finish` (`:532`): the stream's `turn_end` and the ack's `ended` both go through it. An unstarted send-now turn that ends `cancelled` rejects with `RpcError(Cancelled)`.
   - `turn_start` of a send-now turn: sets `started` and pushes `user_message` when the prompt is not `""`.
   - Recovery (`:438`): `turnRecovery` runs for `active`, then for `next`.
   - `failAll` (`:451`): used by `linkClosed`, `failed` and `error`. `turn_lost` uses the same loop with the `sent` check (`:408`).
3. `client/src/index.ts`: unchanged. No new public type: the params use the protocol's `SendNowMessage`.
4. `cli/src/local-runtime.ts`:
   - `PersistingController` gains `enqueue(text, id?)` and `sendNow` (`:92-95`);
   - `send`'s save wrapper is factored into `saved()` (`:147`) and shared by `send` and `sendNow` (`:167`);
   - `enqueue` forwards the id (`:177`).

**Drift from the plan (and why):**
- **Compaction target.** No live `active` exists during a compaction, so
  nothing would ever promote the send-now turn. It is installed at once (the
  same `install`), and `turnId` switches immediately. An enqueue during the
  compaction window then binds to the reserved turn, which the daemon can only
  fold. Not tested here: the TUI path is c.
- **Failure modes the plan did not list, handled and tested:**
  - *Resync with a cut past the hand-off.* The reset names the successor
    (`out.turn === next.turnId`), so the old `turn_end` lies behind the cut and
    will never stream. The old turn is ended `cancelled` and the reset goes to
    the successor (`:363`). The old turn's real outcome is not known at that
    point: a send-now cancelled it, but it may have ended `end_turn`
    naturally. That is an approximation (T-B5d).
  - *Resync with both turns behind the cut.* Only the re-sent `send_now`'s
    `ended` can close the successor, which is why recovery covers `next`
    (T-B5b).
  - `failed` and `error` outputs also fail `next` (`failAll`). Not separately
    tested.
- **Unstarted rule on an ambiguous resync.** If a resync hid the successor's
  `turn_start` and it ended `cancelled`, `started` is still false, so the
  caller restores texts that may already be in the history. A visible
  duplicate was chosen over a silent loss (AGENTS §8).
- **Test files.** The client tests are in a new
  `client/test/send-now.test.ts` (self-contained helpers, mirroring
  `daemon/test/send-now.test.ts`) instead of `remote.test.ts`/`queue.test.ts`.
  T-B5–T-B5d are in `reattach.test.ts`.
- **`tinyRingHost`** (T-B5b–d) approves tools daemon-side (`allowAll`). With
  the link down, a tool's permission prompt would otherwise wait for a client
  that is not attached. This was found empirically: model call 3 never started.

**Tests (+15).**
- `client/test/send-now.test.ts` (9):
  - T-B1, real daemon, gated exec: the ack comes before T1's tail;
  - T-B2, scripted daemon, the slot-free order;
  - a continuation shows no `user_message`;
  - T-B3, real daemon, Esc in the window;
  - T-B4, `MethodNotFound`;
  - a refusal after the hand-off;
  - local refusals; enqueue binds to the old turn until the hand-off;
  - steering binds to the successor after the hand-off;
  - T-B6.
- `client/test/reattach.test.ts` (4):
  - T-B5, a replay after a drop after the ack, with `send_now` re-sent on the new link and run once (one "A", 2 model calls);
  - T-B5b and T-B5c, resyncs with a 1 KB ring (cut before the successor committed a round);
  - T-B5d, resync cut past the hand-off.
- `cli/test/local-runtime.test.ts` (2): one save after the new turn settles; a refusal (the very error object) and a cancel-before-start save nothing.

**Red → green.** The three `src` files were swapped for `git show HEAD:` copies
with `cp`, and the new tests were run: **40 pass, 12 fail**.
- T-B6 was red on its assertion: the id was ignored.
- The others were red with `TypeError: sendNow is not a function`. That is
  expected for a feat. Their property-level reds are the mutations below.
- T-B5b–d were added after this run. They call `sendNow` too.

Green afterwards: 52/52 narrow (`--rerun-each 3`: 117/117 for the client
files).

**Mutations.** Each was applied with Edit, run on the narrow files, and restored
by `cp` from the backup.

| # | Mutation | Red |
|---|---|---|
| M1 | promote on the ack instead of the old `turn_end` (plan's T-B1 mutation) | T-B1, T-B2, T-B3, T-B5, continuation, local refusals |
| M2 | install `next` in the ack handler (plan's T-B2 mutation) | T-B2, continuation |
| M3 | send-now `user_message` only after a reset (old rule) | T-B1, T-B2, T-B5 |
| M4 | no unstarted-cancelled rule | T-B3 |
| M5 | recovery skips `next` | T-B5b (it **survived** T-B5 alone, so T-B5b was added) |
| M6 | `enqueue` ignores the caller's id | T-B6, T-B4, local refusals, after-hand-off |
| M7 | cli `sendNow` without the save wrapper | cli "saved once" |
| M7b | save even when nothing was yielded | cli "refusal/cancel save nothing", plus the existing `send` test (re-run on the final lint-reshaped test) |
| M8 | `turnId` switched at once (the eval's original) | T-B4, local refusals |
| M9 | no reset-past-hand-off rule | T-B5d |

The tree was **byte-identical** afterwards. `git status --short` and the
`shasum` of the 6 changed files were diffed against the snapshots
(`.tentacle/tmp/send-now-b/{status,sha}-before2.txt` vs `-after2.txt`, empty
diffs; M1–M4 against the first snapshot, `shasum -c` OK). The src was also
checked with `cmp` against the gated version after M7b's re-run.

**Gate** (`bun run check`): typecheck clean · lint `Checked 411 files … No
fixes applied` · **2064 pass, 2 skip, 0 fail** (2066 tests, 171 files). That
is +15 tests against 2049/2/0, with the same opt-in skips. Two earlier gate
runs failed and were fixed by hand:
- `tsc`: test literal types (`as const`, and the type of the enqueue record);
- Biome: a quote style, and `useYield` on a throwing generator fake (replaced
  by a plain async iterable).

**Open items.**
- *For c:*
  - `LocalRuntime.createSession` still returns the TUI's `SessionController`
    type, so the TUI reaches `sendNow` only when c widens that interface.
  - The local `NoTurnRunning` (the old turn already ended client-side, but its
    texts are not delivered) is the plan's choice. c must not treat it as
    "silent": the queued rows must still be sent.
  - The compaction-target enqueue window (drift 1).
- *For the owner:*
  - The `cancelled` approximation for the old turn on a resync past the
    hand-off.
  - Restore-over-loss on an ambiguous resync.
  - The pre-existing TUI `queue.test.tsx` flake under load.

**Repro scripts:** none beyond the `rg` above. The rest was done with tests in
the repo. The gate outputs are in `.tentacle/tmp/send-now-b/{baseline,gate}.txt`.

### Execution — follow-up 1 (owner decisions)

*— claude-opus-5-5, 2026-10-23*

**Owner decisions (2026-10-23).** Principle: the client never guesses what the
daemon knows.
1. An ambiguous resync must be decided by a fact from the daemon.
2. The old turn's label after a resync past the hand-off is made exact only if
   an existing path can recover the real outcome with no protocol change.

**1 — `delivered` on the turn's end.**

*Where the client learns the outcome.* Both paths end in
`RemoteSession.finish` (`client/src/remote-session.ts:557`):
- the stream's `turn_end`, through `onUpdate`;
- the ack's `ended`, through `sendPrompt` → `finish`.

On recovery the ack is the re-sent `session/send_now`, which `recovered` sends
(`:461`). Two cases:
- T-B5b: both turns end behind the cut. Only the ack's `ended` reaches the
  client.
- T-B5c/T-B5f: the cut is at T1's end and the successor's `turn_start` is lost
  with the overflowed ring. The live `turn_end` reaches the client.

So the field goes on **`TurnEnd`**, which is both `PromptResult.ended` and the
`turn_end` update:
- `protocol/src/session.ts:157-166` adds `delivered: z.boolean().optional()`;
- `protocol/src/updates.ts:115-116` spells it out in `TurnEndUpdateSchema`, as
  that file requires.

*Daemon.*
- `hosted-session.ts:973` `endUnstarted` sets `delivered: false`.
- `finishTurn` (`:1085`) sets `delivered: true` for a turn in the new
  memory-only `sendNowTurns` (`:220-225`, filled by `startSuccessor`). A
  `prompt` turn carries no field, so no existing `turn_end` changes shape.
- Ends are persisted verbatim (`:541`, reloaded at `:292`), so the field
  survives a restart. A retried ack after a restart reads it (new persistence
  test).
- The record parser checks the type (`persisted-session.ts:112-114`). An older
  daemon reading such a record ignores the unknown member and passes it
  through unchanged. That is correct, so there is no `DAEMON_RECORD_VERSION`
  bump.

*Known gap, documented.* A send-now turn that is resumed after a restart (a
suspended permission) is not in `sendNowTurns`, so its end has no field. The
client then takes the fallback. Persisting the set would change the record
format, which is not worth it for that edge.

*Client.* `finish` decides with `delivered` when it is present. When it is
absent (an older daemon), it falls back to today's inference: not started +
`cancelled` → `Cancelled`, which restores rather than lose.

*Contract.*
- The `session/send_now` comment (`session.ts:348-353`) now says the end
  carries `delivered`, and that a client never infers it from a `turn_start` it
  may not have seen.
- `bun run schema:export` gave `protocol.json` +6 lines.
- Fixtures were added (`json-schema.test.ts`: two `send_now` results and one
  `turn_end`). Their red came from the drift gate.

The field is additive, so there is no `PROTOCOL_VERSION` bump (AGENTS §7
forward compat). An older client drops the member on its strip parse.

**2 — the old turn's real end: implemented.**

*Precondition verified.* The daemon's `prompt` answers a known `turnId` from
its cache before any busy check: `{turnId, ended}` (`hosted-session.ts:767-771`).
The client delivers the reset and then calls `recovered()`
(`client/src/remote-client.ts:1087`, then `:1095`).

When the reset names the successor, the successor started, so the old turn
had already finished and its end is cached. The old turn is always this
client's own (`RemoteSession.active` only holds turns from its own `send`), and
it was acked or its `prompt` is still being retried by `sessionCall`.

"Another client started it" cannot arise here: a foreign turn is never this
session's `active`. The daemon cache is keyed by `turnId`, not by client, but
re-sending `prompt` for a turn this client did not start would risk starting
one, and nothing here does that.

*Design.*
- On a reset past the hand-off the old turn becomes `settling` (`:86`, `:380`)
  instead of being ended `cancelled`. The successor is installed.
- `recovered` re-sends `settling`'s prompt (`:461`), and its `ended` ends it
  with the real outcome (`promote` clears `settling`, `:270`).
- `failAll` (`:475`) and `turn_lost` (`:425`) also fail a settling turn.

Every answer on the new link comes after the old turn's end, so it carries
`ended`. An answer from the dead link is discarded by `sessionCall`'s
generation check. Nothing is guessed.

*Probe* (`.tentacle/tmp/send-now-b/old-end-probe.test.ts`, run through
`bun test` because a plain `bun <script>` needs approval here). Does an aborted
T1 whose model throws end with anything but `cancelled`?

```
sendNow ack {"turnId":"T2"}
ends [{"type":"turn_end","turnId":"T1","stopReason":"cancelled"},{"type":"turn_end","turnId":"T2","stopReason":"end_turn"}]
T1 retry {"turnId":"T1","ended":{"stopReason":"cancelled"}}
```

No: a reserved send-now always aborts T1, so it ends `cancelled`. Only the
daemon's slot-free path gives a different real outcome. T-B5e builds that path
with a link that mutes the daemon's frames: T1's `turn_end end_turn` is lost,
the client still sees T1 running, and its `send_now` starts the successor at
once. Then come a drop and a resync past the hand-off.

**Tests (+10).**
- `client/test/send-now.test.ts` +7:
  - ack and stream × `delivered` true / false / absent;
  - `delivered: false` beats a seen `turn_start`.
- `client/test/reattach.test.ts` +2, real daemon:
  - **T-B5e**: the old turn's real `end_turn` after a resync past the hand-off;
  - **T-B5f**: the resync hid the successor's `turn_start`, then Esc; the
    successor ends `cancelled`, the texts are not restored, and the history
    has one "A".
- `daemon/test/send-now.test.ts`:
  - +1: `delivered` survives a restart, and a non-boolean value is refused;
  - T-A8 ×3 and T-A9 now pin `delivered` (T1, a `prompt` turn, has no field).

**Red → green.**

| Run | Result | Red on |
|---|---|---|
| New client tests, current client code | 13 pass, 3 fail | ack and stream `delivered: true` (the duplicate restore), "false beats a seen start" |
| T-B5f, current client code | red | `"send-now cancelled before it started"` while "A" is in the history (the real duplicate) |
| T-B5e, current client code | red | `cancelled` received, `end_turn` expected |
| Updated daemon tests, `hosted-session.ts`/`persisted-session.ts` at `HEAD` | 5 red | T-A8 ×3, T-A9, persistence |
| T-B5f, daemon at `HEAD` (no field), new client | red | the documented older-daemon fallback: restore |

Green afterwards: `--rerun-each 3` gave 144/144 for the client files; daemon
259/259.

**Mutations.** Each was applied with Edit and restored by `cp` from
`.tentacle/tmp/send-now-b/bak2/`.

| # | Mutation | Red |
|---|---|---|
| N1 | ignore `delivered` (always infer) | ack and stream `true`, "false beats a seen start", T-B5f |
| N2 | invert `delivered` | 13 tests, including all `delivered` cases, T-B1, T-B3, T-B5–T-B5f |
| N3 | fallback broken (field absent → never restore) | ack and stream "no field" |
| N4 | daemon: no `delivered: true` in `finishTurn` | T-A9, T-B5f |
| N5 | daemon: no `delivered: false` in `endUnstarted` | T-A8 ×3, persistence (client T-B3 stays green: the fallback covers it, as designed) |
| N6 | point 2 reverted (old turn closed `cancelled` at the reset) | T-B5e |
| N7 | `recovered` skips `settling` | T-B5d, T-B5e |
| N8 | parser does not check `delivered` | persistence |

The tree was **byte-identical** afterwards. `git status --short` and the
`shasum` of all 13 changed files were diffed against the snapshots
(`{status,sha}-before3.txt` vs `-after3.txt`, empty diffs). No `MUTATION`
marker is left.

**Drift.**
- The earlier Execution's open owner items ("`cancelled` approximation",
  "restore-over-loss on an ambiguous resync") are resolved here. The
  restore-over-loss inference survives only as the older-daemon fallback.
- `persisted-session.ts` (validation only) and the fixtures were touched; the
  plan did not name them.
- The `started` field comment now says it is only the fallback.

**Gate** (`bun run check`): typecheck clean · lint `Checked 411 files … No
fixes applied` · **2074 pass, 2 skip, 0 fail** (2076 tests, 171 files). That
is +10 against 2064/2/0.

The first gate run had one fail: `exec/test/process-tree.test.ts` "process.exit
kills a running job's tree" ran for 592 537 ms before reporting its 5 s
timeout, and the whole run took 675 s against the usual ~80 s. That is a
machine-level stall in a package this task does not touch. Alone it passes
15/15, and the full re-run is green. Outputs:
`.tentacle/tmp/send-now-b/gate{2,3}.txt`.

### Execution — follow-up 2 (review nits)

*— claude-opus-5-5, 2026-10-23*

The owner asked to close all four Review findings before the merge. The
Review section is unchanged. Line numbers below are today's.

**Finding 1 — the refusal cleanup is now pinned.** T-B4
(`client/test/send-now.test.ts:278-283`) now checks two more things:
- after the `MethodNotFound`, a **second** `sendNow` in the same turn reaches
  the daemon (`requests` holds 2 × `session/send_now`, the second refusal is
  also `MethodNotFound`, not a local `TurnInProgress`);
- after the old turn's `turn_end`, `enqueue` still names T1, so the refused
  turn was not installed at the old turn's end.

The scripted daemon gained a `requests` log. No source change: the code was
right, it was just untested. **R6 → red** (T-B4).

**Finding 2 — the older-daemon "a reset shows it started" fallback is now
pinned.** New scripted test (`send-now.test.ts:437`), with no reconnect
needed:
1. the old turn ends;
2. a `history_replaced` barrier makes the reducer fetch a snapshot
   (`session-reducer.ts:257-260`);
3. the snapshot's `turn` names the successor (`:310-321`, a `reset`);
4. `turn_end{cancelled}` arrives **without** `delivered`.

The iterable must yield `[history_reset, turn_end cancelled]` and not reject.
The scripted daemon gained `onSnapshot` and a non-mandatory `notify`. **R8 →
red.**

**Finding 3 — the two `settling` fail branches: removed.** I removed them
rather than keeping them with a comment, for two reasons:

- *They are redundant on every terminal path.* A settling turn always has its
  keyed `prompt` in flight. Either `recovered` re-sent it (the reset is
  delivered just before `recovered`, `remote-client.ts:1087`/`:1095`; a reset
  past the hand-off never comes with a recreate), or the original call is
  still being retried. `sessionCall` rejects that call:
  - on a dead link: `stopError` in `whenLive`, `remote-client.ts:1177`;
  - on a failed session: `:1189`;
  - on a recreate: `SessionLostError`, `:1234`.

  `sendPrompt`'s rejection handler then fails the turn.
- *In one path the branch was wrong, not redundant.* `failAll` also runs on an
  `error` output: a frame this client cannot act on, while the link is
  healthy. There it failed the settling turn although its real end was still
  on the way. That is a guess, against the owner's principle. Without the
  branch, the settling turn gets its real end.

Comments now say this at `remote-session.ts:435` and on `failAll` (`:480-485`).

*Proof.* Two new real-daemon tests (`reattach.test.ts:1396`, `:1410`) on the
T-B5e setup, refactored into `pastHandOff(onResentPrompt)`. That helper kills
the new link through `Target.onFrame` just after the re-sent `prompt` is
forwarded, so the call stays in flight. Then:
- the dials are refused: the old turn rejects with "rejected the credentials:
  401";
- the host is swapped for a fresh one: the old turn rejects with "lost the
  session", and the fresh model is never called.

Both are green with the branches removed (`--rerun-each 3`: 156/156).

New mutation **N9**: `sendPrompt`'s rejection does not fail a settling turn.
Both tests go red. So they really exercise the settling path, and the failure
comes from the in-flight call.

*R4/R5* were the removal of these branches. They survived the review because
the branches were equivalent mutants, as N9 plus the green runs above show.
Now that the branches are gone, R4/R5 cannot be applied any more.

**Finding 4 — bug fixed, red first.** New test (`send-now.test.ts:475`):
1. after T1 ended, an unknown display update arrives while idle;
2. a `compaction` send-now is refused with `CompactInProgress`;
3. `enqueue` must still name T1;
4. the next `send` must start with the `unsupported` notice.

Red on the code before the fix: `turnId` was the refused turn's id. After
restoring only `turnId` (step 1 of the fix), it was still red on the notice:
the next turn started with `turn_end`, not `unsupported`.

The fix (2 files):
- `queue.ts:43-46` adds `AsyncQueue.takeBuffered()` (4 lines + doc), with its
  own unit test (`queue.test.ts:45`);
- `remote-session.ts` keeps `const before = this.turnId` (`:221`). In the
  refusal catch, when the refused turn had been installed (no turn to wait
  for, or promoted at the old turn's end), it restores `turnId = before` and
  puts the refused queue's buffered `unsupported` events back at the head of
  `idleNotices` (`:249-251`). That queue was never iterated, so every notice
  it took is still buffered: the idle ones and any that arrived since.

That is about 4 code lines in `remote-session.ts` plus comments, and 4 in
`queue.ts`. Mutations: **F4a** (no `turnId` restore) → red; **F4b** (no
notice restore) → red.

**Mutations, all on the final code.** Each was applied with Edit and restored
by `cp` from `.tentacle/tmp/send-now-b/bak4/`.

| # | Mutation | Red |
|---|---|---|
| R1 (reviewer) | `finishTurn` sets `delivered: true` on every turn | T-A8 close, T-A9 |
| R2, R3, R7 | **not defined** in the Review or in the reviewer's folder (`.tentacle/tmp/send-now-b/review/`). The Review table lists only R1, R4+R5+R6, R8. Not invented. | — |
| R4, R5 (reviewer) | branches removed: equivalent mutants, see finding 3 | n/a |
| R6 (reviewer) | refusal does not clear `next` | T-B4 |
| R8 (reviewer) | a reset no longer marks `started` | finding 2 |
| M1 | promote on the ack | 14 (T-B1, T-B2, T-B3, T-B5–T-B5f, …) |
| M2 | install `next` on the ack | 7 (T-B2, T-B5e, continuation, …) |
| M3 | `user_message` only after a reset | T-B1, T-B2, T-B5 |
| M4 | no undelivered rule | T-B3 plus 5 `delivered` tests |
| M5 | recovery skips `next` | T-B5b |
| M6 | `enqueue` ignores the id | T-B6 plus 4 |
| M7 / M7b | cli without the save wrapper / save always | cli "saved once" / cli "save nothing" plus the existing `send` test |
| M8 | `turnId` switched at once | T-B4, local refusals |
| M9 | no reset-past-the-hand-off rule | T-B5d, T-B5e |
| N1 / N2 / N3 | ignore / invert `delivered` / fallback broken | 4 / 13 / 2 |
| N4 / N5 | daemon without `delivered: true` / without `false` | T-A9, T-B5f / T-A8 ×3, persistence |
| N6 | point 2 reverted | T-B5e, both settling tests |
| N7 | recovery skips `settling` | T-B5d, T-B5e, both settling tests |
| N8 | parser does not check `delivered` | persistence |
| N9 (new) | a settling turn's call rejection does not fail it | both settling tests |
| F4a / F4b (new) | no `turnId` / no notice restore | finding 4 |

The tree was **byte-identical** afterwards. `git status --short` and the
`shasum` of all 15 changed files were diffed against the snapshots
(`{status,sha}-before4.txt` vs `-after4.txt`, empty diffs). No `MUTATION`
marker is left. N9 was also run once before the test files were formatted:
same result.

**Drift.**
- `queue.ts` and `queue.test.ts` were touched; the plan did not name them.
- Biome formatting was fixed by hand in the two client test files.
- `DAEMON_RECORD_VERSION` was not bumped, as instructed.

**Gate** (`bun run check`): typecheck clean · lint `Checked 411 files … No
fixes applied` · **2079 pass, 2 skip, 0 fail** (2081 tests, 171 files,
76.4 s). That is +5 against 2074/2/0, with the same opt-in skips. Output:
`.tentacle/tmp/send-now-b/gate4.txt`.

## Review

*— claude-opus-5-5 (reviewer, fresh context), 2026-10-23. Same model as the
planner and the executor: only the context is fresh, so blind spots shared by
the model survive both passes. A `load-bearing` task would ideally get a
second review by a different model (AGENTS §10).*

**Verdict: APPROVE-WITH-NITS.** No correctness defect found on the single
session path, the hand-over, or the recovery paths. The nits are test gaps on
defensive or fallback code, plus one small state leak on the compaction
target. None blocks the merge. They can be closed here or carried to c.

### Findings

1. **Test gap: the refusal cleanup is not pinned.**
   `client/src/remote-session.ts:239-241` (`this.next = null` on a refusal)
   can be removed and every client test stays green (R6). The plan's failure
   row "MethodNotFound → `next` is discarded" cites T-B4, but T-B4 checks only
   that `enqueue` still binds to the old turn. If the cleanup broke, a second
   `sendNow` in the same turn would be refused locally (`TurnInProgress`), and
   the refused turn would be installed at the old turn's end.
   Fix: in T-B4, call `sendNow` a second time after the refusal and assert
   that it reaches the daemon.
2. **Test gap: the older-daemon fallback "a reset showed it running" is not
   pinned.** At `remote-session.ts:402`, `started = true` can be flipped to
   `false` and the tests stay green (R8). The executor's T-B5f red run against
   a daemon at `HEAD` covered this fallback once, but no test in the tree
   keeps it covered. Fix: a scripted-daemon test where a reset names the
   successor, then `turn_end{cancelled}` arrives without `delivered`, and the
   iterable must end without restoring.
3. **Defensive code with no test (FYI).** Removing the `settling` failure in
   `turn_lost` (`:428`) and in `failAll` (`:478`) leaves every test green
   (R4/R5). The behaviour still holds without it: a settling turn always has a
   keyed call in flight (its retried `prompt`), and `sessionCall` rejects that
   call when the session is recreated ("keyed commands never cross one",
   `remote-client.ts:161,192`) or when the link closes. So these branches are
   a second safety net. Either keep them with a one-line test or say in the
   comment that they are a safety net.
4. **Compaction-target refusal leaks state** (`:224` with `:242-244`).
   `install` sets `turnId` to the new turn's id and moves pending
   `idleNotices` into that turn's queue. On a refusal, the catch only clears
   `active`. So `turnId` stays on a turn the daemon never had, and those
   notices are dropped. The forward-compat doc says an `unsupported` notice is
   "never dropped". The impact is small: a later `enqueue` gets
   `NoTurnRunning`, which a stale ended id gets too. Fix: restore the previous
   `turnId` and the notices in the catch. Untested, like the rest of the
   compaction drift, which is addendum item 11 and belongs to c.

### Specific question — `delivered` in the record without a `DAEMON_RECORD_VERSION` bump

**An older daemon does not half-load such a record.** Checked against the
pre-task code (e0f38e3) with a repro,
`.tentacle/tmp/send-now-b/review/old-daemon-record.test.ts`. It feeds a
record whose turn ends carry `delivered: false` and `delivered: true` to the
old `parseDaemonRecord` and the old `reconcileOnReload`. Output:

```
parsed     [{"turnId":"T1","end":{"stopReason":"cancelled"}},{"turnId":"T2","end":{"stopReason":"cancelled","delivered":false}},{"turnId":"T3","end":{"stopReason":"end_turn","delivered":true}}]
reconciled [... same, delivered intact ...]   1 pass
```

Why it holds:
- The old parser validates and then casts the record as it is. It does not
  rebuild it (`persisted-session.ts:195`).
- The old constructor stores the same `end` object (`hosted-session.ts:297`).
- `persistedState` writes that object back unchanged (`:548`).
- A retried ack returns it unchanged as `ended`.

So an older daemon keeps the field, writes it back, and even serves it. The
clause "never half-loaded" targets a reader that silently drops or
misreads part of a record. Here the old reader drops nothing. It only does not
*add* the field to turns that end on it. That gives a record with some ends
with the field and some without. A client handles that through the documented
fallback (`started` + `cancelled` → restore), so the worst case is a visible
duplicate, never a silent loss. That fallback exists anyway for a live older
daemon. A downgrade does not add a new failure mode.

**Recommendation: accept, no bump.**
- The field is optional, purely additive, and its absence already has a
  defined meaning, the same as on the wire, where no `PROTOCOL_VERSION` bump
  was needed either.
- A bump to 2 would make every older daemon *refuse* every record that this
  build wrote, including records that never used send-now. That is a much
  bigger loss (the sessions go missing after a downgrade) to protect a field
  that older daemons already carry intact.
- If task 2a bumps 1→2 for its own reasons, `delivered` simply goes along.
  It needs no migration (absent = old semantics).

The only tightening in the other direction is real but correct: the new parser
refuses a record whose `delivered` is not a boolean (`persisted-session.ts:112`),
like the other end fields.

### Gate (re-run by the reviewer)

`bun run check`: typecheck clean · lint `Checked 411 files … No fixes
applied` · **2074 pass, 2 skip, 0 fail** (2076 tests, 171 files, 76.4 s).
This matches Execution follow-up 1. The skips are the two opt-in ones. No
flake and no `exec` hang in this run.

### Mutations (reviewer's own, beyond the executor's M1–M9 / N1–N8)

| # | Mutation | Result |
|---|---|---|
| R1 | daemon `finishTurn` sets `delivered: true` on **every** turn | **red**: T-A8, T-A9 (2 fail): a `prompt` turn's shape is pinned |
| R4+R5+R6 | no `settling` fail in `turn_lost` / `failAll`; refusal does not clear `next` | **survived** (210/210 client): findings 1, 3 |
| R8 | a reset no longer marks the successor `started` | **survived** (210/210): finding 2 |

Each mutation was applied with Edit and restored by `cp` from
`.tentacle/tmp/send-now-b/review/`. Afterwards `shasum -c` gave OK on all 14
task files, and `git status --short` matched the snapshot taken before the
review. The tree is byte-identical.

### Premise table

| Premise | Verdict |
|---|---|
| Context symptom: no `sendNow` in client/cli on `main` | TRUE: Execution's `rg` on e0f38e3. The capability now exists (`remote-client.ts:511`) |
| Load-bearing: the old `turn_end` comes strictly before the successor's updates | TRUE: `finishTurn` emits `turn_end` (`hosted-session.ts:1094`), then `settleSuccessor()` last in the same synchronous `finally` (`:1102`); `emit` numbers updates by call order |
| `turnRecovery` re-sends only an acked, unfinished, not-recreated turn | TRUE: `link-machine.ts:173-179` |
| Keyed `sessionCall`s are re-sent after a drop and never cross a recreation | TRUE: `remote-client.ts:161,192,1209` |
| Ends are persisted and reloaded verbatim | TRUE: `hosted-session.ts:297,548` (and the repro above) |
| The prompt cache answers a known `turnId` before the busy check (item 9) | TRUE: `hosted-session.ts:773` (`turns.get` first) |

### Attacks tried

1. **One session path (§7).** `sendNow` reuses `sendPrompt` → the keyed
   `sessionCall`, the same queue, `end`/`fail` and recovery as `send`. There is
   no second agent loop and no second send path. `RemoteClient.sendNow` is a
   plain call that tracks nothing, so the mobile app can use it. **Holds.**
2. **Hand-over by order with a second client (D4).** A foreign prompt cannot
   slip in between the old `turn_end` and the successor's `turn_start`: one
   synchronous stretch. If our `send_now` is refused after a promotion
   ("refusal after the hand-off"), the foreign deltas routed to the promoted
   turn go into a queue that is never returned, so nothing shows. **Holds.**
3. **Resync, cut past the hand-off, old turn not acked.** `settling` gets no
   explicit re-send, because only an acked turn is re-sent. Its original
   `prompt` is still retried by `sessionCall`, and the answer carries `ended`,
   because the successor started after it. `finish` → `promote` clears
   `settling`. **Holds.**
4. **Recovery re-sends answered out of order.** If the successor's `ended`
   arrives before the old turn's, `finish(next)` closes `next`'s queue without
   promoting it. The old turn's end then installs an already-ended turn, which
   is harmless: its stream is only `turn_end`. **Holds.**
5. **Recreated session with a settling turn.** Its in-flight prompt is not
   re-sent across the recreation, so it is rejected and the turn fails: no
   re-run. **Holds** (finding 3: the explicit branch is redundant).
6. **Forward compatibility.**
   - An older client drops `delivered` on its strip parse
     (`TurnEndUpdateSchema` and `TurnEndSchema` are not `.strict()`).
   - With an older daemon (no field), the client falls back to the old
     inference.
   - With a daemon that has no `send_now`: `MethodNotFound` → reject, with
     nothing changed (T-B4).
   - The JSON Schema export (+6 lines) and the fixtures cover both
     `TurnEnd` and `TurnEndUpdate`.

   **Holds.**
7. **cli persistence.** `saved()` is shared: one flush once the successor
   settles, and none if nothing was yielded (a refusal, or a cancel before the
   start). The old turn is saved by its own `send`. Only `snapshot` →
   `ChatMessage`s are saved. **Holds.**
8. **Abort listener lifetime.** It is attached eagerly and removed in
   `stream`'s `finally`. If a caller never iterates the iterable, the listener
   stays on the signal, the same as a `send` that is never drained. It is not
   a new risk. **Noted, not a finding.**

### What holds

The load-bearing assumption, the promotion rule, idempotent retry,
`delivered` as a daemon fact (owner principle, items 8–9), the exact old-turn
label through the existing retry cache, both ends of the wire, and the single
broker (no construction changed).

### How the executor behaved

The executor was disciplined. It re-verified the premises after the account
switch (`cmp` against a backup), showed red before green, and ran 17
mutations that it recorded honestly, including one that survived, M5, which
it fixed by adding T-B5b. It reported the 592 s `exec` stall instead of
hiding it. Its drift is documented (the compaction target, the extra files).
One overclaim: the plan's failure table credits T-B4 with "`next` discarded",
which T-B4 does not assert (finding 1).

### Orchestrator verification after follow-up 2

*— claude-opus-5-5 (orchestrator), 2026-10-23*

- Gate re-run: 2079 pass / 2 skip / 0 fail, lint clean (411 files).
- Finding 4 non-vacuity, independently: deleting `this.turnId = before;` or
  the `idleNotices` restore in `remote-session.ts` each turns "finding 4: a
  refused compaction-target send-now leaves the client as before" RED (214/1);
  file restored byte-identical (`shasum`).
- Not seen by the fresh-context Review: follow-up 2 REMOVED the two
  `settling` fail branches (finding 3) instead of testing them — justified by
  the in-flight `prompt` call rejecting on every terminal path (N9) and by the
  branch guessing an outcome on an `error` frame over a healthy link (owner
  principle: the client never guesses what the daemon knows). Owner chose to
  merge without a second Review round (2026-10-23).
- `DAEMON_RECORD_VERSION` not bumped for `delivered` (Review; recorded in
  `docs/eval/send-now.md` addendum).
