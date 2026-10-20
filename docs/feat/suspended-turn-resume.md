# feat/suspended-turn-resume — a turn suspended on a permission survives a `serve` restart

> **Status:** review done (APPROVE-WITH-NITS, findings 1–7 addressed; no second Review by owner choice) — awaiting merge OK
> **Branch:** `feat/suspended-turn-resume`
> **Type:** feat (promoted from eval 2026-10-20) · **Size:** M · **Blast:** load-bearing (agent loop, steering window, persistence + permission invariants) · **Suited:** strong model executes; mandatory fresh-context Review (one, by owner choice)

---

## Context

*— claude-opus-5-5, 2026-10-19 (eval); promoted 2026-10-20*

Parent: `docs/eval/session-reattach.md` (point 8, decision D). A pending
permission suspends its turn with **no timeout** until a human answers; the
owner requires that suspension to survive a `serve` restart. Two children
planned the same work independently — `daemon-side-persistence` Part B and
`permission-events` slice 7b — so it is one task, after both of them.

Until this lands, `daemon-side-persistence` Part A closes a turn suspended at
restart honestly as "not executed" (never as a denial nobody gave).

Decided constraints (parent): D4 — a permission asked inside a sub-agent is
not resumable (in-memory conversation); the sub-agent gets an explicit
"interrupted" result. D5 — "allow always" grants are lost on restart.
D1 — the restarted daemon is a new `epoch`, so clients resync.

**Repro** (2026-10-20, `main` @ `b87947a`, bun 1.4.3,
`.tentacle/tmp/suspended-turn-resume/repro.ts`): a real `SessionHost` +
`SessionPersister` (no-op store) + `Agent` + gate, scripted model; restore the
record a `serve` writes while turn `T1` waits for approval of `c2` of
`[c1 look (none), c2 run (ask), c3 run (ask)]`, with `steer-1` queued.

```ts
const hosted = host.restore(record);   // record.turn = {turnId:"T1", steering:["steer-1"],
                                       //   pending:{toolCallId:"c2", tool:"run", resumable:true}}
hosted.attach({ send: (u) => { if (u.update.type === "permission_request") asks.push(u.update.requestId); } });
await new Promise((r) => setTimeout(r, 20));
console.log("running after restore:", hosted.running, "| snapshot.turn:", JSON.stringify(hosted.snapshotPage().turn));
console.log("permission_request re-emitted:", asks.length);
console.log("history:", /* shape of snapshotPage().messages */);
console.log("retried prompt{T1}:", JSON.stringify(hosted.prompt("T1", [{ type: "text", text: "go" }])));
console.log("runs:", runs, "| model calls:", model.calls.length);
```

```
running after restore: false | snapshot.turn: undefined
permission_request re-emitted: 0
history: user:go -> assistant: -> tool(c1):look ok -> tool(c2):Not run: the -> tool(c3):Not run: the -> user:steer-1
retried prompt{T1}: {"turnId":"T1","ended":{"stopReason":"error","error":{"code":-32012,"message":"interrupted: the daemon restarted during this turn"}}}
runs: [] | model calls: 0
```

The capability is missing: the suspension is lost (visibly), the user must
re-prompt, and the turn `T1` the client is waiting on ends as an error.

## Implementation

*— claude-opus-5-5, 2026-10-20*

Sources: `docs/feat/daemon-side-persistence.md` (items **[B]**, B1–B4, tests
12–16, and the `resumeFrom` prototype) and `docs/feat/permission-events.md`
("Slice 7b"). Both drafts predate Part A and 7a as built; this plan re-verifies
them on `main` @ `b87947a` and **wins where they disagree** (each divergence is
listed under *Reconciliation*).

### Load-bearing assumption

> **The persisted record of a suspended turn — history up to the pending call,
> the pending call id, the steering queue — is enough to continue that turn in a
> fresh process exactly as it would have continued uninterrupted: the pending
> call is asked again, then it and every later call of that round run once, and
> the model is called only after them.**

Verified:
- The record captured at the ask is the exact prefix
  `…, assistant{c1..cn}, tool(c1)…tool(c_{k-1})`: the assistant message is
  pushed and committed before any call runs (`agent.ts:268-282`), calls run in
  order, each result is pushed before the next `tool_start`
  (`agent.ts:325-365`), and the ask happens inside `runTool`
  (`agent.ts:518`). `HostedSession.awaitDecision` captures `pending` with
  `currentToolCallId` (set on `tool_start`, `hosted-session.ts:622-625`) and
  the steering queue (`persistedState`, `:352-375`) — synchronously before the
  request goes out (`:286-288`).
- The decision depends only on `(tool, input)` and in-memory grants
  (`permission-gate.ts`, `authorize`); the input is re-parsed from the stored
  `call.arguments` (`agent.ts:512-518`). Re-asking = calling `authorize` again.
