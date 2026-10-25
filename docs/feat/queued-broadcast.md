# feat/queued-broadcast — every attached client sees the session's queued steers

> **Status:** implementation (re-plan after the owner's Q1, awaiting approval)
> **Branch:** `feat/queued-broadcast` (ONE task, owner decision 2026-10-24)
> **Type:** feat · **Size:** **L** (re-plan 2026-10-24: was M; the writer rule adds a method, a record bump, the client hand-back and a TUI change — 4 packages + protocol, see *Files*) · **Blast:** **load-bearing** (the daemon's steering mirror, the end-of-turn and hand-off stretches of `finishTurn`, the snapshot cut, the daemon record, the protocol — AGENTS §7) · **Suited:** strong model + mandatory fresh-context Review that red-teams the steering no-await window, the send-now hand-off, the cut, the record bump and "handed back at most once"

Parent: `docs/eval/mobile-app.md` decision 21 row 5 (S · load-bearing), decisions 5
("everyone sees everything") and 15 ("Every device sees every device's queue …
needs a new display update … no `PROTOCOL_VERSION` bump"). Builds on
`docs/eval/send-now.md` (D4 + addendum) and `docs/feat/send-now-a.md` /
`send-now-b.md` (merged). Composes with the unmerged 4c / 4d plans
(`.tentacle/tmp/plans/send-now-c.md`, `send-now-d.md`).

## Context

*— claude-opus-5-5, 2026-10-24*

**Why.** A queued steer is visible only to the client that typed it. The
TUI's rows are its own optimistic list (`tui/src/App.tsx` `queued: string[]`,
per `docs/eval/send-now.md` "How queueing works today"). The daemon streams a
steer only when it is **injected** (`steer`, `protocol/src/updates.ts:80-84`).
Nothing streams when a steer is **accepted**, carried over by a send-now, or
dropped. Decision 15 requires that every device sees every device's queue, in
order, and sees each row leave it. Decision 5 requires that a late attacher
sees the same as everyone else.

**What the daemon knows today (verified on `main` @ `24c13c6`):**
- The agent's queue is private: `Session.enqueue` pushes, `pendingSteering()`
  copies (`agent/src/session.ts:137`, `:142`). `send` replaces it with
  `opts.steering ?? []` (`:91`), and `resume` keeps it (`:116`).
- The daemon mirrors it as **ids only**: `steeringIds: (string | undefined)[]`
  (`daemon/src/hosted-session.ts:228-233`). `undefined` marks a restored
  steer, whose id is not on disk (`:352-356`). The mirror is pushed by
  `enqueue` (`:1133-1135`), shifted on each `steer` (`:1033-1039`), reset by
  `prompt` (`:802-803`) and rebuilt by `startSuccessor` (`:916-938`).
- The rows of a reserved send-now live in `Successor.messages` / `.steers`
  (`:135-143`). They are not yet in the agent's queue.
- **Latent ambiguity.** A turn that ends with undrained steers and no send-now
  waiting (Esc, an error) leaves them in the agent's queue (`session.ts:91`
  only resets at the next `send`). From there, two different things can happen:
  - a later `prompt` drops them (`hosted-session.ts:803`, `session.ts:91`);
  - a later `send_now` on a free slot **resurrects** them. `sendNow` → `settleSuccessor`
    → `startSuccessor` seeds `pendingSteering()` minus the caller's ids
    (`:861-869`, `:918-925`), even after a compaction ran in between.

  So "are they still queued?" has no single answer today. A broadcast of the
  queue needs one (see *Design*, D-drop).
- Recovery is snapshot + replay at a cut (`hosted-session.ts:31-39`). The cut
  moves only in synchronous stretches (`recordCut` `:725-733`,
  `historyReplaced` `:1189-1208`). The client applies the snapshot, then the
  buffered updates **past `since`** (`client/src/session-reducer.ts:15-16`,
  `:311-321`). Updates at or before the cut are dropped. So anything a snapshot
  must convey about non-history state has to be **recorded at the cut**.
- 4c (in review) gives each TUI row the id it was enqueued with, and names this
  task's seam: "Task 5's broadcast would feed the same model with other devices'
  rows (read-only, not sent by my send-now: D4)" (`send-now-c.md:87-90`).

**Repro (capability missing)**, 2026-10-24, on `main` @ `24c13c6`: a search for
`queued` in `packages/{protocol,daemon,client}/src/**` returns only prose and
unrelated identifiers. No update type, snapshot field or client state carries
the queue. Matches: `remote-session.ts:72,172`, `permission-router.ts:9`,
`ws-server.ts:38`, `session.ts:335,351,364`, `updates.ts:80` (the `steer` doc
comment), `hosted-session.ts:17,227,300,349,558,932,969,1113,1133` (the
`enqueued` id set and comments), `persisted-session.ts:232,234,256`,
`connection.ts:208`, `proxy-model.ts:19,80`.

**The feasibility repro was not run, because of a permission limit.** The plan
was to copy the repo into `.tentacle/tmp/queued-broadcast-plan/` and run the
daemon/client suites with a stub `queued` emit, to count the existing tests that
assert exact update sequences. The copy needed an approval that was not
granted. Static substitute: the only whole-stream ordering assertions that the
new update can break are found by searching for
`.type)).toEqual|kinds[i + 1]` (*Tests*, "existing guards"). The executor's
first step re-runs that search and the suites after the first emit is wired
(see O1).

**Re-plan note (re-plan 2026-10-24).** The line numbers above are as of
`24c13c6` and are superseded: 4c, 4d, 2a (`session-archive`) and 3
(`session-titles`) moved every file. The Implementation below is re-verified
on `main` @ `49a53f4` and cites today's lines. The facts above still hold,
with three additions found by the re-check:
- **The writer's own Esc also drops its rows silently today.** The TUI's Esc
  only aborts (`tui/src/App.tsx:1424-1426`); at the turn's end the rows are
  cleared (`App.tsx:741`, `:745` → `queued.ts:72` `onTurnEnd = () => []`). So
  the 4a `endUnstarted` gap (another device's Esc / cancelled send-now,
  `send-now-c.md` Execution follow-up 3, test F-7 `daemon/test/send-now.test.ts:1118`)
  is one case of a wider rule: **any** turn that ends with undrained steers
  drops them. The agent's late drain means an `end_turn` never leaves one
  (`agent/src/agent.ts:573-579`), so the cases are: a cancel (Esc, another
  client's send-now that is then cancelled, `close`), an error, a limit, a
  hook stop. `daemon/test/persistence.test.ts:688-690` pins the drop on
  purpose ("a steer still queued at a cancel is dropped (by design …)").
- **A turn cut short by a crash or by a close keeps its steers as user
  messages** in the history when the record is reloaded/reopened
  (`persisted-session.ts:396-398`; `HostedSession.archive` keeps the turn's
  steering from before the close, `hosted-session.ts:1493-1498`). That is
  "delivered, unanswered": the next prompt — anyone's — answers them.
- **Task 3 set the client precedent** for session state that is not
  turn-scoped: the `session_title` update and the snapshot's `title` feed
  `RemoteClient.titleChanged` / `titleRead` and a listener
  (`client/src/remote-client.ts:1107-1123`, `:1381-1384`, `:1275-1276`;
  `RemoteSession.onTitle`, `remote-session.ts:128-137`), never the reducer.
  The queue follows it (the original 5b's reducer route is dropped).

## Implementation

*— claude-opus-5-5, 2026-10-24 (re-plan 2026-10-24: every subsection below is re-planned for the owner's Q1 and re-verified on `main` @ `49a53f4`)*

Line references are `packages/daemon/src/hosted-session.ts` unless a file is
named.

### Load-bearing assumption

*(re-plan 2026-10-24)*

**Within one synchronous stretch of the daemon, the `{id, text}` mirror equals
the agent's pending steering, in order, and every change of the queue state —
the rows queued AND the rows returned to their writer — happens in a stretch
that also emits it and is recorded at every cut. So: (1) a full-state update
emitted on every change, plus a cut that stores the last emitted state, gives
every client the exact queue and the exact returned set with no client-side
inference — live, re-attached with `since`, resynced, or attaching late; and
(2) a turn that ends with undrained steers and no live successor moves them to
`returned` in the same stretch as its end, so the agent's leftover queue is
never read again and "still queued?" has one answer: no — they are with their
writer.**

Proof (today's code):
- **Mirror = agent queue.** Every `steer` the agent yields comes from a
  `drainSteering()` splice, one per text, in order (`agent/src/agent.ts:442-444`,
  `:459-461`, `:573-577`, `:620-622`, `:679-681`; the drain is
  `steering.splice(0)`, `agent/src/session.ts:96`, `:123`). Every agent-queue
  push is paired with a mirror push in the same stretch: `enqueue`
  (`:1354-1356`) and the resume seed (`:397-401`). Every agent-queue
  replacement is paired with a mirror replacement: `prompt` (`:859-866`) and
  `startSuccessor` (`:1026`, `:1042-1047`). `drive` shifts the mirror on every
  `steer` (`:1121-1127`). Pinned by F2 and its mutation R7
  (`daemon/test/send-now.test.ts:1004-1006`).
- **The leftover is never read again once returned.** The agent's queue keeps
  the leftover until the next `send` replaces it (`agent/src/session.ts:91`).
  Today it is read in exactly two places: `startSuccessor`'s seed
  (`:1006-1013`, the resurrection path) and `persistedState` (`:609`). The
  re-plan makes both read the mirror instead, which the end of the turn
  empties (*Design* D-return). Every turn start passes its queue explicitly
  (`prompt` → `send` with no `steering` → `[]`, `:863`; `startSuccessor`
  → `steering: seed`, `:1045`).
- **Every change can emit synchronously.** `emit` is synchronous, numbered,
  ringed and fanned out with no `await` (`:798-809`). Each mutation site is
  synchronous: `enqueue` (`:1333-1358`), `drive`'s `steer` branch (inside the
  loop body, `:1121-1131`), `finishTurn` (`:1167-1194`), `sendNow`
  (`:885-935`), `settleSuccessor` / `startSuccessor` / `endUnstarted`
  (`:984-1069`), `compact`'s `finally` (`:1393-1404`), `cancel`
  (`:1434-1439`), `close` (`:1451-1482`), and the new `reclaim`.
- **The cut moves only in synchronous stretches:** `recordCut` (`:780-788`,
  called from `drive` `:1113` and `finishTurn` `:1184`), `historyReplaced`
  (`:1412-1431`) and the constructor (`:370-375`). A cut that stores
  `lastQueued` (the last state emitted, seq ≤ `cut.seq`) is exactly the state
  "after every update ≤ cut.seq" — the history slice's contract.
- **The client side is ordered by seq.** Snapshot, then the buffered updates
  past `since` (`client/src/session-reducer.ts:311-321`); a gap resyncs
  (`:212-219`). A full state applied in seq order converges to the last one.

**Held statically.** Decisive empirical tests: **Q6** (a late attacher whose
cut is past the last `queued` update: mutation M2 drops `queued` from
`snapshotPage` → red) and **Q3** (Esc with a row left: `returned` names it,
the agent's leftover is never seeded by a later send-now — Q8; mutation M3
skips the move → both red).

### Preconditions

*(re-plan 2026-10-24: P3, P5, P7 changed; P8–P10 new)*

- P1: **Concurrent dispatch, never serialized** (§7; `transport/peer.ts:322`).
  Every new daemon statement is synchronous; `session/reclaim` is a
  synchronous handler like `enqueue` (`daemon/src/connection.ts:228-233`).
- P2: **Steering no-await window** (`:1088-1094`, `agent.ts:560-572`). The new
  work in `drive` and `finishTurn` is synchronous state + `emit` + the
  `persist` capture (already there, `:1188`). No `await`, no microtask.
- P3: **Send-now atomicity.** `turn_end{old}` is immediately followed by
  `turn_start{successor}` (T-A1 `send-now.test.ts:216`, T-A1b `:289`). So every
  `queued` update of a turn's end is emitted **after** `settleSuccessor`
  (`:1190`), never between the two. The writer rule needs no update before
  `turn_end`: the writer's client keeps its own texts (*Design*, client), so
  the order "rows cleared at `turn_end`, then handed back" is safe.
- P4: **An aborted turn never drains again** (`docs/eval/send-now.md` P4). A
  steer accepted by an aborted, still-unwinding turn (`enqueue` checks only
  `controller` and `activeTurnId`, `:1351`) is therefore a leftover at its
  end: returned, or carried by a live successor.
- P5: **Display class rule** (§7; `protocol/src/updates.ts:184-216`).
  - A new `display` type needs no bump; an older client shows `unsupported`
    once per kind.
  - The ring and the seq are shared (`:798-809`); a skipped seq is a gap that
    resyncs (`session-reducer.ts:215`). So no per-attachment frame filtering.
  - **`queued` is honestly `display`**, also with `returned` in it: a client
    that skips it loses nothing daemon-side (the rows stay in `returned`,
    persisted, until reclaimed, and the snapshot carries them), hangs nothing,
    and the daemon waits on nobody (a reclaim is a request; no timer, no
    fallback). It is not `mandatory`: an older client failing turns loudly
    would be worse than today's behaviour, which it keeps. Not `blocking`:
    nothing waits.
- P6: **Strip schemas; methods are free** (§7). The optional `SnapshotResult`
  field is dropped by an older client; an unknown `session/reclaim` would be
  `MethodNotFound` — never reached, since only a daemon that sends `returned`
  is ever asked to reclaim.
- P7: **Persistence (§7).** The queue is not a `ChatMessage`: the laptop never
  persists it. The daemon record carries the turn's steering texts
  (`persisted-session.ts:36-41`) and, after this task, their ids and the
  `returned` rows: a record shape change → `DAEMON_RECORD_VERSION` 3 → 4
  (`persisted-session.ts:22`). Pod daemons and the in-process worker persist
  nothing (no persister, `hosted-session.ts:574-578`): there `returned` lives
  in memory and dies with the daemon.
- P8 (new): **Writer identity = the enqueue id.** The daemon's only per-row
  identity is the `session/enqueue` `id` (`protocol/src/session.ts:463-468`)
  or a send-now message `id` (`:505-510`), minted by the client
  (`client/src/remote-session.ts:186-199`). There is no per-attachment or
  per-device identity (one token, one principal; `Connection` holds none,
  `connection.ts:86-93`), and a connection identity would not survive a
  reconnect. So "the writer" is **the `RemoteSession` that sent that id** — it
  knows that exactly, and nobody else can claim to. No device label
  (decision 5).
- P9 (new): **The 4b contract stays.** A send-now cancelled before it started
  ends `{cancelled, delivered:false}` and its OWN client restores its messages
  and the steers enqueued to it (`:1054-1069`, `remote-session.ts:634-646`).
  Those ids are never put in `returned` (no double hand-back).
- P10 (new): **The laptop's record parser keeps extra fields**
  (`agent/src/session-store.ts:277-317`: "Extra top-level fields are kept"),
  so `returned` and `turn.steeringIds` pass the store and are checked by
  `parseDaemonRecord`.

### Design

*(re-plan 2026-10-24: D-drop → D-return; `returned`, `session/reclaim`, the
record bump, the client hand-back and the TUI are new; the client route
follows task 3 instead of the reducer)*

**Row identity = the client's own enqueue key** (unchanged). A row is
`{ id, text }`, exactly the `SendNowMessage` a send-now cites
(`protocol/src/session.ts:505-510`). "Mine" = an id my `RemoteSession` sent.
A restored row from a **v1–v3** record has no id on disk: the daemon mints one
at the reload (`crypto.randomUUID()`), so it is nobody's. A **v4** record
carries the ids, so a writer still recognises its rows after a daemon restart
(the owner's Q4).

**The rule (owner, Q1).** A row left in the queue when its turn ends — and no
live send-now takes it over — goes back to its writer: it leaves the queue
into `returned`, the daemon reports it, the writer's client puts it back in
the input (PC: joined, with a notice; phone: task 13), and it is **never
re-sent by itself**. A live send-now hand-off still carries foreign rows into
the successor (D4, T-A4 `send-now.test.ts:377`): that is the conversation the
writer was steering continuing at once, not "the next turn, whoever starts
it".

**Shape: one full-state display update, plus the state at the cut.**
```ts
// protocol/src/session.ts
export const QueuedEntrySchema = SendNowMessageSchema;           // {id, text}
/** Why a row went back to its writer (a daemon fact, for the notice). */
export const ReturnCauseSchema = z.enum(["cancelled", "failed", "ended"]);
export const ReturnedEntrySchema = QueuedEntrySchema.extend({ cause: ReturnCauseSchema });
/** The session's queue NOW: rows waiting, in delivery order, and rows back with their writer. */
export const QueueStateSchema = z.object({
  entries: z.array(QueuedEntrySchema),
  returned: z.array(ReturnedEntrySchema),
});
// SnapshotResultSchema, first page only (like `since`, `turn`, `title`):
queued: QueueStateSchema.optional(),

// protocol/src/updates.ts — replaces any earlier state
export const QueuedUpdateSchema = QueueStateSchema.extend({ type: z.literal("queued") });
UPDATE_CLASS.queued = "display";            // P5

// protocol/src/session.ts + methods.ts — new method "session/reclaim"
export const ReclaimParamsSchema = z.object({
  sessionId: SessionIdSchema,
  ids: z.array(z.string().min(1).max(128)).min(1),
});
export const ReclaimResultSchema = z.object({});
```
- `cause`: `cancelled` — the turn was cancelled (Esc, a send-now then
  cancelled); `failed` — it ended with `error`, `max_tokens`, `max_iterations`
  or a hook stop; `ended` — the session was closed/deleted or the daemon
  restarted. A daemon fact; the TUI words the notice from it (*TUI*).
- Full state, not deltas (unchanged reasons): convergence after any loss,
  order and leave events carried by the ordered stream, a row's id kept
  across a hand-off. Contract in the schema comment: a row leaves `entries`
  in the `queued` that follows its `steer` (delivered), the send-now
  `turn_start` whose prompt carries it (sent now), or its turn's `turn_end`
  (then it is in `returned`, or — a cancelled send-now's own row — restored by
  its sender through `delivered:false`). A row leaves `returned` in the
  `queued` that follows a `session/reclaim` of it, or a send-now that carries
  it in its prompt.

**Daemon (`HostedSession`).**
1. **The mirror carries texts.** `steeringIds` (`:259-264`) becomes
   `queue: { id: string; text: string }[]`. The resume seed (`:397-401`) pushes
   the record's ids (v4) or minted ones (v1–v3). `startSuccessor` seeds from
   `queue` instead of zipping `pendingSteering()` with ids (`:1004-1013`), and
   `drive` shifts `queue` (`:1121-1127`). `refusal` reads `queue` (`:966`).
   `persistedState` writes `turn.steering` and `turn.steeringIds` **from the
   mirror** (`:609`), so they cannot disagree.
2. **D-return (replaces D-drop).** New state
   `returned: { id; text; cause }[]` (ordered, oldest first). In `finishTurn`,
   inside `if (this.activeTurnId === turnId)` (`:1175-1180`), before the
   `turn_end` emit and so before `recordCut` and `persist` (`:1182-1188`):
   - if a **live** successor waits (`successor !== null && !successor.cancelled
     && !closed`): nothing moves — the rows are carried (D4);
   - else: `returned.push(...queue minus successor?.messages ids minus
     successor?.steers ids, with cause)` and `queue = []`. The `minus` keeps
     P9: a cancelled send-now's own rows are restored by its sender only.
   - `cause` from the outcome: `closed` → `ended`; `stopReason "cancelled"` →
     `cancelled`; anything else → `failed`.
   Effect: Esc, an error, another device's cancelled send-now (the 4a gap) and
   a `close` all hand the rows back; a later `send_now` on a free slot seeds
   from the empty mirror (no resurrection, Q8). `prompt`'s reset (`:860`)
   stays as a no-op guard.
3. **`returned` leaves only by an explicit act.**
   - `reclaim(ids)` (new, synchronous): drop those ids from `returned`;
     unknown / already gone → ignored (idempotent, a no-op success). Then
     `persist()` and `publishQueue()`. Not gated by "who" (P8: one principal);
     the client only ever reclaims its own (*Client*).
   - `startSuccessor`: an id in its prompt (`ours`, `:1000`) also leaves
     `returned` (it has just been sent).
   - Nothing else: no expiry, no automatic claim, never re-queued, never
     re-sent. A row whose writer is gone stays until a reclaim or the
     session's delete (Q-R1).
4. **The view (pure, `daemon/src/queue-view.ts`).**
   `queueView({ turnRunning, queue, successor, isDelivered, returned })` →
   `QueueState`:
   - `entries` with a **live** reserved successor: its `messages` not yet
     delivered (the prompt), then the `queue` rows whose id is not among them
     (carried), then `successor.steers`;
   - `entries` otherwise: `turnRunning ? queue : []`, with
     `turnRunning = activeTurnId !== null && !compacting`;
     a **cancelled** successor contributes nothing (its sender restores its
     rows through `delivered:false`);
   - `returned` as is.
   Also exports `sameState(a, b)` (ids, texts, causes, in order) and
   `leftovers(queue, successor)` (the D-return split, so `finishTurn` holds no
   branching of its own beyond the call).
5. **`publishQueue()`.** Compute the view; if it differs from `lastQueued`
   (`sameState`), emit `{type:"queued", ...state}` and store it. Called as the
   **last synchronous statement** of each mutation site:
   - `enqueue`, both branches (`:1340-1345`, `:1354-1357`);
   - `drive`, right after emitting a `steer` (`:1128-1131`): order `steer`,
     then `queued`;
   - `sendNow`: after the reservation (`:916-918`) and after the free-slot
     settle (`:932-933`);
   - `finishTurn`: after `settleSuccessor` (`:1190`), before `kickTitle` — so in
     a hand-off it follows the successor's `turn_start` (P3);
   - `compact`'s `finally`, after `settleSuccessor` (`:1403`);
   - `cancel` (`:1434-1439`): a cancelled successor's rows leave `entries`;
   - `close`, before `session_closed` (`:1474`): the returned rows reach every
     attached writer before the session ends;
   - `reclaim`.
   `startSuccessor` / `endUnstarted` are reached only through those callers.
   The dedupe makes a retried enqueue (`:1334`) or an unchanged view emit
   nothing.
6. **The cut carries the state.** `Cut` (`:139-145`) gains
   `queued: QueueState`; `recordCut`, `historyReplaced` and the constructor set
   it to `lastQueued`. The constructor computes the initial view first (a
   resumed turn's steers, a reloaded `returned`), before the cut. `snapshotPage`
   returns `queued: cut.queued` on the first page (`:743-749`, beside
   `since` / `turn` / `title`).
7. **Close and archive agree with what was streamed.** `close` ends the turn
   through `finishTurn(cancelled)` (`:1462-1468`) with `closed === true`, so
   the leftover goes to `returned` (`cause: "ended"`) and streams before
   `session_closed`. `archive()` (`:1493-1498`) keeps `before.turn` for its
   pending ask but must take `steering`/`steeringIds` from **after** the close
   (empty) and `returned` from after: otherwise the reopen would ALSO append
   the rows as user messages (`persisted-session.ts:396-398`) — a hand-back
   plus a delivery. A reopened archive shows its `returned` rows in the
   snapshot.
8. **What a late attacher sees** (unchanged): `open` without `since` →
   `resync`, replay past the cut (`:677-700`), then the snapshot's `queued`.

**Record (`persisted-session.ts`), `DAEMON_RECORD_VERSION` 3 → 4.**
- `PersistedTurn` gains `steeringIds: string[]` (same length as `steering`;
  v4 always writes it). `DaemonSessionState` / the record gain
  `returned: { id; text; cause }[]` (v4 always writes it, maybe `[]`).
- `parseDaemonRecord`: `READABLE_VERSIONS` `[1, 2, 3, 4]` (`:24`). A v4 record
  must carry both well-formed (`turnProblem` `:137-154`: equal lengths,
  strings; `returned`: objects with string `id`/`text` and a known `cause`),
  else refused with the reason, never half-loaded. A v1–v3 record reads with
  no ids and `returned: []`.
- **Fix the title gate while bumping** (`:215`): today it reads
  `schemaVersion !== DAEMON_RECORD_VERSION` → after the bump it would refuse
  every v3 record with a chosen title. It becomes `schemaVersion < 3`. Pinned
  by a test (v3 record with `{text, source}` title still loads).
- A v3 daemon refuses a v4 record (unknown version; `persisted-session.ts:174-179`,
  left untouched on disk). That is the honest downgrade, as for 2 and 3.
- `ResumedTurn` (`:306-314`) gains `steeringIds?`; `Reconciled` and
  `RestoredSessionState` (`hosted-session.ts:163-176`) gain `returned`;
  `SessionHost.restore` passes it (`session-host.ts:570-592`).
- **A turn cut short by a crash** (not resumable, not archived):
  `reconcileOnReload` appends its steers as user messages
  (`persisted-session.ts:396-398`). **Recommended (Q-R2):** for a v4 record
  (ids known) move them to `returned` with `cause: "ended"` instead; v1–v3
  keep today's user messages (no id: nobody could take them back). An
  archived record's turn has `steering: []` after item 7, so the same code
  path is a no-op for it.

**Client (`@tentacle/client`).** Follows task 3's title route, not the reducer.
- `mapping.ts` `updateToEvent`: `case "queued": return null` (`:149-210`; the
  switch is exhaustive, `tsc` forces it). The type is then in
  `KNOWN_UPDATE_TYPES` → declared at `initialize` → no `unsupported` notice.
- `RemoteClient`:
  - routes a `queued` update like `session_title` (`remote-client.ts:1381-1384`)
    to `queuedChanged(entry, state)`, which stores `entry.queued` and calls the
    `onSessionQueued` listeners;
  - `Snap` (`:187-193`) and `readSnapshotPages` (`:1503-1530`) carry the first
    page's `queued`; `resync` (`:1275-1276`) and `readBack` (`:628`) call
    `queuedRead(entry, snap.queued)` beside `titleRead`;
  - `reclaim(sessionId, ids)`: the RPC.
- `RemoteSession`:
  - `queued: QueueState | undefined` (getter; `undefined` = this daemon does
    not report the queue — an older daemon, or no report yet: a capability
    signal, not a guess);
  - **`mine: Map<id, text>`**: every id it sent, with its text — filled by
    `enqueue` (`:186-199`, before the request) and by `sendNow`'s messages;
  - **`handedBack: Set<id>`**: ids already given back to the user by ANY path
    — the `returned` path, a refused send-now's non-`held` ids, a send-now
    ended `delivered:false` (its messages and its steers, `finish` `:634-646`);
  - on every queue state (live or read): `handBack(state, mine, handedBack)`
    (pure, `client/src/hand-back.ts`) → `{ give: [{id, text, cause}], reclaim: ids }`:
    `give` = the `returned` ids in `mine` and not in `handedBack`, with **my
    own text from `mine`** (never the daemon's: a pod daemon is not trusted,
    §7 — it cannot put words in my input); `reclaim` = the `returned` ids in
    `mine` (handed back now or before). It fires `onReturned(give)` once, adds
    them to `handedBack`, then sends `reclaim` (fire-and-forget; a failure is
    retried at the next state that still lists them, e.g. after a reconnect);
  - `queued` is added to the "owned elsewhere" list in `output()`
    (`:582-592`).
- Rows of other writers (in `returned` but not in `mine`) are **never**
  handed back or reclaimed by this client: visible state only (task 6/13).

**TUI (`@tentacle/tui`) — the PC half of the rule.** The broadcast list is
still rendered from the TUI's own rows (Q3 unchanged: the switch to the
daemon's list is task 6). Only the hand-back is wired:
- `queued.ts` (pure): `dropIds(rows, ids)` and
  `returnedNotice(n, cause, stoppedHere)` →
  - `cancelled`, not stopped here: "Turn stopped from another device: your N
    queued messages are back in the input" (the owner's text);
  - `cancelled`, stopped here (this TUI pressed Esc on that turn — a client
    fact, not a daemon one): "your N queued messages are back in the input";
  - `failed`: "The turn ended early: your N queued messages are back in the
    input";
  - `ended`: "The session ended: your N queued messages are back in the input".
- `App.tsx`: subscribe `session.onReturned` (like `onTitle`); on a batch:
  drop those ids from the rows (if still there), `restoreInput(joined,
  notice)` (`App.tsx:580-588`, the existing helper, joined with "\n\n" like
  send-now). Never sends. `stoppedHere` is set by the Esc handler
  (`:1424-1426`) for the turn it aborts and cleared at the next turn start.
- An older daemon: no `queued` ever → no hand-back → today's behaviour.

**Writer offline when its rows come back** (the owner's question).
- **Reconnect, same process** (a drop, a laptop sleep): the `RemoteSession`
  and its `mine` survive (`RemoteClient` re-attaches its sessions). A covered
  `since` replays the `queued` update; otherwise the resync's snapshot carries
  `queued.returned`. Either way the rows are handed back once, then reclaimed.
- **Daemon restart meanwhile:** `returned` is in the v4 record → reloaded →
  same as above (`serve` only; a pod daemon has no record).
- **The writer's process is gone** (TUI quit, phone killed): nobody holds
  those ids any more. The rows stay in `returned`, visible to every client
  (task 6 / 13 render them as "returned to another device"), until a reclaim
  — which only an explicit user act on some device may send (task 6 / 13;
  never automatic, since no device can tell it is the writer) — or the
  session's delete. **Never** re-sent, never auto-claimed (Q-R1).
- **Another device of the same user** cannot take them automatically: one
  principal, no device identity (P8). Only by the explicit act above.

**Protocol impact (re-plan 2026-10-24).** Still additive:
- one `display` update `queued` (P5), one optional first-page
  `SnapshotResult.queued`, one new method `session/reclaim` (P6);
- older client: `unsupported` once per session, keeps today's drop, never
  reclaims — the rows stay in `returned` for newer clients; older daemon: no
  `queued`, `RemoteSession.queued === undefined`, no hand-back.

So **`PROTOCOL_VERSION` stays 11** (`protocol/src/version.ts:7`): no field
changes meaning, nothing is removed, no update is mandatory. Honest caveat:
the *daemon-side* meaning of a leftover changes (dropped → returned), but no
wire field encodes "dropped", so no older peer misreads anything; it only
fails to show the hand-back. **`DAEMON_RECORD_VERSION` 3 → 4** (record).

### Files

*(re-plan 2026-10-24: one task, dependency order protocol → daemon → client → tui)*

1. `packages/protocol/src/session.ts`: `QueuedEntrySchema`, `ReturnCauseSchema`,
   `ReturnedEntrySchema`, `QueueStateSchema` (+ types), `SnapshotResultSchema.queued`,
   `ReclaimParamsSchema` / `ReclaimResultSchema` and the contract comment.
2. `packages/protocol/src/updates.ts`: `QueuedUpdateSchema`, union member,
   `UPDATE_CLASS.queued = "display"`.
3. `packages/protocol/src/methods.ts`: `Reclaim: "session/reclaim"` (+ its
   params/result wiring wherever methods are mapped).
4. `packages/protocol/schema/protocol.json`: regenerated (`bun run schema:export`;
   pinned by `protocol/test/json-schema.test.ts`).
5. `packages/daemon/src/queue-view.ts` (new, pure): `queueView`, `sameState`,
   `leftovers`.
6. `packages/daemon/src/persisted-session.ts`: v4, `steeringIds`, `returned`,
   parse rules, the `:215` title gate, `ResumedTurn.steeringIds`,
   `reconcileOnReload` (Q-R2).
7. `packages/daemon/src/hosted-session.ts`: mirror `{id,text}`, D-return,
   `returned`, `reclaim`, `publishQueue` at the listed sites, `Cut.queued`,
   `snapshotPage().queued`, `persistedState`, `archive`, constructor.
8. `packages/daemon/src/session-host.ts`: pass `returned` through `restore`.
9. `packages/daemon/src/connection.ts`: the `session/reclaim` handler
   (synchronous; on `serve` the ack waits for `persisted()`, like `enqueue`).
10. `packages/client/src/mapping.ts`: `case "queued": return null`.
11. `packages/client/src/hand-back.ts` (new, pure): `handBack`.
12. `packages/client/src/remote-client.ts`: route, `Snap.queued`, `queuedRead`,
    listeners, `reclaim`.
13. `packages/client/src/remote-session.ts`: `queued`, `mine`, `handedBack`,
    `onReturned`, auto-reclaim, `output()` owned-elsewhere.
14. `packages/tui/src/queued.ts`: `dropIds`, `returnedNotice`.
15. `packages/tui/src/App.tsx`: `onReturned` subscription, `stoppedHere`.

### Failure modes

*(re-plan 2026-10-24)*

| Case | Convergence |
|---|---|
| Re-attach with a covered `since` | The replay holds every `queued` past it (the ring pins past the cut, `ring.ts`). Full state: the last one wins. The writer hands back once (`handedBack`). |
| Ring overflow / evicted / another epoch (compaction, restart) | `resync` → snapshot `queued` at the cut + replay past it. Exact (load-bearing assumption). Q6, C3. |
| **Writer disconnected when its turn ends** | The rows sit in `returned` (memory; on `serve` also on disk). On reconnect: replay or snapshot → handed back once → reclaimed. C5. |
| **Writer's process gone** | Rows stay in `returned`, visible to all, until an explicit reclaim or the delete. Never re-sent. Q-R1. |
| **Reclaim lost** (drop after the hand-back) | `handedBack` stops a second hand-back; the next state still lists the ids → reclaim re-sent. Idempotent daemon-side. C6. |
| **Race: send-now hand-off** | Live successor → rows carried, nothing returned (T-A4 unchanged). `queued` follows the successor's `turn_start` (P3; mutation M4). |
| **Race: another device cancels the send-now before it starts (4a gap)** | `finishTurn{T1}` sees a cancelled successor → T1's leftovers minus the sender's ids → `returned{cancelled}`; `endUnstarted` → `delivered:false` → the sender restores its own. Nobody's text twice, nobody's lost. Q4b (F-7's shape). |
| **Race: my refused send-now restores an id that is then returned** | The refusal's non-`held` ids go to `handedBack`; the later `returned` only reclaims them. C7. |
| **Race: an id is in `returned` and a send-now carries it** | `startSuccessor` drops it from `returned` (it is in the prompt). Q11. |
| A turn cancelled / failed with steers left | `turn_end`, then `queued{entries:[], returned:[…]}`; a later `send_now` on a free slot seeds nothing (Q8, red on `main`). |
| **Compaction** | No turn → no leftovers (an enqueue there binds only to a reserved send-now, `:1340`). `history_replaced`'s new cut carries `lastQueued`, `returned` included. A summary never contains a returned row (it was never in the history). Q12. |
| **Close mid-queue** | Leftovers → `returned{ended}` before `session_closed`; the archive record has `steering: []` and the `returned` rows (item 7) → the reopen does not also append them. A reclaim after the close fails (session not open): the client ignores it; the rows show again after a reopen until reclaimed. Q13. |
| **Archive / reopen** | `returned` reloads with the record; snapshot shows it. P-R3. |
| **Delete (tombstoned session id)** | `close("deleted")` streams the hand-back before `session_closed{deleted}`: an attached writer gets its rows. The record and its `returned` are removed with the session; an offline writer reopening gets `SessionDeleted` (2a) — delete means delete, stated in the notice-free path. Q13b. |
| Daemon restart, resumed (permission-suspended) turn with steers | v4: the steers keep their ids → the writer recognises them; delivered once (`restoredIds`). v1–v3: minted ids, nobody's. Q9. |
| Daemon restart, turn cut short (not resumable) | Q-R2 (recommended: v4 → `returned{ended}`; v1–v3 → user messages, as today). P-R2. |
| v3 daemon reads a v4 record | Refused, file untouched (`persisted-session.ts:174-179`). P-R1. |
| A retried enqueue / unchanged view | Dedupe (`sameState`): no update. Q10. |
| A throwing sink | The existing per-attachment catch in `emit` (`:801-807`). |
| Older client / older daemon | P5 / P6; C4. |
| Hostile pod daemon forges `returned` | It can only name ids; the laptop hands back **its own** text for an id it minted (`mine`), never the daemon's — a forged id it never minted is ignored. Nothing is sent. §7 "pod not trusted". C8. |
| Large pasted texts | Every change re-sends the full state; the ring pins it until the next cut. Accepted (debt). |

### Tests

*(re-plan 2026-10-24)* Every new test is shown **red on `main`** first (no
`queued`, no `returned`, no `reclaim` exists there; the behavioural ones are
red by behaviour, noted). Fakes: the `send-now.test.ts` rig (`Scripted`,
`Gate`, `blockedT1`, `client()`, `until`), the `persistence.test.ts` record
rig, `client/test/send-now.test.ts`'s two `RemoteClient`s over the in-memory
daemon, `ink-testing-library` for the TUI. No `!`.

**Protocol** — `protocol/test/updates.test.ts`: `queued` parses (with and
without `returned` rows), class `display`, entry id bounds; `ReclaimParams`
rejects `ids: []`. `json-schema.test.ts` green after regeneration.
`daemon/test/mapping.test.ts:164-165` gets one `queued` sample.

**Daemon, pure** — `daemon/test/queue-view.test.ts`: idle → `{[],[]}`;
running → mirror; live reserved → prompt-first, carried, successor steers;
cancelled successor → contributes nothing; delivered messages left out;
`leftovers` excludes the successor's ids; `sameState`.

**Daemon, behaviour** — `daemon/test/queued.test.ts` (new):
- Q1 two clients see `queued[A]`, `queued[A,B]` with the enqueue ids.
- Q2 drain: `steer{A}` immediately followed by `queued[B]`. (M1: skip
  `publishQueue` in `drive` → red.)
- **Q3** Esc with B pending: `turn_end{T1}`, then
  `queued{entries:[], returned:[{B, cancelled}]}`. Red on `main` by behaviour
  (nothing reports B). (M3: skip the D-return move → red.)
- Q4 hand-off: foreign `x` + ours `a`, `sendNow(T2,[a])` → `queued[a,x]`;
  then `turn_end{T1}`, `turn_start{T2}`, `queued[x]` (same id, nothing
  returned); then `steer{x}`, `queued[]`. (M4: publish before
  `settleSuccessor` → T-A1 red.)
- **Q4b (the 4a gap)** F-7's shape: my `a` queued in T1; B's send-now S on T1
  with its own `b`; B cancels before S starts → `returned` = `[{a, cancelled}]`
  only (not `b`), `turn_end{S, delivered:false}`, history `["go","go"]`.
  (M5: `leftovers` without "minus the successor's ids" → `b` returned too →
  red.)
- Q5 cancel in the window: `turn_end{T2, delivered:false}`, then the
  successor's rows leave `entries`.
- **Q6** late attacher, decisive (two gated tool calls; the cut moves past the
  `queued` seq at a `history_commit`, `:1108-1115`; the executor asserts
  `historyCut.seq` > that seq): a fresh `open` replays no `queued`, and
  `snapshotPage().queued` equals the live state. (M2.)
- **Q8** no resurrection: T1 with a foreign X pending, `cancel()`, then
  `sendNow(T2,[a])` on the free slot → no `steer{X}`, history `["go","A"]`;
  X in `returned`. Red on `main` (X is seeded and steered).
- Q10 a retried `enqueue` emits no second `queued`.
- Q11 `sendNow` citing an id in `returned` → it leaves `returned` at
  `turn_start`.
- Q12 a compaction with `returned` non-empty: the post-barrier snapshot still
  carries it.
- Q13 `close` with A pending: `queued{returned:[{A, ended}]}` precedes
  `session_closed`; Q13b the same for `close("deleted")`.
- Q14 `reclaim([A, "unknown"])` → `queued{returned:[]}`; a second reclaim →
  no update.
- Existing pins that change **on purpose** (the rule changed; each edit cites
  this doc): F-7 (`send-now.test.ts:1118`) also asserts `returned:[a]`;
  `persistence.test.ts:688-690` "a steer still queued at a cancel is dropped"
  → "… is returned to its writer"; the reconcile test `:1323-1332` stays for a
  v3 record and gets a v4 sibling (Q-R2).
- Existing guards that must stay green **unchanged**: T-A1 / T-A1b
  (`:216`, `:289`), T-A4 (`:377`), F2 / R7 (`:1004`), F-1 (`:1055`), the "no
  macrotask between the last drain and the turn's end" pins
  (`integration.test.ts:405`, `:444`; `persistence.test.ts:825`).

**Daemon, record** — `daemon/test/persistence.test.ts`:
- P-R1 a v4 record round-trips `turn.steeringIds` and `returned`; a v4 record
  with mismatched lengths / a bad `cause` is refused with a reason (never
  half-loaded); a v3 record loads with no ids and `returned: []`; **a v3
  record with a chosen title still loads** (the `:215` gate; red with the
  naive bump — that is the mutation).
- P-R2 (if Q-R2 yes) a v4 crash-cut turn with steering `["s1"]` ids `["i1"]`
  → history unchanged, `returned:[{i1,"s1",ended}]`; v3 → user messages as
  today.
- P-R3 archive mid-queue → record `turn.steering: []`, `returned:[A]`; reopen
  → history has no `A` user message, snapshot `queued.returned:[A]`.
- Q9 restart with a resumed turn and steering `["S"]` id `"i"`: the snapshot's
  `entries` is `[{i,"S"}]` (v4); with a v3 record, a minted id not in
  `enqueueIds`.

**Client** — `client/test/hand-back.test.ts` (pure): mine/not-mine;
already handed back → reclaim only; foreign ids ignored; text taken from
`mine`, not from the state (C8). `client/test/queued-broadcast.test.ts` over
the in-memory daemon:
- C1 B sees A's rows in `RemoteSession.queued` while idle.
- C3 tiny `ringBytes` forces B's resync → `queued` equals the daemon's.
- C4 a daemon without `queued` → `queued === undefined`, `onReturned` never
  fires.
- **C5** writer A drops its connection, B presses Esc, A reconnects (resync)
  → `onReturned` fires once with A's text, then the daemon's `returned` is
  empty. Mutation: `queuedRead` not called on resync → red.
- C6 the reclaim fails once → no second `onReturned`; the reclaim is re-sent.
- C7 A's send-now refused with `held:[]`, then A's T1 ends with the same id
  returned → `onReturned` does not fire for it; it is reclaimed.
- C8 a forged `returned` with an id A never sent → nothing; with an id A sent
  but another text → A's own text.

**TUI** — `tui/test/queued.test.ts` (`dropIds`, `returnedNotice` per cause and
`stoppedHere`); `tui/test/app.test.tsx` pattern: a stubbed session fires
`onReturned([{a,"fix x"},{b,"and y"}], cancelled)` → the input holds
`"fix x\n\nand y"` (after any draft) and the frame shows "Turn stopped from
another device: your 2 queued messages are back in the input"; with Esc
pressed here first → the plain notice; nothing is sent (the stub records no
`send`).

**Gate.** `bun run check`, lint baseline clean (§6).

**Open items.**
- **O1** (kept): executor step 0 wires `publishQueue` in `enqueue` only and
  runs `bun test packages/daemon packages/client packages/cli packages/tui`.
  Static count today: 2 hits for `.type)).toEqual|kinds[i + 1]` in those test
  folders. Each failure must be an exact-sequence assertion, adapted by
  filtering `queued` out, never by weakening its property. If the count is
  far above ~10, report before continuing.
- O2 (steer ids across a restart): **closed** by the v4 record.
- O3 (kept): the daemon does not refuse a send-now or a reclaim citing
  someone else's id: one principal; client-side rule. Revisit with task 9's
  per-device keys.

**Notes / debt.**
- Full-state bytes for big texts; `returned` of vanished writers grows until
  someone reclaims or deletes (no cap: a cap would be a silent drop).
- `steer` still has no `id`: the TUI's FIFO drop stays until task 6.
- The phone half (compose field + banner) is task 13 over the same
  `onReturned`.

## Execution

*— claude-opus-5-5, 2026-10-25*

**Premises re-verified first** on `feat/queued-broadcast` @ `49a53f4`: every
`file:line` of the re-plan held (mirror `:259-264`, resume seed `:397-401`,
`startSuccessor` `:1004-1013`, `drive` `:1121-1127`, `refusal` `:966`,
`persistedState` `:609`, `finishTurn` `:1167-1194`, `enqueue` `:1333-1358`,
`compact` `finally` `:1393-1404`, `cancel`, `close`, `archive` `:1493-1498`,
`snapshotPage` `:743-749`, `recordCut`, the title gate
`persisted-session.ts:215`, `READABLE_VERSIONS` `:24`, `reconcileOnReload`
`:396-398`, `SessionHost.restore` `:570-592`). `SessionPersister.schedule`
captures synchronously (`session-persister.ts:88-100`), so the D-return state
set before `persist()` in `finishTurn` is what the record holds.

**Gate baseline** (`bun run check`, before any edit): typecheck clean · lint
`Checked 441 files … No fixes applied` · **2374 pass / 2 skip / 0 fail**.

**Repro (capability missing).** Not a separate script: the red run below *is*
the repro — the new tests run against `main`'s sources. On `main` there is no
`queued` update, no snapshot `queued`, no `session/reclaim`, and the
behavioural cases (Q3 Esc with a row left, Q8 resurrection, Q4b the 4a gap,
F-7's `returned`) fail by behaviour.

### As built, in the plan's order

1. **Protocol** (`protocol/src/session.ts`): `QueuedEntrySchema`,
   `ReturnCauseSchema`, `ReturnedEntrySchema`, `QueueStateSchema` (+ types) and
   the contract comment, beside `SnapshotTurnSchema`; `SnapshotResult.queued`
   (first page); `ReclaimParamsSchema` (`ids` min 1, each 1..128) /
   `ReclaimResultSchema` with its comment. `updates.ts`: `QueuedUpdateSchema`,
   union member, `UPDATE_CLASS.queued = "display"`. `methods.ts`:
   `Reclaim: "session/reclaim"` + `RequestSchemas`. `schema/protocol.json`
   regenerated (`bun run schema:export`, +121 lines). `PROTOCOL_VERSION` stays 11.
2. **Daemon, pure** — `daemon/src/queue-view.ts` (new): `queueView`,
   `leftovers`, `returnCause`, `sameState`, `EMPTY_QUEUE`.
3. **Record** — `persisted-session.ts`: `DAEMON_RECORD_VERSION = 4` (`:27`),
   `READABLE_VERSIONS [1, 2, 3, 4]`; `PersistedTurn.steeringIds?`,
   `DaemonSessionState.returned?`, `DaemonSessionRecord.returned` (always
   written); a v4 `turn` must carry `steeringIds` of the same length and a v4
   `returned` must be well-formed (`returnedRows` `:271`), else refused with
   the reason; a v1–v3 record reads with its turn's ids stripped and
   `returned: []`. **The title gate fixed** (`:237`):
   `schemaVersion < CHOSEN_TITLE_VERSION (3)`. `ResumedTurn.steeringIds?`,
   `Reconciled.returned`. `session-host.ts` `restore` passes `returned`.
4. **`HostedSession`** (`hosted-session.ts`):
   - the mirror is `queue: {id, text}[]` (one source); `returned`,
     `lastQueued`; `Cut.queued`;
   - resume seed: the v4 id, else `crypto.randomUUID()` (`:417-425`); the
     initial state computed after the seed, set on the seq-0 cut;
   - `persistedState` writes `turn.steering`/`steeringIds` and `returned` from
     the mirror (`:629-645`);
   - `queueState()` / `successorView()` (a close counts as a cancel) /
     `publishQueue()` (dedupe by `sameState`, never throws) / `reclaim(ids)`
     (`:650-700`);
   - `publishQueue` is the last statement of: both `enqueue` branches,
     `drive` right after a `steer`'s emit, `sendNow` (reservation and
     free-slot settle), `finishTurn` after `settleSuccessor` (`:1294`),
     `compact`'s `finally`, `cancel`, `close` before `session_closed`, `reclaim`;
   - **D-return** in `finishTurn` inside `if (activeTurnId === turnId)`,
     before the `turn_end` emit (`:1275-1281`);
   - `startSuccessor` seeds from the mirror minus its prompt's ids, and drops
     those ids from `returned`;
   - `snapshotPage` returns `queued: cut.queued` on the first page (`:834`);
     `recordCut` / `historyReplaced` store `lastQueued`;
   - `archive()` keeps `before.turn` but with `steering: []`, `steeringIds: []`
     (`:1615`).
   No `await` added anywhere; every new statement in `drive`/`finishTurn` is
   synchronous state + `emit` (P2).
5. **`connection.ts`**: `session/reclaim` handler (`:242`), synchronous like
   `enqueue`; the ack waits for `persisted()`.
6. **Client**: `mapping.ts` `case "queued": return null`; `client/src/hand-back.ts`
   (new, pure): `handBack`, `restoredByRefusal`; `remote-client.ts`:
   `SessionQueueNotice`, `onSessionQueued`, `queuedOf`, `reclaim` (`:503`,
   `keyed`), `Snap.queued`, the `queued` route (`:1438`), `resync` feeds the
   snapshot's queue (`:1329`); `remote-session.ts`: `queued` getter,
   `onReturned` (`:171`), `queueChanged` (`:192`), `mine`, `handedBack`,
   `reclaiming`; `handedBack` filled by a refused send-now (`:398`, and the
   local "a send-now is already waiting" refusal `:349`) and by a send-now
   ended `delivered: false`; `queued` in the owned-elsewhere list.
7. **TUI**: `queued.ts` `dropIds`, `returnedNotice` (`:127`), `handBackRows`
   (`:149`); `App.tsx`: `SessionController.onReturned?`, `watchReturned`
   (`:618`, re-subscribed on `/clear`), `stoppedHereRef`.

### Drift from the Implementation (and why)

- **O1 step 0** was run as "all sites wired, then count" instead of
  "`enqueue` only first". Existing tests broken by the change: **13**. Only
  **2** were exact-sequence assertions (T-A8 ×2, `send-now.test.ts:497`,
  `:516`): adapted by filtering `queued` out, property unchanged. The rest:
  record-version pins 3→4 / "newer" 4→5 (D6 `session-titles.test.ts`, U2 and
  "rejects another version" `persistence.test.ts`, S1/S2/A11
  `cli/test/serve-persistence.test.ts`), v4 fixture shape (R9, and four typed
  literals for `tsc`), B2 now expects `steeringIds: ["e1"]`, the mapping
  sample list, the JSON-Schema drift gate and its fixture coverage.
- **`readBack` does NOT feed the queue** (plan: "resync and readBack call
  `queuedRead`"). `readBack`'s snapshot is at the cut, BEHIND the live
  stream: feeding it would move the client's state backwards (e.g. show a
  row as waiting after its `returned` update). Only `resync` (snapshot + the
  buffered replay past its `since`) is exact. Every attach without a covered
  `since` resyncs, so nothing is missed.
- **`cli/src/local-runtime.ts`** (not in *Files*): `persistingController`
  forwards `onReturned` — the TUI's controller over RPC is that wrapper, so
  without it the TUI never subscribes (pinned by `cli/test/queued-broadcast.test.ts`).
- **Protocol tests** are in a new `protocol/test/queued-broadcast.test.ts`
  (namespace access, so red on `main` is on the assertion), not in `updates.test.ts`.
- **Schemas spelled out** (`QueuedEntrySchema` is its own object, not an alias
  of `SendNowMessageSchema`; `ReturnedEntry` and the update are not `.extend`):
  the exporter's warning about shared instances (`updates.ts`, `TurnEndUpdate`).
- **Q2 not built** (owner decision pending): see *Q2 seam* below. P-R2 is
  replaced by a test that pins TODAY's behaviour.
- **A resumed v4 steer's id leaves `restoredIds`** (`hosted-session.ts:424`):
  `restoredIds` means "text already in the history", false for a re-queued
  steer. Harmless while ids were `undefined`; with v4 ids it would make
  `refusal` report it held and `sendNow` treat it as delivered.
- **`stoppedHere`** is also set by the two Ctrl+C aborts (they stop the turn
  here too) and reset at the send-now chord (a new turn of ours).
- **No listener → no reclaim**: `RemoteSession` reclaims only while someone
  is subscribed to `onReturned`; a reclaim with nobody to show the rows would
  be a silent drop. A `reclaiming` set stops duplicate in-flight reclaims.
- **`handedBack` on an undelivered successor** also takes the ids `mine`
  bound to that turn or to the turn it interrupted: exactly the rows the TUI's
  `onSuccessorError` restores (`takeAll(rows)`).
- **Tests reading the live state use the stream**, not `snapshotPage()`
  (the snapshot is at the cut, by design; `finishTurn` records the cut before
  the `queued` that follows `turn_end`). Q6 moves the cut past the `queued`
  with a second turn's end (a cut like `history_commit`'s), asserting
  `historyCut.seq` > its seq.
- **M4 is killed by Q4, not T-A1**: with the dedupe, an early `publishQueue`
  in a live hand-off emits nothing (the view does not change before the
  successor starts), so nothing can fall between `turn_end` and
  `turn_start`; the missing post-start `queued[x]` is what goes red.
- **Notices**: wrapped `_…_` like the TUI's other notices; singular for 1 row.
- **Extra tests** beyond the plan: Q3b (cause `failed`, a model that fails
  after an enqueue), Q14b (`session/reclaim` over the wire), P-R4 (a reclaim
  is durable and survives a restart), C2.
- **Tooling**: `python3` and a `bash` script needed an approval that was not
  available, and so did `git checkout`. The red run and the mutations were done
  with single `cp` / `git show HEAD:<file> > <file>` commands from a verified
  backup (`.tentacle/tmp/queued-broadcast/bak/`).

### Q2 seam (not implemented)

`persisted-session.ts:466-474` (`reconcileOnReload`): an `OWNER DECISION
PENDING` comment where the recommendation would plug in (v4 → `returned`
with cause `ended`). The code below it is unchanged: every version's
crash-cut steers become user messages. The test that would change is
`persistence.test.ts:2178` ("Q-R2 seam …"), which pins today's behaviour for
a v4 record.

### Tests (new)

`protocol/test/queued-broadcast.test.ts` (QP1–5) · `daemon/test/queue-view.test.ts`
· `daemon/test/queued.test.ts` (Q1, Q2, Q3, Q3b, Q4, Q4b, Q5, Q6, Q8, Q10,
Q11, Q12, Q13 ×2, Q14, Q14b) · `persistence.test.ts` "the v4 record" (P-R1 ×2,
Q-R2 seam, Q9, P-R3, P-R4) + B5's new assertion · `client/test/hand-back.test.ts`
(incl. C8 pure) · `client/test/queued-broadcast.test.ts` (C1, C2, C4–C8) ·
`cli/test/queued-broadcast.test.ts` (L-Q1) · `tui/test/hand-back-rows.test.ts` ·
`tui/test/returned.test.tsx`. Pins changed on purpose: F-7 (`returned:[a]`),
B5 (`:688-690` "dropped" → returned, live stream), F-6's comment.

**Red on `main`** (sources from `HEAD`, the two new modules removed, all tests
kept): **54 fail / 111 pass** across the 11 files
(`.tentacle/tmp/queued-broadcast/red.out`). Every new test is in the fail
list. `queue-view.test.ts` and `hand-back.test.ts` fail with "Cannot find
module": their module is new, so they cannot fail on an assertion. C4 and
L-Q1 fail on `onReturned` not existing. Restored from the backup: the 16
source shasums are equal to the ones taken before.

**Mutations** (each edit → narrow test → `cp` from `bak/` → shasum checked):

| # | Mutation | Red |
|---|---|---|
| M1 | no `publishQueue` after a `steer` | Q2, Q4 |
| M2 | `snapshotPage` without `queued` | Q6, Q2, Q5, Q8, Q12, C5 (C5 proves the resync path) |
| M3 | skip the D-return move | Q3, Q3b, Q4b, Q6, Q8, Q11–Q14, F-7 |
| M4 | `publishQueue` before `settleSuccessor` | Q4 |
| M5 | `leftovers` without "minus the successor's ids" | Q4b, queue-view |
| M6 | title gate `!== DAEMON_RECORD_VERSION` | P-R1 (v3 title) |
| M7 | `archive` keeps `before.turn.steering` | P-R3 |
| M8 | `resync` does not feed the snapshot's queue | C5 |
| M9 | hand back the daemon's text | C8 |
| M10 | a refused send-now marks nothing handed back | C7 |
| M11 | `persistingController` drops `onReturned` | L-Q1 |
| M12 | Esc does not set `stoppedHere` | returned.test "Esc here" |

After all the mutations the tree is **byte-identical**: the `shasum` of all 30
changed and new files matches the snapshot taken before (`after-mutations.sha`),
and `git status --short` is unchanged. One file changed after that snapshot:
the three version pins in `cli/test/serve-persistence.test.ts`, found by the
full suite (listed under O1 above).

### Gate (end)

- `bun run typecheck`: clean.
- `bun test`: **2430 pass / 2 skip / 0 fail** (2432 tests, 199 files). That is
  +56 over 2374/2/0. The 2 skips are the opt-in ones.
- `bun run lint`: `Checked 451 files`, **1 error, not in the repo**:
  `.claude/settings.local.json` (gitignored). The harness rewrote it during
  this session when it recorded a permission rule, and Biome wants its array
  on one line. I did not touch it, because it is the harness's permission
  file. `bunx biome format --write .claude/settings.local.json` fixes it.
  Because of it, `bun run check` stops at lint, so the tests were run on
  their own. Every repo file is clean.

### Open items for the owner

- **Q2** (crash-cut steers) is still yours to decide. The seam is above.
- **Q3** (one L task): executed as one branch. A split is still possible before merge.
- **Known limit, unchanged (task 6).** The TUI's row list is still its own. My
  rows clear at the turn's end and come back through `onReturned`. In a
  hand-off to ANOTHER device's send-now, my TUI clears rows that the daemon
  carries (as on `main`).
- **A reclaim that fails while connected** is re-sent only at the next queue
  state (any change, or a reconnect's resync). Meanwhile the row stays visible
  in `returned`: nothing is lost and nothing is handed back twice.
- **A writer whose process is gone.** `mine` lives in memory, so its rows wait
  in `returned` until an explicit act (task 6 / 13) or the session's delete
  (Q-R1). By design (P8).

### Follow-up 1 (owner Q2)

*— claude-opus-5-5, 2026-10-25*

Owner decision Q2 (the recommendation) built at the seam. It replaces *Q2
seam (not implemented)* above and closes that item in *Open items*.

**As built.**
1. `persisted-session.ts:471-493` (`reconcileOnReload`, the turn is not
   resumed): if the turn has `steeringIds`, its undrained steers go to
   `returned` with cause `ended`, after the record's own returned rows, and
   never into the history. The parser guarantees that `steeringIds` is
   present exactly for a v4 record (a v4 turn without it is refused, and a
   v1–v3 turn's ids are stripped), so v1–v3 keep their user messages. An id
   that is already in `returned` is skipped, which makes the reload
   idempotent. The `OWNER DECISION PENDING` comment is gone, and the function's
   doc comment now describes the new rule. Archived records are unchanged:
   their turn has `steering: []`.
2. `hosted-session.ts:397-401` (constructor): every reloaded `returned` id is
   removed from `restoredIds`. **This is drift, and it is needed.**
   `restoredIds` means "this text is in the history". It is built from
   `enqueueIds`, and those include the crash-cut steers' ids. Without this
   line, a send-now that cites a crash-returned row after the reload counts
   it as delivered. The daemon then answers `NoTurnRunning` (the history
   ends in a tool note), or `held` in a refusal, and the user's text is
   never sent. The same was already latent for rows returned *before* a
   restart (P-R4's path); the line fixes both.
3. **Drift (client): a race I reproduced, not inferred.** A writer's send-now
   can be in flight across the crash while it carries the steer, e.g. the
   chord was pressed just before the daemon died. On reconnect the resync's
   snapshot lists the row in `returned`. The client gave it back (into the
   input field), and the re-sent send-now then sent it as well: the same text
   ended up both in the input and in the conversation. Repro: the new
   `reattach.test.ts:1704` without the fix printed
   `returned=[[{"id":"a","text":"A","cause":"ended"}]]` and the turn ran
   (`model2.calls === 1`). Fix: `hand-back.ts` `handBack(…, carried)`. A
   returned id that a live (not ended) send-now of mine carries is only
   reclaimed, never given back. Every way that send-now can end already
   covers the row: it is sent; or a refusal / `delivered:false` restores it
   through the existing paths (`restoredByRefusal`, `finish`) and adds it to
   `handedBack`. `remote-session.ts:198-204` computes `carried` from
   `active`/`next`. The same race existed in the live path without a crash
   (another device's Esc lands just before my chord); the guard covers it
   too.
4. Pins changed on purpose:
   - `persistence.test.ts` "Q-R2 seam" is replaced by the v4 pin, with a
     separate v3 pin next to it.
   - `send-now.test.ts` F1a pinned the old v4 behaviour (crash, then the
     reload appends the steer, then the resent send-now runs a continuation
     with prompt `""`). It is split in two:
     - **F1a (v4)**: the row is in `returned`, not in the history, and the
       resent send-now runs it as its prompt (`turn_start{prompt:"A"}`). The
       history is `["go","A"]` once, and `returned` ends up empty.
     - **F1a (v3)**: the old behaviour, unchanged.

**The failure modes asked for, and how each converges (each is pinned):**
- **Writer attached (reconnects, same process)**, `reattach.test.ts:1688`.
  The resync snapshot carries `returned:[{a,"A",ended}]`, so `onReturned`
  fires once with the writer's own text. The client then reclaims it, and
  the daemon's `returned` becomes empty. "A" is never in the history, and
  the model is never called (nothing is re-sent by itself).
- **Writer offline**, `persistence.test.ts:2229`. After the reload the
  session is idle. The snapshot and the record written by `restore` (no
  `turn`) both hold the row. Nothing expires; only a reclaim removes it (the
  test ends with one). A writer that attaches later reads it from the
  snapshot and hands it back through the existing C5 path.
- **Second crash before the reclaim**, same test, two cases.
  - The crash comes after the reload's write: the record then has no `turn`
    and has `returned:[e1]`, so the next reload shows the row once.
  - The crash comes before that write landed: the old record is reloaded
    again and gives the same result, because `reconcileOnReload` is pure.
  The "already returned" guard covers the remaining case of a record that
  lists the same id in both places (pinned in the pure test).
- **Turn suspended on its own permission**, `persistence.test.ts:2282`. That
  turn is **re-run, not cut**, so Q2 does not apply to it. Its steers are
  queued again as the resumed turn's queue, with their v4 ids (no longer in
  `restoredIds`, from the main execution). Nothing is returned on reload.
  - A crash while the turn is still suspended rewrites the same `turn` (with
    `steeringIds`), so the next reload resumes it again.
  - If the resumed turn drains the steers, they are delivered (B1, unchanged).
  - If the turn is stopped first, they go back to their writer through the
    normal D-return path (`cancelled`, id `e1`), never into the history.
- **Close / archive of a session holding crash-returned rows**,
  `persistence.test.ts:2310`. The archived record has no `turn` and
  `returned:[e1 ended]` exactly once. The reopen shows the row in the
  snapshot and never delivers it. Delete removes the record together with
  its `returned`; that path is unchanged (Q13b).
- **A send-now citing a crash-returned row after the reload**,
  `persistence.test.ts:2264`. It is sent once and leaves `returned`
  (item 2).

**Red → green.** I first wrote the tests and ran them on the code before this
follow-up: the persistence, send-now, reattach and hand-back files, with
items 1–3 reverted all at once. Result: **6 fail / 158 pass**
(`.tentacle/tmp/queued-broadcast/fu1/red.out`). The failing tests were F1a v4,
the Q-R2 v4 pure test, writer offline, close/archive, writer reconnects, and
the pure `carried` test. All of them failed on assertions.

Four tests are green on the old code **by construction**, so the mutations
below prove them:
- the send-now citing test and the in-flight race test: without item 1
  nothing is returned at all;
- the suspended-permission test: it pins behaviour that already existed;
- the two v3 pins.

**Mutations.** Each was one edit, then the narrow tests, then a `cp` from
`.tentacle/tmp/queued-broadcast/fu1/new/`, then a `shasum` check:

| # | Mutation | Red |
|---|---|---|
| M13 | no v4 branch (`ids && false`) | the red run above |
| M14 | no "already returned" guard | Q-R2 v4 pure |
| M15 | returned ids left in `restoredIds` | Q-R2 send-now citing, F1a v4, the in-flight race |
| M16 | `carried` not passed by `queueChanged` | the in-flight race (the pure `carried` test went red in the red run) |
| M17 | resume seed mints ids instead of the v4 ones | Q-R2 suspended |
| M18 | v1–v3 get minted ids (returned too) | Q-R2 v3, F1a v3, `reconcile: … steers become user messages`, B6, U3 |

After the last restore, the 4 sources are **byte-identical** to the backup:
`persisted-session.ts c66d4b76…`, `hosted-session.ts 3538e30f…`,
`hand-back.ts 182089f1…`, `remote-session.ts 5210c984…`. A grep finds no
mutation residue left. Biome then reformatted 3 test files only (no source
file). One `tsc` fix came after that: `cause: "ended" as const` in a test
constant.

**Gate.** `bun run check`: typecheck clean · lint `Checked 451 files … No
fixes applied` (`.claude/settings.local.json` did not trip it this time, so it
was left untouched) · **2439 pass / 2 skip / 0 fail** (2441 tests, 199 files).
That is +9 over 2430: persistence +5 net, send-now +1, reattach +2,
hand-back +1. The 2 skips are the opt-in ones.

**Notes.**
- `PROTOCOL_VERSION` and `DAEMON_RECORD_VERSION` are unchanged (11 / 4). Q2
  changes only what a v4 reload *means*, and no v4 record has shipped yet.
- A v1–v3 crash-cut steer still becomes a user message that nobody can take
  back. That is accepted by the owner (no writer known).
- Not verified: the TUI notice for cause `ended` after a real `serve` restart.
  It is covered by `returned.test.tsx` per cause, but not end-to-end through
  a real restart. To verify it, run `tentacle serve`, queue a steer during a
  tool, kill -9 the daemon, restart it, and reattach.

### Follow-up 2 (Review round 1)

*— claude-opus-5-5, 2026-10-25*

**Repro first.** The reviewer's
`.tentacle/tmp/queued-broadcast/review/r1.test.ts`, re-run on the tree as
found: `onReturned calls: []` · `daemon returned now: []` ·
`user msgs: ["go"]`. The row `a` was lost. After the fix:
`onReturned calls: [[{"id":"a","text":"A-text","cause":"cancelled"}]]`.

**F1, root cause.** The daemon knows which row each `steer` drains (the
mirror's head, `hosted-session.ts` `drive`), but the `steer` update did not
carry its id. So the TUI guessed FIFO and dropped its front row on ANY
steer, another writer's included (`tui/src/queued.ts` `onSteer`). On top of
that guess, the client guessed a second time: on `delivered:false` it marked
every row of mine bound to the cut turn as given back. It assumed the TUI
still held them. Both guesses are now gone.
- **The steer names its row** (the owner's principle: the daemon says whose
  steer it is).
  - `protocol/src/updates.ts` `SteerSchema`: optional field `id`. It is
    additive (`steer` stays `display`), so no bump: an older client drops
    the field on parse.
  - `agent/src/agent.ts`: `AgentEvent` `steer.id?`. The loop never sets it.
  - `daemon/src/hosted-session.ts` `drive`: the shifted row's id goes on the
    event.
  - `daemon/src/mapping.ts`, `client/src/mapping.ts`: the id is passed
    through.
  - `tui/src/queued.ts` `onSteer(rows, id?)`: with an id, the TUI drops that
    row only, and a foreign steer drops none. With no id (an older daemon),
    FIFO as before. That fallback follows the `delivered` precedent.
  - `App.tsx` passes `event.id`.
  - `protocol.json` was regenerated (`schema:export`).
- **The client marks only what the caller surely restores.**
  `client/src/remote-session.ts` `finish`: on `delivered:false`, only the
  send-now's own messages go into `handedBack`. Every other row of mine
  comes back through the daemon's `returned` fact. The `mine` map lost its
  now-dead `turnId` (it is now `Map<id, text>`). The `onReturned` doc states
  the dedupe contract.
- **The TUI dedupes against its own restore** (no double for rows typed after
  the chord).
  - `tui/src/send-now.ts` `onSuccessorError` also returns the `ids` it
    restored.
  - `App.tsx` keeps them in `restoredRef`.
  - `tui/src/queued.ts` `handBackRows(…, restored)` skips them. When nothing
    is left, it gives no text and no notice, and `App` then pushes no notice.

**F2 (owner decision).** `daemon/src/session-host.ts` `reclaimArchived`
handles a reclaim of an archived session:
- A deleted id answers `SessionDeleted`. An id that is not archived answers
  `UnknownSession`.
- Otherwise the ids go into the entry's new `reclaimed` set, and
  `rewriteArchived` rewrites the record without them. This is the archived
  rename's seam, generalised: it applies rename and reclaim together, skips
  a write that changes nothing, and now resolves once the write has settled,
  so the reclaim's ack waits for the disk.
- A reopen restores `withoutReclaimed(record, entry.reclaimed)`, which wins
  even against a racing write.

`daemon/src/connection.ts` `reclaim`: a session that is not live goes to
`reclaimArchived`, with no `open` needed (as for the archived rename). A
live session keeps the `lookup` path.

**Drift.**
- The plan's alternative "the TUI reports the ids it restored" was not
  taken: it needs a new controller method. The TUI dedupes locally instead,
  and the client never relies on what the caller holds.
- Existing exact-shape steer assertions got the id: `daemon/test/send-now`
  ×3, `daemon/test/integration` ×2, `client/test/remote` ×2.

**Tests (new), red first.** `fu2/red.log` and `fu2/red-f2.log` hold the
red runs. Each test failed on its assertion, not on an import.

| Test | Red on the tree as found | Mutation (then reverted) → red |
|---|---|---|
| client C9: a T1 row not cited and a row typed after the chord come back once; the send-now's own text does not | `onReturned` never fired (timeout) | **D (the reviewer's): every row of `mine` marked handedBack → red** |
| daemon Q2b: each `steer` carries its row's id | no `id` | E: steer emitted without its id |
| tui `onSteer` by id / a foreign steer drops nothing | front row dropped | F: always FIFO (also reddens the App foreign-steer test) |
| tui `handBackRows` with `restored` | given twice | G: `restored` ignored (also reddens the App chord test) |
| App: typed after the chord, restored, then returned → once | `alpha\n\nbravo\n\nbravo` | G2: `restoredRef` not fed |
| App: another writer's steer keeps my row; my own steer removes it | `alpha` vanished | F |
| daemon Q14c: reclaim of a deleted id → `SessionDeleted`; never seen → `UnknownSession` | `UnknownSession` for the deleted id | K: no tombstone check |
| reattach F2a: closed with my row queued → back once → the reclaim lands in the archive → a reopen returns nothing | the reclaim was refused, the record kept `a` | H: `reclaim` refuses a session that is not live |
| reattach F2b: the writer is offline at the close → the archive holds the row → a reopen returns it once | green (it pins today's behaviour) | J: the archive drops `returned` |

After the last revert, the 6 sources are byte-identical (`shasum -c
fu2/after.sha`: all OK; `remote-session.ts 2ef97f23…`, `hosted-session.ts
d583ee7c…`, `queued.ts 5beeeabe…`, `App.tsx 81070418…`, `connection.ts
254ccf51…`, `session-host.ts 95de81e9…`).

**Gate.** `bun run check`: typecheck clean · lint `Checked 451 files … No
fixes applied` · **2448 pass / 2 skip / 0 fail** (2450 tests, 199 files).
That is +9 over 2439. The 2 skips are the opt-in ones.

**Notes.**
- `PROTOCOL_VERSION` stays 11 (the steer `id` is an additive field, and the
  reclaim of an archived session widens what is accepted).
- With an older daemon (no steer id), the TUI's FIFO drop and its full
  restore on `Cancelled` stay as before. The dedupe holds there too, because
  such a daemon sends no `returned`.
- The mobile app does not restore on its own yet (task 13). Whoever builds it
  must dedupe the same way (the `onReturned` doc says so).

### Follow-up 3 (Review round 2, finding 1)

*— claude-sonnet-5-5, 2026-10-25.* Tests only; no production change.

Added `P-R5` in `packages/daemon/test/persistence.test.ts:2371` (next to the
other archived-record tests, same `rig`/`client` fakes). It drives the race
through existing seams, with no new one: archive a session with row `e1`
returned → `await host.prepareOpen` (the reopen's read is done, the record is
pinned) → `await host.reclaimArchived(id, ["e1"])` → `host.open(params,
attachment, prepared)` with the stale record → asserts the snapshot's
`queued.returned` is `[]`. (The `Connection.open` await is exactly the gap
between the first two calls.)

**Non-vacuity.** Mutation `restore(record, entry.renamed)` at
`session-host.ts:371` (guard removed): P-R5 **red** on the `returned`
assertion (`e1` present). Restored: **green**. `session-host.ts` shasum before
= after = `95de81e92c4839d39ea102d3c6a08156ee4c61fb`.

**Gate.** `bun run check`: typecheck clean · lint `Checked 457 files … No
fixes applied` · **2472 pass / 2 skip / 0 fail** (2474 tests, 202 files); +1
over round 2's 2471. The 2 skips are the opt-in ones.

## Review

> **Orchestrator note (2026-10-24, owner decision):** scope ADDS the 4a `endUnstarted` gap: when another device stops the turn (Esc) or cancels its send-now before it starts, the writer's undelivered rows go back to the writer — PC: into the input field (joined) + notice "Turn stopped from another device: your N queued messages are back in the input"; phone: compose field + banner; never re-sent automatically; the daemon tells the writer which ids came back (daemon fact). See `docs/eval/send-now.md` addendum (4c as-built) and `docs/feat/send-now-c.md` Execution follow-up 3 (repro). Re-plan question 1 accordingly.

> **Owner decision (2026-10-24): APPROVED as ONE task, no split** (M · load-bearing; strong model, mandatory fresh-context Review). Branch `feat/queued-broadcast`. Q1 REPLACED: rows left in the queue at a turn's end (and rows dropped by another device's Esc / cancelled send-now — the 4a `endUnstarted` gap) are NOT discarded: they go back to their WRITER, visibly (PC: input field, joined, + notice; phone: compose field + banner), never re-sent by themselves; the daemon tells the writer which ids came back (rule: `docs/eval/send-now.md` addendum, 4c as-built). Q3 accepted (the TUI switches to the daemon's queue in task 6, not now). Q4 accepted (persist steer ids riding 2a's `DAEMON_RECORD_VERSION` bump — 5 runs after 2a). Re-plan the design sections touched by the new Q1 before executing.

### Questions for the owner (re-plan)

*— claude-opus-5-5, 2026-10-24*

- **Q-R1. How long do returned rows wait for a writer that is offline?**
  Options: (a) until the writer (or an explicit act on another device)
  reclaims them, persisted, never expiring — needs the new method
  `session/reclaim`; (b) until the next turn starts — no new method, but a
  writer offline across someone else's turn loses them silently; (c) live
  only (ring replay) — lost on any resync. **Recommendation: (a).** It is the
  only option with no silent loss; the method is additive (no bump), and the
  rows of a writer that is gone for good stay visible until someone takes them
  or deletes the session.
- **Q-R2. A turn cut short by a daemon crash: should its steers also go back
  to their writer**, instead of becoming user messages in the history that the
  next prompt (anyone's) answers (today, `persisted-session.ts:396-398`)?
  **Recommendation: yes, for v4 records** (the ids are known); v1–v3 records
  keep today's behaviour (no id, nobody could take them back). It is the same
  rule, and what you rejected ("riding someone else's prompt by surprise").
  The close/archive path does this anyway (Design item 7: otherwise a row
  would be handed back and also delivered).
- **Q-R3. Size grew from M to L** (a method, a record bump, the client
  hand-back and a TUI change, across 4 packages + protocol). **Recommendation:
  keep it as ONE task**, as you decided ("a single agent can work it"):
  splitting would ship the daemon's `returned` without a client that hands it
  back. L is allowed (no XL), with the strong model and a mandatory
  fresh-context Review.

### Owner decisions on the re-plan

*— recorded by the orchestrator (claude-opus-5-5), 2026-10-25*

- **Q1 (writer offline when its rows come back) — YES as recommended.** The
  returned rows stay in the daemon, persisted, with no expiry, until the
  writer reconnects and reclaims them; then they land in its input field
  with the notice. Nothing is dropped silently.
- **Q2 (rows queued when the daemon crashes mid-turn) — NOT DECIDED, waits
  for the owner** ("non prendere decisioni importanti senza avermi
  interpellato"). Execution keeps TODAY's behaviour for that case (v1–v4
  records alike) and leaves a clearly marked seam where the planner's
  recommendation (return the rows to their writer on reload) would plug in.
  Nothing about it is committed before the owner decides.
- **Q2 — DECIDED by the owner 2026-10-25 ("si va bene"): the
  recommendation.** For v4 records, rows queued in a turn cut short by a
  daemon crash/restart go back to their writer on reload, exactly like a
  turn stopped from another device (input field + notice; held for an
  offline writer, persisted, no expiry), and never enter the history as user
  messages. v1–v3 records keep today's behaviour (they carry no writer).
  Implemented at the seam marked `OWNER DECISION PENDING`
  (`persisted-session.ts`), replacing the pin of today's behaviour for v4.
- **Q3 (one L task) — pending the owner's confirmation**; it changes no
  behaviour, so execution proceeds as one branch (as the owner chose for
  task 3); a split remains possible before merge if the owner prefers.

### Adversarial review (fresh context)

*— claude-opus-5-5, 2026-10-25. Same model as the executor (fresh context
only): shared blind spots survive both passes. For a load-bearing L task,
AGENTS §10 prefers a different model as a second reviewer.*

**Verdict: REQUEST-CHANGES.** One finding breaks the owner's rule (no silent
drop): F1. The daemon side, the record, the protocol and the Q2 follow-up
hold under attack.

**Gate (re-run by me, working tree as found).** `bun run check`: typecheck
clean · lint `Checked 451 files … No fixes applied` · **2439 pass / 2 skip /
0 fail** (2441 tests, 199 files, 9234 `expect()`). The 2 skips are the
opt-in ones. This matches Execution's Follow-up 1.

#### Findings

1. **F1 — Medium, a silent drop.** The send-now `delivered:false` path
   marks rows as given back that the caller never restores
   (`client/src/remote-session.ts:751-760`). When a send-now ends
   undelivered, every id in `mine` bound to that turn or to the turn it
   interrupted goes into `handedBack`. That claims "the TUI's
   `takeAll(rows)` restores exactly these". It does not when the TUI's list
   has diverged from the daemon's. `onSteer` drops the front row on ANY
   `steer`, including another writer's (`tui/src/queued.ts:42`, applied to
   every `steer` at `App.tsx:738-739`; the known FIFO limit until task 6).
   - **The sequence:**
     1. B's steer is drained right after I type `a`, so my TUI drops `a`,
        but the daemon accepts it into T1.
     2. My chord cites only what my TUI still has.
     3. B's Esc cancels my send-now before it starts.
     4. The daemon returns `a` correctly (a T1 leftover, not the send-now's
        own id).
     5. My client finds `a` in `handedBack`, so it never fires
        `onReturned` and reclaims it.
     6. The text is gone everywhere.
   - **Repro** (`.tentacle/tmp/queued-broadcast/review/r1.test.ts`, the
     C-test rig, with `sendNow([{x}])` while `a` is queued in T1, then B's
     `cancel`):
     `entries before B's Esc [{"id":"x",…},{"id":"a","text":"A-text"}]` →
     `onReturned calls: []` · `daemon returned now: []` ·
     `user msgs: ["go"]`.
   - **No test covers the loop.** With the whole loop disabled (mutation
     D), `packages/client`, `cli/test/queued-broadcast` and
     `tui/test/returned` stay **266 pass / 0 fail**.
   - **Removing the loop is not the fix either.** Rows typed after the
     chord are bound to T1 (`enqueue` uses `this.turnId`, `:280`), and the
     TUI restores them through `onSuccessorError`. Without the loop they
     would be given back twice.
   - **Wanted:** the client marks only the ids the caller actually restored.
     For example, the TUI reports the ids it restored, or the TUI's hand-back
     dedupes against its own restore. Pin both cases with a test that is red
     first: a row typed after the chord is not given back twice, and a
     mis-dropped row is given back once.
2. **F2 — Low (owner decision: accept as debt or not).** A close mid-queue
   leaves rows in `returned` that were already given back. `close()` streams
   `queued{returned}` and then `session_closed`, and detaches in the same
   stretch (`hosted-session.ts:1591-1598`). The writer gets its rows, but its
   reclaim always fails with `UnknownSession` (`connection.ts:305-314`), so
   the archived record keeps them.
   - After a reopen, every client sees them as "returned". No live
     `RemoteSession` holds those ids any more, so nothing reclaims them
     automatically.
   - Task 6/13's "explicit act on some device" would hand them out a
     **second** time.
   - Q13 in the plan says "the rows show again after a reopen until
     reclaimed". It does not say that the writer already has them.
   - Not a loss. It is a duplicate risk deferred to task 6/13.
3. **Note (not a defect):** with no `onReturned` listener, nothing is
   reclaimed. Every TUI runtime (worker, pod `run`/`attach`, `connect`)
   creates its controller in `createSession` → `persistingController`
   (`cli/src/local-runtime.ts:300-313`), which forwards `onReturned`
   (`:209`). So no TUI path leaves it unsubscribed. The mobile app does not
   subscribe yet (task 13): its rows stay *held*, never dropped. Acceptable.

#### Premise table (the Implementation's load-bearing citations)

| Premise | Verdict |
|---|---|
| Context symptom: no `queued` on `main` (Execution's red run is the repro: 54 fail / 111 pass, every new test failing) | TRUE (not re-run whole; my mutations A–C re-prove the main tests) |
| `send` replaces the queue `opts.steering ?? []` (`agent/src/session.ts:91`); the drain is `splice(0)` (`:96`, `:123`) | TRUE |
| A drain pushes and then yields one `steer` per text, with no await before `turn_end` (`agent.ts:442-446`, `:459-461`, `:573-579`, `:620-622`, `:679-681`) | TRUE |
| Concurrent dispatch (`transport/peer.ts:322` `void this.handleRequest`) | TRUE; `reclaim` adds no lock (`connection.ts:242-247`) |
| `PROTOCOL_VERSION` 11 (`protocol/version.ts:7`) | TRUE, unchanged |
| The laptop store keeps extra top-level fields (`agent/src/session-store.ts:279`) | TRUE |
| `enqueue` is accepted by an aborted turn (P4), and `finishTurn` returns that row | TRUE (`hosted-session.ts:1462`, `:1281-1286`) |
| The executor's 4 source shasums (`3538e30f`, `182089f1`, `c66d4b76`, `5210c984`) | TRUE, identical |

#### Mutations (mine; each reverted, then shasum checked)

| # | Mutation | Result |
|---|---|---|
| A | `finishTurn` does not push to `returned` | `daemon/test/queued.test.ts` **10 fail** (Q3, Q3b, Q4b, Q6, Q8, Q11–Q14) |
| B | `handBack` gives the daemon's text | **2 fail** (C8 pure, C8 wire) |
| C | Q2 off (`if (ids && false)`) | **5 fail** (F1a v4, Q-R2 ×3, reattach Q-R2) |
| D | the `delivered:false` `mine` loop disabled | **0 fail**: F1, the loop is unpinned |

After the mutations: the 4 shasums are equal to the ones taken before, and
`git status --short` is identical to the start of the session.

#### Attacks tried

- **Steering window.** No `await` is added. `publishQueue` and the D-return
  are synchronous, and `persist` only captures. In `drive` the mirror shifts
  on the yield that follows each history push, and only microtasks run in
  between, so no `persist` can capture a lagging mirror. Held.
- **Hand-off atomicity.** `publishQueue` runs after `settleSuccessor`. With
  the dedupe, nothing is emitted between `turn_end` and `turn_start`. Held
  (the executor's M4 shows the same).
- **B's Esc vs a steer, cancelled send-now, compaction, close, delete.**
  Each `leftovers`/`queueView` branch was traced by hand. A row ends up
  delivered, carried, or returned exactly once daemon-side. The only
  exception is close (F2: client-side duplicate risk). Held daemon-side.
- **Tombstoned/delete.** `close("deleted")` streams the hand-back before
  `session_closed`, and the record is removed with its rows. Held (Q13b).
- **Reclaim authorization.** `lookup` requires the session to be attached on
  that connection. There is no writer check beyond that, by design (one
  principal, O3). A duplicated or stale reclaim is idempotent. A reclaim of
  a `carried` id before the send-now lands is covered by every end of that
  send-now (sent / `restoredByRefusal` / `delivered:false`). Held.
- **A failed reclaim retried later.** The row stays in `returned` (visible,
  persisted), and `handedBack` blocks a second give. No loss (C6).
- **Pod forgery.** Text only from `mine`; `cause` is enum-checked; a forged
  id is ignored. Held (mutation B).
- **Record.** v4 without `steeringIds` or `returned`, or with an empty text
  or an unknown cause → refused. A v1–v3 record has its ids stripped and
  `returned: []`. The title gate is `< 3`. Q2 runs only when `steeringIds`
  is present, and is idempotent (the `known` guard). A suspended resume
  re-queues with v4 ids. Held (mutation C).
- **Protocol.** `queued` is `display`, the snapshot field is optional, and
  the new method is additive. An older client keeps today's drop, and its
  rows are held, not lost. Held: 11 is honest.
- **Raw terminal write.** The notice goes through `restoreInput` /
  `pushNotice` only. Held.

#### Executor behaviour

Execution is accurate where I checked it: the gate counts, the shasums,
documented drift (`readBack` not fed, `restoredIds` pruning, the
`local-runtime` forward), and red-first runs. Weak spot: the
`delivered:false` "handedBack" drift was justified as "exactly the rows the
TUI restores", but no test backs it (§9). That untested assertion is where F1
lives.

### Owner decision after Review round 1

- **F2 (reclaim after the session is closed/archived) — the recommendation,
  owner "ok" 2026-10-25.** `session/reclaim` is accepted on a closed /
  archived session too: it only marks the rows reclaimed in the archived
  record (no reopen, no revival, metadata-only — 2a's archive rules hold).
  So rows returned at close come back exactly once; if the writer was
  offline at close, they stay held in the archive and come back once on the
  reopen. A tombstoned (deleted) id still answers `SessionDeleted`.
  *— recorded by the orchestrator (claude-opus-5-5), 2026-10-25*

### Orchestrator note: integration with main (2026-10-25)

*— claude-opus-5-5 (orchestrator)*

While task 5 ran, main gained the TUI message style (`feat/tui-message-style`,
built in parallel at the owner's request: queued rows look like sent ones,
the rotating arc is gone), the double-version-marker fix, and three small
owner-requested TUI fixes (queued rows above the thinking line, a blank row
under the send-now hint, message background `#373737`). The task 5 working
tree was exported as a patch against 49a53f4 and applied with `git apply -3`
onto main `f46f862` in the worktree `.tentacle/worktrees/qb-int` (branch
`feat/queued-broadcast-int`): no conflict. One task 5 test
(`tui/test/returned.test.tsx`, review F1) still matched the removed arc
spinner; it now uses the shared `queuedRow` matcher. Gate on the integrated
tree: 2471 pass / 2 skip / 0 fail, typecheck and lint clean. The merge will
be done from this worktree.

### Review round 2

*— claude-opus-5-5, 2026-10-25. Fresh context, same model as the executor
and the round-1 reviewer: shared blind spots survive. Reviewed the integrated
tree in `.tentacle/worktrees/qb-int` (task 5 on main `f46f862`, uncommitted).*

**Verdict: APPROVE-WITH-NITS.** F1 is fixed at the root and pinned; the F2
owner decision is built as decided. One test gap (finding 1) on the
reopen-vs-reclaim race the owner asked about: the code is right, but no test
holds it. Add the test before or right after the merge; it is not a loss.

**Gate (re-run by me).** `bun run check`: typecheck clean · lint `Checked 457
files … No fixes applied` · **2471 pass / 2 skip / 0 fail** (2473 tests, 202
files). The 2 skips are the opt-in ones. Matches the orchestrator's note.

#### Findings

1. **Low — test gap (§9) on the owner's F2 race.** The guard that keeps a
   reclaim against a racing reopen is unpinned. `session-host.ts:371`
   (`restore(withoutReclaimed(record, entry.reclaimed), …)`): with it removed
   (`restore(record, …)`), `packages/daemon`, `client` and `cli` stay **1073
   pass / 0 fail**. The race is reachable: a reopen awaits `prepareOpen`'s
   disk read (`connection.ts:331`) with no lock, so a reclaim can land between
   that read and `open`. The reopen then uses the stale record. Without the
   guard the row would show as `returned` again in the live session. Nobody
   would hand it out (the reopening `RemoteSession` has an empty `mine`), but
   task 6/13's "explicit act" could give it a second time. **Wanted:** a test
   that holds `prepareOpen`'s read, reclaims, then opens, and asserts that the
   snapshot's `returned` is empty. It must be red with the mutation above.
2. **Nit — an ack can come before the disk write (plausible, not
   reproduced).** `rewriteArchived` returns early when the resident record
   already has the change (`session-host.ts:511-513`, `!renamed && kept ===
   current`). Case: two reclaims overlap, or the same ids are retried while
   the first write is in flight. The second one then acks before the first
   write lands. A failed write (`ok === false`) also acks success; the sweeps
   retry it. The worst case is a crash in that window: the row is back in the
   archive as `returned`, held and visible, never lost. The doc's "the
   reclaim's ack waits for the disk" holds only for the first writer.
3. **Info — `/clear` closes the session before its `returned` can be
   reclaimed** (`App.tsx:1066-1068`). `RemoteSession.close` unsubscribes in
   the same call. If the daemon still held rows of mine, the close hands them
   back to nobody, and the archive keeps them as `returned`. The TUI already
   put its own rows in the input (`:1081-1086`). Not a loss: it is the F2
   display/duplicate debt left for task 6/13. Not reproduced.

#### F1 (round 1) — holds

- **The steer names its row.** `drive` shifts the mirror's head and sets
  `id` on the event (`hosted-session.ts:1215-1222`). Every mirror entry has
  an id, including restored ones: a v4 id or a minted, nobody's id
  (`:421-427`). So a new daemon never sends an id-less steer, and the TUI's
  FIFO fallback (`queued.ts` `onSteer`) only runs against an older daemon.
- **Additive, honest.** `SteerSchema.id` is optional, and `steer` stays
  `display`. An older client drops the field and keeps its own FIFO. An older
  daemon sends no id and no `returned`: that is main's behaviour, with no
  new loss. `PROTOCOL_VERSION` 11 is honest.
- **The client marks only the send-now's own texts**
  (`remote-session.ts:752-757`). **Mutation D** (every id in `mine` marked
  given back) → **red**: C9 and my R1.
- **The TUI never restores a row twice.** `onSuccessorError` returns `ids`,
  `restoredRef` keeps them, and `handBackRows` skips them. In the other order
  (`returned` before the `Cancelled`), `handBackRows` drops the rows first,
  so the restore takes only what is left. Once either way. The other restore
  paths are consistent: `planRefusal` keeps held rows in the list
  (`afterRefusal`), and those come back once through `returned`.
- **Repro, re-run** (`.tentacle/tmp/queued-broadcast/review2/r2.test.ts`; the
  round-1 rig was copied here):
  - **R1** (round 1's case): `onReturned: [[{"id":"a","text":"A-text","cause":"cancelled"}]]`,
    and the daemon's `returned` is then `[]`.
  - **R2, my variant.**
    - Setup: B queues `b1`, `b2`; they drain while my `a` waits.
    - A sees `steer{id:"b1"}` and `steer{id:"b2"}`. My TUI rows after
      `onSteer` are still `[a]`.
    - Then my send-now `[x]`, a row `c` typed after the chord, and B's
      cancel.
    - Result: the error is `send-now cancelled before it started`, and
      `onReturned` gives `[a, c]`. The TUI's own restore takes `ids:["a","c"]`,
      and its hand-back is then `text:""` with no notice. **The text back in
      the input is exactly `"A-text\n\nC-text"`, once.** The user messages
      are `["go","B1","B2"]`: nothing of mine was delivered.
- **Mutation F′** (`onSteer` always FIFO) → **red**: the pure `onSteer` test,
  the App foreign-steer test, and R2.

#### F2 (owner decision) — holds, with finding 1

- **What the code does.**
  - `connection.ts` `reclaim`: a session that is not live goes to
    `reclaimArchived`; no `open`, no attach, no revival.
  - `reclaimArchived` (`session-host.ts`): a tombstoned id → `SessionDeleted`
    (checked first); an id that is not archived → `UnknownSession`.
    Otherwise it marks the ids in `entry.reclaimed` and rewrites the
    record's `returned` only. That is metadata-only, like the archived
    rename (2a's rules).
  - No gap between live and archived: `archive()` deletes the session and
    indexes the record in one synchronous stretch (`:565-576`). So the
    writer's reclaim, which arrives later over RPC, always finds the entry.
- **My mutation** — the rewrite ignores `reclaimed` (`kept = current`) →
  **red**: reattach F2a. The executor's H, J and K (Follow-up 2's table) cover
  the method gate, the archive keeping `returned` and the tombstone.
- **Writer offline at close → back once on the reopen:** F2b, held by the
  executor's J.

#### Integration with main — holds

- **Frames** (`review2/frames.test.ts`, App via `ink-testing-library`; SGR
  is stripped, so `#373737` is not visible here):
  - The queued rows show as `› alpha` / `› bravo`, above the
    `ctrl+x ctrl+s to send now` hint, then a blank row, then the thinking
    line. This is main's layout, and no arc spinner is left.
  - A hand-back mid-turn drops `alpha` from the block and puts it in the
    input (`❯ alpha`); the notice goes to the transcript.
  - After the turn ends, `bravo` is added to the input joined (`alpha\n\n
    bravo`), with the "another device" notice. Nothing was sent
    (`sent: ["go"]`).
- **Bottom-area height.** The notice goes to the transcript (`pushNotice`),
  not to the bottom area. `runningRows` (`App.tsx:525-528`) counts
  `queued.length`, and `handBackRows` updates it through `setRows`. The
  restored text is counted by `inputBoxRows`. No stale height.
- Task 5 does not touch the row renderer, so the colours are main's.

#### Mutations (mine; each reverted)

| # | Mutation | Result |
|---|---|---|
| D | `delivered:false` marks every id in `mine` as given back | **red**: C9, R1 |
| F′ | `onSteer` always FIFO | **red**: 3 (pure, App, R2) |
| R1 | reopen ignores `entry.reclaimed` (`session-host.ts:371`) | **0 fail**: finding 1 |
| R2 | archived rewrite ignores `reclaimed` | **red**: F2a |

After the last revert:
- The 6 touched sources match the shasums taken before (`remote-session.ts
  2ef97f23…`, `queued.ts 5beeeabe…`, `hosted-session.ts d583ee7c…`,
  `session-host.ts 95de81e9…`, `connection.ts 254ccf51…`, `App.tsx
  f58579575…`). The first five equal the executor's Follow-up 2 sums; App
  differs only by the integration.
- The 11 untracked files are unchanged.
- `git diff` is byte-identical to the start (`cmp`), before this section was
  written.

#### Attacks tried

- **An id-less steer from a new daemon** (a restored or v1–v3 steer would hit
  the FIFO fallback and drop my front row): none. Every mirror entry carries
  an id. Held.
- **Hand-back order** (`returned` before or after the `Cancelled`
  restore): once either way. Held. Cosmetic: in the "returned first" order,
  two notices are shown.
- **A reclaim between `close` and the archive index:** no gap (it is
  synchronous). Held.
- **A reopen racing a reclaim:** correct by reading, unpinned (finding 1).
- **Overlapping reclaims:** an early ack (finding 2). No loss.
- **Session switch:** the subscription is only re-made where `sessionRef`
  changes (`App.tsx:386`, `:1067`). Held. `/clear` → finding 3.
- **Pod forgery and authorization:** unchanged from round 1. A reclaim of
  an archived id needs no attach. That is consistent with the archived rename
  (one principal, O3).

#### Executor behaviour

Follow-up 2 is accurate where I checked it: the shasums, the red-first table
and the gate counts. Each fix landed at the cause round 1 named (the daemon
names the steer instead of the client guessing), and it drops the guess
instead of moving it. One gap: Follow-up 2 says the reopen guard "wins even
against a racing write", but no test pins that (finding 1). The same §9 slip
as round 1, on a smaller scale.
