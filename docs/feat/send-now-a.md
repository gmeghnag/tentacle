# feat/send-now-a — `session/send_now`: the daemon's atomic interrupt-and-send

> **Status:** implementation (plan approved by the owner 2026-10-23; R0 Ctrl+S pty check approved as the first step)
> **Branch:** `feat/send-now-a` (off `main`; first of four: a → b → c → d)
> **Type:** feat · **Size:** M · **Blast:** load-bearing (the busy slot, the steering no-await window, the protocol, AGENTS §7) · **Suited:** strong model executes; fresh-context Review mandatory (§10), red-teaming the busy-slot hand-off and the steering window

Parent decision record: `docs/eval/send-now.md` (decided: S1–S3, D1–D5, D3c).
Its split was changed from A/B/C to **a/b/c/d**. The eval's slice A
(protocol → agent → daemon → client) is two tasks here: **a** covers protocol,
agent and daemon, and **b** covers the client and the cli. That keeps this
load-bearing hand-off reviewable on its own, and the mobile app (decision 15)
needs only **a** plus `RemoteClient.sendNow` from **b**. **c** is the TUI.
**d** is the compaction-time queue (D3c).

## Context

*— claude-opus-5-5, 2026-10-23*

**Why.** A user who has queued steering messages mid-turn wants them sent
**now**. Today they are injected only at the next model-round boundary. The
owner decided Claude Code's semantics (S1): cancel the whole turn, then start
a new turn whose prompt is the queued texts, joined (D1: `"\n\n"`, exactly as
typed, in order). This happens **in one daemon step**, so no other client's
prompt can slip in between (S2). Mobile decision 15 uses the same
`session/send_now` for its "Send now" button. So the method must be
client-agnostic: plain params (target, texts, idempotency keys), no TUI
assumption.

This task builds only the daemon side: the protocol method, the agent's
steering seed, and `HostedSession`/`Connection`. Raw RPC requests (the daemon
integration-test pattern) drive and pin it. Nothing calls it from a client
until **b**.

**Premises re-verified on today's `main` (`be75584`).** Since the eval
(`bf42260`), `packages/` has changed only in `package.json` version bumps
(`git diff --stat bf42260 HEAD -- packages`). Every citation below was
re-read. The eval's line numbers drift by 1–3 lines, corrected here. Four
premises were wrong or incomplete and are fixed in the design:

1. **P4 was false, and is not needed.** The eval claimed "an aborted turn never
   drains again". But the `turn_start`-hook stop path drains steering **without
   an abort check** (`agent/src/agent.ts:437-446`). A steer accepted during a
   `turn_start` hook that is then cancelled can still drain after the abort.
   Fix: the prompt filter ("which of my messages were already injected") is
   computed **at the hand-off**, after the old turn's `turn_end`. By then every
   drain of the old turn has been observed (`drive` sees each `steer` event,
   `daemon/src/hosted-session.ts:763-784`). Nothing needs P4.
2. **Reserving the successor's `turnId` in `turns` (eval step 4) would put a
   dangling key on disk.** `persistedState` writes every `turns` entry
   (`hosted-session.ts:476-499`). The persister builds the record
   **synchronously** at `schedule` (`session-persister.ts:83-91`).
   `finishTurn`'s `persist` (`hosted-session.ts:836-842`) runs inside the
   window. After a crash there, the reload would hold the key with no end and
   no `turn`, the client's resent `send_now` would get a cached `{turnId}` ack,
   and it would wait forever. Fix: the reservation is **memory-only** (a
   `successor` field). The key enters `turns` only when the successor starts.
3. **The eval's optional persisted `steeringIds` would break the on-disk
   rule.** An additive field that an older build ignores is a record that is
   "half-loaded" (AGENTS §7). Honouring the rule needs a
   `DAEMON_RECORD_VERSION` bump. Fix: no persisted change at all. See *Design →
   delivered ids*.
4. **The eval omitted the hooks-trust asker.** `Connection.prompt` passes the
   prompting connection's `hooks/trust` asker into the turn
   (`daemon/src/connection.ts:309-319`). A successor is a fresh turn that may
   need project-hook trust (`agent.ts:388-395`). `send_now` passes it the same
   way.

**Repro (capability missing)**, 2026-10-23, `main` @ `be75584`:
```
$ rg -n 'send_now|sendNow|send-now|SendNow' packages --glob '!**/node_modules/**'; echo "exit=$?"
exit=1
```

**Other tasks.**
- *Task 1 `feat/session-list`*, in flight on another branch, also edits
  `protocol/src/methods.ts`, `daemon/src/connection.ts` (new `case`) and
  `daemon/src/hosted-session.ts`. Task 1 adds a `lastChangeAt` stamp, set
  **where the busy slot ends**: `finishTurn` (`:820-843`) and `compact`'s
  `finally` (`:891-900`). Those are the two places this task's hand-off goes.
  The tasks run sequentially. Whichever lands second rebases knowingly. Keep
  task 1's stamp where task 1 put it: the old turn **did** end, so a hand-off
  must not skip or move the stamp, and the successor start does not stamp.
  The `methods.ts`/`connection.ts` conflicts are adjacent one-line additions.
- *Task 5 (queued-steer broadcast, later)*: this task makes it **easier**. The
  steering mirror below (`{id, text}` in queue order, shifted on every drain)
  is the one place the daemon knows queue membership by id. Task 5 adds the
  `queued`/`dequeued` emits at the same points: push in `enqueue`, shift in
  `drive`, take in the hand-off, reset in `prompt`. No conflict. One existing
  gap task 5 must name: `Session.send` drops a cancelled turn's undrained
  steers at the next turn (`agent/src/session.ts:83-85`), which would be a
  `dequeued{dropped}`. This task does not change that.

## Implementation

*— claude-opus-5-5, 2026-10-23*

### Load-bearing assumption

**The busy slot is the single gate every turn-starting request passes, in one
synchronous step. So freeing it and taking it again for the successor in the
same synchronous stretch admits no other request in between, however long
the cancel takes.**

Proof (re-verified):
- `prompt` checks the slot (`assertIdle`) and takes it (`controller = …`) with
  no `await` in between, synchronously up to the ack
  (`hosted-session.ts:684-730`, comment `:672-675`). `compact` calls
  `assertIdle` before its first `await` (`:870-878`). `assertIdle` throws
  while `controller !== null` (`:736-742`). The only other taker is the
  constructor's resume (`:284-305`).
- The slot is freed in exactly two places: `finishTurn` (`:826-830`,
  synchronous) and `compact`'s `finally` (`:891-900`). `close` goes through
  `finishTurn` (`:940-951`).
- The peer dispatches requests concurrently but on one JS thread
  (`transport/src/peer.ts:322`, `void this.handleRequest`). `handleRequest`
  reaches the handler with no `await` before it: method check, schema parse,
  then `await handler(…)` (`peer.ts:332-352`). So one handler's synchronous
  stretch cannot interleave with another's.

**Held.** The hand-off is called at the end of the synchronous code that
frees the slot, and it takes the slot back without an `await`. Decisive
tests: T-A1 (request level) and T-A1b (microtask level). Mutations M1/M2 are
in *Tests*.

### Preconditions

- **P1 — concurrent dispatch, never serialized** (§7; `peer.ts:322`). The new
  handler is synchronous up to its ack, like `prompt` (`connection.ts:309-319`).
- **P2 — steering no-await window.** From the agent's last drain
  (`agent.ts:573-580`) through `drive` calling `finishTurn` on the `turn_end`
  event (`hosted-session.ts:763-766`) there is no `await`. Pinned by
  `daemon/test/integration.test.ts:401` and `:440` ("no macrotask fits…").
  The hand-off runs **inside** `finishTurn`, so it must not `await` either.
  Neither does the successor's start: `void this.drive(…)` only.
- **P3 — one `steer` event per drained text, in queue order**, on every drain
  path (`agent.ts:442-444`, `:459-461`, `:575-577`, `:620-622`, `:679-681`).
  `drive` forwards each one (`hosted-session.ts:781-784`). So a FIFO id
  mirror shifted on `steer` knows exactly which enqueue ids were injected.
- **P4 — the agent's steering queue is one field, reset at each `send`.**
  `Session.send` sets `this.steering = []` (`agent/src/session.ts:83-85`). The
  drain closure reads the field at each call (`:90`). `resume` keeps it
  (`:115-118`), seeded by the daemon (`hosted-session.ts:284-287`). The one
  agent change replaces the reset with a seed.