- `runMessages` always starts with a model round (`agent.ts:207-229`), so a
  minimal seam is needed (B1). The draft's prototype (persistence doc,
  "Experiment" B'') shows "run the unanswered calls from the pending one, then
  the loop" yields a history byte-identical to the uninterrupted run, with the
  same prompts and one model round; test **S1** re-proves it on the built seam.

### Preconditions (verified on `b87947a`)

- **P1 sequential calls**: the `for (const call of toolCalls)` loop,
  `agent.ts:325-365`. At most one ask per session (7a Execution, "Known limits").
- **P2 at a `history_commit` no ask is pending**: the agent yields
  `history_commit` only from the loop body (`agent.ts:281,343,364`), never while
  blocked in `runTool`'s `authorize`; a sub-agent's progress reaches the parent
  only as `subagent_*` events (`agent.ts:103-117`).
- **P3 the steering invariant** (`agent.ts:287-298`, `hosted-session.ts:601-608`,
  pinned by `persistence.test.ts` P4 and `integration.test.ts`): `drive` never
  awaits between the last drain and `finishTurn`. Untouched: `drive` keeps its
  loop body; only the generator it iterates changes.
- **P4 the protocol already has the resumed-turn state.** `SnapshotTurnSchema`
  (`protocol/src/session.ts:195-197`): "the turn running at the cut (its
  `turn_start` is at or before `since`)". A restored session whose cut carries
  `turnId` is exactly that state: the prompt is already in the snapshot
  history, and the replay carries the turn's updates after the cut. **No wire
  change, no `PROTOCOL_VERSION` bump.** Emitting `turn_start{prompt}` again
  would add the prompt a second time to a client's projection (the prompt is
  before the cut) — the draft's B3 is wrong on this point.
- **P5 the requester is event-based (7a)**: `awaitDecision` mints a fresh
  `requestId` per ask (`hosted-session.ts:262`) in a per-incarnation `asks`
  map (`:172`), so a pre-restart id answers `PermissionNotPending` (`:309-311`)
  with no new code.
- **P6 the clear-before-run already exists (Part A D-a)**:
  `hosted-session.ts:289-296` clears `pending`, schedules and awaits the write
  before the gate may run the tool.
- **P7 the reaper skips a busy session** (`session-reaper.ts:73`); the opt-in
  admin cap still closes a detached busy one (`:76`) — same as any live
  suspended turn today.
- **P8 restore is synchronous and builds through the normal factory**
  (`session-host.ts:137-151, 220-244`); pods/worker pass no persister, so they
  never hold a record and never restore (`serve.ts:209-250`).
- **P9 `HostedSession`'s constructor writes once** (`hosted-session.ts:244`).
  Danger found while planning: if the resumed turn were started *after* the
  constructor, that first capture would have no `turn` but a history with
  dangling calls; a crash before the next write would reload it "as is" —
  an idle session whose history has unanswered tool calls (every next model
  call fails). So the resumed state must be in place **before** that capture
  (Design D3).

### Design

**D1. Agent seam (`agent.ts`, new pure `agent/src/resume.ts`).**
- `suspendedCalls(messages, toolCallId): readonly ToolCall[] | null` — pure,
  exported. Non-null iff the history is *exactly* suspended before
  `toolCallId`: the last `assistant` message has `toolCalls` containing it, and
  every message after that assistant is a `tool` message, answering, in order,
  exactly the calls before it. Returns the calls from `toolCallId` on. Strict on
  purpose (any stray user/tool message → null).
- Extract the per-call body (`agent.ts:325-365`) into
  `private async *runToolCalls(calls, messages, toolContext, signal)`; the
  round loop calls it. Behaviour identical (abort branch, progress, transform,
  commit).
- `runMessages(messages, sessionId, signal?, drainSteering?, opts?: { resumeFrom?: string })`.
  With `resumeFrom`: `suspendedCalls` → null throws `ResumeShapeError` before
  anything is yielded, pushed, run or streamed; otherwise
  `yield* runToolCalls(those calls)`, **then** `flushBackgroundExits`, then the
  loop as usual (the queued steers drain at the first iteration top — where an
  uninterrupted run drains them). Flushing exits first would put a user note
  between an assistant's `toolCalls` and their results (an invalid history).
  Without `opts`: byte-identical to today; `Session.send` never passes it.
- **`Session.resume(toolCallId, signal)`** (`session.ts`): like `send`, but it
  pushes nothing and **keeps** the steering queue (the caller seeds it with
  `enqueue`); persists in `finally`.

