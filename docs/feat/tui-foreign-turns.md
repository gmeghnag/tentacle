# feat/tui-foreign-turns — the TUI renders foreign turns; eager open with full history

> **Status:** done — reviewed (APPROVE-WITH-NITS), owner merge OK 2026-10-25; F1 carried to task 7. Re-planned 2026-10-25 against `main` `efc2e28`; APPROVED (2026-10-24 as ONE task; re-plan QR1–QR4 answered by the owner 2026-10-25, see the end)
> **Branch:** `feat/tui-foreign-turns` (one branch; steps A → B → C below are the implementation order inside it)
> **Type:** feat · **Size:** L · **Blast:** load-bearing (protocol `session/cancel`, the daemon's cancel, the `RemoteSession` stream routing = the one TUI-over-RPC session path, the permission path to the single broker, the `App.tsx` turn loop and key handler) · **Suited:** strong model executes; mandatory fresh-context Review that red-teams AGENTS §7 "TUI always over RPC — one session path", "Single-broker invariant", "Protocol", and the task 5 queue contract *(re-plan 2026-10-25)*

Parent: `docs/eval/mobile-app.md` decision 21 row 6 (L · load-bearing), decisions
4 (leaving detaches), 5 (every client is a view of the SESSION), 15 (writing
while a turn runs = exactly the TUI). Answers `docs/eval/session-handoff.md`
Q3 (eager open), Q4 (foreign turns), Q5 (prompts on every device), gaps G3/G4.
Builds on (all merged, re-plan 2026-10-25): 4c/4d send-now
(`docs/feat/send-now-c.md`, `send-now-d.md`), 2a `session-archive`, 3
`session-titles`, 5 `queued-broadcast` (`docs/feat/queued-broadcast.md`:
`session/reclaim`, rows back to the writer, steer row ids, protocol 11, record
v4), `tui-spill-note` (record v5, `spill` on tool messages). Followed by task 7
(`connect` lifecycle: quit detaches, `--resume` / `/sessions` — the callers of
this task's eager open).

## Context

*— claude-opus-5-5, 2026-10-24; refreshed (re-plan 2026-10-25)*

**Why.** Decision 5: "a turn started on any device renders live on every
attached device exactly like an own turn", and "opening an existing session
shows its full history at once, then live updates". Today the TUI is a view of
**its own requests**, not of the session. Re-checked on `efc2e28`
*(re-plan 2026-10-25)*:

- `RemoteSession` opens lazily on the first `send`
  (`client/src/remote-session.ts:470-484`, inside `runTurn`); nothing is shown
  of an existing session before the user types.
- Its `output()` drops everything while no own turn runs:
  `return; // idle: a turn started elsewhere is not rendered (known limit)`
  (`remote-session.ts:570-578`; only an `unsupported` notice is kept).
- The App's only event sources are the generators of its own `send` and
  `sendNow`, both consumed by `streamTurn` (`tui/src/App.tsx:747-828`; `run`
  `:831-872`; send-now `:891-1031`). Its busy state (`running`), Esc / Ctrl+C
  (`abortRef` `:355`, keys `:1432-1442`, `:1458-1469`, `:1505-1509`) and
  steering (`:1287-1309`) exist only for own turns.
- The TUI's queued rows are still its own (`tui/src/queued.ts`): task 5 kept
  the switch to the daemon's list for this task (`queued-broadcast.md:436-438`,
  `:879-882`; owner, `mobile-app.md:477-478`).
- **The latent routing bug is still there, and reproduced** *(re-plan
  2026-10-25)*. While an own turn is active, `output()` hands every update to
  `this.active` (`remote-session.ts:570`, `:596-598`), and `onUpdate` pushes
  every turn-scoped update into that turn's queue (`:706-713`). Only
  `turn_start` / `turn_end` are checked by id (`:674-694`). So an own prompt
  that loses the slot (`TurnInProgress`, `daemon/src/hosted-session.ts:1169-1175`)
  shows the OTHER turn's output as its own until its rejection lands. Repro
  below: 8 of A's chunks rendered as B's turn. Reachable as soon as a second
  client attaches to a session (task 7's `connect --resume`, task 12's phone).

What already works and is kept (verified *(re-plan 2026-10-25)*):
- Permission prompts are session state: `RemoteClient.deliver` routes every
  `permission_request` of an attached session to the router and the ONE broker
  (`client/src/remote-client.ts:1424-1427`, `:1729-1747`). The TUI declares
  every known update at `initialize` (`remote-client.ts:888`), so it is a
  declaring client for the `blocking` `permission_request`
  (`protocol/src/updates.ts:237`) and is asked. First answer wins daemon-side
  (`hosted-session.ts:575-605`); `permission_resolved` closes the others.
  The wire request carries **no turn id** (`protocol/src/permission.ts:54-65`):
  see step B4 for how the client attributes it.
- `session/cancel` is a per-session **notification**
  (`protocol/src/session.ts:217-222`, `daemon/src/connection.ts:400-408`,
  `hosted-session.ts:1552-1559`): any device can stop the running turn —
  blindly (step A).
- Paged snapshots read the WHOLE history (`remote-client.ts:1560`, pages of
  `SNAPSHOT_PAGE = 200`, `:95`, at most `SNAPSHOT_MAX_PAGES`, `:103`). The
  first page names the turn running at the cut, the title and the queue
  (`hosted-session.ts:824-842`). A resync applies the title and the queue
  (`remote-client.ts:1322-1330`).
- A spilled tool result renders the same live and in history replay: the live
  `tool_result` keeps `spill` (`client/src/mapping.ts:176-177`), and
  `messagesToItems` keeps it from the message (`tui/src/resume.ts:43-44`). So
  a foreign turn and an eager-open history show the short note with no extra
  work *(re-plan 2026-10-25)*.

**Repro 1 (2026-10-24, kept)** — eager-open cost, from
`.tentacle/tmp/tui-foreign-turns-plan/repro.ts` on `24c13c6`: a foreign turn's
updates DO reach the second client's `RemoteSession` and are dropped there;
the cost of an eager full-history open is the FIRST layout (~140 µs/item,
synchronous: 5 000 messages ≈ 0.7 s, 20 000 ≈ 2.8 s), not the transfer
(in-memory, 17 ms for 20 000) nor the conversion (2 ms). Not re-measured: the
spill note changed `render-lines.ts`, so T-C8 re-measures on today's code
before the threshold is fixed (O3).

**Repro 2 (re-plan 2026-10-25)** — the routing bug on `efc2e28`, from
`.tentacle/tmp/tui-foreign-turns/race.test.ts` (run with `bun test <path>`).
One in-process `SessionHost`, two `RemoteClient`s; B's uplink has 20 ms of
latency (a WAN device). A's model streams 40 chunks, 2 ms apart.

```ts
const slowUplink = (ch: DuplexChannel): DuplexChannel => ({
  send: (data) => void setTimeout(() => ch.send(data), 20),
  close: () => ch.close(),
  setOnMessage: (h) => ch.setOnMessage(h),
  setOnClose: (h) => ch.setOnClose(h),
});
// a = dial(fast), b = dial(slowUplink); both attached to sid (one warm turn each)
const t = drain(sa.send("a-turn"));
await sleep(5);
const race = await drain(sb.send("b-race")); // B's own prompt loses the slot
```

```
$ bun test .tentacle/tmp/tui-foreign-turns/race.test.ts
B's own send yielded 8 events: [text:A3, text:A4, text:A5, text:A6, text:A7, text:A8, …]
then threw: a turn is already running
```

Reading: B's TUI would show its "b-race" bubble followed by eight of A's
chunks, then a failure. With a fast uplink the same race yields `[]` (the
rejection beats A's next chunk): the bug is timing-dependent, so its
regression test (T-B2) scripts the frame order instead of relying on latency.

## Implementation

*— claude-opus-5-5, 2026-10-24; re-planned in full 2026-10-25*

### Load-bearing assumption

*(re-plan 2026-10-25)*

**The daemon's stream brackets turns exactly: at any seq at most one turn is
started-and-not-ended, and every turn-scoped update lies between ITS turn's
`turn_start` and `turn_end` (or after a reset whose `turn` names it).**
"Turn-scoped" = `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
`tool_call_update`, `plan`, `agent_usage`, `steer`, `context_note`,
`permission_request`, `permission_resolved`. Everything else is
**session-level** and is never routed to a turn: `queued`, `session_title`,
`history_replaced`, `background_exit`, `session_closed`. Task 5's and task 3's
updates are session-level on purpose: they are emitted both inside and
outside turns (repro below), and their owners are already the session
listeners (`remote-client.ts:1428-1441`). So they do not touch "mine vs
foreign by turnId".

Proof, code (today's lines):
- One busy slot. Every taker calls `assertIdle` and takes the slot in the same
  synchronous stretch (`hosted-session.ts:1165-1175`): `prompt` (`:934-946`,
  `turn_start` at `:946`), a free-slot `sendNow` (`:1017-1029`), `compact`
  (`:1482-1491`).
- `finishTurn` clears the slot and emits `turn_end` before anything else
  (`:1275-1292`). Then, in its `finally`: `recordCut` (`:1294`), the reserved
  send-now starts (`settleSuccessor`, `:1300` → `startSuccessor`, its
  `turn_start` at `:1131`), then `publishQueue` (`:1303`). So a hand-off is
  `turn_end{X}`, `turn_start{Y}`, `queued` — back to back.
- The only `turn_end` with no `turn_start` is an unstarted send-now
  (`endUnstarted`, `:1152-1162`, "delivered NOTHING"). A resumed turn after a
  restart streams no `turn_start`; the snapshot's `turn` says it runs
  (`:383-394`, `:423-436`).
- Permission events are inside the turn. `awaitDecision` needs a live,
  non-compacting turn signal (`:464-470`). Its `permission_request` is emitted
  after a disk flush, and only if the ask is still pending (`:509-520`). A
  pending ask blocks the agent, so the turn cannot end first. An abort settles
  the ask (`permission_resolved`, `:591-605`) before the unwinding `drive`
  reaches `finishTurn`. On `close`, the abort's `permission_resolved` comes
  before `finishTurn{cancelled}` (`:1576-1588`).
- Session-level updates come from outside the turn's code path:
  `background_exit` from a job listener (`:410-418`); `queued` from
  `publishQueue` (enqueue `:1472`, steer `:1229-1231`, turn end `:1303`,
  reclaim `:704`, cancel `:1558`, close `:1595`); `session_title` from
  `setTitle` (rename mid-turn or idle, generated after a turn's end on a
  macrotask, `:1315-1331`, `:1411-1419`); `history_replaced` from a
  compaction, which holds the slot itself, so no turn is open (`:1528-1549`).

Proof, test (`.tentacle/tmp/tui-foreign-turns/bracket.test.ts`, on
`efc2e28`). Three clients on one daemon, a slow model (40 chunks, 2 ms
apart), an observer logging every applied update. Scenarios:
1. A's turn: B steers it, renames mid-turn, cancels it. The steer is returned;
   B reclaims it while idle and renames idle.
2. A's turn: B `send_now`s it (a hand-off).
3. A's turn: B `send_now`s it and cancels at once (the successor ends
   unstarted).
4. An idle compaction.
5. The race of Repro 2, with a fast uplink.

```
$ bun test .tentacle/tmp/tui-foreign-turns/bracket.test.ts
updates observed: 263, turns: 6, violations: 0
turn_end with no turn_start (unstarted send-now): 1
session-level updates (inside a turn / outside): {"queued":{"inside":5,"outside":2},"session_title":{"inside":1,"outside":1},"history_replaced":{"inside":0,"outside":1}}
resets seen by the observer: 2
(2) B's own send while A's turn runs yielded [] then threw: a turn is already running
```

Non-vacuous: 263 updates over 6 turns, including a cancel, a hand-off, an
unstarted successor (the one `turn_end` without a start), a reclaim, two
renames and a compaction barrier (one of the 2 resets; the other is the
observer's attach). `queued` and `session_title` occur on both sides of the
bracket, which is why they must never be routed by it. The executor turns this
script into T-B0, so the gate pins the property, not this doc.

**Who started a turn — learned from the daemon, exactly.** The `turnId` is
the client-minted idempotency key of `prompt` / `send_now`
(`protocol/src/session.ts:153-158`); the daemon echoes it in `turn_start`,
`turn_end` and the snapshot's `turn` (`protocol/src/updates.ts:118-134`,
`session.ts:303-304`). A turn is **own** iff its id is one this
`RemoteSession` minted and still tracks (`active` / `next` / `settling`,
`remote-session.ts:86-99`); every other id is **foreign**. No text, no shape,
no guess — the same rule task 5 uses for rows ("mine = an id I minted",
`remote-session.ts:102-107`). A turn this TUI started before it was restarted
is foreign to the new process. That is correct: the new process has no stream
for it, and it renders the same anyway.

**Which turn an update belongs to — the reducer says** *(re-plan
2026-10-25)*. The pure reducer already tracks the stream's running turn:
`turn` is set on `turn_start`, cleared on the matching `turn_end` and on
`session_closed`, and set from the snapshot on a reset
(`client/src/session-reducer.ts:234-240`, `:257-258`, `:311-322`). But
`RemoteClient.step` stores only the FINAL state of a step before delivering
its outputs (`remote-client.ts:1363-1371`), and one step can drain a buffer
spanning several turns. So the turn must be stamped **per output**, by the
reducer: `{kind: "update", seq, update, turn}`. Routing then reads a pure,
unit-tested fact, and the permission path (B4) reads the same one.

### Preconditions

*(re-plan 2026-10-25: re-verified on `efc2e28`; P8 of the 2026-10-24 plan — 4c/4d/5 unmerged — is obsolete, all are on `main`)*

- P1 — one session path (AGENTS §7): every runtime builds `RemoteSession`
  through `RemoteClient.newSession` (`remote-client.ts:473-479`; worker/pod via
  `cli/src/local-runtime.ts:309-313`, `connect` via `cli/src/connect.ts:127`).
  The App sees only `SessionController` (`App.tsx:105-157`). Foreign turns go
  through the SAME `ActiveTurn` / `onUpdate` / `updateToEvent` code in the
  client and the SAME `streamTurn` loop in the App — no second render path.
- P2 — the reducer's `turn` is exact per update (above), and `reset.turn`
  reaches the listener (`session-reducer.ts:320`).
- P3 — single broker: one `PermissionBroker` per runtime, shared by
  `RemoteClient` and `startTui` (`connect.ts:89`, `:114`, `:126`; worker/pod
  `local-runtime.ts:268-282`). Nothing here creates a broker or a second
  requester. A field added to `PermissionRequestOptions`
  (`core/src/permission.ts:64-67`) rides the existing call; held requests keep
  their options (`permission.ts:94-100`, `:116-119`).
- P4 — `cancel` is idempotent and per session (`hosted-session.ts:1552-1559`).
  Its other callers stay blind: `Connection.close` for a model-proxy daemon
  (`connection.ts:120-127`) and the client's `error`-frame path
  (`remote-session.ts:599-605`).
- P5 — strip schemas (AGENTS §7 forward compat): `CancelParamsSchema` is a
  plain `z.object` (`protocol/src/session.ts:219-221`), so a protocol-11
  daemon built before this task drops an unknown `turnId`. The handshake
  requires an exact `PROTOCOL_VERSION` (`connection.ts:276`, today 11,
  `protocol/src/version.ts:7`): an "older daemon" here means only an older
  build of protocol 11. Every such build echoes `turnId` and reports `queued`.
- P6 — `hooks/trust` is asked only of the PROMPTING connection
  (`connection.ts:379-398`). A foreign turn's hooks trust is the other
  device's prompt, never this TUI's. Nothing to change.
- P7 — the row cache warms in time-budgeted chunks (`tui/src/render-lines.ts:714`,
  used by resize at `App.tsx:462-501`).
- P8 — `connect` passes no `jobs` to the TUI (`connect.ts:123-132`), so no
  client-side auto-wake can double-fire across devices on `serve`. The worker
  and pod runtimes do pass `jobs` (`local-runtime.ts:344`), but each has
  exactly one client: each `run` / `attach` exec is its own daemon process.
- P9 — the session-level listeners exist and fire while idle: the title
  (`remote-client.ts:1435-1437`), the queue (`:1438-1441`, `RemoteSession.queued`
  `remote-session.ts:153-160`), the rows handed back (`onReturned`, `:162-192`).
- P10 — open semantics on `serve` (2a): a live id attaches; an archived id is
  `SessionArchived` unless `reopen: true`; a deleted id is `SessionDeleted`
  whatever the params say; an unknown id without `create` / `messages` is
  `UnknownSession` (`daemon/src/session-host.ts:340-378`).

### Design

#### Order inside the branch

*(re-plan 2026-10-25: one branch; the old 6a/6b/6c split table is obsolete)*

| Step | What | Gate before the next step |
|---|---|---|
| A | protocol + daemon: `session/cancel{turnId?}` | `bun test packages/daemon/test/send-now.test.ts` (+ the new cancel tests) |
| B | client: per-output turn stamp, routing by it, foreign turns, session feed, permission turn attribution, eager `open()`; cli passthrough | `bun test packages/client/test/foreign-turns.test.ts` + `session-reducer`, `permission-router`, `queued-broadcast`, `send-now`, `reattach` |
| C | TUI: one loop for any turn, keys, own-only auto-accept, withdrawn prompt, the daemon's rows, compaction/closed notices, large-history warm | `bun test packages/tui/test/foreign-turns.test.tsx` + the pure tables; then `bun run check` |

#### A — a cancel names the turn it means

Problem: Esc is pressed on what the screen shows; the screen lags the daemon
by a round trip. With several devices, "turn X ended, the phone's turn Y
started" can happen inside that lag, and today's blind `session/cancel`
cancels Y. Own-only turns made that window harmless; foreign turns make it
real (owner Q1).

- `CancelParamsSchema` gains `turnId: TurnIdSchema.optional()` (comment: "the
  turn the client means; absent → whatever runs, a compaction included").
- `HostedSession.cancel(turnId?)` (`hosted-session.ts:1552-1559`):
  - absent → today's body, unchanged (4d's compaction cancel, the blind
    callers of P4);
  - `=== activeTurnId` and not compacting → `controller.abort()` only. A
    reserved successor is NOT cancelled: it is a newer intent (another
    device's send-now, or mine);
  - `=== successor?.turnId` → `successor.cancelled = true` only. The old turn
    is already being interrupted by that send-now;
  - anything else → no-op (stale);
  - in every branch: `publishQueue()` last, as today (a cancelled successor's
    rows leave `entries`).
- `Connection.onNotification` passes `params.turnId` (`connection.ts:401-406`).
- `RemoteClient.cancel(sessionId, turnId?)` (`remote-client.ts:756-760`).

Protocol: an additive optional field on a notification, strip schema → **no
`PROTOCOL_VERSION` bump** (P5). An older protocol-11 build drops it and
cancels whatever runs (= today). Regenerate `protocol.json`
(`bun run schema:export`). No record change (`DAEMON_RECORD_VERSION` stays 5).

#### B — the client is a view of the session

**B1. The reducer stamps each update with its turn** (`session-reducer.ts`).
`StreamOutput`'s `update` member gains `readonly turn: string | null`:
- `turn_start{X}` → `X` (after setting `state.turn`);
- `turn_end{X}` → `X` if it closes the running turn, else `null` (an
  unstarted send-now: it belongs to no started turn);
- any other update → `state.turn` as of that update (`null` outside turns).
Pure, three lines in `apply` (`:233-252`). Every existing consumer ignores the
new field.

**B2. Routing (`RemoteSession.output`, replacing the idle drop at
`:570-578`).**
1. `streaming` = the turn the stream says runs: the last `out.turn` of a
   `turn_start`, or `reset.turn`; cleared by its `turn_end`, `reset{turn:
   null}`, `turn_lost`, `session_closed`.
2. `turnFor(id)` = the own turn with that id (`settling` / `active` / `next`),
   else the foreign turn with that id. A foreign turn is created on its
   `turn_start`, or on a `reset` that names it.
3. A turn-scoped update goes to `turnFor(out.turn)` — **never to "the active
   own turn"**, which is the bug of Repro 2. `out.turn === null` → dropped,
   and counted by a test-only assertion: it cannot happen per the
   load-bearing assumption. `turn_end{X}` with no turn of id X (a foreign
   unstarted send-now) is ignored: it delivered nothing.
4. A session-level update is never routed to a turn. `queued`,
   `session_title`, `background_exit` and the permission events stay with
   their owners (`remote-session.ts:695-705`, unchanged). A `history_replaced`
   sets `compactedPending = true` (the next reset is a compaction's: a daemon
   fact, the barrier, never a guess). A `session_closed` ends every open turn,
   own and foreign (each already got `turn_end{cancelled}` before it,
   `hosted-session.ts:1582-1598`), marks the session `remoteClosed` (a later
   `send` rejects `UnknownSession` "this session was closed on another
   device", not a cryptic id error), and raises a `closed` activity with its
   `reason`.
5. A `reset` goes to `turnFor(reset.turn)` when a turn runs at the cut: the
   same code as today's own reset (`:580-595`). A foreign turn that was
   streaming and is NOT `reset.turn` ended behind the cut. Its stream
   **closes with no `turn_end` event**: the outcome is unknown to this client
   and is never guessed (the snapshot shows what it did). A reset with no
   turn running raises a `history` activity carrying `compacted:
   compactedPending` (then cleared).
6. A resumed turn after a daemon restart has no `turn_start`: it arrives as
   `reset{turn: id}` → a foreign turn, no prompt bubble (its prompt is in the
   snapshot). The same as attaching mid-turn.
7. The hand-off resync at `:558-569` (own old turn → own successor) is
   unchanged.

**B3. A foreign turn = an `ActiveTurn` with `foreign: true`.** The same record
and `onUpdate` / `end` / `fail` as an own turn. It is never `sent`, never
`acked`, and it is not in `recovered`'s list (`:636-648`), so it is never
re-sent: `turnRecovery` needs `acked` (`client/src/link-machine.ts`). Its
events:
- first, `user_message{prompt}` when it was created by a `turn_start` whose
  `prompt !== ""` (a continuation has none, the 4a/4b carry-over);
- then exactly what an own turn yields, `spill` included (`mapping.ts:177`).

It takes the `idleNotices` like `install()` does (`:440-446`). It ends on:
- its `turn_end`: an error outcome fails the queue, like an own error
  (`:719-737`);
- `turn_lost`, `session_closed` or `linkClosed`: it fails, with the same
  messages as an own turn (`failAll` covers own AND foreign);
- rule B2.5 (a reset that does not name it).

**B4. Permission attribution for owner Q3.** The wire request has no turn id.
The client attributes each request to the turn it was raised in:
`deliver` passes `out.turn` to `router.request(sessionId, update, turnId)`
(`remote-client.ts:1424-1425`; `client/src/permission-router.ts:77`). The
router keeps it on the queued entry, so a request prompted later still
carries it (`permission-router.ts:201-207`). `runPermissionActions` calls
`permissions.request(req, { signal, turnId })` (`remote-client.ts:1742-1743`).
`PermissionRequestOptions.turnId?` is new and laptop-internal — never on the
wire, like `signal`. `RemoteSession.ownsTurn(turnId)` answers own-vs-foreign
(B2.2). The broker is untouched (P3): the same one instance, the same single
requester.

**B5. Steering, send-now and cancel bind to the daemon's running turn.**
- `enqueue` binds to `streaming ?? this.turnId` (today `this.turnId`,
  `:281-298`): typing during a foreign turn steers IT (decision 5: "any
  device can steer it"). Before its own `turn_start`, an own unstarted turn
  keeps today's binding. After any end, the kept `turnId` still yields the
  daemon's `NoTurnRunning` (the comment at `:79-85` holds).
- `sendNow(…, "turn")` (`:333-425`) treats a streaming, unended foreign turn
  as the current one. The local `NoTurnRunning` refusal (`:351`) checks
  `(streaming ?? this.turnId) === null`. `interrupt = {kind: "turn", turnId:
  streaming ?? this.turnId}`. The successor waits as `next` and is promoted
  when the foreign turn ends: `promote` (`:449-459`) also accepts a foreign
  `ended`. The rows sent are still only mine (D4, `takeForSendNow`,
  `queued.ts:65-71`).
- Cancels name their turn (step A). An own turn's abort:
  `client.cancel(id, turn.turnId)` at `:504-507`, `:393-396` and the
  ack-time re-send `:540-544`. A foreign turn's activity:
  `cancel()` → `client.cancel(id, foreignTurnId)`. The `error`-frame cancel
  (`:604`) stays blind (P4).

**B6. The session feed (new, optional on the controller).**
```ts
type SessionActivity =
  /** A turn this session did not start (or one already running when we attached). */
  | { kind: "turn"; turnId: string; events: AsyncIterable<SessionEvent>; cancel(): void }
  /** The daemon's history replaced what is shown while no turn runs (eager open, a resync, a compaction). */
  | { kind: "history"; messages: readonly ChatMessage[]; compacted: boolean }
  /** The session ended daemon-side (another device's close / delete, the reaper). */
  | { kind: "closed"; reason: "closed" | "deleted" };
watch(listener: (a: SessionActivity) => void): () => void;
ownsTurn(turnId: string): boolean;
```
There is one listener (the App). Activities raised before `watch` are
buffered and handed over on subscribe, like `idleNotices`, so the order of
`open()` and `watch()` cannot lose the initial history. The 2026-10-24
`queued` activity is dropped: task 5 already gives the queue its own
listener (`onSessionQueued` / `RemoteSession.queued`), and step C reads that
*(re-plan 2026-10-25)*.

**B7. Eager open (the seam task 7 calls)** *(re-plan 2026-10-25: 2a semantics)*.
- `RemoteClient.newSession(seed, id, seedTitle, opts?: { attach?: { reopen?:
  boolean } })` (`remote-client.ts:473-479`; today's 3rd parameter is the
  seed title).
- `RemoteSession.open(): Promise<void>`: a no-op unless built with `attach`.
  Otherwise it ATTACHES: `session/open{sessionId, reopen?}`, never `create`,
  never `messages`. That is a new `RemoteClient.attachSession(id, listener,
  {reopen})` beside `openSession` (`:544-578`). `runTurn` awaits the same
  promise instead of its own lazy open (`:470-484`).
- The entry is `attachOnly`. Its recovery never creates or recreates:
  - `recover` of a never-live entry must not send `create: true`
    (`:1186-1192`);
  - `openOn`'s `UnknownSession` → `recreate` (`:1222-1226`) applies only to an
    `everLive` entry. A recreate would build an empty session under an id
    another device owns (task 7's "opening a gone id must fail, not create an
    empty session", `mobile-app.md:523-524`).
- Outcomes (P10):
  - live → `resync: true` → paged snapshot (title and queue included,
    `:1322-1330`) → `reset` → a `history` activity (idle) or a foreign turn
    (mid-turn): the full history, then live;
  - `SessionArchived` → `open()` rejects (task 7 retries with `reopen` from
    `/sessions`);
  - `SessionDeleted` → `noteDeleted` fires (`:1249-1256`), and `open()`
    rejects;
  - `UnknownSession` → rejects.
  In none of these cases is a session created.
- A FRESH session stays lazy on purpose: nobody else can be on an id the
  daemon does not have. Opening it eagerly would create an empty daemon
  session at every launch (with task 7's detach-on-quit, a litter of empty
  sessions in `session/list`). No caller in THIS task passes `attach`: task
  7's `connect --resume` / `/sessions` do. This task builds and tests the
  seam (client tests + the TUI with a fake controller).
- Titles (task 3): an attach learns the chosen title from the snapshot
  (`titleRead`, `:1147-1156`) and announces it as a `session_title` notice.
  The TUI shows no title today; the persisting controller saves on it
  (`local-runtime.ts:169`).

**B8. Persistence (cli).** `persistingController` (`local-runtime.ts:134-219`)
passes `watch` / `open` / `ownsTurn` through. It calls `flush()` when a
foreign turn's events end (the same `saved()` wrapper, `:174-187`) and on a
`history` activity. **Whose turns are saved: all of them.** The laptop record
is a copy of the SESSION, read from `snapshot` (AGENTS §7 Persistence), never
"my turns". In practice foreign turns exist only on `serve` / `connect`
(P8), which keeps no laptop store (`connect.ts:123-132`), and there the
trusted daemon persists itself. The hooks keep the invariant true for every
runtime at no cost. A pod could fabricate a "foreign" turn. But it already
supplies the snapshot that the laptop persists, so there is no new trust
surface: nothing here creates an approval or a durable decision (AGENTS §7 "a
pod is not trusted"). `connect` hands the `RemoteSession` itself to the TUI
(`connect.ts:127`), which has the new members natively.

#### C — the App renders any turn through one loop

Pure decisions in pure modules (AGENTS §7); `App.tsx` only executes them.

- **C1. One loop.** `streamTurn(open, controller, opts)` (`App.tsx:747-828`)
  consumes own turns, send-now successors and foreign turns (`opts.foreign`).
  - A foreign turn starts with `startContinuation`, with no local bubble: its
    `user_message` (the daemon's prompt) draws it, exactly as a send-now
    successor does (`:709-719`).
  - Its controller's `abort` calls `activity.cancel()`, and it is installed
    as `abortRef`. So Esc (`:1505-1509`), Ctrl+C (`:1458-1469`) and Ctrl+C in
    the dialog (`:1432-1442`) stop it with no new key code (owner Q2: "stop
    what is running, whoever started it"). The dialog comment "with no turn
    of ours…" is reworded.
  - `running` now means "a turn of the session runs".
  - A stream that closes with no `turn_end` event (B2.5) ends with pure
    `endWithoutOutcome(state)` (`state.ts`: `running: false`, no stop
    reason), never a guessed reason.
- **C2. Ordering (pure, `tui/src/turn-feed.ts`, new).** `nextStep({ inFlight,
  compactingOwn, activity }) → "consume" | "hold" | "history" | "closed"`.
  - A foreign `turn` while an own run is in flight is **held**. Its queue
    buffers, so nothing is lost. It is consumed when that run settles, in the
    `finally` of `streamTurn` (`:801-825`). The only overlaps are an own
    prompt that lost the slot (it will reject) and a hand-off (the old
    `turn_end` precedes the successor's updates).
  - During my own `/compact` a foreign turn can start only through another
    device's send-now on the compaction. It is consumed at once. My
    compaction then settles `Cancelled` with `turnRunning: true` → its rows
    go back to the input (`send-now.ts:100-119`, existing branch).
  - `history` while idle → `resetHistory`, unless `compacted` (C6). While a
    run is in flight it cannot occur: B2.5 routes the reset into the turn.
- **C3. An own prompt that lost the slot.** `TurnInProgress` before any event
  (another device's turn took the slot first) is handled in pure
  `withdrawUserTurn(state, item)` (`state.ts`). `item` is the object
  `startTurn` appended (`state.ts:171-181`): removed by identity, never by
  text. A reset meanwhile already replaced it, so there is nothing to remove.
  Then:
  - the text goes back to the input (`restoreInput`, `App.tsx:621-629`, the
    `withRestored` join);
  - the notice says "_another device started a turn — your message is back
    in the input (Enter now queues it)_".
  Never lost (decision 15's rejected-enqueue rule, applied to a rejected
  prompt). This replaces today's `failTurn` + restore for the
  fallback-send-now case (`:792-799`): one rule for every own prompt that
  loses the slot *(re-plan 2026-10-25)*.
- **C4. Keys on a foreign turn.** `quitAction` (`commands.ts:195-204`) gains
  `foreign: boolean`.
  - `/exit` mid-foreign-turn → **exit at once, no cancel**. Today's "stop then
    exit" (`App.tsx:1059-1070`) exists to save an own turn; a foreign turn is
    not ours to stop on our way out (owner Q2, decision 4). See QR4 for what
    `connect`'s exit path does next.
  - Ctrl+C → stop it; a second Ctrl+C quits, as today.
  - Enter → steers the foreign turn (B5).
  - `/clear`, `/retry`, `/compact` and skills are refused while it runs, as
    for own turns (`commands.ts:157`, `App.tsx:1042-1057`, `:1107-1110`).
    Consequence *(re-plan 2026-10-25)*: `/clear` can no longer close a
    session while ANY device's turn runs. So the close never creates
    `returned` rows of mine that nobody reclaims (task 5 Review finding 3,
    `queued-broadcast.md:1424-1429`). What is left of that debt: a reclaim
    that was in flight or failed at the moment of an idle `/clear`. It stays
    task 13's, unchanged.
  - Ctrl+X Ctrl+S → sends MY rows now, interrupting the foreign turn (B5).
    `planSendNow`'s `running` (`App.tsx:895`) is true for it, because
    `streamCtrlRef` is the foreign controller.
- **C5. Auto-accept answers only own turns (owner Q3).** Pure
  `autoApproves(req, own)` (`tui/src/permission-ui.ts:40-42`).
  `usePermissionBroker(permissions, ownsTurn?)` auto-accepts only when
  `ownsTurn` is absent (no session decides) or `ownsTurn(options.turnId)` is
  true. A request with no `turnId` under a session that decides is ASKED,
  never auto-approved. The same rule applies when Shift+Tab turns auto-accept
  on with a dialog already up (`:133-142`). A foreign turn's prompt therefore
  always shows the dialog; the first answer on any device wins; "Yes, don't
  ask again this session" there creates the same daemon-side session rule as
  it would on the phone (one principal; `serve` only, never a pod: P8).
- **C6. Compaction and close notices** *(re-plan 2026-10-25)*.
  - `history{compacted: true}` while idle does NOT replace the transcript.
    This TUI's own `/compact` keeps its scrollback today, because the reset
    is dropped while idle (`remote-session.ts:577`) and its own notice says
    "Context compacted" (`send-now.ts:107-108`). If `compactingRef` is set,
    it was mine: nothing more. Otherwise the notice says "_the conversation
    was compacted on another device_". QR1 asks the owner to confirm this.
  - Any other idle `history` (eager open, a resync after a gap or a ring
    overflow) replaces the transcript: the daemon's history is the truth, and
    the TUI may have missed turns.
  - `closed` → "_this session was closed on another device_" /
    "_…was deleted on another device_". What happens next (a fresh session,
    the picker) is task 7's.
- **C7. Queued rows — the daemon's list (task 5's deferral lands here).**
  Pure `shownRows(local, daemon: QueueState | undefined)` (`queued.ts`):
  - with a report: the daemon's `entries` in order (every writer's steers,
    decision 15). A row that is mine keeps its local `state` (`sending`).
    After them come my local rows not yet acked (`markAcked(rows, id)` on the
    enqueue's resolve, `App.tsx:1298`) and the compaction-time rows (4d: never
    enqueued, so never acked).
  - with no report yet (`queued === undefined`: a fresh session before its
    first change): the local rows, as today.
  - `rowsRef` stays the truth for what Ctrl+X Ctrl+S sends (mine only, D4).
    `onSteer` by id (`queued.ts:43-44`), `onTurnEnd` (`:74`) and the
    hand-back (`handBackRows`, `:154-170`) keep acting on the local rows.
  - Visible effect: a phone's row shows; my rows that another device's
    send-now carries stay visible (the known limit at
    `queued-broadcast.md:879-882` is fixed). No per-device label
    (decision 5).
  - Other writers' `returned` rows are NOT rendered, and there is no reclaim
    act on them (QR2).
  - Where the rows render (`App.tsx:1769-1773`): the queue shows while a
    turn of the session runs or my compaction runs, as today.
- **C8. Large histories.** A `history` (or a `history_reset` inside a turn)
  with more than `WARM_THRESHOLD` items (start 500; fixed by T-C8's
  measurement) is warmed with `warmRowsChunk(items, opts, i, 6)` on
  `setTimeout(0)` steps before it is committed — the resize pattern (P7).
  The running line shows "loading history (i/N)…". The loop awaits the warm,
  so later events apply after it, in order. Input stays live (target: no
  event-loop stall > 50 ms at 20 000 messages).
- **C9. Wiring.** `SessionController` gains optional `watch?`, `open?`,
  `ownsTurn?` (`App.tsx:105-157`). A mount effect calls `watch` first, then
  `open?.()` (a rejection → a notice). `/clear` unsubscribes the old
  session's `watch` and subscribes the new one, like `watchReturned`
  (`:636-661`, `:1077-1079`).

### Files

*(re-plan 2026-10-25: dependency order, one branch)*

Step A (protocol → daemon):
1. `packages/protocol/src/session.ts` — `CancelParamsSchema.turnId?`.
2. `packages/protocol/schema/protocol.json` — regenerated (`bun run schema:export`).
3. `packages/daemon/src/hosted-session.ts` — `cancel(turnId?)`.
4. `packages/daemon/src/connection.ts` — pass `turnId`.

Step B (core → client → cli):
5. `packages/core/src/permission.ts` — `PermissionRequestOptions.turnId?`.
6. `packages/client/src/session-reducer.ts` — `turn` on each `update` output.
7. `packages/client/src/permission-router.ts` — keep `turnId` on the entry and the `prompt` action.
8. `packages/client/src/remote-client.ts` — `cancel(sessionId, turnId?)`;
   `deliver` → router with `out.turn`; `runPermissionActions` →
   `{signal, turnId}`; `newSession(…, opts?)`; `attachSession`; `attachOnly`
   in `register` / `recover` / `openOn`.
9. `packages/client/src/remote-session.ts` — `streaming`, `turnFor`, foreign
   turns, rules B2.1–7, `watch`, `open`, `ownsTurn`, `remoteClosed`,
   enqueue / sendNow binding, `promote` for a foreign end, cancels with
   `turnId`.
10. `packages/client/src/index.ts` — export `SessionActivity`.
11. `packages/cli/src/local-runtime.ts` — `persistingController`: `watch` /
    `open` / `ownsTurn` passthrough + flush hooks.

Step C (tui):
12. `packages/tui/src/turn-feed.ts` (new, pure) — `nextStep`, warm threshold.
13. `packages/tui/src/state.ts` — `withdrawUserTurn`, `endWithoutOutcome`.
14. `packages/tui/src/queued.ts` — `markAcked`, `shownRows`.
15. `packages/tui/src/commands.ts` — `quitAction(…, foreign)`.
16. `packages/tui/src/permission-ui.ts` — `autoApproves(req, own)`, `ownsTurn` input.
17. `packages/tui/src/App.tsx` — `SessionController.watch?` / `open?` /
    `ownsTurn?`, the mount effect, feed → `streamTurn`, hold / consume, keys,
    withdraw, rows view, notices, warm.

### Failure modes

*(re-plan 2026-10-25: re-derived on today's code; every row names its test)*

| Case | Convergence |
|---|---|
| Own prompt loses the slot to another device's turn (Repro 2) | Foreign chunks go by `out.turn` to the foreign turn, never into the own stream (T-B2). The own prompt rejects `TurnInProgress` → bubble withdrawn, text back in the input, notice; the held foreign turn renders after (T-C4). |
| Race: own `turn_start` and a foreign one | Impossible by the one slot (load-bearing); whoever's `prompt` reached `assertIdle` first owns the slot, the other is the row above. |
| Another device send-nows MY turn | My stream ends `cancelled`, then a foreign activity with the daemon's prompt (held until my stream settles, then consumed). My rows that it carries stay visible from the daemon's list (T-B9, T-C6). |
| My send-now on a foreign turn | `interrupt` names the foreign id; the successor waits as `next`, promoted at the foreign `turn_end`; only my rows (T-B8). |
| Another device's send-now on MY compaction | My `/compact` settles `Cancelled`; the foreign turn is consumed at once; the compaction rows go back to the input (`turnRunning` branch) (T-C9). |
| Foreign unstarted send-now (`turn_end`, no `turn_start`) | `out.turn === null` and no turn of that id → ignored, no activity (T-B7). |
| Esc on a turn that just ended while a new one started | `cancel{turnId: stale}` is a no-op daemon-side (T-A1); an older protocol-11 build → today's blind cancel (stated, P5). |
| Disconnect mid-foreign-turn, `since` covered | Replay past `since`, seq dedupe (reducer); the foreign turn object survives `link_down`; never re-sent (T-B4, T-B6). |
| Re-attach, `since` evicted (ring overflow) / gap | Resync: the reset goes into the still-running foreign turn, or closes one that ended behind the cut WITHOUT a guessed outcome (`endWithoutOutcome`), or becomes an idle `history` (replace) (T-B5, T-C10). |
| Compaction elsewhere (or mine) | `history_replaced` → `compactedPending` → idle `history{compacted}` → transcript kept, notice only when not mine (T-B14, T-C11; QR1). |
| A permission prompt of a foreign turn | Attributed by `out.turn` (B4); asked even with auto-accept on (T-B15, T-C3b); first answer wins daemon-side; Ctrl+C in the dialog cancels that turn (T-C3). A replayed pending request after a reset carries the reset's turn. |
| Close / archive by another device mid-turn | `turn_end{cancelled}` ends the own / foreign stream; `queued{returned: cause ended}` hands my rows back (task 5; the reclaim then fails `UnknownSession`, its known F2 debt); `session_closed` → `closed` activity → notice; a later send rejects with a clear message (T-B11, T-C7). |
| Delete (tombstone) by another device | `session_closed{deleted}` → "deleted on another device". An eager attach of a tombstoned id → `SessionDeleted`, `noteDeleted`, `open()` rejects, nothing created (T-B13c). |
| Eager attach of an archived / unknown id | `SessionArchived` / `UnknownSession` → `open()` rejects; never `create`, never `recreate` (T-B13b). |
| Link drops before an attach ever went live | `recover` re-sends the attach (no `create`) (T-B13d). **Mutation:** send `create: true` for never-live entries again → red. |
| Foreign turn fails (`stopReason: error`) | Same `RpcError` as an own failure → `failTurn` on every device (T-B1b). |
| Link gone for good / session recreated (pod) | `linkClosed` / `turn_lost` fail own AND foreign streams — no hang (T-B10). |
| Quit during a foreign turn | The TUI exits at once without cancelling (T-C5). `connect`'s exit path then still calls `closeSessions` (`connect.ts:136`) until task 7 (QR4). |
| No `queued` report yet | Local rows only, as today (T-C6b). |
| Very long history | Transfer: paged, bounded (`SNAPSHOT_MAX_PAGES`); render: chunked warm, input live (T-C8). WAN transfer cost: later (owner Q4). |
| Persistence | Every foreign turn's end and every idle `history` trigger the same serialized, coalesced snapshot save as an own turn (T-B12). |

### Tests

*(re-plan 2026-10-25)*

Every RED test is shown failing on `main` before its fix lands (§9).
Iterate on the narrow file; then `bun run check`. Fakes (match, don't invent):
- the real in-process daemon of `client/test/send-now.test.ts` (`realDaemon`
  `:57`, `gatedEnv` `:38`, `scriptedDaemon` `:110`);
- `client/test/support/link-cutter.ts` for drops, and `support/fakes.ts` for
  scripted frame orders;
- `ink-testing-library` frames as in `tui/test/app.test.tsx`, and the fake
  controllers of `tui/test/send-now-app.test.tsx` / `returned.test.tsx`.

**Step A** — `daemon/test/send-now.test.ts` (or a new `cancel.test.ts`):
- T-A1 RED: `cancel{turnId: <ended turn>}` while a new turn runs → the new turn
  is NOT cancelled (today it is).
- T-A2: `cancel{turnId: active}` aborts it; a reserved successor still starts.
- T-A3: `cancel{turnId: successor}` → `turn_end{delivered: false}` for it; the
  old turn is unaffected beyond its send-now interrupt.
- T-A4: no `turnId` → today's behaviour (aborts the turn or the compaction +
  the successor).
- T-A5: `cancel{turnId: unknown}` while a compaction runs → the compaction
  goes on.
- Mutation: drop the field in `Connection` → T-A1 red.

**Step B** — `client/test/session-reducer.test.ts`, `permission-router.test.ts`,
and `client/test/foreign-turns.test.ts` (new):
- T-B0: the bracket property, pinned from `bracket.test.ts` (scenarios 1–4),
  asserted on the reducer's `out.turn`: every turn-scoped output has a
  non-null `turn` equal to its bracket; session-level ones are counted on both
  sides.
- T-Br (reducer, pure): a drained buffer `turn_start{X}`, chunk, `turn_end{X}`,
  `turn_start{Y}`, chunk in ONE step → the outputs carry X, X, X, Y, Y. RED: no
  field. **Mutation:** stamp from the step's final state → red.
- T-B1 RED: A prompts; B (attached, watching) gets a `turn` activity whose
  events are `user_message "hi"`, text, `turn_end`. T-B1b: A's turn errors →
  B's stream rejects with the same `RpcError` class.
- T-B2 RED: scripted frames — B's own prompt in flight, then `turn_start{Y}`,
  a chunk, then the `TurnInProgress` error. B's own stream holds no chunk of Y
  and rejects; Y's activity has the chunk. **Mutation:** route to
  `this.active` again → red.
- T-B3: attach mid-turn (gated tool) → `history_reset` then live, no
  `user_message`.
- T-B4: a drop mid-foreign-turn, covered `since` → each chunk once, one end.
- T-B5: tiny `ringBytes` → resync. Turn still running → the reset is in its
  stream; ended behind the cut → the stream closes with no `turn_end`,
  exactly once.
- T-B6: no `session/prompt` / `send_now` frame ever carries a foreign turn id
  across `recovered` (frame spy). **Mutation:** add foreign turns to
  `recovered`'s list → red.
- T-B7: a foreign unstarted send-now → no activity.
- T-B8: B `sendNow` during A's turn → `interrupt.turnId` = A's; B's successor
  is own, promoted at A's end.
- T-B9: A `send_now` on B's own turn → B's stream ends `cancelled`, then a
  foreign activity with the daemon's prompt.
- T-B10: `linkClosed` fails a foreign stream (no hang); `turn_lost` too.
- T-B11: `session_closed` idle → `closed{closed}`; mid-foreign-turn → the
  stream ends, then `closed`; a later `send` rejects "closed on another
  device".
- T-B12 (`cli/test/local-runtime.test.ts`): a foreign turn's end and an idle
  `history` each cause one save; RED before the hooks.
- T-B13:
  - (a) an eager `open()` of a 450-message session (3 pages) → one `history`
    activity with all 450. Activities raised before `watch` are delivered on
    subscribe. A fresh (non-attach) session's `open()` sends no
    `session/open`.
  - (b) attach to an archived and to an unknown id → rejects, and no
    `session/open` frame carries `create` or `messages` (frame spy).
  - (c) attach to a deleted id → rejects and `onSessionDeleted` fires.
  - (d) the link cut before the attach's response → the re-sent open has no
    `create`.
  - **Mutation:** let `openOn` recreate a never-live entry → (b) red.
- T-B14: an idle compaction → `history{compacted: true}`; a gap resync →
  `compacted: false`.
- T-B15: a `permission_request` inside foreign turn Y reaches the broker with
  `turnId: Y` and `ownsTurn(Y) === false`; inside own turn T, `ownsTurn(T)`.
  A request queued behind another and prompted later keeps its `turnId`.
  **Mutation:** pass the step's final `turn` → red on the drained-buffer case.
- T-B16: an enqueue during a foreign turn reaches the daemon bound to it
  (`steer` with my id shows in A's stream too).

**Step C** — `tui/test/foreign-turns.test.tsx` (new, a fake controller with
`watch` / `ownsTurn`), plus the pure tables in `turn-feed.test.ts`,
`state.test.ts`, `queued.test.ts`, `commands.test.ts`:
- T-C1 RED: a `turn` activity renders the bubble, the streamed text, the
  running line; then idle.
- T-C2: Enter during it → `enqueue`; Esc → `cancel`; Ctrl+C → `cancel`.
- T-C3: the permission dialog during a foreign turn: Ctrl+C cancels the turn
  (RED: today the dialog stays). T-C3b RED: auto-accept ON, a request with a
  foreign `turnId` → the dialog shows; an own one → auto-approved; one with
  no `turnId` under `ownsTurn` → the dialog shows. **Mutation:** ignore `own`
  in `autoApproves` → red.
- T-C4: an own prompt rejected `TurnInProgress` → the bubble is gone, the text
  is back in the field, the notice shows; the held foreign turn renders after.
- T-C5: `/exit` mid-foreign-turn exits without `cancel`. **Mutation:** drop the
  `foreign` input to `quitAction` → red.
- T-C6: rows = the daemon's list (a foreign row shown) + my unacked row; a
  foreign `steer` does not drop my row; my row carried by another device's
  send-now stays visible. T-C6b: no report → local rows only.
- T-C7: `closed` → the notice (closed / deleted wording).
- T-C8: a 20 000-message `history`: a key typed during the warm is echoed in
  the next frame (input live), and the final frame shows the tail; measured
  per-item cost on a realistic fixture (code, diffs, a spilled result) fixes
  `WARM_THRESHOLD`.
- T-C9: another device's send-now on my compaction → my rows back in the
  input, the foreign turn renders.
- T-C10: a foreign stream closing without `turn_end` → idle, no stop-reason
  line.
- T-C11: `history{compacted}` while idle and not mine → transcript kept +
  notice; mine → no extra notice.

### Notes / debt

*(re-plan 2026-10-25: the 2026-10-24 "Open items" O1/O2 are decided — owner Q5 and Q4)*

- O1 → its own small task after 6, before 12 (owner Q5): loop notes reappear
  as user bubbles after a reset (`tui/src/resume.ts`). Eager open makes it
  visible on every attach.
- O2 → later (owner Q4): progressive history, newest page first, after a WAN
  measurement.
- O3 — the first-layout cost per item was measured on synthetic text; T-C8
  re-measures it on today's renderer and real content before the threshold
  is fixed.
- No caller passes `attach` in this task (task 7's). Until then foreign turns
  reach a TUI only on a session another client opened by id (`session/list`
  + `open`).

### Questions for the owner (re-plan)

*— claude-opus-5-5, 2026-10-25*

- **QR1 — a compaction while idle: keep my transcript or replace it?** Today
  this TUI's own `/compact` keeps the scrollback (the idle reset is dropped)
  and adds "Context compacted". Once idle resets are rendered, the compacted
  history (one summary) would replace the screen. That holds whether the
  compaction was mine or another device's. **Recommend: keep the transcript
  and add a notice** ("compacted on another device" when not mine), the same
  as own `/compact` today. Only a non-compaction resync (eager open, a gap)
  replaces the screen. **Owner (2026-10-25): YES, keep the transcript + notice.**
- **QR2 — other writers' `returned` rows on the TUI.** Task 5 left "render
  them as returned to another device + an explicit reclaim act" to "task
  6/13". A reclaim act here would hit task 5's F2 duplicate (a closed
  session's rows already given to their writer). **Recommend: not in task 6.**
  The TUI renders only `entries` (every writer's waiting rows) and hands back
  only mine. Showing / reclaiming others' returned rows stays task 13's (the
  phone UX), where F2 must be solved first. **Owner (2026-10-25): YES, task 13.**
- **QR3 — `/clear` on a shared session.** `/clear` closes the session for
  every attached device (D3). With foreign turns, `/clear` is refused while
  any device's turn runs. But at idle it still ends the session the phone is
  viewing. **Recommend: keep it in task 6** (unchanged, D3). Whether `/clear`
  should detach instead belongs with task 7's `session/detach` and quit
  semantics. **Owner (2026-10-25): YES, unchanged here; decided in task 7.**
- **QR4 — Q2's "/exit leaves the foreign turn running" holds fully only with
  task 7.** The TUI will send no cancel. But `connect`'s exit path then calls
  `client.closeSessions()` (`connect.ts:133-137`), which closes the session
  and cancels the phone's turn. **Recommend: leave that to task 7** (the
  next task, whose "quit = just close the socket" ships with its TTL / detach
  tests). This task states the gap in its Execution and Review. Alternative:
  pull the one-line `connect.ts` change into 6 without task 7's tests. **Owner (2026-10-25): YES, task 7; state the gap in Execution/Review.**

## Execution

*— claude-opus-5-5, 2026-10-25*

Implemented in the plan's order A → B → C on `feat/tui-foreign-turns`
(uncommitted). Every file:line premise of the plan was re-checked before its
edit and held (line numbers drifted only by my own edits).

### Baseline

`bun run check` on `efc2e28` + the plan doc, started before any code edit:
typecheck clean, `biome check .` 464 files, 0 errors / 0 warnings. The test
run raced my first edit (the T-A tests were appended while it ran), so it
reported `2550 pass / 2 skip / 4 fail` over 2556 tests: the 4 fails are exactly
the 4 new RED T-A tests and the 2 extra passes the 2 new non-RED ones (T-A2b,
T-A4). Pre-existing suite = **2548 pass / 2 skip / 0 fail**, as expected.
Not re-taken on a clean tree (the run was interrupted by a session limit).

### Repro (before the fix)

`git checkout HEAD -- <file>` and `git show … > file` were refused by the
sandbox, so the "main" state was re-created by re-introducing main's exact
lines at the one spot (`output()` → `this.active`, `remote-session.ts:570`,
`:596-598` on main):

```
$ bun test .tentacle/tmp/tui-foreign-turns/race.test.ts     # main's routing
B's own send yielded 9 events: [text:A2, text:A3, text:A4, text:A5, text:A6, text:A7, …]
then threw: a turn is already running
$ bun test .tentacle/tmp/tui-foreign-turns/race.test.ts     # this branch
B's own send yielded 0 events: []
then threw: a turn is already running
```

On main the T-A1 test (below) got `turn_end{T2, cancelled}`: proof that a
protocol-11 daemon built before this task PARSES `{sessionId, turnId}` (strip
schema) and cancels blindly — the "older daemon ignores it" claim, observed.

### Step A — `session/cancel{turnId?}`

- `protocol/src/session.ts` `CancelParamsSchema.turnId: TurnIdSchema.optional()`;
  `protocol.json` regenerated (`bun run schema:export`: +`turnId` ref). No
  `PROTOCOL_VERSION` bump, no record change.
- `daemon/src/hosted-session.ts` `cancel(turnId?)`: absent → today's body;
  `=== activeTurnId && !compacting` → abort only (a reserved successor still
  starts); `=== successor.turnId` → `successor.cancelled` only; else no-op;
  `publishQueue()` last in every branch.
- `daemon/src/connection.ts` passes `turnId`; `client/src/remote-client.ts`
  `cancel(sessionId, turnId?)` (the field is omitted when absent).
- Tests (`daemon/test/send-now.test.ts`, describe "session/cancel — a cancel
  names its turn"): T-A1 (over the wire, RED), T-A2 (RED), T-A2b, T-A3, T-A4,
  T-A5 (RED). `protocol/test/methods.test.ts`: the field parses; an empty one
  is rejected; an older schema (`omit turnId`) strips it.
- Nuance: T-A3 as first written also asserted the successor's row in
  `returned`; wrong — a cancelled send-now's own texts leave the queue (its
  sender restores them). Assertion removed; T-A3 is green on main too (a
  blind cancel does the same), as the plan implies (not marked RED).
- Mutation: `Connection` drops `turnId` → T-A1 red (1 fail); reverted,
  `shasum` identical (`ee8eab4…`).

### Step B — client

- `session-reducer.ts` B1: each `update` output carries `turn` (start → its
  id; end → the id it closes, else null; other → the running turn as of that
  update). T-Br ×3 RED → green. **Mutation** (stamp from the step's final
  state) → 2 red; reverted, `2b5d09d…` identical.
- `core/src/permission.ts` `PermissionRequestOptions.turnId?` (laptop-only);
  `permission-router.ts` keeps `turnId` on the entry and the `prompt` action
  (`request(sessionId, update, turnId = null)`); `remote-client.ts` `deliver`
  passes `out.turn`, `runPermissionActions` passes `{signal, turnId}`. Router
  test RED → green. Broker untouched (one instance, one requester).
- `remote-session.ts` B2–B7: `streaming`, one `foreign` turn, `turnFor`,
  `route` (turn-scoped by stamp; `queued` / `session_title` /
  `background_exit` / permission events never routed; `history_replaced` →
  `compactedPending`; `session_closed` → `onClosed`), `onReset` (rule B2.5,
  `closeWithoutOutcome`), `startForeign`, `watch` (buffer until subscribe),
  `ownsTurn`, `open`, `remoteClosed`, `enqueue`/`sendNow` bound to
  `streaming ?? turnId`, `promote` on a foreign end, every own cancel names
  its turn; the `error`-frame cancel stays blind (P4).
- `remote-client.ts` B7: `newSession(…, {attach})`, `attachSession`,
  entry `attach`: `recover` of a never-live attach re-sends `{sessionId,
  reopen?}`; `openOn`'s `UnknownSession` → recreate only if
  `entry.attach === undefined || entry.everLive`.
- Added (drift, see below): `RemoteSession.onQueued(listener)`.
- `cli/src/local-runtime.ts` B8: `watch` (a foreign turn's events wrapped in
  `saved()`, a `history` flushes at once), `open`, `ownsTurn`, `onQueued`
  passthrough. T-B12 RED (0 saves) → green.
- `client/test/foreign-turns.test.ts` (new, real in-process daemon, several
  clients, frame spies): T-B0 (bracket pinned on `out.turn`: 0 violations,
  ≥4 turns, 1 unstarted end, `queued`/`session_title` inside AND outside,
  `history_replaced` outside only, 2 resets), T-B1, T-B1b, T-B2 (scripted
  frames), T-B3, T-B3b, T-B4+T-B6, T-B5, T-B5b+T-B14b, T-B7, T-B8, T-B9,
  T-B10, T-B11, T-B11b, T-B13 a–d, T-B14, T-B15, T-B16. 22 tests,
  `--rerun-each 5` → 110 pass.
- RED / mutations (each reverted, `remote-session.ts` back to `24441034…`,
  `remote-client.ts` back to `d7c83ce…`):
  - T-B2 RED with main's routing re-introduced: own stream held `"Y-chunk"`.
  - T-B1 RED with main's idle drop re-introduced (`turn_start` of an unknown
    id ignored): no activity (timeout).
  - T-B6: the plan's mutation alone (foreign in `recovered`'s list) stays
    GREEN — vacuous by construction, `turnRecovery` needs `acked`, which a
    foreign turn never is (B3's second guard). Stronger mutation (in the list
    AND `acked: true`) → red: a `session/prompt` with A's turn id left B.
  - T-B13: `openOn` recreates a never-live attach → (b) red (the unknown id
    resolved); `recover` sends `create` for a never-live attach → (d) red.
  - T-B15: `deliver` without `out.turn` → red. The plan's "step's final turn"
    mutation is T-Br's (the stamp is what `deliver` passes).

Existing tests changed (each is a planned behaviour change, never a weakened
property):
- `client/test/remote.test.ts` fake daemon streamed chunks with no
  `turn_start` — impossible for the real daemon (the load-bearing bracket);
  it now sends `turn_start` at seq 1 and shifts the frames.
- `client/test/reattach.test.ts` T-B5c / T-B5f pinned the latent routing
  bug: after a resync whose cut is at T1's end, the replay carries
  `turn_start{T2}` and T2's 60 deltas; main routed them to T1's stream
  (`this.active`), so T2 "had no start". Verified with a temporary log: the
  `turn_start{T2, prompt "A"}` IS delivered. Now T2 gets `user_message "A"`,
  the 60 deltas, `z`, its end; T1 holds none of them (asserted).
- `tui/test/send-now-app.test.tsx` T-D7b: C3's one rule replaces the old
  fallback notice; the test now checks the new notice, the text back in the
  input and the bubble gone.

### Step C — TUI

- `turn-feed.ts` (new, pure): `SessionActivity` (structural), `nextStep`,
  `historyAction`, `lostSlot` (by `SendNowErrorCode.TurnInProgress`, reused
  from `send-now.ts`), `commitWarmed`, `needsWarm`, `WARM_THRESHOLD`, the
  notices. `state.ts`: `withdrawUserTurn`, `endWithoutOutcome`. `queued.ts`:
  `acked`, `DaemonQueue`, `markAcked`, `shownRows`. `commands.ts`:
  `quitAction(…, foreign)`. `permission-ui.ts`: `autoApproves(req, own)`,
  `ownRequest`, `usePermissionBroker(permissions, ownsTurn?)`.
- `App.tsx`: `SessionController.watch?/open?/ownsTurn?/onQueued?`;
  `streamTurn(open, controller, StreamOpts{successor, foreign, own})` is the
  one loop; `onActivity` (hold / consume / history / closed), `drainHeld`
  (after a run settles, and in the send-now refusal idle branches),
  `commitHistory` (warm), `watchSession` (watch → onQueued → open; re-done on
  `/clear`), `/exit` passes `foreign`, enqueue ack → `markAcked`, rows render
  `shownRows(queued, daemonQueue)`, `loading history (i/N)…` line.
- Tests: pure tables (`turn-feed.test.ts` new, `state`, `queued`, `commands`)
  and `tui/test/foreign-turns.test.tsx` (new): T-C1, C2, C3, C3b, C3c, C4,
  C5, C6, C6b, C7, C8, C9, C10, C11, and "watch first, then open; a failed
  open is a notice". `--rerun-each 3` → 45 pass.
- RED / mutations (each reverted; `App.tsx` `dab2796…`, `permission-ui.ts`
  `f664849…`, `turn-feed.ts` `c11932e…` identical after; `turn-feed.ts` then
  got the threshold edit below):
  - main's TUI (no `watch` subscription): 11 of 15 red (T-C1, C2, C3, C4, C6,
    C7, C9, C10, C11, C9-open, C8); T-C3b/C3c/C5/C6b green (C5 vacuously:
    no foreign turn → an idle exit; it has its own mutation).
  - foreign turn without `abortRef` (main's dialog behaviour) → T-C2, T-C3 red.
  - `autoApproves` ignoring `own` → T-C3b red.
  - `/exit` without the `foreign` input → T-C5 red.
  - `nextStep` never holds → T-C4 + its table red.
  - rows from local only (`shownRows(queued, undefined)`) → T-C6 red.
- The pure functions that are new (`nextStep`, `shownRows`, …) cannot be red
  on an assertion before they exist; their RED is the App-level tests above.
  `quitAction` and `autoApproves` existed: their new cases are red on main.

T-C8 measurement (`.tentacle/tmp/tui-foreign-turns/warm.test.ts`, 4 000
rounds of: a prompt, an assistant reply with a 30-line code block and two
tool calls, a 40-line diff result, a spilled result, a closing reply):

```
$ bun test .tentacle/tmp/tui-foreign-turns/warm.test.ts
messages 20000, items 20000, warm total 17039 ms, 852.0 µs/item, worst chunk 10.0 ms
items laid out synchronously in 50 ms: 58
```

→ **`WARM_THRESHOLD = 50`** (the plan's start value 500 would be a ~0.4 s
stall on such content). The worst chunk (10 ms) bounds the stall; input stays
live (T-C8 echoes a key mid-warm). 20 000 heavy messages take ~17 s to warm:
a strong argument for O2 (progressive history), owner Q4.

### Gate (final)

`bun run check`: typecheck clean; `biome check .` 468 files, no fixes, 0
errors / 0 warnings; `bun test` **2617 pass / 2 skip / 0 fail** (9870
expects, 208 files). Baseline 2548 + 69 new tests; the 2 skips are the
opt-in ones.

### Drift from the Implementation, and nuances decided

1. **`RemoteSession.onQueued` / `SessionController.onQueued` added** (not in
   Files): C7 needs a subscription to re-render; the `queued` getter alone
   cannot. It filters `onSessionQueued` by id and gives the current state.
2. **`openOn` recreate guard** is `entry.attach === undefined ||
   entry.everLive`, not "everLive only": byte-equivalent for every non-attach
   path today (all of them send `create: true` while never live) and safer.
3. **A rejected `open()` resets its memo**: a later `open()` / `send` tries
   the attach again (never a create).
4. **`ownsTurn` also accepts `this.turnId`** (the last own id, kept after its
   end) besides active / next / settling.
5. **Unwatched activities**: a newer `history` supersedes an older unseen
   one in the buffer; foreign turns' queues buffer until consumed.
6. **`session_closed` after my own `close()` raises no `closed` activity**
   (`/clear` is no news to this device) — T-B11b.
7. **A compacted reset never goes into an own unstarted turn** (it becomes a
   `history{compacted}` → notice only), so QR1 "keep the transcript" holds
   even if my prompt is in flight.
8. **"Mine" for a compaction notice** is a counter of my `/compact`s whose
   history has not arrived (decremented on that history or on a failed
   compaction), not `compactingRef`: the history arrives after the
   barrier's snapshot, usually AFTER `compact()` resolved and cleared
   `compactingRef`.
9. **A history while a run of mine is in flight is held** (like a turn),
   unless compacted (a notice never waits); activities are also held while a
   long history warms.
10. **A continuation (auto-wake) that loses the slot** ends silently (no
    bubble to withdraw, no text to restore).
11. **T-B3 split**: the reset names the turn only after its first commit.
    Attached earlier, the cut predates the turn's start: `history`, then the
    turn WITH its prompt bubble (not in the snapshot: never lost, never
    twice) — T-B3b.
12. **T-B0 non-vacuity** uses explicit counts (turn-scoped outputs > 0, two
    resets) instead of a raw update count.
13. **No test-only "dropped unrouted" counter** in `RemoteSession`: T-B0 pins
    the property on the reducer's output directly.
14. **The foreign activity's `cancel()` reads `this.id` lazily** (a turn can
    be announced during the first open); a cancel while the link is down is
    lost, like any notification.

### QR4 gap (stated, unchanged here)

`/exit` during a foreign turn now sends no cancel (T-C5). But `connect`'s exit
path still calls `client.closeSessions()` (`cli/src/connect.ts:133-137`),
which closes the session and so ends the other device's turn. Left to task 7
as decided; `connect.ts` is untouched.

### Open items for the owner

- **The `error`-frame cancel is still blind (P4, as planned)**: a frame this
  client cannot parse during ANOTHER device's turn fails that stream here AND
  cancels the phone's turn. Option: in task 7 or 13, send it only while an
  own turn is in flight (or name the own turn).
- **The warm cost** (17 s for 20 000 heavy messages) supports doing O2 soon.
- No caller passes `attach` yet (task 7), so eager open is covered by
  client tests and a fake TUI controller only.

## Review

> **Owner decision (2026-10-24): APPROVED as ONE task, no split** (L · load-bearing; strong model, mandatory fresh-context Review). Branch `feat/tui-foreign-turns`; the 6a/6b/6c sections become the implementation order inside one branch (their dependencies — 4c, 4d, task 5 — are merged before 6 in the current order; re-verify). Q1 yes: `session/cancel{turnId?}` (a late Esc never stops a turn another device just started; additive, no bump). Q2 yes, as the owner understood it: Ctrl+C / Esc = "stop what is running", whoever started it (a foreign turn too — the other device sees it interrupted); `/exit` = "I leave, everything stays as it is" (the foreign turn goes on daemon-side). Only `serve`/`connect` sessions have foreign turns. Q3 yes: Shift+Tab auto-accept applies only to own turns; a foreign turn's permissions are always asked. Q4 later: progressive render of the latest history page, after measuring on a slow network. Q5 yes: loop notes that reappear as user messages after a reset → a small task after 6, before 12. Task 5 was approved as ONE task too (no 5b): read "5b" in this plan as task 5.

### Adversarial review

*— claude-opus-5-5, 2026-10-25 (fresh context; SAME model as the executor, so
blind spots we share can survive both passes)*

**Verdict: APPROVE-WITH-NITS.** No finding blocks the merge. Finding 1 needs
an owner decision (when to do it, not whether the code is right as planned).
Findings 2–5 are low or nit.

#### Gate (re-run by the reviewer on the working tree)

`bun run check`: typecheck clean · `biome check .` 468 files, no fixes, 0
errors / 0 warnings · `bun test` **2617 pass / 2 skip / 0 fail**, 2619 tests
over 208 files (113.8 s). The 2 skips are the opt-in ones. This matches
Execution. Flakiness: `--rerun-each 3` on `client/test/foreign-turns.test.ts`,
`tui/test/foreign-turns.test.tsx` and `client/test/reattach.test.ts` gave
240 pass / 0 fail.

#### Findings

1. **Low · owner decision. The `error`-frame cancel is still blind**
   (`client/src/remote-session.ts:751`). This was planned (P4) and the
   executor disclosed it. With foreign turns, a frame this TUI cannot parse
   while the PHONE's turn runs makes the TUI cancel the phone's turn. The
   user did nothing, so this goes against the spirit of Q1/Q2 ("a late Esc
   never stops a turn another device just started"; "`/exit` leaves it
   running"). It can be reached only through a malformed known-type frame or
   a mandatory kind that was not version-bumped, i.e. a daemon bug inside the
   same protocol version. The fix is cheap (`cancel(id, <own turn id>)`, or
   no cancel while only a foreign turn streams). **Owner:** do it in this
   task, or in task 7/13 as Execution proposes? **Owner (2026-10-25): task 7.** My recommendation is task 7:
   the risk is low and the plan is already approved.
2. **Low. "Mine" for a compaction notice is a counter, and the counter can
   drift** (`tui/src/App.tsx:1049-1052`, `:1373`, `:1381-1382`). It is safer
   than `compactingRef` (mutation M5 below proves the counter is load-bearing
   for T-C11). Two races still skew it. (a) My `/compact` loses the slot to
   the phone's compaction, and the phone's `history{compacted}` arrives
   before my `CompactInProgress`: the counter takes it as mine, and the
   `>0` guard leaves it at 0. Result: no "compacted on another device"
   notice. (b) The link drops across my own barrier: the resync arrives as
   `compacted: false`, so the transcript is replaced and the counter stays
   at 1. Result: the NEXT foreign compaction gets no notice. Both are
   cosmetic: the transcript decision still follows the daemon's
   `history_replaced` fact, and nothing is lost. A fix would be a pure
   counter in `turn-feed.ts`, or a daemon-echoed compaction id later. No
   change is required.
3. **Nit. Some logic sits in `App.tsx`** (AGENTS §7 "logic lives in pure
   modules"). The decisions are pure (`nextStep`, `historyAction`,
   `lostSlot`, `commitWarmed`, `shownRows`, `quitAction`, `autoApproves`).
   But three pieces live in the component: the `inFlight` predicate and the
   `drainHeld` gating (`App.tsx:772`, `:1035-1044`), the counter arithmetic
   of finding 2, and the warm loop. The warm loop copies the existing resize
   pattern. The key handler only gained a `foreign` argument, so it did not
   grow. Extract these together with the known key-handler debt.
4. **Nit. Every own prompt refused `TurnInProgress` before it streams gets
   `SLOT_LOST_NOTICE` "another device started a turn"**
   (`tui/src/turn-feed.ts:85`). That includes a case where this TUI's own
   earlier turn still runs daemon-side after its stream failed locally. The
   text comes back either way (T-C4 and T-D7b), so only the wording is wrong.
5. **Nit. A turn-scoped update with no bracket is dropped silently**
   (`remote-session.ts:942-946`). The plan's test-only counter was dropped
   (drift 13). T-B0 pins the daemon property instead, which is acceptable.
   But a daemon bug that breaks the bracket would now hide output instead of
   showing it. The `remote.test.ts` fixture change (adding `turn_start` and
   shifting seqs) only brings the fake into line with the real daemon's
   bracket. Its assertions are unchanged, so nothing was loosened.

**QR4 gap confirmed and unchanged.** `cli/src/connect.ts:136` still calls
`client.closeSessions()` on exit, so `/exit` mid-foreign-turn sends no cancel
(T-C5), but `connect` then closes the session. This belongs to task 7, as
decided.

#### Pre-existing tests that were changed: corrections, not loosenings

- **T-B5c** (`client/test/reattach.test.ts:1341`). The cut is at T1's end,
  so T1's `turn_end` is behind it, and the replay carries `turn_start{T2}`
  and 60 deltas. On main these went to `this.active` (T1). The old test
  pinned `nextEvents == [z, end]`, which silently encoded "T2 lost its
  prompt and 60 deltas". The new test keeps every old assertion. It also
  asserts that T1 holds neither `z` nor `0 `, and that T2 gets
  `user_message A`, all 60 deltas, `z` and its end. Strictly stronger.
- **T-B5f** (`:1503`). The old assertion "no `user_message`" (the start was
  hidden) was the bug. The new one asserts exactly ONE `user_message A`, and
  the existing check that "A" appears once in the snapshot is kept. This
  pins "never twice" too.
- **T-D7b** (`tui/test/send-now-app.test.tsx:831`). The test now checks the
  new notice, `❯ A` back in the input, and no `› A` bubble. That is more than
  the old notice-only check.

#### Mutation non-vacuity (reviewer's own; each one reverted)

| # | Mutation | Result |
|---|---|---|
| M1 | `route`: a turn-scoped update goes to `this.active` first (main's routing) | Race repro → **9** A-chunks in B's own send (branch: **0**); T-B2 **red** |
| M2 | `ownRequest`: a request with no `turnId` counts as own | T-C3b **red** |
| M3 | `ownsTurn` also true for `this.foreign` | T-B15 **red** (and T-B1) |
| M4 | `HostedSession.cancel`: a named cancel aborts whatever runs | T-A1, T-A3, T-A5 **red** |
| M5 | compaction "mine" from `compactingRef` instead of the counter | T-C11 **red** |

After the reverts, `git status --short` and the `shasum` of all 31
changed/new files under `packages/` and `docs/` were identical to the
pre-review snapshot.

#### Premise table (spot-checked against the code)

| Premise | Verdict |
|---|---|
| Context symptom: foreign chunks in my own turn (Repro 2) | TRUE. Reproduced through the real `RemoteClient` ↔ `SessionHost` stack with main's routing (M1): 9 events. Branch: 0 |
| `remote-session.ts:570-578` idle drop, `:596-598` route to `this.active` (main) | TRUE (removed lines in the diff) |
| `hosted-session.ts:1165-1175` one slot; `:1173` `TurnInProgress` | TRUE |
| Snapshot `turn` is the turn **at the cut** (`snapshotPage`, `:836` `cut.turnId`) | TRUE. This is what makes the reset stamp exact |
| Pending ask sits past the cut and is replayed after a reset (`hosted-session.ts:20-29`) | TRUE. So a replayed request is stamped with the cut's turn and the replay's brackets |
| `session/cancel` is a blind notification (`connection.ts:399-408`, `hosted-session.ts:1552`) | TRUE on main; now named |
| `protocol/src/updates.ts:237` `permission_request: "blocking"`; TUI declares all (`remote-client.ts:888` on main) | TRUE |
| `PROTOCOL_VERSION` 11 (`version.ts:7`); strip `CancelParamsSchema` | TRUE. The field is additive, there is no bump, and `protocol.json` was regenerated |
| `connect.ts:133-137` still closes on exit | TRUE (`:136`) |
| Bracket property (T-B0 / `bracket.test.ts`) | TRUE. Re-run: 263 updates, 6 turns, 0 violations, 1 unstarted end |
| T-C8 cost | TRUE. Re-run: 20 000 msgs, 16.9 s, 846 µs/item, worst chunk 10.1 ms, 59 items/50 ms → `WARM_THRESHOLD = 50` is justified |

#### Attacks tried

1. **Single broker and Q3, a request racing a turn boundary** (security).
   The stamp is the reducer's `state.turn` *at that update*, set by
   `turn_start` and cleared by the matching `turn_end`, in the daemon's seq
   order. A gap forces a reopen, so a missed `turn_end` can never leave a
   stale stamp. Sequences checked: `turn_end{mine}`, `turn_start{Y}`,
   request → stamped Y. A request replayed after a reset → stamped with the
   cut's turn, or with the replay's `turn_start`. The router keeps the
   stamp while the request is queued. `ownsTurn` matches by minted id only:
   a foreign id never becomes own. A missing stamp is ASKED (fail-safe, M2).
   After `/clear`, a pending old request is judged against the new session,
   which is also the safe direction. No new `PermissionBroker` and no new
   requester (grep of the `src` diff). **Holds.** I found no path where a
   foreign request is auto-accepted.
2. **One session path.** Foreign turns are the same `ActiveTurn`, with
   `onUpdate`/`end`/`fail`, consumed by the same `streamTurn`. `onQueued` is
   a filter over the existing `onSessionQueued`. `turn-feed.ts` only makes
   decisions. A foreign turn is never `sent` or `acked`, so `recovered`
   cannot re-send it (T-B6 with the stronger mutation). **Holds.**
3. **Q1, a late Esc.** An own cancel names its turn (`runTurn`, `sendNow`,
   the ack-time re-send). A foreign cancel names the foreign id. A stale id
   is a no-op daemon-side (M4). **Holds**, except for the blind error-frame
   cancel (finding 1).
4. **Interleavings.** A hand-off on a foreign turn: `promote` accepts a
   foreign end when no own turn is in flight. A foreign turn ended behind a
   resync cut: `closeWithoutOutcome`, then `endWithoutOutcome`, with no
   guessed reason. A reset naming my successor while a foreign turn was
   shown: the foreign turn closes, then the successor is installed. An own
   prompt that lost the slot: the foreign turn is HELD, then drained in
   `finally`. I traced every `drainHeld` exit path (`exitPending` → exit; a
   settled send-now → its successor's `finally` drains). None strands held
   activities. **Holds.**
5. **The eager open never creates (2a).** `recover` of a never-live attach
   sends no `create`. `openOn` does not recreate a never-live attach. A
   failed `open()` resets its memo, and `runTurn` retries the attach, never
   a create. **Holds** (the executor's T-B13 mutations; code read).
6. **Perf and the render thread.** The warm yields every ≤ 10 ms, and
   `warmingRef` is set before the first `await`. Activities wait during the
   warm. An own prompt typed during it is kept after the history
   (`commitWarmed`). No raw terminal writes and no peer lock were added
   (grep). Input stays live, but 20 000 heavy messages take about 17 s to
   appear: owner Q4 (O2).
7. **Task 5 queue contract.** `rowsRef` is still what send-now sends (mine
   only). `onSteer`/`onTurnEnd`/`handBackRows` act on local rows.
   `shownRows` adds only the display. An acked row the daemon no longer
   lists is hidden, since it was drained or returned. A returned row comes
   back through `onReturned`, which is unchanged. **Holds.**

#### How the executor behaved

The executor followed the plan's order and was honest about drift (14 items,
each with its reason). Each RED test was shown by re-introducing main's exact
lines, after `git checkout` was refused. The executor caught that the plan's
T-B6 mutation was vacuous, and strengthened it instead of reporting a fake
red. One weakness: the baseline was not re-taken on a clean tree. My gate run
covers that, and the suite count reconciles (2548 + 69 = 2617). The two
halves of the session (the account switch at turn 287) fit together: no
leftover markers, one consistent style across step A/B and step C, and the
Execution section matches the code I read.