- **P5 — cancel keeps history valid on every path.** A mid-stream abort
  pushes no partial reply (`agent.ts:494-513`). Unstarted calls get
  `CANCELLED_TOOL_NOTE` (`agent.ts:724-739`). A call whose permission was
  settled by the abort reads as cancelled (`agent.ts:906-907`). Hooks get the
  turn's signal (`agent.ts:420-424`, `:539-545`). A pending ask settles
  `cancelled` on abort (`hosted-session.ts:345-360`). A compaction aborted
  before replacement leaves history untouched, and after it is complete
  (`agent/src/session.ts:151-162`).
- **P6 — old generator teardown is inert.** When `drive` `return`s after
  `finishTurn` (`hosted-session.ts:765`), the old generator only runs
  `Session.send`'s `finally { this.persist() }` (`agent/src/session.ts:94-98`,
  the `onPersist` snapshot). `runMessages` has no `finally` that touches
  `messages` (`rg -n finally agent.ts` → only `:752`, a tool's progress
  close). So starting the successor's generator before the old one is
  disposed is safe.
- **P7 — persistence (§7):** only `ChatMessage`s are persisted. The
  reservation writes nothing, and the successor's start persists like
  `prompt` (`hosted-session.ts:723-727`).

### Design

**Protocol (`@tentacle/protocol`), additive, `PROTOCOL_VERSION` stays 10**
(`protocol/src/version.ts:7`). It is a new **method**, not an update. An old
daemon answers `MethodNotFound` (`peer.ts:333-335`), and the client handles
that (b/c fallback). Per §7, "fields and methods are free". No new
`session/update` kind: the successor is bracketed by the existing
`turn_start`/`turn_end` (`protocol/src/updates.ts:101-115`).
```ts
// protocol/src/session.ts (next to EnqueueParamsSchema, :315-323)
export const SendNowTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), turnId: TurnIdSchema }), // the turn the client sees running
  z.object({ kind: z.literal("compaction") }),
]);
export const SendNowMessageSchema = z.object({
  id: EnqueueParamsSchema.shape.id,     // the client's enqueue key (fresh if never enqueued)
  text: EnqueueParamsSchema.shape.text, // min(1)
});
export const SendNowParamsSchema = z.object({
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,                 // the NEW turn: its idempotency key
  interrupt: SendNowTargetSchema,
  messages: z.array(SendNowMessageSchema).min(1), // D2: an empty send-now never reaches the wire
});
export const SendNowResultSchema = PromptResultSchema; // { turnId, ended? }
```
Strip schemas, never `.strict()` (§7 forward-compat). `methods.ts`:
`Method.SendNow: "session/send_now"` and its `RequestSchemas` entry.
`interrupt` names what the client believes it is interrupting. A stale
request (the target already ended) must never cancel some **other** turn.
That keeps the method safe for any client, including the mobile app and
task 6's foreign-turn views.

**Agent — `SendOptions.steering?: readonly string[]`** (`agent/src/session.ts:20-25`).
`send` does `this.steering = [...(opts.steering ?? [])]` in place of the
reset at `:85`. Every existing caller passes nothing, so behaviour is
unchanged.

**Daemon — `HostedSession`** (new state, all in memory):
- `steeringIds: (string | undefined)[]` runs parallel to the agent's queue.
  `enqueue` pushes `id`. `drive` shifts one per `steer` event and adds the id
  to `drained`. `prompt` resets it to `[]` right before `session.send` (the
  agent resets too). The constructor's resume seeds `undefined` per restored
  steer (`:284-287`). Ids are not on disk.
- `drained: Set<string>` holds the ids injected in this incarnation.
  `restoredIds: Set<string>` is a copy of the restored `enqueueIds`
  (`:244-246`).
- **delivered ids:** `isDelivered(id) = drained.has(id) || restoredIds.has(id)`.
  A restored id was accepted by a previous incarnation, so its text is
  already in the history. Either it was drained, or a cut-short turn's
  steering was appended on reload (`persisted-session.ts:319-321`). Or it is
  still in a **resumed** turn's restored queue, where it is re-seeded as an
  id-less steer below. In none of these cases does it go into the prompt,
  which prevents duplicates without any persisted ids. Its one gap: a
  pre-restart *cancelled* turn's undrained steers were already dropped by
  today's reset. That is not a new loss.
- `successor: { turnId, interrupt, messages, steers: {id,text}[], cancelled, askHooksTrust? } | null`
  is the reservation.

`sendNow(turnId, interrupt, messages, askHooksTrust?): PromptResult` is
synchronous to the ack. Order of checks:
1. `turns.get(turnId)` → cached ack (as `prompt`, `:695-698`). Then
   `successor?.turnId === turnId` → `{ turnId }` (a retry while reserved).
2. `successor` set (another one) → `TurnInProgress`.
3. **Target running.** `kind:"turn"` needs `activeTurnId === interrupt.turnId`
   (and not compacting). `kind:"compaction"` needs `compacting`. If so:
   `successor = {…, cancelled:false, steers:[]}`, `controller.abort()`, ack
   `{ turnId }`. Nothing is written: no `turns` key, no `enqueued` ids (premise 2).
4. **Target not running, slot held** (by someone else's turn or compaction) →
   `TurnInProgress`.
5. **Target not running, slot free** (the turn ended on its own just before):
   if every message `isDelivered` → `NoTurnRunning`. That means "all already
   injected, nothing to send", and the client stays silent. Otherwise set
   `successor` and call `startSuccessor()` **now**, so there is one start path.

**Hand-off — `settleSuccessor()`** is called last in `finishTurn`'s `finally`
(after `persist`, `:836-842`) and last in `compact`'s `finally` (after its
`persist`, `:891-900`). Both are synchronous, and in the `finally` so a
throwing `turn_end` sink cannot skip it. It does nothing unless
`successor !== null && controller === null`. If `closed || successor.cancelled`
it calls `endUnstarted()`, otherwise `startSuccessor()`.
- `startSuccessor()` (no `await`, never throws out; emits wrapped like
  `prompt`'s, `:708-714`):
  1. `remaining = messages.filter(m => !isDelivered(m.id))`. `ours` = the set
     of their ids.
  2. `seed` = the leftover agent queue (`session.pendingSteering()` zipped
     with `steeringIds`) **minus** entries whose id is in `ours` (those are
     in the prompt). Id-less (resumed) and foreign entries are kept (D4), in
     order, followed by `successor.steers`. `steeringIds` = the matching ids.
  3. Every `messages[i].id` → `enqueued`. A late `session/enqueue` of the
     same id is now a no-op success (`:849-851`): never a false "not queued",
     never a double.
  4. Take the slot: `controller = new AbortController()`,
     `activeTurnId = successor.turnId`, `turns.set(turnId, {})`,
     `successor = null`.
  5. `emit({type:"turn_start", turnId, prompt})`, where
     `prompt = remaining.map(m => m.text).join("\n\n")` (D1). It is `""` when
     everything was injected meanwhile: a continuation turn
     (`agent/src/session.ts:66-69`, `:86-88`) answers the injected steers.
  6. `void this.drive(turnId, session.send(prompt, signal, {steering: seed, askHooksTrust}), controller)`,
     then `persist()`. Same order and comment as `prompt` (`:716-727`).
- `endUnstarted()`: `turns.set(turnId, {end: {stopReason:"cancelled"}})`,
  `successor = null`, emit `turn_end{turnId, stopReason:"cancelled"}` with
  **no** `turn_start`, then `persist`. Folded `steers` are **not** injected.
  This is an explicit wire contract, not a silent drop: *a `turn_end` whose
  turn never had a `turn_start` delivered nothing: neither its prompt nor any
  steer enqueued to it.* The client that owns the texts restores them (c puts
  them back in the input field). Re-queueing them daemon-side would be worse:
  with the slot free, the next `send`'s reset drops them anyway
  (`agent/src/session.ts:83-85`), without telling anyone.

**Other changes:**
- `enqueue(id, turnId, text)`: after the `enqueued.has(id)` check (`:849`),
  if `successor?.turnId === turnId`, push to `successor.steers` and add the id
  to `enqueued`. This covers the user typing after the key, whose texts bind
  to the new turn (client b). Enqueues for the old turn keep today's path
  while it unwinds. They are re-seeded by step 2, or, if their id is in
  `messages`, excluded there and delivered in the prompt.
- `cancel()` (`:928-930`): abort as today, and also set
  `successor.cancelled = true` when reserved. This covers Esc/Stop on any
  device and a model-proxy drop (`connection.ts:108-117`).
- `close()` (`:940-961`): after the active turn's `finishTurn` (whose
  `settleSuccessor` sees `closed`), call `endUnstarted()` if a reservation
  remains (the compaction case). That is before `session_closed`.