**D2. Reload decision (`persisted-session.ts`, pure).** `reconcileOnReload`
returns `resume?: ResumedTurn = {turnId, toolCallId, steering, pending}` —
messages, turns and steering then left **untouched** — iff all hold:
`turn.pending.resumable`; `suspendedCalls(messages, pending.toolCallId)` is
non-null and its first call's name is `pending.tool`; the record's `turns`
holds `turn.turnId` without an end. Otherwise the Part A path, unchanged (the
sub-agent note, D4; "Not run"/"Interrupted"). `classifyPending` delegates its
shape check to `suspendedCalls` (one definition of "suspended before this
call", used at capture, at reload and by the agent).

**D3. Resumed turn (`hosted-session.ts`).** `RestoredSessionState.resume?`.
In the constructor, **before** its `persist()`: seed the steering queue
(`session.enqueue` per text), take the busy slot (`controller`,
`activeTurnId`), keep the record's `pending` (so the first capture still says
"suspended on c_k", never "idle with dangling calls" nor "in flight"), set
`cut.turnId`. After the `persist()`, the constructor's last statement starts
`drive` over `session.resume(toolCallId, signal)` — no state where a session
holds the slot without a driver. `drive(turnId, events, controller)` now takes
the generator; `prompt` passes `session.send(text, signal)` (lazy: the body
still runs on drive's first `next()`, so A1's turn-start capture is unchanged).
No `turn_start` is emitted (P4). The re-ask goes through the normal requester
(fresh `requestId`, P5).

**D4. Persist-then-emit (7b's guarantee: every request a user can see is
durable).** In `awaitDecision`: register the ask, set `pending`, `persist()`,
**await `persisted()`**, then emit `permission_request` — only if the ask is
still unsettled. An ask gets `shown`; `settle` emits `permission_resolved` only
for a shown ask (a cancel that lands during the write ends it silently: no
client ever saw it). `flush` never rejects (Part A D-b): a failed write is
logged and the request is shown anyway — the daemon makes no decision of its
own, the restart guarantee is lost for that one ask, loudly. 7b's draft
("write failure → cancel + `turn_end{error}`") is rejected: it is a
daemon-made decision caused by a disk.

**D5. A stale `pending` is cleared at every commit.** In `drive` on
`history_commit`: `pending = undefined` before the write (sound by P2). This
covers the one path that never goes through `awaitDecision`: a resumed turn
cancelled before its re-ask (the agent answers the call "Cancelled" and
commits), whose next record must not say "pending on an answered call".

**D6. `serve` notice.** `restored N sessions (K resumed a turn waiting for
approval)` — the operator learns a turn is live again.

### Reconciliation with the source drafts

| Draft says | Plan does | Why |
|---|---|---|
| B3: the resumed turn emits `turn_start{turnId}` | no `turn_start`; `cut.turnId` = the turn | P4: the prompt is already in the snapshot; re-emitting doubles it |
| B2: `Session.resume(toolCallId, steering, signal)` | `resume(toolCallId, signal)`, steering seeded with `enqueue` | the first capture (P9) must already hold the steers; a lazy generator seeds too late |
| B1/15: `ResumeShapeError` → caller falls back to "Not run" | the reload decides with the same pure `suspendedCalls` first; the agent's throw is a guard for other callers | one function, same input, checked synchronously just before — a disagreement is impossible by construction, not handled after the fact |
| 7b: `pendingPermission{turnId, toolCallId}` record | Part A's `turn.pending{toolCallId, tool, resumable, requestedAt}` | already built and validated (`persisted-session.ts:17-32`); no format change, `schemaVersion` stays 1 |
| 7b: deny/cancel clears without waiting | every outcome waits (as built, P6) | one code path; harmless on a working disk — **not** on a hung one (Review finding 6: a cancel then never ends the turn; pre-existing on `main`, tracked in `TODO.md`) |
| 7b: write failure on suspend → cancel + `turn_end{error}` | log, show the request anyway | D4 |
| 7b: history-validity repair exception | n/a — `history-validity-invariant` is not built; `reconcileOnReload` is the only repair and decides via D2 | |

### Files (dependency order)

1. `packages/agent/src/resume.ts` (new, pure): `suspendedCalls`.
2. `packages/agent/src/agent.ts`: `runToolCalls` extraction, `opts.resumeFrom`,
   `ResumeShapeError`.
3. `packages/agent/src/session.ts`: `resume()`.
4. `packages/agent/src/index.ts`: exports.
5. `packages/daemon/src/persisted-session.ts`: `ResumedTurn`, `reconcileOnReload`
   branch, `classifyPending` → `suspendedCalls`.
6. `packages/daemon/src/hosted-session.ts`: D3, D4, D5.
7. `packages/daemon/src/session-host.ts`: pass `resume` through `restore`.
8. `packages/cli/src/serve.ts`: D6.
9. Docs: `ARCHITECTURE.md`/`AGENTS.md` only where they state the restart
   behaviour (grep); `TODO.md` index.

### Failure modes