- `Connection` (`connection.ts:160-178`): `case Method.SendNow`, a handler
  shaped like `prompt` (`:309-319`). It calls `lookup` and passes the same
  `hooks/trust` asker.

**Not touched:** `persisted-session.ts` (no format change, no
`DAEMON_RECORD_VERSION` bump), the ring, the cut logic, `updates.ts`.

### Files

In dependency order:
1. `packages/protocol/src/session.ts`: the four schemas + types.
2. `packages/protocol/src/methods.ts`: `Method.SendNow`, the `RequestSchemas` entry. *(Task 1 conflict: an adjacent line.)*
3. `packages/agent/src/session.ts`: `SendOptions.steering`, the seed in place of the reset at `:85`.
4. `packages/daemon/src/hosted-session.ts`: mirror, `drained`/`restoredIds`, `successor`, `sendNow`, `settleSuccessor`/`startSuccessor`/`endUnstarted`, `enqueue`/`cancel`/`close`/`drive`/`prompt` edits. *(Task 1 conflict: `finishTurn` and `compact` `finally`.)*
5. `packages/daemon/src/connection.ts`: `case Method.SendNow` + handler. *(Task 1 conflict: an adjacent `case`.)*

### Failure modes

| Case | Convergence |
|---|---|
| Another client's `prompt`/`compact` between the cancel and the start | `TurnInProgress`/`CompactInProgress`: the aborted controller holds the slot until `finishTurn`, which hands it over in the same stretch (load-bearing assumption). T-A1. |
| Cancel takes long (a tool ignoring its signal, `agent.ts:756`) | The successor waits, as Esc does today. No new hazard. Retries get `{turnId}` (step 1). |
| Esc/Stop/model-proxy drop during the window | `successor.cancelled`, then `turn_end{cancelled}` for the successor with no `turn_start`. T-A8. |
| `close` during the window (turn or compaction) | Old `turn_end{cancelled}`, successor `turn_end{cancelled}`, then `session_closed`. Never a started successor on a closed session. T-A8. |
| Retry of `send_now` (lost response, reconnect) | Keyed: reserved → `{turnId}`. Started or ended → cached ack. After a daemon restart → step 5 against the restored state. |
| Daemon crash in the window | Nothing about the reservation is on disk (premise 2). The reload closes the old turn honestly (`persisted-session.ts:300-325`). The resent `send_now` runs step 5. Restored ids are delivered, so no duplicate. Never-accepted ids form the prompt. |
| Target ended naturally just before | Late drain injected all accepted steers (P2). Step 5 sends only the undelivered ones, or `NoTurnRunning` (nothing lost). T-A9. |
| Stale target (a different turn now runs) | Step 4 → `TurnInProgress`. A newer turn is never cancelled by an old intent. T-A9. |
| Our in-flight enqueue lands in the window | Accepted into the old queue. At hand-off its id ∈ `ours`, so it is excluded from the seed and delivered once in the prompt. After hand-off it is a no-op success. T-A5. |
| A message drained before the abort (any path, incl. `agent.ts:442`) | `drained` → excluded from the prompt. Already in history once. T-A3. |
| A foreign steer queued in the old turn (D4; task 6 makes it reachable) | Re-seeded, then drained at the successor's first boundary. T-A4. |
| Pending permission (D3a) | The abort settles it `cancelled` and streams `permission_resolved` (`hosted-session.ts:345-360`). The call is answered `CANCELLED_TOOL_NOTE`. The successor runs. T-A6. |
| Running hook (D3c of the eval: hook) | Killed by the signal (`hooks.ts`, via `env.exec`'s signal). The agent's post-hook abort checks end the turn (`agent.ts:546-550`). The successor's own `turn_start` hooks run on the joined prompt. |
| `/compact` (D3b) | `compact` rejects `Cancelled` to its requester (`hosted-session.ts:882-888`). History is untouched or fully replaced. The hand-off in `finally` starts the successor on whichever history. T-A7. |
| A `turn_end` sink throws | `settleSuccessor` is in `finally`, so it still runs. Its own emits are wrapped (`reportTurnError`). |
| Empty prompt after filtering | Continuation turn (`""`), no user message, and the injected steers get their answer. T-A3. |
| Version skew (old daemon) | `MethodNotFound`, handled client-side (b/c). |

### Tests

Red first, on the narrowest file. Use the in-memory daemon + raw
`client.request(…)` pattern and the "tool that blocks until released" fake of
the steering tests (`daemon/test/integration.test.ts:300-470`); match the
existing fakes. `SpyBroker` is for the permission case.

- `protocol/test/methods.test.ts` / `session.test.ts`: schema accepts a valid
  request. It rejects `messages: []`, a missing `interrupt`, and an empty
  `text`. An unknown extra field is stripped, not rejected.
- `agent` (session test): `send(text, signal, {steering:["S"]})` drains `"S"`
  at the first boundary. Without it the queue starts empty (no regression).
- `daemon/test/integration.test.ts` (new `describe("session/send_now")`):
  - **T-A1 atomicity (request level).** Turn T1 blocked in a tool. Client A
    sends `send_now{turnId:T2, interrupt:{turn:T1}, messages:[a:"A"]}` → ack.
    Client B sends `prompt{T3}` **before** the tool is released →
    `TurnInProgress`. After release, the stream is `turn_end{T1,cancelled}`
    immediately followed by `turn_start{T2,"A"}` with no update in between.
  - **T-A1b atomicity (microtask level).** A sink attached to the session
    records `hosted.running` in a `queueMicrotask` scheduled when it receives
    `turn_end{T1}`. The test asserts `true`.
  - T-A2 join/order: `[a:"A", b:"B"]` → one user message `"A\n\nB"`, and
    `turn_start.prompt` is equal.
  - T-A3 drained exclusion: `a` enqueued and drained at a boundary before
    `send_now` → prompt `"B"`, and the history has `"A"` once. All drained →
    `turn_start.prompt === ""` and no new user message.
  - T-A4 foreign steer (`enqueue{id:"x"}` not in `messages`) → the successor
    drains `"x"` at its first boundary (a `steer` update of T2).
  - T-A5 an enqueue of id `a` in the window → no double, and after the
    hand-off `enqueue{a}` is a no-op success. An enqueue to `turnId:T2` in the
    window → drained by T2.
  - T-A6 permission pending → `permission_resolved{cancelled}`, the cancelled
    tool note in history, then T2 runs.
  - T-A7 compaction blocked (a slow summarize fake) → `send_now{compaction}`
    → `compact` rejects `Cancelled`, history length unchanged, then T2 runs.
  - T-A8 `session/cancel` in the window → `turn_end{T2,cancelled}` and no
    `turn_start{T2}`, and an `enqueue{turnId:T2}` made in that window is
    never injected (the contract). `session/close` in the window → T1 end, T2 end, then
    `session_closed`.
  - T-A9 retries (`{turnId}` while reserved, cached `ended` after), step 4
    `TurnInProgress`, step 5 `NoTurnRunning` / plain start.
  - T-A10 (persistence, `daemon/test/persistence.test.ts`): with a persister,
    the record written by `finishTurn` in the window holds **no** key `T2`.
    A restart there plus a resent `send_now` starts T2 once, without a
    duplicated steer.
- **Mutations (non-vacuity, §9), each must turn a test red, then revert:**
  - M1: run `settleSuccessor` via `setTimeout(0)` → T-A1 fails.
  - M2: run it via `queueMicrotask` → T-A1b fails (T-A1 may not, which is why
    T-A1b exists).
  - M3: take the prompt from all `messages` (no `isDelivered` filter) → T-A3
    fails.
  - M4: `turns.set(T2)` at reservation → T-A10 fails.
- Gate before done: `bun run check` (typecheck → lint → test), lint baseline
  clean (§6).

## Execution

*— claude-opus-5-5, 2026-10-23*

**Baseline** (unchanged tree, branch @ `9e90468`, `bun run check`): typecheck
clean · lint `Checked 408 files … No fixes applied` · `2010 pass, 2 skip,
0 fail` (2012 tests, 168 files).

**Premises re-verified on `9e90468`** (task 1 `session/list` merged after the
plan). All hold. Lines moved: `prompt` `:708-757` (task 1 stamp `:736`, just
after `assertIdle` `:728`), `finishTurn` `:848-869` (stamp `:858`), `compact`
`:899-934` (stamp `:916` on success only), `cancel` `:960`, `close` `:972`,
constructor resume `:295-315`, `Connection.prompt` `connection.ts:313-324`.
The agent premises were unchanged (`session.ts:83-85` reset, `pendingSteering`,
every drain path yields one `steer` per text: `agent.ts:442,459,575,620,679`;
a tool that ignores its signal is awaited, `agent.ts:752-756`). New facts:
`SessionPersister` now writes `updatedAt = state.lastChangeAt`, and
`SessionHost.build` passes `restored` only when a persister is set
(`session-host.ts:302`).

**Repro (capability missing)**, before any edit:
```
$ rg -n 'send_now|sendNow|SendNow' packages --glob '!**/node_modules/**'
(no output, exit 1)
```

**As built, in the plan's order:**
1. `protocol/src/session.ts`: `SendNowTargetSchema`, `SendNowMessageSchema`,
   `SendNowParamsSchema` + types, and `type SendNowResult = PromptResult`.
   `methods.ts`: `Method.SendNow = "session/send_now"`, with
   `{params: SendNowParamsSchema, result: PromptResultSchema}`.
   `json-schema.test.ts`: two fixtures, union pin `4 → 5`.
   `schema/protocol.json` regenerated with `bun run schema:export`.
   `PROTOCOL_VERSION` stays 10.
2. `agent/src/session.ts`: `SendOptions.steering`. `send` seeds
   `this.steering = [...(opts.steering ?? [])]` in place of the reset.
3. `daemon/src/hosted-session.ts`: the `Successor` interface, plus
   `steeringIds`/`drained`/`restoredIds`/`successor` fields.
   `sendNow` is at `:801`. `isDelivered` `:845`, `settleSuccessor` `:855`,
   `startSuccessor` `:868`, `endUnstarted` `:924`. The mirror shift on
   `steer` in `drive` is at `:988`. `settleSuccessor()` is the last call in
   `finishTurn`'s `finally` (`:1053`) and in `compact`'s `finally` (`:1131`).
   `enqueue` has a successor branch and pushes the id (`:1063-1087`).
   `cancel` marks the successor (`:1159`). `close` calls `endUnstarted` before
   `session_closed` (`:1174`). `prompt` resets the mirror before `send`.
4. `daemon/src/connection.ts`: `case Method.SendNow` (`:175`) and
   `sendNow` (`:328`). The hooks-trust closure became one
   `askHooksTrust` field (`:333`), shared by `prompt` and `sendNow`.

**Tests**: `protocol/test/send-now.test.ts` (4),
`agent/test/session.test.ts` "steering seed" (3) and
`daemon/test/send-now.test.ts` (19: T-A1, T-A1b, 2× lastChangeAt, T-A2,
2× T-A3, T-A4–T-A7, 3× T-A8, 3× T-A9, a wire-errors case, T-A10).

**Red → green:**
- protocol, on `main`'s `protocol/src/{session,methods}.ts`: `0 pass, 4 fail`.
  All four fail on `expect(...).toBe` assertions. Green: `110 pass` (the
  protocol package).
- agent, before the seed: `8 pass, 1 fail` ("a seeded queue is drained…").
  Green: `9 pass`. The other two cases are regression guards.
- daemon, on `main`'s `hosted-session.ts` + `connection.ts` (new protocol
  kept): `0 pass, 19 fail`. The 2 wire cases fail on assertions. The 17
  direct-call cases fail with `TypeError: …sendNow is not a function`. The
  mutations below supply each property's non-vacuity. Green: `19 pass`.