| Case | Outcome / convergence |
|---|---|
| Crash while suspended (resumable) | Reload → turn running, re-asked with a new `requestId`; approve → runs once. |
| Crash during the restore window (before the re-ask is written) | The constructor's capture still has `turn.pending` (D3) → the next reload resumes again. |
| Crash between the ask's write and its emit | Durable first (D4) → resumed after the restart; nobody saw the old id. |
| Crash after approval, before the tool's result is written | `pending` was cleared durably before the run (P6) → reload: "Interrupted", never re-asked, never run twice. |
| Late answer to the pre-restart `requestId` | `PermissionNotPending` (P5). |
| Pending shape does not match the history / turn key missing or ended | Part A reconciliation (D2): conservative notes, idle; nothing runs. |
| Sub-agent pending | Not resumable (D4 parent): sub-agent note, as built. |
| Cancel / close of the resumed turn before or during the re-ask | Abort settles the ask (7a); before the ask, the agent answers "Cancelled" and D5 clears `pending` at that commit; `turn_end{cancelled}`; nothing runs. |
| Cancel during the persist-then-emit write | The ask settles `cancelled` unseen; no `permission_request`/`permission_resolved` pair for it (D4). |
| Store write fails before the emit | Logged (`onError`); the request is shown anyway; the restart guarantee is lost for that ask only. |
| Retried `prompt{T}` after the restart | `{turnId: T}` (running), then the real end — not `DaemonRestarted`. |
| `enqueue{turnId: T}` after the restart | Accepted (the turn is running); a pre-restart id is a no-op (ids restored). |
| Client re-attaching | New epoch → resync; snapshot has `turn: {turnId}`; replay holds `tool_start` + `permission_request` (pinned past the cut). |
| Restart again while re-asked | Same as the first: the record has the new `pending`. |
| Iteration budget | Restarts at 0 for the resumed turn (the count is not persisted). Bounded: one budget per restart. Documented, not fixed. |
| Grants | Lost (D5 parent): the later calls are asked again. |
| Pods / worker | No persister → never a record → never resumed. |
| The waiting call's tool is no longer registered after the restart (Review finding 7) | Nothing is asked; the agent records its normal "unknown tool" result and the turn goes on. Nothing executes. |
| The disk hangs (a write never settles) | The request is never shown and a cancel cannot end the turn (only `close`); pre-existing for the clear-before-run wait — `TODO.md` (Review finding 6). |

### Tests (red first; each names its mutation)

`packages/agent/test/resume.test.ts` (real `Agent` + `Session` + gate,
scripted model):
- **S1 load-bearing**: uninterrupted run (steer queued while `c2` waits) vs.
  suspend → JSON round-trip → fresh agent/session → `enqueue` → `resume("c2")`:
  history deep-equal; 1 model call after the resume, whose request ends
  `tool(c2), tool(c3), user:steer-1`; asks `[c2, c3]`; execs once each; `c1`
  not re-run. Mutations: `resume` as `send("")`; resume from `calls[0]`;
  `resume` resets steering.
- **S2** `ResumeShapeError` for each bad shape (unknown id, answered id, a
  later call answered, a user message after the assistant, no assistant):
  nothing yielded, model 0 calls, no exec, history unchanged.
- **S3** a background exit pending before the resume is flushed **after** the
  resumed results. Mutation: flush first → the history has a user note inside
  the round.
- **S4** aborted before the resume → `c2`,`c3` "Cancelled", `turn_end
  cancelled`, no ask, no exec, no model call.
- **S5** `suspendedCalls` table (pure).

`packages/daemon/test/persistence.test.ts`:
- **A3 → B1** restart mid-suspension **resumes**: running, `snapshot.turn`,
  the pre-restart history, a new `requestId`; the old one →
  `PermissionNotPending`; approve `c2` then `c3` → each runs once; one model
  call; final history = uninterrupted; `turn_end{T1, end_turn}`; retried
  `prompt{T1}` → that end. Mutation: no `resume` branch in reconcile → "Not run".
- **B2** the restore window: the restored session's first save holds
  `turn.pending` + steering. Mutation: seed after the constructor's write.
- **B3** persist-then-emit: with a held store no `permission_request` is
  emitted; on release, the request arrives with `durable.turn.pending` set.
  Mutation: emit before the await.
- **B4** crash after approval: the record captured mid-tool (approved ask) →
  reload: "Interrupted", not running, no ask, tool count 1.
- **B5** a resumed turn cancelled before its re-ask: the commit's record has
  no `pending`; `turn_end{cancelled}`; nothing runs. Mutation: drop D5.
- **B6** reconcile falls back when the turn key is missing/ended or the tool
  name differs (pure).
- Existing **A4**/**A5**/**A6**/**A7**/**P4** stay green unchanged.

`packages/cli/test/serve-persistence.test.ts`:
- **B7 (real disk, real `buildAgent`, WebSocket)**: a crafted record suspended
  on a `shell` call → `startDaemon` → notice says "resumed" → `session/open` →
  the replay holds `permission_request` → `session/cancel` →
  `turn_end{cancelled}`, the record on disk has no `turn`. No model call
  (cancel), nothing executed.