**Mutations** (each applied, run, then the file restored by `cp` from a
backup and checked byte-identical with `cmp`, which gave no output):

| Mutation | Red |
|---|---|
| M1 `setTimeout(() => settleSuccessor(), 0)` in `finishTurn` | T-A1, T-A1b |
| M2 `queueMicrotask(() => settleSuccessor())` | T-A1b only |
| M3 `remaining = messages.filter(() => true)` | both T-A3, T-A9 "ended on its own", T-A10 |
| M4 `turns.set(turnId, {})` at the reservation | T-A10 |
| M5 drop the `lastChangeAt` stamp in `startSuccessor` | both lastChangeAt tests |
| M6 agent: keep `this.steering = []` | agent seed test, T-A4, T-A5 |

How the red runs were done: `git stash`/`git apply -R` need approval in this
session's permission mode. So `main`'s files were taken with
`git show main:<path> > .tentacle/tmp/send-now-a/main-*.ts` and copied over,
and my versions were restored from `mine-*.ts` and checked with `cmp`.

**Drift from Implementation (and why):**
- **The successor's start stamps `lastChangeAt`** (`this.now()`, just like
  `prompt`). This follows the owner's instruction for this run and replaces
  the plan's "the successor start does not stamp". Task 1's stamps are
  untouched. On a hand-off, `finishTurn` stamps T1's end and the successor
  then stamps T2's start, so the start is ≥ the end.
- **No `SendNowResultSchema` export.** `json-schema.test.ts` rejects "one
  schema under two export names", so `RequestSchemas` uses
  `PromptResultSchema` directly and only the type alias is exported.
- **`SendNowMessageSchema` fields are written out**
  (`z.string().min(1).max(128)`, `z.string().min(1)`) instead of
  `EnqueueParamsSchema.shape.*`. The constraints are the same. This avoids the
  "reused anonymous schema" rule of the JSON-Schema export.
- **Steers enqueued to the reserved successor stay memory-only.** Their ids
  enter `enqueued` only when the successor starts. The plan added them at
  `enqueue` time. But `enqueued` is persisted, so a crash or a cancel would
  have left an id that a retry treats as success while its text was never
  delivered. That is premise 2's reasoning, and it matches the `endUnstarted`
  contract: after a cancel, a retried `enqueue{y, T2}` gets an honest
  `NoTurnRunning` (tested in T-A8). Retries during the window are de-duplicated
  against `successor.steers` and `successor.messages`.
- `Successor` does not keep `interrupt`, because nothing reads it after the
  reservation.
- Step 4 uses `assertIdle`, so a compaction holding the slot gives
  `CompactInProgress`, not `TurnInProgress`.
- Step 5 starts through `settleSuccessor()`, so a closed session ends the
  successor unstarted.
- **T-A1 racer.** A wire `prompt` sent "before release" cannot detect M1. T-A1
  also arms a macrotask racer in a daemon-side sink on `turn_end{T1}`, the
  repo's "a timer stands in for the next transport message" pattern. T2
  blocks in the tool, so the racer meets it running.
- **Test placement.** All the daemon cases, T-A10 included, live in a new
  `daemon/test/send-now.test.ts` rather than `integration.test.ts` and
  `persistence.test.ts`, so they can be run narrowly. The T-A10 restart rig
  has a persister (see `session-host.ts:302` above).

**Gate after the change** (`bun run check`): typecheck clean · lint
`Checked 410 files … No fixes applied` (0 errors, 0 warnings) · `2036 pass,
2 skip, 0 fail` (2038 tests, 170 files). That is +26 tests, and the skips
are the same two opt-ins.

**Not verified / open:**
- No test covers a running *hook* killed by the cancel. The plan listed none,
  and the agent's existing hook-abort tests cover that path.
- A send-now whose target was already aborted (Esc first, still unwinding)
  is still accepted, and the successor starts. That is the plan's step 3 as
  written. Review should confirm it is the intended UX.

### Execution — follow-up (review fixes), 2026-10-23

*— claude-opus-5-5, 2026-10-23*

**Owner decisions recorded:**
- **F1:** when every text was already delivered but is still unanswered,
  `send_now` starts a continuation turn instead of refusing.
- **Esc, then `send_now`:** if the user pressed Esc and the turn is still
  cancelling, `send_now` still starts a new turn with the queued texts. The
  Review (finding 4) found this consistent with S1/S2, and the owner accepts
  it. No code change.

**F1 (`hosted-session.ts:834-846`, helper `awaitsAnswer` `:851`).**
"Unanswered" is defined exactly as follows. Walk the history back from its
end. If a `user` message whose content equals one of the caller's
**delivered** texts comes before any `assistant` message, the text is
unanswered. In other words, no assistant reply follows the caller's last
delivered text.

Step 5 (the slot is free) now behaves like this:
- Every text was delivered and is unanswered: the daemon starts the same
  continuation turn as step 3 (prompt `""`), through `settleSuccessor` →
  `startSuccessor`. That stamps `lastChangeAt` like a turn start.
- Every text was delivered and an assistant reply follows them:
  `NoTurnRunning`, as before. There is genuinely nothing to answer.
- Otherwise (some text undelivered): unchanged.

The contract text in `protocol/src/session.ts` (the `session/send_now` block
comment) now says this. `bun run schema:export` was re-run. It produced no
diff beyond the existing +89 lines, because the comment is not part of the
schema.

**F2.** New test F2 in `daemon/test/send-now.test.ts`, case ATK1:
1. "A" is drained at a boundary.
2. A foreign `x` and our `b` are queued.
3. `send_now[b]` gives prompt `"B"`, T2's only steer is `"X"`, and the
   history is `go, A, B, X`.

**New tests** (`daemon/test/send-now.test.ts`, +4, one per F1 path):
- **F1a, crash before the hand-off.** The record holds
  `turn{T1, steering:["A"]}`. After the reload the history is `go, A`. The
  resent `send_now[a]` acks, `lastChangeAt` is 600 (the clock at the
  start), the prompt is `""`, and the model's last message is "A".
- **F1b, the `max_iterations` final drain.** `maxIterations: 1`, and a steer
  is sent during the final report.
- **F1c, the `turn_start` hook stop drain.** The hook exits 2, and a steer
  is sent while the hook runs.

The test rig gained `maxIterations` and `hooks` options.

**Red → green:**
- F1a, F1b and F1c were red on the pre-fix code (`20 pass, 3 fail`, each
  `code: -32008`). Their setup assertions passed, so the reds come from the
  refusal itself. Green after the fix: `23 pass`.
- F2 is green on the real code, as expected, and red under R7.

**Mutations** (each applied with Edit, run on `send-now.test.ts` (M6 also on
the agent test), then restored by `cp` from a backup):

| Mutation | Red |
|---|---|
| R7 `steeringIds[0]` in place of `shift()` | F2 |
| M7 `awaitsAnswer` → `false` (the old rule) | F1a, F1b, F1c |
| M8 `awaitsAnswer` → `true` (never refuse) | T-A9 "ended on its own" (`NoTurnRunning` kept) |
| M1 `setTimeout` hand-off | T-A1, T-A1b |
| M2 `queueMicrotask` hand-off | T-A1b |
| M3 no `isDelivered` filter | both T-A3, T-A9, T-A10, F1a–c |
| M4 `turns.set` at reservation | T-A10 |
| M5 no start stamp | both lastChangeAt tests, F1a |
| M6 agent keeps the reset | agent seed test, T-A4, T-A5, F2 |

The tree was **byte-identical** after the mutations. `git status --short` and
the `shasum` of all 11 changed or untracked files were diffed before and
after (`.tentacle/tmp/send-now-a/{status,sha}-{before,after}.txt`). Both
diffs were empty.

**D1-order note (Review nit 3, documented only, no code).** Take a crash
while T1 is suspended on a *resumable* permission. The reload re-seeds T1's
steers without ids (`hosted-session.ts:326-329`). A resent
`send_now[a (enqueued), b]` then leaves `a` out of the prompt (it is in
`restoredIds`) and re-seeds "A" as a steer. So the prompt is `"B"`, and "A"
is drained after the turn starts, which inverts the D1 order. Nothing is
lost or duplicated. Keeping the order would need persisted steer ids, which
means a `DAEMON_RECORD_VERSION` bump (premise 3). That is not worth it for a
crash-only edge.

**Drift:** none from the fix requests. One limit of the F1 rule: it matches
by **text content**, because ids are not in the history. If an identical
text is in the history from an earlier exchange and has an assistant reply
after it, the walk stops at that reply. So the rule can only answer "already
answered", which keeps today's `NoTurnRunning`. It never starts a spurious
turn.

**Gate** (`bun run check`): typecheck clean · lint `Checked 410 files … No
fixes applied` · `2040 pass, 2 skip, 0 fail` (2042 tests, 170 files). That
is +4 against 2036/2/0, with the same opt-in skips.

### Execution — follow-up 2 (structural unanswered rule), 2026-10-23

*— claude-opus-5-5, 2026-10-23*

**Context.** The round-2 review was stopped by the orchestrator before it
wrote anything. The tree was checked before any edit:
- `git status --short` and the `shasum` of all 11 changed or untracked
  files matched my last snapshot (`sha-after.txt`). The only difference was
  this doc, where I had appended follow-up 1 after taking that snapshot.
- The doc ended with the first Review only, so no temporary mutation was
  left behind.
- `bun run check` gave `2040 pass, 2 skip, 0 fail`, lint clean.

**Owner decision (2026-10-23).** The text-matching `awaitsAnswer` of
follow-up 1 is **replaced** by a structural rule. Text identity is only a
heuristic: texts repeat, another client can type the same one, compaction
rewrites them, and `ChatMessage` carries no id (`core/src/model.ts:27`).

**Rule** (`hosted-session.ts` `awaitsAnswer()`, no parameters, O(1), no
persisted data). It applies when every caller text was delivered. The
history awaits an answer if and only if:
- its last message has `role: "user"`, whoever wrote it, **and**
- that message is not the lone non-system message of the history, which is
  what a compaction summary is.

If it awaits an answer, the daemon starts a continuation turn (prompt `""`).
Otherwise it answers `NoTurnRunning`. The contract text in
`protocol/src/session.ts` was updated. `bun run schema:export` left
`protocol.json` identical (same `shasum`): the comment is not in the schema.

**How each history ends, verified against the code, and what it resolves to:**

| Case | History ends with | Result |
|---|---|---|
| Crash before the hand-off, reload | `user`: the cut-short turn's steering is pushed last (`persisted-session.ts:329-331`) | continuation (F1a) |
| `max_iterations` final drain | `user` (`agent.ts:679-681`, then `turn_end`) | continuation (F1b) |
| `turn_start` hook stop | `user`: the hook note, then the drained steers (`agent.ts:434-446`) | continuation (F1c) |
| Successful compaction | `user` summary (`compact.ts:239-242`) as the lone non-system message | `NoTurnRunning`, no spurious turn (S3) |
| Compaction with kept skills | `tool` (`compact.ts:243-246`) | `NoTurnRunning` |
| Turn cancelled after a tool ran | `tool` (loop-top abort after the result push) | `NoTurnRunning` (S4) |
| Normal end | `assistant` | `NoTurnRunning` (T-A9) |
| `system` only, or empty (`startConversation`, `agent.ts:264-266`) | not `user` | `NoTurnRunning` |

The `tool` cases are decided explicitly. A trailing `tool` message means the
turn was cancelled after a tool ran: the user chose to stop it, and the
model had already seen the drained texts. So only `user` counts.

A turn stopped by a hook with no steer ends with the hook's note, a `user`
message. A send-now whose texts were all delivered then starts a
continuation. That is accepted under "whoever wrote it".

Known gap of the positional summary check: on a fresh history (no prior
user message), a continuation turn whose only content is one drained steer
with no reply would also look like a lone summary. That case gets
`NoTurnRunning`. It is unreachable in practice (it needs a `""` turn on an
empty conversation) and costs nothing, because the text is already in the
history.

**Tests** (`daemon/test/send-now.test.ts`, new describe, +4):
- **S1:** our text is answered, then another client's *different* text sits
  unanswered at the tail. Result: continuation.
- **S2:** the *same* text "A" is answered, then delivered again unanswered.
  Result: continuation; once that is answered, `NoTurnRunning`.
- **S3:** right after a compaction. Result: `NoTurnRunning`.
- **S4:** cancelled mid-tool, so the history ends with `tool`. Result:
  `NoTurnRunning`.

The rig gained a `stoppingHooks` helper (hook run *n* waits for the test,
then exits 2).

**Red → green.** On the old text rule: `26 pass, 1 fail`. S1 was red with
`code: -32008`. Green after the change: `27 pass` (F1a–c still green).

**Drift.** The old rule got S2 right in both halves: a repeated text at the
tail is matched, and a reply after it stops the walk. A duplicate-text case
that the old rule gets *wrong* needs the unanswered tail to be a text that
is not one of the caller's. That is S1, which was red. S2, S3 and S4 pass on
the old rule. Their non-vacuity comes from the mutations below.