Gate: narrow files per slice; `bun run check` before done.

## Execution

*— claude-opus-5-5, 2026-10-20*

Built in the plan's order (agent → daemon → cli → docs), narrow test file per
slice.

1. **Agent.** `agent/src/resume.ts` (new): `suspendedCalls`.
   `agent/src/agent.ts`: the per-call body moved verbatim into
   `runToolCalls` (the round loop now `yield*`s it); `RunOptions.resumeFrom`;
   `ResumeShapeError` (thrown on the generator's first `next()`, before any
   yield). Resumed calls run before `flushBackgroundExits`. `session.ts`:
   `resume(toolCallId, signal)`. Exported from `index.ts`. All 117 pre-existing
   agent tests unchanged and green (the refactor guard).
2. **Daemon.** `persisted-session.ts`: `ResumedTurn`, private `resumableTurn`,
   `reconcileOnReload` returns `resume` (history/turns untouched);
   `classifyPending` = tool-name check + `suspendedCalls` (the old lenient
   "answered set" check is gone; `trailingCalls` stays for the Part A notes).
   `hosted-session.ts`: `RestoredSessionState.resume`; constructor seeds
   steers, takes the slot, keeps the old `pending`, sets `cut.turnId` — all
   before its write — and starts `drive` last; `drive(turnId, events,
   controller)`; persist-then-emit with `PendingAsk.shown`; `pending` cleared
   at every `history_commit`. `session-host.ts`: `restore` passes `resume`.
3. **CLI.** `serve.ts`: the restore notice counts resumed turns.
4. **Docs.** One sentence each in `AGENTS.md` §7 (persistence bullet) and
   `ARCHITECTURE.md` (permission paragraph).

**Drift from the Implementation (and why):**
- **A3 and A8 rewritten, not just "kept green".** A3 pinned the old "Not run"
  outcome for a resumable suspension — it is now B1. A8 used a suspended record
  to test the cached `DaemonRestarted` end; that record now resumes, so A8 uses
  a crash mid-tool (the state that is still closed) — same property.
- **B3b added** (not in the plan): a cancel during the persist-then-emit write
  must stream neither `permission_request` nor `permission_resolved`. It is the
  only test that pins `PendingAsk.shown`.
- **B4 uses a slow disk at the approval** (as A6 does): with a fast store the
  M8 mutation (no await before the run) was invisible to it.
- **B5's expectation corrected:** a steer still queued when the resumed turn is
  cancelled is dropped — the same as for an uninterrupted turn, by design
  (`docs/fix/steering-over-rpc.md:585`). The first draft of the test expected
  it in the history; the code was right.
- **B7**: `session/cancel` is a notification (the first draft sent it as a
  request and got `MethodNotFound`); the raw ws client now also collects
  `session/update` notifications.

**Repro after** (same script, this branch):

```
running after restore: true | snapshot.turn: {"turnId":"T1"}
permission_request re-emitted: 1
history: user:go -> assistant: -> tool(c1):look ok
retried prompt{T1}: {"turnId":"T1"}
runs: [] | model calls: 0
```

**Mutations** (script `.tentacle/tmp/suspended-turn-resume/mutate.py`: apply,
run, restore, assert byte-identical) — each red on the named test:

| Mutation | Red |
|---|---|
| `resume` without `resumeFrom` (= `send("")`) | S1 |
| `suspendedCalls` returns every call (resume from `c1`) | S1 |
| `resume` resets the steering queue | S1 |
| no `ResumeShapeError` throw | S2 |
| background exits flushed before the resumed round | S3 |
| no abort branch in `runToolCalls` | S4 |
| "answered set" instead of the in-order prefix | S5 |
| M1 no `resume` branch in `reconcileOnReload` | B1, B2, B5, B6, B7 |
| M2 `restore` drops `resume` | B1, B2, B5, B7 |
| M3 constructor writes before seeding the resumed turn | B2 |
| M4 the record's old `pending` not kept | B2 |
| M5 steers not seeded | B1, B2 |
| M6 emit before the write is durable | B3, B3b |
| M7 `permission_resolved` for an unshown ask | B3b |
| M8 no durable clear before the run | A6, B4 |
| M9 no `pending` clear at `history_commit` | B5 |
| M10 no turn-key check in `resumableTurn` | B6 |
| M11 `classifyPending` ignores the tool name | A5, A14 |

**Gate (before the Review):** `bun run check` → tsc clean, Biome clean (295 files), **1108 pass,
2 skip (the opt-in live-k8s and slow-keepalive tests), 0 fail** (4398 expects,
113 files).

**Unverified:** a real model round after an approval on a restored `serve`
session over the wire (B7 cancels; the model round after a resume is covered
in-process by B1/S1 with a scripted model). Not reachable from the TUI yet:
`tentacle connect` has no `--resume` and always opens a new session
(`cli/src/main.ts:158-167`); `--resume` exists only for the in-process worker
and pods, which never persist. So no shipped client is affected (no
regression), and none can answer a resumed request until `client-reattach`
(8a) re-attaches by id. Until then a resumed turn is reachable by a raw client
(as B7 does) and ends by `session/close`, the opt-in admin cap, or an answer —
like any detached suspended turn since 7a (no timeout, by decision).

#### After the Review (APPROVE-WITH-NITS): findings addressed

*— claude-opus-5-5, 2026-10-20*

Each finding verified against the code before acting; none disputed.

1. *Broken links after the `git mv`.* `TODO.md:499` now names the feat doc;
   the status pointers in `daemon-side-persistence.md:3,40`,
   `permission-events.md:3,35`, `session-reattach.md:452,493` too (`:351` of
   the persistence doc is history: annotated, not rewritten).
2. *No test for "write fails before the ask → shown anyway".* **B3c** added.
   Mutation: the persister's `flush` never settles after a failed write (=
   "show only on success") → B3c red.
3. *Restart notice untested when nothing resumes.* A13 now asserts the notice
   has no "resumed". Mutation: count every restored session as resumed → A13
   red.
4. *`turns.set(resume.turnId, {})` redundant.* Kept, now pinned: without it a
   resumed turn whose key is missing would hold the busy slot forever
   (`finishTurn` no-ops). **B8** builds a `HostedSession` directly with that
   state and cancels it. Mutation: drop the line → B8 red. (`resumableTurn`
   already refuses such a record — B6 — so this is defence in depth, now
   tested rather than dead.)
5. *Stale comments.* `session-persister.ts` header (three waits, not two) and
   `HostedSession.persisted()` ("never in the steering window").
6. *Hung disk blocks `cancel` of a pending ask* (pre-existing on `main`; 7b
   adds "the re-ask is never shown"). Out of scope: a `TODO.md` entry, and the
   plan's "harmless" claim corrected (Reconciliation table) plus a
   Failure-modes row.
7. *Tool no longer registered after the restart.* A Failure-modes row; no
   code change (nothing executes).

**Gate after the fixes:** `bun run check` → tsc clean, Biome clean, **1110
pass, 2 skip (opt-in), 0 fail** (4404 expects, 113 files).
Re-running the gate afterwards hit the known GC flake
(`session-reaper.test.ts` "a connection forgets a session another client
closed", `docs/eval/reaper-gc-flaky-test.md`, test-only) 4 times in a row, so
it was measured rather than waved off: full suite, back to back, same machine —
**branch 1/8, `main` 2/8**, and 0/6 each when run concurrently; no other test
failed in any of the 36 runs. Same pre-existing flake at the same rate; this
task does not touch `Connection` or the reaper.


## Review

*— claude-opus-5-5, 2026-10-20 (fresh context; the **same model** as the
executor, so blind spots may be shared — the attacks below were chosen to
cross-check by execution, not by re-reading)*

**Verdict: APPROVE-WITH-NITS.** The load-bearing property holds end to end over
the wire after a real `SIGKILL`: the pending call is asked again with a new id,
each call runs exactly once, the model is called once after them, the queued
steer lands where it would have, and the record converges. Finding 1 should be
fixed before merge (a broken index link, trivial). The rest are test gaps,
stale comments and one problem that already exists on `main`.

### Findings

1. **Minor (docs; fix before merge):** `TODO.md:499` still links
   `docs/eval/suspended-turn-resume.md`, which the `git mv` turned into a dead
   link. Implementation "Files" item 9 names the `TODO.md` index, but `TODO.md`
   is unmodified. The status pointers in `docs/feat/daemon-side-persistence.md:3,40`,
   `docs/feat/permission-events.md:3,35` and `docs/eval/session-reattach.md:452,493`
   still name the eval path too.
2. **Low (test gap):** the failure mode "store write fails before the emit →
   logged, request shown anyway" (D4, `hosted-session.ts:321-335`) has **no
   test**. A10 has no tools, so it never asks. I verified the behaviour
   empirically (attack A below). Nothing stops a later change from bringing back
   7b's rejected "write failure → don't show / cancel" shape.
3. **Low (test gap):** the D6 notice (`serve.ts:146-160`) is pinned only on its
   positive case. My mutation R14 (count *every* restore as "resumed") survives,
   because B7 restores one session and that one resumes. The cost is an operator
   told "answer it from any client" when nothing is waiting.
4. **Nit (dead code):** `this.turns.set(resume.turnId, {})`
   (`hosted-session.ts:261`) is redundant. `resumableTurn` already requires the
   turn key to be open and in `restored.turns`, which the constructor loaded at
   `:212-214`. Mutation R12 (delete it) survives the suite. Drop it, or comment
   that it is defensive.
5. **Nit (stale comments):** `session-persister.ts:10` says "Only two acks
   wait, via `flush`", but the persist-then-emit (`hosted-session.ts:324`) is a
   third. `hosted-session.ts:395` `persisted()` says "Never in a turn.", but it
   is awaited inside a turn at `:324` and `:340`; the second use predates this
   task.
6. **Low (on `main` too, out of scope, record it):** with a **hung** store
   (a `save` that never settles, e.g. a stuck NFS/FUSE mount), `cancel` never
   ends a turn suspended on a permission. `decided.then` awaits `persisted()`
   (`:336-341`) and the gate never returns. Reproduced identically on `main`
   (`turn_start,tool_call,permission_request,permission_resolved | running true`).
   This task adds a second dependency on the same flush: a (re-)asked request
   is **never shown** on a hung store (attack B). So the Reconciliation row
   "every outcome waits — harmless" is untrue when the disk hangs. Only
   `close` ends such a turn, because it calls `finishTurn` synchronously.
   Suggest a TODO/eval item. It does not block this task.
7. **Info (undocumented failure mode, acceptable):** if the pending call's tool
   is no longer registered after the restart (an upgrade removed it), the
   resumed turn asks nothing and records `unknown tool: run`. The model is then
   called and the turn ends normally; nothing executes (attack E). This is the
   same as any unknown-tool call. Worth one line in Failure modes.

### Gate (re-run by the reviewer)

`bun run check` → `tsc --noEmit` clean · `biome check .` "Checked 295 files …
No fixes applied." · **1108 pass, 2 skip (the opt-in live-k8s and slow
keepalive tests), 0 fail, 4398 expect() calls, 1110 tests across 113 files.**
This matches Execution exactly. The agent package has 122 tests: 117
pre-existing plus 5 new, as claimed.