**Mutations** (`awaitsAnswer`, each applied with Edit and restored by `cp`
from a backup):

| Mutation | Red |
|---|---|
| W1 wrong message: `history[0]` | T-A9, S2, S4 |
| W1′ wrong message: `history.at(-2)` | T-A9, F1a, F1b, S2 |
| W2 always `true` | T-A9, S2, S3, S4 |
| W3 always `false` | F1a, F1b, F1c, S1, S2 |
| W4 no summary exception | S3 |
| W5 `role !== "assistant"` (a `tool` tail counts) | S4 |

The tree was **byte-identical** afterwards. `git status --short` and the
`shasum` of all 11 files were diffed against snapshots taken before the
mutations (`.tentacle/tmp/send-now-a/{status3,sha3}-{before,after}.txt`).
Both diffs were empty. M1–M8 and R7 were not re-run: this change touches
only `awaitsAnswer`, its call site and a comment.

**Gate** (`bun run check`): typecheck clean · lint `Checked 410 files … No
fixes applied` · `2044 pass, 2 skip, 0 fail` (2046 tests, 170 files). That
is +4 against 2040/2/0, with the same opt-in skips. The first gate run
failed on Biome formatting in the new tests: three long `expectRpc` lines.
I wrapped them by hand, and the next run was clean.

### Execution — follow-up 3 (summary marker), 2026-10-23

*— claude-opus-5-5, 2026-10-23*

**Finding (orchestrator).** Follow-up 2 recognised the compaction summary by
its position. But `[system?, user(summary)]` (`compact.ts:228-249`) is also
the shape of a first turn, so the position check is a heuristic too.

**Reachability, checked against the code.** A first turn that is stopped by
its `turn_start` hook never has that bare shape: the hook pushes its note
(`agent.ts:434-436`). The shape does occur when the session's first turn is
itself a send-now (prompt "A" = our message `a`) and gets no reply:
- the turn is cancelled before the model replies (a mid-stream abort pushes
  no partial reply), or
- the daemon crashes before the reply. The record has `turn{T1}` and no
  calls, so the reload appends nothing.

**Side bug found and fixed.** The ids that went into a send-now *prompt*
were added to `enqueued` but were never treated as delivered in memory
(`isDelivered` = `drained` ∪ `restoredIds`). So a second send-now with a new
`turnId` re-sent "A" as a prompt, a duplicate. Fix: `startSuccessor` adds
`ours` to `drained` ("in the prompt = in the history").

**Design.** No persisted field and no text or prefix matching.
- `HostedSession.compactionSummary` holds the summary message **object** the
  session installed. `historyReplaced()` sets it to the first `user` message
  of the new history, which is the summary by `compactedHistory`'s
  construction.
- `awaitsAnswer()` is `last.role === "user" && last !== compactionSummary`,
  an identity check. It needs no clearing: any later message replaces the
  tail.
- **Reload** (identity lost). The in-memory `RestoredSessionState` gains
  `cutShort`, set by `SessionHost.restore` to `record.turn !== undefined`.
  This is not a record field. Only for an **idle** record (`!cutShort`)
  whose history is a lone user message after the system prompt does the
  constructor set the marker on that message.

**Reload decision.** An idle `[system?, user]` record is either just
compacted or a first turn that ended (cancelled or errored) with no reply,
and the two cannot be told apart without a persisted marker. The options:
- *Spurious continuation:* an unasked model turn that can **run tools**.
- *`NoTurnRunning`:* nothing happens. The text is already in the history,
  so the next normal prompt gets it answered (re-sending the same text would
  put it in the history twice). *(Wording corrected by the orchestrator per
  Review round 2, nit 2.)*

**Decided: `NoTurnRunning`.** An unrequested agent run is worse than
silence. A record cut short mid-turn (`cutShort`) is never read as a
summary, so a crash before the first reply continues, as F1 requires.
Making this exact would need a persisted marker, which is a record-format
change. Not done.

**Tests** (`daemon/test/send-now.test.ts`, +5). The rig gained a
`systemPrompt` option, and `persistence.test.ts:579` (a hand-built
`RestoredSessionState` for a resumed turn) gained `cutShort: true`.
- **U1:** a first send-now turn stopped by its hook (`[A, note]`). The
  resent send-now gives a continuation with a single "A" in the history.
- **U2:** a first send-now turn cancelled before any reply (`[A]`).
  Result: continuation.
- **U3:** a crash before the first reply, then a reload
  (`[system, user]`, `cutShort`). Result: continuation.
- **U4:** a compaction, then a later hook-stopped turn with an unanswered
  "X" tail. Result: continuation.
- **U5:** a reload of a just-compacted record (`[system, user]`, idle).
  Result: `NoTurnRunning`, and the model is never called.
- **S3** (just compacted, in memory → `NoTurnRunning`) still passes.

**Red on the pre-fix code** (`28 pass, 4 fail`):
- U1 and U2 failed on `prompt` (the duplicate "A").
- U3 failed with `code: -32008`, the position rule.
- U4 first failed on a test bug: I had assumed hook run 3, but compaction
  runs no `turn_start` hook, so T2 is run 2. After the fix it passes on the
  pre-fix code, and X2 pins it.
- U5 passes on the pre-fix code, as expected (the position rule refused
  there too), and X3′ pins it.

Green after the change: all 32 tests in `send-now.test.ts`, and the daemon
package at `258 pass`.

**Mutations** (each applied with Edit and restored by `cp` from a backup):

| Mutation | Red |
|---|---|
| X1 drop the marker check (`last.role === "user"`) | S3, U5 |
| X2 marker "never cleared" (any user tail after a compaction reads as the summary: `compactionSummary === undefined`) | U4 |
| X3 the reload marker ignores `cutShort` | U3 |
| X3′ no marker on reload | U5 |
| X4 drop the `drained.add(ours)` fix | U1, U2 |