### Premise table (checked on `main` @ `b87947a` via a throwaway worktree)

| Premise | Cited | Verdict |
|---|---|---|
| Context symptom (Repro) | `repro.ts` | **TRUE** — on `main`: `running false`, no re-ask, "Not run" notes, `prompt{T1}` → `-32012`. On this branch: output identical to "Repro after". |
| Assistant pushed + committed before any call | `agent.ts:268-282` | TRUE |
| Sequential calls, result pushed before next `tool_start` | `agent.ts:325-365` | TRUE |
| Ask inside `runTool` | `agent.ts:518` | TRUE (`gate.authorize`) |
| Input re-parsed from stored `call.arguments` | `agent.ts:512-518` | TRUE |
| `runMessages` starts with a model round | `agent.ts:207-229` | TRUE |
| P2 `history_commit` only from the loop body; sub-agent progress only as `subagent_*` | `agent.ts:281,343,364`, `:103-117` | TRUE (`progressToEvent` maps only `subagent_*`; the child registry excludes `agent_task`) |
| P3 steering invariant | `agent.ts:287-298`, `hosted-session.ts:601-608` | TRUE; `drive` gained no `await` |
| `currentToolCallId` set on `tool_start` | `hosted-session.ts:622-625` | TRUE |
| `persistedState` captures steering + pending | `:352-375` | TRUE |
| Capture before the emit | `:286-288` | TRUE (sync emit on `main`; now awaited) |
| P5 fresh `requestId`, per-incarnation `asks`, `PermissionNotPending` | `:262`, `:172`, `:309-311` | TRUE (e2e: old id → `-32013`) |
| P6 clear-before-run awaits the write | `:289-296` | TRUE |
| P7 reaper skips busy; admin cap still closes | `session-reaper.ts:73,76` | TRUE in substance; lines drifted (`:76` busy, `:79` cap) |
| P4 `SnapshotTurnSchema` semantics | `protocol/src/session.ts:195-197` | TRUE (at `:197-198`) |
| `PendingPermission` format | `persisted-session.ts:17-32` | TRUE |
| P8 only `startDaemon` has a persister | `serve.ts` | TRUE (`persister` only on the `startDaemon` path) |
| P9 constructor writes once | `hosted-session.ts:244` | TRUE |
| Decision depends on `(tool, input)` + in-memory grants | `permission-gate.ts` `authorize` | TRUE; `tool.permission` is static code (not configurable), so a re-ask follows the same policy |

### Mutations (§9) — reviewer-chosen, via `mutate.py`, tree restored byte-identical

| Mutation | Result |
|---|---|
| R1 emit after a microtask, not after the write | red: B3, B3b |
| R2 resumed cut without `turnId` | red: B1, B7 |
| R4 no tool-name check in `resumableTurn` | red: B6 |
| R5 `suspendedCalls` without the length check (a later call answered → resumable) | red: S2, S5, A14 |
| R8 a cancelled, never-shown ask still emitted | red: B3b |
| R10 `resume` without the steering drain | red: S1, B1 |
| R16 an ended turn key still resumes | red: B6 |
| R20 resume skips the pending call | red: S1, S3, S4, B1, B5 |
| R21 `resumable:false` ignored at reload | red: B6 |
| R22 no-persister `persisted()` never settles (pod/worker path) | red by **hang**: the daemon suite timed out at 300 s, so the path is exercised |
| R12 drop `turns.set` in the constructor | **survives** → finding 4 |
| R14 notice counts every restore as resumed | **survives** → finding 3 |
| Executor's M9, M5 (spot-check) | red exactly as Execution states (B5; B1+B2) |

### End-to-end trace (real `startDaemon`, real disk, real `buildAgent` + `shell`, mock OpenAI SSE server, raw WebSocket)

Phase 1 runs in a child process: `prompt T1`. The model returns
`[c1 shell "echo one >> log.txt", c2 shell "echo two >> log.txt"]`; the test
waits for `permission_request c1`, sends `enqueue e1 "steer-1"`, then **SIGKILLs
the process**. Phase 2 runs in a new process: it restarts, re-opens the session,
and approves every request over the wire.

```
record after crash: turn = {"turnId":"T1","steering":["steer-1"],"pending":{"toolCallId":"c1","tool":"shell","resumable":true,…}}
log.txt before restart: "<none>"
notices ["restored 1 session from … (1 resumed a turn waiting for approval — answer it from any client)"]
open2 {… "created":false,"resync":true}   snap.turn {"turnId":"T1"} msgs 3
retry prompt T1 {"turnId":"T1"}            resolve old id {"code":-32013,…}
approved c1 new-id "ok"   approved c2 new-id "ok"
stream types tool_call,permission_request,permission_resolved,tool_call_update,tool_call,permission_request,permission_resolved,tool_call_update,steer,agent_message_chunk,turn_end
final system | user:do it | assistant: | tool(c1):exit=0 | tool(c2):exit=0 | user:steer-1 | assistant:all done
log.txt: "one\ntwo\n"     model requests: 2 (last ends tool(c1), tool(c2), user:steer-1)
record after: turn = undefined turns = [{"turnId":"T1","end":{"stopReason":"end_turn"}}]
```

This closes the Execution's "Unverified" item: a real model round after an
approval on a restored `serve` session over the wire. There is no `turn_start`
in the new incarnation, and every `permission_request` is paired with a
`permission_resolved`.

### Attacks tried

- **A. Failing store** (every `save` rejects): request shown, errors reported,
  approve → runs once, `end_turn`. Holds (untested → finding 2).
- **B. Hung store:** the request is never shown and `cancel` never ends the
  turn. Already on `main` for the cancel half → finding 6.
- **C. Second restart while re-asked:** the record captured at the re-ask
  restores again → running, a new id, approve → runs once, 1 model call. Holds.
- **D. `close` synchronously right after `restore`** (before the drive's first
  microtask): `turn_end, session_closed`; no ask, no run, no model call. Holds.
- **E. Pending tool unregistered after restart:** no ask, `unknown tool`, model
  continues; nothing executes → finding 7.
- **F. `enqueue` after the restart:** a new id for T1 is accepted and drained
  in place; a pre-restart id is a no-op; another turn's id → `NoTurnRunning`.
  Holds (that Failure-modes row had no test).
- **G. A sub-agent ask marked resumable:** a sub-agent's request can never
  match the parent's current call name (the child registry excludes
  `agent_task`), and `resumableTurn` re-checks the name against `calls[0]`.
  No path re-runs a started call. Holds.
- **H. Any other ask path that could fire after side effects** (which would
  make "pending ⇒ never started" false): `rg` finds only `gate.authorize`
  (`agent.ts:576`) and the sub-agent requester. Holds.
- **I. Superseded writes resolving early** (would break persist-then-emit):
  `JsonSessionStore.save` resolves only once "this record — or a newer" one is
  written. Holds.
- **J. Steering window:** `drive` gained only a synchronous assignment; the
  resume path ends through the same `runMessages` body and a synchronous
  `finally` persist. Held by construction (no resume-specific P4 test).
- **K. Prior art:** `docs/eval/parallel-tool-calls.md` would break P1. The
  strict in-order `suspendedCalls` then returns null, so the reload falls back
  to the Part A closure — fail-safe, but that eval must account for it.
  `docs/eval/client-reattach.md` plans `turn.state: "suspended"`; it is
  compatible with the `cut.turnId` used here.

### How the executor behaved

The executor followed the approved plan's order. It reported the drift
honestly and with reasons: A3/A8 were rewritten, B3b was added, B4 was given a
slow disk to make M8 visible, B5's expectation was corrected, and B7's cancel
was sent as a notification. The mutation table and gate counts reproduced
exactly. The "Unverified" note was candid and is now closed by the trace
above. The executor missed the `TODO.md` index update its own plan listed
(finding 1). It also left two Failure-modes rows without a test (finding 2;
`enqueue` after restart) while presenting the table as covered.