The tree was **byte-identical** afterwards. `git status --short` and the
`shasum` of 12 files (`session-host.ts` included) were diffed against
snapshots taken before the mutations
(`.tentacle/tmp/send-now-a/{status4,sha4}-{before,after}.txt`). Both diffs
were empty. The protocol contract text ("a compaction summary alone does
not count") is still accurate, so it was not changed. The JSON Schema is
not affected.

**Drift.** `session-host.ts` (one line) and `persistence.test.ts` (one
line) were touched; neither was named in the plan. The side-bug fix is
outside the orchestrator's request, but U1 and U2 need it. The "hook stop
on the very first prompt" case is red because of the side bug, not the
position rule: that shape is never `[user]` alone.

**Gate** (`bun run check`): typecheck clean · lint `Checked 410 files … No
fixes applied` · `2049 pass, 2 skip, 0 fail` (2051 tests, 170 files). That
is +5 against 2044/2/0. Two earlier gate runs failed:
- `tsc`, on the missing `cutShort` in the hand-built test state;
- Biome, which asked for single quotes in one test name.

Both were fixed by hand.

## Review

*— claude-opus-5-5, 2026-10-23. Same model family as the planner and the
executor (a fresh context on a different account only): shared blind spots
can survive both passes. For a `load-bearing` task AGENTS §10 prefers a
different model as well.*

**Verdict: REQUEST-CHANGES.** Two small changes are needed: F1 (a behaviour
fix, or an explicit owner decision) and F2 (a missing test). The hand-off
itself holds: atomicity, the steering window, persistence, D4 and
idempotency. I found no §7 violation.

### Findings

1. **F1: step 5 `NoTurnRunning` treats "in the history" as "answered".**
   (`daemon/src/hosted-session.ts:834-838`, protocol comment
   `protocol/src/session.ts:333-335`.) The hand-off path (step 3) runs a
   continuation turn (`""`) when every text was already injected, so the
   model answers them. Step 5 (slot free) instead refuses `NoTurnRunning`,
   and the contract tells the client to stay silent. That is right only if
   the old turn's drain was followed by a model round. Three paths inject a
   text with **no** model round after it:
   - (a) a crash **before** the hand-off. Reproduced (ATK5): a record holding
     `turn{T1, steering:["A"]}` reloads as `…, tool: Interrupted…, user: "A"`,
     and the resent `send_now[a]` gets `-32008` with `running: false`. "A" sits
     unanswered, and the client was told "nothing to send".
   - (b) the `max_iterations` late drain (`agent/src/agent.ts:674-682`, "no
     round is left to answer it").
   - (c) the `turn_start`-hook stop drain (`agent.ts:437-446`, "gets NO model
     round").

   The user pressed "send now" and nothing answers them. No data is lost (the
   text is in the history), but an explicit intent turns into silence. Fix
   options: (i) in step 5, when every text is delivered, start the same
   continuation turn as step 3 (one rule for both paths); or (ii) refuse
   `NoTurnRunning` only when the history ends with an assistant reply after
   those texts. Either way, add a test for (a). If the owner prefers today's
   behaviour, record that decision in the doc and in the protocol comment.
   The Implementation's failure-mode row "Daemon crash in the window" covers
   only the post-hand-off record (T-A10), not the pre-hand-off one.
2. **F2: the id mirror's alignment is not pinned (§9).**
   (`hosted-session.ts:986-992`, consumed at `:878-886`.) Mutation R7 (in
   `drive`, `steeringIds[0]` in place of `shift()`, so the mirror never
   advances) leaves **all 19** `send-now.test.ts` cases green. It turns red
   only with my scratch case ATK1: drain `a` at a boundary, then enqueue
   `b`, then `send_now[b]`. With R7 the stale head `a` is zipped against the
   pending "B", "B" is re-seeded, and it is delivered twice. Every existing
   case has at most one drain before the hand-off, or no pending entry after
   a drain. The mirror is what makes D4 and the dedup correct, so pin it: add
   ATK1 (one drained entry followed by one pending entry of ours, plus
   ideally one foreign entry) to `daemon/test/send-now.test.ts`.
3. **Nit, reasoned, not run: D1 order across a resumed turn.** After a crash
   while T1 was suspended on a *resumable* permission, the reload re-seeds
   T1's steers id-less (`hosted-session.ts:326-329`). A resent
   `send_now[a(enqueued), b]` then excludes `a` (it is in `restoredIds`) and
   re-seeds "A" as a steer. The prompt is "B", and "A" is drained after the
   first round. Nothing is lost or duplicated, but the D1 order is inverted.
   This is a crash-only edge: document it, or leave it.
4. **Executor's owner question (Esc, then send_now while T1 unwinds),
   observed in ATK2:** the call is acked, and T2 starts with prompt "A".
   That **matches S1/S2**. S1 is "cancel the whole turn, then start the
   queued texts". A turn that is already cancelling simply skips the first
   half. D2 covers only an empty queue. The result is also what the S2
   fallback (cancel → wait for `turn_end` → send) produces. The reverse order
   (send_now, then Esc) cancels the successor (T-A8), so the last intent wins
   both ways. What remains is TUI UX: whether Esc keeps the rows is task c's
   call. This is not a defect of a.

### Gate (re-run by the reviewer, tree as delivered)

`bun run check`: typecheck clean · `biome check .` "Checked 410 files … No
fixes applied" · **2036 pass, 2 skip, 0 fail, 7617 expect() calls, 2038
tests across 170 files**. This matches Execution exactly. The 2 skips are
the opt-in live-k8s and slow-keepalive tests.

### Mutation non-vacuity (reviewer's own, `hosted-session.ts`)

Each mutation was applied by a script from a backup and then run against
`packages/daemon/test/send-now.test.ts`. The file was restored after each
and checked with `cmp` against the backup.

| Mutation | Result |
|---|---|
| R1 `queueMicrotask(() => settleSuccessor())` in `finishTurn` | red: T-A1b |
| R2 keep our ids in the seed (`ours` exclusion off) | red: T-A5 |
| R3 `cancel()` does not mark the successor | red: T-A8 cancel |
| R4 successor steers go into `enqueued` at `enqueue` (the plan's original) | red: T-A8 cancel (the retry gets a fake success) |
| R5 `interrupt.turnId` ignored (cancel whatever runs) | red: T-A9 stale target |
| R6 `close()` skips `endUnstarted` | red: T-A8 close during compaction |
| R7 the mirror never shifts (`steeringIds[0]`) | **green, 19/19 → F2**. Red only with scratch ATK1 |

**Tree byte-identical** after all mutations: the `git status --short` output
and the `shasum` of every modified and untracked file were diffed
before/after, and both diffs were empty. The executor's M1–M6 were not
re-run; R1–R6 independently cover the same properties.

### Premise table

| # | Premise (as cited) | Verdict |
|---|---|---|
| 0 | Context symptom: no `send_now` on `main` | TRUE: Execution's `rg` is empty on `main`'s sources, and every hit in the tree is this diff. |
| P1 | Concurrent dispatch, `void this.handleRequest` (`transport/src/peer.ts:322`). The handler is reached with no `await` before it, and an unknown method gets `MethodNotFound` (`:333-335`) | TRUE. The new handler is synchronous to its ack (`connection.ts:328-331`). |
| P2 | Steering no-await window. `finishTurn` is synchronous, and `settleSuccessor`/`startSuccessor` contain no `await` (`void this.drive`) | TRUE (read, and R1 shows the microtask test bites). |
| P3 | One `steer` per drained text, in order, on every drain path (`agent.ts:442-444` …) | TRUE for the paths I read (`:442`, `:679`). The mirror relies on it, and F2 is about pinning it. |
| P4 | `Session.send` resets the queue, and `resume` keeps it (`agent/src/session.ts:89-91`, `:121-128`) | TRUE. The seed replaces the reset, so callers that pass nothing see no change (agent test 2). |
| P5 | Cancel keeps history valid; a pending ask settles `cancelled` | TRUE as exercised by T-A6/T-A7 (I did not re-read every agent line). |
| P6 | Old generator teardown is inert: `send`'s `finally` only persists | TRUE (`session.ts:100-104`). The new `send` sets `steering` synchronously inside `drive`'s first `next()`, so no enqueue can land between the seed and the start. |
| Prem. 2 | The persister captures synchronously, so a reserved key would dangle | TRUE (`session-persister.ts:84`, `build()` at `schedule`). The reservation is memory-only, `turns.set` is at `:916`, and T-A10/M4 pin it. |
| Prem. 4 | Hooks-trust asker | TRUE. One `askHooksTrust` field is shared by `prompt` and `sendNow` (`connection.ts:333-336`). |
| Reload | A cut-short turn's steering is appended as user messages (`persisted-session.ts:329-331`) | TRUE, which is exactly what makes F1(a) reachable. |

### Attacks tried

1. **Atomicity, wire level plus macrotask racer** (T-A1, re-read): another
   client's `prompt` gets `TurnInProgress` before and at the hand-off, and
   `turn_end{T1}` is immediately followed by `turn_start{T2}`. **Holds.**
   R1 shows the microtask case is pinned.
2. **D4 + idempotency end to end over two real `Connection`s** (ATK4):
   A enqueues `a1`, B enqueues `x`, A enqueues `a2`. A sends
   `send_now[a1,a2]`, and B resends the identical request while it is
   reserved. Results: ack `{T2}`, retry `{T2}`, a post-end retry
   `{T2, ended:end_turn}`. B's stream is `turn_end T1 cancelled` →
   `turn_start T2 "A1\n\nA2"` → `steer "X"` → `turn_end T2`. The history is
   `go, "A1\n\nA2", X`. **Holds.** Only the caller's texts are in the prompt,
   and the foreign steer stays queued for T2.
3. **Mirror alignment** (ATK1): passes on the real code, and catches R7,
   which the delivered suite misses → **F2**.
4. **Crash before the hand-off + resend** (ATK5): no duplicate and no lost
   text, but no answer either → **F1(a)**.
5. **Esc then send_now** (ATK2) and **Esc, T1 fully ended with an
   undrained `a`, then send_now[a]** (ATK3; step 5 starts "A" because `a`
   was never drained): **both hold.**
6. **Persistence at every point of the hand-off**, by reading:
   - reserve: nothing written;
   - `finishTurn`: a record with T1 ended, no `turn`, no T2;
   - `startSuccessor`: the T2 key, `turn` and prompt in one record.

   Async saves can only leave record 2 or record 3 on disk. Record 2 is
   T-A10, and record 1 (before the hand-off) is ATK5. A `close` during the
   window ends T2 unstarted. `persist()` is a no-op once `closed`, and the
   file is removed by the host. **Holds.**
7. **Don't-serialize-the-peer:** no lock or `await` was added to any
   `Connection` handler. **Holds.**
8. **Protocol both ends / forward compat:** strip schemas (an unknown field
   is stripped, protocol test). JSON Schema fixtures were added and the
   union pin moved 4→5. An old daemon answers `MethodNotFound` (P1). No new
   update kind, so `UPDATE_CLASS` is untouched. `PROTOCOL_VERSION` stays 10:
   an additive method, per §7. **Holds.** The client end is task b, so
   nothing calls it yet, as scoped.
9. **Prior art** (`TODO.md`, `docs/fix`, `docs/eval`,
   `docs/library-bugs.md`): nothing is open on these symbols beyond the
   parent eval.

### What holds

The load-bearing assumption is held and pinned: a single synchronous
hand-off from `finishTurn`/`compact`'s `finally`. The reservation is
memory-only. The `endUnstarted` wire contract (a `turn_end` with no
`turn_start` delivered nothing) is consistent with the executor's drift of
keeping successor steers out of `enqueued`, a drift that R4 proves was
right. Close and cancel converge, a stale target is never cancelled,
`lastChangeAt` is stamped on the successor's start, and the gate is green.

### How the executor behaved

The executor re-verified the premises after task 1 merged and recorded the
line drift. Every drift from the plan is listed with its reason, and the
riskiest one (successor steers stay memory-only) is the correct one. The
red runs and the M1–M6 mutations were documented and reproducible. The
executor flagged the Esc question instead of deciding it. Two misses:
- **F2 (vacuity):** the executor did not mutate the mirror itself, so a
  core property went unpinned.
- **F1:** the "all delivered ⇒ nothing to send" rule was carried over from
  the plan without checking the drain paths that get no model round.

Neither was overstated in Execution. Both were simply not examined.

### Review — round 2

*— claude-opus-5-5, 2026-10-23. Same model family as the executor, in a
fresh context on a different account. Shared blind spots can survive both
passes.*

**Verdict: APPROVE-WITH-NITS.** F1 and F2 are fixed and pinned. The
structural rule and the summary marker hold against every attack I tried.
The collateral delivered-ids fix is correct. What remains is wording only.

#### Findings

1. **Nit: the reload exception is missing from the contract text**
   (`protocol/src/session.ts:333-338`). The comment says an unanswered
   `user` tail gets a continuation and only "a compaction summary alone"
   does not count. After a reload, though, an idle `[system?, user]` record
   is read as a summary (`hosted-session.ts:298-309`). So a first turn that
   got no reply and then saw a restart answers `NoTurnRunning` while its text
   is unanswered. That is the owner's decision (better silence than an
   unrequested turn that can run tools), and it is not a silent drop: the
   text is in the history, the client gets an error code, and a correct
   client (b/c) clears its rows at `turn_start`, so it never resends
   already-started ids under a new `turnId`. But a client reading the
   contract cannot know this exception exists. Add one clause to the
   comment.
2. **Nit: misleading wording in Execution follow-up 3.** It says "the client
   can send it as a normal prompt". In the case above that would put the
   text into the history a second time. The accurate statement is that the
   text is already in the history, and a normal prompt will get it
   answered.

#### Gate (re-run)

`bun run check`: typecheck clean · Biome "Checked 410 files … No fixes
applied" · **2049 pass, 2 skip, 0 fail, 7688 expect() calls, 2051 tests
across 170 files**. This matches the executor's numbers. The 2 skips are
the opt-ins.

#### Mutations (reviewer's own, applied with Edit and reverted by hand)

| Mutation | Red |
|---|---|
| R7 the mirror never shifts (`steeringIds[0]`) | **F2** (it was green in round 1, so finding 2 of round 1 is fixed) |
| R1 hand-off via `queueMicrotask` + R2 our ids kept in the seed + R3 `cancel` does not mark the successor | T-A1b, T-A5, T-A8 cancel (plus F2) |
| R4 successor steers go into `enqueued` + R5 `interrupt.turnId` ignored + R6 `close` skips `endUnstarted` | T-A8 cancel, T-A8 close during compaction, T-A9 stale target |
| K1 the marker is never set (`compactionSummary = undefined` in `historyReplaced`) + K2 drop `drained.add(ours)` | S3 (K1); U1, U2 (K2) |
| K3 the reload marker ignores `cutShort` | U3 |
| K4 no reload marker at all | U5 |
| K5 `session-host.ts`: `cutShort: false` | U3 |

R1–R3 and R4–R6 were run as combined batches. In each batch every
mutation's round-1 killer test went red, and the tests involved are
independent of each other. **Tree byte-identical** afterwards: the
`git status --short` output was the same before and after, and the
`shasum` of all 12 changed code files matched the pre-mutation snapshot
line for line. `hosted-session.ts` was also checked with `cmp` against a
backup.

#### F1 verified

- **The three paths continue.** F1a (crash before the hand-off, reload with
  `cutShort`), F1b (`max_iterations` drain) and F1c (hook stop) are green.
- **`lastChangeAt` is stamped** at the continuation's start (F1a asserts
  `600`). I did not re-run a mutation of the stamp myself; the executor's
  M5 covers it.
- **Contract text** matches the in-memory behaviour, except for the reload
  clause (finding 1).

#### Attacks tried

1. **Can the marker go stale, so a later unanswered tail reads as the
   summary?** The marker is an object identity, so it can only match while
   the summary object is the tail itself. After a compaction, every
   history change appends: steers, drains, prompts, hook notes and the
   `CONTINUE_NUDGE`. The only removals are:
   - `agent.ts:588`, which pops the empty assistant message that same
     round pushed, so the tail goes back to that turn's own `user`/`tool`
     message, never the summary (a `""` turn on a bare summary is exactly
     what `awaitsAnswer` refuses);
   - `session.ts:164` (`length = 0`), which runs only inside `compact`, and
     there `historyReplaced` sets the marker again.

   A failed or cancelled compaction never calls `historyReplaced`, so the
   old marker stays, but it is not the tail and cannot match. A second
   compaction replaces the marker. The daemon has no `/retry` that rewrites
   the history (grep). **Holds.** U4 pins "an unanswered tail after a
   compaction continues", and K1 pins S3.
2. **Is a message's identity stable?** `Session.messages` is reassigned
   only in the constructor (`session.ts:53`). Snapshots and persistence copy
   the array (`[...messages]`), never the objects. **Holds.**
3. **Other tails.**
   - Another client's text at the tail: continuation, whoever wrote it
     (S1). That is harmless, because the tail is genuinely unanswered.
   - A `CONTINUE_NUDGE` or hook-note tail: also a continuation. That is
     benign, and the executor named it.
   - A `tool` tail: `NoTurnRunning` (S4). This was decided explicitly: the
     model had already seen the drained texts.
   - A `system`-only or empty history: `NoTurnRunning`.

   No path starts a turn over an `assistant` tail, so no spurious turn ever
   runs over a finished exchange.
4. **The reload choice** (§8 "silent drop?"): see finding 1. It is honest,
   because the text is in the history and the client gets an error code.
   It is not documented in the contract. Reachable only by a client that
   resends already-started ids under a new `turnId` after a restart. A
   crash *during* a compaction writes an idle record (`persistedState` omits
   `turn` while `compacting`), so it falls in the same ambiguous class and
   resolves the same way.
5. **Collateral fix (`drained.add(ours)`, `hosted-session.ts:929-932`).**
   - It adds only the caller's own ids, so D4 holds: another client's
     ids and steers are untouched.
   - A same-`turnId` retry is the cached ack, as before.
   - A new-`turnId` resend of the same ids is now a continuation or
     `NoTurnRunning` (U1, U2, K2), never a second copy of "A".
   - An unstarted successor (`endUnstarted`) adds nothing, so the
     client's restore stays valid.

   **Holds.**
6. **Round-1 owner items are recorded in Execution follow-up 1.** The
   Esc→send_now owner decision is accepted with no code change. The D1-order
   note is documented, with the reason it is not fixed: it would need a
   `DAEMON_RECORD_VERSION` bump.

#### How the executor behaved

The executor went through three follow-ups, each with red-before-green
runs, its own mutation tables, and byte-identical checks of the tree. When
the orchestrator pushed back on text matching and then on the positional
heuristic, the executor replaced each one cleanly instead of patching it.
It found and fixed a real side bug (a duplicate "A" on a second send-now)
and declared it as drift. It also stated the remaining reload ambiguity
openly instead of hiding it. Two things are still missing: the contract
comment does not mention the reload exception, and one sentence in the doc
is loosely worded.
